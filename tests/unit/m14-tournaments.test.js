'use strict';

// M14 tournament rules (§6.1, §6.8, §6.9, §8): 100% coverage gate.
const R = require('../../src/modules/tournaments/tournaments.rules');
const { feeOf } = require('../../src/common/money');

describe('M14 tournaments.rules: state machines', () => {
  it('moves tournaments, registrations and matches only along §8', () => {
    expect(R.can(R.TOURNAMENT, 'draft', 'pending_review')).toBe(true);
    expect(R.can(R.TOURNAMENT, 'pending_review', 'registration_open')).toBe(true);
    expect(R.can(R.TOURNAMENT, 'registration_closed', 'registration_open')).toBe(true);
    expect(R.can(R.TOURNAMENT, 'live', 'completed')).toBe(true);
    expect(R.can(R.TOURNAMENT, 'completed', 'cancelled')).toBe(false);
    expect(R.can(R.TOURNAMENT, 'draft', 'live')).toBe(false);
    expect(R.can(R.TOURNAMENT, 'nonsense', 'live')).toBe(false);
    expect(R.can(R.REGISTRATION, 'reserve', 'offered')).toBe(true);
    expect(R.can(R.REGISTRATION, 'offered', 'pending_approval')).toBe(true);
    expect(R.can(R.REGISTRATION, 'approved', 'removed')).toBe(true);
    expect(R.can(R.REGISTRATION, 'rejected', 'approved')).toBe(false);
    expect(R.can(R.MATCH, 'scheduled', 'walkover')).toBe(true);
    expect(R.can(R.MATCH, 'abandoned', 'no_result')).toBe(true);
    expect(R.can(R.MATCH, 'completed', 'scheduled')).toBe(false);
  });

  it('counts places and the registration window', () => {
    expect(R.HOLDING).toContain('offered');
    expect(R.LIVE).toContain('reserve');
    expect(R.placeFree(7, 8)).toBe(true);
    expect(R.placeFree(8, 8)).toBe(false);
    const t = { status: 'registration_open', registrationOpensAt: '2026-11-01T00:00:00Z', registrationClosesAt: '2026-11-10T00:00:00Z' };
    expect(R.registrationWindow(t, new Date('2026-10-31T00:00:00Z'))).toBe('not_yet');
    expect(R.registrationWindow(t, new Date('2026-11-05T00:00:00Z'))).toBe('open');
    expect(R.registrationWindow(t, new Date('2026-11-10T00:00:00Z'))).toBe('closed');
    expect(R.registrationWindow({ ...t, status: 'draft' }, new Date('2026-11-05T00:00:00Z'))).toBe('closed');
  });
});

describe('M14 tournaments.rules: money', () => {
  const base = { paid: 1800000, available: 900000, closed: false, firstResult: false, afterClosePct: 50 };

  it('follows the refund table (§6.9)', () => {
    expect(R.refundAmount({ ...base, reason: 'rejected' })).toBe(1800000);
    expect(R.refundAmount({ ...base, reason: 'withdrawn' })).toBe(1800000);
    expect(R.refundAmount({ ...base, reason: 'withdrawn', closed: true })).toBe(900000);
    expect(R.refundAmount({ ...base, reason: 'withdrawn', closed: true, firstResult: true })).toBe(0);
    expect(R.refundAmount({ ...base, reason: 'removed' })).toBe(1800000);
    expect(R.refundAmount({ ...base, reason: 'removed', firstResult: true })).toBe(0);
    expect(R.refundAmount({ ...base, reason: 'cancelled' })).toBe(1800000);
    expect(R.refundAmount({ ...base, reason: 'cancelled', firstResult: true })).toBe(900000);
    expect(R.refundAmount({ ...base, paid: 0, reason: 'rejected' })).toBe(0);
    expect(R.refundAmount({ ...base, paid: 1500, reason: 'withdrawn', closed: true })).toBe(750);
  });

  it('releases the worked example: 6 × ৳18,000, 50% then the rest, 5% each time', () => {
    const hold = { held: 1800000, released: 0, refunded: 0 };
    const first = R.trancheAmount(hold, 50);
    expect(first).toBe(900000);
    const afterFirst = { ...hold, released: first };
    const second = R.trancheAmount(afterFirst, 100);
    expect(second).toBe(900000);
    const feeBps = 500;
    const totalFirst = 6 * first;
    expect(totalFirst).toBe(5400000); // ৳54,000
    expect(6 * (first - feeOf(first, feeBps))).toBe(5130000); // ৳51,300 to the organiser
    expect(6 * (feeOf(first, feeBps) + feeOf(second, feeBps))).toBe(540000); // ৳5,400 fee
    expect(R.trancheAmount(afterFirst, 50)).toBe(0); // tranche 1 again: nothing more
    expect(R.trancheAmount({ held: 1800000, released: 0, refunded: 1500000 }, 50)).toBe(300000); // capped by what is left
    expect(R.trancheAmount({ held: 1001, released: 0, refunded: 0 }, 50)).toBe(500);
  });
});

describe('M14 tournaments.rules: checks', () => {
  const dates = { registrationOpensAt: '2026-10-20T00:00:00Z', registrationClosesAt: '2026-11-04T18:00:00Z', startDate: '2026-11-07', endDate: '2026-11-21' };
  const cfg = { closeDays: 2, minStartDays: 3, today: '2026-10-18' };

  it('checks dates', () => {
    expect(R.datesBlock(dates, cfg)).toBeNull();
    expect(R.datesBlock({ ...dates, endDate: null }, cfg)).toBe('DATES_MISSING');
    expect(R.datesBlock({ ...dates, registrationClosesAt: '2026-10-19T00:00:00Z' }, cfg)).toBe('REGISTRATION_WINDOW_INVALID');
    expect(R.datesBlock({ ...dates, registrationClosesAt: '2026-11-05T18:00:01Z' }, cfg)).toBe('REGISTRATION_CLOSES_TOO_LATE');
    expect(R.datesBlock({ ...dates, registrationClosesAt: '2026-11-04T18:00:00Z' }, cfg)).toBeNull(); // 5 Nov 00:00 Dhaka, two days before
    expect(R.datesBlock({ ...dates, endDate: '2026-11-06' }, cfg)).toBe('END_BEFORE_START');
    expect(R.datesBlock({ ...dates, registrationClosesAt: '2026-10-16T00:00:00Z', registrationOpensAt: '2026-10-15T00:00:00Z', startDate: '2026-10-20', endDate: '2026-10-21' }, cfg)).toBe('START_TOO_SOON');
  });

  it('checks squads, prizes and rosters', () => {
    expect(R.squadBlock({ squadMin: 11, squadMax: 16 }, 11)).toBeNull();
    expect(R.squadBlock({ squadMin: 10, squadMax: 16 }, 11)).toBe('SQUAD_LIMITS_INVALID');
    expect(R.squadBlock({ squadMin: 1, squadMax: 2 }, undefined)).toBeNull();
    expect(R.squadBlock({ squadMin: 0, squadMax: 2 }, null)).toBe('SQUAD_LIMITS_INVALID');
    expect(R.squadBlock({ squadMin: 11, squadMax: 31 }, 11)).toBe('SQUAD_LIMITS_INVALID');
    expect(R.squadBlock({ squadMin: 12, squadMax: 11 }, 11)).toBe('SQUAD_LIMITS_INVALID');
    expect(R.prizeBlock({ prizePoolPoisha: null, prizeSplit: [] })).toBeNull();
    expect(R.prizeBlock({ prizePoolPoisha: null })).toBeNull();
    expect(R.prizeBlock({ prizePoolPoisha: 0, prizeSplit: [{ label: '1st', pct: 100 }] })).toBe('PRIZE_SPLIT_WITHOUT_POOL');
    expect(R.prizeBlock({ prizePoolPoisha: 5000000, prizeSplit: [] })).toBeNull();
    expect(R.prizeBlock({ prizePoolPoisha: 5000000, prizeSplit: [{ label: '1st', pct: 60 }, { label: '2nd', pct: 40 }] })).toBeNull();
    expect(R.prizeBlock({ prizePoolPoisha: 5000000, prizeSplit: [{ label: '1st', pct: 60 }, { label: '2nd', pct: 30 }] })).toBe('PRIZE_SPLIT_INVALID');
    expect(R.prizeBlock({ prizePoolPoisha: 5000000, prizeSplit: [{ label: '1st', pct: 100 }, { label: '2nd', pct: 0 }] })).toBe('PRIZE_SPLIT_INVALID');
    expect(R.rosterBlock(10, { squadMin: 11, squadMax: 16 })).toBe('SQUAD_TOO_SMALL');
    expect(R.rosterBlock(17, { squadMin: 11, squadMax: 16 })).toBe('SQUAD_TOO_LARGE');
    expect(R.rosterBlock(14, { squadMin: 11, squadMax: 16 })).toBeNull();
  });

  it('lists the submission checks (§6.1)', () => {
    const ok = { orgVerified: true, payoutReady: false, feePoisha: 0, rulesError: null, datesError: null, formatError: null, squadError: null, prizeError: null, venues: 1, feeMax: 20000000 };
    expect(R.submissionChecks(ok).every((c) => c.result === 'pass')).toBe(true);
    const bad = R.submissionChecks({ ...ok, orgVerified: false, feePoisha: 30000000, rulesError: 'RULE_OUT_OF_RANGE', datesError: 'X', squadError: 'Y', prizeError: 'Z', venues: 0 });
    expect(bad.filter((c) => c.result === 'fail').map((c) => c.key)).toEqual(['org_verified', 'payout_account', 'rules_valid', 'dates_consistent', 'capacity_valid', 'prize_split_valid', 'venue_present', 'fee_in_range']);
    expect(bad.find((c) => c.key === 'fee_in_range').severity).toBe('soft');
    expect(R.submissionChecks({ ...ok, feePoisha: 100, payoutReady: true }).find((c) => c.key === 'payout_account').result).toBe('pass');
    expect(R.submissionChecks({ ...ok, formatError: 'GROUPS_INVALID' }).find((c) => c.key === 'capacity_valid').result).toBe('fail');
  });
});
