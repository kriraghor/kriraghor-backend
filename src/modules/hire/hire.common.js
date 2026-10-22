'use strict';

/**
 * Shared bits of M11: the error catalogue (§9 codes), settings read per call (M03), locks, events,
 * the money moves of one job (M06 split escrow: one hold per job, split_ref = the job id) and the
 * serializers. Contact details (phones) show to the other party only once the request is paid.
 */
const { ExclusionConstraintError } = require('sequelize');
const { AppError } = require('../../common/errors');
const { sequelize, HireRequest, HireJob, HireProfile } = require('../../models');
const settings = require('../settings').settings;
const events = require('../events').events;
const escrow = require('../payments').escrow;
const refunds = require('../payments').refunds;
const rules = require('./hire.rules');

const ERRORS = {
  ROLE_REQUIRED: [403, 'Apply as a player or a pro first'],
  MEMBER_NOT_ACTIVE: [403, 'Verify your NID first'],
  ROLE_NOT_FOR_YOU: [422, 'This role is for the other kind of account (players or pros)'],
  PROFILE_EXISTS: [409, 'You already have a profile for this role'],
  PROFILE_STATE: [409, 'The profile cannot do that in its current state'],
  PROFILE_IN_REVIEW: [409, 'The profile is in review'],
  NOTHING_TO_REVIEW: [409, 'There is nothing new to review'],
  RATE_CARD_REQUIRED: [409, 'Set your rates before sending the profile for review'],
  NOT_YOUR_PROFILE: [403, 'This profile belongs to someone else'],
  OWN_PROFILE: [422, 'You cannot hire yourself'],
  PROFILE_NOT_AVAILABLE: [409, 'This person is not taking requests right now'],
  UNIT_NOT_OFFERED: [422, 'This person is not hired that way'],
  AREA_UNKNOWN: [422, 'Choose an area from the list'],
  DUPLICATE_REQUEST: [409, 'You already have an open request to this person at that time'],
  CHECKS_FAILED: [422, 'Cannot accept'],
  SCHEDULE_CLASH: [409, 'This clashes with another job'],
  REPLY_WINDOW_CLOSED: [409, 'The time to reply has passed'],
  REQUEST_STATE: [409, 'The request cannot do that in its current state'],
  JOB_STATE: [409, 'The job cannot do that in its current state'],
  NOT_A_PARTY: [404, 'Not found'],
  TOO_EARLY: [409, 'It is too early for that'],
  JOB_ENDED: [409, 'The job has ended'],
  CONTACT_NOT_ALLOWED: [422, 'Keep contact details out of messages until the request is paid; phone numbers show then'],
  MESSAGES_RATE_LIMITED: [429, 'Too many messages. Try again later'],
  SHORTLIST_LIMIT: [409, 'Your shortlist is full'],
  // Round B1 (FR-05): the pro's calendar.
  PRO_UNAVAILABLE: [409, 'This person is not available at that time'],
  BLOCK_OVER_JOB: [409, 'You have a booked job in that time'],
};
/** The automatic checks' failure texts (§6.5). */
const CHECK_TEXT = {
  credential: 'Your credential does not cover this level',
  police_clearance: 'Under-16 work needs an approved police clearance',
  free: 'Clashes with another job, travel included',
  daily_limit: 'Over your daily limit',
  in_future: 'Starts too soon to accept',
  available: 'You marked this time as not available',
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : undefined);

/** Every number from M03 (read per call). */
const config = () => ({
  replyHours: settings.get('hire.reply_hours'),
  replyBeforeStartMin: settings.get('hire.reply_before_start_min'),
  paymentWindowMin: settings.get('hire.payment_window_min'),
  payBeforeStartMin: settings.get('hire.pay_before_start_min'),
  autoReleaseHours: settings.get('hire.auto_release_hours'),
  disputeWindowHours: settings.get('hire.dispute_window_hours'),
  bufferMin: settings.get('hire.travel_buffer_min'),
  maxJobsCap: settings.get('hire.max_jobs_per_day_cap'),
  checkinOpenMin: settings.get('hire.checkin_open_before_min'),
  lateMin: settings.get('hire.late_before_start_min'),
  startOpenMin: settings.get('hire.toss_open_before_min'),
  noShowAfterMin: settings.get('hire.no_show_after_min'),
  shortNoticeHoursDefault: settings.get('hire.short_notice_hours'),
  nightPctMax: settings.get('hire.night_surcharge_pct_max'),
  shortPctMax: settings.get('hire.short_surcharge_pct_max'),
  cancelFreeHours: settings.get('hire.cancel_free_hours'),
  cancelHighHours: settings.get('hire.cancel_high_hours'),
  cancelPctMid: settings.get('hire.cancel_fee_pct_24_72h'),
  cancelPctHigh: settings.get('hire.cancel_fee_pct_lt24h'),
  matchHours: settings.get('hire.match_hours'),
  unitMultipliers: settings.get('hire.unit_multipliers'),
  experienceMultipliers: settings.get('hire.experience_multipliers'),
  rateBand: settings.get('hire.rate_band'),
  engagementsMax: settings.get('hire.engagements_max'),
  messagesPerHour: settings.get('hire.messages_per_hour'),
  shortlistMax: settings.get('hire.shortlist_max'),
  acceptanceWindowDays: settings.get('hire.acceptance_window_days'),
  bioMinChars: settings.get('hire.profile_bio_min_chars'),
  horizonDays: settings.get('hire.availability_horizon_days'),
});

/** A savepoint around a write the exclusion constraint may refuse (Postgres aborts the whole transaction otherwise). */
async function guarded(transaction, fn) {
  try {
    return await sequelize.transaction({ transaction }, (savepoint) => fn(savepoint));
  } catch (err) {
    if (err instanceof ExclusionConstraintError || err?.parent?.code === '23P01') throw fail('SCHEDULE_CLASH');
    throw err;
  }
}

const lockRequest = (id, transaction) => HireRequest.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
const lockJob = (id, transaction) => HireJob.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
const lockProfile = (id, transaction) => HireProfile.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });

const requestPayload = (r, extra = {}) => ({ requestId: r.id, code: r.code, profileId: r.profileId, hirerId: r.hirerId, proUserId: r.proUserId, total: r.totalPoisha, ...extra });
const jobPayload = (j, extra = {}) => ({ jobId: j.id, code: j.code, requestId: j.requestId, hirerId: j.hirerId, proUserId: j.proUserId, quote: j.quotePoisha, ...extra });
const publishRequest = (transaction, name, r, extra, actor = null) => events.publish(transaction, { name, aggregateType: 'hire_request', aggregateId: r.id, payload: requestPayload(r, extra), actor });
const publishJob = (transaction, name, j, extra, actor = null) => events.publish(transaction, { name, aggregateType: 'hire_job', aggregateId: j.id, payload: jobPayload(j, extra), actor });

// ---------------------------------------------------------------- money of one job (through M06)

const paymentOf = async (j, transaction) => (await HireRequest.findByPk(j.requestId, { attributes: ['paymentId'], transaction })).paymentId;
const heldOf = (j) => j.quotePoisha - j.refundedPoisha - j.releasedPoisha;

/** Refund `amount` of the job's split to the hirer. Returns what was refunded. */
async function refund(j, amount, { reasonCode, key, kind = 'policy', actor = null, transaction }) {
  if (amount <= 0) return 0;
  const paymentId = await paymentOf(j, transaction);
  const row = await refunds.refundPayment({ paymentId, amount, reasonCode, idempotencyKey: `${key}:refund`, actor, kind, splitRef: j.id }, { transaction });
  if (!row) return 0;
  await j.update({ refundedPoisha: j.refundedPoisha + amount }, { transaction });
  return amount;
}

/** Release `amount` of the job's split to the pro's payable, with the fee on `feeBase` (default: the amount). */
async function release(j, amount, { feeBase = null, actor = null, transaction }) {
  if (amount <= 0) return { gross: 0, fee: 0, net: 0 };
  const hold = await escrow.lockHoldForPayment(await paymentOf(j, transaction), transaction, { splitRef: j.id });
  if (!hold) return { gross: 0, fee: 0, net: 0 };
  if (hold.status === 'frozen') await escrow.unfreezeInTx(hold, { reason: 'dispute_closed', actor, transaction });
  const moved = await escrow.releaseInTx(hold, { amount, feeBase: feeBase ?? amount, actor, transaction, kind: 'escrow.release_hire' });
  await j.update({ releasedPoisha: j.releasedPoisha + moved.gross }, { transaction });
  return moved;
}

/** The job's hold (for M17 freeze and unfreeze). */
async function holdOf(j, transaction) {
  const paymentId = await paymentOf(j, transaction);
  return paymentId ? escrow.lockHoldForPayment(paymentId, transaction, { splitRef: j.id }) : null;
}

// ---------------------------------------------------------------- views

const iso = (d) => (d ? new Date(d).toISOString() : null);

const jobView = (j) => ({
  id: j.id,
  code: j.code,
  status: j.status,
  start: iso(j.startAt),
  end: iso(j.endAt),
  hours: j.hours,
  format: j.format ?? null,
  night: j.night,
  u16: j.u16,
  venue: { groundId: j.venueGroundId ?? null, text: j.venueText, areaId: j.venueAreaId, zone: j.zone },
  money: { quote: j.quotePoisha, fee: j.feePoisha, net: j.netPoisha, refunded: j.refundedPoisha, released: j.releasedPoisha, cancelFee: j.cancelFeePoisha },
  checkedInAt: iso(j.checkedInAt),
  late: j.late,
  startedAt: iso(j.startedAt),
  completedAt: iso(j.completedAt),
  workNote: j.workNote ?? null,
  result: j.resultText ?? null,
  releaseAt: iso(j.releaseAt),
  releasedAt: iso(j.releasedAt),
  releasedBy: j.releasedBy ?? null,
  cancelledAt: iso(j.cancelledAt),
  cancelledBy: j.cancelledBy ?? null,
  cancelReason: j.cancelReason ?? null,
  disputeId: j.disputeId ?? null,
});

/** What the viewer (the hirer or the pro) can do with a job now; the apps show only these buttons. */
function jobCan(j, viewer, now = new Date()) {
  const cfg = config();
  if (viewer === 'hirer') {
    return {
      confirm: j.status === 'completed_marked',
      cancel: Boolean(rules.nextJob('cancel', j.status, 'hirer')),
      noShow: rules.ACTIVE_JOB.includes(j.status) && !rules.noShowBlock({ now, start: j.startAt, end: j.endAt, checkedIn: Boolean(j.checkedInAt), afterMin: cfg.noShowAfterMin, windowHours: cfg.disputeWindowHours }),
      problem: !rules.problemBlock({ status: j.status }),
    };
  }
  return {
    checkIn: j.status === 'scheduled' && !rules.checkIn({ now, start: j.startAt, end: j.endAt, openMin: cfg.checkinOpenMin, lateMin: cfg.lateMin }).block,
    start: j.status === 'checked_in' && !rules.startBlock({ now, start: j.startAt, openMin: cfg.startOpenMin }),
    complete: ['checked_in', 'live'].includes(j.status),
    withdraw: j.status === 'scheduled',
  };
}

/**
 * A request as one of its parties sees it. `other` is the other party ({ name, phone }); the phone
 * shows only once the request is paid (v3: masked until payment).
 */
function requestView(r, jobs, { profile, other, viewer }) {
  const paid = ['confirmed', 'completed', 'cancelled'].includes(r.status) && Boolean(r.confirmedAt);
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    role: viewer === r.hirerId ? 'hirer' : 'pro',
    unit: r.unit,
    note: r.note ?? null,
    profile,
    other: { name: other?.name ?? null, phone: paid ? other?.phone ?? null : null },
    money: { total: r.totalPoisha, fee: viewer === r.hirerId ? null : r.feePoisha, net: viewer === r.hirerId ? null : r.netPoisha },
    quote: r.quoteSnapshot,
    replyBy: iso(r.replyBy),
    payBy: iso(r.payBy),
    paymentId: viewer === r.hirerId ? r.paymentId ?? null : null,
    declineReason: r.declineReasonCode ?? null,
    createdAt: iso(r.createdAt),
    confirmedAt: iso(r.confirmedAt),
    jobs: jobs.map((j) => ({ ...jobView(j), can: jobCan(j, viewer === r.hirerId ? 'hirer' : 'pro') })),
  };
}

module.exports = { ERRORS, CHECK_TEXT, fail, config, guarded, lockRequest, lockJob, lockProfile, publishRequest, publishJob, heldOf, refund, release, holdOf, iso, jobView, jobCan, requestView };
