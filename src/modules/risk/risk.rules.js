'use strict';

/**
 * M18 rules (§6, §8): comparators, severities and the risk level, the flag machine with the clear
 * snooze and re-breach test (FR-05, FR-08), who may take which action and what undoes it (FR-09,
 * FR-10, Q100), and the reliability formula (§6.3, Q102). Pure functions, 100% branch coverage.
 *
 * Reliability (owner, booker): score = round(100 × max(0, 1 − Σ(weight × incidents) ÷ max(sample,
 * min_denominator))), shown once sample ≥ min_sample. The spec's example: 25 bookings and one penalised
 * owner cancel (weight 1.0) → 1 − 1 ÷ 25 = 0.96 → 96%.
 */
const DAY = 24 * 3600 * 1000;
const ms = (t) => new Date(t).getTime();

// ---------------------------------------------------------------------------------------------
// Severities and the risk level

const SEVERITIES = ['info', 'medium', 'high', 'critical'];
const rank = (s) => SEVERITIES.indexOf(s);

/** The account's risk level: the highest severity among its open or actioned flags, or 'none'. */
function riskLevel(flags) {
  let best = -1;
  for (const f of flags) if (['open', 'actioned'].includes(f.status) && rank(f.severity) > best) best = rank(f.severity);
  return best < 0 ? 'none' : SEVERITIES[best];
}

/** A document request that went overdue raises its flag one level (FR-07), capped at critical. */
const raised = (severity) => SEVERITIES[Math.min(rank(severity) + 1, SEVERITIES.length - 1)];

/** Masters are alerted for high and critical flags. */
const alerts = (severity) => rank(severity) >= rank('high');

// ---------------------------------------------------------------------------------------------
// Metrics

/** Does the metric breach the rule's threshold? */
const breached = ({ comparator, value, threshold }) => (comparator === 'gt' ? value > threshold : value >= threshold);

/** A percentage with a minimum sample: null below the sample (FR-01, refund_rate_min_sample). */
function rate({ part, whole, minSample }) {
  if (whole < minSample || whole === 0) return null;
  return Math.round((part / whole) * 10000) / 100;
}

// ---------------------------------------------------------------------------------------------
// The flag machine (§8.1)

/**
 * What an evaluation does for one user and rule, given the latest flag of that pair (or null):
 *   raise    no active flag and the metric breaches → a new open flag
 *   refresh  an open or actioned flag → update its value and last seen (it stays until a person acts)
 *   reopen   a cleared flag whose snooze ended, or one still snoozed whose metric got clearly worse
 *            (by at least half the gap between the value it was cleared at and the threshold, FR-08),
 *            or a lapsed flag that breaches again
 *   none     nothing to do
 */
function flagStep({ flag, comparator, value, threshold, now }) {
  const hit = breached({ comparator, value, threshold });
  if (flag && ['open', 'actioned'].includes(flag.status)) return 'refresh';
  if (!hit) return 'none';
  if (!flag) return 'raise';
  if (flag.status === 'cleared' && flag.snoozeUntil && ms(now) < ms(flag.snoozeUntil)) return worsened({ cleared: flag.clearedValue ?? threshold, value, threshold }) ? 'reopen' : 'none';
  return 'reopen';
}

/** FR-08: the metric moved past the cleared value by at least half the cleared value's distance from the threshold. */
function worsened({ cleared, value, threshold }) {
  if (value <= cleared) return false;
  return value - cleared >= 0.5 * Math.max(0, cleared - threshold);
}

/** Open flags with no action for `days` lapse (they reopen on the next breach). */
const lapseDue = ({ status, lastActivityAt, now, days }) => status === 'open' && ms(now) - ms(lastActivityAt) >= days * DAY;

/** The flag status after an action on it (null: the action does not change it). */
const FLAG_AFTER = { freeze_payouts: 'actioned', request_documents: 'actioned', suspend: 'actioned', ban: 'actioned', clear: 'cleared', reopen: 'open' };
function flagAfter(action, from) {
  const to = FLAG_AFTER[action];
  if (!to) return null;
  if (action === 'reopen') return from === 'cleared' ? 'open' : null;
  return ['open', 'actioned'].includes(from) ? to : null;
}

// ---------------------------------------------------------------------------------------------
// Actions, authority and undo (FR-06 to FR-11, Q100, Q101)

/** The action that undoes each forward action. Undo rows themselves cannot be undone. */
const UNDO = { freeze_payouts: 'unfreeze_payouts', request_documents: 'cancel_document_request', clear: 'reopen', suspend: 'restore', ban: 'restore' };
const FORWARD = Object.keys(UNDO);
const undoOf = (action) => UNDO[action] ?? null;

/** Step-up scope a master confirms for an action (null: none). */
const STEP_UP = { freeze_payouts: 'risk.manage', unfreeze_payouts: 'risk.manage', ban: 'user.ban' };
const stepUpFor = (action) => STEP_UP[action] ?? null;

/**
 * Who may take an action (Q100): staff with manage_users ask for documents, clear and suspend for up
 * to `staffSuspendMaxDays`; masters also freeze and unfreeze payouts and ban. Lifting a ban is a
 * master's (restore of a ban). A person always acts: the system never freezes (Q101).
 */
function actionBlock({ action, actor, days = null, staffSuspendMaxDays, restoringBan = false }) {
  if (!actor.isMaster && !actor.canManageUsers) return 'PERMISSION_REQUIRED';
  if (actor.isMaster) return null;
  if (stepUpFor(action) || (action === 'restore' && restoringBan)) return 'MASTER_REQUIRED';
  if (action === 'suspend' && (days === null || days > staffSuspendMaxDays)) return 'SUSPENSION_TOO_LONG';
  return null;
}

/** Can this action row be undone now? */
function undoBlock({ action, reversed }) {
  if (!FORWARD.includes(action)) return 'ACTION_NOT_REVERSIBLE';
  if (reversed) return 'ACTION_ALREADY_REVERSED';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Reliability (§6.3, Q102)

/** Σ weight × count over the incident kinds. */
const weighted = (counts, weights) => Object.entries(counts).reduce((n, [k, c]) => n + c * (weights[k] ?? 0), 0);

function reliability({ sample, incidents, minSample, minDenominator }) {
  const score = Math.round(100 * Math.max(0, 1 - incidents / Math.max(sample, minDenominator)));
  return { score, shown: sample >= minSample };
}

/** The low-score alert fires once when a shown score falls below the line. */
const lowCrossed = ({ before, after, line }) => after.shown && after.score < line && !(before && before.shown && before.score < line);

module.exports = {
  SEVERITIES,
  riskLevel,
  raised,
  alerts,
  breached,
  rate,
  flagStep,
  worsened,
  lapseDue,
  flagAfter,
  UNDO,
  FORWARD,
  undoOf,
  stepUpFor,
  actionBlock,
  undoBlock,
  weighted,
  reliability,
  lowCrossed,
};
