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
