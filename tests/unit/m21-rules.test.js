'use strict';

// M21 esports rules: points engine (FR-19), standings and tie-breakers (§6.4), prize allocation and
// team splits (FR-23 to FR-25, worked examples A, B and C in §6.5), refund matrix (§6.6), ranking
// formula (§6.8), state machines (§8), draft and roster checks, UID masking (FR-32). 100% branch gate.
const R = require('../../src/modules/esports/esports.rules');

const d = (iso) => new Date(iso);

describe('M21 state machines (§8)', () => {
  it('allows only the documented moves', () => {
    expect(R.canTournament('draft', 'review')).toBe(true);
    expect(R.canTournament('review', 'scheduled')).toBe(true);
    expect(R.canTournament('finalised', 'cancelled')).toBe(false);
    expect(R.canTournament('nope', 'draft')).toBe(false);
    expect(R.canRegistration('pending_payment', 'confirmed')).toBe(true);
    expect(R.canRegistration('no_show', 'refunded')).toBe(false);
    expect(R.canMatch('results_pending', 'disputed')).toBe(true);
    expect(R.canMatch('final', 'disputed')).toBe(false);
    expect(R.HOLDING).toContain('pending_payment');
    expect(R.PUBLIC).not.toContain('draft');
  });
});

describe('M21 authoring (FR-06, FR-07)', () => {
  const now = d('2026-10-20T00:00:00Z');
  const mode = { teamSize: 4, maxTeams: 25, maxPlayers: 100 };
  const ok = {
    prizes: [{ place: 1, amount: 400000 }, { place: 2, amount: 250000 }],
    maxSlots: 25,
    minParticipants: 16,
    entryUnit: 'squad',
    format: 'series',
    registrationOpensAt: d('2026-10-21T00:00:00Z'),
    registrationClosesAt: d('2026-10-22T12:00:00Z'),
    startsAt: d('2026-10-22T14:00:00Z'),
    matches: [{ startsAt: d('2026-10-22T14:00:00Z') }, { startsAt: d('2026-10-22T15:00:00Z') }],
    placementPoints: [15, 12, 10],
  };

  it('accepts a complete draft and names the first problem otherwise', () => {
    expect(R.draftBlock(ok, mode, now)).toBeNull();
    expect(R.draftBlock({ ...ok, prizes: [] }, mode, now)).toBe('PRIZE_TABLE_REQUIRED');
    expect(R.draftBlock({ ...ok, prizes: [{ place: 2, amount: 1 }] }, mode, now)).toBe('PRIZE_PLACES_INVALID');
    expect(R.draftBlock({ ...ok, prizes: [{ place: 1, amount: 0 }] }, mode, now)).toBe('PRIZE_AMOUNT_INVALID');
    expect(R.draftBlock({ ...ok, prizes: [{ place: 1, amount: 1.5 }] }, mode, now)).toBe('PRIZE_AMOUNT_INVALID');
    expect(R.draftBlock({ ...ok, maxSlots: 1, minParticipants: 1 }, mode, now)).toBe('PRIZE_PLACES_INVALID');
    expect(R.draftBlock({ ...ok, minParticipants: 30 }, mode, now)).toBe('MIN_ABOVE_MAX');
    expect(R.draftBlock({ ...ok, entryUnit: 'player' }, mode, now)).toBe('ENTRY_UNIT_INVALID');
    expect(R.draftBlock({ ...ok, entryUnit: 'player' }, { ...mode, teamSize: 1 }, now)).toBeNull();
    expect(R.draftBlock({ ...ok, maxSlots: 26 }, mode, now)).toBe('SLOTS_ABOVE_LOBBY');
    expect(R.draftBlock({ ...ok, matches: [] }, mode, now)).toBe('SCHEDULE_INVALID');
    expect(R.draftBlock({ ...ok, format: 'single_match' }, mode, now)).toBe('SCHEDULE_INVALID');
    expect(R.draftBlock({ ...ok, registrationOpensAt: d('2026-10-19T00:00:00Z') }, mode, now)).toBe('SCHEDULE_INVALID');
    expect(R.draftBlock({ ...ok, registrationClosesAt: d('2026-10-20T12:00:00Z') }, mode, now)).toBe('SCHEDULE_INVALID');
    expect(R.draftBlock({ ...ok, registrationClosesAt: d('2026-10-23T00:00:00Z') }, mode, now)).toBe('SCHEDULE_INVALID');
    expect(R.draftBlock({ ...ok, matches: [{ startsAt: d('2026-10-22T15:00:00Z') }] }, mode, now)).toBe('SCHEDULE_INVALID');
    expect(R.draftBlock({ ...ok, matches: [ok.matches[0], { startsAt: d('2026-10-22T14:00:00Z') }] }, mode, now)).toBe('SCHEDULE_INVALID');
    expect(R.draftBlock({ ...ok, placementPoints: [] }, mode, now)).toBe('POINTS_INVALID');
    expect(R.draftBlock({ ...ok, placementPoints: [1, -1] }, mode, now)).toBe('POINTS_INVALID');
    expect(R.draftBlock({ ...ok, placementPoints: [1.5] }, mode, now)).toBe('POINTS_INVALID');
  });

  it('locks money and schedule fields after publish (edge case 18)', () => {
    expect(R.lockedChange({ titleEn: 'x', rulesMd: 'y' })).toEqual([]);
    expect(R.lockedChange({ prizes: [], entryFee: 1, titleEn: 'x' })).toEqual(['entryFee', 'prizes']);
    expect(R.LOCKED_AFTER_PUBLISH).toContain('placementPoints');
  });

  it('places check-in and the room reveal before the first match', () => {
    const w = R.checkinWindow(d('2026-10-22T14:00:00Z'), 60, 20);
    expect(w).toEqual({ opensAt: d('2026-10-22T13:00:00Z'), closesAt: d('2026-10-22T13:40:00Z') });
    expect(R.revealAt(d('2026-10-22T14:00:00Z'), 15)).toEqual(d('2026-10-22T13:45:00Z'));
  });
});

describe('M21 registration (FR-08 to FR-13, FR-24, §6.6)', () => {
  it('gives the lowest free slot or none', () => {
    expect(R.freeSlot(new Set([1, 2, 4]), 5)).toBe(3);
    expect(R.freeSlot(new Set([1, 2]), 2)).toBeNull();
  });

  const p = (userId, extra = {}) => ({ id: `p-${userId}`, userId, gameId: 'g', status: 'verified', ...extra });
  const squad = { teamSize: 4, maxSubs: 1 };
  const solo = { teamSize: 1, maxSubs: 0 };
  it('checks the roster against the mode and the registrant', () => {
    const four = [p('a'), p('b'), p('c'), p('d')];
    expect(R.rosterBlock({ players: four, substitutes: [p('e')], mode: squad, gameId: 'g', registrantUserId: 'a', entryUnit: 'squad' })).toBeNull();
    expect(R.rosterBlock({ players: four.slice(0, 3), substitutes: [], mode: squad, gameId: 'g', registrantUserId: 'a', entryUnit: 'squad' })).toBe('ESPORTS_SQUAD_SIZE_INVALID');
    expect(R.rosterBlock({ players: four, substitutes: [p('e'), p('f')], mode: squad, gameId: 'g', registrantUserId: 'a', entryUnit: 'squad' })).toBe('ESPORTS_SQUAD_SIZE_INVALID');
    expect(R.rosterBlock({ players: four, substitutes: [p('a')], mode: squad, gameId: 'g', registrantUserId: 'a', entryUnit: 'squad' })).toBe('ESPORTS_SQUAD_SIZE_INVALID');
    expect(R.rosterBlock({ players: [p('a'), p('b'), p('c'), p('d', { status: 'pending' })], substitutes: [], mode: squad, gameId: 'g', registrantUserId: 'a', entryUnit: 'squad' })).toBe('ESPORTS_GAME_PROFILE_REQUIRED');
    expect(R.rosterBlock({ players: [p('a'), p('b'), p('c'), p('d', { gameId: 'other' })], substitutes: [], mode: squad, gameId: 'g', registrantUserId: 'a', entryUnit: 'squad' })).toBe('ESPORTS_GAME_PROFILE_REQUIRED');
    expect(R.rosterBlock({ players: four, substitutes: [], mode: squad, gameId: 'g', registrantUserId: 'z', entryUnit: 'squad' })).toBe('ESPORTS_NOT_IN_SQUAD');
    expect(R.rosterBlock({ players: [p('a')], substitutes: [], mode: solo, gameId: 'g', registrantUserId: 'a', entryUnit: 'player' })).toBeNull();
    expect(R.rosterBlock({ players: [p('b')], substitutes: [], mode: solo, gameId: 'g', registrantUserId: 'a', entryUnit: 'player' })).toBe('ESPORTS_GAME_PROFILE_REQUIRED');
  });

  it('accepts a declared split only when it covers the players and sums to 100', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const split = [{ userId: 'a', pct: 40 }, { userId: 'b', pct: 20 }, { userId: 'c', pct: 20 }, { userId: 'd', pct: 20 }];
    expect(R.splitBlock(split, ids)).toBeNull();
    expect(R.splitBlock(split.slice(1), ids)).toBe('SPLIT_INVALID');
    expect(R.splitBlock([...split.slice(0, 3), { userId: 'a', pct: 20 }], ids)).toBe('SPLIT_INVALID');
    expect(R.splitBlock([...split.slice(0, 3), { userId: 'x', pct: 20 }], ids)).toBe('SPLIT_INVALID');
    expect(R.splitBlock([...split.slice(0, 3), { userId: 'd', pct: 20.5 }], ids)).toBe('SPLIT_INVALID');
    expect(R.splitBlock([...split.slice(0, 3), { userId: 'd', pct: -1 }], ids)).toBe('SPLIT_INVALID');
    expect(R.splitBlock([...split.slice(0, 3), { userId: 'd', pct: 30 }], ids)).toBe('SPLIT_INVALID');
  });

  it('follows the refund and forfeit matrix (§6.6, Q122)', () => {
    const base = { paid: 5000, withdrawRefundPct: 100 };
    expect(R.refundAmount('cancelled', { ...base, beforeClose: false })).toBe(5000);
    expect(R.refundAmount('min_not_met', { ...base, beforeClose: false })).toBe(5000);
    expect(R.refundAmount('withdraw', { ...base, beforeClose: true })).toBe(5000);
    expect(R.refundAmount('withdraw', { paid: 5001, withdrawRefundPct: 50, beforeClose: true })).toBe(2500);
    expect(R.refundAmount('suspended', { ...base, beforeClose: true })).toBe(5000);
    expect(R.refundAmount('withdraw', { ...base, beforeClose: false })).toBe(0);
    expect(R.refundAmount('no_show', { ...base, beforeClose: false })).toBe(0);
    expect(R.refundAmount('disqualified', { ...base, beforeClose: true })).toBe(0);
    expect(R.isNoShow(3, 4)).toBe(true);
    expect(R.isNoShow(4, 4)).toBe(false);
  });
});

describe('M21 results and points (FR-18, FR-19)', () => {
  const entries = new Map([
    ['r1', new Set(['u1', 'u2'])],
    ['r2', new Set(['u3'])],
    ['r3', new Set(['u4'])],
  ]);
  it('validates placements and kills', () => {
    const rows = [
      { registrationId: 'r1', placement: 1, kills: [{ userId: 'u1', kills: 6 }, { userId: 'u2', kills: 3 }] },
      { registrationId: 'r2', placement: 2, kills: [{ userId: 'u3', kills: 4 }] },
      { registrationId: 'r3', placement: null, kills: [] },
    ];
    expect(R.resultsBlock(rows, entries)).toBeNull();
    expect(R.resultsBlock([{ registrationId: 'zz', placement: 1, kills: [] }], entries)).toBe('ESPORTS_RESULT_ENTRY_UNKNOWN');
    expect(R.resultsBlock([rows[0], rows[0]], entries)).toBe('ESPORTS_RESULT_ENTRY_UNKNOWN');
    expect(R.resultsBlock([{ ...rows[0], placement: 0 }], entries)).toBe('ESPORTS_PLACEMENT_INVALID');
    expect(R.resultsBlock([{ ...rows[0], placement: 4 }], entries)).toBe('ESPORTS_PLACEMENT_INVALID');
    expect(R.resultsBlock([{ ...rows[0], placement: 1.5 }], entries)).toBe('ESPORTS_PLACEMENT_INVALID');
    expect(R.resultsBlock([rows[0], { ...rows[1], placement: 1 }], entries)).toBe('ESPORTS_PLACEMENT_DUPLICATE');
    expect(R.resultsBlock([{ ...rows[1], kills: [{ userId: 'u1', kills: 1 }] }], entries)).toBe('ESPORTS_KILLS_MISMATCH');
    expect(R.resultsBlock([{ ...rows[1], kills: [{ userId: 'u3', kills: -1 }] }], entries)).toBe('ESPORTS_KILLS_MISMATCH');
    expect(R.resultsBlock([{ ...rows[1], kills: [{ userId: 'u3', kills: 1.5 }] }], entries)).toBe('ESPORTS_KILLS_MISMATCH');
    expect(R.resultsBlock([{ registrationId: 'r3', placement: null, kills: [{ userId: 'u4', kills: 2 }] }], entries)).toBe('ESPORTS_KILLS_MISMATCH');
    expect(R.resultsBlock([{ registrationId: 'r3', placement: null, kills: [{ userId: 'u4', kills: 0 }] }], entries)).toBeNull();
  });

  it('scores placement points plus kills × kill points; DNP and places past the table score nothing', () => {
    const table = { placementPoints: [15, 12, 10], killPoints: 1 };
    expect(R.points({ placement: 1, kills: 9 }, table)).toEqual({ placementPoints: 15, killPointsTotal: 9, total: 24 });
    expect(R.points({ placement: 5, kills: 2 }, table)).toEqual({ placementPoints: 0, killPointsTotal: 2, total: 2 });
    expect(R.points({ placement: null, kills: 0 }, table)).toEqual({ placementPoints: 0, killPointsTotal: 0, total: 0 });
  });

  it('ranks by points, then wins, kills, latest placement and registration time (§6.4)', () => {
    const e = (id, t) => ({ registrationId: id, registeredAt: d(`2026-10-20T00:00:0${t}Z`) });
    const res = (id, seq, placement, kills, total) => ({ registrationId: id, matchSeq: seq, placement, kills, total });
    const out = R.standings(
      [e('a', 1), e('b', 2), e('c', 3), e('d', 4), e('e', 5), e('f', 6), e('g', 7)],
      [
        res('a', 1, 1, 0, 20), // 20, 1 win
        res('b', 1, 2, 0, 10),
        res('b', 2, 1, 0, 10), // 20, 1 win, 0 kills, last place 1
        res('c', 1, 3, 5, 15), // 15, 0 wins, 5 kills
        res('d', 1, 4, 2, 15), // 15, 0 wins, 2 kills, last 4... in match 2:
        res('d', 2, 2, 0, 0), // d: 15, last 2
        res('e', 1, 5, 2, 15), // e: 15, 0 wins, 2 kills, DNP match 2 → last null
        res('f', 1, null, 0, 0),
        res('g', 1, null, 0, 0),
      ]
    );
    expect(out.map((r) => r.registrationId)).toEqual(['b', 'a', 'c', 'd', 'e', 'f', 'g']);
    expect(out[0]).toMatchObject({ rank: 1, totalPoints: 20, wins: 1, lastPlacement: 1, matchesPlayed: 2 });
    expect(out[1]).toMatchObject({ registrationId: 'a', lastPlacement: null });
    expect(out[4]).toMatchObject({ registrationId: 'e', lastPlacement: null, matchesPlayed: 1 });
    expect(out[5]).toMatchObject({ registrationId: 'f', matchesPlayed: 0, rank: 6 });
    expect(R.standings([e('x', 1)], [])).toEqual([{ registrationId: 'x', registeredAt: e('x', 1).registeredAt, totalPoints: 0, wins: 0, kills: 0, lastPlacement: null, matchesPlayed: 0, rank: 1 }]);
  });
});

describe('M21 prizes (FR-23 to FR-25, §6.5)', () => {
  it('worked example A: solo, profit, kill rewards', () => {
    const ranking = [{ registrationId: 'w1' }, { registrationId: 'w2' }, { registrationId: 'w3' }, { registrationId: 'w4' }];
    const out = R.awards({
      ranking,
      prizes: [{ place: 2, amount: 60000 }, { place: 1, amount: 100000 }, { place: 3, amount: 30000 }],
      killReward: 500,
      killsByEntry: new Map([['w1', 10], ['w2', 20], ['w4', 10]]),
    });
    expect(out.filter((a) => a.kind === 'place').map((a) => [a.registrationId, a.amount])).toEqual([['w1', 100000], ['w2', 60000], ['w3', 30000]]);
    expect(out.filter((a) => a.kind === 'kill_reward').map((a) => [a.registrationId, a.amount])).toEqual([['w1', 5000], ['w2', 10000], ['w4', 5000]]);
    const paid = out.reduce((s, a) => s + a.amount, 0);
    expect(R.settlementPreview(240000, paid)).toEqual({ collected: 240000, paid: 210000, subsidy: 0, revenue: 30000 });
  });

  it('worked example B: low fill, the shortfall is a subsidy; an empty place is not paid', () => {
    const out = R.awards({ ranking: [{ registrationId: 's1' }, { registrationId: 's2' }], prizes: [{ place: 1, amount: 400000 }, { place: 2, amount: 250000 }, { place: 3, amount: 150000 }], killReward: 0, killsByEntry: new Map() });
    expect(out.map((a) => a.amount)).toEqual([400000, 250000]);
    expect(R.settlementPreview(720000, 800000)).toEqual({ collected: 720000, paid: 800000, subsidy: 80000, revenue: 0 });
  });

  it('worked example C: declared split, equal split, remainder to the captain', () => {
    const split = [{ userId: 'cap', pct: 40 }, { userId: 'b', pct: 20 }, { userId: 'c', pct: 20 }, { userId: 'd', pct: 20 }];
    expect(R.splitAward(100000, { playerIds: ['cap', 'b', 'c', 'd'], captainId: 'cap', split })).toEqual([
      { userId: 'cap', amount: 40000 },
      { userId: 'b', amount: 20000 },
      { userId: 'c', amount: 20000 },
      { userId: 'd', amount: 20000 },
    ]);
    const equal = R.splitAward(100101, { playerIds: ['cap', 'b', 'c', 'd'], captainId: 'cap', split: null });
    expect(equal).toEqual([{ userId: 'cap', amount: 25026 }, { userId: 'b', amount: 25025 }, { userId: 'c', amount: 25025 }, { userId: 'd', amount: 25025 }]);
    expect(equal.reduce((s, x) => s + x.amount, 0)).toBe(100101);
    // The captain did not play: the remainder goes to the first player; zero shares are dropped.
    expect(R.splitAward(3, { playerIds: ['b', 'c', 'd', 'e'], captainId: 'cap', split: null })).toEqual([{ userId: 'b', amount: 3 }]);
    expect(R.splitAward(100, { playerIds: ['cap', 'b'], captainId: 'cap', split: [{ userId: 'cap', pct: 100 }, { userId: 'b', pct: 0 }] })).toEqual([{ userId: 'cap', amount: 100 }]);
  });

  it('pays kill rewards to each player for their own kills', () => {
    expect(R.killShares([{ userId: 'a', kills: 3 }, { userId: 'b', kills: 0 }], 500)).toEqual([{ userId: 'a', amount: 1500 }]);
  });
});

describe('M21 disputes (FR-20)', () => {
  const now = d('2026-10-22T15:00:00Z');
  const base = { matchStatus: 'results_pending', disputeClosesAt: d('2026-10-22T16:00:00Z'), now, isEntrant: true, openOrUsed: 0, max: 2 };
  it('allows an entrant inside the window, up to the limit', () => {
    expect(R.disputeBlock(base)).toBeNull();
    expect(R.disputeBlock({ ...base, matchStatus: 'disputed' })).toBeNull();
    expect(R.disputeBlock({ ...base, isEntrant: false })).toBe('ESPORTS_NOT_IN_MATCH');
    expect(R.disputeBlock({ ...base, matchStatus: 'final' })).toBe('ESPORTS_DISPUTE_WINDOW_CLOSED');
    expect(R.disputeBlock({ ...base, disputeClosesAt: null })).toBe('ESPORTS_DISPUTE_WINDOW_CLOSED');
    expect(R.disputeBlock({ ...base, now: d('2026-10-22T16:00:01Z') })).toBe('ESPORTS_DISPUTE_WINDOW_CLOSED');
    expect(R.disputeBlock({ ...base, openOrUsed: 2 })).toBe('ESPORTS_DISPUTE_LIMIT');
  });
});

describe('M21 ranking (FR-28, §6.8, Q125)', () => {
  it('scores percentile placement plus 2 × kills, by tier, with a 90-day half-life', () => {
    expect(R.placementScore(48, 1)).toBe(100);
    expect(R.placementScore(4, 4)).toBe(25);
    expect(R.tournamentScore({ placement: 100, kills: 5, tierWeight: 2 })).toBe(220);
    expect(R.decay(90, 90)).toBe(0.5);
    expect(R.decay(0, 90)).toBe(1);
  });

  const now = d('2026-10-31T00:00:00Z');
  const day = 86400000;
  const entry = (userId, daysAgo, placementScore, kills, tierWeight = 1) => ({ userId, placementScore, kills, tierWeight, finalisedAt: new Date(now.getTime() - daysAgo * day) });
  const entries = [
    entry('a', 0, 100, 0),
    entry('a', 90, 100, 0),
    entry('a', 400, 100, 0), // outside the 365-day window
    entry('b', 0, 50, 0),
    entry('b', 0, 50, 0),
    entry('c', 0, 100, 0), // one tournament only
    entry('d', -1, 100, 0), // in the future: ignored
  ];
  it('ranks rolling points with decay and a minimum number of tournaments', () => {
    const out = R.rankPlayers(entries, { now, scope: 'rolling', halfLifeDays: 90, minTournaments: 2 });
    expect(out).toEqual([
      { userId: 'a', points: 150, tournaments: 2, rank: 1 },
      { userId: 'b', points: 100, tournaments: 2, rank: 2 },
    ]);
    const ties = R.rankPlayers([entry('y', 0, 10, 0), entry('x', 0, 10, 0), entry('z', 0, 5, 0), entry('z', 0, 5, 0)], { now, scope: 'rolling', halfLifeDays: 90, minTournaments: 1 });
    expect(ties.map((r) => r.userId)).toEqual(['z', 'x', 'y']);
  });

  it('ranks a season without decay', () => {
    const { from, to } = R.seasonRange('2026-S4');
    const out = R.rankPlayers(entries, { now, scope: 'season', halfLifeDays: 90, minTournaments: 1, from, to });
    // In 2026-S4: a once (the 90-day-old one is in S3), b twice at 50, c once, d once; ties go to more tournaments, then id.
    expect(out.map((r) => [r.userId, r.points, r.tournaments])).toEqual([['b', 100, 2], ['a', 100, 1], ['c', 100, 1], ['d', 100, 1]]);
  });

  it('names seasons by Dhaka quarter', () => {
    expect(R.seasonOf(d('2026-12-31T18:30:00Z'))).toBe('2027-S1'); // 00:30 on 1 Jan in Dhaka
    expect(R.seasonOf(d('2026-10-01T00:00:00Z'))).toBe('2026-S4');
    expect(R.seasonRange('2026-S1')).toEqual({ from: d('2025-12-31T18:00:00Z'), to: d('2026-03-31T18:00:00Z') });
  });
});

describe('M21 privacy and inputs (FR-29, FR-32)', () => {
  it('masks UIDs', () => {
    expect(R.maskUid('5123456890')).toBe('5123•••890');
    expect(R.maskUid('123456')).toBe('12•••56');
  });
  it('makes slugs', () => {
    expect(R.slugify('Free Fire Daily #12 — Night!', 'k3x9')).toBe('free-fire-daily-12-night-k3x9');
    expect(R.slugify('ফ্রি ফায়ার', 'k3x9')).toBe('k3x9');
  });
  it('allows https stream links on known hosts', () => {
    expect(R.streamBlock('youtube', 'https://www.youtube.com/watch?v=abc')).toBeNull();
    expect(R.streamBlock('facebook', 'https://fb.watch/xyz')).toBeNull();
    expect(R.streamBlock('other', 'https://example.org/live')).toBeNull();
    expect(R.streamBlock('youtube', 'http://www.youtube.com/watch?v=abc')).toBe('STREAM_URL_INVALID');
    expect(R.streamBlock('youtube', 'https://evil.example/watch')).toBe('STREAM_URL_INVALID');
    expect(R.streamBlock('tiktok', 'not a url')).toBe('STREAM_URL_INVALID');
  });
});
