'use strict';

/**
 * M10 Bookings models (migration 20261025000002-create-bookings). index.js re-exports them and
 * declares the cross-file associations.
 *
 * booking_slots.period is a PostgreSQL tstzrange: Sequelize reads it as [{value, inclusive}, …];
 * the services query overlaps with raw SQL (the exclusion constraint is the real guard).
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');
const { toPoisha } = require('../common/money');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const req = (type) => ({ type, allowNull: false });
const num = (field, type, allowNull = false) => ({
  type,
  allowNull,
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : Number(v);
  },
});
const poisha = (field, allowNull = false) => ({
  type: DataTypes.BIGINT,
  allowNull,
  ...(allowNull ? {} : { defaultValue: 0 }),
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? v : toPoisha(v);
  },
});
const by = { createdBy: DataTypes.UUID, updatedBy: DataTypes.UUID };

const STATUSES = ['pending_payment', 'confirmed', 'checked_in', 'completed', 'no_show', 'cancelled', 'cancelled_by_owner', 'cancelled_by_platform', 'expired', 'skipped'];

class Booking extends Model {}
Booking.init(
  {
    id,
    code: req(DataTypes.STRING(16)),
    source: req(DataTypes.ENUM('app', 'walk_in', 'series')),
    groundId: req(DataTypes.UUID),
    ownerId: req(DataTypes.UUID),
    courtIds: req(DataTypes.ARRAY(DataTypes.UUID)),
    bookerUserId: DataTypes.UUID,
    teamName: DataTypes.STRING(80),
    contactName: DataTypes.STRING(80),
    contactPhoneEnc: DataTypes.STRING(255),
    contactPhoneLast4: DataTypes.CHAR(4),
    startAt: req(DataTypes.DATE(3)),
    endAt: req(DataTypes.DATE(3)),
    status: req(DataTypes.ENUM(...STATUSES)),
    holdExpiresAt: DataTypes.DATE(3),
    pricingRuleId: req(DataTypes.UUID),
    pricePoisha: poisha('pricePoisha'),
    extensionsPoisha: poisha('extensionsPoisha'),
    totalPoisha: poisha('totalPoisha'),
    advancePct: num('advancePct', DataTypes.DECIMAL(5, 2)),
    advancePoisha: poisha('advancePoisha'),
    paymentChoice: req(DataTypes.ENUM('advance', 'full', 'venue')),
    onlinePoisha: poisha('onlinePoisha'),
    feeBps: req(DataTypes.INTEGER),
    feePoisha: poisha('feePoisha'),
    releasedPoisha: poisha('releasedPoisha'),
    retainedPoisha: poisha('retainedPoisha'),
    refundPoisha: poisha('refundPoisha'),
    balanceStatus: { type: DataTypes.ENUM('not_due', 'due', 'collected', 'unrecorded', 'waived'), allowNull: false, defaultValue: 'not_due' },
    balanceMethod: DataTypes.ENUM('cash', 'bkash_venue'),
    balanceCollectedPoisha: poisha('balanceCollectedPoisha', true),
    balanceCollectedAt: DataTypes.DATE(3),
    balanceCollectedBy: DataTypes.UUID,
    graceMin: req(DataTypes.SMALLINT),
    minBookingMin: req(DataTypes.SMALLINT),
    seriesId: DataTypes.UUID,
    seriesWeek: DataTypes.SMALLINT,
    paymentId: DataTypes.UUID,
    idempotencyKey: DataTypes.STRING(80),
    moveCount: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    freeCancelUntil: DataTypes.DATE(3),
    confirmedAt: DataTypes.DATE(3),
    checkedInAt: DataTypes.DATE(3),
    completedAt: DataTypes.DATE(3),
    noShowAt: DataTypes.DATE(3),
    cancelledAt: DataTypes.DATE(3),
    expiredAt: DataTypes.DATE(3),
    cancelActor: DataTypes.ENUM('booker', 'owner', 'platform', 'system'),
    cancelReason: DataTypes.STRING(40),
    cancelNote: DataTypes.STRING(200),
    remindedAt: DataTypes.DATE(3),
    unrecordedAt: DataTypes.DATE(3),
    ...by,
  },
  { sequelize, modelName: 'Booking', tableName: 'bookings' }
);

class BookingSlot extends Model {}
BookingSlot.init(
  {
    id,
    courtId: req(DataTypes.UUID),
    groundId: req(DataTypes.UUID),
    period: req(DataTypes.RANGE(DataTypes.DATE)),
    source: req(DataTypes.ENUM('app', 'walk_in', 'series', 'closure')),
    bookingId: DataTypes.UUID,
    closureId: DataTypes.UUID,
    status: { type: DataTypes.ENUM('active', 'released'), allowNull: false, defaultValue: 'active' },
    releasedAt: DataTypes.DATE(3),
    releaseReason: DataTypes.ENUM('expired', 'cancelled', 'no_show_tail', 'moved', 'skipped', 'reopened'),
  },
  { sequelize, modelName: 'BookingSlot', tableName: 'booking_slots' }
);

class CheckIn extends Model {}
CheckIn.init(
  {
    id,
    bookingId: req(DataTypes.UUID),
    checkedInAt: req(DataTypes.DATE(3)),
    checkedInBy: DataTypes.UUID,
    lateMinutes: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    method: req(DataTypes.ENUM('owner_desk', 'walk_in')),
  },
  { sequelize, modelName: 'CheckIn', tableName: 'check_ins', updatedAt: false }
);

Booking.hasMany(BookingSlot, { as: 'slots', foreignKey: 'bookingId' });
Booking.hasOne(CheckIn, { as: 'checkIn', foreignKey: 'bookingId' });

module.exports = { Booking, BookingSlot, CheckIn, BOOKING_STATUSES: STATUSES };
