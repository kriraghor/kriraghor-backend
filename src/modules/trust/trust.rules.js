'use strict';

/**
 * M17 rules: the dispute state machine (§8.1), windows and SLAs (Q95), the outcome maths, who may
 * decide (§6.3), reporter eligibility and auto-hide (Q99), review eligibility and content checks
 * (Q98). Pure functions, 100% branch coverage. Times are Date or epoch ms; money is integer poisha.
 *
 * Outcome maths on what the case holds (a no-show's retained advance, or a started booking's online
 * money): all → everything back; half → floor(held / 2) back; none → nothing back; custom → any
 * amount up to what is held. What is not refunded is released to the owner with the fee on what the
 * owner keeps (Q26). The ৳500 retained example: all → ৳500 back; half → ৳250 back, owner ৳237.50,
 * fee ৳12.50; none → owner ৳475, fee ৳25. When nothing is refunded on a booking that was not a
 * no-show, the normal check-in rule applies instead: the fee on the full booking value (`fullPrice`).
 */
const { feeOf } = require('../../common/money');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ms = (t) => new Date(t).getTime();

// ---------------------------------------------------------------------------------------------
// State machine (§8.1)

const ACTIVE = ['awaiting_response', 'under_review', 'escalated'];
const TRANSITIONS = {
  respond: { from: ['awaiting_response'], to: 'under_review' },
  respondent_timeout: { from: ['awaiting_response'], to: 'under_review' },
  escalate: { from: ['under_review'], to: 'escalated' },
  send_back: { from: ['escalated'], to: 'under_review' },
  decide: { from: ['under_review'], to: 'resolved' },
  master_decide: { from: ['under_review', 'escalated'], to: 'resolved' },
  withdraw: { from: ACTIVE, to: 'withdrawn' },
};

/** The status after `action`, or null when the action is not allowed from `from`. */
const next = (action, from) => (TRANSITIONS[action].from.includes(from) ? TRANSITIONS[action].to : null);
const isActive = (status) => ACTIVE.includes(status);

/** A case against a person waits for their side; a case against the platform goes straight to staff. */
const initialStatus = ({ hasRespondent }) => (hasRespondent ? 'awaiting_response' : 'under_review');

/** FR-02: at most `max` open cases per claimant. */
const openBlock = ({ openCount, max }) => (openCount >= max ? 'DISPUTE_LIMIT' : null);

// ---------------------------------------------------------------------------------------------
// Windows and SLAs (Q95: 48 h to open, respondent 48 h, staff 72 h, master 48 h)

const after = (now, hours) => new Date(ms(now) + hours * HOUR);

/** The respondent's reminder is due `hours` before their deadline, once. */
const reminderDue = ({ status, respondentDueAt, remindedAt, now, hours }) =>
  status === 'awaiting_response' && !remindedAt && Boolean(respondentDueAt) && ms(now) >= ms(respondentDueAt) - hours * HOUR && ms(now) < ms(respondentDueAt);

const respondentTimedOut = ({ status, respondentDueAt, now }) => status === 'awaiting_response' && Boolean(respondentDueAt) && ms(now) >= ms(respondentDueAt);

/** Which SLA a case has just breached ('staff' or 'master'), or null. Each case breaches once per level. */
function slaBreach({ status, slaDueAt, masterDueAt, breachedAt, now }) {
  if (status === 'under_review' && slaDueAt && ms(now) >= ms(slaDueAt) && !(breachedAt && ms(breachedAt) >= ms(slaDueAt))) return 'staff';
  if (status === 'escalated' && masterDueAt && ms(now) >= ms(masterDueAt) && !(breachedAt && ms(breachedAt) >= ms(masterDueAt))) return 'master';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Staff claims (one reviewer at a time, like M05: TTL plus heartbeat)

const claimHeld = ({ claimedBy, claimExpiresAt, now }) => Boolean(claimedBy) && Boolean(claimExpiresAt) && ms(claimExpiresAt) > ms(now);

/** Can `actorId` take or keep the claim? */
const claimBlock = ({ claimedBy, claimExpiresAt, actorId, now }) => (claimHeld({ claimedBy, claimExpiresAt, now }) && claimedBy !== actorId ? 'CLAIMED_BY_OTHER' : null);

const claimExpiry = (now, ttlMin) => new Date(ms(now) + ttlMin * 60 * 1000);

// ---------------------------------------------------------------------------------------------
// Outcomes and money

/** The outcomes a case can end with. Cash and played-booking cases are findings only (Q96). */
function allowedOutcomes({ sourceType, money }) {
  if (sourceType === 'esports_result') return ['corrected', 'rejected'];
  return money ? ['all', 'half', 'none', 'custom'] : ['upheld', 'rejected'];
}

/** The refund an outcome gives back from what is held. Throws RangeError on a bad custom amount. */
function outcomeRefund({ outcome, held, custom = null }) {
  if (outcome === 'all') return held;
  if (outcome === 'half') return Math.floor(held / 2);
  if (outcome === 'custom') {
    if (!Number.isSafeInteger(custom) || custom < 0 || custom > held) throw new RangeError('A custom refund must be between 0 and what is held');
    return custom;
  }
  return 0;
}

/**
 * The money an outcome moves: the refund, then the rest released with its fee. `fullPrice` is the
 * booking value when the case holds a started booking's online money (fee on the full value when
 * nothing is refunded); null for a no-show's retained advance.
 */
function outcomePlan({ outcome, held, custom = null, feeBps, fullPrice = null }) {
  const refund = outcomeRefund({ outcome, held, custom });
  const release = held - refund;
  if (release === 0) return { refund, release: 0, feeBase: 0, fee: 0, net: 0 };
  const feeBase = refund === 0 && fullPrice !== null ? fullPrice : release;
  const fee = feeOf(feeBase, feeBps);
  if (fee > release) throw new RangeError('The fee would exceed the amount released');
  return { refund, release, feeBase, fee, net: release - fee };
}

/**
 * Who may decide (§6.3). Parties never decide (CONFLICT_OF_INTEREST). Staff decide claimed cases
 * under review; a refund needs refund_small and must be within refunds.staff_limit_poisha, or the
 * case is escalated to a master. Masters decide cases under review or escalated (with step-up).
 */
function decideBlock({ actor, dispute, refund, staffLimit, now, asMaster }) {
  if (actor.id === dispute.claimantId || actor.id === dispute.respondentId) return 'CONFLICT_OF_INTEREST';
  if (asMaster) {
    if (!actor.isMaster) return 'MASTER_REQUIRED';
    return next('master_decide', dispute.status) ? null : 'DISPUTE_STATE';
  }
  if (!next('decide', dispute.status)) return 'DISPUTE_STATE';
  if (!claimHeld({ ...dispute, now }) || dispute.claimedBy !== actor.id) return 'CLAIM_REQUIRED';
  if (refund > 0 && !actor.canRefund) return 'REFUND_PERMISSION_REQUIRED';
  if (refund > staffLimit) return 'ESCALATION_REQUIRED';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Reports (Q99)

/** Only NID-verified reporters whose account is old enough count toward auto-hide. */
const eligibleReporter = ({ memberActive, accountCreatedAt, now, minDays }) => Boolean(memberActive) && ms(now) - ms(accountCreatedAt) >= minDays * DAY;

/** The report that takes the eligible count to the threshold fires the alert (once per crossing). */
const thresholdCrossed = ({ before, after: count, threshold }) => before < threshold && count >= threshold;

/** Which resolution actions apply to which subjects. */
const RESOLUTIONS = {
  ground: ['no_violation', 'content_removed', 'owner_warned', 'user_suspended'],
  booking: ['no_violation', 'owner_warned', 'converted_to_dispute'],
  user: ['no_violation', 'user_suspended'],
  review: ['no_violation', 'content_removed', 'user_suspended'],
  esports_tournament: ['no_violation', 'owner_warned'],
};
const resolutionAllowed = (subjectType, action) => RESOLUTIONS[subjectType].includes(action);

// ---------------------------------------------------------------------------------------------
// Reviews (Q98: one-sided, members rate grounds after play)

const PLAYED = ['checked_in', 'completed'];

/** Can the member review this booking now? */
function reviewBlock({ isBooker, status, endAt, now, windowDays }) {
  if (!isBooker) return 'NOT_YOUR_BOOKING';
  if (!PLAYED.includes(status) || ms(now) < ms(endAt)) return 'NOT_PLAYED';
  if (ms(now) > ms(endAt) + windowDays * DAY) return 'REVIEW_WINDOW_CLOSED';
  return null;
}

function editBlock({ status, editUntil, now }) {
  if (status === 'hidden') return 'REVIEW_HIDDEN';
  if (ms(now) > ms(editUntil)) return 'REVIEW_EDIT_CLOSED';
  return null;
}

// Links and phone numbers take the conversation off the platform: such a review waits for staff.
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|bd|io|me|xyz)\b)/i;
const PHONE = /(\+?880|\b0)1[3-9]\d{8}\b|\b\d{3}[\s-]?\d{3}[\s-]?\d{4,5}\b/;
const contentFlag = (text) => (text && (LINK.test(text) || PHONE.test(text.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d))))) ? 'content' : null);

/** A new review: held while its booking has an active dispute, or when its text needs a look. */
function initialReview({ disputeActive, text }) {
  if (disputeActive) return { status: 'held', heldReason: 'dispute' };
  if (contentFlag(text)) return { status: 'held', heldReason: 'content' };
  return { status: 'published', heldReason: null };
}

/** count, sum and the 1–5 histogram → the aggregate; the average shows only from `min` reviews. */
function aggregate(hist, min) {
  const count = hist.reduce((n, v) => n + v, 0);
  const sum = hist.reduce((n, v, i) => n + v * (i + 1), 0);
  const avg = count ? Math.round((sum / count) * 100) / 100 : null;
  return { count, sum, avg, display: count >= min ? avg : null };
}

module.exports = {
  ACTIVE,
  TRANSITIONS,
  next,
  isActive,
  initialStatus,
  openBlock,
  after,
  reminderDue,
  respondentTimedOut,
  slaBreach,
  claimHeld,
  claimBlock,
  claimExpiry,
  allowedOutcomes,
  outcomeRefund,
  outcomePlan,
  decideBlock,
  eligibleReporter,
  thresholdCrossed,
  RESOLUTIONS,
  resolutionAllowed,
  PLAYED,
  reviewBlock,
  editBlock,
  contentFlag,
  initialReview,
  aggregate,
};
