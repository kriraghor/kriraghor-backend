'use strict';

// M14 scheduling (M14-FR-17/18, §6.6, §13): 100% coverage gate.
const F = require('../../src/modules/tournaments/fixtures.rules');
const S = require('../../src/modules/tournaments/schedule.rules');

const ids = (n) => Array.from({ length: n }, (_, i) => `t${i + 1}`);
const base = {
  startDate: '2026-11-07', // a Saturday
  endDate: '2026-12-31',
  weekdays: [5, 6], // Friday and Saturday
  slots: ['18:00', '16:30'],
  durationMin: 120,
  bufferMin: 15,
  matchesPerDay: null,
  minRestHours: 44,
  maxPerTeamPerDay: 1,
  restDates: [],
  venues: [{ venueId: 'v1', courts: [] }],
};

describe('M14 schedule.rules', () => {
  it('reads Dhaka times and dates', () => {
    expect(new Date(S.at('2026-11-07', '16:30')).toISOString()).toBe('2026-11-07T10:30:00.000Z');
    expect(S.addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(S.weekday('2026-11-07')).toBe(6);
    expect(S.dhakaDate(Date.parse('2026-11-07T18:30:00Z'))).toBe('2026-11-08');
  });

  it('knows teams and dependencies of a match', () => {
    const { matches } = F.generate('groups_knockout', ids(8), { groupCount: 2, qualifiersPerGroup: 2, thirdPlace: true });
    const semi = matches.find((m) => m.roundName === 'semi_final');
    expect(S.teamsOf(semi)).toEqual([]);
    expect(S.depsOf(semi, matches).sort((a, b) => a - b)).toEqual(matches.filter((m) => m.stageKey === 'G').map((m) => m.matchNo));
    const final = matches.find((m) => m.roundName === 'final');
    expect(S.depsOf(final, matches)).toHaveLength(2);
    const league = F.generate('league', ids(4), { knockoutTopN: 2 }).matches;
    expect(S.depsOf(league[6], league)).toHaveLength(6);
    const ranked = F.generate('groups_knockout', ids(9), { groupCount: 3, qualifiersPerGroup: 2, bestExtra: 2 }).matches;
    expect(S.depsOf(ranked.find((m) => m.stageKey === 'K'), ranked)).toHaveLength(9);
    expect(S.depsOf({ teamA: null, teamB: { type: 'team', teamId: 'x' } }, [])).toEqual([]);
  });

  it('a league of 4 on one pitch: nobody plays twice a day, everyone rests 44 h, slots in time order', () => {
    const { matches } = F.generate('league', ids(4));
    const { placed, unscheduled } = S.schedule(matches, base);
    expect(unscheduled).toEqual([]);
    expect(placed).toHaveLength(6);
    expect(placed[0].start).toBe('2026-11-07T10:30:00.000Z'); // 16:30 first
    const withTeams = placed.map((p) => ({ ...p, teams: S.teamsOf(matches.find((m) => m.matchNo === p.matchNo)) }));
    for (const t of ids(4)) {
      const mine = withTeams.filter((p) => p.teams.includes(t)).map((p) => Date.parse(p.start)).sort((a, b) => a - b);
      for (let i = 1; i < mine.length; i += 1) expect(mine[i] - mine[i - 1]).toBeGreaterThanOrEqual(44 * 3600000);
    }
    for (const p of placed) expect([5, 6]).toContain(S.weekday(S.dhakaDate(Date.parse(p.start))));
  });

  it('puts a knockout after its sources plus rest, uses courts, caps a day and skips rest days', () => {
    const { matches } = F.generate('groups_knockout', ids(8), { groupCount: 2, qualifiersPerGroup: 2 });
    const cfg = { ...base, minRestHours: 1, maxPerTeamPerDay: 2, matchesPerDay: 6, restDates: ['2026-11-13'], venues: [{ venueId: 'v1', courts: ['A', 'B'] }] };
    const { placed, unscheduled } = S.schedule(matches, cfg);
    expect(unscheduled).toEqual([]);
    const byNo = new Map(placed.map((p) => [p.matchNo, p]));
    const lastGroupEnd = Math.max(...matches.filter((m) => m.stageKey === 'G').map((m) => Date.parse(byNo.get(m.matchNo).end)));
    for (const m of matches.filter((x) => x.stageKey === 'K')) expect(Date.parse(byNo.get(m.matchNo).start)).toBeGreaterThanOrEqual(lastGroupEnd + 3600000);
    expect(placed.some((p) => p.court === 'B')).toBe(true);
    const perDay = {};
    for (const p of placed) perDay[S.dhakaDate(Date.parse(p.start))] = (perDay[S.dhakaDate(Date.parse(p.start))] ?? 0) + 1;
    expect(Math.max(...Object.values(perDay))).toBeLessThanOrEqual(6);
    expect(perDay['2026-11-13']).toBeUndefined();
  });

  it('reports what does not fit: no slot, then the matches that wait for it', () => {
    const { matches } = F.generate('knockout', ids(4));
    const cfg = { ...base, endDate: '2026-11-07', slots: ['16:30'] };
    const { placed, unscheduled } = S.schedule(matches, cfg);
    expect(placed).toHaveLength(1);
    expect(unscheduled).toEqual([
      { matchNo: 2, reason: 'no_slot' },
      { matchNo: 3, reason: 'waits_for_unscheduled' },
    ]);
  });

  it('keeps matches already placed and schedules around them', () => {
    const { matches } = F.generate('league', ids(4));
    const fixed = [{ matchNo: 1, start: '2026-11-07T10:30:00.000Z', end: '2026-11-07T12:30:00.000Z', venueId: 'v1', court: null, teams: S.teamsOf(matches[0]), deps: [] }];
    const { placed } = S.schedule(matches, base, fixed);
    expect(placed.map((p) => p.matchNo)).not.toContain(1);
    expect(placed).toHaveLength(5);
  });

  it('works with the defaults: one match a day per team, no rest dates, a venue without courts', () => {
    const { matches } = F.generate('league', ids(3));
    const cfg = { ...base, maxPerTeamPerDay: undefined, restDates: undefined, minRestHours: 0, venues: [{ venueId: 'v1' }] };
    const { placed, unscheduled } = S.schedule(matches, cfg);
    expect(unscheduled).toEqual([]);
    expect(placed.every((p) => p.court === null)).toBe(true);
    const capped = S.schedule(matches, { ...cfg, matchesPerDay: 1, venues: [{ venueId: 'v1', courts: ['A', 'B'] }] }).placed;
    expect(new Set(capped.map((p) => S.dhakaDate(Date.parse(p.start)))).size).toBe(3);
    const court = { matchNo: 5, start: 0, end: 10, venueId: 'v1', teams: [], deps: [] };
    expect(S.clashes({ ...court, matchNo: 6 }, [court], {})).toEqual([{ kind: 'court', matchNo: 5 }]);
  });

  it('names the clash for a manual edit: team, court, order', () => {
    const at = (h) => Date.parse(`2026-11-07T${String(h).padStart(2, '0')}:00:00Z`);
    const a = { matchNo: 1, start: at(10), end: at(12), venueId: 'v1', court: null, teams: ['x', 'y'], deps: [] };
    const b = { matchNo: 2, start: at(12), end: at(14), venueId: 'v1', court: null, teams: ['z', 'w'], deps: [] };
    const ko = { matchNo: 3, start: at(13), end: at(15), venueId: 'v2', court: null, teams: [], deps: [1] };
    const cfg = { bufferMin: 15, minRestHours: 2 };
    expect(S.clashes({ ...a, matchNo: 9, venueId: 'v2' }, [a], cfg)).toEqual([{ kind: 'team', matchNo: 1 }]);
    expect(S.clashes(b, [a], cfg)).toEqual([{ kind: 'court', matchNo: 1 }]);
    expect(S.clashes(ko, [a], cfg)).toEqual([{ kind: 'order', matchNo: 1 }]);
    expect(S.clashes({ ...a, start: at(13), end: at(15), venueId: 'v3' }, [ko], cfg)).toEqual([{ kind: 'order', matchNo: 3 }]);
    expect(S.clashes(a, [a], cfg)).toEqual([]);
    expect(S.clashes({ ...b, start: at(16), end: at(18) }, [a], {})).toEqual([]);
    expect(S.clashes({ ...ko, deps: undefined, teams: [], start: at(20), end: at(22) }, [{ ...a, deps: undefined }])).toEqual([]);
  });
});
