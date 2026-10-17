'use strict';

// M17 rules (100% branch gate): the dispute machine (§8.1), windows and SLAs (Q95), the outcome maths
// with the ৳500 retained example, decision authority (§6.3), reporter eligibility and auto-hide (Q99),
// review eligibility, edits and content checks (Q98).
const r = require('../../src/modules/trust/trust.rules');

const T0 = new Date('2026-10-20T10:00:00Z');
const H = 3600 * 1000;
const at = (hours) => new Date(T0.getTime() + hours * H);

describe('M17 state machine (§8.1)', () => {
  it('allows each transition only from its states', () => {
    expect(r.next('respond', 'awaiting_response')).toBe('under_review');
    expect(r.next('respond', 'under_review')).toBeNull();
    expect(r.next('respondent_timeout', 'awaiting_response')).toBe('under_review');
    expect(r.next('escalate', 'under_review')).toBe('escalated');
    expect(r.next('escalate', 'escalated')).toBeNull();
    expect(r.next('send_back', 'escalated')).toBe('under_review');
    expect(r.next('decide', 'under_review')).toBe('resolved');
    expect(r.next('decide', 'escalated')).toBeNull();
    expect(r.next('master_decide', 'escalated')).toBe('resolved');
    expect(r.next('master_decide', 'under_review')).toBe('resolved');
    expect(r.next('master_decide', 'awaiting_response')).toBeNull();
    for (const s of r.ACTIVE) expect(r.next('withdraw', s)).toBe('withdrawn');
    expect(r.next('withdraw', 'resolved')).toBeNull();
    expect(r.next('withdraw', 'withdrawn')).toBeNull();
  });

  it('knows active cases, the first status and the open limit (FR-02)', () => {
    expect(r.isActive('escalated')).toBe(true);
    expect(r.isActive('resolved')).toBe(false);
    expect(r.initialStatus({ hasRespondent: true })).toBe('awaiting_response');
    expect(r.initialStatus({ hasRespondent: false })).toBe('under_review');
    expect(r.openBlock({ openCount: 2, max: 3 })).toBeNull();
    expect(r.openBlock({ openCount: 3, max: 3 })).toBe('DISPUTE_LIMIT');
  });
});

describe('M17 windows and SLAs (Q95)', () => {
  it('adds hours', () => expect(r.after(T0, 48)).toEqual(at(48)));

  it('reminds the respondent once, inside the last hours', () => {
    const base = { status: 'awaiting_response', respondentDueAt: at(48), remindedAt: null, hours: 12 };
    expect(r.reminderDue({ ...base, now: at(35) })).toBe(false);
    expect(r.reminderDue({ ...base, now: at(36) })).toBe(true);
    expect(r.reminderDue({ ...base, now: at(48) })).toBe(false); // the deadline itself is a timeout
    expect(r.reminderDue({ ...base, remindedAt: at(37), now: at(40) })).toBe(false);
    expect(r.reminderDue({ ...base, status: 'under_review', now: at(40) })).toBe(false);
    expect(r.reminderDue({ ...base, respondentDueAt: null, now: at(40) })).toBe(false);
  });

  it('times out an unanswered respondent at the deadline', () => {
    expect(r.respondentTimedOut({ status: 'awaiting_response', respondentDueAt: at(48), now: at(48) })).toBe(true);
    expect(r.respondentTimedOut({ status: 'awaiting_response', respondentDueAt: at(48), now: at(47) })).toBe(false);
    expect(r.respondentTimedOut({ status: 'under_review', respondentDueAt: at(48), now: at(50) })).toBe(false);
    expect(r.respondentTimedOut({ status: 'awaiting_response', respondentDueAt: null, now: at(50) })).toBe(false);
  });

  it('breaches the staff SLA, then the master SLA, once each', () => {
    const staff = { status: 'under_review', slaDueAt: at(72), masterDueAt: null, breachedAt: null };
    expect(r.slaBreach({ ...staff, now: at(71) })).toBeNull();
    expect(r.slaBreach({ ...staff, now: at(72) })).toBe('staff');
    expect(r.slaBreach({ ...staff, breachedAt: at(72), now: at(80) })).toBeNull();
    expect(r.slaBreach({ ...staff, breachedAt: at(10), now: at(80) })).toBe('staff'); // an older breach (sent back with a new SLA)
    expect(r.slaBreach({ ...staff, slaDueAt: null, now: at(80) })).toBeNull();
    const master = { status: 'escalated', slaDueAt: at(72), masterDueAt: at(120), breachedAt: at(72) };
    expect(r.slaBreach({ ...master, now: at(119) })).toBeNull();
    expect(r.slaBreach({ ...master, now: at(120) })).toBe('master');
    expect(r.slaBreach({ ...master, breachedAt: at(121), now: at(130) })).toBeNull();
    expect(r.slaBreach({ ...master, masterDueAt: null, now: at(130) })).toBeNull();
    expect(r.slaBreach({ status: 'resolved', slaDueAt: at(1), masterDueAt: at(1), breachedAt: null, now: at(200) })).toBeNull();
  });
});

describe('M17 desk claims', () => {
  it('holds a claim until it expires, and only for its holder', () => {
    const c = { claimedBy: 'a', claimExpiresAt: at(1) };
    expect(r.claimHeld({ ...c, now: T0 })).toBe(true);
    expect(r.claimHeld({ ...c, now: at(1) })).toBe(false);
    expect(r.claimHeld({ claimedBy: null, claimExpiresAt: at(1), now: T0 })).toBe(false);
    expect(r.claimHeld({ claimedBy: 'a', claimExpiresAt: null, now: T0 })).toBe(false);
    expect(r.claimBlock({ ...c, actorId: 'a', now: T0 })).toBeNull();
    expect(r.claimBlock({ ...c, actorId: 'b', now: T0 })).toBe('CLAIMED_BY_OTHER');
    expect(r.claimBlock({ ...c, actorId: 'b', now: at(2) })).toBeNull();
    expect(r.claimExpiry(T0, 30)).toEqual(new Date(T0.getTime() + 30 * 60000));
  });
});

describe('M17 outcomes and money (the ৳500 retained example)', () => {
  it('lists the outcomes per kind of case (Q96: cash cases are findings only)', () => {
    expect(r.allowedOutcomes({ sourceType: 'booking', money: true })).toEqual(['all', 'half', 'none', 'custom']);
    expect(r.allowedOutcomes({ sourceType: 'booking', money: false })).toEqual(['upheld', 'rejected']);
    expect(r.allowedOutcomes({ sourceType: 'esports_result', money: false })).toEqual(['corrected', 'rejected']);
  });

  it('refunds all, half (floored), none or a custom amount', () => {
    expect(r.outcomeRefund({ outcome: 'all', held: 50000 })).toBe(50000);
    expect(r.outcomeRefund({ outcome: 'half', held: 50001 })).toBe(25000);
    expect(r.outcomeRefund({ outcome: 'none', held: 50000 })).toBe(0);
    expect(r.outcomeRefund({ outcome: 'upheld', held: 0 })).toBe(0);
    expect(r.outcomeRefund({ outcome: 'custom', held: 50000, custom: 12345 })).toBe(12345);
    expect(r.outcomeRefund({ outcome: 'custom', held: 50000, custom: 0 })).toBe(0);
    expect(() => r.outcomeRefund({ outcome: 'custom', held: 50000, custom: 50001 })).toThrow(RangeError);
    expect(() => r.outcomeRefund({ outcome: 'custom', held: 50000, custom: -1 })).toThrow(RangeError);
    expect(() => r.outcomeRefund({ outcome: 'custom', held: 50000, custom: 1.5 })).toThrow(RangeError);
    expect(() => r.outcomeRefund({ outcome: 'custom', held: 50000 })).toThrow(RangeError);
  });

  it('settles a no-show advance: all → ৳500 back; half → ৳250 back, owner ৳237.50, fee ৳12.50; none → ৳475 / ৳25', () => {
    const base = { held: 50000, feeBps: 500 };
    expect(r.outcomePlan({ ...base, outcome: 'all' })).toEqual({ refund: 50000, release: 0, feeBase: 0, fee: 0, net: 0 });
    expect(r.outcomePlan({ ...base, outcome: 'half' })).toEqual({ refund: 25000, release: 25000, feeBase: 25000, fee: 1250, net: 23750 });
    expect(r.outcomePlan({ ...base, outcome: 'none' })).toEqual({ refund: 0, release: 50000, feeBase: 50000, fee: 2500, net: 47500 });
    expect(r.outcomePlan({ ...base, outcome: 'custom', custom: 10000 })).toEqual({ refund: 10000, release: 40000, feeBase: 40000, fee: 2000, net: 38000 });
  });

  it('settles a started booking: nothing back is a normal check-in release (fee on the full ৳2,000 value)', () => {
    const base = { held: 50000, feeBps: 500, fullPrice: 200000 };
    expect(r.outcomePlan({ ...base, outcome: 'none' })).toEqual({ refund: 0, release: 50000, feeBase: 200000, fee: 10000, net: 40000 });
    expect(r.outcomePlan({ ...base, outcome: 'half' })).toEqual({ refund: 25000, release: 25000, feeBase: 25000, fee: 1250, net: 23750 });
    expect(() => r.outcomePlan({ held: 1000, feeBps: 500, fullPrice: 200000, outcome: 'none' })).toThrow(RangeError);
  });

  it('caps the fee base at the items subtotal on a sub-order (M13: no commission on delivery)', () => {
    // ৳5,200 items + ৳80 delivery held; 5%.
    const base = { held: 528000, feeBps: 500, feeBaseMax: 520000 };
    expect(r.outcomePlan({ ...base, outcome: 'none' })).toEqual({ refund: 0, release: 528000, feeBase: 520000, fee: 26000, net: 502000 });
    expect(r.outcomePlan({ ...base, outcome: 'half' })).toEqual({ refund: 264000, release: 264000, feeBase: 264000, fee: 13200, net: 250800 });
    expect(r.outcomePlan({ ...base, outcome: 'all' })).toEqual({ refund: 528000, release: 0, feeBase: 0, fee: 0, net: 0 });
  });

  it('moves nothing on a findings-only case', () => expect(r.outcomePlan({ outcome: 'upheld', held: 0, feeBps: 500 })).toEqual({ refund: 0, release: 0, feeBase: 0, fee: 0, net: 0 }));
});

describe('M17 decision authority (§6.3)', () => {
  const dispute = { claimantId: 'm', respondentId: 'o', status: 'under_review', claimedBy: 's', claimExpiresAt: at(1) };
  const staff = { id: 's', isMaster: false, canRefund: true };
  const decide = (over = {}) => r.decideBlock({ actor: staff, dispute, refund: 50000, staffLimit: 1000000, now: T0, asMaster: false, ...over });

  it('never lets a party decide', () => {
    expect(decide({ actor: { ...staff, id: 'm' } })).toBe('CONFLICT_OF_INTEREST');
    expect(decide({ actor: { ...staff, id: 'o' } })).toBe('CONFLICT_OF_INTEREST');
    expect(r.decideBlock({ actor: { id: 'x', isMaster: true }, dispute: { ...dispute, respondentId: null }, refund: 0, staffLimit: 0, now: T0, asMaster: true })).toBeNull();
  });

  it('lets claimed staff decide within the limit with refund_small', () => {
    expect(decide()).toBeNull();
    expect(decide({ refund: 0, actor: { ...staff, canRefund: false } })).toBeNull();
    expect(decide({ actor: { ...staff, canRefund: false } })).toBe('REFUND_PERMISSION_REQUIRED');
    expect(decide({ refund: 1000001 })).toBe('ESCALATION_REQUIRED');
    expect(decide({ dispute: { ...dispute, status: 'escalated' } })).toBe('DISPUTE_STATE');
    expect(decide({ dispute: { ...dispute, claimedBy: 'other' } })).toBe('CLAIM_REQUIRED');
    expect(decide({ now: at(2) })).toBe('CLAIM_REQUIRED');
  });

  it('lets masters decide cases under review or escalated', () => {
    expect(decide({ asMaster: true })).toBe('MASTER_REQUIRED');
    const master = { id: 'x', isMaster: true };
    expect(decide({ asMaster: true, actor: master, dispute: { ...dispute, status: 'escalated' }, refund: 5000000 })).toBeNull();
    expect(decide({ asMaster: true, actor: master, dispute: { ...dispute, status: 'awaiting_response' } })).toBe('DISPUTE_STATE');
  });
});

describe('M17 reports (Q99)', () => {
  it('counts only NID-verified reporters with old enough accounts', () => {
    expect(r.eligibleReporter({ memberActive: true, accountCreatedAt: at(-7 * 24), now: T0, minDays: 7 })).toBe(true);
    expect(r.eligibleReporter({ memberActive: true, accountCreatedAt: at(-7 * 24 + 1), now: T0, minDays: 7 })).toBe(false);
    expect(r.eligibleReporter({ memberActive: false, accountCreatedAt: at(-100 * 24), now: T0, minDays: 7 })).toBe(false);
  });

  it('fires once when the count crosses the threshold', () => {
    expect(r.thresholdCrossed({ before: 2, after: 3, threshold: 3 })).toBe(true);
    expect(r.thresholdCrossed({ before: 3, after: 4, threshold: 3 })).toBe(false);
    expect(r.thresholdCrossed({ before: 1, after: 2, threshold: 3 })).toBe(false);
  });

  it('allows each action only on its subjects', () => {
    expect(r.resolutionAllowed('review', 'content_removed')).toBe(true);
    expect(r.resolutionAllowed('user', 'content_removed')).toBe(false);
    expect(r.resolutionAllowed('booking', 'converted_to_dispute')).toBe(true);
    expect(Object.keys(r.RESOLUTIONS)).toEqual(['ground', 'booking', 'user', 'review', 'esports_tournament', 'shop', 'product']);
    expect(r.resolutionAllowed('product', 'content_removed')).toBe(true); // M12: a reported product can be taken down
  });
});

describe('M17 reviews (Q98)', () => {
  const played = { isBooker: true, status: 'completed', endAt: T0, windowDays: 30 };

  it('lets the booker rate a played booking inside the window', () => {
    expect(r.reviewBlock({ ...played, now: at(1) })).toBeNull();
    expect(r.reviewBlock({ ...played, status: 'checked_in', now: at(1) })).toBeNull();
    expect(r.reviewBlock({ ...played, isBooker: false, now: at(1) })).toBe('NOT_YOUR_BOOKING');
    expect(r.reviewBlock({ ...played, status: 'no_show', now: at(1) })).toBe('NOT_PLAYED');
    expect(r.reviewBlock({ ...played, status: 'checked_in', now: at(-1) })).toBe('NOT_PLAYED');
    expect(r.reviewBlock({ ...played, now: at(30 * 24 + 1) })).toBe('REVIEW_WINDOW_CLOSED');
  });

  it('allows edits until the edit window ends, never on a hidden review', () => {
    expect(r.editBlock({ status: 'published', editUntil: at(1), now: T0 })).toBeNull();
    expect(r.editBlock({ status: 'published', editUntil: at(1), now: at(2) })).toBe('REVIEW_EDIT_CLOSED');
    expect(r.editBlock({ status: 'hidden', editUntil: at(1), now: T0 })).toBe('REVIEW_HIDDEN');
  });

  it('holds text with links or phone numbers (Latin or Bangla digits)', () => {
    expect(r.contentFlag(null)).toBeNull();
    expect(r.contentFlag('Great turf, friendly staff')).toBeNull();
    expect(r.contentFlag('book direct at https://example.com')).toBe('content');
    expect(r.contentFlag('see turfdeals.bd')).toBe('content');
    expect(r.contentFlag('call 01711223344')).toBe('content');
    expect(r.contentFlag('call ০১৭১১২২৩৩৪৪')).toBe('content');
    expect(r.contentFlag('call 017 112 23344')).toBe('content');
  });

  it('starts held during a dispute or for content, otherwise published', () => {
    expect(r.initialReview({ disputeActive: true, text: 'fine' })).toEqual({ status: 'held', heldReason: 'dispute' });
    expect(r.initialReview({ disputeActive: false, text: 'www.x.com' })).toEqual({ status: 'held', heldReason: 'content' });
    expect(r.initialReview({ disputeActive: false, text: 'fine' })).toEqual({ status: 'published', heldReason: null });
  });

  it('aggregates the histogram and shows the average from the minimum count', () => {
    expect(r.aggregate([0, 0, 0, 0, 0], 3)).toEqual({ count: 0, sum: 0, avg: null, display: null });
    expect(r.aggregate([0, 0, 0, 1, 1], 3)).toEqual({ count: 2, sum: 9, avg: 4.5, display: null });
    expect(r.aggregate([1, 0, 1, 0, 1], 3)).toEqual({ count: 3, sum: 9, avg: 3, display: 3 });
    expect(r.aggregate([0, 0, 1, 1, 1], 3).avg).toBe(4);
    expect(r.aggregate([0, 1, 0, 0, 2], 3).avg).toBe(4); // 12 / 3
    expect(r.aggregate([0, 0, 0, 2, 1], 1).avg).toBe(4.33);
  });
});
