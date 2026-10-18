'use strict';

// M15 lite results and standings (M15-FR-09/10/11, M14 §6.5): 100% coverage gate.
const S = require('../../src/modules/scoring/standings.rules');

const football = { pW: 3, pD: 1, walkoverScore: 3 };
const cricket = { pW: 2, pT: 1, overs: 20, players: 11 };
const kabaddi = { pW: 5, pT: 3, pLc: 1 };
const badminton = { bestOf: '3', points: 21, cap: 30, winBy2: true, pW: 2 };
const volleyball = { bestOf: '5', points: 25, finalPts: 15, winBy2: true, pW: 3 };

const res = (teamA, teamB, engine, input, values, opts = {}) => ({ teamA, teamB, score: input, ...S.decide(engine, input, { values, ...opts }) });

describe('M15 standings.rules: deciding a result', () => {
  it('clock sports: win, draw, and a knockout draw decided on penalties', () => {
    expect(S.decide('clock', { a: { score: 2 }, b: { score: 1 } }, { values: football })).toEqual({ outcome: 'win', winner: 'a', margin: 1 });
    expect(S.decide('clock', { a: { score: 1 }, b: { score: 1 } }, { values: football })).toEqual({ outcome: 'draw', winner: null, margin: 0 });
    expect(S.decide('clock', { a: { score: 1 }, b: { score: 1 } }, { knockout: true })).toEqual({ error: 'KNOCKOUT_NEEDS_WINNER' });
    expect(S.decide('clock', { a: { score: 1 }, b: { score: 1 }, pens: { a: 4, b: 5 } }, { knockout: true })).toEqual({ outcome: 'draw', winner: 'b', margin: 0 });
    expect(S.decide('clock', { a: { score: 1 }, b: { score: 1 }, pens: { a: 4, b: 4 } }, { knockout: true })).toEqual({ error: 'KNOCKOUT_NEEDS_WINNER' });
    expect(S.decide('clock', { a: { score: -1 }, b: { score: 1 } })).toEqual({ error: 'RESULT_INVALID' });
    expect(S.decide('clock', { a: { score: 1 }, b: { score: 1 }, pens: { a: 'x', b: 1 } }, { knockout: true })).toEqual({ error: 'KNOCKOUT_NEEDS_WINNER' });
    expect(S.decide('clock', { a: { score: 1 }, b: { score: 1 }, pens: { a: 1, b: 'x' } }, { knockout: true })).toEqual({ error: 'KNOCKOUT_NEEDS_WINNER' });
    expect(S.decide('clock', { a: { score: 0 }, b: { score: 0 }, pens: { a: 5, b: 4 } }, { knockout: true }).winner).toBe('a');
    expect(S.decide('clock', { a: { score: 1 } })).toEqual({ error: 'RESULT_INVALID' });
  });

  it('cricket: runs decide; a tie needs a decider in a knockout', () => {
    const a = { runs: 160, wickets: 6, balls: 120 };
    expect(S.decide('ball_by_ball', { a, b: { runs: 150, wickets: 10, balls: 110 } }, { values: cricket })).toEqual({ outcome: 'win', winner: 'a', margin: 10 });
    expect(S.decide('ball_by_ball', { a, b: { ...a } }, { values: cricket })).toEqual({ outcome: 'tie', winner: null, margin: 0 });
    expect(S.decide('ball_by_ball', { a, b: { ...a } }, { values: cricket, knockout: true })).toEqual({ error: 'KNOCKOUT_NEEDS_WINNER' });
    expect(S.decide('ball_by_ball', { a, b: { ...a }, decider: 'b' }, { values: cricket, knockout: true })).toEqual({ outcome: 'tie', winner: 'b', margin: 0 });
    expect(S.decide('ball_by_ball', { a, b: { ...a, balls: 121 } }, { values: cricket })).toEqual({ error: 'RESULT_INVALID' });
    expect(S.decide('ball_by_ball', { a, b: { ...a, balls: 300 } })).toEqual({ outcome: 'tie', winner: null, margin: 0 }); // 50 overs by default
    expect(S.decide('ball_by_ball', { a })).toEqual({ error: 'RESULT_INVALID' });
  });

  it('rally: sets to the target, win by two, a cap and a shorter deciding set', () => {
    expect(S.decide('rally', { sets: [[21, 15], [21, 19]] }, { values: badminton })).toEqual({ outcome: 'win', winner: 'a', margin: 2 });
    expect(S.decide('rally', { sets: [[21, 15], [18, 21], [29, 30]] }, { values: badminton })).toEqual({ outcome: 'win', winner: 'b', margin: 1 });
    expect(S.decide('rally', { sets: [[23, 21], [21, 23], [22, 20]] }, { values: badminton }).winner).toBe('a');
    expect(S.decide('rally', { sets: [[21, 20]] }, { values: badminton })).toEqual({ error: 'RESULT_INVALID' }); // not two clear
    expect(S.decide('rally', { sets: [[24, 21]] }, { values: badminton })).toEqual({ error: 'RESULT_INVALID' }); // over by three
    expect(S.decide('rally', { sets: [[20, 18]] }, { values: badminton })).toEqual({ error: 'RESULT_INVALID' }); // short of 21
    expect(S.decide('rally', { sets: [[21, 15]] }, { values: badminton })).toEqual({ error: 'RESULT_INVALID' }); // not finished
    expect(S.decide('rally', { sets: [[21, 15], [21, 15], [21, 15]] }, { values: badminton })).toEqual({ error: 'RESULT_INVALID' }); // played on
    expect(S.decide('rally', { sets: [] }, { values: badminton })).toEqual({ error: 'RESULT_INVALID' });
    expect(S.decide('rally', {}, { values: badminton })).toEqual({ error: 'RESULT_INVALID' });
    expect(S.decide('rally', { sets: [[21, 21]] }, { values: badminton })).toEqual({ error: 'RESULT_INVALID' });
    const v = S.decide('rally', { sets: [[25, 20], [20, 25], [25, 23], [23, 25], [15, 13]] }, { values: volleyball });
    expect(v).toEqual({ outcome: 'win', winner: 'a', margin: 1 });
    expect(S.setTarget(volleyball, 4, 5)).toBe(15);
    expect(S.setTarget(volleyball, 3, 5)).toBe(25);
    expect(S.setOk([11, 9], 11, { winBy2: false })).toBe(true);
    expect(S.setOk([11, 10], 11, { winBy2: false })).toBe(true);
    expect(S.setOk([12, 10], 11, { winBy2: false })).toBe(false);
    expect(S.setOk([1.5, 0], 11, {})).toBe(false);
  });

  it('no result and walkover', () => {
    expect(S.decide('clock', { outcome: 'no_result' })).toEqual({ outcome: 'no_result', winner: null, margin: 0 });
    expect(S.decide('clock', { outcome: 'no_result' }, { knockout: true })).toEqual({ error: 'KNOCKOUT_NEEDS_WINNER' });
    expect(S.decide('clock', { outcome: 'walkover', walkoverTo: 'b' })).toEqual({ outcome: 'walkover', winner: 'b', margin: 0 });
    expect(S.decide('clock', { outcome: 'walkover' })).toEqual({ error: 'RESULT_INVALID' });
  });

  it('table points per rules, with kabaddi’s close-loss point', () => {
    expect(S.pointsFor(football, { outcome: 'win', winner: 'a' }, 'a')).toBe(3);
    expect(S.pointsFor(football, { outcome: 'win', winner: 'a' }, 'b')).toBe(0);
    expect(S.pointsFor(football, { outcome: 'draw', winner: null }, 'a')).toBe(1);
    expect(S.pointsFor(cricket, { outcome: 'tie', winner: null }, 'a')).toBe(1);
    expect(S.pointsFor(cricket, { outcome: 'no_result', winner: null }, 'b')).toBe(1);
    expect(S.pointsFor({ pW: 2, pL: 1 }, { outcome: 'win', winner: 'b', margin: 20 }, 'a')).toBe(1);
    expect(S.pointsFor(kabaddi, { outcome: 'win', winner: 'b', margin: 7 }, 'a')).toBe(1);
    expect(S.pointsFor(kabaddi, { outcome: 'win', winner: 'b', margin: 8 }, 'a')).toBe(0);
    expect(S.pointsFor(kabaddi, { outcome: 'walkover', winner: 'b', margin: 0 }, 'a')).toBe(0);
    expect(S.pointsFor({}, { outcome: 'win', winner: 'a' }, 'a')).toBe(0);
    expect(S.pointsFor({ pD: 1 }, { outcome: 'tie', winner: null }, 'a')).toBe(1);
    expect(S.pointsFor({}, { outcome: 'tie', winner: null }, 'a')).toBe(0);
    expect(S.pointsFor({}, { outcome: 'draw', winner: null }, 'a')).toBe(0);
  });
});

describe('M15 standings.rules: tables', () => {
  it('football: points, goal difference, goals; a walkover counts 3–0', () => {
    const r = [
      res('A', 'B', 'clock', { a: { score: 2 }, b: { score: 0 } }, football),
      res('C', 'D', 'clock', { a: { score: 1 }, b: { score: 1 } }, football),
      res('A', 'C', 'clock', { a: { score: 1 }, b: { score: 3 } }, football),
      res('B', 'D', 'clock', { outcome: 'walkover', walkoverTo: 'a' }, football),
    ];
    const t = S.table(['A', 'B', 'C', 'D'], r, { engine: 'clock', values: football, tiebreakers: ['points', 'goal_difference', 'goals_scored'] });
    expect(t.map((x) => [x.teamId, x.points, x.for - x.against, x.position])).toEqual([
      ['C', 4, 2, 1],
      ['B', 3, 1, 2],
      ['A', 3, 0, 3],
      ['D', 1, -3, 4],
    ]);
    expect(t.find((x) => x.teamId === 'B')).toMatchObject({ for: 3, against: 2, won: 1, lost: 1 });
    expect(t.every((x) => !x.needsLots)).toBe(true);
  });

  it('head-to-head is a mini-table among the tied teams, then lots', () => {
    // A, B, C all beat each other once in a circle, D loses to all: A, B, C tied on 6.
    const r = [
      res('A', 'B', 'clock', { a: { score: 1 }, b: { score: 0 } }, football),
      res('B', 'C', 'clock', { a: { score: 1 }, b: { score: 0 } }, football),
      res('C', 'A', 'clock', { a: { score: 1 }, b: { score: 0 } }, football),
      res('A', 'D', 'clock', { a: { score: 1 }, b: { score: 0 } }, football),
      res('B', 'D', 'clock', { a: { score: 1 }, b: { score: 0 } }, football),
      res('C', 'D', 'clock', { a: { score: 3 }, b: { score: 0 } }, football),
    ];
    const keys = ['points', 'head_to_head', 'lots'];
    const t = S.table(['A', 'B', 'C', 'D'], r, { engine: 'clock', values: football, tiebreakers: keys });
    expect(t.map((x) => [x.teamId, x.position, x.needsLots])).toEqual([
      ['A', 1, true],
      ['B', 1, true],
      ['C', 1, true],
      ['D', 4, false],
    ]);
    const drawn = S.table(['A', 'B', 'C', 'D'], r, { engine: 'clock', values: football, tiebreakers: keys, lots: ['B', 'C', 'A'] });
    expect(drawn.map((x) => x.teamId)).toEqual(['B', 'C', 'A', 'D']);
    // With goal difference after head-to-head, C (+3 v D) is first; A and B stay tied in the mini-table, then lots.
    const gd = S.table(['A', 'B', 'C', 'D'], r, { engine: 'clock', values: football, tiebreakers: ['head_to_head', 'goal_difference', 'lots'], lots: ['B', 'A'] });
    expect(gd.map((x) => x.teamId)).toEqual(['C', 'B', 'A', 'D']);
    // Two tied teams, one beat the other: head-to-head separates them.
    const two = [res('A', 'B', 'clock', { a: { score: 2 }, b: { score: 1 } }, football), res('B', 'C', 'clock', { a: { score: 5 }, b: { score: 0 } }, football), res('A', 'C', 'clock', { a: { score: 0 }, b: { score: 0 } }, football), res('C', 'A', 'clock', { a: { score: 1 }, b: { score: 0 } }, football)];
    const h2h = S.table(['A', 'B', 'C'], two, { engine: 'clock', values: football, tiebreakers: ['head_to_head', 'goal_difference'] });
    expect(h2h.map((x) => [x.teamId, x.points])).toEqual([
      ['C', 4],
      ['A', 4],
      ['B', 3],
    ]);
  });

  it('cricket: net run rate with all out counted as the full overs; no result stays out', () => {
    const r = [
      res('A', 'B', 'ball_by_ball', { a: { runs: 160, wickets: 5, balls: 120 }, b: { runs: 100, wickets: 10, balls: 90 } }, cricket),
      res('B', 'C', 'ball_by_ball', { a: { runs: 140, wickets: 4, balls: 120 }, b: { runs: 141, wickets: 2, balls: 96 } }, cricket),
      res('C', 'A', 'ball_by_ball', { outcome: 'no_result' }, cricket),
    ];
    const t = S.table(['A', 'B', 'C'], r, { engine: 'ball_by_ball', values: cricket, tiebreakers: ['points', 'net_run_rate', 'fewer_no_results'] });
    expect(t.map((x) => [x.teamId, x.points])).toEqual([
      ['A', 3],
      ['C', 3],
      ['B', 0],
    ]);
    // A: 160/20 − 100/20 (all out → 20 overs) = 3.0; C: 141/16 − 140/20 = 1.8125 → 1.813.
    expect(t[0].nrr).toBe(3);
    expect(t[1].nrr).toBe(1.813);
    expect(S.metric('nrr', { runsFor: 0, ballsFaced: 0, runsAgainst: 0, ballsBowled: 0 })).toBe(0);
    expect(S.table(['A'], [], { engine: 'ball_by_ball', values: {} })[0].points).toBe(0);
    const defaults = S.table(['A', 'B'], [res('A', 'B', 'ball_by_ball', { a: { runs: 10, wickets: 10, balls: 6 }, b: { runs: 5, wickets: 1, balls: 6 } }, {})], { engine: 'ball_by_ball', values: {} });
    expect(defaults[0].ballsFaced).toBe(300);
  });

  it('rally: sets, points and ratios', () => {
    const r = [res('A', 'B', 'rally', { sets: [[21, 15], [21, 19]] }, badminton), res('B', 'C', 'rally', { sets: [[21, 10], [15, 21], [21, 5]] }, badminton), res('C', 'A', 'rally', { sets: [[21, 18], [21, 16]] }, badminton)];
    const t = S.table(['A', 'B', 'C'], r, { engine: 'rally', values: badminton, tiebreakers: ['points', 'game_difference', 'point_difference'] });
    expect(t.map((x) => [x.teamId, x.points, x.setsFor - x.setsAgainst])).toEqual([
      ['C', 2, 1],
      ['A', 2, 0],
      ['B', 2, -1],
    ]);
    const row = { for: 10, against: 0, setsFor: 2, setsAgainst: 0, noResult: 1, won: 1, points: 2 };
    expect(S.metric('set_ratio', row)).toBe(Infinity);
    expect(S.metric('point_ratio', row)).toBe(Infinity);
    expect(S.metric('point_ratio', { ...row, for: 0 })).toBe(0);
    expect(S.metric('point_ratio', { ...row, against: 5 })).toBe(2);
    expect(S.metric('fewer_no_results', row)).toBe(-1);
    expect(S.metric('wins', row)).toBe(1);
    expect(S.metric('points_scored', row)).toBe(10);
    expect(S.metric('fair_play', row)).toBe(0);
    expect(S.metric('score_difference', row)).toBe(10);
    expect(S.metric('point_difference', row)).toBe(10);
    expect(S.metric('set_difference', row)).toBe(2);
    expect(S.metric('goals_scored', row)).toBe(10);
    expect(S.metric('goal_difference', row)).toBe(10);
    expect(S.metric('net_run_rate', { runsFor: 60, ballsFaced: 60, runsAgainst: 30, ballsBowled: 60 })).toBe(3);
    expect(S.metric('game_difference', row)).toBe(2);
  });

  it('ignores results outside the table and non-final outcomes; orders nothing with no keys', () => {
    const t = S.table(['A', 'B'], [{ teamA: 'A', teamB: 'X', outcome: 'win', winner: 'a', margin: 1, score: { a: { score: 1 }, b: { score: 0 } } }, { teamA: 'A', teamB: 'B', outcome: 'abandoned' }], { engine: 'clock', values: football });
    expect(t.map((x) => x.played)).toEqual([0, 0]);
    expect(S.order(['A', 'B'], new Map(), [], {})).toEqual([['A', 'B']]);
    const wo = S.table(['A', 'B'], [res('A', 'B', 'rally', { outcome: 'walkover', walkoverTo: 'b' }, {})], { engine: 'rally', values: { pW: 2 } });
    expect(wo.map((x) => [x.teamId, x.points, x.for])).toEqual([['B', 2, 0], ['A', 0, 0]]);
  });

  it('ranks teams across groups by points per match, then difference, then scored', () => {
    const row = (teamId, played, points, f, a) => ({ teamId, played, points, for: f, against: a, setsFor: 0, setsAgainst: 0 });
    const ranked = S.rankAcrossGroups([row('A3', 3, 3, 3, 4), row('B3', 2, 3, 2, 2), row('C3', 3, 3, 4, 5), row('D3', 3, 3, 3, 4)], ['points', 'goal_difference']);
    expect(ranked.map((x) => [x.teamId, x.rank, x.needsLots])).toEqual([
      ['B3', 1, false],
      ['C3', 2, false],
      ['A3', 3, true],
      ['D3', 3, true],
    ]);
    expect(S.rankAcrossGroups([row('X', 0, 0, 0, 0)])[0].rank).toBe(1);
    expect(S.rankAcrossGroups([row('X', 1, 3, 1, 0), row('Y', 1, 3, 2, 1)], ['head_to_head', 'set_difference'])[0].teamId).toBe('Y');
  });
});
