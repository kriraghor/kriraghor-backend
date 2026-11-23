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

  it('30 days: one bucket a day, today last; a year back keeps the weekday (dashboards round 2)', () => {
    expect(A.isPeriod('30d')).toBe(true);
    const d = A.buckets('30d', '2026-11-21');
    expect(d).toHaveLength(30);
    expect(d[29]).toEqual({ key: '2026-11-21', from: '2026-11-21', to: '2026-11-22' });
    expect(d[0]).toEqual({ key: '2026-10-23', from: '2026-10-23', to: '2026-10-24' });
    expect(A.lastYear('30d', d)[29]).toEqual({ key: '2026-11-21', from: '2025-11-22', to: '2025-11-23' });
  });

  it('30 days compare the whole period with the 30 days before; the headline is the whole period', () => {
    const d = A.buckets('30d', '2026-11-21');
    expect(A.comparable(d, '2026-11-21')).toEqual({ current: { from: '2026-10-23', to: '2026-11-22' }, previous: { from: '2026-09-23', to: '2026-10-23' } });
    expect(A.headline(d)).toEqual({ from: '2026-10-23', to: '2026-11-22' });
    // Weeks and months: the headline is the last bucket.
    expect(A.headline(A.buckets('7w', '2026-10-21'))).toEqual({ from: '2026-10-19', to: '2026-10-26' });
    expect(A.headline(A.buckets('yr', '2026-10-21'))).toEqual({ from: '2026-10-01', to: '2026-11-01' });
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

describe('M19 Round B2 KPI helpers (§6.3 shops, gyms, organisers)', () => {
  it('counted sub-orders: placed and not given back', () => {
    expect([...A.SHOP_COUNTED]).toEqual(['placed', 'accepted', 'shipped', 'delivered', 'completed', 'disputed']);
    for (const s of ['pending_payment', 'rejected', 'expired', 'cancelled', 'refunded']) expect(A.SHOP_COUNTED.has(s)).toBe(false);
  });

  it('average order: whole poisha, half up; null without orders (Sales / Orders reconciles)', () => {
    expect(A.average(500000, 2)).toBe(250000);
    expect(A.average(100001, 2)).toBe(50001); // 50,000.5 → 50,001
    expect(A.average(100000, 3)).toBe(33333);
    expect(A.average(0, 0)).toBeNull();
    expect(A.average(5, -1)).toBeNull();
  });

  it('unused share of ended passes: three places; null when nothing ended', () => {
    expect(A.share(1, 3)).toBe(0.333);
    expect(A.share(0, 4)).toBe(0);
    expect(A.share(2, 2)).toBe(1);
    expect(A.share(1, 0)).toBeNull();
  });

  it('Dhaka hours and the days of a bucket', () => {
    expect(A.dhakaHour('2026-10-22T00:30:00Z')).toBe(6);
    expect(A.dhakaHour('2026-10-21T18:10:00Z')).toBe(0);
    expect(A.dhakaHour(new Date('2026-10-22T17:59:00Z'))).toBe(23);
    expect(A.daysOf({ from: '2026-10-19', to: '2026-10-26' })).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
    expect(A.daysOf({ from: '2026-10-01', to: '2026-10-01' })).toEqual([]);
  });

  it('top rows: largest first, ties by key (numbers as numbers, text as text)', () => {
    const hours = [{ hour: 9, n: 2 }, { hour: 10, n: 2 }, { hour: 18, n: 5 }, { hour: 7, n: 1 }];
    expect(A.top(hours, 'n', 3, 'hour').map((h) => h.hour)).toEqual([18, 9, 10]);
    const products = [{ title: 'Shin guard', units: 3 }, { title: 'Boots', units: 3 }, { title: 'Ball', units: 7 }];
    expect(A.top(products, 'units', 10, 'title').map((p) => p.title)).toEqual(['Ball', 'Boots', 'Shin guard']);
    expect(hours.map((h) => h.hour)).toEqual([9, 10, 18, 7]); // the input is not reordered
  });

  it('organiser totals: teams of running events, matches and money of all (M14 §4.1)', () => {
    const money = (collected, held, released, refunded) => ({ collected, held, released, refunded, fees: 0 });
    const t = A.organiserTotals([
      { status: 'registration_open', maxTeams: 8, approved: 3, waiting: 2, unpaid: 1, reserve: 0, matches: 0, played: 0, money: money(7200000, 7200000, 0, 0) },
      { status: 'live', maxTeams: 4, approved: 4, waiting: 0, unpaid: 0, reserve: 1, matches: 6, played: 2, money: money(7200000, 3420000, 3420000, 360000) },
      { status: 'completed', maxTeams: 6, approved: 6, waiting: 0, unpaid: 0, reserve: 0, matches: 15, played: 15, money: money(10800000, 0, 10800000, 0) },
      { status: 'cancelled', maxTeams: 4, approved: 2, waiting: 1, unpaid: 0, reserve: 0, matches: 0, played: 0, money: money(3600000, 0, 0, 3600000) },
    ]);
    expect(t).toEqual({ approved: 7, maxTeams: 12, waiting: 2, unpaid: 1, reserve: 1, matches: 21, played: 17, collected: 28800000, held: 10620000, released: 14220000, refunded: 3960000 });
    expect([...A.RUNNING]).toEqual(['registration_open', 'registration_closed', 'live']);
    expect(A.organiserTotals([])).toMatchObject({ approved: 0, collected: 0 });
  });
});
