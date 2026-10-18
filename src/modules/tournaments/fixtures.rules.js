'use strict';

/**
 * M14 fixture generation (pure; 100% coverage gate). M14-FR-15, §6.2–6.4, §6.7.
 *
 * Teams arrive as a seeded list of ids (the draw decides the order). Matches come out numbered
 * (`matchNo`, unique per tournament) with references for their two sides:
 *   {type:'team', teamId} · {type:'winner', matchNo} · {type:'loser', matchNo}
 *   {type:'group_pos', group, pos} · {type:'league_pos', pos} · {type:'ranked', pos, rank}
 * A `ranked` reference is "the rank-th best of all teams finishing pos-th in their group"
 * (best thirds, odd group counts). References resolve as results arrive (M14 service).
 */
const crypto = require('crypto');

const BYE = null;
const GROUP_NAMES = 'ABCDEFGHIJKLMNOP';
const team = (teamId) => ({ type: 'team', teamId });

// ---------------------------------------------------------------- round robin (circle method, §6.2)
/**
 * Circle (polygon) method: with n entries (plus a BYE when odd), entry n−1 stays fixed and round r
 * pairs r with the fixed entry and (r+k) with (r−k) mod n−1 for k = 1…n/2−1. The team drawn against
 * the BYE rests that round. Home alternates by round for the fixed entry and by k for the others,
 * which keeps every team's home and away count within one of each other (tested for n = 2…20).
 * Returns [{round, home, away}] with rounds from 1.
 */
function roundRobin(entries) {
  const list = entries.length % 2 ? [...entries, BYE] : [...entries];
  const n = list.length;
  const m = n - 1;
  const out = [];
  for (let r = 0; r < m; r += 1) {
    const pairs = [r % 2 ? [list[m], list[r]] : [list[r], list[m]]];
    for (let k = 1; k < n / 2; k += 1) {
      const a = list[(r + k) % m];
      const b = list[(r - k + m) % m];
      pairs.push(k % 2 ? [a, b] : [b, a]);
    }
    for (const [home, away] of pairs) if (home !== BYE && away !== BYE) out.push({ round: r + 1, home, away });
  }
  return out;
}

/** Double league: the second cycle repeats the first with home and away swapped, rounds continuing. */
function doubleRoundRobin(entries) {
  const first = roundRobin(entries);
  const rounds = first.reduce((m, x) => Math.max(m, x.round), 0);
  return [...first, ...first.map((x) => ({ round: x.round + rounds, home: x.away, away: x.home }))];
}

// ---------------------------------------------------------------- groups and draws (§6.3)
/** Group sizes for n teams in g groups: the first n mod g groups get one more. */
function groupSizes(n, g) {
  const base = Math.floor(n / g);
  return Array.from({ length: g }, (_, i) => base + (i < n % g ? 1 : 0));
}

/**
 * Serpentine distribution: seeds 1..g go to A..g, g+1..2g to g..A, and so on. A last, partial row
 * always fills from A, so the bigger groups come first (matching groupSizes).
 */
function snake(seeded, g) {
  const groups = Array.from({ length: g }, () => []);
  const fullRows = Math.floor(seeded.length / g);
  seeded.forEach((id, i) => {
    const row = Math.floor(i / g);
    const col = i % g;
    groups[row % 2 === 0 || row === fullRows ? col : g - 1 - col].push(id);
  });
  return groups;
}

/**
 * A random draw that anyone can replay from its published seed: Fisher–Yates with numbers taken from
 * SHA-256(seed:i). The service creates the seed with crypto.randomBytes and stores it on the stage.
 */
function shuffle(ids, seed) {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const n = crypto.createHash('sha256').update(`${seed}:${i}`).digest().readUIntBE(0, 6);
    const j = n % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------- knockout (§6.4)
/** Standard seed order for a bracket of size S (a power of two): border(8) = 1,8,4,5,2,7,3,6. */
function border(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

const nextPow2 = (q) => 2 ** Math.ceil(Math.log2(q));

/** Round names by how many entrants a round starts with. */
function roundName(entrants) {
  if (entrants === 2) return 'final';
  if (entrants === 4) return 'semi_final';
  if (entrants === 8) return 'quarter_final';
  return `round_of_${entrants}`;
}

/**
 * Places seeded references (best first) in a bracket of size S with byes for the top seeds (a bye is
 * not a match: the team goes straight into the next round).
 */
function bySeed(refs) {
  const size = nextPow2(refs.length);
  return border(size).map((s) => (s <= refs.length ? refs[s - 1] : BYE));
}

/**
 * Builds the knockout rounds from first-round slots (pairs in order: slots 0–1, 2–3, …). Returns
 * matches without numbers: [{key, round, roundName, teamA, teamB}], where references to earlier
 * matches use {type:'winner'|'loser', key}. A third-place match is added only when two semi-finals
 * exist (with a bye in a semi there is only one, and no third place).
 */
function bracket(slots, { thirdPlace = false } = {}) {
  const matches = [];
  let entries = slots;
  let round = 1;
  let semis = [];
  while (entries.length > 1) {
    const name = roundName(entries.length);
    const next = [];
    for (let i = 0; i < entries.length; i += 2) {
      const a = entries[i];
      const b = entries[i + 1];
      if (a === BYE || b === BYE) {
        next.push(a === BYE ? b : a);
        continue;
      }
      const key = matches.length + 1;
      matches.push({ key, round, roundName: name, teamA: a, teamB: b });
      next.push({ type: 'winner', key });
    }
    if (name === 'semi_final') semis = matches.filter((m) => m.round === round);
    entries = next;
    round += 1;
  }
  if (thirdPlace && semis.length === 2) {
    const final = matches.pop();
    matches.push({ key: matches.length + 1, round: final.round, roundName: 'third_place', teamA: { type: 'loser', key: semis[0].key }, teamB: { type: 'loser', key: semis[1].key } });
    matches.push({ ...final, key: matches.length + 1 });
    // The final's own references never point at the third-place match, so renumbering it is safe.
  }
  return matches;
}

/**
 * Group → knockout cross-over (§6.4). Groups are paired (A,B), (C,D)…; within a pair X1 v Y2 and
 * Y1 v X2 go to opposite halves, so group-mates can only meet in the final. With 4 qualifiers:
 * X1 v Y4 and Y2 v X3 in one half, Y1 v X4 and X2 v Y3 in the other. One qualifier: X1 v Y1.
 * Returns first-round slots, or null when the table does not apply (odd groups, best extras, or a
 * count that is not a power of two): then `rankedSlots` is used.
 */
function crossOverSlots(groupCount, qualifiers, bestExtra) {
  const total = groupCount * qualifiers;
  if (groupCount % 2 || bestExtra || ![1, 2, 4].includes(qualifiers) || total < 2 || nextPow2(total) !== total) return null;
  const g = (i, pos) => ({ type: 'group_pos', group: GROUP_NAMES[i], pos });
  const top = [];
  const bottom = [];
  for (let p = 0; p < groupCount; p += 2) {
    const [x, y] = [p, p + 1];
    if (qualifiers === 1) top.push(g(x, 1), g(y, 1));
    if (qualifiers === 2) {
      top.push(g(x, 1), g(y, 2));
      bottom.push(g(y, 1), g(x, 2));
    }
    if (qualifiers === 4) {
      top.push(g(x, 1), g(y, 4), g(y, 2), g(x, 3));
      bottom.push(g(y, 1), g(x, 4), g(x, 2), g(y, 3));
    }
  }
  return [...top, ...bottom];
}

/**
 * The general case: every group's qualifiers ranked into one seed list (all winners, best first,
 * then all runners-up, …, then the best extras), placed by border(S) with byes for the top seeds.
 */
function rankedSlots(groupCount, qualifiers, bestExtra) {
  const refs = [];
  for (let pos = 1; pos <= qualifiers; pos += 1) for (let rank = 1; rank <= groupCount; rank += 1) refs.push({ type: 'ranked', pos, rank });
  for (let rank = 1; rank <= bestExtra; rank += 1) refs.push({ type: 'ranked', pos: qualifiers + 1, rank });
  return bySeed(refs);
}

// ---------------------------------------------------------------- the whole tournament
/**
 * Generates stages and numbered matches for a format.
 *   league / double_league: one table; `knockoutTopN` (0, 2, 4, 8) adds a knockout from the table.
 *   groups_knockout: `groupCount` groups (snake), `qualifiersPerGroup`, `bestExtra`, then a knockout.
 *   knockout: the seeded teams with byes.
 * Group matches are interleaved by round (A R1, B R1, A R2, …) so groups progress together.
 * Numbering follows stage, round, then group; within a knockout the third-place match comes before
 * the final. Returns {stages:[{key, kind, seq, groups?:[{name, teamIds}]}], matches:[…]}.
 */
function generate(format, teamIds, cfg = {}) {
  const stages = [];
  const matches = [];
  const push = (stageKey, m) => matches.push({ matchNo: matches.length + 1, stageKey, ...m });
  const addKnockout = (slots, seq) => {
    const ko = bracket(slots, { thirdPlace: Boolean(cfg.thirdPlace) });
    stages.push({ key: 'K', kind: 'knockout', seq });
    const offset = matches.length;
    const remap = (ref) => (ref.type === 'winner' || ref.type === 'loser' ? { type: ref.type, matchNo: ref.key + offset } : ref);
    for (const m of ko) push('K', { group: null, round: m.round, roundName: m.roundName, teamA: remap(m.teamA), teamB: remap(m.teamB) });
  };

  if (format === 'league' || format === 'double_league') {
    stages.push({ key: 'L', kind: 'league', seq: 1 });
    const rr = (format === 'league' ? roundRobin : doubleRoundRobin)(teamIds);
    for (const m of rr) push('L', { group: null, round: m.round, roundName: null, teamA: team(m.home), teamB: team(m.away) });
    const top = cfg.knockoutTopN ?? 0;
    if (top >= 2) addKnockout(bySeed(Array.from({ length: top }, (_, i) => ({ type: 'league_pos', pos: i + 1 }))), 2);
  } else if (format === 'groups_knockout') {
    const g = cfg.groupCount;
    const groups = snake(teamIds, g).map((ids, i) => ({ name: GROUP_NAMES[i], teamIds: ids }));
    stages.push({ key: 'G', kind: 'group', seq: 1, groups });
    const perGroup = groups.map((grp) => roundRobin(grp.teamIds).map((m) => ({ ...m, group: grp.name })));
    const rounds = perGroup.reduce((max, list) => list.reduce((mx, m) => Math.max(mx, m.round), max), 0);
    for (let r = 1; r <= rounds; r += 1) {
      for (const list of perGroup) for (const m of list.filter((x) => x.round === r)) push('G', { group: m.group, round: r, roundName: null, teamA: team(m.home), teamB: team(m.away) });
    }
    const q = cfg.qualifiersPerGroup;
    const extra = cfg.bestExtra ?? 0;
    addKnockout(crossOverSlots(g, q, extra) ?? rankedSlots(g, q, extra), 2);
  } else {
    addKnockout(bySeed(teamIds.map(team)), 1);
  }
  return { stages, matches };
}

/** How many matches a format makes (the console shows it before generating). */
function matchCount(format, n, cfg = {}) {
  return generate(format, Array.from({ length: n }, (_, i) => `t${i}`), cfg).matches.length;
}

/**
 * Format checks (M14 §4.2, §6.1 capacity_valid). Returns an error code or null.
 * Groups need at least two teams each at max capacity; qualifiers cannot exceed the smallest group.
 */
function formatBlock(format, { minTeams, maxTeams, groupCount, qualifiersPerGroup, bestExtra = 0, knockoutTopN = 0 }) {
  if (!(minTeams >= 2 && minTeams <= maxTeams)) return 'CAPACITY_INVALID';
  if (format === 'groups_knockout') {
    if (!(groupCount >= 2 && groupCount <= 16) || maxTeams < 2 * groupCount || minTeams < 2 * groupCount) return 'GROUPS_INVALID';
    // At least one team in the smallest group (at the minimum team count) must miss out.
    const smallest = Math.floor(minTeams / groupCount);
    if (!(qualifiersPerGroup >= 1 && qualifiersPerGroup <= Math.min(4, smallest - 1))) return 'QUALIFIERS_INVALID';
    if (!(bestExtra >= 0 && bestExtra < groupCount)) return 'QUALIFIERS_INVALID';
  }
  if (format === 'league' || format === 'double_league') {
    if (![0, 2, 4, 8].includes(knockoutTopN) || knockoutTopN > minTeams) return 'KNOCKOUT_TOP_INVALID';
  }
  return null;
}

module.exports = { BYE, GROUP_NAMES, roundRobin, doubleRoundRobin, groupSizes, snake, shuffle, border, roundName, bySeed, bracket, crossOverSlots, rankedSlots, generate, matchCount, formatBlock };
