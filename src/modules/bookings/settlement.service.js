'use strict';

/**
 * M10 settlement: turns a money plan (bookings.rules) into M06 calls inside the caller's transaction.
 * M10 never posts to the ledger itself (all money moves through M06):
 *   refund   → refunds.refundPayment (system policy refund from the hold)
 *   release  → escrow.releaseInTx with feeBase (v3: the fee on the full booking value)
 *   venue fee → fees.accrueReceivable (netted at the owner's next payout, M07)
 * Every call is idempotent by key (`booking:{id}:{step}`), so a retried job never moves money twice.
 */
const escrow = require('../payments/escrow.service');
const refunds = require('../payments/refunds.service');
const fees = require('../payments/fee.service');

/**
 * Apply a plan to a booking: refund first (from the hold), then release what is left to the owner.
 * Updates the booking's money columns. Returns what moved. M17 decisions pass kind 'dispute' and the
 * dispute's own key (`dispute:{id}`), so a decision never moves money twice either.
 */
async function apply(b, plan, { step, reasonCode, actor = null, transaction, kind = 'policy', key = null }) {
  let refunded = 0;
  let released = { gross: 0, fee: 0, net: 0 };
  if (plan.refund > 0 && b.paymentId) {
    const idempotencyKey = key ? `${key}:refund` : `booking:${b.id}:${step}:refund`;
    const r = await refunds.refundPayment({ paymentId: b.paymentId, amount: plan.refund, reasonCode, idempotencyKey, actor, kind }, { transaction });
    if (r) refunded = plan.refund;
  }
  if (plan.release > 0 && b.paymentId) {
    const hold = await escrow.lockHoldForPayment(b.paymentId, transaction);
    if (hold) released = await escrow.releaseInTx(hold, { amount: plan.release, feeBase: plan.feeBase, actor, transaction, kind: 'escrow.release_booking' });
  }
  await b.update(
    {
      refundPoisha: b.refundPoisha + refunded,
      releasedPoisha: b.releasedPoisha + released.gross,
      ...(step === 'retain' ? { retainedPoisha: released.gross } : {}),
    },
    { transaction }
  );
  return { refunded, released: released.gross, fee: released.fee, net: released.net };
}

/** A fee owed on money the owner collected at the venue (walk-in, extension, series session). */
const accrueVenueFee = (b, amount, key, { actor = null, transaction }) =>
  fees.accrueReceivable({ payeeId: b.ownerId, vertical: 'grounds', amount, refType: 'booking', refId: b.id, key: `booking:${b.id}:${key}`, memo: `Venue fee on booking ${b.code}`, actor }, { transaction });

/** Cancel a fee owed when the venue sale itself is cancelled (a walk-in entered by mistake). */
const reverseVenueFee = (b, key, { actor = null, transaction }) => fees.reverseReceivable({ key: `booking:${b.id}:${key}`, actor }, { transaction });

module.exports = { apply, accrueVenueFee, reverseVenueFee };
