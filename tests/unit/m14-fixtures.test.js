'use strict';

// M14 fixture generation golden tests (M14-FR-15, §6.2–6.4, §13): 100% coverage gate.
const F = require('../../src/modules/tournaments/fixtures.rules');

const ids = (n) => Array.from({ length: n }, (_, i) => `t${i + 1}`);
const key = (a, b) => [a, b].sort().join('|');

describe('M14 fixtures.rules: round robin', () => {
  it.each(Array.from({ length: 19 }, (_, i) => i + 2))('n=%i: every pair once, nobody twice in a round, home/away within one', (n) => {
    const teams = ids(n);
    const rr = F.roundRobin(teams);
    expect(rr).toHaveLength((n * (n - 1)) / 2);
    expect(new Set(rr.map((m) => key(m.home, m.away))).size).toBe(rr.length);
    const rounds = n % 2 ? n : n - 1;
    expect(Math.max(...rr.map((m) => m.round))).toBe(rounds);
    for (let r = 1; r <= rounds; r += 1) {
      const playing = rr.filter((m) => m.round === r).flatMap((m) => [m.home, m.away]);
      expect(new Set(playing).size).toBe(playing.length);
    }
    for (const t of teams) {
      const home = rr.filter((m) => m.home === t).length;
      const away = rr.filter((m) => m.away === t).length;
      expect(Math.abs(home - away)).toBeLessThanOrEqual(1);
    }
  });

  it('rests one team a round when the count is odd, and mirrors the double league', () => {
    const rr = F.roundRobin(ids(5));
    for (let r = 1; r <= 5; r += 1) expect(rr.filter((m) => m.round === r)).toHaveLength(2);
    const dbl = F.doubleRoundRobin(ids(4));
    expect(dbl).toHaveLength(12);
    const first = dbl.filter((m) => m.round <= 3);
    const second = dbl.filter((m) => m.round > 3);
    expect(second.map((m) => `${m.away}-${m.home}-${m.round - 3}`)).toEqual(first.map((m) => `${m.home}-${m.away}-${m.round}`));
    expect(F.roundRobin(['a'])).toEqual([]);
  });
});

describe('M14 fixtures.rules: groups, snake, draws', () => {
  it('splits sizes that differ by at most one (10 teams in 3 groups → 4/3/3)', () => {
    expect(F.groupSizes(10, 3)).toEqual([4, 3, 3]);
    expect(F.groupSizes(16, 4)).toEqual([4, 4, 4, 4]);
    expect(F.groupSizes(9, 4)).toEqual([3, 2, 2, 2]);
  });

  it('deals seeds in a snake', () => {
    expect(F.snake(ids(8), 3)).toEqual([
      ['t1', 't6', 't7'],
      ['t2', 't5', 't8'],
      ['t3', 't4'],
    ]);
    expect(F.snake(ids(10), 3).map((g) => g.length)).toEqual([4, 3, 3]);
  });

  it('replays a random draw from its seed and changes with another seed', () => {
    const a = F.shuffle(ids(12), 'seed-1');
    expect(F.shuffle(ids(12), 'seed-1')).toEqual(a);
    expect([...a].sort()).toEqual([...ids(12)].sort());
    expect(F.shuffle(ids(12), 'seed-2')).not.toEqual(a);
    expect(F.shuffle([], 'x')).toEqual([]);
  });
});

describe('M14 fixtures.rules: knockout', () => {
  it('orders seeds with border()', () => {
    expect(F.border(1)).toEqual([1]);
    expect(F.border(2)).toEqual([1, 2]);
    expect(F.border(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect(F.border(16).slice(0, 4)).toEqual([1, 16, 8, 9]);
  });

  it('names rounds', () => {
    expect([2, 4, 8, 16, 32].map(F.roundName)).toEqual(['final', 'semi_final', 'quarter_final', 'round_of_16', 'round_of_32']);
  });

  it.each([
    [5, 3, 4],
    [6, 2, 5],
    [7, 1, 6],
    [8, 0, 7],
  ])('Q=%i: %i byes to the top seeds, %i matches, no bye against a bye', (q, byes, count) => {
    const slots = F.bySeed(ids(q).map((t) => ({ type: 'team', teamId: t })));
    expect(slots.filter((s) => s === F.BYE)).toHaveLength(byes);
    for (let i = 0; i < slots.length; i += 2) expect(slots[i] === F.BYE && slots[i + 1] === F.BYE).toBe(false);
    // The byes go to seeds 1..byes: their opponents are BYE.
    for (let s = 1; s <= byes; s += 1) {
      const at = slots.findIndex((x) => x && x.teamId === `t${s}`);
      expect(slots[at % 2 ? at - 1 : at + 1]).toBe(F.BYE);
    }
    expect(F.bracket(slots)).toHaveLength(count);
  });

  it('adds a third-place match only with two semi-finals, numbered before the final', () => {
    const five = F.bracket(F.bySeed(ids(5).map((t) => ({ type: 'team', teamId: t }))), { thirdPlace: true });
    expect(five.map((m) => m.roundName)).toEqual(['quarter_final', 'semi_final', 'semi_final', 'third_place', 'final']);
    expect(five[3].teamA).toEqual({ type: 'loser', key: 2 });
    expect(five[3].teamB).toEqual({ type: 'loser', key: 3 });
    expect(five[4].teamA).toEqual({ type: 'winner', key: 2 });
    const three = F.bracket(F.bySeed(ids(3).map((t) => ({ type: 'team', teamId: t }))), { thirdPlace: true });
    expect(three.map((m) => m.roundName)).toEqual(['semi_final', 'final']);
    expect(F.bracket(F.bySeed(ids(4).map((t) => ({ type: 'team', teamId: t }))))).toHaveLength(3);
    // A bye in either slot of a pair sends the other side through.
    const x = { type: 'team', teamId: 'x' };
    const y = { type: 'team', teamId: 'y' };
    const z = { type: 'team', teamId: 'z' };
    expect(F.bracket([F.BYE, x, y, z])).toEqual([
      { key: 1, round: 1, roundName: 'semi_final', teamA: y, teamB: z },
      { key: 2, round: 2, roundName: 'final', teamA: x, teamB: { type: 'winner', key: 1 } },
    ]);
  });
});

describe('M14 fixtures.rules: group cross-over', () => {
  const g = (group, pos) => ({ type: 'group_pos', group, pos });

  it('2 groups × 2: A1 v B2, B1 v A2', () => {
    expect(F.crossOverSlots(2, 2, 0)).toEqual([g('A', 1), g('B', 2), g('B', 1), g('A', 2)]);
  });

  it('4 groups × 2: A1 v B2 and C1 v D2 top, B1 v A2 and D1 v C2 bottom', () => {
    expect(F.crossOverSlots(4, 2, 0)).toEqual([g('A', 1), g('B', 2), g('C', 1), g('D', 2), g('B', 1), g('A', 2), g('D', 1), g('C', 2)]);
  });

  it('2 groups × 4: A1 v B4 · B2 v A3 · B1 v A4 · A2 v B3', () => {
    expect(F.crossOverSlots(2, 4, 0)).toEqual([g('A', 1), g('B', 4), g('B', 2), g('A', 3), g('B', 1), g('A', 4), g('A', 2), g('B', 3)]);
  });

  it('4 groups × 1: the winners meet in semi-finals', () => {
    expect(F.crossOverSlots(4, 1, 0)).toEqual([g('A', 1), g('B', 1), g('C', 1), g('D', 1)]);
  });

  it('falls back to the ranked list for odd groups, best extras or a non-power of two', () => {
    expect(F.crossOverSlots(3, 2, 0)).toBeNull();
    expect(F.crossOverSlots(4, 2, 2)).toBeNull();
    expect(F.crossOverSlots(2, 3, 0)).toBeNull();
    expect(F.crossOverSlots(6, 2, 0)).toBeNull();
    const ranked = F.rankedSlots(3, 2, 2); // 6 qualifiers + 2 best thirds = 8
    expect(ranked).toHaveLength(8);
    expect(ranked[0]).toEqual({ type: 'ranked', pos: 1, rank: 1 });
    expect(ranked).toContainEqual({ type: 'ranked', pos: 3, rank: 2 });
  });

  it.each([
    [2, 2],
    [4, 2],
    [2, 4],
    [8, 2],
  ])('%i groups × %i: group-mates are in opposite halves, so they can only meet in the final', (groups, q) => {
    const slots = F.crossOverSlots(groups, q, 0);
    const half = slots.length / 2;
    for (const name of F.GROUP_NAMES.slice(0, groups)) {
      const at = (pos) => slots.findIndex((s) => s.group === name && s.pos === pos);
      // Winner and runner-up of a group are always in different halves.
      expect(at(1) < half).not.toBe(at(2) < half);
    }
  });
});

describe('M14 fixtures.rules: generate', () => {
  it('a league of 6 with a top-4 knockout', () => {
    const { stages, matches } = F.generate('league', ids(6), { knockoutTopN: 4, thirdPlace: true });
    expect(stages.map((s) => s.kind)).toEqual(['league', 'knockout']);
    expect(matches.filter((m) => m.stageKey === 'L')).toHaveLength(15);
    const ko = matches.filter((m) => m.stageKey === 'K');
    expect(ko.map((m) => m.roundName)).toEqual(['semi_final', 'semi_final', 'third_place', 'final']);
    expect(ko[0].teamA).toEqual({ type: 'league_pos', pos: 1 });
    expect(ko[0].teamB).toEqual({ type: 'league_pos', pos: 4 });
    expect(ko[3].teamA).toEqual({ type: 'winner', matchNo: 16 });
    expect(ko[2].teamB).toEqual({ type: 'loser', matchNo: 17 });
    expect(matches.map((m) => m.matchNo)).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
  });

  it('a double league without a knockout', () => {
    const { stages, matches } = F.generate('double_league', ids(4));
    expect(stages).toHaveLength(1);
    expect(matches).toHaveLength(12);
    expect(F.generate('league', ids(4), { knockoutTopN: 0 }).matches).toHaveLength(6);
  });

  it('groups and knockout: 9 teams in 3 groups, top 2 and the best 2 thirds', () => {
    const { stages, matches } = F.generate('groups_knockout', ids(9), { groupCount: 3, qualifiersPerGroup: 2, bestExtra: 2, thirdPlace: false });
    expect(stages[0].groups.map((x) => x.teamIds.length)).toEqual([3, 3, 3]);
    const group = matches.filter((m) => m.stageKey === 'G');
    expect(group).toHaveLength(9);
    // Interleaved by round: the first three matches are round 1 of A, B, C.
    expect(group.slice(0, 3).map((m) => `${m.group}${m.round}`)).toEqual(['A1', 'B1', 'C1']);
    expect(matches.filter((m) => m.stageKey === 'K').map((m) => m.roundName)).toEqual(['quarter_final', 'quarter_final', 'quarter_final', 'quarter_final', 'semi_final', 'semi_final', 'final']);
  });

  it('groups and knockout: 8 teams in 2 groups uses the cross-over', () => {
    const { matches } = F.generate('groups_knockout', ids(8), { groupCount: 2, qualifiersPerGroup: 2 });
    const semis = matches.filter((m) => m.roundName === 'semi_final');
    expect(semis[0].teamA).toEqual({ type: 'group_pos', group: 'A', pos: 1 });
    expect(semis[0].teamB).toEqual({ type: 'group_pos', group: 'B', pos: 2 });
  });

  it('a knockout of 6 seeded teams', () => {
    const { stages, matches } = F.generate('knockout', ids(6), { thirdPlace: true });
    expect(stages).toEqual([{ key: 'K', kind: 'knockout', seq: 1 }]);
    expect(matches.map((m) => m.roundName)).toEqual(['quarter_final', 'quarter_final', 'semi_final', 'semi_final', 'third_place', 'final']);
    expect(F.matchCount('knockout', 6, { thirdPlace: true })).toBe(6);
    expect(F.matchCount('league', 5)).toBe(10);
  });

  it('checks format settings', () => {
    const base = { minTeams: 4, maxTeams: 8 };
    expect(F.formatBlock('league', base)).toBeNull();
    expect(F.formatBlock('league', { minTeams: 1, maxTeams: 8 })).toBe('CAPACITY_INVALID');
    expect(F.formatBlock('league', { minTeams: 9, maxTeams: 8 })).toBe('CAPACITY_INVALID');
    expect(F.formatBlock('league', { ...base, knockoutTopN: 4 })).toBeNull();
    expect(F.formatBlock('league', { ...base, knockoutTopN: 3 })).toBe('KNOCKOUT_TOP_INVALID');
    expect(F.formatBlock('double_league', { ...base, knockoutTopN: 8 })).toBe('KNOCKOUT_TOP_INVALID');
    expect(F.formatBlock('knockout', base)).toBeNull();
    const groups = { minTeams: 8, maxTeams: 12, groupCount: 2, qualifiersPerGroup: 2 };
    expect(F.formatBlock('groups_knockout', groups)).toBeNull();
    expect(F.formatBlock('groups_knockout', { ...groups, groupCount: 1 })).toBe('GROUPS_INVALID');
    expect(F.formatBlock('groups_knockout', { ...groups, groupCount: 17 })).toBe('GROUPS_INVALID');
    expect(F.formatBlock('groups_knockout', { ...groups, groupCount: 5 })).toBe('GROUPS_INVALID');
    expect(F.formatBlock('groups_knockout', { ...groups, maxTeams: 8, minTeams: 6, groupCount: 4 })).toBe('GROUPS_INVALID');
    expect(F.formatBlock('groups_knockout', { ...groups, qualifiersPerGroup: 4 })).toBe('QUALIFIERS_INVALID');
    expect(F.formatBlock('groups_knockout', { ...groups, qualifiersPerGroup: 0 })).toBe('QUALIFIERS_INVALID');
    expect(F.formatBlock('groups_knockout', { ...groups, bestExtra: 2 })).toBe('QUALIFIERS_INVALID');
    expect(F.formatBlock('groups_knockout', { ...groups, bestExtra: -1 })).toBe('QUALIFIERS_INVALID');
    expect(F.formatBlock('groups_knockout', { ...groups, bestExtra: 1 })).toBeNull();
  });
});
