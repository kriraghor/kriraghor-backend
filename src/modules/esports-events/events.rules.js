'use strict';

/**
 * M23 big events: pure rules (100% branch coverage). Stream parsing and embeds are M21's
 * (esports/streams.rules.js), shared with the tournament page.
 */
const LIVE_TOURNAMENT = ['check_in', 'live', 'results_pending'];
const DONE_TOURNAMENT = ['finalised', 'paid_out', 'cancelled'];
const HEX = /^#[0-9a-f]{6}$/;

/** The phase shown to viewers: worked out, never stored (draft and cancelled are stored statuses). */
function phase(event, tournaments, now = new Date()) {
  if (event.status !== 'published') return event.status;
  if (tournaments.some((t) => LIVE_TOURNAMENT.includes(t.status))) return 'live';
  if (now < new Date(event.startsAt)) return 'upcoming';
  if (now >= new Date(event.endsAt)) return 'ended';
  return 'live';
}

/** Event fields: ends after it starts, a lower-case #rrggbb accent. */
function eventBlock({ startsAt, endsAt, accentHex }) {
  if (!(new Date(endsAt) > new Date(startsAt))) return 'EVENT_DATES_INVALID';
  if (accentHex !== undefined && !HEX.test(accentHex)) return 'EVENT_ACCENT_INVALID';
  return null;
}

/**
 * The stage list staff save: qualifiers name a final in the same list, a tournament appears once,
 * at most `max` stages. Returns a code or null.
 */
function stagesBlock(stages, max) {
  if (stages.length > max) return 'EVENT_STAGES_INVALID';
  const ids = stages.map((s) => s.tournamentId);
  if (new Set(ids).size !== ids.length) return 'EVENT_STAGES_INVALID';
  const finals = new Set(stages.filter((s) => s.role === 'final').map((s) => s.tournamentId));
  for (const s of stages) {
    if (s.role === 'qualifier' && (!finals.has(s.finalTournamentId) || !s.qualifyCount)) return 'EVENT_STAGES_INVALID';
    if (s.role === 'final' && (s.finalTournamentId || s.qualifyCount)) return 'EVENT_STAGES_INVALID';
  }
  return null;
}

/**
 * Can these qualifiers feed this final? `qualifiers` are tournament summaries with their qualifyCount.
 * A final that qualifiers feed must be invite-only, the same game, mode and entry unit, have slots for
 * every qualifying entry, not need more entries than can qualify, and close registration late enough
 * after each qualifier starts that its results can be final. A final nothing feeds (a showcase
 * tournament) may stay open.
 */
function linkBlock(final, qualifiers, gapMinutes) {
  if (final.organiserType !== 'kriraghor') return 'EVENT_TOURNAMENT_NOT_OURS';
  if (qualifiers.length && final.entryPolicy !== 'invite') return 'EVENT_FINAL_NOT_INVITE';
  if (DONE_TOURNAMENT.includes(final.status)) return 'EVENT_TOURNAMENT_STATE';
  let total = 0;
  for (const q of qualifiers) {
    if (q.organiserType !== 'kriraghor') return 'EVENT_TOURNAMENT_NOT_OURS';
    if (q.gameId !== final.gameId || q.modeId !== final.modeId || q.entryUnit !== final.entryUnit) return 'EVENT_LINK_MISMATCH';
    if (new Date(final.registrationClosesAt).getTime() < new Date(q.startsAt).getTime() + gapMinutes * 60000) return 'EVENT_QUALIFY_GAP';
    total += q.qualifyCount;
  }
  if (qualifiers.length && final.maxSlots < total) return 'EVENT_FINAL_SLOTS';
  if (qualifiers.length && final.minParticipants > total) return 'EVENT_FINAL_MIN';
  return null;
}

/** The key of an entry in a final: its squad, or the solo player. */
const entryKey = ({ squadId, userId }) => (squadId ? `s:${squadId}` : `u:${userId}`);

/**
 * The top `n` of a qualifier by M21's unique rank, skipping disqualified entries and entries already
 * holding a place in the final (`taken` keys). Entries are { rank, registrationId, squadId,
 * registrantUserId, status, playerUserIds }.
 */
function qualifyCut(standings, n, taken = new Set()) {
  const out = [];
  for (const s of [...standings].sort((a, b) => a.rank - b.rank)) {
    if (out.length >= n) break;
    if (s.status === 'disqualified') continue;
    const key = entryKey({ squadId: s.squadId, userId: s.squadId ? null : s.registrantUserId });
    if (taken.has(key)) continue;
    taken.add(key);
    out.push(s);
  }
  return out;
}

/**
 * A qualified squad must bring enough of the players who qualified (Q147 for pass-downs). Invites
 * carry no players and are not checked; solo entries are the qualified player themselves.
 */
function coreBlock(qualifiedPlayers, playerUserIds, minCore) {
  if (!qualifiedPlayers.length) return null;
  const need = Math.min(minCore, qualifiedPlayers.length);
  const kept = playerUserIds.filter((id) => qualifiedPlayers.includes(id)).length;
  return kept >= need ? null : 'EVENT_CORE_PLAYERS';
}

/** A follow alert of this kind may go out again (cooldown per event and kind). */
const cooldownOver = (lastSentAt, now, minutes) => !lastSentAt || now.getTime() - new Date(lastSentAt).getTime() >= minutes * 60000;

/** The final's reminder is due: within `minutes` of its start and not started. */
const finalReminderDue = (startsAt, now, minutes) => now.getTime() >= new Date(startsAt).getTime() - minutes * 60000 && now < new Date(startsAt);

/** A poll's options: 2 to max, each label present, no duplicates (case-insensitive English). */
function pollOptionsBlock(options, max) {
  if (options.length < 2 || options.length > max) return 'POLL_OPTIONS_INVALID';
  const labels = options.map((o) => o.labelEn.trim().toLowerCase());
  if (new Set(labels).size !== labels.length) return 'POLL_OPTIONS_INVALID';
  return null;
}

/** Can a vote be cast? The poll is open and not past closesAt, and the option is one of its own. */
function voteBlock(poll, optionId, optionIds, now) {
  if (poll.status !== 'open' || (poll.closesAt && now >= new Date(poll.closesAt))) return 'POLL_CLOSED';
  if (!optionIds.includes(optionId)) return 'POLL_OPTION_UNKNOWN';
  return null;
}

/** Totals per option with whole-percent shares (largest remainder, so they add to 100). */
function pollTotals(optionIds, counts) {
  const total = optionIds.reduce((s, id) => s + (counts.get(id) ?? 0), 0);
  if (!total) return { total, items: optionIds.map((id) => ({ optionId: id, votes: 0, pct: 0 })) };
  const raw = optionIds.map((id) => ({ optionId: id, votes: counts.get(id) ?? 0, exact: ((counts.get(id) ?? 0) * 100) / total }));
  const floors = raw.map((r) => ({ ...r, pct: Math.floor(r.exact) }));
  let left = 100 - floors.reduce((s, r) => s + r.pct, 0);
  const order = [...floors].sort((a, b) => b.exact - b.pct - (a.exact - a.pct) || b.votes - a.votes);
  for (const r of order) {
    if (left <= 0) break;
    r.pct += 1;
    left -= 1;
  }
  return { total, items: floors.map(({ optionId, votes, pct }) => ({ optionId, votes, pct })) };
}

/** The prize total shown on the event: the linked tournaments' prize pools (cancelled ones excluded). */
const prizeTotal = (tournaments) => tournaments.filter((t) => t.status !== 'cancelled').reduce((s, t) => s + t.prizePool.amount, 0);

/** Cancelling an event is refused while a linked tournament is running (it never cancels them). */
const cancelBlock = (tournaments) => (tournaments.some((t) => LIVE_TOURNAMENT.includes(t.status)) ? 'EVENT_TOURNAMENT_RUNNING' : null);

/** An https link (sponsors). */
function httpsUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** URL-safe slug from the English title and a short suffix. */
function slugify(title, suffix) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  return base ? `${base}-${suffix}` : suffix;
}

module.exports = {
  LIVE_TOURNAMENT,
  DONE_TOURNAMENT,
  phase,
  eventBlock,
  stagesBlock,
  linkBlock,
  entryKey,
  qualifyCut,
  coreBlock,
  cooldownOver,
  finalReminderDue,
  pollOptionsBlock,
  voteBlock,
  pollTotals,
  prizeTotal,
  cancelBlock,
  httpsUrl,
  slugify,
};
