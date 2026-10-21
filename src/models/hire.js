'use strict';

/**
 * M03 hire taxonomy (migration 20261031000001) and M11 Hire, step 1 (20261031000003): hire_categories,
 * hire_roles, hire_profiles, rate_cards, rate_card_items, hire_requests, hire_jobs, hire_messages,
 * hire_shortlists. index.js re-exports them.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');
const { toPoisha } = require('../common/money');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const req = (type) => ({ type, allowNull: false });
const by = { createdBy: DataTypes.UUID, updatedBy: DataTypes.UUID };
const names = {
  key: req(DataTypes.STRING(40)),
  nameEn: req(DataTypes.STRING(80)),
  nameBn: req(DataTypes.STRING(80)),
  sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
};
const poisha = (field, { allowNull = false, dflt } = {}) => ({
  type: DataTypes.BIGINT,
  allowNull,
  ...(dflt === undefined ? {} : { defaultValue: dflt }),
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : toPoisha(v);
  },
});
const num = (field, type, extra = {}) => ({
  type,
  allowNull: false,
  ...extra,
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : Number(v);
  },
});

// ---------------------------------------------------------------- M03 taxonomy

class HireCategory extends Model {}
HireCategory.init(
  { id, ...names, code: req(DataTypes.CHAR(2)), forRole: req(DataTypes.ENUM('player', 'pro')), tint: DataTypes.STRING(9), ...by },
  { sequelize, modelName: 'HireCategory', tableName: 'hire_categories' }
);

class HireRole extends Model {}
HireRole.init(
  {
    id,
    ...names,
    categoryId: req(DataTypes.UUID),
    sportKeys: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
    allowedUnits: req(DataTypes.ARRAY(DataTypes.TEXT)),
    formatPriced: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    formats: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
    baseHourlyPoisha: poisha('baseHourlyPoisha'),
    specialisations: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    credentialTiers: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    requiresCredential: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    policeCheckForU16: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isOfficial: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ...by,
  },
  { sequelize, modelName: 'HireRole', tableName: 'hire_roles' }
);
HireRole.belongsTo(HireCategory, { as: 'category', foreignKey: 'categoryId' });
HireCategory.hasMany(HireRole, { as: 'roles', foreignKey: 'categoryId' });

// ---------------------------------------------------------------- M11

class HireProfile extends Model {}
HireProfile.init(
  {
    id,
    userId: req(DataTypes.UUID),
    roleId: req(DataTypes.UUID),
    slug: req(DataTypes.STRING(96)),
    headline: req(DataTypes.STRING(80)),
    specialisation: DataTypes.STRING(40),
    sportKeys: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
    experienceLevel: req(DataTypes.ENUM('amateur', 'semi_pro', 'pro', 'national')),
    years: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    baseAreaId: req(DataTypes.UUID),
    bio: DataTypes.TEXT,
    worksWithU16: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: {
      type: DataTypes.ENUM('draft', 'pending_review', 'changes_requested', 'live', 'paused', 'rejected', 'withdrawn', 'suspended', 'removed'),
      allowNull: false,
      defaultValue: 'draft',
    },
    editStatus: DataTypes.ENUM('draft', 'pending_review', 'changes_requested', 'rejected'),
    liveVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    liveSnapshot: DataTypes.JSON,
    currentSubmissionId: DataTypes.UUID,
    reviewReasonCode: DataTypes.STRING(40),
    reviewReasonText: DataTypes.STRING(500),
    firstLiveAt: DataTypes.DATE(3),
    statusChangedAt: DataTypes.DATE(3),
    publicHeadline: DataTypes.STRING(80),
    publicExperienceLevel: DataTypes.STRING(10),
    publicAreaId: DataTypes.UUID,
    normalisedHourlyPoisha: poisha('normalisedHourlyPoisha', { allowNull: true }),
    ratingAvg: { ...num('ratingAvg', DataTypes.DECIMAL(3, 2)), allowNull: true },
    ratingCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    jobsDone: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // Round B1 (FR-52, migration 20261109000002): reply stats over hire.acceptance_window_days.
    acceptanceRate: { ...num('acceptanceRate', DataTypes.DECIMAL(5, 2)), allowNull: true },
    medianReplyMinutes: DataTypes.INTEGER,
    ...by,
  },
  { sequelize, modelName: 'HireProfile', tableName: 'hire_profiles' }
);
HireProfile.belongsTo(HireRole, { as: 'role', foreignKey: 'roleId' });

class RateCard extends Model {}
RateCard.init(
  {
    id,
    profileId: req(DataTypes.UUID),
    version: req(DataTypes.INTEGER),
    nightPct: num('nightPct', DataTypes.DECIMAL(5, 2), { defaultValue: 0 }),
    shortNoticePct: num('shortNoticePct', DataTypes.DECIMAL(5, 2), { defaultValue: 0 }),
    shortNoticeHours: req(DataTypes.SMALLINT),
    travelNorthPoisha: poisha('travelNorthPoisha', { dflt: 0 }),
    travelSouthPoisha: poisha('travelSouthPoisha', { dflt: 0 }),
    travelOutsidePoisha: poisha('travelOutsidePoisha', { dflt: 0 }),
    maxJobsPerDay: req(DataTypes.SMALLINT),
    createdBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'RateCard', tableName: 'rate_cards', updatedAt: false }
);

class RateCardItem extends Model {}
RateCardItem.init(
  { id, rateCardId: req(DataTypes.UUID), unit: req(DataTypes.ENUM('hourly', 'match')), format: DataTypes.ENUM('T10', 'T20', 'OD', 'TAPE'), ratePoisha: poisha('ratePoisha') },
  { sequelize, modelName: 'RateCardItem', tableName: 'rate_card_items', timestamps: false }
);
RateCard.hasMany(RateCardItem, { as: 'items', foreignKey: 'rateCardId' });

class HireRequest extends Model {}
HireRequest.init(
  {
    id,
    code: req(DataTypes.STRING(20)),
    hirerId: req(DataTypes.UUID),
    profileId: req(DataTypes.UUID),
    proUserId: req(DataTypes.UUID),
    unit: req(DataTypes.ENUM('hourly', 'match')),
    note: DataTypes.STRING(500),
    rateCardId: req(DataTypes.UUID),
    quoteSnapshot: req(DataTypes.JSON),
    totalPoisha: poisha('totalPoisha'),
    feeBps: req(DataTypes.INTEGER),
    feePoisha: poisha('feePoisha'),
    netPoisha: poisha('netPoisha'),
    status: {
      type: DataTypes.ENUM('pending', 'accepted_unpaid', 'confirmed', 'completed', 'declined', 'expired', 'withdrawn', 'lapsed', 'cancelled'),
      allowNull: false,
      defaultValue: 'pending',
    },
    replyBy: req(DataTypes.DATE(3)),
    payBy: DataTypes.DATE(3),
    paymentId: DataTypes.UUID,
    declineReasonCode: DataTypes.STRING(40),
    declineText: DataTypes.STRING(300),
    decidedAt: DataTypes.DATE(3),
    confirmedAt: DataTypes.DATE(3),
    closedAt: DataTypes.DATE(3),
    idempotencyKey: req(DataTypes.STRING(80)),
  },
  { sequelize, modelName: 'HireRequest', tableName: 'hire_requests' }
);

class HireJob extends Model {}
HireJob.init(
  {
    id,
    code: req(DataTypes.STRING(24)),
    requestId: req(DataTypes.UUID),
    profileId: req(DataTypes.UUID),
    proUserId: req(DataTypes.UUID),
    hirerId: req(DataTypes.UUID),
    startAt: req(DataTypes.DATE(3)),
    endAt: req(DataTypes.DATE(3)),
    busy: req(DataTypes.RANGE(DataTypes.DATE)),
    format: DataTypes.ENUM('T10', 'T20', 'OD', 'TAPE'),
    hours: num('hours', DataTypes.DECIMAL(4, 1)),
    night: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    u16: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    venueGroundId: DataTypes.UUID,
    venueText: req(DataTypes.STRING(200)),
    venueAreaId: req(DataTypes.UUID),
    zone: req(DataTypes.ENUM('home', 'north', 'south', 'outside')),
    quotePoisha: poisha('quotePoisha'),
    feePoisha: poisha('feePoisha'),
    netPoisha: poisha('netPoisha'),
    refundedPoisha: poisha('refundedPoisha', { dflt: 0 }),
    releasedPoisha: poisha('releasedPoisha', { dflt: 0 }),
    status: {
      type: DataTypes.ENUM('reserved', 'scheduled', 'checked_in', 'live', 'completed_marked', 'released', 'cancelled', 'withdrawn', 'void', 'disputed', 'refunded'),
      allowNull: false,
      defaultValue: 'reserved',
    },
    checkedInAt: DataTypes.DATE(3),
    late: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    startedAt: DataTypes.DATE(3),
    completedAt: DataTypes.DATE(3),
    workNote: DataTypes.STRING(1000),
    resultText: DataTypes.STRING(120),
    releaseAt: DataTypes.DATE(3),
    releasedAt: DataTypes.DATE(3),
    releasedBy: DataTypes.ENUM('hirer', 'auto', 'dispute', 'cancellation'),
    cancelledAt: DataTypes.DATE(3),
    cancelledBy: DataTypes.ENUM('hirer', 'pro', 'system', 'staff'),
    cancelReason: DataTypes.STRING(40),
    cancelFeePoisha: poisha('cancelFeePoisha', { dflt: 0 }),
    remindedAt: DataTypes.DATE(3),
    disputeId: DataTypes.UUID,
  },
  { sequelize, modelName: 'HireJob', tableName: 'hire_jobs' }
);
HireRequest.hasMany(HireJob, { as: 'jobs', foreignKey: 'requestId' });
HireJob.belongsTo(HireRequest, { as: 'request', foreignKey: 'requestId' });

class HireMessage extends Model {}
HireMessage.init({ id, requestId: req(DataTypes.UUID), authorId: req(DataTypes.UUID), body: req(DataTypes.STRING(1000)) }, { sequelize, modelName: 'HireMessage', tableName: 'hire_messages', updatedAt: false });

class HireShortlist extends Model {}
HireShortlist.init({ id, userId: req(DataTypes.UUID), profileId: req(DataTypes.UUID), removedAt: DataTypes.DATE(3) }, { sequelize, modelName: 'HireShortlist', tableName: 'hire_shortlists', updatedAt: false });

/**
 * Round B1 (§7, FR-05): time a person is not available. period is the block itself, or a weekly
 * repeat's validity (upper bound open without an until); repeatRule { weekdays, from, to, until? }.
 */
class AvailabilityBlock extends Model {}
AvailabilityBlock.init(
  {
    id,
    userId: req(DataTypes.UUID),
    profileId: DataTypes.UUID,
    period: req(DataTypes.RANGE(DataTypes.DATE)),
    reason: DataTypes.STRING(120),
    repeatRule: DataTypes.JSONB,
    status: { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
    createdBy: DataTypes.UUID,
    removedBy: DataTypes.UUID,
    removedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'AvailabilityBlock', tableName: 'availability_blocks' }
);

module.exports = { HireCategory, HireRole, HireProfile, RateCard, RateCardItem, HireRequest, HireJob, HireMessage, HireShortlist, AvailabilityBlock };
