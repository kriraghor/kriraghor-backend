'use strict';

/**
 * M20's side of the M17 targets port (source 'trainer_subscription'; the source id is one paid month,
 * trainer_subscription_periods.id). The member who paid can open `service_problem` from the start of
 * the month until its release (disputes.window_trainer_hours after it ends). Opening freezes the
 * month's escrow hold, so the monthly release cannot pay it out; withdrawing puts it back. The
 * decision refunds the member and releases the rest to the trainer, the fee capped at the month's
 * price (feeBaseMax).
 */
const { TrainerSubscription, TrainerSubscriptionPeriod } = require('../../models');
const { fail } = require('../trust/trust.errors');
const escrow = require('../payments').escrow;
const rules = require('./gym.rules');
const c = require('./gym.common');

const CATEGORIES = ['service_problem'];

function evaluate(period, category, now) {
  if (!CATEGORIES.includes(category)) return { block: 'DISPUTE_NOT_ELIGIBLE' };
  if (period.status !== 'paid' || !period.releaseAt) return { block: 'DISPUTE_NOT_ELIGIBLE' };
  if (now < rules.instantOf(period.periodStart) || now >= period.releaseAt) return { block: 'DISPUTE_WINDOW_CLOSED' };
  return { money: true, held: c.heldOf(period), closesAt: period.releaseAt };
}

async function load(sourceId, transaction) {
  const period = transaction ? await c.lockPeriod(sourceId, transaction) : await TrainerSubscriptionPeriod.findByPk(sourceId);
  if (!period) return {};
  return { period, sub: await TrainerSubscription.findByPk(period.subscriptionId, { transaction }) };
}

async function snapshot({ sourceId, category, principal, transaction }) {
  const { period, sub } = await load(sourceId, transaction);
  if (!period) throw fail('DISPUTE_NOT_ELIGIBLE');
  if (sub.memberId !== principal.id) throw fail('NOT_YOUR_SUBSCRIPTION');
  const e = evaluate(period, category, new Date());
  if (e.block) throw fail(e.block);
  return {
    ref: `${sub.code}-${period.seq}`,
    claimantId: sub.memberId,
    respondentId: sub.trainerId,
    money: true,
    paid: period.pricePoisha,
    held: e.held,
    policyKey: `gym.${category}`,
    policy: { feeBps: period.feeBps, feeBaseMax: period.pricePoisha, price: period.pricePoisha, periodStart: period.periodStart, periodEnd: period.periodEnd, closesAt: c.iso(e.closesAt) },
  };
}

/** GET /me/disputes/options: what the member can open on this month now. */
async function options({ sourceId, principal }) {
  const { period, sub } = await load(sourceId);
  if (!period || sub.memberId !== principal.id) return [];
  const now = new Date();
  return CATEGORIES.map((category) => ({ category, ...evaluate(period, category, now) }))
    .filter((o) => !o.block)
    .map((o) => ({ category: o.category, money: o.money, held: o.held, closesAt: c.iso(o.closesAt) }));
}

async function freeze({ sourceId, ref, actor, transaction }) {
  const period = await c.lockPeriod(sourceId, transaction);
  if (period.status !== 'paid') throw fail('DISPUTE_NOT_ELIGIBLE');
  const hold = await c.holdOf(period, transaction);
  if (hold && hold.status !== 'frozen') await escrow.freezeInTx(hold, { reason: 'dispute', ref, actor, transaction });
  await period.update({ status: 'disputed', disputeId: ref }, { transaction });
  const sub = await TrainerSubscription.findByPk(period.subscriptionId, { transaction });
  await c.publishSub(transaction, 'trainer_subscription.disputed', sub, { seq: period.seq, disputeId: ref }, actor);
}

/** Back to paid (a withdrawn case): the hold thaws and the month is released on its usual date (or at the next tick if that has passed). */
async function unfreeze({ sourceId, actor, transaction }) {
  const period = await c.lockPeriod(sourceId, transaction);
  const hold = await c.holdOf(period, transaction);
  if (hold?.status === 'frozen') await escrow.unfreezeInTx(hold, { reason: 'dispute_closed', actor, transaction });
  if (period.status === 'disputed') await period.update({ status: 'paid', disputeId: null }, { transaction });
}

/** The decision: refund part or all of the month, release the rest to the trainer. */
async function applyOutcome({ sourceId, dispute, plan, actor, transaction }) {
  const period = await c.lockPeriod(sourceId, transaction);
  if (period.status !== 'disputed') throw fail('DISPUTE_SOURCE_CHANGED', { status: period.status });
  const hold = await c.holdOf(period, transaction);
  if (hold?.status === 'frozen') await escrow.unfreezeInTx(hold, { reason: 'dispute_closed', actor, transaction });
  const refunded = await c.refund(period, plan.refund, { reasonCode: `dispute_${dispute.category}`, key: `dispute:${dispute.id}`, kind: 'dispute', actor, transaction });
  let moved = { gross: 0, fee: 0, net: 0 };
  if (plan.release > 0) moved = await c.release(period, { feeBase: plan.feeBase, actor, transaction, kind: 'escrow.release_trainer' });
  await period.update({ status: plan.release > 0 ? 'released' : 'refunded' }, { transaction });
  const sub = await TrainerSubscription.findByPk(period.subscriptionId, { transaction });
  await c.publishSub(transaction, 'trainer_subscription.released', sub, { seq: period.seq, gross: moved.gross, fee: moved.fee, net: moved.net, refund: refunded, by: 'dispute' }, actor);
  return { refunded, released: moved.gross, fee: moved.fee };
}

/** The month as the desk and the parties see it. */
async function describe(sourceId) {
  const { period, sub } = await load(sourceId);
  if (!period) return null;
  return {
    kind: 'trainer_subscription',
    id: period.id,
    code: `${sub.code}-${period.seq}`,
    status: period.status,
    title: sub.title,
    sessionsPerMonth: sub.sessionsPerMonth ?? null,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    money: { price: period.pricePoisha, refunded: period.refundedPoisha, released: period.releasedPoisha },
  };
}

function register() {
  require('../trust/targets.port').register('trainer_subscription', { permission: 'resolve_reports', snapshot, options, freeze, unfreeze, applyOutcome, describe });
}

module.exports = { register, evaluate, snapshot, options, freeze, unfreeze, applyOutcome, describe };
