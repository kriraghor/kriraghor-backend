'use strict';

/**
 * M05 moderation rules (§5, §6.5, §8). Pure functions, no I/O, 100% branch coverage.
 */

// §8 submission states. withdrawn and superseded are final; approved and rejected reopen (master).
const TRANSITIONS = {
  pending_review: ['approved', 'changes_requested', 'rejected', 'withdrawn', 'superseded'],
  changes_requested: ['superseded', 'withdrawn'],
  approved: ['pending_review'],
  rejected: ['pending_review'],
  withdrawn: [],
  superseded: [],
};
const OPEN = ['pending_review', 'changes_requested'];
const canTransition = (from, to) => Boolean(TRANSITIONS[from]?.includes(to));

const DECISION_STATUS = { approve: 'approved', request_changes: 'changes_requested', reject: 'rejected' };

// ---------------------------------------------------------------- SLA (FR-18, §6.5)

/** ok | warn (less than warnHours left) | overdue (past due). */
function slaState(dueAt, now, warnHours) {
  const left = dueAt.getTime() - now.getTime();
  if (left < 0) return 'overdue';
  return left < warnHours * 3600000 ? 'warn' : 'ok';
}

const slaDue = (submittedAt, hours) => new Date(submittedAt.getTime() + hours * 3600000);

// ---------------------------------------------------------------- claim lock (FR-07, FR-08)

/** A new claim: TTL from now, never past the hard cap. */
function claimWindow(now, ttlMin, maxMin) {
  const hard = new Date(now.getTime() + maxMin * 60000);
  const expires = new Date(Math.min(now.getTime() + ttlMin * 60000, hard.getTime()));
  return { expiresAt: expires, hardExpiresAt: hard };
}

/** A heartbeat extends the lock by the TTL, capped at the hard expiry. */
const heartbeatExpiry = (claim, now, ttlMin) => new Date(Math.min(now.getTime() + ttlMin * 60000, claim.hardExpiresAt.getTime()));

const claimActive = (claim, now) => Boolean(claim) && !claim.releasedAt && claim.expiresAt > now && claim.hardExpiresAt > now;

// ---------------------------------------------------------------- decisions (FR-06, FR-09 to FR-11)

const missingTicks = (items, ticks) => items.map((i) => i.key).filter((k) => !ticks.includes(k));
const hardFailures = (checks) => checks.filter((c) => c.severity === 'hard' && c.result === 'fail').map((c) => c.key);

/**
 * Why the caller cannot take this decision (null when they can). `override` is a master's reason to
 * approve despite failing hard checks (Q46), except the adapter's `locked` check keys; `reason` is the
 * rejection_reasons row (or null).
 */
function decisionBlock({ submission, claim, now, actorId, isMaster, decision, rubricItems, checks, locked = [], reason, reasonText, override }) {
  if (submission.status !== 'pending_review') return { code: 'INVALID_STATE' };
  if (submission.submittedBy === actorId) return { code: 'SELF_REVIEW_FORBIDDEN' };
  if (!claim || claim.staffId !== actorId) return { code: 'CLAIM_REQUIRED' };
  if (!claimActive(claim, now)) return { code: 'CLAIM_EXPIRED' };
  if (decision === 'approve') {
    const missing = missingTicks(rubricItems, claim.ticks);
    if (missing.length) return { code: 'RUBRIC_INCOMPLETE', missing };
    const failing = hardFailures(checks);
    if (failing.length && !override) return { code: 'CHECK_FAILED', failing };
    if (failing.some((k) => locked.includes(k))) return { code: 'CHECK_LOCKED', failing: failing.filter((k) => locked.includes(k)) };
    if (failing.length && !isMaster) return { code: 'MASTER_REQUIRED' };
    return null;
  }
  if (!reason) return { code: 'REASON_REQUIRED' };
  if (!reason.kinds.includes(submission.kind)) return { code: 'REASON_NOT_ALLOWED_FOR_KIND' };
  if (reason.requiresText && !(reasonText ?? '').trim()) return { code: 'REASON_REQUIRED' };
  return null;
}

/** Ticks a reviewer may store: only keys of the rubric, no duplicates. */
const cleanTicks = (items, ticks) => [...new Set(ticks)].filter((t) => items.some((i) => i.key === t));

module.exports = {
  TRANSITIONS,
  OPEN,
  DECISION_STATUS,
  canTransition,
  slaState,
  slaDue,
  claimWindow,
  heartbeatExpiry,
  claimActive,
  missingTicks,
  hardFailures,
  decisionBlock,
  cleanTicks,
};
