'use strict';

/**
 * Shared bits of M20: the error catalogue (§9 codes), settings read per call (M03), locks, events,
 * the money of one pass or one subscription period (an M06 payment with one escrow hold), the signed
 * QR token and the views.
 */
const { AppError } = require('../../common/errors');
const crypto = require('../../common/crypto');
const storage = require('../../common/storage');
const { Gym, GymPass, TrainerSubscription, TrainerSubscriptionPeriod } = require('../../models');
const settings = require('../settings').settings;
const events = require('../events').events;
const escrow = require('../payments').escrow;
const refunds = require('../payments').refunds;
const rules = require('./gym.rules');

const ERRORS = {
  NOT_OWNER: [403, 'This gym belongs to another owner'],
  GYM_STATE: [409, 'The gym cannot do that in its current state'],
  GYM_IN_REVIEW: [409, 'Staff are reviewing this gym. Wait for the decision'],
  GYM_INCOMPLETE: [422, 'Finish the listing before sending it for review'],
  NOTHING_TO_REVIEW: [409, 'There are no changes that need review'],
  AREA_UNKNOWN: [422, 'Choose an area from the list'],
  CATALOG_ITEM_UNKNOWN: [422, 'Choose facilities from the list'],
  PHOTO_LIMIT: [409, 'This gym has the most photos allowed'],
  PHOTOS_MISMATCH: [422, 'Send every photo of the gym, in the new order'],
  FILE_EMPTY: [422, 'The file is empty'],
  FILE_TOO_LARGE: [413, 'The photo is too large'],
  FILE_TYPE_NOT_ALLOWED: [415, 'Upload a JPEG, PNG or WebP photo'],
  FILE_TYPE_MISMATCH: [415, 'The file is not the type it says it is'],
  GYM_NOT_AVAILABLE: [409, 'This gym is not selling passes right now'],
  PACKAGE_UNKNOWN: [422, 'Choose one of the gym’s packages'],
  DATE_OUT_OF_RANGE: [422, 'Choose a date in the range offered'],
  GYM_CLOSED_ON_DATE: [422, 'The gym is closed on that date'],
  PASS_CAPACITY_FULL: [409, 'The gym has sold every pass for that date'],
  PASS_NOT_ACTIVE: [409, 'This pass cannot be used'],
  PASS_NOT_REFUNDABLE: [409, 'This pass can no longer be cancelled'],
  PASS_WRONG_GYM: [409, 'This pass is for another gym'],
  PASS_NOT_VALID_TODAY: [409, 'This pass is not valid today'],
  PASS_ALREADY_REDEEMED: [409, 'This pass was already used today'],
  GYM_CLOSED_NOW: [409, 'The gym is closed now'],
  INVALID_PASS_TOKEN: [422, 'This code is not a Kriraghor pass'],
  NOT_A_FITNESS_TRAINER: [403, 'Monthly plans are for live fitness trainer profiles'],
  PLAN_NOT_AVAILABLE: [409, 'This plan is not open for new members'],
  OWN_PLAN: [422, 'You cannot subscribe to your own plan'],
  ALREADY_SUBSCRIBED: [409, 'You already have this plan'],
  SUBSCRIPTION_STATE: [409, 'The subscription cannot do that now'],
  RENEWAL_NOT_OPEN: [409, 'Renewal opens closer to the end of the month'],
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : undefined);

/** Every number from M03 (read per call). */
const config = () => ({
  dayMin: settings.get('gym.day_pass_min_poisha'),
  dayMax: settings.get('gym.day_pass_max_poisha'),
  advanceDays: settings.get('gym.pass_advance_days'),
  monthDays: settings.get('gym.month_days'),
  quarterDays: settings.get('gym.quarter_days'),
  minPhotos: settings.get('gym.min_photos'),
  maxPhotos: settings.get('gym.max_photos'),
  photoMaxBytes: settings.get('ground.photo_max_bytes'),
  subscriptionDays: settings.get('gym.subscription_days'),
  startDays: settings.get('gym.subscription_start_days'),
  cancelDays: settings.get('gym.subscription_cancel_days'),
  noticeDays: settings.get('gym.subscription_renew_notice_days'),
  graceDays: settings.get('gym.subscription_grace_days'),
  planMin: settings.get('gym.trainer_plan_min_poisha'),
  planMax: settings.get('gym.trainer_plan_max_poisha'),
  windowHours: settings.get('disputes.window_trainer_hours'),
  payMinutes: settings.get('payments.intent_ttl_minutes'),
});

const iso = (d) => (d ? new Date(d).toISOString() : null);
const today = (now = new Date()) => rules.dhakaDate(now);

const lockGym = (id, transaction) => Gym.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
const lockPass = (id, transaction) => GymPass.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
const lockSub = (id, transaction) => TrainerSubscription.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
const lockPeriod = (id, transaction) => TrainerSubscriptionPeriod.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });

const publish = (transaction, name, aggregateType, aggregateId, payload, actor = null) => events.publish(transaction, { name, aggregateType, aggregateId, payload, actor });
const passPayload = (p, extra = {}) => ({ passId: p.id, code: p.code, gymId: p.gymId, holderId: p.holderId, ownerId: p.ownerId, kind: p.kind, price: p.pricePoisha, ...extra });
const publishPass = (transaction, name, p, extra, actor = null) => publish(transaction, name, 'gym_pass', p.id, passPayload(p, extra), actor);
const subPayload = (s, extra = {}) => ({ subscriptionId: s.id, code: s.code, memberId: s.memberId, trainerId: s.trainerId, price: s.pricePoisha, ...extra });
const publishSub = (transaction, name, s, extra, actor = null) => publish(transaction, name, 'trainer_subscription', s.id, subPayload(s, extra), actor);

// ---------------------------------------------------------------- money (M06: one hold per payment)

/** What is still in escrow for a pass or a period. */
const heldOf = (row) => row.pricePoisha - row.refundedPoisha - row.releasedPoisha;

/** Refund `amount` of a pass or period to the payer. Returns what was refunded. */
async function refund(row, amount, { reasonCode, key, kind = 'policy', actor = null, transaction }) {
  if (amount <= 0 || !row.paymentId) return 0;
  const r = await refunds.refundPayment({ paymentId: row.paymentId, amount, reasonCode, idempotencyKey: `${key}:refund`, actor, kind }, { transaction });
  if (!r) return 0;
  await row.update({ refundedPoisha: row.refundedPoisha + amount }, { transaction });
  return amount;
}

/** Release what is held to the payee, the fee on `feeBase` (default: what is released). */
async function release(row, { feeBase = null, actor = null, transaction, kind = 'escrow.release_gym' }) {
  const amount = heldOf(row);
  if (amount <= 0 || !row.paymentId) return { gross: 0, fee: 0, net: 0 };
  const hold = await escrow.lockHoldForPayment(row.paymentId, transaction);
  if (!hold) return { gross: 0, fee: 0, net: 0 };
  if (hold.status === 'frozen') await escrow.unfreezeInTx(hold, { reason: 'dispute_closed', actor, transaction });
  const moved = await escrow.releaseInTx(hold, { amount, feeBase: feeBase ?? amount, actor, transaction, kind });
  await row.update({ releasedPoisha: row.releasedPoisha + moved.gross, releasedAt: new Date() }, { transaction });
  return moved;
}

/** The hold of a period (M17 freeze and unfreeze). */
const holdOf = (row, transaction) => (row.paymentId ? escrow.lockHoldForPayment(row.paymentId, transaction) : null);

// ---------------------------------------------------------------- QR token

/** A keyed hash for pass tokens (the OTP secret, domain-separated by the "gym-pass:" prefix). */
const sign = (text) => crypto.hmac(text);
const tokenOf = (pass) => rules.tokenOf({ passId: pass.id, nonce: pass.qrNonce }, sign);
const parseToken = (token) => rules.parseToken(token, sign, (a, b) => a.length === b.length && crypto.timingSafeEqualHex(a, b));

// ---------------------------------------------------------------- views

const photoView = (p) => ({ id: p.id, url: storage.publicUrl(p.key ?? p.storageKey) });
const hoursView = (rows) => rows.map((h) => ({ dow: h.dow, openTime: h.openTime, closeTime: h.closeTime, womenOnly: Boolean(h.womenOnly) })).sort((a, b) => a.dow - b.dow || a.openTime.localeCompare(b.openTime));

/** A pass as its holder sees it (the token and backup code only while it can be used). */
function passView(p, { gym = null, withSecrets = false } = {}) {
  const usable = p.status === 'active';
  return {
    id: p.id,
    code: p.code,
    status: p.status,
    kind: p.kind,
    title: p.title,
    gym,
    validFrom: p.validFrom,
    validTo: p.validTo,
    money: { price: p.pricePoisha, refunded: p.refundedPoisha },
    paidAt: iso(p.paidAt),
    firstRedeemedAt: iso(p.firstRedeemedAt),
    lastRedeemedAt: iso(p.lastRedeemedAt),
    closedAt: iso(p.closedAt),
    closeReason: p.closeReason ?? null,
    token: withSecrets && usable ? tokenOf(p) : null,
    backupCode: withSecrets && usable ? p.backupCode : null,
    can: { cancel: usable && !rules.cancelPlan({ pass: p, today: today() }).block },
  };
}

module.exports = {
  ERRORS,
  fail,
  config,
  iso,
  today,
  lockGym,
  lockPass,
  lockSub,
  lockPeriod,
  publish,
  publishPass,
  publishSub,
  heldOf,
  refund,
  release,
  holdOf,
  sign,
  tokenOf,
  parseToken,
  photoView,
  hoursView,
  passView,
};
