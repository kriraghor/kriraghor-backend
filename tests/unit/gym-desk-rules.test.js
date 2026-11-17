'use strict';

// M24 §21 desk mode with a PIN (product owner, 11 Nov 2026; ADR-010): the pure rules. Which PINs are too
// easy (M24-FR-134), what a wrong PIN does (FR-137), where a request of a device in desk mode may go
// (FR-139) and when an unlock runs out (FR-136). No database.
const rules = require('../../src/modules/gym-manage/gym-manage.rules');

describe('a desk PIN (M24-FR-134)', () => {
  const block = (pin, phoneLast4) => rules.deskPinBlock({ pin, phoneLast4 });

  it('accepts four digits that are not easy to guess', () => {
    for (const pin of ['2580', '1357', '9041', '1213', '0102', '1235']) expect(block(pin, '5678')).toBeNull();
    // No phone given: nothing to compare with.
    expect(rules.deskPinBlock({ pin: '5802' })).toBeNull();
    expect(block('5802', null)).toBeNull();
  });

  it('refuses anything that is not exactly four digits', () => {
    for (const pin of ['', '123', '12345', '12a4', ' 1234', '١٢٣٤', null, undefined, 1234.5]) expect(block(pin, '5678')).toBe('format');
    // A number of four digits reads as its digits.
    expect(block(2580, '5678')).toBeNull();
  });

  it('refuses one digit four times, and a run up or down', () => {
    for (const pin of ['0000', '1111', '9999']) expect(block(pin)).toBe('repeat');
    for (const pin of ['0123', '1234', '6789', '9876', '4321', '3210']) expect(block(pin)).toBe('run');
    // A step of two, or a run that breaks, is not a run.
    expect(block('1357')).toBeNull();
    expect(block('1235')).toBeNull();
    expect(block('1243')).toBeNull();
  });

  it('refuses the last four digits of the person’s own phone', () => {
    expect(block('4471', '4471')).toBe('phone');
    expect(block('4471', 4471)).toBe('phone');
    expect(block('4471', '4472')).toBeNull();
  });
});

describe('a wrong PIN (M24-FR-137)', () => {
  const wrong = (failed, lockouts) => rules.deskPinWrong({ failed, lockouts, failLimit: 5, maxLockouts: 3 });

  it('counts down the tries, then locks, and clears the PIN after the last lockout in a row', () => {
    expect(wrong(1, 0)).toEqual({ lock: false, clear: false, left: 4 });
    expect(wrong(4, 0)).toEqual({ lock: false, clear: false, left: 1 });
    expect(wrong(5, 0)).toEqual({ lock: true, clear: false, left: 0 });
    expect(wrong(5, 1)).toEqual({ lock: true, clear: false, left: 0 });
    expect(wrong(5, 2)).toEqual({ lock: true, clear: true, left: 0 });
    // Tries that raced past the limit lock as well.
    expect(wrong(7, 0)).toEqual({ lock: true, clear: false, left: 0 });
  });
});

describe('where a device in desk mode may go (M24-FR-139)', () => {
  const G = '01a1c473-e48b-7e09-8887-53ba8a4eeab3';
  const OTHER = '01a1c473-de0d-7462-9138-d78ae85b1029';
  const route = (method, path) => rules.deskRoute({ method, path, gymId: G });

  it('always lets the desk-mode endpoints and sign-out through', () => {
    expect(route('GET', '/manage/desk-mode')).toBe('control');
    expect(route('POST', '/manage/desk-mode/unlock')).toBe('control');
    expect(route('POST', '/manage/desk-mode/close/')).toBe('control');
    expect(route('GET', '/manage/desk-mode?x=1')).toBe('control');
    expect(route('POST', '/auth/logout')).toBe('control');
  });

  it('sends the desk gym’s panel, the list of gyms and the gym’s pass desk through the lock', () => {
    expect(route('GET', `/manage/gyms/${G}`)).toBe('gym');
    expect(route('POST', `/manage/gyms/${G}/dues/x/payments`)).toBe('gym');
    expect(route('GET', `/manage/gyms/${G}/members?q=rafi`)).toBe('gym');
    expect(route('GET', '/manage/gyms')).toBe('gym');
    expect(route('POST', `/me/gyms/${G}/redemptions`)).toBe('gym');
    expect(route('GET', `/me/gyms/${G}/passes`)).toBe('gym');
    // The panel's header and workplace list, as the unlocked person.
    expect(route('GET', '/me')).toBe('gym');
    expect(route('GET', '/me/workplaces/')).toBe('gym');
  });

  it('refuses everything else: another gym, billing, the listing, the account, other sign-out verbs', () => {
    expect(route('GET', `/manage/gyms/${OTHER}/members`)).toBe('outside');
    expect(route('GET', `/manage/gyms/${G}x`)).toBe('outside');
    expect(route('POST', '/manage/gyms')).toBe('outside');
    expect(route('GET', '/manage/billing')).toBe('outside');
    expect(route('GET', '/manage/desk-modes')).toBe('outside');
    expect(route('PUT', `/me/gyms/${G}/packages`)).toBe('outside');
    expect(route('GET', `/me/gyms/${OTHER}/passes`)).toBe('outside');
    expect(route('GET', '/me/gym-memberships')).toBe('outside');
    expect(route('PUT', '/me/gym-desk-pin')).toBe('outside');
    expect(route('GET', '/auth/logout')).toBe('outside');
    expect(route('POST', '/auth/step-up')).toBe('outside');
    expect(route('GET', '/me/notifications')).toBe('outside');
    expect(route('PATCH', '/me')).toBe('outside');
    expect(route('POST', '/me/workplaces/x/leave')).toBe('outside');
  });
});

describe('an unlock and its idle time (M24-FR-136)', () => {
  const now = new Date('2026-11-11T10:00:00.000Z');

  it('runs out the idle minutes after the last touch', () => {
    expect(rules.deskIdleUntil(now, 5).toISOString()).toBe('2026-11-11T10:05:00.000Z');
    expect(rules.deskIdleUntil(now, 1).toISOString()).toBe('2026-11-11T10:01:00.000Z');
  });

  it('is live only while it has not ended and its time has not passed', () => {
    const u = { endedAt: null, expiresAt: '2026-11-11T10:00:00.001Z' };
    expect(rules.deskUnlockLive(u, now)).toBe(true);
    expect(rules.deskUnlockLive({ ...u, expiresAt: now }, now)).toBe(false);
    expect(rules.deskUnlockLive({ ...u, expiresAt: '2026-11-11T09:59:59.000Z' }, now)).toBe(false);
    expect(rules.deskUnlockLive({ ...u, endedAt: '2026-11-11T09:58:00.000Z' }, now)).toBe(false);
    expect(rules.deskUnlockLive(null, now)).toBe(false);
    expect(rules.deskUnlockLive(undefined, now)).toBe(false);
  });

  it('counts desk mode as a plan feature', () => {
    expect(rules.FEATURES).toContain('desk_mode');
  });
});

// M24 §22 the desk through a lost connection: the desk copy's stamp, when an item was taken, what parks it,
// who it is recorded for, its outcome, and how the owner may resolve it (M24-FR-144 to FR-150).
describe('the desk copy and offline items (M24 §22)', () => {
  const sign = (t) => require('crypto').createHash('sha256').update(`k:${t}`).digest('hex');
  const GYM = '0190a0a0-0000-7000-8000-00000000000a';

  it('signs the copy with the gym and the server time, and reads only its own stamps', () => {
    const stamp = rules.snapshotStamp({ gymId: GYM, ms: 1763370000000 }, sign);
    expect(rules.parseSnapshotStamp(stamp, { sign })).toEqual({ gymId: GYM, ms: 1763370000000 });
    // Default comparison, a changed time, a changed signature, the wrong shape.
    expect(rules.parseSnapshotStamp(stamp.replace('1763370000000', '1763370000001'), { sign, equal: (a, b) => a === b })).toBeNull();
    expect(rules.parseSnapshotStamp(`${stamp.slice(0, -1)}${stamp.endsWith('0') ? '1' : '0'}`, { sign })).toBeNull();
    for (const bad of [null, undefined, '', 'v1.gso', stamp.replace('v1.', 'v2.'), stamp.replace('.gso.', '.gm.'), stamp.replace(GYM, 'not-a-uuid'), `v1.gso.${GYM}.12a.${'0'.repeat(32)}`, `v1.gso.${GYM}.1.short`, `${stamp}.x`]) {
      expect(rules.parseSnapshotStamp(bad, { sign })).toBeNull();
    }
  });

  it('puts a member in the copy with today’s flags and decision', () => {
    const member = { id: 'm1', memberCode: 'IY-0001', displayName: 'Rafiq', phoneLast4: '0222' };
    const current = { title: 'Monthly', endsOn: '2026-11-20', status: 'active', visitLimit: null };
    expect(rules.snapshotMember({ member, current, hadMembership: true, overdue: false, policy: 'block', today: '2026-11-17', inToday: true })).toEqual({
      id: 'm1',
      memberCode: 'IY-0001',
      displayName: 'Rafiq',
      phoneLast4: '0222',
      package: { title: 'Monthly', endsOn: '2026-11-20', status: 'active' },
      flags: ['expiring'],
      reasons: [],
      decision: 'allow',
      inToday: true,
    });
    const none = rules.snapshotMember({ member: { ...member, phoneLast4: undefined }, current: null, hadMembership: false, overdue: true, policy: 'block', today: '2026-11-17' });
    expect(none).toMatchObject({ phoneLast4: null, package: null, reasons: ['none', 'unpaid'], decision: 'block', inToday: false });
  });

  it('dates an item by the copy’s server time plus the time on the device; ahead is set to now, old is late', () => {
    const at = (stampMs, elapsedMs, nowMs = 10_000_000) => rules.offlineTakenAt({ stampMs, elapsedMs, nowMs, maxHours: 1, skewSeconds: 60 });
    expect(at(9_000_000, 500_000)).toEqual({ at: new Date(9_500_000), flags: [] });
    // Within the skew but after now: now, no flag.
    expect(at(9_000_000, 1_030_000)).toEqual({ at: new Date(10_000_000), flags: [] });
    expect(at(9_000_000, 1_060_001)).toEqual({ at: new Date(10_000_000), flags: ['time_adjusted'] });
    expect(at(5_000_000, 1_399_999)).toEqual({ at: new Date(6_399_999), flags: ['late'] });
    expect(at(5_000_000, 1_400_000)).toEqual({ at: new Date(6_400_000), flags: [] });
  });

  it('parks what cannot be applied', () => {
    const due = (o = {}) => ({ amountPoisha: 350000, paidPoisha: 100000, waivedPoisha: 0, status: 'partial', ...o });
    expect(rules.offlinePark({ kind: 'checkin', memberStatus: 'active' })).toBeNull();
    expect(rules.offlinePark({ kind: 'checkin', memberStatus: 'left' })).toBe('member_left');
    expect(rules.offlinePark({ kind: 'checkin', memberStatus: 'removed' })).toBe('member_removed');
    expect(rules.offlinePark({ kind: 'cash_fee', memberStatus: 'removed', due: due(), amount: 1 })).toBe('member_removed');
    expect(rules.offlinePark({ kind: 'cash_fee', memberStatus: 'left', due: due(), amount: 250000 })).toBeNull();
    expect(rules.offlinePark({ kind: 'cash_fee', memberStatus: 'active', due: due(), amount: 250001 })).toBe('due_changed');
    expect(rules.offlinePark({ kind: 'cash_fee', memberStatus: 'active', due: due({ paidPoisha: 350000, status: 'paid' }), amount: 100 })).toBe('due_paid');
    expect(rules.offlinePark({ kind: 'cash_fee', memberStatus: 'active', due: due({ paidPoisha: 0, waivedPoisha: 350000, status: 'waived' }), amount: 100 })).toBe('due_paid');
    expect(rules.offlinePark({ kind: 'cash_fee', memberStatus: 'active', due: due({ status: 'void' }), amount: 100 })).toBe('due_void');
    // The amount defaults to nothing.
    expect(rules.offlinePark({ kind: 'cash_fee', memberStatus: 'active', due: due() })).toBeNull();
  });

  it('records the person the device names when they work there; confirms them by sender or unlock', () => {
    const t = (o) => rules.offlineTaker({ takenBy: 'a', senderId: 'a', eligible: true, unlockMatches: false, pinOnDevice: false, ...o });
    expect(t({})).toEqual({ recordedAs: 'a', flags: [] });
    expect(t({ senderId: 'b', unlockMatches: true })).toEqual({ recordedAs: 'a', flags: [] });
    expect(t({ senderId: 'b' })).toEqual({ recordedAs: 'a', flags: ['unverified_taker'] });
    expect(t({ senderId: 'b', eligible: false, unlockMatches: true })).toEqual({ recordedAs: 'b', flags: ['unverified_taker'] });
    expect(t({ senderId: 'b', pinOnDevice: true })).toEqual({ recordedAs: 'a', flags: ['pin_on_device'] });
  });

  it('gives the outcome and the resolutions an item allows', () => {
    expect(rules.offlineOutcome({ park: 'due_paid', flags: ['late'] })).toBe('parked');
    expect(rules.offlineOutcome({ park: null, flags: ['late'] })).toBe('flagged');
    expect(rules.offlineOutcome({ park: null, flags: [] })).toBe('applied');
    const block = (item, action) => rules.offlineResolveBlock({ item: { resolution: null, ...item }, action });
    expect(block({ outcome: 'applied', kind: 'checkin' }, 'checked')).toBe('GYM_OFFLINE_ITEM_STATE');
    expect(block({ outcome: 'flagged', kind: 'checkin', resolution: 'checked' }, 'checked')).toBe('GYM_OFFLINE_ITEM_STATE');
    expect(block({ outcome: 'flagged', kind: 'cash_fee' }, 'checked')).toBeNull();
    expect(block({ outcome: 'flagged', kind: 'cash_fee' }, 'apply')).toBe('GYM_OFFLINE_ITEM_STATE');
    expect(block({ outcome: 'parked', kind: 'checkin' }, 'checked')).toBeNull();
    expect(block({ outcome: 'parked', kind: 'checkin' }, 'returned')).toBe('GYM_OFFLINE_ITEM_STATE');
    expect(block({ outcome: 'parked', kind: 'cash_fee' }, 'checked')).toBe('GYM_OFFLINE_ITEM_STATE');
    expect(block({ outcome: 'parked', kind: 'cash_fee' }, 'apply')).toBeNull();
    expect(block({ outcome: 'parked', kind: 'cash_fee' }, 'returned')).toBeNull();
  });
});
