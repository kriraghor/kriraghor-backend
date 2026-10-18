'use strict';

// M16 teams and players: pure rules at 100% (names, short codes, invites, succession, age, eligibility).
const R = require('../../src/modules/teams/teams.rules');

describe('M16 teams.rules', () => {
  it('checks team names and short codes', () => {
    expect(R.nameBlock('Gulshan Gladiators')).toBeNull();
    expect(R.nameBlock(' A ')).toBe('TEAM_NAME_INVALID');
    expect(R.nameBlock('x'.repeat(41))).toBe('TEAM_NAME_INVALID');
    expect(R.nameBlock('Visit www.example.com')).toBe('TEAM_NAME_INVALID');
    expect(R.nameBlock('Kings https://x')).toBe('TEAM_NAME_INVALID');
    expect(R.nameBlock('Call 01711000000')).toBe('TEAM_NAME_INVALID');
    expect(R.nameBlock(undefined)).toBe('TEAM_NAME_INVALID');
    expect(R.shortCode(undefined)).toEqual({ value: null });
    expect(R.shortCode('')).toEqual({ value: null });
    expect(R.shortCode(null)).toEqual({ value: null });
    expect(R.shortCode(' ggl ')).toEqual({ value: 'GGL' });
    expect(R.shortCode('G')).toEqual({ error: 'TEAM_SHORT_CODE_INVALID' });
    expect(R.shortCode('G-L')).toEqual({ error: 'TEAM_SHORT_CODE_INVALID' });
  });

  it('knows who manages a team', () => {
    expect(R.canManage('captain')).toBe(true);
    expect(R.canManage('vice_captain')).toBe(true);
    expect(R.canManage('player')).toBe(false);
    expect(R.isCaptain('captain')).toBe(true);
    expect(R.isCaptain('vice_captain')).toBe(false);
  });

  it('checks invites, resends and accepts', () => {
    const base = { teamStatus: 'active', selfInvite: false, alreadyMember: false, activeCount: 5, maxMembers: 30 };
    expect(R.inviteBlock(base)).toBeNull();
    expect(R.inviteBlock({ ...base, teamStatus: 'archived' })).toBe('TEAM_ARCHIVED');
    expect(R.inviteBlock({ ...base, selfInvite: true })).toBe('INVITE_SELF');
    expect(R.inviteBlock({ ...base, alreadyMember: true })).toBe('ALREADY_MEMBER');
    expect(R.inviteBlock({ ...base, activeCount: 30 })).toBe('TEAM_FULL');

    const now = new Date('2026-11-10T12:00:00Z');
    const inv = { status: 'pending', createdAt: '2026-11-10T11:30:00Z', resentAt: null, expiresAt: '2026-11-17T12:00:00Z' };
    expect(R.resendBlock(inv, now, 60)).toBe('INVITE_RESEND_TOO_SOON');
    expect(R.resendBlock({ ...inv, createdAt: '2026-11-10T10:00:00Z' }, now, 60)).toBeNull();
    expect(R.resendBlock({ ...inv, createdAt: '2026-11-09T10:00:00Z', resentAt: '2026-11-10T11:45:00Z' }, now, 60)).toBe('INVITE_RESEND_TOO_SOON');
    expect(R.resendBlock({ ...inv, status: 'accepted' }, now, 60)).toBe('INVITE_STATE');

    const a = { invite: inv, now, teamStatus: 'active', accountActive: true, alreadyMember: false, activeCount: 5, maxMembers: 30, memberships: 1, maxMemberships: 10 };
    expect(R.acceptBlock(a)).toBeNull();
    expect(R.acceptBlock({ ...a, invite: { ...inv, status: 'cancelled' } })).toBe('INVITE_STATE');
    expect(R.acceptBlock({ ...a, invite: { ...inv, expiresAt: '2026-11-10T12:00:00Z' } })).toBe('INVITE_EXPIRED');
    expect(R.acceptBlock({ ...a, accountActive: false })).toBe('ACCOUNT_INACTIVE');
    expect(R.acceptBlock({ ...a, teamStatus: 'archived' })).toBe('TEAM_ARCHIVED');
    expect(R.acceptBlock({ ...a, alreadyMember: true })).toBe('ALREADY_MEMBER');
    expect(R.acceptBlock({ ...a, activeCount: 30 })).toBe('TEAM_FULL');
    expect(R.acceptBlock({ ...a, memberships: 10 })).toBe('TOO_MANY_TEAMS');
  });

  it('passes the captaincy to the vice-captain, else the longest-serving member, else nobody', () => {
    const m = (userId, role, joinedAt) => ({ userId, role, joinedAt });
    expect(R.successor([m('a', 'player', '2026-01-02'), m('b', 'vice_captain', '2026-03-01')])).toBe('b');
    expect(R.successor([m('a', 'player', '2026-02-02'), m('c', 'player', '2026-01-02')])).toBe('c');
    expect(R.successor([m('z', 'player', '2026-01-02'), m('y', 'player', '2026-01-02')])).toBe('y');
    expect(R.successor([])).toBeNull();
  });

  it('counts age on a date, 29 February included', () => {
    expect(R.ageOnDate('1996-03-14', '2026-01-01')).toBe(29);
    expect(R.ageOnDate('1996-03-14', '2026-03-14')).toBe(30);
    expect(R.ageOnDate('1996-03-14', '2026-03-13')).toBe(29);
    expect(R.ageOnDate('2008-02-29', '2026-02-28')).toBe(17);
    expect(R.ageOnDate('2008-02-29', '2026-03-01')).toBe(18);
    expect(R.ageOnDate('2008-02-29', '2028-02-29')).toBe(20);
  });

  it('evaluates eligibility: NID, age bounds and gender categories', () => {
    const ok = { kycStatus: 'verified', memberActive: true, dob: '1996-03-14', gender: 'female' };
    const day = '2026-10-18';
    const status = (r, key) => r.checks.find((c) => c.key === key).status;
    // No rules: only the NID check applies.
    let r = R.evaluate(ok, {}, day);
    expect(r.eligible).toBe(true);
    expect([status(r, 'age'), status(r, 'gender')]).toEqual(['n_a', 'n_a']);
    expect(R.evaluate(ok, undefined, day).eligible).toBe(true);
    // NID: pending, or missing with a fix.
    r = R.evaluate({ ...ok, kycStatus: 'pending', memberActive: false }, {}, day);
    expect([r.eligible, status(r, 'nid_verified')]).toEqual([false, 'pending']);
    r = R.evaluate({ ...ok, kycStatus: 'unverified', memberActive: false }, {}, day);
    expect(r.checks[0]).toEqual({ key: 'nid_verified', status: 'fail', fix: 'verify_nid' });
    // The spec's example: Over-30, cut-off 1 Jan 2026, DOB 14 Mar 1996 → 29 → fail.
    r = R.evaluate(ok, { ageMin: 30, ageCutoff: '2026-01-01' }, day);
    expect([r.eligible, status(r, 'age')]).toEqual([false, 'fail']);
    expect(status(R.evaluate(ok, { ageMin: 30 }, day), 'age')).toBe('pass');
    expect(status(R.evaluate(ok, { ageMax: 29 }, day), 'age')).toBe('fail');
    expect(status(R.evaluate(ok, { ageMin: 18, ageMax: 40 }, day), 'age')).toBe('pass');
    // No DOB on file: pending while the NID is in review, otherwise missing.
    expect(R.evaluate({ ...ok, dob: null, kycStatus: 'pending' }, { ageMin: 18 }, day).checks[1]).toEqual({ key: 'age', status: 'pending', fix: null });
    expect(R.evaluate({ ...ok, dob: null, kycStatus: 'unverified' }, { ageMin: 18 }, day).checks[1]).toEqual({ key: 'age', status: 'missing', fix: 'verify_nid' });
    // Gender categories.
    expect(status(R.evaluate(ok, { gender: 'women' }, day), 'gender')).toBe('pass');
    expect(status(R.evaluate(ok, { gender: 'men' }, day), 'gender')).toBe('fail');
    expect(status(R.evaluate({ ...ok, gender: 'third' }, { gender: 'women' }, day), 'gender')).toBe('fail');
    expect(status(R.evaluate({ ...ok, gender: 'male' }, { gender: 'men' }, day), 'gender')).toBe('pass');
    expect(status(R.evaluate(ok, { gender: 'open' }, day), 'gender')).toBe('n_a');
    expect(status(R.evaluate(ok, { gender: 'mixed' }, day), 'gender')).toBe('n_a');
    expect(R.evaluate({ ...ok, gender: null }, { gender: 'women' }, day).checks[2]).toEqual({ key: 'gender', status: 'missing', fix: 'set_gender' });
  });

  it('checks a player\'s sports and positions', () => {
    const known = new Map([
      ['cricket', ['batter', 'wicketkeeper']],
      ['football', ['goalkeeper']],
    ]);
    expect(R.sportsBlock([{ sportKey: 'cricket', positions: ['batter'] }, { sportKey: 'football' }], known)).toBeNull();
    expect(R.sportsBlock([{ sportKey: 'chess', positions: [] }], known)).toBe('PROFILE_SPORTS_INVALID');
    expect(R.sportsBlock([{ sportKey: 'cricket', positions: [] }, { sportKey: 'cricket', positions: [] }], known)).toBe('PROFILE_SPORTS_INVALID');
    expect(R.sportsBlock([{ sportKey: 'football', positions: ['striker'] }], known)).toBe('PROFILE_SPORTS_INVALID');
  });
});
