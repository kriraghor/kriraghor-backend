'use strict';

/**
 * PayoutHoldService (M07 §2.4, §6.4, FR-06, FR-13, FR-14). Holds stop money leaving:
 *   payee        account_change, risk_freeze (M18), kyc (M02), account_suspended (M01), manual
 *   payout       manual, on one payout
 *   item_source  dispute (M17): only the disputed source's items wait
 * place() is idempotent on (type, ref_id), so M17/M18 calling twice is harmless. Every change
 * re-evaluates the payee's open payouts (on_hold ⇄ scheduled / needs_approval) in the same transaction.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { sequelize, Payout, PayoutHold, PayoutItem } = require('../../models');
const events = require('../events/events.service');
const rules = require('./payouts.rules');

const serialize = (h) => ({
  id: h.id,
  scope: h.scope,
  type: h.type,
  payeeId: h.payeeId,
  payoutId: h.payoutId ?? null,
  sourceType: h.sourceType ?? null,
  sourceId: h.sourceId ?? null,
  reason: h.reason ?? null,
  until: h.until ?? null,
  placedBy: h.placedBy ?? null,
  placedAt: h.placedAt,
  liftedBy: h.liftedBy ?? null,
  liftedAt: h.liftedAt ?? null,
  liftReason: h.liftReason ?? null,
});

/** Active (not lifted, not expired) holds that touch a payee. */
async function activeFor(payeeId, { transaction, now = new Date() } = {}) {
  const rows = await PayoutHold.findAll({ where: { payeeId, liftedAt: null }, order: [['placedAt', 'ASC']], transaction });
  return rows.filter((h) => rules.isActive(h, now));
}

/**
 * Bring the payee's open payouts in line with their holds: a blocked payout goes on_hold; an
 * unblocked one returns to needs_approval or scheduled by its snapshotted threshold (§8).
 */
async function reevaluate(payeeId, { transaction, now = new Date() }) {
  const holds = await activeFor(payeeId, { transaction, now });
  const open = await Payout.findAll({ where: { payeeId, status: rules.OPEN }, transaction, lock: transaction.LOCK.UPDATE });
  const changed = [];
  for (const p of open) {
    const items = await PayoutItem.findAll({ where: { payoutId: p.id, status: 'included' }, attributes: ['sourceType', 'sourceId'], transaction });
    const blocked = rules.blockingHolds(holds, now, p.id).length > 0 || items.some((i) => rules.itemHeld(i, holds, now));
    const { status } = rules.statusFor({ amount: p.amountPoisha, threshold: p.rulesSnapshot.threshold, autoReleaseMax: 0, blocked });
    if (status !== p.status) {
      await p.update({ status }, { transaction });
      changed.push({ id: p.id, status });
    }
  }
  return changed;
}

/** Place a hold (idempotent on type + refId). Returns { hold, created }. */
async function place({ payeeId, scope, type, payoutId = null, sourceType = null, sourceId = null, refId, reason = null, until = null }, actor, { transaction }) {
  const existing = await PayoutHold.findOne({ where: { type, refId }, transaction });
  if (existing) return { hold: existing, created: false };
  let hold;
  try {
    // A savepoint: a duplicate from a concurrent caller must not abort the caller's transaction.
    hold = await sequelize.transaction({ transaction }, (savepoint) =>
      PayoutHold.create({ payeeId, scope, type, payoutId, sourceType, sourceId, refId, reason, until, placedBy: actor?.id ?? null }, { transaction: savepoint })
    );
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    return { hold: await PayoutHold.findOne({ where: { type, refId }, transaction }), created: false };
  }
  await events.publish(transaction, {
    name: 'payout.held',
    aggregateType: 'payout_hold',
    aggregateId: hold.id,
    payload: { holdId: hold.id, payeeId, payoutId, type, scope },
    actor,
  });
  await reevaluate(payeeId, { transaction });
  return { hold, created: true };
}

/** Lift a hold (once). Returns the hold. */
async function lift(holdId, { reason }, actor, { transaction }) {
  const hold = await PayoutHold.findByPk(holdId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!hold || hold.liftedAt) return hold;
  await hold.update({ liftedAt: new Date(), liftedBy: actor?.id ?? null, liftReason: reason }, { transaction });
  await events.publish(transaction, {
    name: 'payout.hold_lifted',
    aggregateType: 'payout_hold',
    aggregateId: hold.id,
    payload: { holdId: hold.id, payeeId: hold.payeeId, payoutId: hold.payoutId ?? null, type: hold.type },
    actor,
  });
  await reevaluate(hold.payeeId, { transaction });
  return hold;
}

/** M17/M18 entry point: release a hold by id (§2.4). */
const release = (holdId, { reason }, actor) => sequelize.transaction((transaction) => lift(holdId, { reason }, actor, { transaction }));

/** Every active hold of one type on a payee (M01 user.restored lifts account_suspended). */
async function liftAll(payeeId, type, { reason }, actor, { transaction }) {
  const holds = await PayoutHold.findAll({ where: { payeeId, type, liftedAt: null }, transaction });
  for (const h of holds) await lift(h.id, { reason }, actor, { transaction });
  return holds.length;
}

/**
 * Job payouts.hold-expiry (§10, every 15 min): timed holds (account_change) whose `until` has passed
 * are lifted, which puts the payee's payouts back in line. Idempotent: lifted holds are skipped.
 */
async function expireDue(now = new Date()) {
  const due = await PayoutHold.findAll({ where: { liftedAt: null, until: { [Op.lte]: now } }, attributes: ['id'] });
  for (const { id } of due) {
    await sequelize.transaction((transaction) => lift(id, { reason: 'Hold period ended' }, null, { transaction }));
  }
  return { lifted: due.length };
}

/** Holds placed or lifted by staff on a payout or its payee (who may not approve it, §3). */
async function manualActors(payout, { transaction }) {
  const holds = await PayoutHold.findAll({
    where: { type: 'manual', payeeId: payout.payeeId, [Op.or]: [{ scope: 'payee' }, { payoutId: payout.id }] },
    order: [['placedAt', 'DESC']],
    transaction,
  });
  const latest = holds[0];
  return latest ? [latest.placedBy, latest.liftedBy].filter(Boolean) : [];
}

async function forPayout(payout, { transaction } = {}) {
  const rows = await PayoutHold.findAll({
    where: { payeeId: payout.payeeId, [Op.or]: [{ scope: 'payee' }, { payoutId: payout.id }, { scope: 'item_source' }] },
    order: [['placedAt', 'DESC']],
    transaction,
  });
  return rows.map(serialize);
}

module.exports = { place, lift, release, liftAll, activeFor, reevaluate, expireDue, manualActors, forPayout, serialize };
