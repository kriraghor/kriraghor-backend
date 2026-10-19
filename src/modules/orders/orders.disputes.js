'use strict';

/**
 * M13's side of the M17 targets port (source 'sub_order'). The buyer can dispute:
 *   not_received  while the sub-order is shipped (the shop never marked it delivered), or within
 *                 disputes.window_order_hours of being marked delivered
 * Opening moves the sub-order to disputed and freezes its escrow hold (M06), so neither the buyer's
 * "received" nor auto-complete can release it. Withdrawing puts it back (delivered or shipped). The
 * decision refunds from the hold (kind 'dispute') and releases the rest to the shop, the commission
 * on what the shop keeps but never on the delivery fee (feeBaseMax = the items subtotal), all in the
 * decision transaction.
 */
const { SubOrder } = require('../../models');
const { fail } = require('../trust/trust.errors');
const escrow = require('../payments').escrow;
const settle = require('./orders.settle');
const rules = require('./orders.rules');
const c = require('./orders.common');

const CATEGORIES = ['not_received'];

const heldOf = (s) => s.totalPoisha - s.refundedPoisha - s.releasedPoisha;

function evaluate(s, category, now) {
  if (!CATEGORIES.includes(category)) return { block: 'DISPUTE_NOT_ELIGIBLE' };
  const block = rules.notReceivedBlock({ status: s.status, deliveredAt: s.deliveredAt, now, windowHours: c.config().disputeHours });
  if (block) return { block };
  return { money: true, held: heldOf(s), closesAt: rules.notReceivedClosesAt({ status: s.status, deliveredAt: s.deliveredAt, windowHours: c.config().disputeHours }) };
}

async function snapshot({ sourceId, category, principal, transaction }) {
  const s = await c.lockSub(sourceId, transaction);
  if (!s) throw fail('DISPUTE_NOT_ELIGIBLE');
  if (s.buyerId !== principal.id) throw fail('NOT_YOUR_ORDER');
  const e = evaluate(s, category, new Date());
  if (e.block) throw fail(e.block);
  return {
    ref: s.code,
    claimantId: s.buyerId,
    respondentId: s.sellerId,
    money: true,
    paid: s.totalPoisha,
    held: e.held,
    policyKey: 'order.not_received',
    policy: {
      feeBps: s.commissionBps,
      feeBaseMax: s.itemsPoisha,
      items: s.itemsPoisha,
      delivery: s.deliveryPoisha,
      total: s.totalPoisha,
      status: s.status,
      courier: s.courierName,
      trackingNo: s.trackingNo,
      shippedAt: c.iso(s.shippedAt),
      deliveredAt: c.iso(s.deliveredAt),
      closesAt: c.iso(e.closesAt),
    },
  };
}

/** GET /me/disputes/options: what the buyer can open on this sub-order now. */
async function options({ sourceId, principal }) {
  const s = await SubOrder.findByPk(sourceId);
  if (!s || s.buyerId !== principal.id) return [];
  const now = new Date();
  return CATEGORIES.map((category) => ({ category, ...evaluate(s, category, now) }))
    .filter((o) => !o.block)
    .map((o) => ({ category: o.category, money: o.money, held: o.held, closesAt: c.iso(o.closesAt) }));
}

async function freeze({ sourceId, ref, actor, transaction }) {
  const s = await c.lockSub(sourceId, transaction);
  const to = rules.next('dispute', s.status, 'buyer');
  if (!to) throw fail('DISPUTE_NOT_ELIGIBLE');
  const hold = await settle.holdOf(s, transaction);
  if (hold && hold.status !== 'frozen') await escrow.freezeInTx(hold, { reason: 'dispute', ref, actor, transaction });
  await s.update({ status: to, disputeId: ref }, { transaction });
  await c.publishSub(transaction, 'sub_order.disputed', s, { disputeId: ref }, actor);
}

/** The dispute was withdrawn: the hold thaws and the sub-order goes back to where it was. */
async function unfreeze({ sourceId, actor, transaction }) {
  const s = await c.lockSub(sourceId, transaction);
  const hold = await settle.holdOf(s, transaction);
  if (hold?.status === 'frozen') await escrow.unfreezeInTx(hold, { reason: 'dispute_closed', actor, transaction });
  if (s.status === 'disputed') await s.update({ status: s.deliveredAt ? 'delivered' : 'shipped', disputeId: null }, { transaction });
}

/** The decision (M17 plan): refund part or all from the split, release the rest to the shop. */
async function applyOutcome({ sourceId, dispute, plan, actor, transaction }) {
  const s = await c.lockSub(sourceId, transaction);
  if (s.status !== 'disputed') throw fail('DISPUTE_SOURCE_CHANGED', { status: s.status });
  const key = `dispute:${dispute.id}`;
  const hold = await settle.holdOf(s, transaction);
  if (hold?.status === 'frozen') await escrow.unfreezeInTx(hold, { reason: 'dispute_closed', actor, transaction });
  const refunded = await settle.refund(s, plan.refund, { reasonCode: `dispute_${dispute.category}`, key, kind: 'dispute', actor, transaction });
  let moved = { gross: 0, fee: 0, net: 0 };
  if (plan.release > 0) {
    moved = await settle.release(s, plan.release, { feeBase: plan.feeBase, actor, transaction });
    await s.update({ status: rules.next('dispute_release', s.status, 'dispute'), completedAt: new Date(), completedBy: 'dispute' }, { transaction });
    await c.publishSub(transaction, 'sub_order.completed', s, { by: 'dispute', released: moved.gross, fee: moved.fee, net: moved.net, refund: refunded }, actor);
  } else {
    await s.update({ status: rules.next('dispute_refund', s.status, 'dispute') }, { transaction });
    await c.publishSub(transaction, 'sub_order.refunded', s, { refund: refunded, disputeId: dispute.id }, actor);
  }
  await c.syncOrder(s.orderId, { transaction });
  return { refunded, released: moved.gross, fee: moved.fee };
}

/** The sub-order as the desk and the parties see it (no phone or address). */
async function describe(sourceId) {
  const s = await SubOrder.findByPk(sourceId);
  if (!s) return null;
  const [items, shops] = await Promise.all([c.itemsOf([s.id]), c.shopsOf([s])]);
  return {
    kind: 'sub_order',
    id: s.id,
    code: s.code,
    status: s.status,
    shopName: shops.get(s.shopId)?.name ?? '',
    items: items.map((i) => ({ title: i.title, variantLabelEn: i.variantLabelEn, variantLabelBn: i.variantLabelBn, qty: i.qty, lineTotal: i.lineTotalPoisha })),
    courier: s.courierName ? { name: s.courierName, trackingNo: s.trackingNo } : null,
    shippedAt: c.iso(s.shippedAt),
    deliveredAt: c.iso(s.deliveredAt),
    deliveredProof: Boolean(s.deliveredProofKey),
    money: { items: s.itemsPoisha, delivery: s.deliveryPoisha, total: s.totalPoisha, refunded: s.refundedPoisha, released: s.releasedPoisha, commissionBps: s.commissionBps },
  };
}

function register() {
  require('../trust/targets.port').register('sub_order', { permission: 'resolve_reports', snapshot, options, freeze, unfreeze, applyOutcome, describe });
}

module.exports = { register, evaluate, snapshot, options, freeze, unfreeze, applyOutcome, describe };
