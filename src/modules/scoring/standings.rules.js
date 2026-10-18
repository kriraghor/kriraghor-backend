'use strict';

/**
 * M15 lite: final results and standings (pure; 100% coverage gate). M15-FR-09/10/11, M14 §6.5.
 *
 * A result is entered as a final score per engine:
 *   ball_by_ball (cricket): {a:{runs, wickets, balls}, b:{…}, decider?:'a'|'b'} (decider: super
 *     over, bowl-out or coin toss in a tied knockout)
 *   clock (football, futsal, basketball, kabaddi): {a:{score}, b:{score}, pens?:{a, b}}
 *   rally (badminton, volleyball, table tennis): {sets:[[a, b], …]}
 *   or a non-playing outcome: {outcome:'no_result'} | {outcome:'walkover', walkoverTo:'a'|'b'}
 * Standings re-apply the tournament's tiebreakers in order; head-to-head is a mini-table among the
 * tied teams only (re-applying the list); `lots` is the organiser's recorded draw. A tie nothing
 * breaks shares the position and `needsLots` (dependent placeholders wait).
 */
const OUTCOMES = ['win', 'draw', 'tie', 'no_result', 'walkover'];
const int = (v, min = 0, max = Infinity) => Number.isInteger(v) && v >= min && v <= max;

/** The rally target of set `i` (volleyball's deciding set is shorter). */
function setTarget(values, i, bestOf) {
  return values.finalPts && i === bestOf - 1 ? values.finalPts : values.points;
}

/** A valid finished set score under the rules (target, win by two, cap). */
function setOk([x, y], target, values) {
  if (!int(x) || !int(y) || x === y) return false;
  const [w, l] = x > y ? [x, y] : [y, x];
  if (values.cap && w === values.cap) return true;
  if (w < target) return false;
  if (w === target) return l <= target - (values.winBy2 ? 2 : 1);
  return Boolean(values.winBy2) && w - l === 2;
}

/**
 * Decides a result: {outcome, winner:'a'|'b'|null, margin} or {error}. Errors: RESULT_INVALID,
 * KNOCKOUT_NEEDS_WINNER (a knockout cannot end level: penalties, a decider, or sets).
 */
function decide(engine, input, { knockout = false, values = {} } = {}) {
  if (input.outcome === 'no_result') return knockout ? { error: 'KNOCKOUT_NEEDS_WINNER' } : { outcome: 'no_result', winner: null, margin: 0 };
  if (input.outcome === 'walkover') return ['a', 'b'].includes(input.walkoverTo) ? { outcome: 'walkover', winner: input.walkoverTo, margin: 0 } : { error: 'RESULT_INVALID' };
  if (engine === 'rally') {
    const bestOf = Number(values.bestOf);
    const need = Math.ceil(bestOf / 2);
    const sets = input.sets ?? [];
    if (!sets.length || sets.length > bestOf) return { error: 'RESULT_INVALID' };
    const won = { a: 0, b: 0 };
    for (let i = 0; i < sets.length; i += 1) {
      if (won.a === need || won.b === need || !setOk(sets[i], setTarget(values, i, bestOf), values)) return { error: 'RESULT_INVALID' };
      won[sets[i][0] > sets[i][1] ? 'a' : 'b'] += 1;
    }
    if (won.a !== need && won.b !== need) return { error: 'RESULT_INVALID' };
    const winner = won.a === need ? 'a' : 'b';
    return { outcome: 'win', winner, margin: Math.abs(won.a - won.b) };
  }
  const { a, b } = input;
  if (engine === 'ball_by_ball') {
    const side = (s) => s && int(s.runs) && int(s.wickets, 0, 10) && int(s.balls, 0, (values.overs ?? 50) * 6);
    if (!side(a) || !side(b)) return { error: 'RESULT_INVALID' };
    if (a.runs !== b.runs) return { outcome: 'win', winner: a.runs > b.runs ? 'a' : 'b', margin: Math.abs(a.runs - b.runs) };
    if (!knockout) return { outcome: 'tie', winner: null, margin: 0 };
    return ['a', 'b'].includes(input.decider) ? { outcome: 'tie', winner: input.decider, margin: 0 } : { error: 'KNOCKOUT_NEEDS_WINNER' };
  }
  if (!a || !b || !int(a.score) || !int(b.score)) return { error: 'RESULT_INVALID' };
  if (a.score !== b.score) return { outcome: 'win', winner: a.score > b.score ? 'a' : 'b', margin: Math.abs(a.score - b.score) };
  if (!knockout) return { outcome: 'draw', winner: null, margin: 0 };
  const p = input.pens;
  if (p && int(p.a) && int(p.b) && p.a !== p.b) return { outcome: 'draw', winner: p.a > p.b ? 'a' : 'b', margin: 0 };
  return { error: 'KNOCKOUT_NEEDS_WINNER' };
}

/** Table points for one side (§6.5, M15-FR-10): pW, pD or pT, pL, and kabaddi's pLc for a close loss. */
function pointsFor(values, { outcome, winner, margin }, side) {
  if (winner === side) return values.pW ?? 0;
  if (winner) return values.pLc !== undefined && outcome === 'win' && margin <= 7 ? values.pLc : (values.pL ?? 0);
  if (outcome === 'tie') return values.pT ?? values.pD ?? 0;
  return values.pD ?? values.pT ?? 0;
}

const blank = (teamId) => ({ teamId, played: 0, won: 0, drawn: 0, lost: 0, noResult: 0, points: 0, for: 0, against: 0, setsFor: 0, setsAgainst: 0, ballsFaced: 0, ballsBowled: 0, runsFor: 0, runsAgainst: 0 });

/** Adds one result to the two rows (results carry {teamA, teamB, outcome, winner, margin, score}). */
function add(rows, r, engine, values) {
  const A = rows.get(r.teamA);
  const B = rows.get(r.teamB);
  for (const [row, side, opp] of [
    [A, 'a', 'b'],
    [B, 'b', 'a'],
  ]) {
    row.played += 1;
    row.points += pointsFor(values, r, side);
    if (r.outcome === 'no_result') row.noResult += 1;
    else if (!r.winner) row.drawn += 1;
    else if (r.winner === side) row.won += 1;
    else row.lost += 1;
    if (r.outcome === 'walkover') {
      // Walkovers count as the rule's score (football 3–0) and stay out of run rate and sets.
      const goals = values.walkoverScore ?? 0;
      row.for += r.winner === side ? goals : 0;
      row.against += r.winner === side ? 0 : goals;
      continue;
    }
    if (r.outcome === 'no_result') continue;
    const s = r.score;
    if (engine === 'ball_by_ball') {
      const full = (values.overs ?? 50) * 6;
      const faced = (x) => (x.wickets >= (values.players ?? 11) - 1 ? full : x.balls);
      row.runsFor += s[side].runs;
      row.runsAgainst += s[opp].runs;
      row.ballsFaced += faced(s[side]);
      row.ballsBowled += faced(s[opp]);
    } else if (engine === 'rally') {
      for (const [x, y] of s.sets) {
        const [mine, theirs] = side === 'a' ? [x, y] : [y, x];
        row.for += mine;
        row.against += theirs;
        row.setsFor += mine > theirs ? 1 : 0;
        row.setsAgainst += mine > theirs ? 0 : 1;
      }
    } else {
      row.for += s[side].score;
      row.against += s[opp].score;
    }
  }
}

/** Builds rows for `teamIds` from the results among them. */
function rowsFor(teamIds, results, engine, values) {
  const rows = new Map(teamIds.map((id) => [id, blank(id)]));
  for (const r of results) if (rows.has(r.teamA) && rows.has(r.teamB)) add(rows, r, engine, values);
  return rows;
}

const rate = (runs, balls) => (balls ? (runs * 6) / balls : 0);
const ratio = (x, y) => (y ? x / y : x ? Infinity : 0);

/** The value a tiebreaker compares (higher is better). */
function metric(key, row) {
  switch (key) {
    case 'points':
      return row.points;
    case 'wins':
      return row.won;
    case 'net_run_rate':
    case 'nrr':
      return Math.round((rate(row.runsFor, row.ballsFaced) - rate(row.runsAgainst, row.ballsBowled)) * 1000) / 1000;
    case 'goal_difference':
    case 'point_difference':
    case 'score_difference':
      return row.for - row.against;
    case 'goals_scored':
    case 'points_scored':
      return row.for;
    case 'set_difference':
    case 'game_difference':
      return row.setsFor - row.setsAgainst;
    case 'set_ratio':
      return ratio(row.setsFor, row.setsAgainst);
    case 'point_ratio':
      return ratio(row.for, row.against);
    case 'fewer_no_results':
      return -row.noResult;
    default:
      // fair_play waits for cards (M15 full): it separates nobody.
      return 0;
  }
}

/**
 * Orders teams by the tiebreakers; returns groups in order (a group of more than one is a tie no
 * key broke). `ctx` = {results, engine, values, lots, all}.
 */
function order(teams, rows, keys, ctx) {
  if (teams.length <= 1 || !keys.length) return [teams];
  const [k, ...rest] = keys;
  if (k === 'head_to_head') {
    if (teams.length === ctx.all) return order(teams, rows, rest, ctx);
    const mini = rowsFor(teams, ctx.results, ctx.engine, ctx.values);
    const inner = order(teams, mini, ctx.keys, { ...ctx, all: teams.length });
    return inner.flatMap((g) => order(g, rows, rest, ctx));
  }
  if (k === 'lots') {
    const at = (id) => ctx.lots.indexOf(id);
    if (!teams.every((id) => at(id) >= 0)) return [teams];
    return [...teams].sort((x, y) => at(x) - at(y)).map((id) => [id]);
  }
  const value = (id) => metric(k, rows.get(id));
  const sorted = [...teams].sort((x, y) => value(y) - value(x));
  const groups = [];
  for (const id of sorted) {
    const last = groups[groups.length - 1];
    if (last && value(last[0]) === value(id)) last.push(id);
    else groups.push([id]);
  }
  return groups.flatMap((g) => order(g, rows, rest, ctx));
}

/**
 * The standings of one table (a league or a group). Returns rows in order with `position` (tied
 * teams share it) and `needsLots`. Tiebreakers always start with points (§6.5).
 */
function table(teamIds, results, { engine, values, tiebreakers = [], lots = [] }) {
  const counted = results.filter((r) => OUTCOMES.includes(r.outcome));
  const rows = rowsFor(teamIds, counted, engine, values);
  const keys = ['points', ...tiebreakers.filter((k) => k !== 'points')];
  const groups = order(teamIds, rows, keys, { results: counted, engine, values, lots, all: teamIds.length, keys });
  const out = [];
  for (const g of groups) {
    const position = out.length + 1;
    for (const id of g) out.push({ ...rows.get(id), nrr: metric('nrr', rows.get(id)), position, needsLots: g.length > 1 });
  }
  return out;
}

/**
 * Ranks teams that finished in the same place in different groups (best thirds, odd group counts):
 * points per match, then the first difference key per match, then goals or points for per match.
 * Ties nobody breaks share a rank (`needsLots`).
 */
function rankAcrossGroups(rows, tiebreakers = []) {
  const diffKey = tiebreakers.find((k) => !['points', 'head_to_head', 'lots', 'wins', 'fair_play'].includes(k)) ?? 'goal_difference';
  const per = (r, v) => (r.played ? v / r.played : 0);
  const score = (r) => [per(r, r.points), per(r, metric(diffKey, r)), per(r, r.for)];
  const sorted = [...rows].sort((x, y) => {
    const [a, b] = [score(x), score(y)];
    return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
  });
  const same = (x, y) => score(x).every((v, i) => v === score(y)[i]);
  return sorted.map((r) => ({ ...r, rank: sorted.findIndex((x) => same(x, r)) + 1, needsLots: sorted.filter((x) => same(x, r)).length > 1 }));
}

module.exports = { OUTCOMES, setTarget, setOk, decide, pointsFor, rowsFor, metric, order, table, rankAcrossGroups };
