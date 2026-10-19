'use strict';

/**
 * M10's side of the M17 targets port (source 'booking'). The member who paid can dispute:
 *   no_show_contest  after the owner marks a no-show, while the retained advance still waits in escrow
 *                    (booking.settle_due_at = no-show + disputes.window_booking_hours)
 *   venue_problem    from the start until disputes.window_booking_hours after the end. A booking never
 *                    checked in still has its online money in escrow (the case can refund it); once
 *                    checked in the money is with the owner, so the case is findings only (Q96)
 *   cash_problem     money paid at the venue: findings only (Q96)
 * Opening freezes the escrow hold (M06), so neither the tick nor auto-complete can release it; the
 * decision unfreezes it, refunds (kind 'dispute') and releases the rest with the fee on what the owner
 * keeps (Q26), all in the decision transaction. No clawbacks: a booking is never disputed after its
 * money left escrow.
 */
const { Booking } = require('../../models');
const settings = require('../settings/settings.service');
const escrow = require('../payments').escrow;
const reads = require('../grounds/grounds.reads');
const { fail } = require('../trust/trust.errors');
const settlement = require('./settlement.service');
const c = require('./bookings.common');
const rules = require('./bookings.rules');

const CATEGORIES = ['no_show_contest', 'venue_problem', 'cash_problem'];
const HOUR = 3600 * 1000;

/** What a category allows on this booking now: { block } or { money, held, closesAt, policyKey }. */
function evaluate(b, category, now) {
  const closesAfterEnd = new Date(b.endAt.getTime() + settings.get('disputes.window_booking_hours') * HOUR);
  if (category === 'no_show_contest') {
    if (b.status !== 'no_show') return { block: 'DISPUTE_NOT_ELIGIBLE' };
    if (!b.settleDueAt || now >= b.settleDueAt) return { block: 'DISPUTE_WINDOW_CLOSED' };
    return { money: true, held: b.retainedPoisha, closesAt: b.settleDueAt, policyKey: 'booking.no_show' };
  }
  const played = ['checked_in', 'completed'].includes(b.status);
  if (category === 'venue_problem') {
    if (!(played || b.status === 'confirmed') || now < b.startAt) return { block: 'DISPUTE_NOT_ELIGIBLE' };
    if (now >= closesAfterEnd) return { block: 'DISPUTE_WINDOW_CLOSED' };
    const held = b.onlinePoisha - b.refundPoisha - b.releasedPoisha;
    const money = b.status === 'confirmed' && held > 0;
    return { money, held: money ? held : 0, closesAt: closesAfterEnd, policyKey: money ? 'booking.venue_problem' : 'booking.played' };
  }
  if (!played) return { block: 'DISPUTE_NOT_ELIGIBLE' };
  if (now >= closesAfterEnd) return { block: 'DISPUTE_WINDOW_CLOSED' };
  return { money: false, held: 0, closesAt: closesAfterEnd, policyKey: 'booking.venue_cash' };
}

const policyOf = (b, e, category) => ({
  feeBps: b.feeBps,
  // A started booking's money: "nothing back" is a normal completion (fee on the full value).
  fullPrice: category === 'venue_problem' && e.money ? b.pricePoisha : null,
  price: b.pricePoisha,
  advance: b.advancePoisha,
  paidOnline: b.onlinePoisha,
  retained: b.retainedPoisha,
  refundAboveAdvance: c.policy().refundAboveAdvance,
  start: c.iso(b.startAt),
  end: c.iso(b.endAt),
  status: b.status,
  closesAt: c.iso(e.closesAt),
});

async function snapshot({ sourceId, category, principal, transaction }) {
  const b = await c.lock(sourceId, transaction);
  if (!b) throw fail('DISPUTE_NOT_ELIGIBLE');
  if (b.bookerUserId !== principal.id) throw fail('NOT_YOUR_BOOKING');
  if (!CATEGORIES.includes(category)) throw fail('DISPUTE_NOT_ELIGIBLE');
  const e = evaluate(b, category, new Date());
  if (e.block) throw fail(e.block);
  return { ref: b.code, claimantId: b.bookerUserId, respondentId: b.ownerId, money: e.money, paid: b.onlinePoisha, held: e.held, policyKey: e.policyKey, policy: policyOf(b, e, category) };
}

/** GET /me/disputes/options: what the member can open on this booking now. */
async function options({ sourceId, principal }) {
  const b = await Booking.findByPk(sourceId);
  if (!b || b.bookerUserId !== principal.id) return [];
  const now = new Date();
  return CATEGORIES.map((category) => ({ category, ...evaluate(b, category, now) }))
    .filter((o) => !o.block)
    .map((o) => ({ category: o.category, money: o.money, held: o.held, closesAt: c.iso(o.closesAt) }));
}

async function holdOf(b, transaction) {
  return b.paymentId ? escrow.lockHoldForPayment(b.paymentId, transaction) : null;
}

async function freeze({ sourceId, ref, actor, transaction }) {
  const b = await c.lock(sourceId, transaction);
  const hold = await holdOf(b, transaction);
  if (hold) await escrow.freezeInTx(hold, { reason: 'dispute', ref, actor, transaction });
}

async function unfreeze({ sourceId, actor, transaction }) {
  const b = await c.lock(sourceId, transaction);
  const hold = await holdOf(b, transaction);
  if (hold?.status === 'frozen') await escrow.unfreezeInTx(hold, { reason: 'dispute_closed', actor, transaction });
}

/**
 * The decision (M17 plan: refund, release, fee). A no-show settles its retained advance; a started
 * booking that was never checked in is cancelled by the platform (all back), completed with the
 * normal release (nothing back), or completed with the rest released (part back).
 */
async function applyOutcome({ sourceId, dispute, plan, actor, transaction }) {
  if (!dispute.money) return { refunded: 0, released: 0, fee: 0 };
  const b = await c.lock(sourceId, transaction);
  await unfreeze({ sourceId, actor, transaction });
  const opts = { step: 'dispute', reasonCode: `dispute_${dispute.category}`, actor, transaction, kind: 'dispute', key: `dispute:${dispute.id}` };
  let moved;
  if (b.status === 'no_show') {
    moved = await settlement.apply(b, plan, opts);
    await b.update({ retainedPoisha: plan.release, settleDueAt: null, updatedBy: actor.id }, { transaction });
  } else if (b.status === 'confirmed') {
    if (plan.release === 0) {
      moved = await settlement.apply(b, plan, opts);
      await c.release({ bookingId: b.id }, 'cancelled', { transaction, groundId: b.groundId });
      await b.update({ status: rules.next('platform_cancel', b.status), cancelledAt: new Date(), cancelActor: 'platform', cancelReason: 'dispute', cancelNote: dispute.code, updatedBy: actor.id }, { transaction });
    } else if (plan.refund === 0) {
      await require('./bookings.service').completeInTx(b, { transaction, auto: true });
      moved = { refunded: 0, released: b.releasedPoisha, fee: plan.fee };
    } else {
      moved = await settlement.apply(b, plan, opts);
      await b.update({ status: rules.next('complete', b.status), completedAt: new Date(), balanceStatus: 'waived', updatedBy: actor.id }, { transaction });
    }
  } else {
    throw fail('DISPUTE_SOURCE_CHANGED', { status: b.status });
  }
  await c.publish(transaction, 'booking.dispute_settled', b, { refund: moved.refunded, released: moved.released, fee: moved.fee }, actor);
  return { refunded: moved.refunded, released: moved.released, fee: moved.fee };
}

/** The booking as the desk and the parties see it in a case (no phones; the member's team only). */
async function describe(sourceId) {
  const b = await Booking.findByPk(sourceId);
  if (!b) return null;
  const g = await reads.ground(b.groundId);
  const groundName = await require('../grounds/grounds.service').facts(b.groundId).then((f) => f?.name ?? '');
  return {
    kind: 'booking',
    id: b.id,
    code: b.code,
    status: b.status,
    groundId: b.groundId,
    groundName,
    courts: (g?.courts ?? []).filter((k) => b.courtIds.includes(k.id)).map((k) => k.name),
    start: c.iso(b.startAt),
    end: c.iso(b.endAt),
    noShowAt: c.iso(b.noShowAt),
    checkedInAt: c.iso(b.checkedInAt),
    settleDueAt: c.iso(b.settleDueAt),
    teamName: b.teamName ?? null,
    money: { price: b.pricePoisha, paidOnline: b.onlinePoisha, advance: b.advancePoisha, retained: b.retainedPoisha, refund: b.refundPoisha, released: b.releasedPoisha, balanceStatus: b.balanceStatus },
  };
}

function register() {
  require('../trust/targets.port').register('booking', { permission: 'resolve_reports', snapshot, options, freeze, unfreeze, applyOutcome, describe });
}

module.exports = { register, evaluate, snapshot, options, applyOutcome, describe };
