'use strict';

// M10 state machine (§8.1, v3), time guards (FR-01, FR-05, FR-12 to FR-16, Q68) and the v3 money plans
// with the worked examples; M09 step 2 closure and series rules (FR-15, FR-19).
const B = require('../../src/modules/bookings/bookings.rules');
const G = require('../../src/modules/grounds/grounds.rules');
const { dhakaInstant } = require('../../src/modules/grounds/pricing.rules');

const MIN = 60 * 1000;
const start = dhakaInstant('2026-10-19', 18 * 60); // Mon 18:00 Dhaka
const end = new Date(start.getTime() + 120 * MIN);
const plus = (t, m) => new Date(new Date(t).getTime() + m * MIN);
const BPS = 500; // fees.ground_booking_pct = 5

describe('M10 §8.1 booking state machine (v3)', () => {
  it('allows each transition only from its statuses', () => {
    expect(B.next('confirm', 'pending_payment')).toBe('confirmed');
    expect(B.next('confirm', 'expired')).toBeNull();
    expect(B.next('expire', 'pending_payment')).toBe('expired');
    expect(B.next('check_in', 'confirmed')).toBe('checked_in');
    expect(B.next('check_in', 'checked_in')).toBeNull();
    expect(B.next('complete', 'checked_in')).toBe('completed');
    expect(B.next('complete', 'confirmed')).toBe('completed'); // auto-complete (Q68)
    expect(B.next('complete', 'no_show')).toBeNull();
    expect(B.next('no_show', 'confirmed')).toBe('no_show');
    expect(B.next('no_show', 'checked_in')).toBeNull();
    expect(B.next('cancel', 'confirmed')).toBe('cancelled');
    expect(B.next('cancel', 'checked_in')).toBeNull();
    expect(B.next('owner_cancel', 'confirmed')).toBe('cancelled_by_owner');
    expect(B.next('platform_cancel', 'pending_payment')).toBe('cancelled_by_platform');
    expect(B.next('platform_cancel', 'confirmed')).toBe('cancelled_by_platform');
    expect(B.next('platform_cancel', 'completed')).toBeNull();
    expect(B.next('skip', 'confirmed')).toBe('skipped');
    expect(B.next('restore', 'skipped')).toBe('confirmed');
    expect(B.next('restore', 'cancelled')).toBeNull();
    expect([...B.OCCUPYING]).toEqual(['pending_payment', 'confirmed', 'checked_in']);
    expect(B.UPCOMING.has('checked_in')).toBe(false);
  });
});

describe('M10 time guards', () => {
  it('half-hour grid', () => {
    expect(B.isHalfHour(start)).toBe(true);
    expect(B.isHalfHour(plus(start, 15))).toBe(false);
    expect(B.ceilHalfHour(plus(start, 1))).toBe(plus(start, 30).getTime());
    expect(B.ceilHalfHour(start)).toBe(start.getTime());
  });

  it('slot request (§6.1): grid, cutoff and the 7-day window', () => {
    const now = plus(start, -120);
    expect(B.slotBlock({ start, now, cutoffMin: 30, windowDays: 7 })).toBeNull();
    expect(B.slotBlock({ start: plus(start, 10), now, cutoffMin: 30, windowDays: 7 })).toBe('NOT_HALF_HOUR');
    expect(B.slotBlock({ start, now: plus(start, -29), cutoffMin: 30, windowDays: 7 })).toBe('TOO_LATE');
    expect(B.slotBlock({ start, now: plus(start, -30), cutoffMin: 30, windowDays: 7 })).toBeNull();
    expect(B.slotBlock({ start, now: plus(start, -(7 * 24 * 60 + 1)), cutoffMin: 0, windowDays: 7 })).toBe('OUT_OF_RANGE');
  });

  it('hold limits (FR-05, Q21)', () => {
    expect(B.holdBlock({ activeHolds: 1, recentAttempts: 4, maxHolds: 2, maxAttempts: 5 })).toBeNull();
    expect(B.holdBlock({ activeHolds: 2, recentAttempts: 0, maxHolds: 2, maxAttempts: 5 })).toBe('HOLD_LIMIT');
    expect(B.holdBlock({ activeHolds: 0, recentAttempts: 5, maxHolds: 2, maxAttempts: 5 })).toBe('HOLD_RATE_LIMITED');
  });

  it('check-in window: start − 30 min until the end (FR-13)', () => {
    const g = (now) => B.checkInBlock({ start, end, now, openBeforeMin: 30 });
    expect(g(plus(start, -31))).toBe('NOT_CHECKIN_WINDOW');
    expect(g(plus(start, -30))).toBeNull();
    expect(g(plus(end, -1))).toBeNull();
    expect(g(end)).toBe('NOT_CHECKIN_WINDOW');
  });

  it('late is derived (FR-14)', () => {
    expect(B.isLate({ status: 'confirmed', start, graceMin: 15, now: plus(start, 15) })).toBe(false);
    expect(B.isLate({ status: 'confirmed', start, graceMin: 15, now: plus(start, 16) })).toBe(true);
    expect(B.isLate({ status: 'checked_in', start, graceMin: 15, now: plus(start, 60) })).toBe(false);
  });

  it('no-show: after the grace, until auto-complete (FR-15, Q68)', () => {
    const g = (now) => B.noShowBlock({ start, end, graceMin: 15, now, autoCompleteHours: 24 });
    expect(g(plus(start, 15))).toBe('NOT_LATE_YET');
    expect(g(plus(start, 16))).toBeNull();
    expect(g(plus(end, 24 * 60 - 1))).toBeNull();
    expect(g(plus(end, 24 * 60))).toBe('NO_SHOW_WINDOW_CLOSED');
  });

  it('cancel before start; extend before the end; auto-complete after 24 h', () => {
    expect(B.cancelBlock({ start, now: plus(start, -1) })).toBeNull();
    expect(B.cancelBlock({ start, now: start })).toBe('ALREADY_STARTED');
    expect(B.extendBlock({ end, now: plus(end, -1) })).toBeNull();
    expect(B.extendBlock({ end, now: end })).toBe('BOOKING_ENDED');
    expect(B.autoCompleteDue({ end, now: plus(end, 24 * 60 - 1), hours: 24 })).toBe(false);
    expect(B.autoCompleteDue({ end, now: plus(end, 24 * 60), hours: 24 })).toBe(true);
  });

  it('late minutes and the released no-show tail', () => {
    expect(B.lateMinutes(start, plus(start, -5))).toBe(0);
    expect(B.lateMinutes(start, plus(start, 17.5))).toBe(17);
    // marked at 18:20 → the court is free again from 18:30
    expect(B.noShowTailEnd({ start, end, now: plus(start, 20) })).toEqual(plus(start, 30));
    // marked at 18:00:30 — the first half-hour is kept
    expect(B.noShowTailEnd({ start, end, now: plus(start, 0.5) })).toEqual(plus(start, 30));
    expect(B.noShowTailEnd({ start, end, now: plus(end, -10) })).toBeNull();
  });

  it('availability cells (FR-02)', () => {
    const now = plus(start, -120);
    const c = (over) => B.cellState({ start, now, cutoffMin: 0, open: true, occupiedBy: null, viewerId: 'u1', ...over });
    expect(c({})).toBe('open');
    expect(c({ now: plus(start, 1) })).toBe('past');
    expect(c({ open: false })).toBe('closed');
    expect(c({ occupiedBy: { bookerUserId: 'u2' } })).toBe('booked');
    expect(c({ occupiedBy: { bookerUserId: null } })).toBe('booked');
    expect(c({ occupiedBy: { bookerUserId: 'u1' } })).toBe('yours');
  });
});

describe('M10 v3 money plans (CLAUDE.md worked examples)', () => {
  // ৳2,000 booking, 25% advance → ৳500 online; fee 5% × ৳2,000 = ৳100.
  const price = 200000;
  const advance = 50000;
  const policy = { refundAboveAdvance: true, advanceRefundable: false };

  it('what is paid online for each choice', () => {
    expect(B.onlineFor({ choice: 'advance', price, advance, allowFull: true })).toBe(50000);
    expect(B.onlineFor({ choice: 'full', price, advance, allowFull: true })).toBe(200000);
    expect(() => B.onlineFor({ choice: 'full', price, advance, allowFull: false })).toThrow(RangeError);
    expect(B.onlineFor({ choice: 'venue', price, advance, allowFull: true })).toBe(0);
    expect(B.balanceDue({ total: 200000, online: 50000 })).toBe(150000);
    expect(B.balanceDue({ total: 200000, online: 200000 })).toBe(0);
  });

  it('check-in, advance: the owner receives ৳400 and Kriraghor ৳100 (plus ৳1,500 cash at the venue)', () => {
    expect(B.releasePlan({ price, online: advance, feeBps: BPS })).toEqual({ release: 50000, feeBase: 200000, fee: 10000, net: 40000, refund: 0 });
  });

  it('check-in, paid in full: the owner receives ৳1,900', () => {
    expect(B.releasePlan({ price, online: price, feeBps: BPS })).toMatchObject({ net: 190000, fee: 10000 });
  });

  it('nothing online (walk-in, series): nothing to release', () => {
    expect(B.releasePlan({ price, online: 0, feeBps: BPS })).toEqual({ release: 0, feeBase: 0, fee: 0, net: 0, refund: 0 });
    expect(() => B.releasePlan({ price, online: 5000, feeBps: BPS })).toThrow(RangeError);
  });

  it('member cancel or no-show, advance: ৳475 to the owner, ৳25 to Kriraghor', () => {
    expect(B.retainPlan({ online: advance, advance, feeBps: BPS, ...policy })).toEqual({ release: 50000, feeBase: 50000, fee: 2500, net: 47500, refund: 0 });
  });

  it('member cancel or no-show after paying in full: the same, and ৳1,500 back (Q120)', () => {
    expect(B.retainPlan({ online: price, advance, feeBps: BPS, ...policy })).toEqual({ release: 50000, feeBase: 50000, fee: 2500, net: 47500, refund: 150000 });
    // without the Q120 refund the whole payment is retained
    expect(B.retainPlan({ online: price, advance, feeBps: BPS, refundAboveAdvance: false, advanceRefundable: false })).toMatchObject({ release: 200000, fee: 10000, refund: 0 });
    // tiers back on (advance refundable): everything is refunded
    expect(B.retainPlan({ online: advance, advance, feeBps: BPS, refundAboveAdvance: true, advanceRefundable: true })).toMatchObject({ release: 0, refund: 50000 });
  });

  it('owner or platform cancel: 100% back', () => {
    expect(B.refundAllPlan({ online: advance })).toEqual({ release: 0, feeBase: 0, fee: 0, net: 0, refund: 50000 });
    expect(B.refundAllPlan({ online: price }).refund).toBe(200000);
  });

  it('venue fees: a ৳600 extension owes ৳30; a ৳2,750 walk-in owes ৳137.50', () => {
    expect(B.venueFee(60000, BPS)).toBe(3000);
    expect(B.venueFee(275000, BPS)).toBe(13750);
  });

  it('the cancel preview the member confirms', () => {
    expect(B.memberCancelPreview({ online: price, advance, feeBps: BPS }, policy)).toEqual({ refund: 150000, retained: 50000 });
  });
});

describe('M09 step 2: closures and series', () => {
  const now = plus(start, -60);
  it('closure periods (FR-15, Q63)', () => {
    const g = (over) => G.closureBlock({ start, end, now, maxDaysAhead: 90, ...over });
    expect(g({})).toBeNull();
    expect(g({ start: plus(start, 10) })).toBe('NOT_HALF_HOUR');
    expect(g({ end: plus(end, 10) })).toBe('NOT_HALF_HOUR');
    expect(g({ end: start })).toBe('CLOSURE_EMPTY');
    expect(g({ now: end })).toBe('CLOSURE_IN_PAST');
    expect(g({ start: plus(now, 91 * 24 * 60 + 60), end: plus(now, 91 * 24 * 60 + 120) })).toBe('OUT_OF_RANGE');
    expect(G.closurePhase({ start, end, now })).toBe('upcoming');
    expect(G.closurePhase({ start, end, now: start })).toBe('in_progress');
    expect(G.closurePhase({ start, end, now: end })).toBe('past');
  });

  it('series shape (FR-19)', () => {
    const ok = { firstDate: '2026-10-19', dow: 1, startTime: '19:00', lengthMin: 120, weeks: 8, weeksOptions: [4, 6, 8, 12], minBookingMin: 60, today: '2026-10-17' };
    expect(G.seriesBlock(ok)).toBeNull();
    expect(G.seriesBlock({ ...ok, weeks: 5 })).toBe('SERIES_WEEKS_INVALID');
    expect(G.seriesBlock({ ...ok, lengthMin: 45 })).toBe('LENGTH_INVALID');
    expect(G.seriesBlock({ ...ok, lengthMin: 60, minBookingMin: 90 })).toBe('LENGTH_INVALID');
    expect(G.seriesBlock({ ...ok, startTime: '19:15' })).toBe('NOT_HALF_HOUR');
    expect(G.seriesBlock({ ...ok, today: '2026-10-20' })).toBe('OUT_OF_RANGE');
    expect(G.seriesBlock({ ...ok, dow: 2 })).toBe('SERIES_DAY_MISMATCH');
  });

  it('series weeks on the Dhaka wall clock (8 × Mon 19:00–21:00)', () => {
    const w = G.seriesWeeks({ firstDate: '2026-10-19', startTime: '19:00', lengthMin: 120, weeks: 8 });
    expect(w).toHaveLength(8);
    expect(w[0]).toMatchObject({ week: 0, date: '2026-10-19', start: dhakaInstant('2026-10-19', 19 * 60) });
    expect(w[7]).toMatchObject({ week: 7, date: '2026-12-07' });
    expect(w[7].end.getTime() - w[7].start.getTime()).toBe(120 * MIN);
  });
});
