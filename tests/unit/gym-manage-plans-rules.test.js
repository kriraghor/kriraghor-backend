'use strict';

/**
 * M24 prompt 3 rules, pure, at 100% branch coverage with the prompt 1 and 2 files: the entrance QR token
 * (M24-FR-51), the plan day mapping (§6.10), the plan content limits from settings (M24-FR-62), the tick
 * window (M24-FR-65), the latest tick per item and date, and the member's read-only plans (M24-FR-67).
 */
require('../env');
const crypto = require('crypto');
const r = require('../../src/modules/gym-manage/gym-manage.rules');

const sign = (text) => crypto.createHmac('sha256', 'test-secret').update(text).digest('hex');
const GYM = '01936f3a-0000-7000-8000-0000000000aa';

describe('the entrance QR (M24-FR-51)', () => {
  const seconds = 30;
  const now = Date.parse('2026-11-03T04:00:10Z');
  const w = r.windowOf(now, seconds);
  const token = r.entranceToken({ gymId: GYM, window: w }, sign);

  it('v1.ge.<gymId>.<window>.<sig>: the current and the previous window, never two windows ago', () => {
    expect(token).toMatch(new RegExp(`^v1\\.ge\\.${GYM}\\.${w}\\.[0-9a-f]{32}$`));
    expect(r.parseEntranceToken(token, { sign, nowMs: now, seconds })).toEqual({ gymId: GYM });
    expect(r.parseEntranceToken(token, { sign, nowMs: now + seconds * 1000, seconds })).toEqual({ gymId: GYM });
    expect(r.parseEntranceToken(token, { sign, nowMs: now + 2 * seconds * 1000, seconds })).toBeNull();
    // A future window is not accepted either.
    expect(r.parseEntranceToken(r.entranceToken({ gymId: GYM, window: w + 1 }, sign), { sign, nowMs: now, seconds })).toBeNull();
  });

  it('domain separation: a member QR signature or a tampered token fails', () => {
    const memberSig = sign(`gym-member:${GYM}:${w}`).slice(0, 32);
    expect(r.parseEntranceToken(`v1.ge.${GYM}.${w}.${memberSig}`, { sign, nowMs: now, seconds })).toBeNull();
    expect(r.parseEntranceToken(token.replace(/.$/, (ch) => (ch === 'a' ? 'b' : 'a')), { sign, nowMs: now, seconds })).toBeNull();
    // The member QR prefix is not an entrance token.
    expect(r.parseEntranceToken(r.memberToken({ memberId: GYM, window: w }, sign), { sign, nowMs: now, seconds })).toBeNull();
    for (const bad of ['', undefined, 'v1.ge.x.1.y', `v2.ge.${GYM}.${w}.${'a'.repeat(32)}`, `v1.ge.${GYM}.abc.${'a'.repeat(32)}`, `v1.ge.${GYM}.${w}.zz`, `v1.ge.${GYM}.${w}`]) {
      expect(r.parseEntranceToken(bad, { sign, nowMs: now, seconds })).toBeNull();
    }
    expect(r.parseEntranceToken(token, { sign, equal: () => false, nowMs: now, seconds })).toBeNull();
  });

  it('seconds left in the window', () => {
    expect(r.secondsLeft(now, seconds)).toBe(20);
    expect(r.secondsLeft(Date.parse('2026-11-03T04:00:00Z'), seconds)).toBe(30);
  });
});

const workout = {
  kind: 'workout',
  days: [
    { key: 'd1', name: { en: 'Chest' }, items: [{ ref: 'i1', name: { en: 'Bench press' } }, { ref: 'i2', name: { en: 'Dips' } }] },
    { key: 'd2', name: { en: 'Legs' }, items: [{ ref: 'i3', name: { en: 'Squat' } }] },
    { key: 'd3', name: { en: 'Rest' }, items: [] },
  ],
};
const diet = {
  kind: 'diet',
  meals: [
    { ref: 'm1', name: { en: 'Breakfast' }, items: [{ ref: 'f1', name: { en: 'Two eggs' } }] },
    { ref: 'm2', name: { en: 'Lunch' }, items: [{ ref: 'f2', name: { en: 'Rice' } }, { ref: 'f3', name: { en: 'Fish' } }] },
  ],
};

describe('the plan day mapping (§6.10)', () => {
  it('days[(date − starts_on) mod days.length]; null before the start, after the end, or with no days', () => {
    const a = { startsOn: '2026-11-01', endsOn: '2026-11-10', days: 3 };
    expect(r.dayIndexFor({ ...a, date: '2026-11-01' })).toBe(0);
    expect(r.dayIndexFor({ ...a, date: '2026-11-03' })).toBe(2);
    expect(r.dayIndexFor({ ...a, date: '2026-11-04' })).toBe(0);
    expect(r.dayIndexFor({ ...a, date: '2026-11-10' })).toBe(0);
    expect(r.dayIndexFor({ ...a, date: '2026-10-31' })).toBeNull();
    expect(r.dayIndexFor({ ...a, date: '2026-11-11' })).toBeNull();
    expect(r.dayIndexFor({ startsOn: '2026-11-01', days: 3, date: '2027-01-01' })).toBe(61 % 3);
    expect(r.dayIndexFor({ startsOn: '2026-11-01', days: 0, date: '2026-11-01' })).toBeNull();
  });

  it('the week: today and the next six days', () => {
    const week = r.weekOf({ today: '2026-10-30', startsOn: '2026-11-01', endsOn: '2026-11-03', days: 3 });
    expect(week.map((d) => [d.date, d.index])).toEqual([
      ['2026-10-30', null],
      ['2026-10-31', null],
      ['2026-11-01', 0],
      ['2026-11-02', 1],
      ['2026-11-03', 2],
      ['2026-11-04', null],
      ['2026-11-05', null],
    ]);
    expect(r.weekOf({ today: '2026-11-01', startsOn: '2026-11-01', days: 1 }).every((d) => d.index === 0)).toBe(true);
  });

  it('items of a plan, and the refs a member may tick on a date', () => {
    expect(r.itemsOf(workout).map((i) => i.ref)).toEqual(['i1', 'i2', 'i3']);
    expect(r.itemsOf(diet).map((i) => i.ref)).toEqual(['f1', 'f2', 'f3']);
    const a = { startsOn: '2026-11-01', endsOn: '2026-11-30' };
    expect([...r.itemRefsFor(workout, { ...a, date: '2026-11-01' })]).toEqual(['i1', 'i2']);
    expect([...r.itemRefsFor(workout, { ...a, date: '2026-11-02' })]).toEqual(['i3']);
    expect([...r.itemRefsFor(workout, { ...a, date: '2026-11-03' })]).toEqual([]);
    expect(r.itemRefsFor(workout, { ...a, date: '2026-10-31' })).toBeNull();
    expect([...r.itemRefsFor(diet, { ...a, date: '2026-11-15' })]).toEqual(['f1', 'f2', 'f3']);
    expect(r.itemRefsFor(diet, { ...a, date: '2026-10-31' })).toBeNull();
    expect(r.itemRefsFor(diet, { ...a, date: '2026-12-01' })).toBeNull();
    expect([...r.itemRefsFor(diet, { startsOn: '2026-11-01', date: '2027-06-01' })]).toEqual(['f1', 'f2', 'f3']);
  });
});

describe('the plan content limits (M24-FR-62)', () => {
  const lim = { maxItems: 2, maxMeals: 2 };
  it('a plan within the limits has no errors', () => {
    expect(r.planContentErrors(workout, lim)).toEqual([]);
    expect(r.planContentErrors(diet, lim)).toEqual([]);
  });
  it('too many items per day or meal, too many meals', () => {
    expect(r.planContentErrors(workout, { maxItems: 1, maxMeals: 2 })).toEqual([{ field: 'content.days[0].items', message: 'At most 1 items' }]);
    expect(r.planContentErrors(diet, { maxItems: 2, maxMeals: 1 })).toEqual([{ field: 'content.meals', message: 'At most 1 meals' }]);
    expect(r.planContentErrors(diet, { maxItems: 1, maxMeals: 2 })).toEqual([{ field: 'content.meals[1].items', message: 'At most 1 items' }]);
  });
  it('day keys, meal refs and item refs are unique in the plan (ticks stay attached across versions)', () => {
    const dupDays = { kind: 'workout', days: [workout.days[0], { ...workout.days[1], key: 'd1', items: [{ ref: 'i1', name: { en: 'Again' } }] }] };
    expect(r.planContentErrors(dupDays, lim)).toEqual([
      { field: 'content.days[1].key', message: 'Must be unique in the plan' },
      { field: 'content.days[1].items[0].ref', message: 'Must be unique in the plan' },
    ]);
    const dupMeals = { kind: 'diet', meals: [diet.meals[0], { ...diet.meals[0] }] };
    expect(r.planContentErrors(dupMeals, lim)).toEqual([
      { field: 'content.meals[1].ref', message: 'Must be unique in the plan' },
      { field: 'content.meals[1].items[0].ref', message: 'Must be unique in the plan' },
    ]);
  });
});

describe('ticks (M24-FR-65, FR-67)', () => {
  const a = { today: '2026-11-10', backDays: 7, startsOn: '2026-11-01' };
  it('today and up to plan_log_back_days back, inside the assignment', () => {
    expect(r.logWindowBlock({ ...a, localDate: '2026-11-10' })).toBeNull();
    expect(r.logWindowBlock({ ...a, localDate: '2026-11-03' })).toBeNull();
    expect(r.logWindowBlock({ ...a, localDate: '2026-11-02' })).toBe('GYM_PLAN_LOG_WINDOW');
    expect(r.logWindowBlock({ ...a, localDate: '2026-11-11' })).toBe('GYM_PLAN_LOG_WINDOW');
    expect(r.logWindowBlock({ ...a, startsOn: '2026-11-08', localDate: '2026-11-07' })).toBe('GYM_PLAN_LOG_WINDOW');
    expect(r.logWindowBlock({ ...a, endsOn: '2026-11-08', localDate: '2026-11-09' })).toBe('GYM_PLAN_LOG_WINDOW');
    expect(r.logWindowBlock({ ...a, endsOn: '2026-11-08', localDate: '2026-11-08' })).toBeNull();
    expect(r.logWindowBlock({ ...a, backDays: 0, localDate: '2026-11-09' })).toBe('GYM_PLAN_LOG_WINDOW');
  });
  it('the latest tick per item and date wins (rows newest first)', () => {
    const rows = [
      { id: 3, localDate: '2026-11-10', itemRef: 'i1', done: false },
      { id: 2, localDate: '2026-11-10', itemRef: 'i1', done: true },
      { id: 1, localDate: '2026-11-09', itemRef: 'i1', done: true },
    ];
    const m = r.latestLogs(rows);
    expect([...m.keys()]).toEqual(['2026-11-10|i1', '2026-11-09|i1']);
    expect(m.get('2026-11-10|i1').id).toBe(3);
  });
  it('read-only: ended or replaced, unlinked, left or removed', () => {
    expect(r.planReadOnly({ assignmentStatus: 'active', linked: true, memberStatus: 'active' })).toBe(false);
    expect(r.planReadOnly({ assignmentStatus: 'ended', linked: true, memberStatus: 'active' })).toBe(true);
    expect(r.planReadOnly({ assignmentStatus: 'active', linked: false, memberStatus: 'active' })).toBe(true);
    expect(r.planReadOnly({ assignmentStatus: 'active', linked: true, memberStatus: 'left' })).toBe(true);
    expect(r.planReadOnly({ assignmentStatus: 'active', linked: true, memberStatus: 'removed' })).toBe(true);
    expect(r.PLAN_KINDS).toEqual(['workout', 'diet']);
  });
});
