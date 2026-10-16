'use strict';

/**
 * M09 Grounds models (migration 20261024000004-create-grounds). index.js re-exports them and declares
 * the cross-file associations.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');
const { toPoisha } = require('../common/money');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const req = (type) => ({ type, allowNull: false });
// DECIMAL and BIGINT come back from pg as strings; read them as numbers.
const num = (field, type, allowNull = false) => ({
  type,
  allowNull,
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : Number(v);
  },
});
const poisha = (field) => ({
  type: DataTypes.BIGINT,
  allowNull: false,
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? v : toPoisha(v);
  },
});
const time = (field) => ({
  type: DataTypes.TIME,
  get() {
    const v = this.getDataValue(field);
    return v ? String(v).slice(0, 5) : null;
  },
});
const by = { createdBy: DataTypes.UUID, updatedBy: DataTypes.UUID };

class Ground extends Model {}
Ground.init(
  {
    id,
    ownerId: req(DataTypes.UUID),
    name: req(DataTypes.STRING(80)),
    slug: req(DataTypes.STRING(96)),
    areaId: req(DataTypes.UUID),
    addressLine: req(DataTypes.STRING(200)),
    lat: num('lat', DataTypes.DECIMAL(9, 6)),
    lng: num('lng', DataTypes.DECIMAL(9, 6)),
    description: DataTypes.TEXT,
    rulesText: DataTypes.TEXT,
    isIndoor: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    bookingCutoffMin: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    requiresOfficial: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    facilityIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
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
    ratingAvg: num('ratingAvg', DataTypes.DECIMAL(3, 2), true),
    ratingCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ...by,
  },
  { sequelize, modelName: 'Ground', tableName: 'grounds' }
);

class GroundPhoto extends Model {}
GroundPhoto.init(
  {
    id,
    groundId: req(DataTypes.UUID),
    storageKey: req(DataTypes.STRING(255)),
    mime: req(DataTypes.ENUM('image/jpeg', 'image/png', 'image/webp')),
    sizeBytes: req(DataTypes.INTEGER),
    sha256: req(DataTypes.CHAR(64)),
    sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
    versionAdded: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    removedAt: DataTypes.DATE(3),
    ...by,
  },
  { sequelize, modelName: 'GroundPhoto', tableName: 'ground_photos' }
);

class Court extends Model {}
Court.init(
  {
    id,
    groundId: req(DataTypes.UUID),
    name: req(DataTypes.STRING(40)),
    sportIds: req(DataTypes.ARRAY(DataTypes.UUID)),
    surfaceId: req(DataTypes.UUID),
    sizeText: DataTypes.STRING(40),
    capacityText: DataTypes.STRING(40),
    combinableGroup: DataTypes.STRING(32),
    sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.ENUM('pending', 'active', 'retired'), allowNull: false, defaultValue: 'pending' },
    retiredAt: DataTypes.DATE(3),
    ...by,
  },
  { sequelize, modelName: 'Court', tableName: 'courts' }
);

class CourtHours extends Model {}
CourtHours.init(
  {
    id,
    courtId: req(DataTypes.UUID),
    dow: req(DataTypes.SMALLINT),
    isClosed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    openTime: time('openTime'),
    closeTime: time('closeTime'),
  },
  { sequelize, modelName: 'CourtHours', tableName: 'court_hours' }
);

class PricingRule extends Model {}
PricingRule.init(
  {
    id,
    groundId: req(DataTypes.UUID),
    version: req(DataTypes.INTEGER),
    status: req(DataTypes.ENUM('draft', 'published', 'superseded', 'discarded')),
    basePricePoisha: poisha('basePricePoisha'),
    courtBaseOverrides: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    peakFromHour: req(DataTypes.SMALLINT),
    earlyToHour: req(DataTypes.SMALLINT),
    peakPct: num('peakPct', DataTypes.DECIMAL(5, 2)),
    weekendPct: num('weekendPct', DataTypes.DECIMAL(5, 2)),
    earlyPct: num('earlyPct', DataTypes.DECIMAL(5, 2)),
    advancePct: num('advancePct', DataTypes.DECIMAL(5, 2)),
    seriesDiscountPct: num('seriesDiscountPct', DataTypes.DECIMAL(5, 2)),
    minBookingMin: req(DataTypes.SMALLINT),
    fullRefundHours: req(DataTypes.SMALLINT),
    halfRefundHours: req(DataTypes.SMALLINT),
    checkinGraceMin: req(DataTypes.SMALLINT),
    effectiveFrom: DataTypes.DATE(3),
    effectiveTo: DataTypes.DATE(3),
    summary: DataTypes.STRING(300),
    changedKeys: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    publishedBy: DataTypes.UUID,
    ...by,
  },
  { sequelize, modelName: 'PricingRule', tableName: 'pricing_rules' }
);

Ground.hasMany(GroundPhoto, { as: 'photos', foreignKey: 'groundId' });
Ground.hasMany(Court, { as: 'courts', foreignKey: 'groundId' });
Court.hasMany(CourtHours, { as: 'hours', foreignKey: 'courtId' });
Ground.hasMany(PricingRule, { as: 'pricing', foreignKey: 'groundId' });

module.exports = { Ground, GroundPhoto, Court, CourtHours, PricingRule };
