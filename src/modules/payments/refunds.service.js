'use strict';

/**
 * RefundService (M06 §2.4, §6.5, §8, FR-08, FR-09, FR-10).
 *
 *   create ── within authority ──▶ approved ──(job)──▶ processing ──provider confirms──▶ succeeded
 *          ── staff above cap ───▶ pending_master ──master + step-up──▶ approved
 *                                                 ──master rejects───▶ rejected
 *   provider refusal ──▶ failed ──retry 1 min / 10 min / 1 h──▶ processing … after refunds.retry_max ──▶ manual_required
 *
 * On approval the money leaves its source for refund_clearing (escrow hold, goodwill expense or
 * suspense); when the provider confirms, refund_clearing is cleared against provider_clearing. A
 * refund that can't be paid by the provider stays in refund_clearing as manual_required, for M07 to
 * pay to an account the payer adds (Q50).
 */
const { Op } = require('sequelize');
const { AppError, E } = require('../../common/errors');
const logger = require('../../common/logger');
const { sequelize, Payment, Refund, EscrowHold } = require('../../models');
const settings = require('../settings').settings;
const audit = require('../audit').audit;
const events = require('../events').events;
const providers = require('../../providers/payments');
const ledger = require('./ledger.service');
const lrules = require('./ledger.rules');
const escrow = require('./escrow.service');
const erules = require('./escrow.rules');
const rules = require('./refunds.rules');
const purposes = require('./payments.purposes');
const jobs = require('./payments.jobs');

const MAX_STATUS_POLLS = 24;
const STATUS_POLL_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];

const lockPayment = async (id, transaction) => {
  const p = await Payment.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!p) throw E.notFound('Payment');
  return p;
};
const lockRefund = async (id, transaction) => {
  const r = await Refund.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!r) throw E.notFound('Refund');
  return r;
};

const payload = (r, p) => ({ refundId: r.id, paymentId: p.id, amount: r.amountPoisha, purpose: p.purpose, purposeId: p.purposeId, payerId: p.payerId });

function scheduleProcess(refund, delay = 0, extra = {}) {
  jobs.dispatch(jobs.JOBS.REFUND_PROCESS, { refundId: refund.id, ...extra }, { jobId: `refund-${refund.id}-${refund.attempts}-${extra.polls ?? 0}`, delay });
}

/** Moves the money to refund_clearing and approves (inside the caller's transaction, payment locked). */
async function reserveInTx(refund, payment, hold, { transaction, actor = null }) {
  if (refund.source === 'escrow') await escrow.takeForRefund(hold, refund.amountPoisha, { transaction });
  const def = purposes.get(payment.purpose);
  await ledger.post(
    {
      kind: 'refund.reserve',
      refType: 'refund',
      refId: refund.id,
      idempotencyKey: `refund.reserve:${refund.id}`,
      lines: lrules.refundReserveLines({ source: refund.source, escrowAccount: def.escrowAccount, holdId: hold?.id, amount: refund.amountPoisha }),
      memo: `Refund ${refund.reasonCode} on ${payment.code}`,
      postedBy: actor?.id ?? null,
    },
    { transaction }
  );
  await refund.update({ status: 'approved', approvedBy: actor?.id ?? refund.approvedBy ?? null }, { transaction });
  await events.publish(transaction, { name: 'refund.approved', aggregateType: 'refund', aggregateId: refund.id, payload: payload(refund, payment), actor });
  transaction.afterCommit(() => scheduleProcess(refund));
}

/**
 * Create a refund inside `transaction` with the payment already locked. `actorKind` = system | staff | master.
 * Returns the refund row.
 */
async function createInTx({ payment, amount, kind, reasonCode, reasonText = null, actor = null, actorKind, idempotencyKey, holdId = null }, { transaction }) {
  const existing = await Refund.findOne({ where: { idempotencyKey }, transaction });
  if (existing) return existing;
  const refunds = await Refund.findAll({ where: { paymentId: payment.id }, transaction });
  const left = rules.refundable(payment.capturedPoisha, refunds.map((r) => ({ status: r.status, amount: r.amountPoisha })));
  if (amount > left) throw new AppError(422, 'REFUND_EXCEEDS_CAPTURED', 'That is more than can still be refunded on this payment', { meta: { refundable: left } });

  // A split payment (M13) has a hold per sub-order: the caller names it; otherwise the first hold
  // that still holds enough (single-payee payments have one).
  const holds = await EscrowHold.findAll({ where: { paymentId: payment.id, ...(holdId ? { id: holdId } : {}) }, order: [['createdAt', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
  const hold = holds.find((h) => erules.available(h) >= amount) ?? holds[0] ?? null;
  const source = rules.source({ kind, holdAvailable: hold ? erules.available(hold) : 0, amount, actorKind });
  if (!source) throw new AppError(422, 'REFUND_EXCEEDS_HELD', 'The money has already been released to the payee; only a master can refund it as goodwill', { meta: { held: hold ? erules.available(hold) : 0 } });
  if (source === 'escrow' && hold.status === 'frozen') throw new AppError(409, 'ESCROW_FROZEN', 'This hold is frozen');

  const staffTotal = refunds.filter((r) => r.initiatorKind === 'staff' && rules.COUNTED.has(r.status)).reduce((s, r) => s + r.amountPoisha, 0);
  const status = rules.authority({ actorKind, amount, staffTotal, limit: settings.get('refunds.staff_limit_poisha') });
  const refund = await Refund.create(
    {
      paymentId: payment.id,
      escrowHoldId: source === 'escrow' ? hold.id : null,
      amountPoisha: amount,
      reasonCode,
      reasonText,
      kind,
      source,
      status: status === 'approved' ? 'approved' : 'pending_master',
      initiatedBy: actor?.id ?? null,
      initiatorKind: actorKind,
      recommendedPoisha: status === 'pending_master' ? amount : null,
      idempotencyKey,
    },
    { transaction }
  );
  if (status === 'approved') {
    await reserveInTx(refund, payment, hold, { transaction, actor });
  } else {
    await events.publish(transaction, { name: 'refund.escalated', aggregateType: 'refund', aggregateId: refund.id, payload: payload(refund, payment), actor });
  }
  return refund;
}

/**
 * A purpose module refunds one of its payments by id (M21: tournament cancelled, minimum not met, a
 * player withdrew before close). System policy refunds are approved at once and reserved from escrow.
 * M17 dispute decisions pass kind 'dispute' and the decider as `actor` (initiated_by): M17 has
 * already checked the authority (staff within refunds.staff_limit_poisha, or a master), so they are
 * approved at once too. Returns null when the payment never captured (nothing to refund).
 * Idempotent by key.
 */
async function refundPayment({ paymentId, amount, reasonCode, reasonText = null, idempotencyKey, actor = null, kind = 'policy', splitRef = null }, { transaction }) {
  const payment = await Payment.findByPk(paymentId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!payment || !['succeeded', 'partially_refunded'].includes(payment.status)) return null;
  if (amount <= 0) return null;
  const holdId = splitRef ? await escrow.holdIdForPayment(payment.id, { splitRef }) : null;
  if (splitRef && !holdId) return null;
  return createInTx({ payment, amount, kind, reasonCode, reasonText, actor, actorKind: 'system', idempotencyKey, holdId }, { transaction });
}

/** POST /admin/refunds (refund_small or master; Idempotency-Key). */
async function create(actor, { paymentId, amount, reasonCode, reasonText, goodwill = false }, idempotencyKey, req) {
  const actorKind = actor.isMaster ? 'master' : 'staff';
  const refund = await sequelize.transaction(async (transaction) => {
    const payment = await lockPayment(paymentId, transaction);
    if (!['succeeded', 'partially_refunded'].includes(payment.status)) throw new AppError(409, 'PAYMENT_NOT_REFUNDABLE', 'Only a successful payment can be refunded', { meta: { status: payment.status } });
    const row = await createInTx(
      { payment, amount, kind: goodwill ? 'goodwill' : 'manual', reasonCode, reasonText, actor, actorKind, idempotencyKey: `admin:${actor.id}:${idempotencyKey}` },
      { transaction }
    );
    await audit.record(
      { action: 'refund.requested', actor, entityType: 'refund', entityId: row.id, entityCode: payment.code, after: { amount, status: row.status, source: row.source }, reason: reasonText ?? reasonCode, stepUp: Boolean(req.stepUp), req },
      { transaction }
    );
    return row;
  });
  return serialize(refund);
}

/** POST /admin/refunds/:id/approve (master + step-up refund.large). */
async function approve(actor, id, { note } = {}, req) {
  const refund = await sequelize.transaction(async (transaction) => {
    const row = await lockRefund(id, transaction);
    if (row.status !== 'pending_master') throw new AppError(409, 'REFUND_NOT_PENDING', 'This refund is not waiting for approval', { meta: { status: row.status } });
    const payment = await lockPayment(row.paymentId, transaction);
    const hold = await EscrowHold.findOne({ where: { paymentId: payment.id, ...(row.escrowHoldId ? { id: row.escrowHoldId } : {}) }, order: [['createdAt', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
    if (row.source === 'escrow' && (!hold || erules.available(hold) < row.amountPoisha)) {
      throw new AppError(422, 'REFUND_EXCEEDS_HELD', 'The hold no longer has that much; reject this refund and create a new one');
    }
    await row.update({ decisionNote: note ?? null }, { transaction });
    await reserveInTx(row, payment, hold, { transaction, actor });
    await audit.record({ action: 'refund.approved', actor, entityType: 'refund', entityId: row.id, entityCode: payment.code, after: { amount: row.amountPoisha }, reason: note, stepUp: true, req }, { transaction });
    return row;
  });
  return serialize(refund);
}

/** POST /admin/refunds/:id/reject (master + step-up refund.large). */
async function reject(actor, id, { note }, req) {
  const refund = await sequelize.transaction(async (transaction) => {
    const row = await lockRefund(id, transaction);
    if (row.status !== 'pending_master') throw new AppError(409, 'REFUND_NOT_PENDING', 'This refund is not waiting for approval', { meta: { status: row.status } });
    await row.update({ status: 'rejected', approvedBy: actor.id, decisionNote: note, completedAt: new Date() }, { transaction });
    await audit.record({ action: 'refund.rejected', actor, entityType: 'refund', entityId: row.id, reason: note, stepUp: true, req }, { transaction });
    return row;
  });
  return serialize(refund);
}

/** The provider confirmed: clear refund_clearing, bump the payment, publish refund.succeeded. */
async function settle(refundId) {
  return sequelize.transaction(async (transaction) => {
    const refund = await lockRefund(refundId, transaction);
    if (refund.status === 'succeeded') return refund;
    const payment = await lockPayment(refund.paymentId, transaction);
    await ledger.post(
      {
        kind: 'refund.settle',
        refType: 'refund',
        refId: refund.id,
        idempotencyKey: `refund.settle:${refund.id}`,
        lines: lrules.refundSettleLines({ provider: payment.provider, amount: refund.amountPoisha }),
        memo: `Refund confirmed by ${payment.provider}`,
      },
      { transaction }
    );
    await refund.update({ status: 'succeeded', completedAt: new Date(), lastError: null }, { transaction });
    const refunded = payment.refundedPoisha + refund.amountPoisha;
    await payment.update({ refundedPoisha: refunded, status: rules.paymentStatusAfterRefund({ status: payment.status, captured: payment.capturedPoisha, refunded }) }, { transaction });
    await events.publish(transaction, { name: 'refund.succeeded', aggregateType: 'refund', aggregateId: refund.id, payload: payload(refund, payment) });
    return refund;
  });
}

/**
 * M07-FR-15: a manual_required refund was paid by hand through a refund payout. M07 has already moved
 * the money out of refund_clearing (Dr refund_clearing / Cr payout_clearing, then platform_bank), so
 * this only closes the refund and the payment's refunded total, inside M07's transaction.
 */
async function settleManually(refundId, { payoutCode }, { transaction }) {
  const refund = await lockRefund(refundId, transaction);
  if (refund.status === 'succeeded') return refund;
  if (refund.status !== 'manual_required') throw new AppError(409, 'INVALID_STATE', 'Only a refund waiting to be paid by hand can be settled this way');
  const payment = await lockPayment(refund.paymentId, transaction);
  await refund.update({ status: 'succeeded', completedAt: new Date(), lastError: null, decisionNote: `Paid by hand in payout ${payoutCode}` }, { transaction });
  const refunded = payment.refundedPoisha + refund.amountPoisha;
  await payment.update({ refundedPoisha: refunded, status: rules.paymentStatusAfterRefund({ status: payment.status, captured: payment.capturedPoisha, refunded }) }, { transaction });
  await events.publish(transaction, { name: 'refund.succeeded', aggregateType: 'refund', aggregateId: refund.id, payload: payload(refund, payment) });
  return refund;
}

/** A provider refusal: retry with backoff, then manual_required (FR-10). */
async function fail(refundId, err) {
  const retryMax = settings.get('refunds.retry_max');
  return sequelize.transaction(async (transaction) => {
    const refund = await lockRefund(refundId, transaction);
    const payment = await Payment.findByPk(refund.paymentId, { transaction });
    const attempts = refund.attempts + 1;
    const permanent = err.retryable === false;
    if (attempts >= retryMax || permanent) {
      await refund.update({ status: 'manual_required', attempts, lastError: String(err.code ?? err.message).slice(0, 120) }, { transaction });
      await events.publish(transaction, { name: 'refund.manual_required', aggregateType: 'refund', aggregateId: refund.id, payload: payload(refund, payment) });
    } else {
      await refund.update({ status: 'failed', attempts, lastError: String(err.code ?? err.message).slice(0, 120) }, { transaction });
      await events.publish(transaction, { name: 'refund.failed', aggregateType: 'refund', aggregateId: refund.id, payload: payload(refund, payment) });
      transaction.afterCommit(() => scheduleProcess(refund, rules.retryDelay(attempts)));
    }
    return refund;
  });
}

/**
 * Job refunds.process: call the provider for an approved (or failed, retrying) refund, then poll its
 * status until it is confirmed. Idempotent: the provider gets the refund id as its reference, and the
 * status guard skips refunds that are already done.
 */
async function processRefund({ refundId, polls = 0 }) {
  const refund = await Refund.findByPk(refundId);
  if (!refund || !['approved', 'failed', 'processing'].includes(refund.status)) return { skipped: refund?.status ?? 'missing' };
  const payment = await Payment.findByPk(refund.paymentId);
  const provider = providers.get(payment.provider);
  try {
    if (!refund.providerRefundId) {
      const res = await provider.refund({ payment, refund });
      await refund.update({ status: 'processing', providerRefundId: res.providerRefundId, attempts: refund.attempts + 1, lastError: null });
      if (res.status === 'succeeded') return { status: (await settle(refund.id)).status };
      scheduleProcess(refund, STATUS_POLL_MS[0], { polls: 1 });
      return { status: 'processing' };
    }
    const st = await provider.refundStatus({ providerRefundId: refund.providerRefundId });
    if (st.status === 'succeeded') return { status: (await settle(refund.id)).status };
    if (st.status === 'failed') return { status: (await fail(refund.id, { code: st.reason ?? 'REFUND_FAILED', retryable: false })).status };
    if (polls < MAX_STATUS_POLLS) scheduleProcess(refund, STATUS_POLL_MS[Math.min(polls, STATUS_POLL_MS.length - 1)], { polls: polls + 1 });
    return { status: 'processing' };
  } catch (err) {
    logger.warn({ err: err.message, refundId }, 'provider refund call failed');
    return { status: (await fail(refund.id, err)).status };
  }
}

function serialize(r) {
  return {
    id: r.id,
    paymentId: r.paymentId,
    amount: r.amountPoisha,
    reasonCode: r.reasonCode,
    reasonText: r.reasonText,
    kind: r.kind,
    source: r.source,
    status: r.status,
    initiatedBy: r.initiatedBy,
    initiatorKind: r.initiatorKind,
    recommended: r.recommendedPoisha,
    approvedBy: r.approvedBy,
    decisionNote: r.decisionNote,
    attempts: r.attempts,
    lastError: r.lastError,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  };
}

/** GET /admin/refunds?status&paymentId&cursor */
async function list({ status, paymentId, cursor, limit = 50 } = {}) {
  const where = { ...(status ? { status } : {}), ...(paymentId ? { paymentId } : {}), ...(cursor ? { id: { [Op.lt]: cursor } } : {}) };
  const rows = await Refund.findAll({ where, include: [{ association: 'payment', attributes: ['code', 'title', 'payerId', 'method', 'methodDisplay'] }], order: [['id', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => ({ ...serialize(r), payment: { code: r.payment.code, title: r.payment.title, payerId: r.payment.payerId, methodDisplay: r.payment.methodDisplay } })),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  };
}

/** Display facts for notifications (M08 reads them here, never from the tables). */
async function facts(id) {
  const r = await Refund.findByPk(id, { attributes: ['initiatedBy', 'reasonCode', 'reasonText', 'attempts'] });
  if (!r) throw E.notFound('Refund');
  return { initiatedBy: r.initiatedBy, reasonCode: r.reasonCode, reasonText: r.reasonText, attempts: r.attempts };
}

module.exports = { createInTx, refundPayment, create, approve, reject, processRefund, settle, settleManually, fail, list, serialize, facts };
