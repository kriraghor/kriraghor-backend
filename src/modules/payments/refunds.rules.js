'use strict';

/**
 * M06 refund rules (FR-08, FR-09, §6.5). Pure functions, 100% branch coverage.
 */

// Refund statuses that still count against what can be refunded (rejected ones do not).
const COUNTED = new Set(['pending_master', 'approved', 'processing', 'succeeded', 'failed', 'manual_required']);

/** refundable = captured − Σ refunds (succeeded or still pending) (§6.5). */
function refundable(captured, refunds) {
  const used = refunds.filter((r) => COUNTED.has(r.status)).reduce((s, r) => s + r.amount, 0);
  return Math.max(0, captured - used);
}

/**
 * Who may refund how much (FR-09):
 *   system  — policy refunds, unlimited → approved
 *   master  — approved (amounts above the staff limit need step-up, enforced by the route)
 *   staff with refund_small — approved if this refund and the staff's total on the payment stay
 *             within the limit; otherwise escalated to a master (pending_master)
 * `staffTotal` = what staff (not masters, not the system) already refunded on this payment.
 */
function authority({ actorKind, amount, staffTotal, limit }) {
  if (actorKind === 'system' || actorKind === 'master') return 'approved';
  if (actorKind !== 'staff') throw new TypeError(`Unknown actor kind: ${actorKind}`);
  return amount <= limit && staffTotal + amount <= limit ? 'approved' : 'pending_master';
}

/**
 * Where the refund money comes from: the escrow hold while it still holds enough, otherwise
 * (money already released to the payee) only a master can refund it as goodwill, a platform expense.
 * Mismatched captures are refunded from suspense.
 */
function source({ kind, holdAvailable, amount, actorKind }) {
  if (kind === 'amount_mismatch') return 'suspense';
  if (amount <= holdAvailable) return 'escrow';
  if (actorKind === 'master' && kind === 'goodwill') return 'goodwill';
  return null;
}

/** Payment status after its refunded total changes. */
function paymentStatusAfterRefund({ status, captured, refunded }) {
  if (status === 'failed') return 'failed'; // a mismatched capture stays failed while it is refunded
  if (refunded >= captured) return 'refunded';
  return refunded > 0 ? 'partially_refunded' : status;
}

/** Retry delays for provider refund calls: 1 min, 10 min, 1 h (§10). */
const RETRY_DELAYS_MS = [60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000];
const retryDelay = (attempt) => RETRY_DELAYS_MS[Math.min(Math.max(attempt, 1), RETRY_DELAYS_MS.length) - 1];

module.exports = { refundable, authority, source, paymentStatusAfterRefund, retryDelay, COUNTED, RETRY_DELAYS_MS };
