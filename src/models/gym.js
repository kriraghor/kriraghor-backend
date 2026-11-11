'use strict';

/**
 * M20 Gym, step 1 (migration 20261101000002): gyms, gym_hours, gym_photos, gym_packages, gym_passes,
 * pass_redemptions, trainer_plans, trainer_subscriptions, trainer_subscription_periods. index.js
 * re-exports them.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');
const { toPoisha } = require('../common/money');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const req = (type) => ({ type, allowNull: false });
const by = { createdBy: DataTypes.UUID, updatedBy: DataTypes.UUID };
const poisha = (field, { allowNull = false, dflt } = {}) => ({
  type: DataTypes.BIGINT,
  allowNull,
  ...(dflt === undefined ? {} : { defaultValue: dflt }),
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : toPoisha(v);
  },
});
const num = (field, type) => ({
  type,
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : Number(v);
  },
});
// M24 §7.1 (G2): 6 months, 12 months and custom days join day, month and quarter.
const KINDS = ['day', 'month', 'quarter', 'half_year', 'year', 'custom'];

class Gym extends Model {}
Gym.init(
  {
    id,
    ownerId: req(DataTypes.UUID),
    slug: req(DataTypes.STRING(140)),
    name: req(DataTypes.STRING(120)),
    areaId: req(DataTypes.UUID),
    addressLine: req(DataTypes.STRING(300)),
    lat: num('lat', DataTypes.DECIMAL(9, 6)),
    lng: num('lng', DataTypes.DECIMAL(9, 6)),
    about: DataTypes.TEXT,
    facilityIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
    status: {
      type: DataTypes.ENUM('draft', 'pending_review', 'changes_requested', 'live', 'paused', 'rejected', 'withdrawn', 'suspended', 'removed'),
      allowNull: false,
      defaultValue: 'draft',
    },
    editStatus: DataTypes.ENUM('draft', 'pending_review', 'changes_requested', 'rejected'),
    liveVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    liveSnapshot: DataTypes.JSONB,
    currentSubmissionId: DataTypes.UUID,
    reviewReasonCode: DataTypes.STRING(40),
    reviewReasonText: DataTypes.STRING(500),
    firstLiveAt: DataTypes.DATE(3),
    statusChangedAt: DataTypes.DATE(3),
    publicName: DataTypes.STRING(120),
    publicAreaId: DataTypes.UUID,
    publicMonthPricePoisha: poisha('publicMonthPricePoisha', { allowNull: true }),
    ratingAvg: num('ratingAvg', DataTypes.DECIMAL(3, 2)),
    ratingCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...by,
  },
  { sequelize, modelName: 'Gym', tableName: 'gyms' }
);

class GymHours extends Model {}
GymHours.init(
  { id, gymId: req(DataTypes.UUID), dow: req(DataTypes.SMALLINT), openTime: req(DataTypes.STRING(5)), closeTime: req(DataTypes.STRING(5)), womenOnly: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, removedAt: DataTypes.DATE(3) },
  { sequelize, modelName: 'GymHours', tableName: 'gym_hours', updatedAt: false }
);

/** M20-FR-16: a range of dates that is closed or has its own opening windows; applied at once, never deleted. */
class GymSpecialDay extends Model {}
GymSpecialDay.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    fromOn: req(DataTypes.DATEONLY),
    toOn: req(DataTypes.DATEONLY),
    kind: req(DataTypes.ENUM('closed', 'hours')),
    windows: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    title: req(DataTypes.STRING(80)),
    status: { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
    createdBy: req(DataTypes.UUID),
    removedBy: DataTypes.UUID,
    removedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'GymSpecialDay', tableName: 'gym_special_days' }
);

class GymPhoto extends Model {}
GymPhoto.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    storageKey: req(DataTypes.STRING(300)),
    mime: req(DataTypes.STRING(40)),
    sizeBytes: req(DataTypes.INTEGER),
    sha256: req(DataTypes.STRING(64)),
    sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
    versionAdded: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    removedAt: DataTypes.DATE(3),
    ...by,
  },
  { sequelize, modelName: 'GymPhoto', tableName: 'gym_photos' }
);

class GymPackage extends Model {}
GymPackage.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    kind: req(DataTypes.ENUM(...KINDS)),
    title: req(DataTypes.STRING(80)),
    pricePoisha: poisha('pricePoisha'),
    days: req(DataTypes.SMALLINT),
    status: { type: DataTypes.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
    // M24 §7.1: the admission fee (desk memberships only, never passes), where it is sold, a visit limit, the order.
    admissionFeePoisha: poisha('admissionFeePoisha', { dflt: 0 }),
    channel: { type: DataTypes.ENUM('desk', 'online', 'both'), allowNull: false, defaultValue: 'both' },
    visitLimit: DataTypes.SMALLINT,
    sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    ...by,
  },
  { sequelize, modelName: 'GymPackage', tableName: 'gym_packages' }
);

class GymPass extends Model {}
GymPass.init(
  {
    id,
    code: req(DataTypes.STRING(20)),
    gymId: req(DataTypes.UUID),
    packageId: req(DataTypes.UUID),
    holderId: req(DataTypes.UUID),
    ownerId: req(DataTypes.UUID),
    kind: req(DataTypes.ENUM(...KINDS)),
    title: req(DataTypes.STRING(80)),
    validFrom: req(DataTypes.DATEONLY),
    validTo: req(DataTypes.DATEONLY),
    pricePoisha: poisha('pricePoisha'),
    feeBps: req(DataTypes.INTEGER),
    feePoisha: poisha('feePoisha'),
    netPoisha: poisha('netPoisha'),
    paymentId: DataTypes.UUID,
    qrNonce: req(DataTypes.STRING(24)),
    backupCode: DataTypes.STRING(6),
    status: { type: DataTypes.ENUM('pending_payment', 'active', 'redeemed', 'expired', 'cancelled', 'refunded', 'void'), allowNull: false, defaultValue: 'pending_payment' },
    payBy: DataTypes.DATE(3),
    paidAt: DataTypes.DATE(3),
    firstRedeemedAt: DataTypes.DATE(3),
    lastRedeemedAt: DataTypes.DATE(3),
    releasedAt: DataTypes.DATE(3),
    releasedPoisha: poisha('releasedPoisha', { dflt: 0 }),
    refundedPoisha: poisha('refundedPoisha', { dflt: 0 }),
    closedAt: DataTypes.DATE(3),
    closeReason: DataTypes.STRING(40),
    idempotencyKey: req(DataTypes.STRING(80)),
    // M24 §7.1: the gym_fee_overrides row behind feeBps (prompt 2; no FK, another module's table).
    feeOverrideId: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymPass', tableName: 'gym_passes' }
);

class PassRedemption extends Model {}
PassRedemption.init(
  {
    id,
    passId: req(DataTypes.UUID),
    gymId: req(DataTypes.UUID),
    redeemedOn: req(DataTypes.DATEONLY),
    redeemedAt: req(DataTypes.DATE(3)),
    redeemedBy: req(DataTypes.UUID),
    method: req(DataTypes.ENUM('qr', 'code')),
  },
  { sequelize, modelName: 'PassRedemption', tableName: 'pass_redemptions', updatedAt: false }
);

class TrainerPlan extends Model {}
TrainerPlan.init(
  {
    id,
    profileId: req(DataTypes.UUID),
    trainerId: req(DataTypes.UUID),
    title: req(DataTypes.STRING(80)),
    description: DataTypes.STRING(500),
    sessionsPerMonth: DataTypes.SMALLINT,
    pricePoisha: poisha('pricePoisha'),
    whereKind: req(DataTypes.ENUM('gym', 'home', 'online')),
    gymId: DataTypes.UUID,
    areaId: DataTypes.UUID,
    status: { type: DataTypes.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
    ...by,
  },
  { sequelize, modelName: 'TrainerPlan', tableName: 'trainer_plans' }
);

class TrainerSubscription extends Model {}
TrainerSubscription.init(
  {
    id,
    code: req(DataTypes.STRING(20)),
    planId: req(DataTypes.UUID),
    profileId: req(DataTypes.UUID),
    memberId: req(DataTypes.UUID),
    trainerId: req(DataTypes.UUID),
    title: req(DataTypes.STRING(80)),
    sessionsPerMonth: DataTypes.SMALLINT,
    pricePoisha: poisha('pricePoisha'),
    status: { type: DataTypes.ENUM('pending_payment', 'active', 'cancelled', 'ended', 'lapsed', 'void'), allowNull: false, defaultValue: 'pending_payment' },
    startedOn: req(DataTypes.DATEONLY),
    paidThrough: DataTypes.DATEONLY,
    renew: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    endedAt: DataTypes.DATE(3),
    endReason: DataTypes.STRING(40),
    idempotencyKey: req(DataTypes.STRING(80)),
  },
  { sequelize, modelName: 'TrainerSubscription', tableName: 'trainer_subscriptions' }
);

class TrainerSubscriptionPeriod extends Model {}
TrainerSubscriptionPeriod.init(
  {
    id,
    subscriptionId: req(DataTypes.UUID),
    seq: req(DataTypes.INTEGER),
    periodStart: req(DataTypes.DATEONLY),
    periodEnd: req(DataTypes.DATEONLY),
    pricePoisha: poisha('pricePoisha'),
    feeBps: req(DataTypes.INTEGER),
    feePoisha: poisha('feePoisha'),
    netPoisha: poisha('netPoisha'),
    paymentId: DataTypes.UUID,
    status: { type: DataTypes.ENUM('pending_payment', 'paid', 'released', 'refunded', 'disputed', 'void'), allowNull: false, defaultValue: 'pending_payment' },
    payBy: DataTypes.DATE(3),
    paidAt: DataTypes.DATE(3),
    releaseAt: DataTypes.DATE(3),
    releasedAt: DataTypes.DATE(3),
    releasedPoisha: poisha('releasedPoisha', { dflt: 0 }),
    refundedPoisha: poisha('refundedPoisha', { dflt: 0 }),
    disputeId: DataTypes.UUID,
  },
  { sequelize, modelName: 'TrainerSubscriptionPeriod', tableName: 'trainer_subscription_periods' }
);
TrainerSubscription.hasMany(TrainerSubscriptionPeriod, { as: 'periods', foreignKey: 'subscriptionId' });
TrainerSubscriptionPeriod.belongsTo(TrainerSubscription, { as: 'subscription', foreignKey: 'subscriptionId' });

module.exports = { Gym, GymHours, GymSpecialDay, GymPhoto, GymPackage, GymPass, PassRedemption, TrainerPlan, TrainerSubscription, TrainerSubscriptionPeriod };
