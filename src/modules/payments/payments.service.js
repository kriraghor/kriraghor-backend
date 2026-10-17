'use strict';

/**
 * PaymentService (M06 §2.4, §8, FR-01 to FR-06).
 *
 *   initiated ──attempt (redirect)──▶ pending ──provider verified──▶ succeeded ──refunds──▶ partially_refunded ─▶ refunded
 *                                     pending ──declined/cancelled──▶ failed ──new attempt (before expiry)──▶ pending
 *   initiated | pending ──expires_at passed, provider says not paid──▶ expired
 *
 * Success is set only by server-side verification (FR-03): the SSLCommerz validation API by val_id,
 * reached from the IPN or the return URL, whichever comes first, or by a query (polling, expiry,
 * reconciliation). The browser's word is never trusted. Every path ends in applyResult(), which locks
 * the payment and is idempotent: a second confirmation of the same capture is a no-op.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const config = require('../../config');
const logger = require('../../common/logger');
const { AppError, E } = require('../../common/errors');
const { nextCode } = require('../../common/sequences');
const { uuid7 } = require('../../common/uuid7');
const { sequelize, Payment, PaymentAttempt, ProviderWebhookEvent, Refund, EscrowHold } = require('../../models');
const settings = require('../settings/settings.service');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const directory = require('../users/directory.service');
const providers = require('../../providers/payments');
const ledger = require('./ledger.service');
const lrules = require('./ledger.rules');
const escrow = require('./escrow.service');
const refunds = require('./refunds.service');
const purposes = require('./payments.purposes');
const fees = require('./fee.service');
const jobs = require('./payments.jobs');

const CAPTURED = ['succeeded', 'partially_refunded', 'refunded'];
const OPEN = ['initiated', 'pending', 'failed'];

const lockPayment = async (id, transaction) => {
  const p = await Payment.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!p) throw E.notFound('Payment');
  return p;
};

// ---------------------------------------------------------------- intents (FR-01)

/**
 * PaymentService.createIntent — called by purpose modules (and the test charge). Idempotent on
 * (payer, idempotencyKey): the same key returns the same payment; a different amount or purpose with
 * the same key is refused. The fee is snapshotted now, at obligation time (FR-07).
 */
async function createIntent(
  { purpose, purposeId, payerId, amount, title, payeeId = null, groupRef = null, releaseRule = { type: 'manual' }, expiresAt, idempotencyKey },
  { transaction } = {}
) {
  const def = purposes.get(purpose);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new AppError(422, 'AMOUNT_INVALID', 'The amount must be a whole number of poisha above zero');
  if (!def.pooled && !payeeId) throw new Error(`Purpose ${purpose} needs a payee`);
  const run = async (t) => {
    const existing = await Payment.findOne({ where: { payerId, idempotencyKey }, transaction: t });
    if (existing) {
      if (existing.purpose !== purpose || existing.purposeId !== purposeId || existing.amountPoisha !== amount) {
        throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different payment');
      }
      return existing;
    }
    const ttl = settings.get('payments.intent_ttl_minutes');
    return Payment.create(
      {
        code: await nextCode('PAY', t),
        purpose,
        purposeId,
        payerId,
        payeeHintId: payeeId,
        amountPoisha: amount,
        title: title.slice(0, 120),
        escrow: { payeeId, groupRef, releaseRule, fee: fees.snapshot(def.vertical) },
        expiresAt: expiresAt ?? new Date(Date.now() + ttl * 60000),
        idempotencyKey,
      },
      { transaction: t }
    );
  };
  return transaction ? run(transaction) : sequelize.transaction(run);
}

/**
 * POST /admin/payments/test-charges (master; PAYMENTS_TEST_CHARGES): a small real payment through the
 * gateway with a chosen payer and payee, held in escrow with a manual release. The Phase 2 exit check.
 */
async function createTestCharge(actor, { payerId, payeeId, amount, title }, idempotencyKey, req) {
  if (!config.payments.testCharges) throw new AppError(403, 'TEST_CHARGES_DISABLED', 'Test charges are turned off in this environment');
  const max = settings.get('payments.test_charge_max_poisha');
  if (amount > max) throw new AppError(422, 'TEST_CHARGE_TOO_LARGE', 'A test charge must not be more than the configured maximum', { meta: { max } });
  const people = await directory.accounts([payerId, payeeId]);
  const payer = people.get(payerId);
  const payee = people.get(payeeId);
  if (!payer || payer.status !== 'active' || payer.isStaff) throw new AppError(422, 'PAYER_INVALID', 'The payer must be an active member account (not staff)');
  if (!payee || payee.status !== 'active') throw new AppError(422, 'PAYEE_INVALID', 'The payee must be an active account');
  return sequelize.transaction(async (transaction) => {
    const payment = await createIntent(
      { purpose: 'test_charge', purposeId: uuid7(), payerId, payeeId, amount, title: title || 'Kriraghor test charge', idempotencyKey: `test:${actor.id}:${idempotencyKey}` },
      { transaction }
    );
    await audit.record(
      { action: 'payment.test_charge_created', actor, entityType: 'payment', entityId: payment.id, entityCode: payment.code, after: { amount, payerId, payeeId }, req },
      { transaction }
    );
    return { payment: serialize(payment), payUrl: `${config.apps.web}/pay/${payment.id}` };
  });
}

// ---------------------------------------------------------------- attempts (FR-02)

const returnUrl = (paymentId) => `${config.apiPublicUrl}${config.apiPrefix}/payments/return/sslcommerz?pid=${paymentId}`;

function scheduleAttemptPolls(attemptId) {
  for (const minutes of settings.get('payments.poll_unknown_minutes')) {
    jobs.dispatch(jobs.JOBS.POLL_ATTEMPT, { attemptId }, { jobId: `poll-${attemptId}-${minutes}`, delay: minutes * 60000 });
  }
}

/** POST /payments/:id/attempts — start (or restart) paying an intent; returns the gateway URL. */
async function startAttempt(user, paymentId, { method }) {
  const provider = providers.get();
  if (!provider.configured()) throw new AppError(503, 'PROVIDER_UNAVAILABLE', 'Payments are not available right now. Try again later.');
  const { payment, attempt } = await sequelize.transaction(async (transaction) => {
    const p = await lockPayment(paymentId, transaction);
    if (p.payerId !== user.id) throw E.notFound('Payment');
    if (CAPTURED.includes(p.status)) throw new AppError(409, 'PAYMENT_ALREADY_SUCCEEDED', 'This payment is already paid');
    if (p.status === 'cancelled') throw new AppError(409, 'PAYMENT_CANCELLED', 'This payment was cancelled');
    if (p.status === 'expired' || new Date(p.expiresAt).getTime() <= Date.now()) throw new AppError(410, 'PAYMENT_EXPIRED', 'This payment has expired');
    // A new attempt replaces an unfinished one; if the old one is paid after all, its IPN still captures.
    await PaymentAttempt.update({ status: 'cancelled', finishedAt: new Date() }, { where: { paymentId: p.id, status: 'in_flight' }, transaction });
    const a = await PaymentAttempt.create({ paymentId: p.id, provider: provider.code, method }, { transaction });
    await p.update({ status: 'pending' }, { transaction });
    return { payment: p, attempt: a };
  });

  const contact = (await directory.contactFor([user.id])).get(user.id) ?? {};
  let session;
  try {
    const url = returnUrl(payment.id);
    session = await provider.createSession({
      payment,
      attempt,
      method,
      urls: { success: url, fail: url, cancel: url, ipn: `${config.apiPublicUrl}${config.apiPrefix}/webhooks/sslcommerz` },
      customer: { name: contact.displayName, email: contact.email, phone: contact.phone },
    });
  } catch (err) {
    await attempt.update({ status: 'failed', failureCode: String(err.code ?? 'PROVIDER_ERROR').slice(0, 60), finishedAt: new Date() });
    logger.warn({ err: err.message, paymentId: payment.id }, 'payment session failed');
    throw new AppError(503, 'PROVIDER_UNAVAILABLE', 'The payment gateway is not answering. Try again in a moment.');
  }
  await attempt.update({ providerSessionId: session.providerSessionId, request: session.request, response: session.response });
  scheduleAttemptPolls(attempt.id);
  return { attemptId: attempt.id, redirectUrl: session.redirectUrl, expiresAt: payment.expiresAt };
}

// ---------------------------------------------------------------- results (FR-03, FR-05, FR-06)

/**
 * Apply a provider result to an attempt, under a payment lock. Idempotent. Returns the payment.
 * result = { status: 'paid'|'failed'|'cancelled'|'pending'|'not_found', amount, currency, providerTrxId, method, methodDisplay, reason }
 */
async function applyResult(attemptId, result, { source }) {
  return sequelize.transaction(async (transaction) => {
    const first = await PaymentAttempt.findByPk(attemptId, { transaction });
    if (!first) throw E.notFound('Payment attempt');
    const payment = await lockPayment(first.paymentId, transaction);
    const attempt = await PaymentAttempt.findByPk(attemptId, { transaction, lock: transaction.LOCK.UPDATE });
    const now = new Date();

    if (result.status === 'paid') {
      if (attempt.status === 'succeeded') return payment; // already applied (IPN and return both arrived)
      await attempt.update({ status: 'succeeded', finishedAt: now, response: { ...(attempt.response ?? {}), verifiedBy: source, providerTrxId: result.providerTrxId } }, { transaction });

      if (payment.capturedPoisha > 0) {
        // A second attempt was also paid: hold it in suspense and refund it (never lose money).
        await capturedTwice(payment, result, { transaction });
        return payment;
      }
      const base = { provider: attempt.provider, method: result.method, methodDisplay: result.methodDisplay, providerTrxId: result.providerTrxId };
      if (result.amount !== payment.amountPoisha || result.currency !== 'BDT') {
        await mismatch(payment, result, base, { transaction });
        return payment;
      }
      await payment.update({ ...base, status: 'succeeded', capturedPoisha: result.amount, succeededAt: now }, { transaction });
      const hold = await escrow.openHold(payment, { transaction, capturedAt: now });
      const grace = settings.get('payments.unknown_grace_minutes') * 60000;
      const late = now.getTime() > new Date(payment.expiresAt).getTime() + grace;
      const decision = await purposes.get(payment.purpose).onCaptured({ payment, late, transaction });
      await events.publish(transaction, {
        name: 'payment.succeeded',
        aggregateType: 'payment',
        aggregateId: payment.id,
        payload: { paymentId: payment.id, code: payment.code, purpose: payment.purpose, purposeId: payment.purposeId, amount: payment.amountPoisha, method: result.method, payerId: payment.payerId, late, accepted: decision === 'accept' },
      });
      if (decision !== 'accept') {
        // FR-05 / §12 #2: captured after the purpose gave up → automatic full refund.
        await refunds.createInTx(
          { payment, amount: payment.amountPoisha, kind: 'late_capture', reasonCode: 'late_capture', actorKind: 'system', idempotencyKey: `late:${payment.id}`, hold },
          { transaction }
        );
      }
      return payment;
    }

    if (result.status === 'failed' || result.status === 'cancelled') {
      if (attempt.status !== 'in_flight' && attempt.status !== 'unknown') return payment;
      await attempt.update({ status: result.status, failureCode: result.reason ?? result.status, finishedAt: now }, { transaction });
      if (payment.status === 'pending') {
        await payment.update({ status: 'failed' }, { transaction });
        await events.publish(transaction, {
          name: 'payment.failed',
          aggregateType: 'payment',
          aggregateId: payment.id,
          payload: { paymentId: payment.id, purpose: payment.purpose, purposeId: payment.purposeId, amount: payment.amountPoisha, payerId: payment.payerId, reason: result.reason ?? result.status },
        });
      }
      return payment;
    }

    // pending / not found: nothing settled yet; mark an unanswered attempt unknown for polling.
    if (attempt.status === 'in_flight' && source === 'poll') await attempt.update({ status: 'unknown' }, { transaction });
    return payment;
  });
}

/** §12 #3: the provider reports a different amount. Do not succeed; hold in suspense and refund it all. */
async function mismatch(payment, result, base, { transaction }) {
  await payment.update({ ...base, status: 'failed', capturedPoisha: result.amount }, { transaction });
  await ledger.post(
    {
      kind: 'payment.amount_mismatch',
      refType: 'payment',
      refId: payment.id,
      idempotencyKey: `payment.mismatch:${payment.id}`,
      lines: lrules.mismatchLines({ provider: base.provider, amount: result.amount }),
      memo: `${payment.code}: expected ${payment.amountPoisha}, captured ${result.amount}`,
    },
    { transaction }
  );
  await events.publish(transaction, {
    name: 'payment.failed',
    aggregateType: 'payment',
    aggregateId: payment.id,
    payload: { paymentId: payment.id, purpose: payment.purpose, purposeId: payment.purposeId, amount: payment.amountPoisha, payerId: payment.payerId, reason: 'amount_mismatch' },
  });
  await refunds.createInTx(
    { payment, amount: result.amount, kind: 'amount_mismatch', reasonCode: 'amount_mismatch', actorKind: 'system', idempotencyKey: `mismatch:${payment.id}` },
    { transaction }
  );
}

/** A payment paid twice through two attempts: the extra capture goes to suspense and is refunded. */
async function capturedTwice(payment, result, { transaction }) {
  await payment.update({ capturedPoisha: payment.capturedPoisha + result.amount }, { transaction });
  await ledger.post(
    {
      kind: 'payment.duplicate',
      refType: 'payment',
      refId: payment.id,
      idempotencyKey: `payment.duplicate:${payment.id}:${result.providerTrxId}`,
      lines: lrules.mismatchLines({ provider: payment.provider, amount: result.amount }),
      memo: `${payment.code}: paid twice`,
    },
    { transaction }
  );
  await refunds.createInTx(
    { payment, amount: result.amount, kind: 'amount_mismatch', reasonCode: 'duplicate_payment', actorKind: 'system', idempotencyKey: `duplicate:${payment.id}:${result.providerTrxId}` },
    { transaction }
  );
}

// ---------------------------------------------------------------- IPN and return (FR-03, FR-04)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Our tran_id is an attempt id; anything else from the gateway is simply unknown (never a uuid cast error). */
const attemptByTranId = async (tranId) => (UUID_RE.test(String(tranId ?? '')) ? PaymentAttempt.findByPk(String(tranId)) : null);

/**
 * POST /webhooks/sslcommerz. Stores the (redacted) IPN once per provider event (FR-04; a replay is a
 * no-op), checks the signature, then always re-validates with the provider before applying it.
 */
async function handleIpn(body) {
  const provider = providers.get('sslcommerz');
  const parsed = provider.parseWebhook(body);
  const attempt = await attemptByTranId(parsed.tranId);
  let row;
  try {
    row = await ProviderWebhookEvent.create({ provider: provider.code, providerEventId: String(parsed.eventId).slice(0, 120), paymentId: attempt?.paymentId ?? null, signatureOk: parsed.signatureOk, raw: provider.redactIpn(body) });
  } catch (err) {
    if (err instanceof UniqueConstraintError) return { result: 'duplicate' };
    throw err;
  }
  const finish = (result) => row.update({ processedAt: new Date(), result }).then(() => ({ result }));
  if (!parsed.signatureOk) {
    await finish('bad_signature');
    throw new AppError(401, 'WEBHOOK_SIGNATURE_INVALID', 'The notification signature is not valid');
  }
  if (!attempt) return finish('unknown_transaction');
  const result = parsed.status === 'VALID' && parsed.valId ? await provider.verify({ valId: parsed.valId }) : await provider.query({ attemptId: attempt.id });
  if (result.tranId && String(result.tranId) !== attempt.id) return finish('transaction_mismatch');
  await applyResult(attempt.id, result, { source: 'ipn' });
  return finish(result.status);
}

/**
 * The gateway sends the payer back here (POST from SSLCommerz, GET from the simulator). Verify if we
 * can, then send the browser to the web result page, which reads the status from the API (never from
 * this redirect).
 */
async function handleReturn({ pid, tranId, valId }) {
  const target = (id) => (id ? `${config.apps.web}/pay/${id}/result` : `${config.apps.web}/me/payments`);
  const attempt = await attemptByTranId(tranId);
  const paymentId = attempt?.paymentId ?? (/^[0-9a-f-]{36}$/i.test(String(pid ?? '')) ? pid : null);
  if (!attempt) return target(paymentId);
  try {
    const provider = providers.get(attempt.provider);
    const result = valId ? await provider.verify({ valId: String(valId) }) : await provider.query({ attemptId: attempt.id });
    if (!result.tranId || String(result.tranId) === attempt.id) await applyResult(attempt.id, result, { source: 'return' });
  } catch (err) {
    logger.warn({ err: err.message, attemptId: attempt.id }, 'return verify failed; the IPN or polling will settle it');
  }
  return target(paymentId);
}

/** Query the provider for an unfinished attempt and apply what it says. */
async function queryAttempt(attempt, source) {
  const provider = providers.get(attempt.provider);
  const result = await provider.query({ attemptId: attempt.id });
  return applyResult(attempt.id, result, { source });
}

/** POST /payments/:id/verify — the result page asks us to check with the provider now. */
async function verifyForPayer(user, paymentId) {
  const payment = await Payment.findByPk(paymentId);
  if (!payment || payment.payerId !== user.id) throw E.notFound('Payment');
  if (payment.status === 'pending') {
    const open = await PaymentAttempt.findAll({ where: { paymentId, status: ['in_flight', 'unknown'] }, order: [['startedAt', 'DESC']], limit: 1 });
    if (open[0]) {
      try {
        await queryAttempt(open[0], 'verify');
      } catch (err) {
        logger.warn({ err: err.message, paymentId }, 'verify query failed');
      }
    }
  }
  return getForPayer(user, paymentId);
}

/** Job payments.poll-attempt (1, 5, 15 min): ask about an attempt that has no answer yet. */
async function pollAttempt({ attemptId }) {
  const attempt = await PaymentAttempt.findByPk(attemptId);
  if (!attempt || !['in_flight', 'unknown'].includes(attempt.status)) return { skipped: true };
  const payment = await queryAttempt(attempt, 'poll');
  return { status: payment.status };
}

/**
 * Job payments.expire-intents (every minute): intents past expiry (+ the unknown grace). Ask the
 * provider about unfinished attempts first: paid → the capture path (late capture refund if the
 * purpose rejects); otherwise → expired.
 */
async function expireIntents({ limit = 200 } = {}) {
  const grace = settings.get('payments.unknown_grace_minutes') * 60000;
  const due = await Payment.findAll({ where: { status: OPEN, expiresAt: { [Op.lt]: new Date(Date.now() - grace) } }, attributes: ['id'], limit });
  let expired = 0;
  for (const { id } of due) {
    try {
      const open = await PaymentAttempt.findAll({ where: { paymentId: id, status: ['in_flight', 'unknown'] } });
      for (const a of open) await queryAttempt(a, 'expiry');
      const done = await sequelize.transaction(async (transaction) => {
        const p = await lockPayment(id, transaction);
        if (!OPEN.includes(p.status)) return false;
        await PaymentAttempt.update({ status: 'cancelled', finishedAt: new Date() }, { where: { paymentId: id, status: ['in_flight', 'unknown'] }, transaction });
        await p.update({ status: 'expired' }, { transaction });
        await events.publish(transaction, {
          name: 'payment.expired',
          aggregateType: 'payment',
          aggregateId: p.id,
          payload: { paymentId: p.id, purpose: p.purpose, purposeId: p.purposeId, amount: p.amountPoisha, payerId: p.payerId, reason: 'expired' },
        });
        return true;
      });
      if (done) expired += 1;
    } catch (err) {
      logger.error({ err: err.message, paymentId: id }, 'payment expiry failed');
    }
  }
  return { due: due.length, expired };
}

/** Cancel an intent that was never paid (purpose cancelled). */
async function cancelIntent(paymentId, { transaction }) {
  const p = await lockPayment(paymentId, transaction);
  if (!['initiated', 'failed'].includes(p.status)) return p;
  await p.update({ status: 'cancelled' }, { transaction });
  return p;
}

// ---------------------------------------------------------------- read models

function serialize(p, { refunds: rs = [] } = {}) {
  return {
    id: p.id,
    code: p.code,
    purpose: p.purpose,
    purposeId: p.purposeId,
    title: p.title,
    amount: p.amountPoisha,
    captured: p.capturedPoisha,
    refunded: p.refundedPoisha,
    status: p.status,
    method: p.method,
    methodDisplay: p.methodDisplay,
    expiresAt: p.expiresAt,
    succeededAt: p.succeededAt,
    createdAt: p.createdAt,
    refunds: rs.map((r) => ({ id: r.id, amount: r.amountPoisha, status: r.status, reasonCode: r.reasonCode, createdAt: r.createdAt, completedAt: r.completedAt })),
  };
}

/** GET /payments/:id — the payer's view (the payee sees amounts through their own modules). */
async function getForPayer(user, paymentId) {
  const p = await Payment.findByPk(paymentId, { include: [{ association: 'refunds' }] });
  if (!p || p.payerId !== user.id) throw E.notFound('Payment');
  return { ...serialize(p, { refunds: p.refunds.filter((r) => r.status !== 'rejected') }), methods: ['bkash', 'nagad', 'card'] };
}

/** GET /me/payments?cursor&limit */
async function listForPayer(userId, { cursor, limit = 20 } = {}) {
  const where = { payerId: userId, ...(cursor ? { id: { [Op.lt]: cursor } } : {}) };
  const rows = await Payment.findAll({ where, include: [{ association: 'refunds' }], order: [['id', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  return { items: page.map((p) => serialize(p, { refunds: p.refunds.filter((r) => r.status !== 'rejected') })), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
}

/** GET /admin/payments?status&purpose&payerId&code&cursor */
async function adminList({ status, purpose, payerId, code, cursor, limit = 50 } = {}) {
  const where = {
    ...(status ? { status } : {}),
    ...(purpose ? { purpose } : {}),
    ...(payerId ? { payerId } : {}),
    ...(code ? { code: code.toUpperCase() } : {}),
    ...(cursor ? { id: { [Op.lt]: cursor } } : {}),
  };
  const rows = await Payment.findAll({ where, order: [['id', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const people = await directory.accounts(page.flatMap((p) => [p.payerId, p.payeeHintId]));
  const who = (id) => (id ? { id, name: people.get(id)?.displayName ?? null } : null);
  return {
    items: page.map((p) => ({ ...serialize(p), payer: who(p.payerId), payee: who(p.payeeHintId), provider: p.provider })),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  };
}

/** GET /admin/payments/:id — everything finance needs: attempts, refunds, hold and ledger. */
async function adminGet(id) {
  const p = await Payment.findByPk(id, { include: [{ association: 'attempts' }, { association: 'refunds' }] });
  if (!p) throw E.notFound('Payment');
  const hold = await EscrowHold.findOne({ where: { paymentId: id } });
  const refundIds = p.refunds.map((r) => r.id);
  const people = await directory.accounts([p.payerId, p.payeeHintId]);
  const who = (uid) => (uid ? { id: uid, name: people.get(uid)?.displayName ?? null } : null);
  const ledgerTxns = await ledger.transactionsFor([['payment', p.id], ...(hold ? [['escrow_hold', hold.id]] : []), ...refundIds.map((rid) => ['refund', rid])]);
  return {
    ...serialize(p),
    payer: who(p.payerId),
    payee: who(p.payeeHintId),
    provider: p.provider,
    providerTrxId: p.providerTrxId,
    escrow: p.escrow,
    attempts: p.attempts
      .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt))
      .map((a) => ({ id: a.id, provider: a.provider, method: a.method, status: a.status, failureCode: a.failureCode, startedAt: a.startedAt, finishedAt: a.finishedAt })),
    refunds: p.refunds.map(refunds.serialize),
    hold: hold ? escrow.serialize(hold) : null,
    ledger: ledgerTxns,
  };
}

/** Display facts for notifications (M08 reads them here, never from the tables). */
async function facts(paymentId) {
  const p = await Payment.findByPk(paymentId, { attributes: ['id', 'code', 'title', 'methodDisplay', 'payerId'] });
  if (!p) throw E.notFound('Payment');
  return { code: p.code, title: p.title, methodDisplay: p.methodDisplay ?? 'your payment method', payerId: p.payerId };
}

/** M19 facts: a captured payment with its vertical; null until it captured. */
function paymentFactOf(p) {
  if (!p || !p.succeededAt) return null;
  return { paymentId: p.id, purpose: p.purpose, vertical: purposes.PURPOSES[p.purpose]?.vertical ?? 'other', payerId: p.payerId, amount: p.capturedPoisha || p.amountPoisha, refunded: p.refundedPoisha, capturedAt: p.succeededAt };
}
const paymentFact = async (paymentId) => paymentFactOf(await Payment.findByPk(paymentId));

/** M19 reconcile (FactsExporter): payments captured in [since, until). */
async function exportPaymentFacts({ since, until }) {
  const rows = await Payment.findAll({ where: { succeededAt: { [Op.gte]: since, [Op.lt]: until } }, order: [['succeededAt', 'ASC']] });
  return rows.map(paymentFactOf);
}

/** Refund amounts the payer can still get back (PaymentService.getRefundable, §2.4). */
async function getRefundable(paymentId) {
  const p = await Payment.findByPk(paymentId);
  if (!p) throw E.notFound('Payment');
  const rs = await Refund.findAll({ where: { paymentId } });
  return require('./refunds.rules').refundable(p.capturedPoisha, rs.map((r) => ({ status: r.status, amount: r.amountPoisha })));
}

/**
 * M18 refund_rate: payments captured into the payee's escrow holds since `since`, and how many of them
 * had a refund the payee caused (a dispute decided against them, or a reason code in `reasonCodes`).
 */
async function payeeRefundStats(payeeId, since, { reasonCodes = [] } = {}) {
  const [row] = await sequelize.query(
    `SELECT COUNT(DISTINCT h.payment_id)::int AS payments,
            COUNT(DISTINCT r.payment_id) FILTER (WHERE r.status <> 'rejected' AND (r.kind = 'dispute' OR r.reason_code IN (:codes)))::int AS refunded
       FROM escrow_holds h LEFT JOIN refunds r ON r.payment_id = h.payment_id
      WHERE h.payee_id = :payeeId AND h.created_at >= :since`,
    { replacements: { payeeId, since, codes: reasonCodes.length ? reasonCodes : ['-'] }, type: sequelize.QueryTypes.SELECT }
  );
  return { payments: row.payments, refunded: row.refunded };
}

module.exports = {
  payeeRefundStats,
  paymentFact,
  exportPaymentFacts,
  createIntent,
  createTestCharge,
  startAttempt,
  applyResult,
  handleIpn,
  handleReturn,
  verifyForPayer,
  pollAttempt,
  expireIntents,
  cancelIntent,
  getForPayer,
  listForPayer,
  adminList,
  adminGet,
  getRefundable,
  facts,
  serialize,
};
