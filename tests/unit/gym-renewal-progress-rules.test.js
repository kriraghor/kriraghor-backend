'use strict';

// M24 §19 and §20 (product owner, 11 Nov 2026): the pure rules of a member's own renewal (M24-FR-121,
// FR-122, FR-125) and of body progress (M24-FR-128 to FR-130). No database.
const rules = require('../../src/modules/gym-manage/gym-manage.rules');

const TODAY = '2026-11-11';

describe('a member renews by themselves (M24-FR-121, FR-122)', () => {
  const running = { id: 'm1', status: 'active', endsOn: '2026-11-20' };
  const base = { open: true, restricted: false, memberStatus: 'active', latest: running, upcoming: null, today: TODAY, daysBefore: 14 };
  const block = (over = {}) => rules.selfRenewBlock({ ...base, ...over });

  it('lets a member renew inside the days before the end, on the last day and after it', () => {
    expect(block()).toBeNull();
    expect(block({ latest: { ...running, endsOn: '2026-11-25' } })).toBeNull(); // exactly 14 days left
    expect(block({ latest: { ...running, endsOn: TODAY } })).toBeNull();
    expect(block({ latest: { ...running, status: 'frozen' } })).toBeNull();
    // Expired long ago: still open (the dates then start today).
    expect(block({ latest: { id: 'm0', status: 'expired', endsOn: '2026-08-01' }, memberStatus: 'expired' })).toBeNull();
    // `restricted` left out: the gym's panel is not read-only.
    expect(rules.selfRenewBlock({ open: true, memberStatus: 'active', latest: running, upcoming: null, today: TODAY, daysBefore: 14 })).toBeNull();
  });

  it('refuses in order: switched off, read-only, left or removed, a renewal waiting, nothing to renew, too early', () => {
    expect(block({ open: false, restricted: true, memberStatus: 'left' })).toEqual({ code: 'GYM_SELF_RENEW_OFF', meta: { reason: 'off' } });
    expect(block({ restricted: true, memberStatus: 'left' })).toEqual({ code: 'GYM_SELF_RENEW_OFF', meta: { reason: 'restricted' } });
    expect(block({ memberStatus: 'left', upcoming: { id: 'm2' } })).toEqual({ code: 'GYM_MEMBER_STATE', meta: { reason: 'left' } });
    expect(block({ memberStatus: 'removed' })).toEqual({ code: 'GYM_MEMBER_STATE', meta: { reason: 'removed' } });
    expect(block({ upcoming: { id: 'm2' }, latest: null })).toEqual({ code: 'GYM_RENEWAL_EXISTS', meta: { membershipId: 'm2' } });
    expect(block({ latest: null })).toEqual({ code: 'GYM_NOTHING_TO_RENEW' });
    expect(block({ latest: { ...running, endsOn: '2026-11-26' } })).toEqual({ code: 'GYM_RENEW_TOO_EARLY', meta: { from: '2026-11-12' } });
    expect(block({ latest: { ...running, status: 'frozen', endsOn: '2027-01-10' }, daysBefore: 30 })).toEqual({ code: 'GYM_RENEW_TOO_EARLY', meta: { from: '2026-12-11' } });
  });

  it('lets a member take back only a renewal they made, not started and unpaid (M24-FR-125)', () => {
    const mine = { createdVia: 'member', status: 'upcoming' };
    expect(rules.selfRenewCancelBlock({ membership: mine })).toBeNull();
    expect(rules.selfRenewCancelBlock({ membership: mine, paidPoisha: 0 })).toBeNull();
    expect(rules.selfRenewCancelBlock({ membership: null })).toEqual({ code: 'GYM_NOTHING_TO_RENEW' });
    expect(rules.selfRenewCancelBlock({ membership: { ...mine, createdVia: 'desk' } })).toEqual({ code: 'GYM_MEMBERSHIP_STATE', meta: { reason: 'made_at_desk' } });
    expect(rules.selfRenewCancelBlock({ membership: { ...mine, status: 'active' } })).toEqual({ code: 'GYM_MEMBERSHIP_STATE', meta: { reason: 'active' } });
    expect(rules.selfRenewCancelBlock({ membership: mine, paidPoisha: 100 })).toEqual({ code: 'GYM_MEMBERSHIP_STATE', meta: { reason: 'paid' } });
  });
});

describe('body progress (M24-FR-128 to FR-130)', () => {
  const none = { weightKg: null, bodyFatPct: null, chestCm: null, waistCm: null, hipsCm: null, armCm: null, thighCm: null };
  const block = (values, over = {}) => rules.bodyEntryBlock({ values: { ...none, ...values }, measuredOn: TODAY, today: TODAY, backdateDays: 365, ...over });

  it('is a plan feature, and knows which measurements were given', () => {
    expect(rules.FEATURES).toContain('progress');
    expect(Object.keys(rules.BODY_FIELDS)).toEqual(['weightKg', 'bodyFatPct', 'chestCm', 'waistCm', 'hipsCm', 'armCm', 'thighCm']);
    expect(rules.bodyGiven({ ...none, weightKg: 70, waistCm: 80 })).toEqual(['weightKg', 'waistCm']);
    expect(rules.bodyGiven({ weightKg: undefined })).toEqual([]);
  });

  it('accepts one measurement or all of them, at the edges of each range and of the dates', () => {
    expect(block({ weightKg: 72.5 })).toBeNull();
    expect(block({ weightKg: 10, bodyFatPct: 2, chestCm: 10, waistCm: 10, hipsCm: 10, armCm: 10, thighCm: 10 })).toBeNull();
    expect(block({ weightKg: 400, bodyFatPct: 70, chestCm: 300, waistCm: 300, hipsCm: 300, armCm: 300, thighCm: 300 })).toBeNull();
    expect(block({ waistCm: 82 }, { measuredOn: '2025-11-11' })).toBeNull(); // 365 days back
    expect(block({ waistCm: 82 }, { backdateDays: 0 })).toBeNull();
  });

  it('refuses an empty entry, a value outside its range, and a date ahead or too far back', () => {
    expect(block({})).toEqual({ code: 'GYM_BODY_EMPTY' });
    expect(block({ weightKg: 9.9 })).toEqual({ code: 'GYM_BODY_RANGE', meta: { field: 'weightKg', min: 10, max: 400 } });
    expect(block({ weightKg: 70, bodyFatPct: 70.1 })).toEqual({ code: 'GYM_BODY_RANGE', meta: { field: 'bodyFatPct', min: 2, max: 70 } });
    expect(block({ thighCm: 301 })).toEqual({ code: 'GYM_BODY_RANGE', meta: { field: 'thighCm', min: 10, max: 300 } });
    expect(block({ weightKg: 70 }, { measuredOn: '2026-11-12' })).toEqual({ code: 'GYM_DATE_OUT_OF_RANGE', meta: { from: '2025-11-11', to: TODAY } });
    expect(block({ weightKg: 70 }, { measuredOn: '2025-11-10' })).toEqual({ code: 'GYM_DATE_OUT_OF_RANGE', meta: { from: '2025-11-11', to: TODAY } });
    expect(block({ weightKg: 70 }, { measuredOn: '2026-11-10', backdateDays: 0 })).toEqual({ code: 'GYM_DATE_OUT_OF_RANGE', meta: { from: TODAY, to: TODAY } });
  });

  it('orders the entries, adds the BMI at the member’s height, and gives the change from the first to the latest', () => {
    const entries = [
      { measuredOn: '2026-11-01', ...none, weightKg: 78.4, waistCm: 90 },
      { measuredOn: '2026-09-01', ...none, weightKg: 82, waistCm: 94.5 },
      { measuredOn: '2026-10-01', ...none, waistCm: 92, armCm: 33 },
    ];
    const p = rules.progressOf(entries, 175);
    expect(p.series.map((e) => e.measuredOn)).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
    expect(p.series.map((e) => e.bmi)).toEqual([26.8, null, 25.6]);
    expect(p.change.weightKg).toEqual({ from: 82, to: 78.4, delta: -3.6, fromOn: '2026-09-01', toOn: '2026-11-01' });
    expect(p.change.waistCm).toEqual({ from: 94.5, to: 90, delta: -4.5, fromOn: '2026-09-01', toOn: '2026-11-01' });
    // One entry with an arm measurement, none with body fat: nothing to compare.
    expect(p.change.armCm).toBeNull();
    expect(p.change.bodyFatPct).toBeNull();
    // The input is not reordered.
    expect(entries[0].measuredOn).toBe('2026-11-01');
  });

  it('gives no BMI without a height, and nothing at all without entries', () => {
    expect(rules.progressOf([{ measuredOn: TODAY, ...none, weightKg: 70 }]).series[0].bmi).toBeNull();
    expect(rules.progressOf([{ measuredOn: TODAY, ...none, weightKg: 70 }], null).change.weightKg).toBeNull();
    const empty = rules.progressOf([]);
    expect(empty.series).toEqual([]);
    expect(Object.values(empty.change).every((x) => x === null)).toBe(true);
  });
});
