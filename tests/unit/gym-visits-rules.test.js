'use strict';

/**
 * M24 trial visits (product owner, 9 Nov 2026; M24-FR-111..119): the pure rules for booking, cancelling and
 * checking in a free visit, the guest's QR token and the desk code. Every branch is covered.
 */
const crypto = require('node:crypto');
const r = require('../../src/modules/gym-manage/gym-manage.rules');

const sign = (s) => crypto.createHmac('sha256', 'test-key').update(s).digest('hex');
const VISIT = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const NONCE = 'a1b2c3d4e5f60718293a4b5c';

describe('M24-FR-111 visitBlock: why a free visit cannot be booked', () => {
  const ok = {
    open: true,
    own: false,
    member: false,
    date: '2026-11-10',
    arriveAt: '18:00',
    today: '2026-11-09',
    nowMinute: 600,
    aheadDays: 14,
    windows: [
      { openTime: '06:00', closeTime: '10:00' },
      { openTime: '16:00', closeTime: '22:00' },
    ],
    usedByPerson: 0,
    perPerson: 1,
    bookedThatDay: 0,
    cap: 5,
  };
  test('a good booking is allowed', () => expect(r.visitBlock(ok)).toBeNull());
  test('visits off or not on the plan', () => expect(r.visitBlock({ ...ok, open: false })).toBe('GYM_VISITS_CLOSED'));
  test('the gym’s own owner or staff', () => expect(r.visitBlock({ ...ok, own: true })).toBe('GYM_VISIT_OWN_GYM'));
  test('already a member with a running membership', () => expect(r.visitBlock({ ...ok, member: true })).toBe('GYM_VISIT_MEMBER'));
  test('a malformed date or time', () => {
    expect(r.visitBlock({ ...ok, date: '10/11/2026' })).toBe('GYM_VISIT_DATE');
    expect(r.visitBlock({ ...ok, arriveAt: '25:00' })).toBe('GYM_VISIT_DATE');
    expect(r.visitBlock({ ...ok, arriveAt: undefined })).toBe('GYM_VISIT_DATE');
  });
  test('a past day or a day beyond the booking window', () => {
    expect(r.visitBlock({ ...ok, date: '2026-11-08' })).toBe('GYM_VISIT_DATE');
    expect(r.visitBlock({ ...ok, date: '2026-11-23' })).toBeNull();
    expect(r.visitBlock({ ...ok, date: '2026-11-24' })).toBe('GYM_VISIT_DATE');
  });
  test('today: a time already past is refused, a later one allowed', () => {
    expect(r.visitBlock({ ...ok, date: '2026-11-09', arriveAt: '09:00', nowMinute: 9 * 60 })).toBe('GYM_VISIT_DATE');
    expect(r.visitBlock({ ...ok, date: '2026-11-09', arriveAt: '18:00', nowMinute: 9 * 60 })).toBeNull();
  });
  test('outside the opening windows (the close time is not inside)', () => {
    expect(r.visitBlock({ ...ok, arriveAt: '12:00' })).toBe('GYM_VISIT_HOURS');
    expect(r.visitBlock({ ...ok, arriveAt: '22:00' })).toBe('GYM_VISIT_HOURS');
    expect(r.visitBlock({ ...ok, arriveAt: '06:00' })).toBeNull();
    expect(r.visitBlock({ ...ok, windows: [] })).toBe('GYM_VISIT_HOURS');
    expect(r.visitBlock({ ...ok, arriveAt: '23:30', windows: [{ openTime: '20:00', closeTime: '24:00' }] })).toBeNull();
  });
  test('the person has used their visits at this gym', () => {
    expect(r.visitBlock({ ...ok, usedByPerson: 1 })).toBe('GYM_VISIT_LIMIT');
    expect(r.visitBlock({ ...ok, usedByPerson: 1, perPerson: 2 })).toBeNull();
  });
  test('the day is full', () => {
    expect(r.visitBlock({ ...ok, bookedThatDay: 5 })).toBe('GYM_VISIT_FULL');
    expect(r.visitBlock({ ...ok, bookedThatDay: 4 })).toBeNull();
  });
  test('the order of the checks', () => {
    expect(r.visitBlock({ ...ok, open: false, own: true, member: true })).toBe('GYM_VISITS_CLOSED');
    expect(r.visitBlock({ ...ok, own: true, member: true })).toBe('GYM_VISIT_OWN_GYM');
    expect(r.visitBlock({ ...ok, arriveAt: '12:00', usedByPerson: 9 })).toBe('GYM_VISIT_HOURS');
    expect(r.visitBlock({ ...ok, usedByPerson: 9, bookedThatDay: 9 })).toBe('GYM_VISIT_LIMIT');
  });
});

describe('M24-FR-112, FR-115 visitCancelBlock', () => {
  const visit = { status: 'booked', visitDate: '2026-11-10', arriveAt: '18:00' };
  const start = r.visitStartAt('2026-11-10', '18:00');
  test('the visit starts at its Dhaka date and time', () => expect(start.toISOString()).toBe('2026-11-10T12:00:00.000Z'));
  test('only a booked visit', () => {
    for (const status of ['attended', 'cancelled', 'no_show']) expect(r.visitCancelBlock({ visit: { ...visit, status }, by: 'guest', now: new Date(0), cutoffMinutes: 60, today: '2026-11-09' })).toBe('GYM_VISIT_STATE');
  });
  test('the guest up to the cutoff before the start', () => {
    const at = (min) => new Date(start.getTime() - min * 60000);
    expect(r.visitCancelBlock({ visit, by: 'guest', now: at(60), cutoffMinutes: 60, today: '2026-11-10' })).toBeNull();
    expect(r.visitCancelBlock({ visit, by: 'guest', now: at(59), cutoffMinutes: 60, today: '2026-11-10' })).toBe('GYM_VISIT_CANCEL_CLOSED');
  });
  test('the gym until the day has passed', () => {
    expect(r.visitCancelBlock({ visit, by: 'gym', now: new Date(start.getTime() + 3600000), cutoffMinutes: 0, today: '2026-11-10' })).toBeNull();
    expect(r.visitCancelBlock({ visit, by: 'gym', now: new Date(start.getTime() + 86400000), cutoffMinutes: 0, today: '2026-11-11' })).toBe('GYM_VISIT_STATE');
  });
});

describe('M24-FR-114 visitCheckInBlock', () => {
  test('a booked visit for today', () => expect(r.visitCheckInBlock({ visit: { status: 'booked', visitDate: '2026-11-09' }, today: '2026-11-09' })).toBeNull());
  test('another day', () => expect(r.visitCheckInBlock({ visit: { status: 'booked', visitDate: '2026-11-10' }, today: '2026-11-09' })).toBe('GYM_VISIT_NOT_TODAY'));
  test('not booked', () => expect(r.visitCheckInBlock({ visit: { status: 'attended', visitDate: '2026-11-09' }, today: '2026-11-09' })).toBe('GYM_VISIT_STATE'));
});

describe('M24-FR-114 the guest’s QR token', () => {
  const token = r.visitToken({ visitId: VISIT, nonce: NONCE }, sign);
  test('shape: v1.gv.<visitId>.<nonce>.<sig>, no personal data', () => {
    expect(token).toMatch(/^v1\.gv\.[0-9a-f-]{36}\.[0-9a-f]{24}\.[0-9a-f]{32}$/);
    expect(r.looksLikeVisitToken(` ${token} `)).toBe(true);
    expect(r.looksLikeVisitToken('v1.gm.x')).toBe(false);
    expect(r.looksLikeVisitToken(null)).toBe(false);
  });
  test('a good token parses, with the default comparison too', () => {
    expect(r.parseVisitToken(token, { sign, equal: (a, b) => a === b })).toEqual({ visitId: VISIT, nonce: NONCE });
    expect(r.parseVisitToken(token, { sign })).toEqual({ visitId: VISIT, nonce: NONCE });
  });
  test('a member token, a bad signature or a malformed token does not', () => {
    const parts = token.split('.');
    expect(r.parseVisitToken(token.replace('v1.gv.', 'v1.gm.'), { sign })).toBeNull();
    expect(r.parseVisitToken(token.replace(/^v1/, 'v2'), { sign })).toBeNull();
    expect(r.parseVisitToken([...parts.slice(0, 4), '0'.repeat(32)].join('.'), { sign })).toBeNull();
    expect(r.parseVisitToken([...parts.slice(0, 4), 'xyz'].join('.'), { sign })).toBeNull();
    expect(r.parseVisitToken(['v1', 'gv', 'not-a-uuid', NONCE, parts[4]].join('.'), { sign })).toBeNull();
    expect(r.parseVisitToken(['v1', 'gv', VISIT, 'ZZ', parts[4]].join('.'), { sign })).toBeNull();
    expect(r.parseVisitToken(parts.slice(0, 4).join('.'), { sign })).toBeNull();
    expect(r.parseVisitToken(undefined, { sign })).toBeNull();
  });
  test('a nonce signed for another visit does not', () => {
    const other = r.visitToken({ visitId: VISIT, nonce: 'ffffffffffffffffffffffff' }, sign).split('.')[4];
    expect(r.parseVisitToken(['v1', 'gv', VISIT, NONCE, other].join('.'), { sign })).toBeNull();
  });
});

describe('M24-FR-114 the desk code', () => {
  test('6 Crockford characters from random bytes', () => {
    expect(r.visitCode(Buffer.from([0, 1, 31, 32, 63, 255, 7]))).toBe('01Z0ZZ');
    for (let i = 0; i < 50; i += 1) expect(r.visitCode(crypto.randomBytes(6))).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  });
  test('typed codes are normalised', () => {
    expect(r.normalizeVisitCode(' ab-c d1 2 ')).toBe('ABCD12');
    expect(r.normalizeVisitCode('oil234')).toBe('011234');
    expect(r.normalizeVisitCode('ABC12U')).toBeNull();
    expect(r.normalizeVisitCode('ABC1')).toBeNull();
    expect(r.normalizeVisitCode(null)).toBeNull();
  });
});

describe('M24-FR-119 no-shows and the Dhaka clock', () => {
  test('a booked visit of a past day is a no-show', () => {
    expect(r.visitNoShow({ status: 'booked', visitDate: '2026-11-08' }, '2026-11-09')).toBe(true);
    expect(r.visitNoShow({ status: 'booked', visitDate: '2026-11-09' }, '2026-11-09')).toBe(false);
    expect(r.visitNoShow({ status: 'attended', visitDate: '2026-11-08' }, '2026-11-09')).toBe(false);
  });
  test('minutes after midnight in Dhaka', () => {
    expect(r.dhakaMinute(new Date('2026-11-09T00:00:00Z'))).toBe(6 * 60);
    expect(r.dhakaMinute(new Date('2026-11-09T18:30:00Z'))).toBe(30);
  });
  test('visits is a Basic-tier feature by default', () => {
    expect(r.FEATURES).toContain('visits');
  });
});
