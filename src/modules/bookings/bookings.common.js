'use strict';

/**
 * Shared bits of M10: the error catalogue (§9 codes), settings read per call (M03, no magic numbers),
 * the occupancy writes (booking_slots, the only writer) and the serializers. Phone numbers are
 * encrypted at rest and only the last four digits are shown (M10 §7.1).
 */
const { Op, ExclusionConstraintError } = require('sequelize');
const { AppError } = require('../../common/errors');
const { encrypt, decrypt } = require('../../common/crypto');
const { getRedis } = require('../../common/redis');
const realtime = require('../../common/realtime');
const logger = require('../../common/logger');
const config = require('../../config');
const { sequelize, Booking, BookingSlot } = require('../../models');
const settings = require('../settings/settings.service');
const events = require('../events/events.service');
const rules = require('./bookings.rules');

const ERRORS = {
  NOT_OWNER: [403, 'This booking is at another owner’s ground'],
  BOOKING_STATE: [409, 'The booking cannot do that in its current state'],
  GROUND_NOT_BOOKABLE: [409, 'This ground is not taking bookings right now'],
  OWN_GROUND: [422, 'You cannot book your own ground'],
  COURT_UNKNOWN: [422, 'Choose courts of this ground'],
  NOT_HALF_HOUR: [422, 'Bookings start on the hour or half-hour'],
  TOO_LATE: [422, 'It is too late to book this time'],
  OUT_OF_RANGE: [422, 'This time is outside the booking window'],
  HOLD_LIMIT: [429, 'You already have the most slots on hold. Pay or release one first'],
  HOLD_RATE_LIMITED: [429, 'Too many attempts. Try again in a few minutes'],
  SLOT_UNAVAILABLE: [409, 'Someone else just took this slot'],
  PAYMENT_CHOICE_UNAVAILABLE: [422, 'Paying in full online is not available'],
  PRICING_MISSING: [409, 'This ground has no published prices yet'],
  NOT_CHECKIN_WINDOW: [409, 'Check-in opens 30 minutes before the start and closes at the end'],
  NOT_LATE_YET: [409, 'The player is not late yet'],
  NO_SHOW_WINDOW_CLOSED: [409, 'It is too late to mark a no-show'],
  ALREADY_STARTED: [409, 'This booking has already started'],
  BOOKING_ENDED: [409, 'This booking has ended'],
  NEXT_SLOT_TAKEN: [409, 'The next half-hour is already taken'],
  OUTSIDE_HOURS: [422, 'The ground is closed for part of that time'],
  NO_BALANCE_DUE: [409, 'Nothing is due at the venue'],
  BALANCE_MISMATCH: [422, 'Record the full amount due'],
  REFUND_CHANGED: [409, 'The refund changed. Check the new amount and try again'],
  MOVE_TARGET_INVALID: [422, 'Choose a free court of the same length at one of your grounds'],
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : undefined);

/** The v3 refund policy (M03 settings). */
const policy = () => ({
  refundAboveAdvance: settings.get('booking.refund_above_advance_on_cancel'),
  advanceRefundable: settings.get('booking.advance_refundable'),
});

const ACTIVE_HOLD = { status: 'pending_payment' };

// ---------------------------------------------------------------- phones (encrypted, last 4 shown)

const phoneFields = (phone) => (phone ? { contactPhoneEnc: encrypt(phone), contactPhoneLast4: phone.slice(-4) } : { contactPhoneEnc: null, contactPhoneLast4: null });
const phoneOf = (row) => (row.contactPhoneEnc ? decrypt(row.contactPhoneEnc) : null);

// ---------------------------------------------------------------- occupancy (booking_slots)

const range = (start, end) => [
  { value: new Date(start), inclusive: true },
  { value: new Date(end), inclusive: false },
];

/** A savepoint: on Postgres a failed statement would otherwise abort the caller's whole transaction. */
async function guarded(transaction, fn, code = 'SLOT_UNAVAILABLE') {
  try {
    return await sequelize.transaction({ transaction }, (savepoint) => fn(savepoint));
  } catch (err) {
    if (err instanceof ExclusionConstraintError || err?.parent?.code === '23P01') throw fail(code);
    throw err;
  }
}

/** One active slot per court; the exclusion constraint refuses an overlap (FR-04, §12 #1). */
async function reserve({ groundId, courtIds, start, end, source, bookingId = null, closureId = null }, { transaction, code } = {}) {
  await guarded(
    transaction,
    (t) => BookingSlot.bulkCreate(courtIds.map((courtId) => ({ courtId, groundId, period: range(start, end), source, bookingId, closureId })), { transaction: t }),
    code
  );
  touch(groundId, transaction);
}

/** Release the active slots of a booking or closure (kept as rows, status released). */
async function release(where, reason, { transaction, groundId }) {
  const [n] = await BookingSlot.update({ status: 'released', releasedAt: new Date(), releaseReason: reason }, { where: { ...where, status: 'active' }, transaction });
  touch(groundId, transaction);
  return n;
}

/** Move the active slots of a booking to a new period in place (extend, no-show tail). */
async function setPeriod(bookingId, groundId, start, end, { transaction, code }) {
  await guarded(transaction, (t) => BookingSlot.update({ period: range(start, end) }, { where: { bookingId, status: 'active' }, transaction: t }), code);
  touch(groundId, transaction);
}

/** Active slots overlapping [from, to) on these courts, with their booking (for conflicts and grids). */
async function overlapping({ courtIds, from, to, ignoreBookingId = null, ignoreClosureId = null }, { transaction } = {}) {
  const rows = await sequelize.query(
    `SELECT s.id, s.court_id AS "courtId", s.source, s.booking_id AS "bookingId", s.closure_id AS "closureId",
            lower(s.period) AS "start", upper(s.period) AS "end", b.code, b.status, b.booker_user_id AS "bookerUserId", b.team_name AS "teamName"
       FROM booking_slots s LEFT JOIN bookings b ON b.id = s.booking_id
      WHERE s.status = 'active' AND s.court_id IN (:courtIds) AND s.period && tstzrange(:from, :to, '[)')
        AND (CAST(:ib AS uuid) IS NULL OR s.booking_id IS DISTINCT FROM CAST(:ib AS uuid))
        AND (CAST(:ic AS uuid) IS NULL OR s.closure_id IS DISTINCT FROM CAST(:ic AS uuid))
      ORDER BY lower(s.period)`,
    { replacements: { courtIds, from: new Date(from), to: new Date(to), ib: ignoreBookingId, ic: ignoreClosureId }, type: sequelize.QueryTypes.SELECT, transaction }
  );
  return rows;
}

// ---------------------------------------------------------------- availability cache and live grid

const cacheKey = (groundId) => `${config.redis.prefix}:avail:${groundId}`;
const room = (groundId) => `ground:${groundId}`;

/** After commit: drop the cached grids of the ground and tell open grids to refresh (FR-02). */
function touch(groundId, transaction) {
  if (!groundId) return;
  const run = async () => {
    try {
      await getRedis().del(cacheKey(groundId));
    } catch (err) {
      logger.warn({ err: err.message }, 'availability cache bust failed');
    }
    realtime.toRoom(room(groundId), 'ground.availability_changed', { groundId });
  };
  if (transaction) transaction.afterCommit(run);
  else run();
}

// ---------------------------------------------------------------- events

const eventPayload = (b, extra = {}) => ({ bookingId: b.id, code: b.code, groundId: b.groundId, ownerId: b.ownerId, bookerUserId: b.bookerUserId ?? null, ...extra });
const publish = (transaction, name, b, extra, actor = null) => events.publish(transaction, { name, aggregateType: 'booking', aggregateId: b.id, payload: eventPayload(b, extra), actor });

// ---------------------------------------------------------------- views

const iso = (d) => (d ? new Date(d).toISOString() : null);

function money(b) {
  return {
    price: b.pricePoisha,
    extensions: b.extensionsPoisha,
    total: b.totalPoisha,
    advancePct: b.advancePct,
    advance: b.advancePoisha,
    paymentChoice: b.paymentChoice,
    paidOnline: b.onlinePoisha,
    dueAtVenue: rules.balanceDue({ total: b.totalPoisha, online: b.onlinePoisha }),
    fee: b.feePoisha,
    released: b.releasedPoisha,
    retained: b.retainedPoisha,
    refund: b.refundPoisha,
    balanceStatus: b.balanceStatus,
    balanceMethod: b.balanceMethod ?? null,
  };
}

/** The member's view (FR-11): no other people's phones, ever. */
function memberView(b, { ground = null, courts = [] } = {}) {
  return {
    id: b.id,
    code: b.code,
    status: b.status,
    groundId: b.groundId,
    ground,
    courtIds: b.courtIds,
    courts,
    start: iso(b.startAt),
    end: iso(b.endAt),
    holdExpiresAt: iso(b.holdExpiresAt),
    late: rules.isLate({ status: b.status, start: b.startAt, graceMin: b.graceMin, now: new Date() }),
    money: money(b),
    freeCancelUntil: iso(b.freeCancelUntil),
    cancelReason: b.cancelReason ?? null,
    paymentId: b.paymentId ?? null,
    createdAt: iso(b.createdAt),
  };
}

/** The owner's view: the contact's name and the last four digits only. */
function ownerView(b, { courts = [] } = {}) {
  return {
    ...memberView(b, { courts }),
    source: b.source,
    teamName: b.teamName ?? null,
    contactName: b.contactName ?? null,
    phoneLast4: b.contactPhoneLast4 ?? null,
    bookerUserId: b.bookerUserId ?? null,
    seriesId: b.seriesId ?? null,
    seriesWeek: b.seriesWeek ?? null,
    graceMin: b.graceMin,
    checkedInAt: iso(b.checkedInAt),
    moveCount: b.moveCount,
    cancelActor: b.cancelActor ?? null,
  };
}

/** Lock a booking row (every state change). */
const lock = (id, transaction) => Booking.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });

module.exports = {
  ERRORS,
  fail,
  policy,
  ACTIVE_HOLD,
  phoneFields,
  phoneOf,
  range,
  reserve,
  release,
  setPeriod,
  overlapping,
  touch,
  cacheKey,
  room,
  publish,
  eventPayload,
  memberView,
  ownerView,
  lock,
  iso,
  Op,
};
