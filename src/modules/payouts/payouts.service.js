'use strict';

/**
 * PayoutService (M07 §5, §6, §8). Turns what the M06 ledger owes payees (payable:user:*) into payouts:
 *
 *   build (schedule run) ─▶ scheduled | needs_approval (> threshold) | on_hold (a hold is active)
 *   scheduled ─release─▶ processing          needs_approval ─2nd distinct master─▶ processing
 *   processing ─mark paid─▶ paid             processing ─mark failed─▶ failed ─retry─▶ processing
 *   scheduled | needs_approval | on_hold | failed ─cancel─▶ cancelled (items return to the pool)
 *
 * Step 1 disburses by hand: a staff member reveals the wallet number (audited, never stored or
 * logged), sends the money in the bKash or Nagad merchant app, then marks the payout paid with the
 * provider reference, or failed. Ledger (FR-08), each posting idempotent by payout and attempt:
 *   release   Dr payable:user:{payee} (amount + netting) / Cr payout_clearing / Cr fee_receivable:user:{payee}
 *             (refund payouts: Dr refund_clearing / Cr payout_clearing, never netted, FR-15)
 *   paid      Dr payout_clearing / Cr platform_bank
 *   failed    the release is reversed: the money is owed to the payee (or the payer) again
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { AppError, E } = require('../../common/errors');
const { nextCode } = require('../../common/sequences');
const { taka } = require('../../common/csv');
const logger = require('../../common/logger');
const { queueItem } = require('../../common/actions');
const authz = require('../auth').authz;
const { sequelize, Payout, PayoutItem, PayoutBatch, PayoutApproval, PayoutReveal, PayoutAccount } = require('../../models');
const audit = require('../audit').audit;
const events = require('../events').events;
const settings = require('../settings').settings;
const directory = require('../users').directory;
const ledger = require('../payments').ledger;
const purposes = require('../payments').purposes;
const invariants = require('../payments').invariants;
const accounts = require('./payout-accounts.service');
const holds = require('./holds.service');
const rules = require('./payouts.rules');

const ERRORS = {
  INVALID_STATE: [409, 'This payout cannot do that in its current state'],
  SELF_PAYOUT_FORBIDDEN: [403, 'You cannot release or approve a payout to yourself'],
  FOUR_EYES_REQUIRED: [409, 'This payout is above the four-eyes threshold and needs two masters to approve it'],
  SAME_APPROVER: [409, 'A different master must give the second approval'],
  HOLD_ACTOR_CANNOT_APPROVE: [409, 'You placed or lifted this payout’s latest hold, so another master must approve it'],
  MASTER_REQUIRED: [403, 'Only a master admin can do this'],
  PAYOUT_ACCOUNT_REQUIRED: [409, 'The payee has no verified payout account yet'],
  PAYOUT_ACCOUNT_UNVERIFIED: [409, 'The payee’s payout account is not verified'],
  PAYOUT_ON_HOLD: [409, 'This payout is on hold'],
  PAYOUT_ACCOUNT_UPDATE_REQUIRED: [409, 'The payee must update their payout account before this payout is retried'],
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : undefined);

const SCHEDULE_FOR = (purpose) => purposes.PURPOSES[purpose]?.payoutSchedule ?? null;
const scheduleSettings = () => ({
  runHour: settings.get('payouts.run_hour'),
  dailyEnabled: settings.get('payouts.daily_enabled'),
  groundWeekday: settings.get('payouts.ground_weekday'),
  shopWeekday: settings.get('payouts.shop_weekday'),
});
const rulesNow = () => ({
  threshold: settings.get('payouts.four_eyes_threshold_poisha'),
  minAmount: settings.get('payouts.min_amount_poisha'),
  autoReleaseMax: settings.get('payouts.auto_release_max_poisha'),
});
const feeReceivableCode = (payeeId) => `fee_receivable:user:${payeeId}`;
/** What the payee owes the platform (fee receivable is an asset: debit − credit). */
const feesOwed = async (payeeId, transaction) => Math.max(0, -(await ledger.balance(feeReceivableCode(payeeId), transaction)));

// ---------------------------------------------------------------- views

function serialize(p, { account = null } = {}) {
  return {
    id: p.id,
    code: p.code,
    kind: p.kind,
    payeeId: p.payeeId,
    batchId: p.batchId ?? null,
    refundId: p.refundId ?? null,
    status: p.status,
    gross: p.grossPoisha,
    deductions: p.deductionsPoisha,
    netting: p.nettingPoisha,
    adjustments: p.adjustmentsPoisha,
    amount: p.amountPoisha,
    threshold: p.rulesSnapshot.threshold,
    account: account ? { id: account.id, type: account.type, masked: rules.maskAccount(account.type, account.accountNoLast4), status: account.status } : null,
    channel: p.channel ?? null,
    providerRef: p.providerRef ?? null,
    attempts: p.attempts,
    failureCode: p.failureCode ?? null,
    failureNote: p.failureNote ?? null,
    periodStart: p.periodStart ?? null,
    periodEnd: p.periodEnd ?? null,
    releasedBy: p.releasedBy ?? null,
    releasedAt: p.releasedAt ?? null,
    paidAt: p.paidAt ?? null,
    createdAt: p.createdAt,
  };
}

const serializeItem = (i) => ({
  id: i.id,
  sourceType: i.sourceType,
  sourceId: i.sourceId,
  ledgerEntryId: i.ledgerEntryId,
  gross: i.grossPoisha,
  fee: i.feePoisha,
  providerCharge: i.providerChargePoisha ?? 0,
  net: i.netPoisha,
  description: i.description,
  status: i.status,
});

/** The account a payout shows: the one it was released to, else the payee's active account. */
async function accountOf(p, transaction) {
  if (p.payoutAccountId) return PayoutAccount.findByPk(p.payoutAccountId, { transaction });
  return accounts.activeFor(p.payeeId, { transaction });
}

// ---------------------------------------------------------------- building (FR-03 to FR-07, §10)

/** A short description of where an item's money came from (read through M06's services). */
async function describe(entry) {
  if (entry.debit > 0) return entry.kind === 'reversal' ? 'Correction to an earlier payment' : `Deduction (${entry.kind})`;
  if (entry.source === 'pool') return 'Esports prize';
  if (entry.source === 'escrow_hold') {
    try {
      const hold = await require('../payments').escrow.getOne(entry.sourceId);
      const p = await require('../payments').intents.facts(hold.paymentId);
      return `${p.title} (${p.code})`.slice(0, 200);
    } catch {
      return 'Released payment';
    }
  }
  return entry.kind;
}

/** Entries still unpaid for each payee, as items, grouped by schedule. */
async function eligibleByPayee({ upTo, payeeIds = null, transaction }) {
  if (payeeIds && !payeeIds.length) return new Map();
  const entries = await ledger.payableEntries({ upTo, payeeIds, transaction });
  if (!entries.length) return new Map();
  const consumed = await PayoutItem.findAll({
    where: { status: 'included', ledgerEntryId: { [Op.in]: entries.map((e) => e.entryId) } },
    attributes: ['ledgerEntryId'],
    transaction,
  });
  const used = new Set(consumed.map((c) => c.ledgerEntryId));
  const byPayee = new Map();
  for (const e of entries) {
    if (used.has(e.entryId)) continue;
    const schedule = SCHEDULE_FOR(e.purpose);
    if (!schedule || schedule === 'withdraw') continue;
    const v = rules.itemValues({ credit: e.credit, debit: e.debit, fee: e.fee, providerCharge: e.providerCharge ?? 0 });
    const item = {
      entry: e,
      schedule,
      sourceType: e.debit > 0 ? 'reversal' : e.source === 'pool' ? 'pool' : 'escrow_hold',
      sourceId: e.sourceId,
      ledgerEntryId: e.entryId,
      ...v,
    };
    if (!byPayee.has(e.payeeId)) byPayee.set(e.payeeId, []);
    byPayee.get(e.payeeId).push(item);
  }
  return byPayee;
}

/** One payee's payout in a batch, in its own transaction (a conflict skips the payee, never the batch). */
async function buildForPayee(batch, payeeId, items, limits, now) {
  try {
    return await sequelize.transaction(async (transaction) => {
      const open = await Payout.findOne({ where: { payeeId, kind: 'earning', status: rules.OPEN }, transaction });
      if (open) return { skipped: 'open_payout' };
      const active = await holds.activeFor(payeeId, { transaction, now });
      const kept = items.filter((i) => !rules.itemHeld(i, active, now));
      if (!kept.length) return { skipped: 'held' };
      const t = rules.totals(kept, { feeReceivable: await feesOwed(payeeId, transaction) });
      if (rules.belowMinimum(t.amount, limits.minAmount)) return { skipped: 'below_minimum' };
      const blocked = rules.blockingHolds(active, now).length > 0;
      const { status, autoRelease } = rules.statusFor({ amount: t.amount, threshold: limits.threshold, autoReleaseMax: limits.autoReleaseMax, blocked });
      const account = await accounts.activeFor(payeeId, { transaction });
      const posted = kept.map((i) => new Date(i.entry.postedAt).getTime());
      const payout = await Payout.create(
        {
          code: await nextCode('PO', transaction, now),
          batchId: batch.id,
          payeeId,
          kind: 'earning',
          payoutAccountId: null,
          periodStart: new Date(Math.min(...posted)),
          periodEnd: batch.windowEnd,
          grossPoisha: t.gross,
          deductionsPoisha: t.deductions,
          nettingPoisha: t.netting,
          adjustmentsPoisha: t.adjustments,
          amountPoisha: t.amount,
          status,
          rulesSnapshot: { ...limits, schedule: batch.schedule, settingsVersions: settings.snapshot(['payouts.four_eyes_threshold_poisha', 'payouts.min_amount_poisha', 'payouts.auto_release_max_poisha']) },
        },
        { transaction }
      );
      const rows = [];
      for (const i of kept) {
        rows.push({ payoutId: payout.id, sourceType: i.sourceType, sourceId: i.sourceId, ledgerEntryId: i.ledgerEntryId, grossPoisha: i.gross, feePoisha: i.fee, providerChargePoisha: i.providerCharge ?? 0, netPoisha: i.net, description: await describe(i.entry) });
      }
      if (t.netting > 0) {
        rows.push({ payoutId: payout.id, sourceType: 'fee_netting', sourceId: payeeId, ledgerEntryId: null, grossPoisha: 0, feePoisha: 0, netPoisha: -t.netting, description: 'Fees you owe (venue cash and walk-ins), netted' });
      }
      await PayoutItem.bulkCreate(rows, { transaction });
      await publishScheduled(payout, transaction);
      return { payoutId: payout.id, status, autoRelease, hasAccount: Boolean(account) };
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) return { skipped: 'conflict' };
    throw err;
  }
}

async function publishScheduled(payout, transaction) {
  const payload = { payoutId: payout.id, code: payout.code, payeeId: payout.payeeId, amount: payout.amountPoisha, status: payout.status, kind: payout.kind };
  await events.publish(transaction, { name: 'payout.scheduled', aggregateType: 'payout', aggregateId: payout.id, payload });
  if (payout.status === 'needs_approval') {
    await events.publish(transaction, {
      name: 'payout.approval_requested',
      aggregateType: 'payout',
      aggregateId: payout.id,
      payload: { payoutId: payout.id, code: payout.code, payeeId: payout.payeeId, amount: payout.amountPoisha },
    });
  }
}

/**
 * Build one schedule window (FR-05). Idempotent: the batch row is UNIQUE(schedule, window_end), each
 * ledger entry is used once, and a payee with an open payout gets nothing new until it is settled.
 * A batch interrupted mid-way is resumed by the next run.
 */
async function buildBatch({ schedule, windowEnd, actor = null, now = new Date() }) {
  let batch;
  try {
    batch = await PayoutBatch.create({ schedule, windowEnd, status: 'building', createdBy: actor?.id ?? null });
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    batch = await PayoutBatch.findOne({ where: { schedule, windowEnd } });
    if (batch.status !== 'building') return { batch: serializeBatch(batch), created: false };
  }
  const limits = rulesNow();
  const byPayee = await eligibleByPayee({ upTo: windowEnd });
  const results = [];
  for (const [payeeId, items] of byPayee) {
    const mine = items.filter((i) => i.schedule === schedule);
    if (mine.length) results.push({ payeeId, ...(await buildForPayee(batch, payeeId, mine, limits, now)) });
  }
  const made = await Payout.findAll({ where: { batchId: batch.id }, attributes: ['amountPoisha', 'status'] });
  const totals = {
    payouts: made.length,
    amount: made.reduce((s, p) => s + p.amountPoisha, 0),
    needsApproval: made.filter((p) => p.status === 'needs_approval').length,
    onHold: made.filter((p) => p.status === 'on_hold').length,
    skipped: results.filter((r) => r.skipped).reduce((acc, r) => ({ ...acc, [r.skipped]: (acc[r.skipped] ?? 0) + 1 }), {}),
  };
  await batch.update({ status: 'ready', totals });
  if (actor) {
    await audit.record({ action: 'payout_batch.run', actor, entityType: 'payout_batch', entityId: batch.id, after: { schedule, windowEnd, ...totals } });
  }
  for (const r of results.filter((x) => x.autoRelease && x.hasAccount)) {
    try {
      await releaseAuto(r.payoutId);
    } catch (err) {
      logger.info({ payoutId: r.payoutId, code: err.code }, 'payout not auto-released');
    }
  }
  return { batch: serializeBatch(batch), created: true };
}

/** Job payouts.schedule (hourly): build every schedule due now (settings-driven, Asia/Dhaka). */
async function runDue(now = new Date()) {
  const due = rules.dueSchedules(now, scheduleSettings());
  const out = [];
  for (const d of due) out.push(await buildBatch({ ...d, now }));
  return { built: out.filter((o) => o.created).length, due: due.length };
}

/** POST /admin/payout-batches/run (master): build a schedule now, for a catch-up or in dev. */
async function runNow(actor, { schedule }) {
  if (!['daily', 'ground_weekly', 'shop_weekly'].includes(schedule)) throw E.badRequest('SCHEDULE_INVALID', 'Unknown payout schedule');
  // The window ends now: everything released up to this moment is in it.
  return buildBatch({ schedule, windowEnd: new Date(), actor });
}

function serializeBatch(b) {
  return { id: b.id, schedule: b.schedule, windowEnd: b.windowEnd, status: b.status, totals: b.totals ?? null, createdBy: b.createdBy ?? null, createdAt: b.createdAt };
}

async function listBatches({ cursor, limit = 50 } = {}) {
  const rows = await PayoutBatch.findAll({ where: cursor ? { id: { [Op.lt]: cursor } } : {}, order: [['id', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  return { items: page.map(serializeBatch), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
}

// ---------------------------------------------------------------- refund payouts (FR-15, Q50)

/**
 * M06 refund.manual_required: the provider could not refund, so the money in refund_clearing is paid
 * to the payer by hand, to a payout account they add and staff verify. Never netted, no batch.
 */
async function createRefundPayout({ refundId, payerId, amount }, { transaction: outer } = {}) {
  const run = (fn) => (outer ? fn(outer) : sequelize.transaction(fn));
  return run(async (transaction) => {
    const existing = await Payout.findOne({ where: { refundId }, transaction });
    if (existing) return serialize(existing);
    const now = new Date();
    const limits = rulesNow();
    const active = await holds.activeFor(payerId, { transaction, now });
    const { status } = rules.statusFor({ amount, threshold: limits.threshold, autoReleaseMax: 0, blocked: rules.blockingHolds(active, now).length > 0 });
    const payout = await Payout.create(
      {
        code: await nextCode('PO', transaction, now),
        payeeId: payerId,
        kind: 'refund',
        refundId,
        grossPoisha: amount,
        amountPoisha: amount,
        status,
        rulesSnapshot: { ...limits, schedule: 'refund' },
      },
      { transaction }
    );
    await PayoutItem.create({ payoutId: payout.id, sourceType: 'refund', sourceId: refundId, grossPoisha: amount, feePoisha: 0, netPoisha: amount, description: 'Refund we could not send automatically' }, { transaction });
    await publishScheduled(payout, transaction);
    return serialize(payout);
  });
}

// ---------------------------------------------------------------- disbursement (FR-07 to FR-10)

async function lockPayout(id, transaction) {
  const p = await Payout.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!p) throw E.notFound('Payout');
  return p;
}

const asRule = (p) => ({ id: p.id, payeeId: p.payeeId, status: p.status, amount: p.amountPoisha, accountId: p.payoutAccountId, failureCode: p.failureCode, rules: p.rulesSnapshot });

const releaseLines = (p) =>
  p.kind === 'refund'
    ? [{ account: 'refund_clearing', debit: p.amountPoisha }, { account: 'payout_clearing', credit: p.amountPoisha }]
    : [
        { account: `payable:user:${p.payeeId}`, debit: p.amountPoisha + p.nettingPoisha },
        { account: 'payout_clearing', credit: p.amountPoisha },
        ...(p.nettingPoisha > 0 ? [{ account: feeReceivableCode(p.payeeId), credit: p.nettingPoisha }] : []),
      ];

/** Move a payout to processing: guards, then the release posting (inside the caller's transaction). */
async function disburseInTx(p, actor, transaction, { allowed = ['scheduled', 'needs_approval', 'failed'] } = {}) {
  if (!allowed.includes(p.status) || !rules.canTransition(p.status, 'processing')) throw fail('INVALID_STATE');
  const account = await accounts.activeFor(p.payeeId, { transaction });
  const block = rules.disburseBlock({ payout: asRule(p), account, holds: await holds.activeFor(p.payeeId, { transaction }), now: new Date() });
  if (block) throw fail(block);
  const attempt = p.attempts + 1;
  const posted = await ledger.post(
    {
      kind: 'payout.release',
      refType: 'payout',
      refId: p.id,
      idempotencyKey: `payout.release:${p.id}:${attempt}`,
      lines: releaseLines(p),
      memo: `${p.code} released (attempt ${attempt})`,
      postedBy: actor?.id ?? null,
    },
    { transaction }
  );
  await p.update(
    {
      status: 'processing',
      payoutAccountId: account.id,
      channel: 'manual',
      attempts: attempt,
      releasedBy: actor?.id ?? null,
      releasedAt: new Date(),
      failureCode: null,
      failureNote: null,
      ledgerTxnIds: [...p.ledgerTxnIds, posted.id],
    },
    { transaction }
  );
  await events.publish(transaction, {
    name: 'payout.released',
    aggregateType: 'payout',
    aggregateId: p.id,
    payload: { payoutId: p.id, code: p.code, payeeId: p.payeeId, amount: p.amountPoisha, attempt },
    actor,
  });
  return account;
}

/** POST /admin/payouts/:id/release: up to the threshold, by release_payouts staff or a master (step-up). */
async function release(actor, id, req) {
  return sequelize.transaction(async (transaction) => {
    const p = await lockPayout(id, transaction);
    const block = rules.releaseBlock({ payout: asRule(p), actorId: actor.id });
    if (block) throw fail(block);
    const before = serialize(p);
    const account = await disburseInTx(p, actor, transaction, { allowed: ['scheduled'] });
    await audit.record({ action: 'payout.released', actor, entityType: 'payout', entityId: p.id, entityCode: p.code, before, after: serialize(p, { account }), req }, { transaction });
    return serialize(p, { account });
  });
}

/** Auto-release (§6.3; payouts.auto_release_max_poisha, 0 = off): the system releases a small, clean payout. */
async function releaseAuto(id) {
  return sequelize.transaction(async (transaction) => {
    const p = await lockPayout(id, transaction);
    const limit = settings.get('payouts.auto_release_max_poisha');
    if (p.status !== 'scheduled' || limit <= 0 || p.amountPoisha > limit) throw fail('INVALID_STATE');
    const account = await disburseInTx(p, null, transaction, { allowed: ['scheduled'] });
    await audit.record({ action: 'payout.released', actor: null, entityType: 'payout', entityId: p.id, entityCode: p.code, after: serialize(p, { account }), meta: { automatic: true } }, { transaction });
    return serialize(p, { account });
  });
}

/** POST /admin/payouts/:id/approve (master + step-up): step 1 of 2, or step 2 which releases it (FR-07). */
async function approve(actor, id, req) {
  return sequelize.transaction(async (transaction) => {
    const p = await lockPayout(id, transaction);
    const approvals = await PayoutApproval.findAll({ where: { payoutId: p.id }, order: [['step', 'ASC']], transaction });
    const holdActorIds = await holds.manualActors(p, { transaction });
    const result = rules.approvalStep({ payout: asRule(p), actorId: actor.id, isMaster: actor.isMaster, approvals, holdActorIds });
    if (result.error) throw fail(result.error);
    try {
      await sequelize.transaction({ transaction }, (savepoint) => PayoutApproval.create({ payoutId: p.id, approverId: actor.id, step: result.step }, { transaction: savepoint }));
    } catch (err) {
      // Two masters approving the same step at once: the second loses (edge case 4).
      if (err instanceof UniqueConstraintError) throw fail('INVALID_STATE');
      throw err;
    }
    const before = serialize(p);
    let account = null;
    if (result.step === 2) account = await disburseInTx(p, actor, transaction, { allowed: ['needs_approval'] });
    await audit.record(
      { action: 'payout.approved', actor, entityType: 'payout', entityId: p.id, entityCode: p.code, before, after: serialize(p, { account }), meta: { step: result.step }, req },
      { transaction }
    );
    return { ...serialize(p, { account: account ?? (await accountOf(p, transaction)) }), approvals: await approvalsOf(p.id, transaction) };
  });
}

/**
 * POST /admin/payouts/:id/reveal (release_payouts or master + step-up): the full wallet number, so
 * the payout can be sent by hand. Only while processing; every reveal is recorded and audited
 * (critical). The number is in this response only: never stored, logged or cached.
 */
async function reveal(actor, id, req) {
  return sequelize.transaction(async (transaction) => {
    const p = await lockPayout(id, transaction);
    if (p.status !== 'processing') throw new AppError(409, 'PAYOUT_REVEAL_FORBIDDEN', 'The number is shown only while a released payout is being sent');
    if (p.payeeId === actor.id) throw fail('SELF_PAYOUT_FORBIDDEN');
    const account = await PayoutAccount.findByPk(p.payoutAccountId, { transaction });
    await PayoutReveal.create({ payoutId: p.id, accountId: account.id, staffId: actor.id }, { transaction });
    await audit.record(
      { action: 'payout.account_revealed', actor, entityType: 'payout', entityId: p.id, entityCode: p.code, meta: { accountId: account.id, last4: account.accountNoLast4 }, req },
      { transaction }
    );
    return {
      payoutId: p.id,
      code: p.code,
      amount: p.amountPoisha,
      type: account.type,
      accountName: account.accountName,
      number: accounts.fullNumber(account),
      showForSeconds: 60,
    };
  });
}

/** POST /admin/payouts/:id/mark-paid: the money was sent; record the provider reference (FR-08). */
async function markPaid(actor, id, { reference, note }, req) {
  return sequelize.transaction(async (transaction) => {
    const p = await lockPayout(id, transaction);
    if (!rules.canTransition(p.status, 'paid')) throw fail('INVALID_STATE');
    if (p.payeeId === actor.id) throw fail('SELF_PAYOUT_FORBIDDEN');
    const before = serialize(p);
    const posted = await ledger.post(
      {
        kind: 'payout.paid',
        refType: 'payout',
        refId: p.id,
        idempotencyKey: `payout.paid:${p.id}:${p.attempts}`,
        lines: [{ account: 'payout_clearing', debit: p.amountPoisha }, { account: 'platform_bank', credit: p.amountPoisha }],
        memo: `${p.code} paid, ref ${reference}`.slice(0, 300),
        postedBy: actor.id,
      },
      { transaction }
    );
    await p.update({ status: 'paid', providerRef: reference, paidBy: actor.id, paidAt: new Date(), ledgerTxnIds: [...p.ledgerTxnIds, posted.id] }, { transaction });
    if (p.kind === 'refund') await require('../payments').refunds.settleManually(p.refundId, { payoutCode: p.code }, { transaction });
    const account = await accountOf(p, transaction);
    await events.publish(transaction, {
      name: 'payout.paid',
      aggregateType: 'payout',
      aggregateId: p.id,
      payload: { payoutId: p.id, code: p.code, payeeId: p.payeeId, amount: p.amountPoisha, kind: p.kind },
      actor,
      req,
    });
    await audit.record({ action: 'payout.marked_paid', actor, entityType: 'payout', entityId: p.id, entityCode: p.code, before, after: serialize(p, { account }), reason: note ?? null, req }, { transaction });
    return serialize(p, { account });
  });
}

/** POST /admin/payouts/:id/mark-failed: the send failed; the release is reversed (FR-10). */
async function markFailed(actor, id, { reason, note }, req) {
  return sequelize.transaction(async (transaction) => {
    const p = await lockPayout(id, transaction);
    if (!rules.canTransition(p.status, 'failed')) throw fail('INVALID_STATE');
    const before = serialize(p);
    const releaseTxn = p.ledgerTxnIds[p.ledgerTxnIds.length - 1];
    const reversed = await ledger.reverse(releaseTxn, { idempotencyKey: `payout.failed:${p.id}:${p.attempts}`, memo: `${p.code} failed: ${reason}`, postedBy: actor.id, kind: 'payout.failed' }, { transaction });
    const retryable = rules.FAILURE_REASONS[reason].retryable;
    await p.update({ status: 'failed', failureCode: reason, failureNote: note ?? null, ledgerTxnIds: [...p.ledgerTxnIds, reversed.id] }, { transaction });
    await events.publish(transaction, {
      name: 'payout.failed',
      aggregateType: 'payout',
      aggregateId: p.id,
      payload: { payoutId: p.id, code: p.code, payeeId: p.payeeId, amount: p.amountPoisha, reason, retryable },
      actor,
      req,
    });
    await audit.record({ action: 'payout.marked_failed', actor, entityType: 'payout', entityId: p.id, entityCode: p.code, before, after: serialize(p), reason: note ?? reason, meta: { reason, retryable }, req }, { transaction });
    return serialize(p, { account: await accountOf(p, transaction) });
  });
}

/** POST /admin/payouts/:id/retry: back to processing (transient failure, or the payee fixed their account). */
async function retry(actor, id, req) {
  return sequelize.transaction(async (transaction) => {
    const p = await lockPayout(id, transaction);
    if (p.payeeId === actor.id) throw fail('SELF_PAYOUT_FORBIDDEN');
    const block = rules.retryBlock({ payout: asRule(p), account: await accounts.activeFor(p.payeeId, { transaction }) });
    if (block) throw fail(block);
    if (p.amountPoisha > p.rulesSnapshot.threshold && !actor.isMaster) throw fail('MASTER_REQUIRED');
    const before = serialize(p);
    const account = await disburseInTx(p, actor, transaction, { allowed: ['failed'] });
    await audit.record({ action: 'payout.released', actor, entityType: 'payout', entityId: p.id, entityCode: p.code, before, after: serialize(p, { account }), meta: { retry: true }, req }, { transaction });
    return serialize(p, { account });
  });
}

/** POST /admin/payouts/:id/cancel: before processing (or after a failure); the items return to the pool. */
async function cancel(actor, id, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const p = await lockPayout(id, transaction);
    if (p.kind === 'refund' || !rules.canTransition(p.status, 'cancelled')) throw fail('INVALID_STATE');
    const before = serialize(p);
    await p.update({ status: 'cancelled' }, { transaction });
    await PayoutItem.update({ status: 'returned' }, { where: { payoutId: p.id, status: 'included' }, transaction });
    await audit.record({ action: 'payout.cancelled', actor, entityType: 'payout', entityId: p.id, entityCode: p.code, before, after: serialize(p), reason, req }, { transaction });
    return serialize(p);
  });
}

// ---------------------------------------------------------------- holds (FR-06, FR-13)

/** POST /admin/payouts/:id/hold: a manual hold on this payout, or on the payee (all their payouts). */
async function placeManualHold(actor, id, { reason, scope = 'payout' }, req) {
  return sequelize.transaction(async (transaction) => {
    const p = await lockPayout(id, transaction);
    if (!rules.OPEN.includes(p.status)) throw fail('INVALID_STATE');
    const { hold } = await holds.place(
      { payeeId: p.payeeId, scope, type: 'manual', payoutId: scope === 'payout' ? p.id : null, refId: require('../../common/uuid7').uuid7(), reason },
      actor,
      { transaction }
    );
    await audit.record({ action: 'payout.held', actor, entityType: 'payout', entityId: p.id, entityCode: p.code, after: holds.serialize(hold), reason, req }, { transaction });
    return detailInTx(p.id, transaction);
  });
}

/** POST /admin/payouts/:id/lift-hold: manual holds only; risk and dispute holds are lifted where they were placed (FR-13). */
async function liftManualHold(actor, id, { holdId, reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const p = await lockPayout(id, transaction);
    const all = await holds.forPayout(p, { transaction });
    const hold = all.find((h) => h.id === holdId);
    if (!hold || hold.liftedAt) throw E.notFound('Active hold');
    if (hold.type === 'risk_freeze') throw new AppError(409, 'RISK_HOLD_MANAGED_IN_RISK', 'A risk freeze is lifted by clearing the flag on the Risk desk');
    if (hold.type !== 'manual') throw new AppError(409, 'HOLD_NOT_LIFTABLE', 'This hold ends on its own (or where it was placed)');
    const lifted = await holds.lift(holdId, { reason }, actor, { transaction });
    await audit.record({ action: 'payout.hold_lifted', actor, entityType: 'payout', entityId: p.id, entityCode: p.code, before: hold, after: holds.serialize(lifted), reason, req }, { transaction });
    return detailInTx(p.id, transaction);
  });
}

// ---------------------------------------------------------------- reads

async function approvalsOf(payoutId, transaction) {
  const rows = await PayoutApproval.findAll({ where: { payoutId }, order: [['step', 'ASC']], transaction });
  const names = await directory.contactFor(rows.map((r) => r.approverId));
  return rows.map((r) => ({ step: r.step, by: r.approverId, name: names.get(r.approverId)?.displayName ?? null, at: r.approvedAt }));
}

async function detailInTx(id, transaction) {
  const p = await Payout.findByPk(id, { transaction });
  if (!p) throw E.notFound('Payout');
  const items = await PayoutItem.findAll({ where: { payoutId: p.id }, order: [['createdAt', 'ASC'], ['id', 'ASC']], transaction });
  const reveals = await PayoutReveal.count({ where: { payoutId: p.id }, transaction });
  const payee = (await directory.contactFor([p.payeeId])).get(p.payeeId);
  return {
    ...serialize(p, { account: await accountOf(p, transaction) }),
    payee: { id: p.payeeId, name: payee?.displayName ?? null },
    items: items.map(serializeItem),
    holds: await holds.forPayout(p, { transaction }),
    approvals: await approvalsOf(p.id, transaction),
    reveals,
    ledger: p.ledgerTxnIds,
  };
}

/** GET /admin/payouts/:id */
const adminGet = (id) => detailInTx(id);

/** GET /admin/payouts?status&kind&payeeId&batchId: list with counts per status (the desk's tabs). */
async function adminList({ status, kind, payeeId, batchId, cursor, limit = 50 } = {}) {
  const where = { ...(status ? { status } : {}), ...(kind ? { kind } : {}), ...(payeeId ? { payeeId } : {}), ...(batchId ? { batchId } : {}), ...(cursor ? { id: { [Op.lt]: cursor } } : {}) };
  const rows = await Payout.findAll({ where, order: [['id', 'DESC']], limit: limit + 1, include: [{ association: 'account' }] });
  const page = rows.slice(0, limit);
  const names = await directory.contactFor(page.map((p) => p.payeeId));
  const [counts] = await sequelize.query('SELECT status, COUNT(*) AS n FROM payouts GROUP BY status');
  const active = await Promise.all(page.map((p) => (p.account ? p.account : accounts.activeFor(p.payeeId))));
  return {
    items: page.map((p, i) => ({ ...serialize(p, { account: active[i] }), payee: { id: p.payeeId, name: names.get(p.payeeId)?.displayName ?? null } })),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
  };
}

/** GET /me/payouts */
async function meList(userId, { cursor, limit = 20 } = {}) {
  const rows = await Payout.findAll({ where: { payeeId: userId, ...(cursor ? { id: { [Op.lt]: cursor } } : {}) }, order: [['id', 'DESC']], limit: limit + 1, include: [{ association: 'account' }] });
  const page = rows.slice(0, limit);
  return { items: page.map((p) => serialize(p, { account: p.account })), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
}

/** GET /me/payouts/:id (the payee's own only). */
async function meGet(userId, id) {
  const p = await Payout.findOne({ where: { id, payeeId: userId } });
  if (!p) throw E.notFound('Payout');
  const d = await detailInTx(p.id);
  return { ...d, holds: d.holds.filter((h) => !h.liftedAt).map(({ id: holdId, type, until, scope }) => ({ id: holdId, type, until, scope })), reveals: undefined, ledger: undefined };
}

/**
 * GET /me/payouts/summary (FR-16): the projection uses the same calculation as the batch: what is
 * eligible now, netted, against the minimum, plus any payout already built.
 */
async function summary(userId, now = new Date()) {
  const byPayee = await eligibleByPayee({ upTo: now, payeeIds: [userId] });
  const items = byPayee.get(userId) ?? [];
  const active = await holds.activeFor(userId, { now });
  const free = items.filter((i) => !rules.itemHeld(i, active, now));
  const t = rules.totals(free, { feeReceivable: await feesOwed(userId) });
  const open = await Payout.findAll({ where: { payeeId: userId, status: { [Op.in]: [...rules.OPEN, 'processing'] } } });
  const startOfMonth = rules.dhakaAt(new Date(Date.UTC(rules.dhakaParts(now).y, rules.dhakaParts(now).m, 1, 12)), 0);
  const paid = await Payout.sum('amountPoisha', { where: { payeeId: userId, status: 'paid', paidAt: { [Op.gte]: startOfMonth } } });
  const schedules = [...new Set(items.map((i) => i.schedule))];
  const next = schedules.map((s) => rules.nextRun(s, now, scheduleSettings())).sort((a, b) => a - b)[0] ?? null;
  const account = await accounts.activeFor(userId);
  const pendingAccount = (await accounts.listMine(userId)).items.find((a) => a.status === 'pending_verification') ?? null;
  return {
    nextPayout: { date: next, projected: rules.belowMinimum(t.amount, settings.get('payouts.min_amount_poisha')) ? 0 : t.amount, minimum: settings.get('payouts.min_amount_poisha') },
    inPayouts: open.reduce((s, p) => s + p.amountPoisha, 0),
    onHold: {
      amount: open.filter((p) => p.status === 'on_hold').reduce((s, p) => s + p.amountPoisha, 0) + items.filter((i) => rules.itemHeld(i, active, now)).reduce((s, i) => s + i.net, 0),
      reasons: [...new Set(active.map((h) => h.type))],
      until: active.filter((h) => h.until).map((h) => h.until).sort((a, b) => b - a)[0] ?? null,
    },
    feesOwed: await feesOwed(userId),
    paidThisMonth: Number(paid ?? 0),
    account: account ? accounts.serialize(account) : null,
    pendingAccount,
  };
}

/** GET /me/payouts/:id/statement.csv (§4.2): the payout and its lines, EN or BN headings. */
async function statementCsv(userId, id, locale = 'en') {
  const d = await meGet(userId, id);
  const bn = locale === 'bn';
  // M24-FR-46: the provider's charge passed through at cost (online gym fees) has its own column.
  const head = bn ? ['বিবরণ', 'মোট (৳)', 'ফি (৳)', 'প্রোভাইডার চার্জ (৳)', 'নিট (৳)'] : ['Description', 'Gross (৳)', 'Fee (৳)', 'Provider charge (৳)', 'Net (৳)'];
  const rows = [
    [bn ? 'পেআউট' : 'Payout', d.code],
    [bn ? 'অবস্থা' : 'Status', d.status],
    [bn ? 'অ্যাকাউন্ট' : 'Account', d.account?.masked ?? ''],
    [bn ? 'রেফারেন্স' : 'Reference', d.providerRef ?? ''],
    [],
    head,
    ...d.items.filter((i) => i.status === 'included').map((i) => [i.description, taka(i.gross), taka(i.fee), taka(i.providerCharge), taka(i.net)]),
    [],
    [bn ? 'পরিশোধিত' : 'Paid', '', '', '', taka(d.amount)],
  ];
  return { filename: `${d.code}.csv`, body: rules.csv(rows) };
}

/** Display facts for notifications (M08 reads them here, never from the tables). */
async function facts(id) {
  const p = await Payout.findByPk(id, { include: [{ association: 'account' }] });
  if (!p) throw E.notFound('Payout');
  const account = p.account ?? (await accounts.activeFor(p.payeeId));
  return { code: p.code, amount: p.amountPoisha, masked: account ? rules.maskAccount(account.type, account.accountNoLast4) : null, providerRef: p.providerRef ?? null, kind: p.kind };
}

/**
 * M19 "Needs your action" for staff (FR-29): payouts above the four-eyes threshold that this master
 * can still approve (not their own, not one they approved already: `payouts_to_approve`), and failed
 * payouts to retry or cancel (`payouts_failed`, always high) for staff who see payouts.
 */
async function pendingActions(principal) {
  const canSee = ['view_payouts', 'release_payouts'].some((p) => authz.hasPermission(principal, p));
  const [approve, failed] = await Promise.all([
    principal.isMaster
      ? Payout.count({
          where: {
            status: 'needs_approval',
            payeeId: { [Op.ne]: principal.id },
            id: { [Op.notIn]: sequelize.literal(`(SELECT payout_id FROM payout_approvals WHERE approver_id = ${sequelize.escape(principal.id)})`) },
          },
        })
      : 0,
    canSee ? Payout.count({ where: { status: 'failed' } }) : 0,
  ]);
  return [
    ...queueItem({ key: 'payouts_to_approve', count: approve, href: '/admin/finance?tab=payouts&status=needs_approval' }),
    ...queueItem({ key: 'payouts_failed', count: failed, urgent: true, href: '/admin/finance?tab=payouts&status=failed' }),
  ];
}

// M06 FR-19 invariant: money in payout_clearing = the payouts being sent right now.
invariants.register('payout_clearing_matches', async () => {
  const inFlight = Number((await Payout.sum('amountPoisha', { where: { status: 'processing' } })) ?? 0);
  const clearing = await ledger.balance('payout_clearing');
  return { ok: inFlight === clearing, detail: `payout_clearing ${clearing} ≠ processing payouts ${inFlight}` };
});

module.exports = {
  pendingActions,
  buildBatch,
  runDue,
  runNow,
  listBatches,
  createRefundPayout,
  release,
  releaseAuto,
  approve,
  reveal,
  markPaid,
  markFailed,
  retry,
  cancel,
  placeManualHold,
  liftManualHold,
  adminGet,
  adminList,
  meList,
  meGet,
  summary,
  statementCsv,
  facts,
  serialize,
};
