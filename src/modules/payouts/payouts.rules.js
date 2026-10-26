'use strict';

/**
 * M07 payout rules (§6, §8). Pure functions, no I/O, 100% branch coverage (CLAUDE.md: money code).
 * Amounts are integer poisha; times are Date objects; business days are Asia/Dhaka (UTC+6, no DST).
 */
const { assertPoisha, sum } = require('../../common/money');

const DHAKA_OFFSET_MS = 6 * 3600 * 1000;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// §8 state machine. cancelled and paid are final.
const TRANSITIONS = {
  scheduled: ['needs_approval', 'on_hold', 'processing', 'cancelled'],
  needs_approval: ['on_hold', 'processing', 'cancelled'],
  on_hold: ['scheduled', 'needs_approval', 'cancelled'],
  processing: ['paid', 'failed'],
  failed: ['processing', 'cancelled'],
  paid: [],
  cancelled: [],
};
const OPEN = ['scheduled', 'needs_approval', 'on_hold'];

const canTransition = (from, to) => Boolean(TRANSITIONS[from]?.includes(to));

// ---------------------------------------------------------------- payout accounts (§4.1)

/** A Bangladeshi mobile wallet number as 01XXXXXXXXX (accepts +880 / 880 prefixes and spaces or dashes). */
function normaliseWallet(input) {
  const digits = String(input ?? '').replace(/[\s-]/g, '');
  const local = digits.replace(/^\+?880/, '0');
  return /^01[3-9]\d{8}$/.test(local) ? local : null;
}

const WALLET_LABELS = { bkash: 'bKash', nagad: 'Nagad' };

/** "bKash ••• 4321": the only form an account number takes outside the reveal. */
const maskAccount = (type, last4) => `${WALLET_LABELS[type] ?? type} ••• ${last4}`;

// ---------------------------------------------------------------- items and amounts (§6.2, FR-03, FR-04)

/**
 * One payable ledger entry as a payout item. A credit (an escrow release or a prize) adds its net and
 * carries the fee M06 took at release; a debit on the payable (a reversal or forfeit) takes money away.
 * M07 never recalculates a percentage: the fee comes from the release posting. M24-FR-46: the
 * provider's charge passed through at cost in the same release (providerCharge) is shown apart:
 * gross = net + fee + providerCharge.
 */
function itemValues({ credit = 0, debit = 0, fee = 0, providerCharge = 0 }) {
  assertPoisha(credit, 'credit');
  assertPoisha(debit, 'debit');
  assertPoisha(fee, 'fee');
  assertPoisha(providerCharge, 'provider charge');
  if ((credit > 0) === (debit > 0)) throw new TypeError('A payable entry has exactly one positive side');
  if (credit > 0) return { gross: credit + fee + providerCharge, fee, providerCharge, net: credit };
  return { gross: 0, fee: 0, providerCharge: 0, net: -debit };
}

/**
 * payout.gross = Σ items.gross; deductions = Σ (items.fee + items.providerCharge);
 * netting = min(fee receivable owed, Σ items.net) (never below 0); amount = Σ net − netting + adjustments.
 */
function totals(items, { feeReceivable = 0, adjustments = 0 } = {}) {
  const net = items.reduce((s, i) => s + i.net, 0);
  const gross = sum(items.map((i) => assertPoisha(i.gross, 'item gross')));
  const deductions = sum(items.map((i) => assertPoisha(i.fee, 'item fee') + assertPoisha(i.providerCharge ?? 0, 'item provider charge')));
  const netting = Math.max(0, Math.min(feeReceivable, net));
  return { gross, deductions, net, netting, adjustments, amount: net - netting + adjustments };
}

/** FR-04: no payout when the amount is not positive or below the minimum; the items wait. */
const belowMinimum = (amount, minAmount) => amount <= 0 || amount < minAmount;

// ---------------------------------------------------------------- holds (§6.4, FR-06)

const isActive = (hold, now) => !hold.liftedAt && (!hold.until || hold.until > now);

/** Holds that block the whole payout: payee-level, or placed on this payout. */
const blockingHolds = (holds, now, payoutId = null) =>
  holds.filter((h) => isActive(h, now) && (h.scope === 'payee' || (h.scope === 'payout' && payoutId && h.payoutId === payoutId)));

/** FR-14: an item-source hold (a dispute) keeps only the matching items out of the run. */
const itemHeld = (item, holds, now) => holds.some((h) => isActive(h, now) && h.scope === 'item_source' && h.sourceType === item.sourceType && h.sourceId === item.sourceId);

// ---------------------------------------------------------------- approval (§6.3, FR-07)

/**
 * Status for a payout that is not (or no longer) on hold:
 *   amount > threshold          → needs_approval (two distinct masters)
 *   amount ≤ autoReleaseMax > 0 → scheduled, released automatically (Q53: 0 = off)
 *   otherwise                   → scheduled, released by release_payouts staff or a master
 */
function statusFor({ amount, threshold, autoReleaseMax, blocked }) {
  if (blocked) return { status: 'on_hold', autoRelease: false };
  if (amount > threshold) return { status: 'needs_approval', autoRelease: false };
  return { status: 'scheduled', autoRelease: autoReleaseMax > 0 && amount <= autoReleaseMax };
}

/**
 * Why a payout cannot go to processing now (null when it can). Shared by release, approval step 2,
 * retry and auto-release (§8 guards).
 */
function disburseBlock({ payout, account, holds, now }) {
  if (!account) return 'PAYOUT_ACCOUNT_REQUIRED';
  if (account.status !== 'active') return 'PAYOUT_ACCOUNT_UNVERIFIED';
  if (blockingHolds(holds, now, payout.id).length) return 'PAYOUT_ON_HOLD';
  return null;
}

/**
 * A release (≤ threshold) by staff with release_payouts or a master. The payee never releases their
 * own payout (§3), and anything above the threshold needs the two-master approval instead.
 */
function releaseBlock({ payout, actorId }) {
  if (payout.status !== 'scheduled') return 'INVALID_STATE';
  if (payout.payeeId === actorId) return 'SELF_PAYOUT_FORBIDDEN';
  if (payout.amount > payout.rules.threshold) return 'FOUR_EYES_REQUIRED';
  return null;
}

/**
 * An approval step for a payout above the threshold: masters only, never the payee, two different
 * people, and neither may be the person who placed or lifted its latest manual hold (§3, edge case 4).
 * Returns { error } or { step }.
 */
function approvalStep({ payout, actorId, isMaster, approvals, holdActorIds = [] }) {
  if (!isMaster) return { error: 'MASTER_REQUIRED' };
  if (payout.status !== 'needs_approval') return { error: 'INVALID_STATE' };
  if (payout.payeeId === actorId) return { error: 'SELF_PAYOUT_FORBIDDEN' };
  if (approvals.some((a) => a.approverId === actorId)) return { error: 'SAME_APPROVER' };
  if (holdActorIds.includes(actorId)) return { error: 'HOLD_ACTOR_CANNOT_APPROVE' };
  if (approvals.length >= 2) return { error: 'INVALID_STATE' };
  return { step: approvals.length + 1 };
}

// Manual failure reasons. Permanent ones need the payee to fix their account before a retry (FR-10).
const FAILURE_REASONS = {
  invalid_wallet: { retryable: false },
  name_mismatch: { retryable: false },
  account_closed: { retryable: false },
  provider_error: { retryable: true },
  other: { retryable: true },
};

/** failed → processing: the failure was transient, or the payee has a different active account now. */
function retryBlock({ payout, account }) {
  if (payout.status !== 'failed') return 'INVALID_STATE';
  const retryable = FAILURE_REASONS[payout.failureCode]?.retryable ?? false;
  if (!retryable && (!account || account.id === payout.accountId)) return 'PAYOUT_ACCOUNT_UPDATE_REQUIRED';
  return null;
}

// ---------------------------------------------------------------- schedules (§6.1, FR-05)

/** Dhaka wall-clock parts of an instant. */
function dhakaParts(at) {
  const d = new Date(at.getTime() + DHAKA_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate(), hour: d.getUTCHours(), weekday: WEEKDAYS[d.getUTCDay()] };
}

/** The instant of hour:00 Dhaka on the Dhaka day of `at`. */
function dhakaAt(at, hour) {
  const p = dhakaParts(at);
  return new Date(Date.UTC(p.y, p.m, p.day, hour) - DHAKA_OFFSET_MS);
}

/**
 * Schedules due at `now` (the job runs hourly; each window is built once, UNIQUE(schedule, window_end)):
 *   daily          every day, from run_hour
 *   ground_weekly  on payouts.ground_weekday, from run_hour
 *   shop_weekly    on payouts.shop_weekday, from run_hour
 * The window ends at run_hour today; items posted up to then are in it.
 */
function dueSchedules(now, { runHour, dailyEnabled, groundWeekday, shopWeekday }) {
  const p = dhakaParts(now);
  if (p.hour < runHour) return [];
  const windowEnd = dhakaAt(now, runHour);
  const due = [];
  if (dailyEnabled) due.push({ schedule: 'daily', windowEnd });
  if (p.weekday === groundWeekday) due.push({ schedule: 'ground_weekly', windowEnd });
  if (p.weekday === shopWeekday) due.push({ schedule: 'shop_weekly', windowEnd });
  return due;
}

/** The next run of a schedule after `now` (for the payee's "next payout" projection, FR-16). */
function nextRun(schedule, now, { runHour, groundWeekday, shopWeekday }) {
  const weekday = { ground_weekly: groundWeekday, shop_weekly: shopWeekday }[schedule];
  for (let d = 0; d < 8; d += 1) {
    const day = new Date(now.getTime() + d * 86400000);
    const at = dhakaAt(day, runHour);
    if (at <= now) continue;
    if (!weekday || dhakaParts(day).weekday === weekday) return at;
  }
  throw new RangeError(`No run found for ${schedule}`);
}

// ---------------------------------------------------------------- statements (§4.2)

/** A CSV cell and file, from the shared helper (formula guard; plain numbers such as -20.00 stay numbers). */
const { cell: csvCell, csv } = require('../../common/csv');

module.exports = {
  TRANSITIONS,
  OPEN,
  WEEKDAYS,
  FAILURE_REASONS,
  canTransition,
  normaliseWallet,
  maskAccount,
  itemValues,
  totals,
  belowMinimum,
  isActive,
  blockingHolds,
  itemHeld,
  statusFor,
  disburseBlock,
  releaseBlock,
  approvalStep,
  retryBlock,
  dhakaParts,
  dhakaAt,
  dueSchedules,
  nextRun,
  csvCell,
  csv,
};
