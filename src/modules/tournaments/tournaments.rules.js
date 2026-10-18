'use strict';

/**
 * M14 tournament rules (pure; 100% coverage gate): state machines (§8), places and the reserve
 * list (M14-FR-10/13), the refund table (§6.9, Q87 as written), escrow tranches (§6.8), date,
 * capacity and prize checks (§4.2, §6.1).
 */

// ---------------------------------------------------------------- state machines (§8)
const TOURNAMENT = {
  draft: ['pending_review', 'cancelled'],
  pending_review: ['changes_requested', 'rejected', 'registration_open', 'draft'],
  changes_requested: ['pending_review', 'cancelled'],
  rejected: [],
  registration_open: ['registration_closed', 'cancelled'],
  registration_closed: ['registration_open', 'live', 'cancelled'],
  live: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

const REGISTRATION = {
  pending_payment: ['pending_approval', 'lapsed', 'withdrawn', 'cancelled'],
  reserve: ['offered', 'withdrawn', 'lapsed', 'cancelled'],
  offered: ['pending_payment', 'pending_approval', 'lapsed', 'withdrawn', 'cancelled'],
  pending_approval: ['approved', 'rejected', 'withdrawn', 'cancelled'],
  approved: ['withdrawn', 'removed', 'cancelled'],
  rejected: [],
  lapsed: [],
  withdrawn: [],
  removed: [],
  cancelled: [],
};

const MATCH = {
  draft: ['scheduled', 'cancelled'],
  scheduled: ['postponed', 'completed', 'no_result', 'walkover', 'abandoned', 'cancelled'],
  postponed: ['scheduled', 'walkover', 'cancelled'],
  abandoned: ['scheduled', 'no_result'],
  completed: [],
  no_result: [],
  walkover: [],
  cancelled: [],
};

const can = (machine, from, to) => Boolean(machine[from]?.includes(to));

/** States that hold a place (an offer holds one while it is open). */
const HOLDING = ['pending_payment', 'offered', 'pending_approval', 'approved'];
/** States that are still in the tournament in some way (one live registration per team). */
const LIVE = [...HOLDING, 'reserve'];
const TERMINAL_MATCH = ['completed', 'no_result', 'walkover', 'cancelled'];
/** Statuses where the public can see the tournament (drafts and reviews never are; M14-FR-23). */
const PUBLIC = ['registration_open', 'registration_closed', 'live', 'completed', 'cancelled'];

/** A new registration takes a place when one is free, else joins the reserve list. */
const placeFree = (holding, maxTeams) => holding < maxTeams;

/** Where registration stands now: before it opens, open, or closed. */
function registrationWindow(t, now) {
  if (t.status !== 'registration_open') return 'closed';
  if (now < new Date(t.registrationOpensAt)) return 'not_yet';
  if (now >= new Date(t.registrationClosesAt)) return 'closed';
  return 'open';
}

// ---------------------------------------------------------------- money (§6.8, §6.9)
/**
 * The refund for a registration that paid `paid` with `available` still in escrow:
 *   rejected, withdrawn before close, removed or cancelled before the first result → 100%
 *   withdrawn after close, before the first result → `afterClosePct` (50%)
 *   withdrawn or removed after the first result → nothing (the team's matches become walkovers)
 *   tournament cancelled after the first result → what is still held (unreleased escrow)
 */
function refundAmount({ reason, paid, available, closed, firstResult, afterClosePct }) {
  if (!paid) return 0;
  if (reason === 'cancelled') return firstResult ? available : paid;
  if (reason === 'rejected') return paid;
  if (firstResult) return 0;
  if (reason === 'withdrawn' && closed) return Math.floor((paid * afterClosePct) / 100);
  return paid;
}

/**
 * Tranche 1 releases `pct` of what each hold took in (less anything released already); the final
 * release takes what is left. Never more than what the hold still has.
 */
function trancheAmount({ held, released, refunded }, pct) {
  const available = held - released - refunded;
  const target = pct >= 100 ? held : Math.floor((held * pct) / 100);
  return Math.max(0, Math.min(available, target - released));
}

// ---------------------------------------------------------------- dates, capacity, prizes
const dayMs = 86400000;
const dhakaDay = (d) => Date.parse(`${d}T00:00:00+06:00`);

/**
 * Date checks: opens < closes ≤ first match day − closeDays (Dhaka midnight); start ≤ end; the first
 * match day at least `minStartDays` after today. Returns an error code or null.
 */
function datesBlock({ registrationOpensAt, registrationClosesAt, startDate, endDate }, { closeDays, minStartDays, today }) {
  if (!registrationOpensAt || !registrationClosesAt || !startDate || !endDate) return 'DATES_MISSING';
  if (!(new Date(registrationOpensAt) < new Date(registrationClosesAt))) return 'REGISTRATION_WINDOW_INVALID';
  if (new Date(registrationClosesAt).getTime() > dhakaDay(startDate) - closeDays * dayMs) return 'REGISTRATION_CLOSES_TOO_LATE';
  if (endDate < startDate) return 'END_BEFORE_START';
  if (dhakaDay(startDate) < dhakaDay(today) + minStartDays * dayMs) return 'START_TOO_SOON';
  return null;
}

/** Squad limits: min ≥ the rule's players (or 1), max ≤ 30, min ≤ max. */
function squadBlock({ squadMin, squadMax }, players) {
  if (!(squadMin >= Math.max(1, players ?? 1) && squadMin <= squadMax && squadMax <= 30)) return 'SQUAD_LIMITS_INVALID';
  return null;
}

/** A prize split sums to 100% when there is a pool; with no pool there is nothing to check. */
function prizeBlock({ prizePoolPoisha, prizeSplit }) {
  const rows = prizeSplit ?? [];
  if (!prizePoolPoisha) return rows.length ? 'PRIZE_SPLIT_WITHOUT_POOL' : null;
  if (!rows.length) return null;
  if (rows.some((r) => !(r.pct > 0)) || rows.reduce((s, r) => s + r.pct, 0) !== 100) return 'PRIZE_SPLIT_INVALID';
  return null;
}

/** The squad a captain picks, against the tournament's limits (M16-FR-06). */
function rosterBlock(count, { squadMin, squadMax }) {
  if (count < squadMin) return 'SQUAD_TOO_SMALL';
  if (count > squadMax) return 'SQUAD_TOO_LARGE';
  return null;
}

/**
 * The automatic checks staff see on the Moderation desk (§6.1). Inputs are facts the service
 * gathered; each check is {key, severity, result}.
 */
function submissionChecks(f) {
  const check = (key, severity, ok) => ({ key, severity, result: ok ? 'pass' : 'fail' });
  return [
    check('org_verified', 'hard', f.orgVerified),
    check('payout_account', 'hard', f.feePoisha === 0 || f.payoutReady),
    check('rules_valid', 'hard', !f.rulesError),
    check('dates_consistent', 'hard', !f.datesError),
    check('capacity_valid', 'hard', !f.formatError && !f.squadError),
    check('prize_split_valid', 'hard', !f.prizeError),
    check('venue_present', 'hard', f.venues > 0),
    check('fee_in_range', 'soft', f.feePoisha <= f.feeMax),
  ];
}

module.exports = {
  TOURNAMENT,
  REGISTRATION,
  MATCH,
  can,
  HOLDING,
  LIVE,
  TERMINAL_MATCH,
  PUBLIC,
  placeFree,
  registrationWindow,
  refundAmount,
  trancheAmount,
  datesBlock,
  squadBlock,
  prizeBlock,
  rosterBlock,
  submissionChecks,
};
