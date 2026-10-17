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

/** The id of the hold opened for a payment (read only; null when it never captured). */
const holdIdForPayment = async (paymentId) => (await EscrowHold.findOne({ where: { paymentId }, attributes: ['id'], order: [['createdAt', 'ASC']] }))?.id ?? null;

/** The hold opened for a captured payment, locked (null when the payment never captured). */
async function lockHoldForPayment(paymentId, transaction) {
  return EscrowHold.findOne({ where: { paymentId }, order: [['createdAt', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
}

/**
 * FR-06: on capture, open a hold from the payment's escrow instructions (snapshotted at obligation
 * time, FR-07) and post Dr provider_clearing / Cr escrow:{purpose} tagged with it.
 */
async function openHold(payment, { transaction, capturedAt }) {
  const def = purposes.get(payment.purpose);
  const esc = payment.escrow;
  const hold = await EscrowHold.create(
    {
      purpose: payment.purpose,
      purposeId: payment.purposeId,
      paymentId: payment.id,
      groupRef: esc.groupRef ?? null,
      payeeId: def.pooled ? null : esc.payeeId,
      vertical: def.vertical,
      feeBps: esc.fee.feeBps,
      feeSettingKey: esc.fee.settingKey,
      feeSettingVersion: esc.fee.settingsVersion,
      heldPoisha: payment.amountPoisha,
      releaseRule: esc.releaseRule,
      releaseAt: rules.releaseAt(esc.releaseRule, capturedAt),
    },
    { transaction }
  );
  await ledger.post(
    {
      kind: 'payment.capture',
      refType: 'payment',
      refId: payment.id,
      idempotencyKey: `payment.capture:${payment.id}`,
      lines: lrules.captureLines({ provider: payment.provider, escrowAccount: def.escrowAccount, amount: payment.amountPoisha, holdId: hold.id }),
      memo: `${payment.code} captured`,
    },
    { transaction }
  );
  await events.publish(transaction, {
    name: 'escrow.held',
    aggregateType: 'escrow_hold',
    aggregateId: hold.id,
    payload: { holdId: hold.id, paymentId: payment.id, purpose: payment.purpose, purposeId: payment.purposeId, amount: payment.amountPoisha, payeeId: hold.payeeId, groupRef: hold.groupRef },
  });
  return hold;
}

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

/** FR-14: freeze (dispute, master action). Frozen holds neither release nor auto-refund. */
async function freeze(actor, holdId, { reason, ref = null }, req) {
  return sequelize.transaction(async (transaction) => {
    const hold = await lockHold(holdId, transaction);
    if (!rules.OPEN.has(hold.status)) throw new AppError(409, 'ESCROW_NOT_OPEN', 'Only an open hold can be frozen', { meta: { status: hold.status } });
    await hold.update({ statusBeforeFreeze: hold.status, status: 'frozen', frozenReason: reason, frozenRef: ref }, { transaction });
    await audit.record({ action: 'escrow.frozen', actor, entityType: 'escrow_hold', entityId: hold.id, reason, stepUp: Boolean(req), meta: { ref }, req }, { transaction });
    await events.publish(transaction, { name: 'escrow.frozen', aggregateType: 'escrow_hold', aggregateId: hold.id, payload: { holdId: hold.id, reason, payeeId: hold.payeeId }, actor });
    return serialize(hold);
  });
}

async function unfreeze(actor, holdId, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const hold = await lockHold(holdId, transaction);
    if (hold.status !== 'frozen') throw new AppError(409, 'ESCROW_NOT_FROZEN', 'This hold is not frozen');
    await hold.update({ status: hold.statusBeforeFreeze ?? 'holding', statusBeforeFreeze: null, frozenReason: null, frozenRef: null }, { transaction });
    await audit.record({ action: 'escrow.unfrozen', actor, entityType: 'escrow_hold', entityId: hold.id, reason, stepUp: Boolean(req), req }, { transaction });
    await events.publish(transaction, { name: 'escrow.unfrozen', aggregateType: 'escrow_hold', aggregateId: hold.id, payload: { holdId: hold.id, reason, payeeId: hold.payeeId }, actor });
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

module.exports = { openHold, holdIdForPayment, lockHoldForPayment, releaseInTx, releaseManually, takeForRefund, freeze, unfreeze, releaseDue, settlePool, reversePoolCredit, list, getOne, serialize, lockHold };
