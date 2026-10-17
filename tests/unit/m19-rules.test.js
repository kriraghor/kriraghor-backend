'use strict';

// M19 periods and buckets on the Dhaka calendar (FR-02 to FR-05), deltas (FR-04), sums (FR-06) and the
// KPI formulas (§6): earned under v3 (the ৳2,000 example), occupancy, repeat teams, GTV and take rate.
const A = require('../../src/modules/analytics/analytics.rules');

describe('M19 Dhaka calendar and periods', () => {
  it('days, weeks and months', () => {
    expect(A.dhakaDate('2026-10-18T17:59:00Z')).toBe('2026-10-18');
    expect(A.dhakaDate('2026-10-18T18:00:00Z')).toBe('2026-10-19');
    expect(A.addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(A.daysBetween('2026-10-01', '2026-11-01')).toBe(31);
    expect(A.weekStart('2026-10-18')).toBe('2026-10-12'); // Sunday → the Monday before
    expect(A.weekStart('2026-10-19')).toBe('2026-10-19'); // Monday
    expect(A.weekStart('2026-10-18', 'sat')).toBe('2026-10-17');
    expect(A.monthStart('2026-10-18')).toBe('2026-10-01');
    expect(A.addMonths('2026-01-01', -1)).toBe('2025-12-01');
    expect(A.isPeriod('7w')).toBe(true);
    expect(A.isPeriod('week')).toBe(false);
  });

  it('7 weeks, a quarter (13 weeks) and a year (12 months), oldest first', () => {
    const w = A.buckets('7w', '2026-10-21');
    expect(w).toHaveLength(7);
    expect(w[6]).toEqual({ key: '2026-10-19', from: '2026-10-19', to: '2026-10-26' });
    expect(w[0].from).toBe('2026-09-07');
    expect(A.buckets('qtr', '2026-10-21')).toHaveLength(13);
    const y = A.buckets('yr', '2026-10-21');
    expect(y).toHaveLength(12);
    expect(y[11]).toEqual({ key: '2026-10', from: '2026-10-01', to: '2026-11-01' });
    expect(y[0].key).toBe('2025-11');
  });

  it('last year: 52 weeks or 12 months back (FR-05)', () => {
    expect(A.lastYear('7w', A.buckets('7w', '2026-10-21'))[6]).toEqual({ key: '2026-10-19', from: '2025-10-20', to: '2025-10-27' });
    expect(A.lastYear('yr', A.buckets('yr', '2026-10-21'))[11]).toMatchObject({ from: '2025-10-01', to: '2025-11-01' });
  });

  it('compares the same elapsed part of the previous bucket (FR-04)', () => {
    // Wednesday: Mon–Wed this week against Mon–Wed last week.
    expect(A.comparable(A.buckets('7w', '2026-10-21'), '2026-10-21')).toEqual({ current: { from: '2026-10-19', to: '2026-10-22' }, previous: { from: '2026-10-12', to: '2026-10-15' } });
    // 31 October against 30 days of September (the shorter month caps it).
    expect(A.comparable(A.buckets('yr', '2026-10-31'), '2026-10-31')).toEqual({ current: { from: '2026-10-01', to: '2026-11-01' }, previous: { from: '2026-09-01', to: '2026-10-01' } });
  });

  it('deltas: percent for amounts and counts, points for rates', () => {
    expect(A.delta(150, 100)).toBe(50);
    expect(A.delta(50, 100, 'count')).toBe(-50);
    expect(A.delta(5, 0)).toBeNull();
    expect(A.delta(null, 3)).toBeNull();
    expect(A.delta(0.62, 0.5, 'rate')).toBe(12);
  });

  it('buckets day rows and windows (FR-03)', () => {
    const rows = [
      { day: '2026-10-13', earned: 200000 },
      { day: '2026-10-19', earned: 50000 },
      { day: '2026-10-20', earned: 100000, extra: 1 },
    ];
    const b = A.bucketize(rows, A.buckets('7w', '2026-10-21').slice(5), ['earned', 'extra']);
    expect(b).toEqual([
      { key: '2026-10-12', from: '2026-10-12', earned: 200000, extra: 0 },
      { key: '2026-10-19', from: '2026-10-19', earned: 150000, extra: 1 },
    ]);
    expect(A.sumWindow(rows, { from: '2026-10-19', to: '2026-10-20' }, 'earned')).toBe(50000);
    expect(A.sumWindow(rows, { from: '2026-10-19', to: '2026-10-21' }, 'missing')).toBe(0);
  });
});

describe('M19 KPI formulas (§6, v3)', () => {
  // ৳2,000 booking, ৳500 advance.
  it('earned: played → the total; member cancel or no-show → the retained advance; otherwise nothing', () => {
    expect(A.earned({ status: 'completed', total: 200000, retained: 0 })).toBe(200000);
    expect(A.earned({ status: 'checked_in', total: 300000, retained: 0 })).toBe(300000);
    expect(A.earned({ status: 'cancelled', total: 200000, retained: 50000 })).toBe(50000);
    expect(A.earned({ status: 'no_show', total: 200000, retained: 50000 })).toBe(50000);
    for (const status of ['confirmed', 'cancelled_by_owner', 'cancelled_by_platform', 'expired', 'pending_payment', 'skipped']) expect(A.earned({ status, total: 200000, retained: 0 })).toBe(0);
    expect([...A.COUNTED]).toEqual(['confirmed', 'checked_in', 'completed', 'no_show']);
  });

  it('bookers, occupancy, repeat teams', () => {
    expect(A.bookerKey({ bookerUserId: 'u1', seriesId: 's1', bookingId: 'b1' })).toBe('user:u1');
    expect(A.bookerKey({ bookerUserId: null, seriesId: 's1', bookingId: 'b1' })).toBe('series:s1');
    expect(A.bookerKey({ bookerUserId: null, seriesId: null, bookingId: 'b1' })).toBe('walkin:b1');
    expect(A.occupancy(13, 34)).toBe(0.382);
    expect(A.occupancy(0, 0)).toBeNull();
    expect(A.repeatShare({ a: 3, b: 1, c: 2, d: 1 })).toBe(0.5);
    expect(A.repeatShare({})).toBeNull();
  });

  it('GTV includes venue money (Q106); take rate; charts add up to the tile', () => {
    expect(A.gtv({ online: 50000, venue: 150000 })).toBe(200000);
    expect(A.takeRate(10000, 200000)).toBe(0.05);
    expect(A.takeRate(100, 0)).toBeNull();
    expect(A.addsUp([1, 2, 3], 6)).toBe(true);
    expect(A.addsUp([1, 2], 6)).toBe(false);
  });
});
