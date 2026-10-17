'use strict';

// M11 pure rules: the quote and its worked examples (§6.3), rate limits (Q74), checks (§6.5), the
// request and job state machines (§8), windows, cancellation tiers (§6.6) and contact masking.
// 100% branch gate in jest.config.
const r = require('../../src/modules/hire/hire.rules');

const at = (iso) => new Date(iso);
const card = { nightPct: 20, shortNoticePct: 15, shortNoticeHours: 48, travel: { north: 30000, south: 50000, outside: 150000 } };
const umpire = [
  { unit: 'match', format: 'T20', rate: 350000 },
  { unit: 'match', format: 'T10', rate: 250000 },
];
const matchHours = { T10: 2, T20: 4, OD: 9, TAPE: 2, default: 3 };

describe('M11 quote (§6.3)', () => {
  const start = at('2026-10-20T13:30:00Z'); // 19:30 Dhaka

  it('prices the design job: T20, night, Mirpur (north), 72 h notice → ৳4,500; at 30 h → ৳5,050; fee ৳505', () => {
    const q72 = r.quoteEngagement({ unit: 'match', format: 'T20', night: true, start, requestedAt: at('2026-10-17T13:30:00Z'), zone: 'north', items: umpire, card });
    expect(q72).toEqual({ lines: [{ key: 'base', amount: 350000 }, { key: 'night', amount: 70000 }, { key: 'travel_north', amount: 30000 }], total: 450000 });
    const q30 = r.quoteEngagement({ unit: 'match', format: 'T20', night: true, start, requestedAt: at('2026-10-19T07:30:00Z'), zone: 'north', items: umpire, card });
    expect(q30.total).toBe(505000);
    expect(r.money([q30.total], 1000)).toEqual({ total: 505000, fee: 50500, net: 454500 });
  });

  it('prices hourly sessions, home without travel, and refuses a unit not offered', () => {
    const items = [{ unit: 'hourly', rate: 60000 }];
    const q = r.quoteEngagement({ unit: 'hourly', hours: 2.5, night: false, start, requestedAt: at('2026-10-01T00:00:00Z'), zone: 'home', items, card });
    expect(q).toEqual({ lines: [{ key: 'base', amount: 150000 }], total: 150000 });
    expect(r.quoteEngagement({ unit: 'match', format: null, night: false, start, requestedAt: start, zone: 'home', items, card })).toEqual({ error: 'UNIT_NOT_OFFERED' });
    expect(r.quoteEngagement({ unit: 'match', format: 'OD', night: false, start, requestedAt: start, zone: 'home', items: umpire, card })).toEqual({ error: 'UNIT_NOT_OFFERED' });
    const flat = { ...card, nightPct: 0, shortNoticePct: 0, travel: { north: 0, south: 0, outside: 0 } };
    expect(r.quoteEngagement({ unit: 'hourly', hours: 1, night: true, start, requestedAt: start, zone: 'south', items, card: flat }).lines).toHaveLength(1);
  });

  it('rounds to ৳50 half up', () => {
    expect(r.round50(502499)).toBe(500000);
    expect(r.round50(502500)).toBe(505000);
    expect(r.round50(500000)).toBe(500000);
  });

  it('finds the zone, night and length', () => {
    expect(r.zoneOf({ venueAreaId: 'a', baseAreaId: 'a', isDhakaMetro: true, dhakaZone: 'north' })).toBe('home');
    expect(r.zoneOf({ venueAreaId: 'a', baseAreaId: 'b', isDhakaMetro: false, dhakaZone: null })).toBe('outside');
    expect(r.zoneOf({ venueAreaId: 'a', baseAreaId: 'b', isDhakaMetro: true, dhakaZone: 'south' })).toBe('south');
    expect(r.zoneOf({ venueAreaId: 'a', baseAreaId: 'b', isDhakaMetro: true, dhakaZone: null })).toBe('north');
    expect(r.isNight(at('2026-10-20T12:00:00Z'))).toBe(true); // 18:00 Dhaka
    expect(r.isNight(at('2026-10-20T11:59:00Z'))).toBe(false);
    expect(r.hoursOf({ unit: 'hourly', hours: 2, matchHours })).toBe(2);
    expect(r.hoursOf({ unit: 'match', format: 'OD', matchHours })).toBe(9);
    expect(r.hoursOf({ unit: 'match', format: null, matchHours })).toBe(3);
  });

});

describe('M11 rate cards (Q74, FR-03)', () => {
  const m = { matchHours, unitMultipliers: { hourly: 1, match: 4 }, experienceMultipliers: { amateur: 1, national: 4 }, band: { min: 0.5, max: 3 } };
  const role = { allowedUnits: ['match'], formatPriced: true, formats: ['T10', 'T20'] };
  const limitsFor = (unit, format) => r.rateLimits({ baseHourly: 50000, unit, format, ...m });

  it('limits a rate by the base × unit factor × band (top experience)', () => {
    expect(r.rateLimits({ baseHourly: 50000, unit: 'hourly', ...m })).toEqual({ min: 25000, max: 600000 });
    expect(r.rateLimits({ baseHourly: 50000, unit: 'match', ...m })).toEqual({ min: 100000, max: 2400000 });
    expect(r.rateLimits({ baseHourly: 50000, unit: 'match', format: 'T20', ...m })).toEqual({ min: 100000, max: 2400000 });
    expect(r.rateLimits({ baseHourly: 50000, unit: 'match', format: 'XX', ...m })).toEqual({ min: 75000, max: 1800000 });
  });

  it('validates a card for the role', () => {
    const base = { card: { nightPct: 20, shortNoticePct: 15, maxJobsPerDay: 2 }, limitsFor, maxJobsCap: 4, nightPctMax: 50, shortPctMax: 50 };
    expect(r.rateCardErrors({ ...base, role, items: umpire })).toEqual([]);
    const bad = r.rateCardErrors({
      ...base,
      role,
      items: [
        { unit: 'hourly', rate: 50000 },
        { unit: 'match', format: 'OD', rate: 400000 },
        { unit: 'match', format: 'T20', rate: 10 },
        { unit: 'match', format: 'T20', rate: 350000 },
      ],
      card: { nightPct: 60, shortNoticePct: 70, maxJobsPerDay: 9 },
    });
    expect(bad.map((e) => e.field)).toEqual(['items[0]', 'items[1]', 'items[2]', 'items', 'nightPct', 'shortNoticePct', 'maxJobsPerDay']);
    const flatRole = { allowedUnits: ['match', 'hourly'], formatPriced: false, formats: [] };
    expect(r.rateCardErrors({ ...base, role: flatRole, items: [{ unit: 'match', format: 'T20', rate: 300000 }, { unit: 'hourly', format: 'T10', rate: 50000 }] }).map((e) => e.message)).toEqual(['This role has one match rate', 'An hourly rate has no format']);
    expect(r.rateCardErrors({ ...base, role, items: [] })).toEqual([{ field: 'items', message: 'Add at least one rate' }]);
    expect(r.rateCardErrors({ ...base, role: flatRole, items: [{ unit: 'hourly', rate: 50000 }, { unit: 'match', rate: 200000 }] })).toEqual([]);
  });

  it('normalises to an hourly rate for sorting', () => {
    expect(r.normalisedHourly([{ unit: 'hourly', rate: 60000 }, { unit: 'match', rate: 300000 }], 4)).toBe(60000);
    expect(r.normalisedHourly([{ unit: 'match', format: null, rate: 200000 }], 4)).toBe(50000);
    expect(r.normalisedHourly(umpire, 4)).toBe(87500);
    expect(r.normalisedHourly([{ unit: 'match', format: 'OD', rate: 600000 }, { unit: 'match', format: 'T10', rate: 250000 }], 4)).toBe(62500);
    expect(r.normalisedHourly([{ unit: 'match', format: 'T10', rate: 250000 }, { unit: 'match', format: 'OD', rate: 600000 }], 4)).toBe(62500);
    expect(r.normalisedHourly([], 4)).toBeNull();
  });
});

describe('M11 checks (§6.5)', () => {
  const now = at('2026-10-17T06:00:00Z');
  const job = { start: at('2026-10-20T13:30:00Z'), u16: false };
  const base = { role: { requiresCredential: true, policeCheckForU16: true }, experienceLevel: 'semi_pro', credential: { level: 'pro', expiresOn: '2027-01-01' }, policeUntil: '2027-01-01', jobs: [job], clashes: [], perDay: {}, maxPerDay: 2, now, leadMin: 120 };
  const failing = (over) => r.checks({ ...base, ...over }).filter((c) => !c.ok).map((c) => c.key);

  it('passes when everything holds', () => expect(failing({})).toEqual([]));
  it('fails each check alone', () => {
    expect(failing({ credential: null })).toEqual(['credential']);
    expect(failing({ credential: { level: 'amateur', expiresOn: null } })).toEqual(['credential']);
    expect(failing({ credential: { level: 'pro', expiresOn: '2026-10-19' } })).toEqual(['credential']);
    expect(failing({ jobs: [{ ...job, u16: true }], policeUntil: null })).toEqual(['police_clearance']);
    expect(failing({ jobs: [{ ...job, u16: true }], policeUntil: '2026-10-19' })).toEqual(['police_clearance']);
    expect(failing({ clashes: ['HJ-1'] })).toEqual(['free']);
    expect(failing({ perDay: { '2026-10-20': 2 } })).toEqual(['daily_limit']);
    expect(failing({ jobs: [{ start: at('2026-10-17T07:00:00Z'), u16: false }] })).toEqual(['in_future']);
  });
  it('skips the credential and police checks for roles that do not need them', () => {
    expect(failing({ role: { requiresCredential: false, policeCheckForU16: false }, credential: null, policeUntil: null, jobs: [{ ...job, u16: true }] })).toEqual([]);
    expect(failing({ jobs: [{ ...job, u16: true }] })).toEqual([]);
  });
  it('widens a job by half the buffer for the clash guard, and dates it in Dhaka', () => {
    expect(r.busyOf({ start: at('2026-10-20T10:00:00Z'), end: at('2026-10-20T14:00:00Z'), bufferMin: 60 })).toEqual({ from: at('2026-10-20T09:30:00Z'), to: at('2026-10-20T14:30:00Z') });
    expect(r.dhakaDay(at('2026-10-20T19:00:00Z'))).toBe('2026-10-21');
    expect(r.levelRank('national')).toBe(3);
  });
});

describe('M11 state machines (§8)', () => {
  const requests = [
    ['accept', 'pending', 'pro', 'accepted_unpaid'],
    ['decline', 'pending', 'pro', 'declined'],
    ['expire', 'pending', 'system', 'expired'],
    ['withdraw', 'pending', 'hirer', 'withdrawn'],
    ['withdraw', 'accepted_unpaid', 'hirer', 'withdrawn'],
    ['pay', 'accepted_unpaid', 'system', 'confirmed'],
    ['lapse', 'accepted_unpaid', 'system', 'lapsed'],
    ['complete', 'confirmed', 'system', 'completed'],
    ['cancel', 'confirmed', 'system', 'cancelled'],
  ];
  it.each(requests)('request %s from %s by %s → %s', (a, f, by, to) => expect(r.nextRequest(a, f, by)).toBe(to));
  const jobs = [
    ['pay', 'reserved', 'system', 'scheduled'],
    ['void', 'reserved', 'system', 'void'],
    ['check_in', 'scheduled', 'pro', 'checked_in'],
    ['start', 'checked_in', 'pro', 'live'],
    ['complete', 'checked_in', 'pro', 'completed_marked'],
    ['complete', 'live', 'pro', 'completed_marked'],
    ['confirm', 'completed_marked', 'hirer', 'released'],
    ['auto_release', 'completed_marked', 'system', 'released'],
    ['cancel', 'scheduled', 'hirer', 'cancelled'],
    ['withdraw', 'scheduled', 'pro', 'withdrawn'],
    ['platform_cancel', 'checked_in', 'staff', 'cancelled'],
    ['dispute', 'live', 'hirer', 'disputed'],
    ['dispute', 'completed_marked', 'hirer', 'disputed'],
    ['dispute_release', 'disputed', 'dispute', 'released'],
    ['dispute_refund', 'disputed', 'dispute', 'refunded'],
  ];
  it.each(jobs)('job %s from %s by %s → %s', (a, f, by, to) => expect(r.nextJob(a, f, by)).toBe(to));
  it('refuses the wrong actor, status or action', () => {
    expect(r.nextRequest('accept', 'pending', 'hirer')).toBeNull();
    expect(r.nextJob('check_in', 'reserved', 'pro')).toBeNull();
    expect(r.nextJob('fly', 'scheduled', 'pro')).toBeNull();
  });
  it('closes a request when its jobs are settled', () => {
    expect(r.requestAfterJobs(['released', 'scheduled'])).toBeNull();
    expect(r.requestAfterJobs(['released', 'disputed'])).toBeNull();
    expect(r.requestAfterJobs(['released', 'cancelled'])).toBe('completed');
    expect(r.requestAfterJobs(['withdrawn', 'refunded'])).toBe('cancelled');
  });
});

describe('M11 windows and deadlines', () => {
  const start = at('2026-10-20T13:30:00Z');
  const end = at('2026-10-20T17:30:00Z');
  const before = (min) => new Date(start.getTime() - min * 60000);

  it('replies within 12 h and pays within 2 h, never past the cut-offs before the start', () => {
    expect(r.replyBy({ now: at('2026-10-17T06:00:00Z'), firstStart: start, replyHours: 12, beforeStartMin: 120 })).toEqual(at('2026-10-17T18:00:00Z'));
    expect(r.replyBy({ now: before(300), firstStart: start, replyHours: 12, beforeStartMin: 120 })).toEqual(before(120));
    expect(r.payBy({ now: at('2026-10-17T06:00:00Z'), firstStart: start, windowMin: 120, beforeStartMin: 60 })).toEqual(at('2026-10-17T08:00:00Z'));
    expect(r.payBy({ now: before(90), firstStart: start, windowMin: 120, beforeStartMin: 60 })).toEqual(before(60));
  });

  it('opens check-in 60 min before, late after 30 min before, closed at the end', () => {
    const w = { start, end, openMin: 60, lateMin: 30 };
    expect(r.checkIn({ ...w, now: before(61) })).toEqual({ block: 'TOO_EARLY' });
    expect(r.checkIn({ ...w, now: before(60) })).toEqual({ late: false });
    expect(r.checkIn({ ...w, now: before(30) })).toEqual({ late: false });
    expect(r.checkIn({ ...w, now: before(29) })).toEqual({ late: true });
    expect(r.checkIn({ ...w, now: end })).toEqual({ block: 'JOB_ENDED' });
  });

  it('opens the start 15 min before', () => {
    expect(r.startBlock({ now: before(16), start, openMin: 15 })).toBe('TOO_EARLY');
    expect(r.startBlock({ now: before(15), start, openMin: 15 })).toBeNull();
  });

  it('lets the manager report a no-show from start + 60 min until end + 24 h, and a problem once marked complete', () => {
    const w = { start, end, afterMin: 60, windowHours: 24, checkedIn: false };
    expect(r.noShowBlock({ ...w, now: start, checkedIn: true })).toBe('CHECKED_IN');
    expect(r.noShowBlock({ ...w, now: new Date(start.getTime() + 59 * 60000) })).toBe('NO_SHOW_NOT_YET');
    expect(r.noShowBlock({ ...w, now: new Date(start.getTime() + 60 * 60000) })).toBeNull();
    expect(r.noShowBlock({ ...w, now: new Date(end.getTime() + 24 * 3600000) })).toBe('DISPUTE_WINDOW_CLOSED');
    expect(r.problemBlock({ status: 'completed_marked' })).toBeNull();
    expect(r.problemBlock({ status: 'released' })).toBe('DISPUTE_NOT_ELIGIBLE');
    expect(r.releaseAt({ completedAt: end, autoHours: 48 })).toEqual(at('2026-10-22T17:30:00Z'));
  });
});

describe('M11 cancellation (§6.6)', () => {
  const start = at('2026-10-20T13:30:00Z');
  const plan = (hoursBefore) => r.cancelPlan({ now: new Date(start.getTime() - hoursBefore * 3600000), start, quote: 450000, freeHours: 72, highHours: 24, pctMid: 25, pctHigh: 50, feeBps: 1000 });
  it('is free over 72 h, 25% from 72 to 24 h, 50% under 24 h; the pro gets the fee minus 10%', () => {
    expect(plan(73)).toEqual({ tier: 'free', pct: 0, cancelFee: 0, refund: 450000, proGets: 0, platformFee: 0 });
    expect(plan(72)).toMatchObject({ tier: 'mid', cancelFee: 112500, refund: 337500, proGets: 101250, platformFee: 11250 });
    expect(plan(30)).toMatchObject({ tier: 'mid', pct: 25 });
    expect(plan(24)).toMatchObject({ tier: 'high', cancelFee: 225000, refund: 225000, proGets: 202500 });
  });
});

describe('M11 contact masking (v3)', () => {
  it('refuses phones, long numbers, emails and links before payment', () => {
    for (const t of ['Call 01711 000 111', 'my number +8801811223344', 'WhatsApp 0 1 7 1 1 2 2 3 3 4 4', 'mail me a@b.com', 'see www.example.org', 'https://wa.me/123', 'find me on fb.com/kamal']) expect([t, r.hasContact(t)]).toEqual([t, true]);
    for (const t of ['T20 at 7:30pm, white ball', 'Can you do 2 matches on 14 and 15 Oct?', 'Ground is near Mirpur 10']) expect([t, r.hasContact(t)]).toEqual([t, false]);
  });
});
