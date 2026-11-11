'use strict';

// M20 holidays and special hours (M20-FR-16 to FR-22) and the M27 conversion report (M27-FR-87 to FR-91):
// the pure rules, every branch. Dates are Dhaka calendar dates.
const gym = require('../../src/modules/gym/gym.rules');
const manage = require('../../src/modules/gym-manage/gym-manage.rules');
const ops = require('../../src/modules/gym-ops/gym-ops.rules');

const WEEK = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, openTime: '06:00', closeTime: '22:00', womenOnly: false }));
const eid = { fromOn: '2026-11-20', toOn: '2026-11-22', kind: 'closed', windows: [], title: 'Eid-ul-Fitr' };
const ramadan = { fromOn: '2026-12-01', toOn: '2026-12-10', kind: 'hours', windows: [{ openTime: '20:00', closeTime: '24:00', womenOnly: false }, { openTime: '05:00', closeTime: '09:00', womenOnly: true }], title: 'Ramadan timings' };
const at = (date, hhmm) => new Date(`${date}T${hhmm}:00+06:00`);

describe('the opening windows of a date (M20-FR-18)', () => {
  it('uses the week when no special day covers the date', () => {
    expect(gym.specialOn([eid, ramadan], '2026-11-19')).toBeNull();
    expect(gym.windowsFor(WEEK, [eid, ramadan], '2026-11-19')).toEqual([WEEK[4]]);
    expect(gym.windowsFor(WEEK, [], '2026-11-21')).toEqual([WEEK[6]]);
  });

  it('is closed on a holiday, from its first to its last day', () => {
    for (const d of ['2026-11-20', '2026-11-21', '2026-11-22']) expect(gym.windowsFor(WEEK, [eid], d)).toEqual([]);
    expect(gym.windowsFor(WEEK, [eid], '2026-11-23')).toHaveLength(1);
  });

  it('uses the special windows on a day with changed hours, earliest first', () => {
    expect(gym.windowsFor(WEEK, [ramadan], '2026-12-05').map((w) => w.openTime)).toEqual(['05:00', '20:00']);
  });

  it('answers open now from the special day before the week', () => {
    expect(gym.openWindowAt(WEEK, at('2026-11-21', '10:00'))).toMatchObject({ openTime: '06:00' });
    expect(gym.openWindowAt(WEEK, at('2026-11-21', '10:00'), [eid])).toBeNull();
    expect(gym.openWindowAt(WEEK, at('2026-12-05', '10:00'), [ramadan])).toBeNull();
    expect(gym.openWindowAt(WEEK, at('2026-12-05', '21:30'), [ramadan])).toMatchObject({ openTime: '20:00' });
    expect(gym.openWindowAt(WEEK, at('2026-12-05', '23:59'), [ramadan])).toMatchObject({ closeTime: '24:00' });
  });

  it('tells a time inside the windows from one outside', () => {
    expect(gym.insideWindows(ramadan.windows, '05:00')).toBe(true);
    expect(gym.insideWindows(ramadan.windows, '09:00')).toBe(false);
    expect(gym.insideWindows([], '10:00')).toBe(false);
  });

  it('places a special day before, in or after today', () => {
    expect(gym.specialPhase(eid, '2026-11-19')).toBe('upcoming');
    expect(gym.specialPhase(eid, '2026-11-20')).toBe('running');
    expect(gym.specialPhase(eid, '2026-11-22')).toBe('running');
    expect(gym.specialPhase(eid, '2026-11-23')).toBe('past');
  });
});

describe('saving a special day (M20-FR-16, FR-17)', () => {
  const limits = { today: '2026-11-11', maxDays: 60, aheadDays: 365, maxActive: 3, others: [] };
  const block = (over) => gym.specialDayBlock({ ...eid, ...limits, ...over });

  it('accepts a holiday and a day with changed hours', () => {
    expect(block()).toBeNull();
    expect(block({ ...ramadan })).toBeNull();
    expect(block({ fromOn: '2026-11-11', toOn: '2026-11-11' })).toBeNull();
    // windows left out: a closed day carries none
    expect(gym.specialDayBlock({ fromOn: eid.fromOn, toOn: eid.toOn, kind: 'closed', ...limits })).toBeNull();
  });

  it('refuses dates out of order, in the past, too long or too far ahead', () => {
    expect(block({ fromOn: '2026-11-22', toOn: '2026-11-20' })).toEqual({ code: 'GYM_SPECIAL_DAY_DATES', meta: { reason: 'order' } });
    expect(block({ fromOn: '2026-11-10', toOn: '2026-11-12' })).toEqual({ code: 'GYM_SPECIAL_DAY_DATES', meta: { reason: 'past' } });
    expect(block({ fromOn: '2026-11-20', toOn: '2027-01-18' })).toBeNull(); // 60 days exactly
    expect(block({ fromOn: '2026-11-20', toOn: '2027-01-19' })).toEqual({ code: 'GYM_SPECIAL_DAY_DATES', meta: { reason: 'too_long', maxDays: 60 } });
    expect(block({ fromOn: '2026-11-20', toOn: '2027-01-19', maxDays: 61 })).toBeNull();
    expect(block({ fromOn: '2027-11-12', toOn: '2027-11-12' })).toEqual({ code: 'GYM_SPECIAL_DAY_DATES', meta: { reason: 'too_far', aheadDays: 365 } });
    expect(block({ fromOn: '2027-11-11', toOn: '2027-11-11' })).toBeNull();
  });

  it('refuses hours on a closed day, and a changed day without valid hours', () => {
    expect(block({ windows: ramadan.windows })).toEqual({ code: 'GYM_SPECIAL_DAY_HOURS', meta: { reason: 'closed_has_windows' } });
    expect(block({ kind: 'hours', windows: [] })).toEqual({ code: 'GYM_SPECIAL_DAY_HOURS', meta: { reason: 'no_windows' } });
    expect(block({ kind: 'hours', windows: [{ openTime: '10:00', closeTime: '09:00' }] })).toMatchObject({ code: 'GYM_SPECIAL_DAY_HOURS', meta: { reason: 'invalid' } });
    expect(block({ kind: 'hours', windows: [{ openTime: '10:00', closeTime: '12:00' }, { openTime: '11:00', closeTime: '13:00' }] })).toMatchObject({ code: 'GYM_SPECIAL_DAY_HOURS', meta: { reason: 'invalid' } });
  });

  it('refuses an overlap and more than the gym may keep', () => {
    expect(block({ others: [{ fromOn: '2026-11-22', toOn: '2026-11-25' }] })).toEqual({ code: 'GYM_SPECIAL_DAY_OVERLAP' });
    expect(block({ others: [{ fromOn: '2026-11-23', toOn: '2026-11-25' }] })).toBeNull();
    expect(block({ others: [{ fromOn: '2026-11-10', toOn: '2026-11-19' }] })).toBeNull();
    const three = [1, 2, 3].map((n) => ({ fromOn: `2026-12-0${n}`, toOn: `2026-12-0${n}` }));
    expect(block({ others: three })).toEqual({ code: 'GYM_SPECIAL_DAY_LIMIT', meta: { max: 3 } });
  });
});

describe('what a special day cancels (M20-FR-20, FR-22)', () => {
  it('leaves a trial visit without an open hour', () => {
    expect(manage.outsideSpecialDay(eid, '10:00')).toBe(true);
    expect(manage.outsideSpecialDay(ramadan, '10:00')).toBe(true);
    expect(manage.outsideSpecialDay(ramadan, '20:30')).toBe(false);
    expect(manage.outsideSpecialDay(ramadan, '09:00')).toBe(true);
  });

  it('leaves a class session shut', () => {
    expect(ops.outsideSpecialDay(eid, 6 * 60 + 30)).toBe(true);
    expect(ops.outsideSpecialDay(ramadan, 6 * 60 + 30)).toBe(false);
    expect(ops.outsideSpecialDay(ramadan, 23 * 60 + 59)).toBe(false);
    expect(ops.outsideSpecialDay(ramadan, 18 * 60)).toBe(true);
    expect(ops.shutBy([eid, ramadan], '2026-11-21', 600)).toBe(eid);
    expect(ops.shutBy([eid, ramadan], '2026-12-05', 600)).toBe(ramadan);
    expect(ops.shutBy([eid, ramadan], '2026-12-05', 6 * 60)).toBeNull();
    expect(ops.shutBy([eid, ramadan], '2026-11-25', 600)).toBeNull();
    expect(ops.shutBy([], '2026-11-21', 600)).toBeNull();
  });

  it('names the reason the person reads', () => {
    expect(manage.specialDayReason(eid)).toBe('The gym is closed: Eid-ul-Fitr');
    expect(manage.specialDayReason(ramadan)).toBe('The gym’s hours changed: Ramadan timings');
    expect(ops.specialDayReason(eid)).toBe('The gym is closed: Eid-ul-Fitr');
    expect(ops.specialDayReason(ramadan)).toBe('The gym’s hours changed: Ramadan timings');
  });

  it('lists the dates holidays close within a range', () => {
    expect([...ops.closedDates([eid, ramadan], '2026-11-01', '2026-12-31')]).toEqual(['2026-11-20', '2026-11-21', '2026-11-22']);
    expect([...ops.closedDates([eid], '2026-11-21', '2026-11-21')]).toEqual(['2026-11-21']);
    expect([...ops.closedDates([eid], '2026-11-23', '2026-11-30')]).toEqual([]);
    expect([...ops.closedDates([], '2026-11-01', '2026-11-30')]).toEqual([]);
  });

  it('marks no shift late or missed on a day the gym was closed', () => {
    const shifts = [{ dow: 5, startTime: '06:00' }, { dow: 6, startTime: '06:00' }]; // Friday 20 and Saturday 21 Nov 2026
    const base = { shifts, times: [], from: '2026-11-20', to: '2026-11-21', today: '2026-11-25', graceMinutes: 10 };
    expect(ops.shiftMarks(base)).toEqual({ late: 0, missed: 2 });
    expect(ops.shiftMarks({ ...base, closed: ops.closedDates([eid], base.from, base.to) })).toEqual({ late: 0, missed: 0 });
    expect(ops.shiftMarks({ ...base, closed: new Set(['2026-11-20']) })).toEqual({ late: 0, missed: 1 });
  });
});

describe('the conversion report (M27-FR-87 to FR-91)', () => {
  it('covers the month asked for, or this month when it is missing, malformed or ahead', () => {
    expect(ops.conversionPeriod('2026-10', '2026-11-11')).toEqual({ month: '2026-10', from: '2026-10-01', to: '2026-10-31' });
    expect(ops.conversionPeriod('2026-11', '2026-11-11')).toMatchObject({ month: '2026-11', to: '2026-11-30' });
    expect(ops.conversionPeriod(undefined, '2026-11-11').month).toBe('2026-11');
    expect(ops.conversionPeriod('2026-13', '2026-11-11').month).toBe('2026-11');
    expect(ops.conversionPeriod('2026-12', '2026-11-11').month).toBe('2026-11');
  });

  it('gives a share with one decimal, or null with nothing to divide by', () => {
    expect(ops.sharePct(1, 3)).toBe(33.3);
    expect(ops.sharePct(2, 3)).toBe(66.7);
    expect(ops.sharePct(0, 5)).toBe(0);
    expect(ops.sharePct(0, 0)).toBeNull();
  });

  const counts = {
    period: { month: '2026-11', from: '2026-11-01', to: '2026-11-30' },
    today: '2026-11-11',
    leads: { received: 4, open: 1, contacted: 1, joined: 1, lost: 1 },
    visits: { booked: 5, attended: 2, missed: 1, cancelled: 1, waiting: 1, joined: 1 },
    joinRequests: { received: 2, accepted: 1, closed: 0, waiting: 1 },
    members: { total: 6, bySource: { desk: 4, platform: 1, import: 1 }, fromVisit: 1, fromEnquiry: 1 },
  };

  it('adds the joined share to each group', () => {
    const r = ops.conversionReport(counts);
    expect(r.enquiries).toEqual({ ...counts.leads, joinedPct: 25 });
    expect(r.visits).toEqual({ ...counts.visits, joinedPct: 25 }); // 1 of the 4 not cancelled
    expect(r.joinRequests).toEqual({ ...counts.joinRequests, joinedPct: 50 });
    expect(r.members).toBe(counts.members);
    expect(r.period).toBe(counts.period);
  });

  it('leaves out a group the plan lacks', () => {
    const r = ops.conversionReport({ ...counts, leads: null, visits: null });
    expect(r.enquiries).toBeNull();
    expect(r.visits).toBeNull();
    expect(ops.conversionRows(r).map((x) => x[0])).not.toContain('Enquiries');
    expect(ops.conversionRows(r).some((x) => x[0] === 'Join requests')).toBe(true);
  });

  it('writes counts only into the CSV rows', () => {
    const rows = ops.conversionRows(ops.conversionReport(counts));
    expect(rows).toContainEqual(['Enquiries', 'Received', 4]);
    expect(rows).toContainEqual(['Trial visits', 'Became members', 1]);
    expect(rows).toContainEqual(['Join requests', 'Waiting', 1]);
    expect(rows).toContainEqual(['New members', 'Came from an enquiry', 1]);
    expect(rows).toHaveLength(5 + 6 + 4 + 6);
    expect(rows.every((r) => r.length === 3 && typeof r[2] === 'number')).toBe(true);
  });
});
