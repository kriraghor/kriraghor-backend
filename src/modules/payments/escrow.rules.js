'use strict';

/**
 * M06 escrow hold rules (§8, FR-13, FR-14). Pure functions, 100% branch coverage.
 */
const { feeOf } = require('../../common/money');

const OPEN = new Set(['holding', 'partially_released']);

/** Money still in the hold. */
const available = (h) => h.heldPoisha - h.releasedPoisha - h.refundedPoisha;

/** Can this hold pay out to its payee now? Returns null or an error code. */
function releaseBlock(h) {
  if (h.status === 'frozen') return 'ESCROW_FROZEN';
  if (!OPEN.has(h.status)) return 'ESCROW_CLOSED';
  if (!h.payeeId) return 'ESCROW_POOLED';
  if (available(h) <= 0) return 'ESCROW_EMPTY';
  return null;
}

/**
 * A release of `amount` (default: everything left). fee = round_half_up(base × fee_bps / 10000), where
 * the base is this tranche unless the purpose passes `feeBase` (M10 v3: the ground fee is on the full
 * booking value although only the advance was paid online). net = gross − fee, so rounding residue
 * stays with the payee. The fee can never exceed what is released.
 */
function release(h, amount = available(h), feeBase = null) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > available(h)) throw new RangeError('Release amount must be between 1 and what the hold still holds');
  if (feeBase !== null && (!Number.isSafeInteger(feeBase) || feeBase < 0)) throw new RangeError('Fee base must be a non-negative integer');
  const fee = feeOf(feeBase ?? amount, h.feeBps);
  if (fee > amount) throw new RangeError('The fee would exceed the amount released');
  return { gross: amount, fee, net: amount - fee };
}

/** Status after money leaves the hold (release or refund). */
function statusAfter(h, { released, refunded }) {
  const left = h.heldPoisha - released - refunded;
  if (left > 0) return released > 0 ? 'partially_released' : 'holding';
  if (released === 0) return 'refunded';
  return refunded === 0 ? 'released' : 'closed';
}

/** When a delay rule releases, from capture time. */
function releaseAt(rule, capturedAt) {
  if (rule?.type === 'delay') return new Date(new Date(capturedAt).getTime() + rule.hours * 3600 * 1000);
  return null;
}

module.exports = { OPEN, available, releaseBlock, release, statusAfter, releaseAt };
