'use strict';

/**
 * M21 esports rules (§5, §6, §8). Pure functions, no I/O, 100% branch coverage (CLAUDE.md: money and
 * points calculations). Money is integer poisha.
 */

// ---------------------------------------------------------------- state machines (§8)

/** §8.1 tournament (groups and the tournament-level "disputed" state come in step 2). */
const TOURNAMENT = {
  draft: ['review', 'cancelled'],
  review: ['draft', 'scheduled', 'cancelled'],
  scheduled: ['registration_open', 'cancelled'],
  registration_open: ['registration_closed', 'cancelled'],
  registration_closed: ['check_in', 'cancelled'],
  check_in: ['live', 'cancelled'],
  live: ['results_pending', 'cancelled'],
  results_pending: ['finalised', 'cancelled'],
  finalised: ['paid_out'],
  paid_out: [],
  cancelled: [],
};
/** §8.2 registration. */
const REGISTRATION = {
  pending_payment: ['confirmed', 'cancelled', 'withdrawn'],
  waitlisted: ['offered', 'cancelled', 'withdrawn'],
  offered: ['pending_payment', 'confirmed', 'waitlisted', 'cancelled', 'withdrawn'],
  confirmed: ['checked_in', 'no_show', 'withdrawn', 'refunded', 'disqualified'],
  checked_in: ['disqualified', 'refunded'],
  withdrawn: ['refunded'],
  no_show: [],
  refunded: [],
  disqualified: [],
  cancelled: [],
};
/** §8.3 match. */
const MATCH = {
  scheduled: ['room_ready', 'cancelled'],
  room_ready: ['room_revealed', 'cancelled'],
  room_revealed: ['live', 'results_pending', 'cancelled'],
  live: ['results_pending', 'cancelled'],
  results_pending: ['disputed', 'final'],
  disputed: ['results_pending', 'final'],
  final: [],
  cancelled: [],
};
const can = (machine) => (from, to) => Boolean(machine[from]?.includes(to));

/** Registrations that hold a slot (FR-09: at most max_slots of these). */
const HOLDING = ['pending_payment', 'confirmed', 'checked_in'];
/** Entries that take part (paid and not out). */
const PLAYING = ['confirmed', 'checked_in'];
/** Tournament states visible to the public. */
const PUBLIC = ['scheduled', 'registration_open', 'registration_closed', 'check_in', 'live', 'results_pending', 'finalised', 'paid_out', 'cancelled'];

// ---------------------------------------------------------------- authoring (FR-06, FR-07)

/**
 * Why a draft cannot go to review (null when it can). `mode` is the catalogue row
 * { teamSize, maxTeams, maxPlayers }; times are Dates; `now` the clock.
 */
function draftBlock(d, mode, now) {
  if (!d.prizes.length) return 'PRIZE_TABLE_REQUIRED';
  const places = d.prizes.map((p) => p.place).sort((a, b) => a - b);
  if (places.some((p, i) => p !== i + 1)) return 'PRIZE_PLACES_INVALID';
  if (d.prizes.some((p) => !(Number.isSafeInteger(p.amount) && p.amount > 0))) return 'PRIZE_AMOUNT_INVALID';
  if (places.length > d.maxSlots) return 'PRIZE_PLACES_INVALID';
  if (d.minParticipants > d.maxSlots) return 'MIN_ABOVE_MAX';
  const entryUnit = mode.teamSize > 1 ? 'squad' : 'player';
  if (d.entryUnit !== entryUnit) return 'ENTRY_UNIT_INVALID';
  if (d.maxSlots > mode.maxTeams) return 'SLOTS_ABOVE_LOBBY';
  if (!d.matches.length || (d.format === 'single_match' && d.matches.length !== 1)) return 'SCHEDULE_INVALID';
  if (!(now < d.registrationOpensAt && d.registrationOpensAt < d.registrationClosesAt && d.registrationClosesAt <= d.startsAt)) return 'SCHEDULE_INVALID';
  const starts = d.matches.map((m) => m.startsAt.getTime());
  if (starts[0] !== d.startsAt.getTime() || starts.some((t, i) => i > 0 && t <= starts[i - 1])) return 'SCHEDULE_INVALID';
  if (d.placementPoints.length < 1 || d.placementPoints.some((p) => !Number.isInteger(p) || p < 0)) return 'POINTS_INVALID';
  return null;
}

/** Fields that never change after publish (FR-07, edge case 18). */
const LOCKED_AFTER_PUBLISH = ['gameId', 'modeId', 'format', 'entryUnit', 'entryPolicy', 'entryFee', 'maxSlots', 'minParticipants', 'prizes', 'killReward', 'placementPoints', 'killPoints', 'matches', 'registrationOpensAt', 'registrationClosesAt', 'startsAt'];
const lockedChange = (patch) => LOCKED_AFTER_PUBLISH.filter((k) => patch[k] !== undefined);

/** Check-in window of a stage (FR-13), from its first match. */
const checkinWindow = (firstStart, openMin, closeMin) => ({
  opensAt: new Date(firstStart.getTime() - openMin * 60000),
  closesAt: new Date(firstStart.getTime() - closeMin * 60000),
});
const revealAt = (startsAt, minutes) => new Date(startsAt.getTime() - minutes * 60000);

// ---------------------------------------------------------------- registration (FR-08 to FR-13)

/** Lowest free slot number, or null when full. */
function freeSlot(taken, max) {
  for (let s = 1; s <= max; s += 1) if (!taken.has(s)) return s;
  return null;
}

/**
 * Who plays: the listed players and substitutes against the mode (FR-05, Q127). Returns an error code
 * or null. Profiles are { id, userId, status, gameId }.
 */
function rosterBlock({ players, substitutes, mode, gameId, registrantUserId, entryUnit }) {
  if (players.length !== mode.teamSize || substitutes.length > mode.maxSubs) return 'ESPORTS_SQUAD_SIZE_INVALID';
  const all = [...players, ...substitutes];
  if (new Set(all.map((p) => p.userId)).size !== all.length) return 'ESPORTS_SQUAD_SIZE_INVALID';
  if (all.some((p) => p.gameId !== gameId || p.status !== 'verified')) return 'ESPORTS_GAME_PROFILE_REQUIRED';
  if (entryUnit === 'player' && players[0].userId !== registrantUserId) return 'ESPORTS_GAME_PROFILE_REQUIRED';
  if (entryUnit === 'squad' && !all.some((p) => p.userId === registrantUserId)) return 'ESPORTS_NOT_IN_SQUAD';
  return null;
}

/** A captain's declared split (FR-24): every playing member once, whole percents summing to 100. */
function splitBlock(split, playerIds) {
  if (split.length !== playerIds.length) return 'SPLIT_INVALID';
  if (new Set(split.map((s) => s.userId)).size !== split.length) return 'SPLIT_INVALID';
  if (split.some((s) => !playerIds.includes(s.userId) || !Number.isInteger(s.pct) || s.pct < 0)) return 'SPLIT_INVALID';
  return split.reduce((a, s) => a + s.pct, 0) === 100 ? null : 'SPLIT_INVALID';
}

/**
 * §6.6 refund matrix. Returns the poisha refunded for an entry that paid `paid`.
 *   cancelled (staff) / min_not_met → 100%
 *   withdraw / suspended, before close → esports.withdraw_refund_pct
 *   after close, no-show, disqualified, banned → 0
 */
function refundAmount(situation, { paid, beforeClose, withdrawRefundPct }) {
  if (situation === 'cancelled' || situation === 'min_not_met') return paid;
  if ((situation === 'withdraw' || situation === 'suspended') && beforeClose) return Math.floor((paid * withdrawRefundPct) / 100);
  return 0;
}

/** Entries short of checked-in players at close become no-shows (FR-13). */
const isNoShow = (checkedIn, teamSize) => checkedIn < teamSize;

// ---------------------------------------------------------------- results and points (FR-18, FR-19)

/**
 * Validate a bulk result entry for one match. rows: [{ registrationId, placement|null, kills:[{userId, kills}] }],
 * entries: Map registrationId → Set(userIds playing). Returns an error code or null.
 */
function resultsBlock(rows, entries) {
  const seen = new Set();
  const placements = new Set();
  for (const r of rows) {
    if (!entries.has(r.registrationId) || seen.has(r.registrationId)) return 'ESPORTS_RESULT_ENTRY_UNKNOWN';
    seen.add(r.registrationId);
    if (r.placement !== null) {
      if (!Number.isInteger(r.placement) || r.placement < 1 || r.placement > entries.size) return 'ESPORTS_PLACEMENT_INVALID';
      if (placements.has(r.placement)) return 'ESPORTS_PLACEMENT_DUPLICATE';
      placements.add(r.placement);
    }
    const players = entries.get(r.registrationId);
    for (const k of r.kills) {
      if (!players.has(k.userId)) return 'ESPORTS_KILLS_MISMATCH';
      if (!Number.isInteger(k.kills) || k.kills < 0) return 'ESPORTS_KILLS_MISMATCH';
    }
    if (r.placement === null && r.kills.some((k) => k.kills > 0)) return 'ESPORTS_KILLS_MISMATCH';
  }
  return null;
}

/** Points for one entry in one match (FR-19): placement points + kills × kill points; DNP scores 0. */
function points({ placement, kills }, { placementPoints, killPoints }) {
  const place = placement === null ? 0 : placementPoints[placement - 1] ?? 0;
  const kill = placement === null ? 0 : kills * killPoints;
  return { placementPoints: place, killPointsTotal: kill, total: place + kill };
}

/**
 * Standings (FR-19, §6.4). entries: [{ registrationId, registeredAt }]; results: [{ registrationId,
 * matchSeq, placement|null, kills, total }]. Tie-breakers: most wins, most kills, best placement in
 * the latest match played by anyone (DNP last), earliest registration.
 */
function standings(entries, results) {
  const latestSeq = results.reduce((m, r) => Math.max(m, r.matchSeq), 0);
  const rows = entries.map((e) => {
    const mine = results.filter((r) => r.registrationId === e.registrationId);
    const last = mine.find((r) => r.matchSeq === latestSeq);
    return {
      registrationId: e.registrationId,
      registeredAt: e.registeredAt,
      totalPoints: mine.reduce((a, r) => a + r.total, 0),
      wins: mine.filter((r) => r.placement === 1).length,
      kills: mine.reduce((a, r) => a + r.kills, 0),
      lastPlacement: last && last.placement !== null ? last.placement : null,
      matchesPlayed: mine.filter((r) => r.placement !== null).length,
    };
  });
  const lastKey = (p) => (p === null ? Number.MAX_SAFE_INTEGER : p);
  rows.sort(
    (a, b) =>
      b.totalPoints - a.totalPoints ||
      b.wins - a.wins ||
      b.kills - a.kills ||
      lastKey(a.lastPlacement) - lastKey(b.lastPlacement) ||
      a.registeredAt.getTime() - b.registeredAt.getTime()
  );
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

// ---------------------------------------------------------------- prizes (FR-23 to FR-25, §6.5)

/**
 * Awards from the final standings: place prizes to ranks 1..N (an empty place is not paid) and a kill
 * reward per entry for its players' kills (edge case 17: none for 0). killsByEntry: Map registrationId → kills.
 */
function awards({ ranking, prizes, killReward, killsByEntry }) {
  const out = [];
  for (const p of [...prizes].sort((a, b) => a.place - b.place)) {
    const entry = ranking[p.place - 1];
    if (entry) out.push({ registrationId: entry.registrationId, kind: 'place', place: p.place, amount: p.amount });
  }
  if (killReward > 0) {
    for (const entry of ranking) {
      const kills = killsByEntry.get(entry.registrationId) ?? 0;
      if (kills > 0) out.push({ registrationId: entry.registrationId, kind: 'kill_reward', place: null, amount: kills * killReward });
    }
  }
  return out;
}

/**
 * Split one place award between the players (FR-24, §6.5 C): the captain's declared percents, else
 * equal shares among those who played; every remainder poisha goes to the captain (or the first
 * player when the captain did not play). Shares of 0 are dropped.
 */
function splitAward(amount, { playerIds, captainId, split }) {
  const shares = split
    ? split.map((s) => ({ userId: s.userId, amount: Math.floor((amount * s.pct) / 100) }))
    : playerIds.map((u) => ({ userId: u, amount: Math.floor(amount / playerIds.length) }));
  const rest = amount - shares.reduce((a, s) => a + s.amount, 0);
  const to = shares.find((s) => s.userId === captainId) ?? shares[0];
  to.amount += rest;
  return shares.filter((s) => s.amount > 0);
}

/** A kill-reward award goes to each player for their own kills. */
/**
 * M22: the per-kill reward actually paid when an organiser capped the paid kills (the fund covers
 * reward × cap): the full reward while the tournament's kills stay within the cap, else the capped
 * total shared over every kill, rounded down (the rest returns to the organiser's fund).
 */
function cappedKillReward(killReward, totalKills, cap) {
  if (!cap || totalKills <= cap) return killReward;
  return Math.floor((killReward * cap) / totalKills);
}

const killShares = (perPlayerKills, killReward) => perPlayerKills.filter((k) => k.kills > 0).map((k) => ({ userId: k.userId, amount: k.kills * killReward }));

/** What finalising costs and earns (§6.5): the subsidy when prizes exceed fees, else revenue. */
function settlementPreview(collected, paid) {
  return { collected, paid, subsidy: Math.max(0, paid - collected), revenue: Math.max(0, collected - paid) };
}

// ---------------------------------------------------------------- disputes (FR-20)

/** Why a player cannot dispute now (null when they can). */
function disputeBlock({ matchStatus, disputeClosesAt, now, isEntrant, openOrUsed, max }) {
  if (!isEntrant) return 'ESPORTS_NOT_IN_MATCH';
  if (!['results_pending', 'disputed'].includes(matchStatus) || !disputeClosesAt || now > disputeClosesAt) return 'ESPORTS_DISPUTE_WINDOW_CLOSED';
  if (openOrUsed >= max) return 'ESPORTS_DISPUTE_LIMIT';
  return null;
}

// ---------------------------------------------------------------- ranking (FR-28, §6.8)

/** Percentile placement score: 100 for the winner of N entries. */
const placementScore = (n, rank) => (100 * (n - rank + 1)) / n;
const tournamentScore = ({ placement, kills, tierWeight }) => (placement + 2 * kills) * tierWeight;
const decay = (days, halfLife) => Math.pow(0.5, days / halfLife);

/**
 * Rank players for one game. entries: [{ userId, placementScore, kills, tierWeight, finalisedAt }].
 * Rolling: last `windowDays`, decayed, at least `minTournaments`. Season: [from, to) without decay.
 * Returns [{ userId, points (3 dp), tournaments, rank }], best first (ties share nothing: earlier
 * tie-break by more tournaments, then userId for a stable order).
 */
function rankPlayers(entries, { now, scope, halfLifeDays, minTournaments, windowDays = 365, from = null, to = null }) {
  const byUser = new Map();
  for (const e of entries) {
    const t = e.finalisedAt.getTime();
    const inWindow = scope === 'rolling' ? t > now.getTime() - windowDays * 86400000 && t <= now.getTime() : t >= from.getTime() && t < to.getTime();
    if (!inWindow) continue;
    const base = tournamentScore({ placement: e.placementScore, kills: e.kills, tierWeight: e.tierWeight });
    const score = scope === 'rolling' ? base * decay((now.getTime() - t) / 86400000, halfLifeDays) : base;
    const cur = byUser.get(e.userId) ?? { userId: e.userId, points: 0, tournaments: 0 };
    cur.points += score;
    cur.tournaments += 1;
    byUser.set(e.userId, cur);
  }
  const rows = [...byUser.values()].filter((r) => r.tournaments >= minTournaments).map((r) => ({ ...r, points: Math.round(r.points * 1000) / 1000 }));
  rows.sort((a, b) => b.points - a.points || b.tournaments - a.tournaments || (a.userId < b.userId ? -1 : 1));
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Season key for a date in Asia/Dhaka: quarters, e.g. 2026-S4. */
function seasonOf(date) {
  const d = new Date(date.getTime() + 6 * 3600000);
  return `${d.getUTCFullYear()}-S${Math.floor(d.getUTCMonth() / 3) + 1}`;
}
/** [from, to) of a season key in UTC (Dhaka quarter boundaries). */
function seasonRange(key) {
  const [, y, s] = /^(\d{4})-S([1-4])$/.exec(key);
  const start = Date.UTC(Number(y), (Number(s) - 1) * 3, 1) - 6 * 3600000;
  const end = Date.UTC(Number(y), Number(s) * 3, 1) - 6 * 3600000;
  return { from: new Date(start), to: new Date(end) };
}

// ---------------------------------------------------------------- privacy (FR-32)

/** `5123•••890` on public pages; short UIDs keep two characters at each end. */
function maskUid(uid) {
  if (uid.length <= 6) return `${uid.slice(0, 2)}•••${uid.slice(-2)}`;
  return `${uid.slice(0, 4)}•••${uid.slice(-3)}`;
}

/** URL-safe slug from a title (ASCII words), with a suffix for uniqueness. */
function slugify(title, suffix) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base ? `${base}-${suffix}` : suffix;
}

/** Stream URLs: https on a known host only (FR-29); the parsing lives in streams.rules (shared with M23). */
const streamBlock = (platform, url) => require('./streams.rules').parseStream(platform, url).error ?? null;

module.exports = {
  TOURNAMENT,
  REGISTRATION,
  MATCH,
  HOLDING,
  PLAYING,
  PUBLIC,
  LOCKED_AFTER_PUBLISH,
  canTournament: can(TOURNAMENT),
  canRegistration: can(REGISTRATION),
  canMatch: can(MATCH),
  draftBlock,
  lockedChange,
  checkinWindow,
  revealAt,
  freeSlot,
  rosterBlock,
  splitBlock,
  refundAmount,
  isNoShow,
  resultsBlock,
  points,
  standings,
  awards,
  splitAward,
  killShares,
  cappedKillReward,
  settlementPreview,
  disputeBlock,
  placementScore,
  tournamentScore,
  decay,
  rankPlayers,
  seasonOf,
  seasonRange,
  maskUid,
  slugify,
  streamBlock,
};
