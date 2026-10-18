'use strict';

// M20 rules (§6, v3; Q110). 100% branch coverage: they decide money, admissions and refunds.
const r = require('../../src/modules/gym/gym.rules');

// A gym open 06:00–23:00 every day except Friday (5); Saturday (6) also has a women-only window 08:00–10:00 before 10:00–22:00.
const HOURS = [
  ...[0, 1, 2, 3, 4].map((dow) => ({ dow, openTime: '06:00', closeTime: '23:00', womenOnly: false })),
  { dow: 6, openTime: '10:00', closeTime: '22:00', womenOnly: false },
  { dow: 6, openTime: '08:00', closeTime: '10:00', womenOnly: true },
];
// 2026-10-22 is a Thursday (4); 2026-10-23 a Friday (5); 2026-10-24 a Saturday (6).
const dhaka = (date, hhmm) => r.instantOf(date, r.toMin(hhmm));

describe('dates on the Dhaka clock', () => {
  it('converts instants and dates', () => {
    expect(r.dhakaDate('2026-10-22T18:30:00.000Z')).toBe('2026-10-23');
    expect(r.addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(r.daysBetween('2026-10-22', '2026-10-29')).toBe(7);
    expect(r.dowOf('2026-10-22')).toBe(4);
    expect(r.instantOf('2026-10-22').toISOString()).toBe('2026-10-21T18:00:00.000Z');
    expect(r.instantOf('2026-10-22', 7 * 60 + 42).toISOString()).toBe('2026-10-22T01:42:00.000Z');
    expect(r.minuteOf('2026-10-22T01:42:00.000Z')).toBe(462);
    expect(r.toMin('24:00')).toBe(1440);
  });
});

describe('money', () => {
  it('takes the fee half up on the price: ৳400 at 5% → ৳20, the owner ৳380', () => {
    expect(r.money(40000, 500)).toEqual({ price: 40000, fee: 2000, net: 38000 });
    expect(r.feeOf(10010, 500)).toBe(501); // 500.5 → 501
    expect(r.feeOf(10009, 500)).toBe(500);
  });
});

describe('opening hours', () => {
  it('accepts a week with women-only windows and 24:00', () => {
    expect(r.hoursErrors([...HOURS, { dow: 5, openTime: '20:00', closeTime: '24:00', womenOnly: false }])).toEqual([]);
  });
  it('refuses a bad weekday, bad times, off the mark, empty, overlapping, too many', () => {
    expect(r.hoursErrors([{ dow: 7, openTime: '06:00', closeTime: '07:00' }])[0].field).toBe('hours.0');
    expect(r.hoursErrors([{ dow: 1, openTime: '6:00', closeTime: '07:00' }])[0].message).toBe('Times are HH:MM');
    expect(r.hoursErrors([{ dow: 1, openTime: '06:00', closeTime: '25:00' }])[0].message).toBe('Times are HH:MM');
    expect(r.hoursErrors([{ dow: 1, openTime: '06:10', closeTime: '07:00' }])[0].message).toBe('Times are on the 15-minute mark');
    expect(r.hoursErrors([{ dow: 1, openTime: '07:00', closeTime: '07:00' }])[0].message).toBe('A window closes after it opens, on the same day');
    expect(r.hoursErrors([{ dow: 1, openTime: '06:00', closeTime: '09:00' }, { dow: 1, openTime: '08:00', closeTime: '10:00' }])[0]).toEqual({ field: 'hours.1', message: 'Windows on the same day overlap' });
    const five = ['06:00', '08:00', '10:00', '12:00', '14:00'].map((t, i) => ({ dow: 2, openTime: t, closeTime: `${String(7 + i * 2).padStart(2, '0')}:00` }));
    expect(r.hoursErrors(five)).toEqual([{ field: 'hours.4', message: 'At most 4 windows a day' }]);
  });
  it('knows when the gym opens, is open and closes', () => {
    expect(r.hasOpenDay(HOURS)).toBe(true);
    expect(r.hasOpenDay([])).toBe(false);
    expect(r.opensOn(HOURS, '2026-10-23')).toBe(false);
    expect(r.windowsOn(HOURS, 6).map((w) => w.openTime)).toEqual(['08:00', '10:00']);
    expect(r.openWindowAt(HOURS, dhaka('2026-10-24', '09:00')).womenOnly).toBe(true);
    expect(r.openWindowAt(HOURS, dhaka('2026-10-22', '23:00'))).toBeNull();
    expect(r.closingOn(HOURS, '2026-10-24').toISOString()).toBe(dhaka('2026-10-24', '22:00').toISOString());
    expect(r.closingOn(HOURS, '2026-10-23')).toBeNull();
  });
});

describe('packages', () => {
  const lim = { dayMin: 10000, dayMax: 300000 };
  it('knows the days of each kind', () => {
    expect([r.daysOf('day', { monthDays: 30, quarterDays: 90 }), r.daysOf('month', { monthDays: 30 }), r.daysOf('quarter', { quarterDays: 90 })]).toEqual([1, 30, 90]);
  });
  it('accepts the design gyms', () => {
    expect(r.packageErrors([{ kind: 'day', price: 40000 }, { kind: 'month', price: 450000 }, { kind: 'quarter', price: 1200000 }], lim)).toEqual([]);
    expect(r.packageErrors([{ kind: 'day', price: 30000 }, { kind: 'quarter', price: 30000 }], lim)).toEqual([]);
  });
  it('needs a day pass inside the limits, and longer packages that cost no less', () => {
    expect(r.packageErrors([{ kind: 'month', price: 450000 }], lim)).toEqual([{ field: 'packages', message: 'Add a day pass' }]);
    expect(r.packageErrors([{ kind: 'day', price: 5000 }], lim)[0].field).toBe('packages.day');
    expect(r.packageErrors([{ kind: 'day', price: 400000 }], lim)[0].field).toBe('packages.day');
    expect(r.packageErrors([{ kind: 'day', price: 40000 }, { kind: 'month', price: 30000 }], lim)).toEqual([{ field: 'packages.month', message: 'A month pass costs at least a day pass' }]);
    expect(r.packageErrors([{ kind: 'day', price: 40000 }, { kind: 'month', price: 450000 }, { kind: 'quarter', price: 400000 }], lim)).toEqual([{ field: 'packages.quarter', message: 'A quarter pass costs at least a month pass' }]);
    expect(r.packageErrors([{ kind: 'day', price: 40000 }, { kind: 'quarter', price: 30000 }], lim)[0].field).toBe('packages.quarter');
    // No day and no month: only the missing day pass is reported.
    expect(r.packageErrors([{ kind: 'quarter', price: 30000 }], lim)).toEqual([{ field: 'packages', message: 'Add a day pass' }]);
  });
});

describe('buying a pass (FR-03)', () => {
  const base = { days: 1, today: '2026-10-22', advanceDays: 7, hours: HOURS };
  it('a day pass on an open day within the next 7 days', () => {
    expect(r.validity({ ...base, kind: 'day', from: '2026-10-24', now: dhaka('2026-10-22', '12:00') })).toEqual({ validFrom: '2026-10-24', validTo: '2026-10-24' });
    expect(r.validity({ ...base, kind: 'day', from: '2026-10-22', now: dhaka('2026-10-22', '22:59') })).toEqual({ validFrom: '2026-10-22', validTo: '2026-10-22' });
  });
  it('refuses the past, too far ahead, a closed day and today after closing', () => {
    expect(r.validity({ ...base, kind: 'day', from: '2026-10-21', now: dhaka('2026-10-22', '12:00') })).toEqual({ block: 'DATE_OUT_OF_RANGE' });
    expect(r.validity({ ...base, kind: 'day', from: '2026-10-29', now: dhaka('2026-10-22', '12:00') })).toEqual({ block: 'DATE_OUT_OF_RANGE' });
    expect(r.validity({ ...base, kind: 'day', from: '2026-10-23', now: dhaka('2026-10-22', '12:00') })).toEqual({ block: 'GYM_CLOSED_ON_DATE' });
    expect(r.validity({ ...base, kind: 'day', from: '2026-10-22', now: dhaka('2026-10-22', '23:00') })).toEqual({ block: 'GYM_CLOSED_ON_DATE' });
  });
  it('a month pass runs 30 days from its start, even from a closed day', () => {
    expect(r.validity({ ...base, kind: 'month', days: 30, from: '2026-10-23', now: dhaka('2026-10-22', '12:00') })).toEqual({ validFrom: '2026-10-23', validTo: '2026-11-21' });
  });
});

describe('the front desk (FR-05)', () => {
  const pass = { gymId: 'g1', kind: 'day', status: 'active', validFrom: '2026-10-22', validTo: '2026-10-22', firstRedeemedAt: null, lastRedeemedAt: null };
  const at = dhaka('2026-10-22', '07:42');
  const check = (over = {}, more = {}) => r.redeemBlock({ pass: { ...pass, ...over }, gymId: 'g1', today: '2026-10-22', at, hours: HOURS, ...more });
  it('admits an active pass of this gym, valid today, while open', () => {
    expect(check()).toBeNull();
  });
  it('says why not, the wrong gym first', () => {
    expect(check({ gymId: 'g2', status: 'expired' })).toEqual({ code: 'PASS_WRONG_GYM' });
    expect(check({ status: 'redeemed', lastRedeemedAt: at })).toEqual({ code: 'PASS_ALREADY_REDEEMED', at });
    expect(check({ status: 'refunded' })).toEqual({ code: 'PASS_NOT_ACTIVE', status: 'refunded' });
    expect(check({ validFrom: '2026-10-23', validTo: '2026-10-23' })).toMatchObject({ code: 'PASS_NOT_VALID_TODAY' });
    expect(check({ validFrom: '2026-09-22', validTo: '2026-10-21' })).toMatchObject({ code: 'PASS_NOT_VALID_TODAY' });
    expect(check({ kind: 'month', validFrom: '2026-10-01', validTo: '2026-10-30' }, { usedTodayAt: at })).toEqual({ code: 'PASS_ALREADY_REDEEMED', at });
    expect(check({}, { at: dhaka('2026-10-22', '05:00') })).toEqual({ code: 'GYM_CLOSED_NOW' });
  });
  it('a day pass is used up; the first admission releases the money', () => {
    expect(r.admission({ kind: 'day', firstRedeemedAt: null })).toEqual({ status: 'redeemed', release: true });
    expect(r.admission({ kind: 'month', firstRedeemedAt: null })).toEqual({ status: 'active', release: true });
    expect(r.admission({ kind: 'quarter', firstRedeemedAt: at })).toEqual({ status: 'active', release: false });
  });
});

describe('cancelling and expiry (FR-06, Q110)', () => {
  const day = { kind: 'day', status: 'active', validFrom: '2026-10-24', validTo: '2026-10-24', pricePoisha: 40000, firstRedeemedAt: null };
  const month = { ...day, kind: 'month', validFrom: '2026-10-22', validTo: '2026-11-20', pricePoisha: 450000 };
  it('refunds a day pass in full before its date, never on it', () => {
    expect(r.cancelPlan({ pass: day, today: '2026-10-23' })).toEqual({ refund: 40000 });
    expect(r.cancelPlan({ pass: day, today: '2026-10-24' })).toEqual({ block: 'PASS_NOT_REFUNDABLE' });
  });
  it('refunds a month pass until its first use', () => {
    expect(r.cancelPlan({ pass: month, today: '2026-10-25' })).toEqual({ refund: 450000 });
    expect(r.cancelPlan({ pass: { ...month, firstRedeemedAt: new Date() }, today: '2026-10-25' })).toEqual({ block: 'PASS_NOT_REFUNDABLE' });
    expect(r.cancelPlan({ pass: month, today: '2026-11-21' })).toEqual({ block: 'PASS_NOT_REFUNDABLE' });
    expect(r.cancelPlan({ pass: { ...month, status: 'redeemed' }, today: '2026-10-25' })).toEqual({ block: 'PASS_NOT_ACTIVE' });
  });
  it('a day pass expires at closing on its date; others after their last day', () => {
    expect(r.expiresAt({ ...day, validFrom: '2026-10-22' }, HOURS).toISOString()).toBe(dhaka('2026-10-22', '23:00').toISOString());
    expect(r.expiresAt({ ...day, validFrom: '2026-10-23' }, HOURS).toISOString()).toBe(r.instantOf('2026-10-24').toISOString());
    expect(r.expiresAt(month, HOURS).toISOString()).toBe(r.instantOf('2026-11-21').toISOString());
  });
});

describe('QR token and backup code', () => {
  const sign = (text) => require('crypto').createHmac('sha256', 'test-secret').update(text).digest('hex');
  const passId = '01928f5e-0000-7000-8000-000000000001';
  const token = r.tokenOf({ passId, nonce: 'Ab12_-xyZ9QwErTy' }, sign);
  it('signs and reads back a token', () => {
    expect(token).toMatch(/^v1\.01928f5e-[0-9a-f-]+\.Ab12_-xyZ9QwErTy\.[0-9a-f]{32}$/);
    expect(r.parseToken(token, sign)).toEqual({ passId, nonce: 'Ab12_-xyZ9QwErTy' });
    expect(r.parseToken(` ${token} `, sign, (a, b) => a === b)).toEqual({ passId, nonce: 'Ab12_-xyZ9QwErTy' });
  });
  it('refuses anything tampered or malformed', () => {
    const [v, id, nonce, sig] = token.split('.');
    expect(r.parseToken(`${v}.${id}.${nonce}.${sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a')}`, sign)).toBeNull();
    expect(r.parseToken(`${v}.${id}.other1234.${sig}`, sign)).toBeNull();
    expect(r.parseToken(`v2.${id}.${nonce}.${sig}`, sign)).toBeNull();
    expect(r.parseToken(`${v}.not-a-uuid.${nonce}.${sig}`, sign)).toBeNull();
    expect(r.parseToken(`${v}.${id}.short.${sig}`, sign)).toBeNull();
    expect(r.parseToken(`${v}.${id}.${nonce}.XYZ`, sign)).toBeNull();
    expect(r.parseToken(`${v}.${id}.${nonce}`, sign)).toBeNull();
    expect(r.parseToken(null, sign)).toBeNull();
  });
  it('makes 6-character Crockford codes and reads what people type', () => {
    expect(r.backupCode(Buffer.from([0, 31, 32, 8, 18, 255]))).toBe('0Z08JZ');
    expect(r.normalizeCode(' 0z0-8jz ')).toBe('0Z08JZ');
    expect(r.normalizeCode('OIL123')).toBe('011123');
    expect(r.normalizeCode('ABCDU1')).toBeNull();
    expect(r.normalizeCode('12345')).toBeNull();
    expect(r.normalizeCode(undefined)).toBeNull();
  });
});

describe('trainer subscriptions', () => {
  it('runs 30-day months, released a day after each ends', () => {
    expect(r.periodOf('2026-10-22', 30)).toEqual({ periodStart: '2026-10-22', periodEnd: '2026-11-20' });
    expect(r.releaseAtOf('2026-11-20', 24).toISOString()).toBe(r.instantOf('2026-11-22').toISOString());
    expect(r.graceUntil('2026-11-20', 3).toISOString()).toBe(r.instantOf('2026-11-24').toISOString());
  });
  it('opens renewal 5 days before the end, then grace for 3 days, then lapses', () => {
    const at = (today) => r.renewalPhase({ today, periodEnd: '2026-11-20', noticeDays: 5, graceDays: 3 });
    expect(at('2026-11-15')).toBe('active');
    expect(at('2026-11-16')).toBe('renewal_due');
    expect(at('2026-11-20')).toBe('renewal_due');
    expect(at('2026-11-21')).toBe('grace');
    expect(at('2026-11-23')).toBe('grace');
    expect(at('2026-11-24')).toBe('lapsed');
  });
  it('refunds in full in the first 3 days of a month', () => {
    expect(r.inCancelWindow({ today: '2026-10-24', periodStart: '2026-10-22', cancelDays: 3 })).toBe(true);
    expect(r.inCancelWindow({ today: '2026-10-25', periodStart: '2026-10-22', cancelDays: 3 })).toBe(false);
  });
  it('starts today or within the start window', () => {
    expect(r.startBlock({ start: '2026-10-22', today: '2026-10-22', startDays: 14 })).toBeNull();
    expect(r.startBlock({ start: '2026-10-21', today: '2026-10-22', startDays: 14 })).toBe('DATE_OUT_OF_RANGE');
    expect(r.startBlock({ start: '2026-11-05', today: '2026-10-22', startDays: 14 })).toBe('DATE_OUT_OF_RANGE');
  });
  it('checks a plan: price within limits, where it happens', () => {
    const lim = { min: 100000, max: 5000000 };
    expect(r.planErrors({ price: 600000, where: 'online' }, lim)).toEqual([]);
    expect(r.planErrors({ price: 600000, where: 'gym', gymId: 'g' }, lim)).toEqual([]);
    expect(r.planErrors({ price: 600000, where: 'home', areaId: 'a' }, lim)).toEqual([]);
    expect(r.planErrors({ price: 50000, where: 'online' }, lim)[0].field).toBe('price');
    expect(r.planErrors({ price: 6000000, where: 'online' }, lim)[0].field).toBe('price');
    expect(r.planErrors({ price: 600000.5, where: 'online' }, lim)[0].field).toBe('price');
    expect(r.planErrors({ price: 600000, where: 'gym' }, lim)).toEqual([{ field: 'gymId', message: 'Choose the gym' }]);
    expect(r.planErrors({ price: 600000, where: 'home' }, lim)).toEqual([{ field: 'areaId', message: 'Choose the area you cover' }]);
  });
});
