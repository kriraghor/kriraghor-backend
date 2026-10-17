'use strict';

/**
 * M10 booking rules: the state machine (§8.1), the time guards and the v3 money plans. Pure
 * functions, 100% branch coverage. Times are Date or epoch ms; money is integer poisha.
 *
 * v3 money (CLAUDE.md "Business rules v3", decided 17 Oct 2026):
 *   - the member pays the advance or the full price online; it waits in escrow;
 *   - check-in (or auto-complete, booking.auto_complete_after_hours after the end) releases all of
 *     it to the owner minus the fee on the full value (৳2,000 @ 25%: ৳500 online → ৳400 + ৳100 fee);
 *   - member cancel or owner no-show: the advance is retained, Kriraghor keeps fee% × retained and
 *     the owner the rest (৳475 / ৳25); anything paid above the advance is refunded (Q120);
 *   - owner or platform cancel: 100% of what was paid online is refunded.
 * No refund tiers apply (booking.advance_refundable = false); the setting stays so tiers can return.
 */
const { feeOf } = require('../../common/money');

const MIN = 60 * 1000;
const HALF_HOUR = 30 * MIN;
const ms = (t) => new Date(t).getTime();

// ---------------------------------------------------------------------------------------------
// State machine (§8.1, v3: instant confirmation, no awaiting_owner/declined, no automatic no-show)

const TRANSITIONS = {
  confirm: { from: ['pending_payment'], to: 'confirmed' }, // payment captured (FR-06)
  expire: { from: ['pending_payment'], to: 'expired' }, // hold lapsed or released (FR-08)
  check_in: { from: ['confirmed'], to: 'checked_in' }, // FR-13
  complete: { from: ['checked_in', 'confirmed'], to: 'completed' }, // end of a checked-in booking, or auto-complete
  no_show: { from: ['confirmed'], to: 'no_show' }, // FR-15, owner only
  cancel: { from: ['confirmed'], to: 'cancelled' }, // booker (FR-11)
  owner_cancel: { from: ['confirmed'], to: 'cancelled_by_owner' }, // FR-19
  platform_cancel: { from: ['pending_payment', 'confirmed'], to: 'cancelled_by_platform' },
  skip: { from: ['confirmed'], to: 'skipped' }, // series week (M09 FR-22)
  restore: { from: ['skipped'], to: 'confirmed' },
};

/** The status after `action`, or null when the action is not allowed from `from`. */
const next = (action, from) => (TRANSITIONS[action].from.includes(from) ? TRANSITIONS[action].to : null);

/** Statuses that hold the court (the slot rows stay active). */
const OCCUPYING = new Set(['pending_payment', 'confirmed', 'checked_in']);
/** Upcoming for M09 (COURT_HAS_BOOKINGS, the pricing footer). */
const UPCOMING = new Set(['pending_payment', 'confirmed']);

// ---------------------------------------------------------------------------------------------
// Time guards. Each returns null (allowed) or a stable error code.

/** The 30-minute grid: a start must sit on :00 or :30. */
const isHalfHour = (t) => ms(t) % HALF_HOUR === 0;

/** The next half-hour boundary at or after t. */
const ceilHalfHour = (t) => Math.ceil(ms(t) / HALF_HOUR) * HALF_HOUR;

/**
 * Can a member book this start (§6.1)? The length and the opening hours are checked by M09's
 * pricing service (LENGTH_INVALID, OUTSIDE_HOURS).
 */
function slotBlock({ start, now, cutoffMin, windowDays }) {
  if (!isHalfHour(start)) return 'NOT_HALF_HOUR';
  if (ms(start) < ms(now) + cutoffMin * MIN) return 'TOO_LATE';
  if (ms(start) > ms(now) + windowDays * 24 * 60 * MIN) return 'OUT_OF_RANGE';
  return null;
}

/** FR-05, Q21: at most N active holds per member and M hold attempts per 10 minutes. */
function holdBlock({ activeHolds, recentAttempts, maxHolds, maxAttempts }) {
  if (activeHolds >= maxHolds) return 'HOLD_LIMIT';
  if (recentAttempts >= maxAttempts) return 'HOLD_RATE_LIMITED';
  return null;
}

/** FR-13: from start − open minutes until the end. */
function checkInBlock({ start, end, now, openBeforeMin }) {
  if (ms(now) < ms(start) - openBeforeMin * MIN || ms(now) >= ms(end)) return 'NOT_CHECKIN_WINDOW';
  return null;
}

/** FR-14: late is derived, never stored. */
const isLate = ({ status, start, graceMin, now }) => status === 'confirmed' && ms(now) > ms(start) + graceMin * MIN;

/** FR-15 (v3): the owner may mark a no-show once the member is late, until auto-complete. */
function noShowBlock({ start, end, graceMin, now, autoCompleteHours }) {
  if (ms(now) <= ms(start) + graceMin * MIN) return 'NOT_LATE_YET';
  if (ms(now) >= ms(end) + autoCompleteHours * 60 * MIN) return 'NO_SHOW_WINDOW_CLOSED';
  return null;
}

/** FR-12: no cancel once the booking has started. */
const cancelBlock = ({ start, now }) => (ms(now) >= ms(start) ? 'ALREADY_STARTED' : null);

/** FR-16: extend +30 minutes while checked in and before the end. */
const extendBlock = ({ end, now }) => (ms(now) >= ms(end) ? 'BOOKING_ENDED' : null);

/** Auto-complete (Q68, v3): never checked in, auto_complete_after_hours after the end. */
const autoCompleteDue = ({ end, now, hours }) => ms(now) >= ms(end) + hours * 60 * MIN;

/** Minutes after the start (0 when early). */
const lateMinutes = (start, at) => Math.max(0, Math.floor((ms(at) - ms(start)) / MIN));

/**
 * FR-15: after a no-show the court is free again from the next half-hour boundary. Returns the new
 * end of the slot, or null when nothing is left to release.
 */
function noShowTailEnd({ start, end, now }) {
  const cut = Math.max(ceilHalfHour(now), ms(start) + HALF_HOUR);
  return cut < ms(end) ? new Date(cut) : null;
}

/** Availability cell (FR-02): past, closed, yours, booked or open. */
function cellState({ start, now, cutoffMin, open, occupiedBy, viewerId }) {
  if (ms(start) < ms(now) + cutoffMin * MIN) return 'past';
  if (!open) return 'closed';
  if (occupiedBy) return occupiedBy.bookerUserId && occupiedBy.bookerUserId === viewerId ? 'yours' : 'booked';
  return 'open';
}

// ---------------------------------------------------------------------------------------------
// Money (v3)

/** What the member pays online for each choice. A walk-in or series session pays at the venue. */
function onlineFor({ choice, price, advance, allowFull }) {
  if (choice === 'advance') return advance;
  if (choice === 'full') {
    if (!allowFull) throw new RangeError('Full online payment is switched off');
    return price;
  }
  return 0;
}

/** Due at the venue after check-in (the extensions are always paid there). */
const balanceDue = ({ total, online }) => Math.max(0, total - online);

/**
 * Check-in or auto-complete: release everything paid online, fee on the full booking value
 * (escrow feeBase). With nothing online (walk-in, series) nothing is released.
 *   ৳2,000 @ 25%: online 50000 → net 40000, fee 10000. Paid in full: 200000 → 190000 + 10000.
 */
function releasePlan({ price, online, feeBps }) {
  if (online === 0) return { release: 0, feeBase: 0, fee: 0, net: 0, refund: 0 };
  const fee = feeOf(price, feeBps);
  if (fee > online) throw new RangeError('The fee is more than what was paid online');
  return { release: online, feeBase: price, fee, net: online - fee, refund: 0 };
}

/**
 * Member cancel or owner no-show: the advance is retained (fee on what is retained), the rest is
 * refunded when refundAboveAdvance (Q120). advanceRefundable (off in v3) refunds everything.
 *   ৳500 advance: retained 50000 → owner 47500, fee 2500. Paid ৳2,000 in full: + refund 150000.
 */
function retainPlan({ online, advance, feeBps, refundAboveAdvance, advanceRefundable }) {
  if (advanceRefundable) return { release: 0, feeBase: 0, fee: 0, net: 0, refund: online };
  const retained = refundAboveAdvance ? Math.min(online, advance) : online;
  const fee = feeOf(retained, feeBps);
  return { release: retained, feeBase: retained, fee, net: retained - fee, refund: online - retained };
}

/** Owner or platform cancel: everything paid online goes back (FR-19, v3). */
const refundAllPlan = ({ online }) => ({ release: 0, feeBase: 0, fee: 0, net: 0, refund: online });

/** Fees owed on venue money (walk-ins, extensions, series sessions), netted at the next payout. */
const venueFee = (amount, feeBps) => feeOf(amount, feeBps);

/** The cancel preview the member confirms; a different figure at cancel time is 409 REFUND_CHANGED. */
function memberCancelPreview(b, policy) {
  const plan = retainPlan({ online: b.online, advance: b.advance, feeBps: b.feeBps, ...policy });
  return { refund: plan.refund, retained: plan.release };
}

module.exports = {
  TRANSITIONS,
  next,
  OCCUPYING,
  UPCOMING,
  HALF_HOUR,
  isHalfHour,
  ceilHalfHour,
  slotBlock,
  holdBlock,
  checkInBlock,
  isLate,
  noShowBlock,
  cancelBlock,
  extendBlock,
  autoCompleteDue,
  lateMinutes,
  noShowTailEnd,
  cellState,
  onlineFor,
  balanceDue,
  releasePlan,
  retainPlan,
  refundAllPlan,
  venueFee,
  memberCancelPreview,
};
