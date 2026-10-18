'use strict';

/**
 * EscrowService (M06 §2.4, §8, FR-06, FR-13, FR-14). Holds customer money per payment until the
 * service is delivered, then releases it to the payee minus the snapshotted fee, refunds from it, or
 * (pooled holds, esports) settles a whole group at once. The ledger is the truth for money; the hold
 * row is the state machine and is always changed in the same transaction as its ledger posting.
 *
 *   holding ──release (all)──▶ released        holding ──refund (all)──▶ refunded
 *   holding ──release (part)─▶ partially_released ──release rest──▶ released | ──refund rest──▶ closed
 *   holding | partially_released ──freeze──▶ frozen ──unfreeze──▶ (previous status)
 */
const { Op } = require('sequelize');
const { AppError, E } = require('../../common/errors');
const { sequelize, EscrowHold } = require('../../models');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const logger = require('../../common/logger');
const ledger = require('./ledger.service');
const lrules = require('./ledger.rules');
const rules = require('./escrow.rules');
const purposes = require('./payments.purposes');

const BLOCK_MESSAGES = {
  ESCROW_FROZEN: [409, 'This hold is frozen'],
  ESCROW_CLOSED: [409, 'This hold has nothing left to release'],
  ESCROW_POOLED: [409, 'This hold is part of a pool and is settled with its group'],
  ESCROW_EMPTY: [409, 'This hold has nothing left to release'],
};
const blocked = (code) => new AppError(BLOCK_MESSAGES[code][0], code, BLOCK_MESSAGES[code][1]);

async function lockHold(id, transaction) {
  const hold = await EscrowHold.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!hold) throw E.notFound('Escrow hold');
  return hold;
}

/** The id of the hold opened for a payment (or one of its splits); null when it never captured. */
const holdIdForPayment = async (paymentId, { splitRef = null } = {}) =>
  (await EscrowHold.findOne({ where: { paymentId, ...(splitRef ? { splitRef } : {}) }, attributes: ['id'], order: [['createdAt', 'ASC']] }))?.id ?? null;

/** The hold opened for a captured payment (or one of its splits, M13), locked; null when it never captured. */
async function lockHoldForPayment(paymentId, transaction, { splitRef = null } = {}) {
  return EscrowHold.findOne({ where: { paymentId, ...(splitRef ? { splitRef } : {}) }, order: [['createdAt', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
}

/**
 * FR-06: on capture, open the payment's holds from its escrow instructions (snapshotted at obligation
 * time, FR-07) and post Dr provider_clearing / Cr escrow:{purpose} tagged with each hold. A split
 * payment (M13 basket) opens one hold per split, each with its own payee and amount; every other
 * payment opens one hold. Returns the holds (the first is the only one for a single-payee payment).
 */
async function openHolds(payment, { transaction, capturedAt }) {
  const def = purposes.get(payment.purpose);
  const esc = payment.escrow;
  const parts = esc.splits?.length ? esc.splits : [{ ref: null, payeeId: esc.payeeId, amount: payment.amountPoisha }];
  const holds = [];
  for (const part of parts) {
    holds.push(
      await EscrowHold.create(
        {
          purpose: payment.purpose,
          purposeId: payment.purposeId,
          paymentId: payment.id,
          splitRef: part.ref ?? null,
          groupRef: esc.groupRef ?? null,
          payeeId: def.pooled ? null : part.payeeId,
          vertical: def.vertical,
          feeBps: esc.fee.feeBps,
          feeSettingKey: esc.fee.settingKey,
          feeSettingVersion: esc.fee.settingsVersion,
          heldPoisha: part.amount,
          releaseRule: esc.releaseRule,
          releaseAt: rules.releaseAt(esc.releaseRule, capturedAt),
        },
        { transaction }
      )
    );
  }
  await ledger.post(
    {
      kind: 'payment.capture',
      refType: 'payment',
      refId: payment.id,
      idempotencyKey: `payment.capture:${payment.id}`,
      lines:
        holds.length === 1
          ? lrules.captureLines({ provider: payment.provider, escrowAccount: def.escrowAccount, amount: payment.amountPoisha, holdId: holds[0].id })
          : lrules.captureSplitLines({ provider: payment.provider, escrowAccount: def.escrowAccount, holds: holds.map((h) => ({ holdId: h.id, amount: h.heldPoisha })) }),
      memo: `${payment.code} captured`,
    },
    { transaction }
  );
  for (const hold of holds) {
    await events.publish(transaction, {
      name: 'escrow.held',
      aggregateType: 'escrow_hold',
      aggregateId: hold.id,
      payload: { holdId: hold.id, paymentId: payment.id, purpose: payment.purpose, purposeId: payment.purposeId, amount: hold.heldPoisha, payeeId: hold.payeeId, groupRef: hold.groupRef, splitRef: hold.splitRef ?? null },
    });
  }
  return holds;
}

/** The single hold of a payment (kept for callers that open one). */
const openHold = async (payment, opts) => (await openHolds(payment, opts))[0];

/** FR-13: release (all or part) to the payee, inside `transaction`, on a locked hold. */
async function releaseInTx(hold, { amount, feeBase = null, actor = null, transaction, kind = 'escrow.release' }) {
  const block = rules.releaseBlock(hold);
  if (block) throw blocked(block);
  const { gross, fee, net } = rules.release(hold, amount, feeBase);
  const def = purposes.get(hold.purpose);
  const n = hold.releaseCount + 1;
  const posted = await ledger.post(
    {
      kind,
      refType: 'escrow_hold',
      refId: hold.id,
      idempotencyKey: `escrow.release:${hold.id}:${n}`,
      lines: lrules.releaseLines({ escrowAccount: def.escrowAccount, holdId: hold.id, payeeId: hold.payeeId, vertical: hold.vertical, gross, fee }),
      memo: feeBase === null ? `Release ${n} of hold ${hold.id}` : `Release ${n} of hold ${hold.id} (fee on ${feeBase})`,
      postedBy: actor?.id ?? null,
    },
    { transaction }
  );
  const released = hold.releasedPoisha + gross;
  await hold.update(
    { releasedPoisha: released, feeTakenPoisha: hold.feeTakenPoisha + fee, releaseCount: n, status: rules.statusAfter(hold, { released, refunded: hold.refundedPoisha }), releaseAt: null },
    { transaction }
  );
  await events.publish(transaction, {
    name: 'escrow.released',
    aggregateType: 'escrow_hold',
    aggregateId: hold.id,
    payload: { holdId: hold.id, purpose: hold.purpose, purposeId: hold.purposeId, gross, fee, net, payeeId: hold.payeeId, transactionId: posted.id },
    actor,
  });
  return { gross, fee, net, transactionId: posted.id };
}

/** POST /admin/escrow/:id/release (master + step-up escrow.manage) — manual release with a reason. */
async function releaseManually(actor, holdId, { amount, reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const hold = await lockHold(holdId, transaction);
    const before = serialize(hold);
    const result = await releaseInTx(hold, { amount, actor, transaction, kind: 'escrow.release_manual' });
    await audit.record(
      { action: 'escrow.released_manually', actor, entityType: 'escrow_hold', entityId: hold.id, before, after: serialize(hold), reason, stepUp: true, meta: result, req },
      { transaction }
    );
    return { hold: serialize(hold), ...result };
  });
}

/** Money leaves the hold for a refund (called by RefundService inside its transaction). */
async function takeForRefund(hold, amount, { transaction }) {
  if (hold.status === 'frozen') throw blocked('ESCROW_FROZEN');
  if (amount > rules.available(hold)) throw new AppError(422, 'REFUND_EXCEEDS_HELD', 'The hold does not have that much left');
  const refunded = hold.refundedPoisha + amount;
  await hold.update({ refundedPoisha: refunded, status: rules.statusAfter(hold, { released: hold.releasedPoisha, refunded }) }, { transaction });
}

/**
 * FR-14: freeze a locked hold inside the caller's transaction (M17 opens a dispute). Frozen holds
 * neither release nor refund until they are unfrozen.
 */
async function freezeInTx(hold, { reason, ref = null, actor = null, transaction }) {
  if (!rules.OPEN.has(hold.status)) throw new AppError(409, 'ESCROW_NOT_OPEN', 'Only an open hold can be frozen', { meta: { status: hold.status } });
  await hold.update({ statusBeforeFreeze: hold.status, status: 'frozen', frozenReason: reason, frozenRef: ref }, { transaction });
  await events.publish(transaction, { name: 'escrow.frozen', aggregateType: 'escrow_hold', aggregateId: hold.id, payload: { holdId: hold.id, reason, payeeId: hold.payeeId }, actor });
  return hold;
}

async function unfreezeInTx(hold, { reason, actor = null, transaction }) {
  if (hold.status !== 'frozen') throw new AppError(409, 'ESCROW_NOT_FROZEN', 'This hold is not frozen');
  await hold.update({ status: hold.statusBeforeFreeze ?? 'holding', statusBeforeFreeze: null, frozenReason: null, frozenRef: null }, { transaction });
  await events.publish(transaction, { name: 'escrow.unfrozen', aggregateType: 'escrow_hold', aggregateId: hold.id, payload: { holdId: hold.id, reason, payeeId: hold.payeeId }, actor });
  return hold;
}

/** POST /admin/escrow/:id/freeze (master + step-up escrow.manage). */
async function freeze(actor, holdId, { reason, ref = null }, req) {
  return sequelize.transaction(async (transaction) => {
    const hold = await lockHold(holdId, transaction);
    await freezeInTx(hold, { reason, ref, actor, transaction });
    await audit.record({ action: 'escrow.frozen', actor, entityType: 'escrow_hold', entityId: hold.id, reason, stepUp: Boolean(req), meta: { ref }, req }, { transaction });
    return serialize(hold);
  });
}

async function unfreeze(actor, holdId, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const hold = await lockHold(holdId, transaction);
    await unfreezeInTx(hold, { reason, actor, transaction });
    await audit.record({ action: 'escrow.unfrozen', actor, entityType: 'escrow_hold', entityId: hold.id, reason, stepUp: Boolean(req), req }, { transaction });
    return serialize(hold);
  });
}

/** Job escrow.release-due (§10): delay-rule holds whose time has come. One transaction per hold. */
async function releaseDue({ limit = 200 } = {}) {
  const due = await EscrowHold.findAll({
    where: { status: [...rules.OPEN], payeeId: { [Op.ne]: null }, releaseAt: { [Op.lte]: new Date() } },
    attributes: ['id'],
    order: [['releaseAt', 'ASC']],
    limit,
  });
  let released = 0;
  for (const { id } of due) {
    try {
      await sequelize.transaction(async (transaction) => {
        const hold = await lockHold(id, transaction);
        if (rules.releaseBlock(hold) || !hold.releaseAt || new Date(hold.releaseAt) > new Date()) return;
        await releaseInTx(hold, { transaction, kind: 'escrow.release_due' });
        released += 1;
      });
    } catch (err) {
      logger.error({ err: err.message, holdId: id }, 'escrow release failed');
    }
  }
  return { due: due.length, released };
}

/**
 * Pool settlement (M21 §6.5, FR-23, FR-25): pays every open hold of a group (a tournament) out at once:
 * prizes to winners, any shortfall from prize_subsidy_expense, the remainder to fee_revenue. Idempotent
 * per group: a second call returns the first result. `prizes` = [{ payeeId, amount }].
 */
async function settlePool({ purpose, groupRef, prizes, actor = null }, { transaction: outer } = {}) {
  const def = purposes.get(purpose);
  if (!def.pooled) throw new Error(`Purpose ${purpose} is not pooled`);
  // M21 settles inside its finalise transaction (awards, shares and the posting commit together).
  const run = (fn) => (outer ? fn(outer) : sequelize.transaction(fn));
  return run(async (transaction) => {
    const holds = await EscrowHold.findAll({ where: { purpose, groupRef }, order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
    if (holds.some((h) => h.status === 'frozen')) throw blocked('ESCROW_FROZEN');
    const open = holds.filter((h) => rules.OPEN.has(h.status)).map((h) => ({ hold: h, id: h.id, available: rules.available(h) }));
    const s = lrules.poolSettlement({ escrowAccount: def.escrowAccount, vertical: def.vertical, holds: open, prizes });
    if (!s.lines.length) return { collected: 0, paid: 0, subsidy: 0, fee: 0, transactionId: null };
    const posted = await ledger.post(
      { kind: 'escrow.pool_settle', refType: 'escrow_group', refId: groupRef, idempotencyKey: `escrow.pool:${purpose}:${groupRef}`, lines: s.lines, postedBy: actor?.id ?? null, memo: `Pool settlement ${groupRef}` },
      { transaction }
    );
    if (posted.existing) return { collected: s.collected, paid: s.paid, subsidy: s.subsidy, fee: s.remainder, transactionId: posted.id, existing: true };
    for (const [i, o] of open.entries()) {
      const released = o.hold.releasedPoisha + o.available;
      await o.hold.update(
        { releasedPoisha: released, feeTakenPoisha: o.hold.feeTakenPoisha + s.feeByHold[i], releaseCount: o.hold.releaseCount + 1, status: rules.statusAfter(o.hold, { released, refunded: o.hold.refundedPoisha }) },
        { transaction }
      );
    }
    await events.publish(transaction, {
      name: 'escrow.pool_settled',
      aggregateType: 'escrow_group',
      aggregateId: groupRef,
      payload: { groupRef, purpose, collected: s.collected, paid: s.paid, subsidy: s.subsidy, fee: s.remainder, transactionId: posted.id },
      actor,
    });
    return { collected: s.collected, paid: s.paid, subsidy: s.subsidy, fee: s.remainder, transactionId: posted.id };
  });
}

/**
 * M22 organiser settlement (§6.2, FR-07, FR-10): an organiser tournament's entry pool (groupRef = the
 * tournament) and its prize fund (groupRef = the fund) settle together, never with a subsidy:
 *   1. prizes out of the fund (ref escrow_group = the tournament, so winners withdraw them like any
 *      esports prize);
 *   2. the entries less the SaaS fee, and the fund's unused remainder, to the organiser (ref
 *      escrow_group = the fund, so M07 pays them on the fund purpose's daily schedule).
 * Idempotent per pool: a second call returns the first result. Inside the caller's transaction.
 */
async function settleOrganiserPool({ tournamentId, fundId, prizes, feeBps, organiserId, actor = null }, { transaction }) {
  const entry = purposes.get('esports_entry');
  const fund = purposes.get('esports_prize_fund');
  const holdsOf = (purpose, groupRef) => EscrowHold.findAll({ where: { purpose, groupRef }, order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
  const [entryRows, fundRows] = await Promise.all([holdsOf('esports_entry', tournamentId), holdsOf('esports_prize_fund', fundId)]);
  if ([...entryRows, ...fundRows].some((h) => h.status === 'frozen')) throw blocked('ESCROW_FROZEN');
  const open = (rows) => rows.filter((h) => rules.OPEN.has(h.status)).map((h) => ({ hold: h, id: h.id, available: rules.available(h) }));
  const entryHolds = open(entryRows);
  const fundHolds = open(fundRows);
  const s = lrules.organiserSettlement({ entryAccount: entry.escrowAccount, fundAccount: fund.escrowAccount, vertical: fund.vertical, entryHolds, fundHolds, prizes, feeBps, organiserId });
  const post = (lines, refId, key, memo) =>
    lines.length ? ledger.post({ kind: 'escrow.pool_settle', refType: 'escrow_group', refId, idempotencyKey: key, lines, postedBy: actor?.id ?? null, memo }, { transaction }) : null;
  const prizeTxn = await post(s.prizeLines, tournamentId, `escrow.pool:esports_entry:${tournamentId}`, `Organiser prizes ${tournamentId}`);
  const orgTxn = await post(s.organiserLines, fundId, `escrow.pool:esports_prize_fund:${fundId}`, `Organiser settlement ${tournamentId}`);
  const result = { collected: s.collected, funded: s.funded, paid: s.paid, fee: s.fee, net: s.net, fundReturn: s.fundReturn, subsidy: 0, transactionId: prizeTxn?.id ?? orgTxn?.id ?? null, organiserTransactionId: orgTxn?.id ?? null };
  if (prizeTxn?.existing || orgTxn?.existing) return { ...result, existing: true };
  for (const [i, o] of entryHolds.entries()) {
    const released = o.hold.releasedPoisha + o.available;
    await o.hold.update({ releasedPoisha: released, feeTakenPoisha: o.hold.feeTakenPoisha + s.feeByHold[i], releaseCount: o.hold.releaseCount + 1, status: rules.statusAfter(o.hold, { released, refunded: o.hold.refundedPoisha }) }, { transaction });
  }
  for (const o of fundHolds) {
    const released = o.hold.releasedPoisha + o.available;
    await o.hold.update({ releasedPoisha: released, releaseCount: o.hold.releaseCount + 1, status: rules.statusAfter(o.hold, { released, refunded: o.hold.refundedPoisha }) }, { transaction });
  }
  await events.publish(transaction, {
    name: 'escrow.pool_settled',
    aggregateType: 'escrow_group',
    aggregateId: tournamentId,
    payload: { groupRef: tournamentId, purpose: 'esports_entry', collected: s.collected, paid: s.paid, subsidy: 0, fee: s.fee, transactionId: result.transactionId },
    actor,
  });
  return result;
}

/**
 * M22 invoices (FR-09): a captured fee invoice is collected at once (Dr escrow:fee_invoice / Cr
 * fee_revenue). Idempotent per hold. Inside the caller's transaction.
 */
async function collectToRevenueInTx(hold, { actor = null, transaction }) {
  const def = purposes.get(hold.purpose);
  const amount = rules.available(hold);
  if (amount <= 0) return null;
  const posted = await ledger.post(
    { kind: 'escrow.collect', refType: 'escrow_hold', refId: hold.id, idempotencyKey: `escrow.collect:${hold.id}`, lines: lrules.revenueLines({ escrowAccount: def.escrowAccount, holdId: hold.id, vertical: def.vertical, amount }), postedBy: actor?.id ?? null, memo: `Fee collected (hold ${hold.id})` },
    { transaction }
  );
  const released = hold.releasedPoisha + amount;
  await hold.update({ releasedPoisha: released, feeTakenPoisha: hold.feeTakenPoisha + amount, releaseCount: hold.releaseCount + 1, status: rules.statusAfter(hold, { released, refunded: hold.refundedPoisha }) }, { transaction });
  return posted;
}

/**
 * M22 (FR-10): an organiser tournament's prize taken back from a disqualified winner goes back to the
 * organiser, not to Kriraghor (Dr payable:user:{winner} / Cr payable:user:{organiser}). Referenced to
 * the tournament's pool, so both sides follow the esports withdrawal flow.
 */
async function reverseToOrganiser({ groupRef, payeeId, organiserId, amount, key, actor = null }, { transaction }) {
  return ledger.post(
    {
      kind: 'escrow.pool_reverse',
      refType: 'escrow_group',
      refId: groupRef,
      idempotencyKey: `escrow.pool_reverse:${key}`,
      lines: [
        { account: `payable:user:${payeeId}`, debit: amount },
        { account: `payable:user:${organiserId}`, credit: amount },
      ],
      postedBy: actor?.id ?? null,
      memo: `Prize returned to the organiser (${groupRef})`,
    },
    { transaction }
  );
}

/**
 * M21 §6.7 (Q123): a prize credited from a pool is taken back from the winner's unwithdrawn balance
 * and becomes platform revenue (Dr payable:user / Cr fee_revenue:{vertical}). Idempotent by key; the
 * ledger refuses it (LEDGER_INSUFFICIENT_BALANCE) when the money was already withdrawn.
 */
async function reversePoolCredit({ purpose, groupRef, payeeId, amount, key, actor = null }, { transaction }) {
  const def = purposes.get(purpose);
  if (!def.pooled) throw new Error(`Purpose ${purpose} is not pooled`);
  return ledger.post(
    {
      kind: 'escrow.pool_reverse',
      refType: 'escrow_group',
      refId: groupRef,
      idempotencyKey: `escrow.pool_reverse:${key}`,
      lines: [
        { account: `payable:user:${payeeId}`, debit: amount },
        { account: `fee_revenue:${def.vertical}`, credit: amount },
      ],
      postedBy: actor?.id ?? null,
      memo: `Prize reversed (${groupRef})`,
    },
    { transaction }
  );
}

function serialize(h) {
  return {
    id: h.id,
    purpose: h.purpose,
    purposeId: h.purposeId,
    paymentId: h.paymentId,
    groupRef: h.groupRef,
    payeeId: h.payeeId,
    vertical: h.vertical,
    fee: { bps: h.feeBps, settingKey: h.feeSettingKey, settingVersion: h.feeSettingVersion },
    held: h.heldPoisha,
    released: h.releasedPoisha,
    refunded: h.refundedPoisha,
    feeTaken: h.feeTakenPoisha,
    available: rules.available(h),
    releaseRule: h.releaseRule,
    releaseAt: h.releaseAt,
    status: h.status,
    frozenReason: h.frozenReason,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

/** GET /admin/escrow?purpose&status&groupRef&cursor */
async function list({ purpose, status, groupRef, payeeId, cursor, limit = 50 } = {}) {
  const where = { ...(purpose ? { purpose } : {}), ...(status ? { status } : {}), ...(groupRef ? { groupRef } : {}), ...(payeeId ? { payeeId } : {}) };
  if (cursor) where.id = { [Op.lt]: cursor };
  const rows = await EscrowHold.findAll({ where, order: [['id', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const totals = await EscrowHold.findAll({
    where: { status: [...rules.OPEN, 'frozen'] },
    attributes: ['status', [sequelize.fn('SUM', sequelize.literal('held_poisha - released_poisha - refunded_poisha')), 'amount'], [sequelize.fn('COUNT', sequelize.col('id')), 'n']],
    group: ['status'],
    raw: true,
  });
  return {
    items: page.map(serialize),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    totals: Object.fromEntries(totals.map((t) => [t.status, { amount: Number(t.amount), count: Number(t.n) }])),
  };
}

async function getOne(id) {
  const hold = await EscrowHold.findByPk(id);
  if (!hold) throw E.notFound('Escrow hold');
  return serialize(hold);
}

module.exports = { openHold,
  openHolds, holdIdForPayment, lockHoldForPayment, releaseInTx, releaseManually, takeForRefund, freeze, unfreeze, freezeInTx, unfreezeInTx, releaseDue, settlePool, settleOrganiserPool, collectToRevenueInTx, reverseToOrganiser, reversePoolCredit, list, getOne, serialize, lockHold };
