'use strict';

/**
 * M13 settlement: turns a sub-order's outcome into M06 calls inside the caller's transaction. M13
 * never posts to the ledger itself (all money moves through M06), and only ever touches its own
 * split of the order's payment (escrow split_ref = the sub-order id):
 *   refund   → refunds.refundPayment({ splitRef }) from that hold
 *   release  → escrow.releaseInTx with feeBase = the items subtotal (no commission on delivery), into
 *              the shop's payable; M07's shop_weekly run pays it out
 * Every call is idempotent by key (`sub_order:{id}:{step}`), so a retried job never moves money twice.
 */
const escrow = require('../payments').escrow;
const refunds = require('../payments').refunds;
const { Order } = require('../../models');
const c = require('./orders.common');

const paymentIdOf = async (s, transaction) => (await Order.findByPk(s.orderId, { attributes: ['paymentId'], transaction })).paymentId;

/** Refund `amount` of this sub-order's split to the buyer. Returns what was refunded. */
async function refund(s, amount, { reasonCode, key, kind = 'policy', actor = null, transaction }) {
  if (amount <= 0) return 0;
  const paymentId = await paymentIdOf(s, transaction);
  const r = await refunds.refundPayment({ paymentId, amount, reasonCode, idempotencyKey: `${key}:refund`, actor, kind, splitRef: s.id }, { transaction });
  if (!r) return 0;
  await s.update({ refundedPoisha: s.refundedPoisha + amount }, { transaction });
  return amount;
}

/** Everything still held for this sub-order goes back to the buyer (reject, cancel, expiry). */
const refundAll = (s, opts) => refund(s, s.totalPoisha - s.refundedPoisha - s.releasedPoisha, opts);

/**
 * Release `amount` of the split to the shop with the fee on `feeBase` (default: the items subtotal,
 * capped at the amount,
 * so a ৳5,200 + ৳80 sub-order pays ৳260 and the shop gets ৳5,020). Returns { gross, fee, net }.
 */
async function release(s, amount, { feeBase = null, actor = null, transaction }) {
  if (amount <= 0) return { gross: 0, fee: 0, net: 0 };
  const paymentId = await paymentIdOf(s, transaction);
  const hold = await escrow.lockHoldForPayment(paymentId, transaction, { splitRef: s.id });
  if (!hold) return { gross: 0, fee: 0, net: 0 };
  if (hold.status === 'frozen') await escrow.unfreezeInTx(hold, { reason: 'dispute_closed', actor, transaction });
  const moved = await escrow.releaseInTx(hold, { amount, feeBase: feeBase ?? Math.min(s.itemsPoisha, amount), actor, transaction, kind: 'escrow.release_order' });
  await s.update({ releasedPoisha: s.releasedPoisha + moved.gross }, { transaction });
  return moved;
}

/** Completed (received, auto, or a dispute that kept the money with the shop): release the rest. */
async function complete(s, by, { actor = null, transaction }) {
  const moved = await release(s, s.totalPoisha - s.refundedPoisha - s.releasedPoisha, { actor, transaction });
  await s.update({ status: 'completed', completedAt: new Date(), completedBy: by }, { transaction });
  await c.publishSub(transaction, 'sub_order.completed', s, { by, released: moved.gross, fee: moved.fee, net: moved.net }, actor);
  await c.syncOrder(s.orderId, { transaction });
  return moved;
}

/** The hold of this sub-order (for M17 freeze and unfreeze). */
async function holdOf(s, transaction) {
  const paymentId = await paymentIdOf(s, transaction);
  return paymentId ? escrow.lockHoldForPayment(paymentId, transaction, { splitRef: s.id }) : null;
}

module.exports = { refund, refundAll, release, complete, holdOf };
