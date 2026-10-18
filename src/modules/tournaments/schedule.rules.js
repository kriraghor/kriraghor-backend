'use strict';

/**
 * M14 scheduling (pure; 100% coverage gate). M14-FR-17/18, §6.6 without M10 courts (step 2).
 *
 * The greedy scheduler walks the candidate slots (date, time, venue, court) in order and puts the
 * first match that fits: its known teams are free (with the buffer), rested (`minRestHours`) and under
 * their daily limit; the matches it depends on (knockout sources, the whole group or league stage for
 * a position reference) have ended plus rest; the court is free; the day is under its cap. What does
 * not fit is reported with a reason, never dropped. Times are Dhaka local (UTC+6, no DST).
 */
const DHAKA_MS = 6 * 3600000;
const MIN = 60000;

/** The instant of a Dhaka calendar date and HH:MM. */
function at(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - DHAKA_MS;
}
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const dhakaDate = (ms) => new Date(ms + DHAKA_MS).toISOString().slice(0, 10);

/** The team ids a match already knows (placeholders contribute none). */
const teamsOf = (m) => [m.teamA, m.teamB].filter((r) => r && r.type === 'team').map((r) => r.teamId);

/**
 * The matches a match waits for: winner/loser sources; every match of a group for a group position;
 * every league match for a league position; every group-stage match for a ranked reference.
 */
function depsOf(m, all) {
  const out = new Set();
  for (const r of [m.teamA, m.teamB]) {
    if (!r) continue;
    if (r.type === 'winner' || r.type === 'loser') out.add(r.matchNo);
    if (r.type === 'group_pos') for (const x of all) if (x.stageKey === 'G' && x.group === r.group) out.add(x.matchNo);
    if (r.type === 'league_pos') for (const x of all) if (x.stageKey === 'L') out.add(x.matchNo);
    if (r.type === 'ranked') for (const x of all) if (x.stageKey === 'G') out.add(x.matchNo);
  }
  return [...out];
}

/**
 * Problems with putting `c` ({matchNo, start, end, venueId, court, teams, deps}) next to `others`
 * (the same shape, placed): team overlap or rest, court overlap, and order against its sources and
 * dependants. Returns [{kind:'team'|'court'|'order', matchNo}], empty when it fits. Used by the
 * scheduler and by manual edits (409 SCHEDULE_CLASH with details).
 */
function clashes(c, others, { bufferMin = 0, minRestHours = 0 } = {}) {
  const buf = bufferMin * MIN;
  const rest = minRestHours * 3600000;
  const out = [];
  for (const o of others) {
    if (o.matchNo === c.matchNo) continue;
    const shared = o.teams.some((t) => c.teams.includes(t));
    const gap = Math.max(c.start - o.end, o.start - c.end);
    if (shared && gap < Math.max(buf, rest)) out.push({ kind: 'team', matchNo: o.matchNo });
    else if (o.venueId === c.venueId && (o.court ?? null) === (c.court ?? null) && gap < buf) out.push({ kind: 'court', matchNo: o.matchNo });
    else if ((c.deps ?? []).includes(o.matchNo) && c.start < o.end + rest) out.push({ kind: 'order', matchNo: o.matchNo });
    else if ((o.deps ?? []).includes(c.matchNo) && o.start < c.end + rest) out.push({ kind: 'order', matchNo: o.matchNo });
  }
  return out;
}

/**
 * cfg: {startDate, endDate, weekdays:[0–6], slots:['HH:MM'], durationMin, bufferMin, matchesPerDay
 * (null = no cap), minRestHours, maxPerTeamPerDay (default 1), restDates:[], venues:[{venueId,
 * courts:[label]}]} (a venue without courts is one pitch). `fixed` are matches already placed (kept).
 * Returns {placed:[{matchNo, start, end, venueId, court}], unscheduled:[{matchNo, reason}]} with ISO
 * times. Reasons: `waits_for_unscheduled` (a source could not be placed) or `no_slot`.
 */
function schedule(matches, cfg, fixed = []) {
  const perTeamDay = cfg.maxPerTeamPerDay ?? 1;
  const dur = cfg.durationMin * MIN;
  const placed = fixed.map((f) => ({ ...f, start: Date.parse(f.start), end: Date.parse(f.end) }));
  const out = [];
  const todo = matches.filter((m) => !placed.some((p) => p.matchNo === m.matchNo)).map((m) => ({ m, teams: teamsOf(m), deps: depsOf(m, matches) }));
  const pitches = cfg.venues.flatMap((v) => (v.courts?.length ? v.courts : [null]).map((court) => ({ venueId: v.venueId, court })));
  const slots = [...cfg.slots].sort();
  const days = [];
  for (let d = cfg.startDate; d <= cfg.endDate && days.length < 400; d = addDays(d, 1)) {
    if (cfg.weekdays.includes(weekday(d)) && !(cfg.restDates ?? []).includes(d)) days.push(d);
  }
  for (const day of days) {
    for (const time of slots) {
      for (const pitch of pitches) {
        if (!todo.length) break;
        const start = at(day, time);
        const today = placed.filter((p) => dhakaDate(p.start) === day);
        if (cfg.matchesPerDay && today.length >= cfg.matchesPerDay) break;
        const i = todo.findIndex(({ m, teams, deps }) => {
          if (!deps.every((d) => placed.some((p) => p.matchNo === d))) return false;
          if (teams.some((t) => today.filter((p) => p.teams.includes(t)).length >= perTeamDay)) return false;
          const c = { matchNo: m.matchNo, start, end: start + dur, ...pitch, teams, deps };
          return clashes(c, placed, cfg).length === 0;
        });
        if (i < 0) continue;
        const [{ m, teams, deps }] = todo.splice(i, 1);
        const p = { matchNo: m.matchNo, start, end: start + dur, ...pitch, teams, deps };
        placed.push(p);
        out.push({ matchNo: p.matchNo, start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString(), venueId: p.venueId, court: p.court });
      }
    }
  }
  const missing = new Set(todo.map((x) => x.m.matchNo));
  return {
    placed: out,
    unscheduled: todo.map(({ m, deps }) => ({ matchNo: m.matchNo, reason: deps.some((d) => missing.has(d)) ? 'waits_for_unscheduled' : 'no_slot' })),
  };
}

module.exports = { at, addDays, weekday, dhakaDate, teamsOf, depsOf, clashes, schedule };
