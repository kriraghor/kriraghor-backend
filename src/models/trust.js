'use strict';

/**
 * M17 Disputes, Reports and Reviews models (migration 20261027000001-create-trust). index.js
 * re-exports them.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');
const { toPoisha } = require('../common/money');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const req = (type) => ({ type, allowNull: false });
const poisha = (field, allowNull = true) => ({
  type: DataTypes.BIGINT,
  allowNull,
  ...(allowNull ? {} : { defaultValue: 0 }),
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : toPoisha(v);
  },
});

const OUTCOMES = ['all', 'half', 'none', 'custom', 'upheld', 'rejected', 'corrected'];
const ACTIVE = ['awaiting_response', 'under_review', 'escalated'];

class Dispute extends Model {}
Dispute.init(
  {
    id,
    code: req(DataTypes.STRING(20)),
    sourceType: req(DataTypes.ENUM('booking', 'esports_result')),
    sourceId: req(DataTypes.UUID),
    sourceRef: req(DataTypes.STRING(40)),
    category: req(DataTypes.ENUM('no_show_contest', 'venue_problem', 'cash_problem', 'result_wrong')),
    claimantId: req(DataTypes.UUID),
    respondentId: DataTypes.UUID,
    status: req(DataTypes.ENUM(...ACTIVE, 'resolved', 'withdrawn')),
    money: req(DataTypes.BOOLEAN),
    paidPoisha: poisha('paidPoisha', false),
    heldPoisha: poisha('heldPoisha', false),
    policyKey: req(DataTypes.STRING(60)),
    policy: req(DataTypes.JSONB),
    claimedBy: DataTypes.UUID,
    claimExpiresAt: DataTypes.DATE(3),
    recommendedOutcome: DataTypes.ENUM(...OUTCOMES),
    recommendedRefundPoisha: poisha('recommendedRefundPoisha'),
    recommendedBy: DataTypes.UUID,
    escalationNote: DataTypes.STRING(1000),
    outcome: DataTypes.ENUM(...OUTCOMES),
    refundPoisha: poisha('refundPoisha'),
    releasedPoisha: poisha('releasedPoisha'),
    feePoisha: poisha('feePoisha'),
    decidedBy: DataTypes.UUID,
    decidedRole: DataTypes.ENUM('staff', 'master'),
    decisionReason: DataTypes.STRING(1000),
    respondentDueAt: DataTypes.DATE(3),
    respondentRemindedAt: DataTypes.DATE(3),
    slaDueAt: DataTypes.DATE(3),
    masterDueAt: DataTypes.DATE(3),
    slaBreachedAt: DataTypes.DATE(3),
    respondedAt: DataTypes.DATE(3),
    escalatedAt: DataTypes.DATE(3),
    resolvedAt: DataTypes.DATE(3),
    withdrawnAt: DataTypes.DATE(3),
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    idempotencyKey: DataTypes.STRING(80),
  },
  { sequelize, modelName: 'Dispute', tableName: 'disputes' }
);

class DisputeEvidence extends Model {}
DisputeEvidence.init(
  {
    id,
    disputeId: req(DataTypes.UUID),
    party: req(DataTypes.ENUM('claimant', 'respondent', 'staff', 'system')),
    kind: req(DataTypes.ENUM('statement', 'file', 'system')),
    authorId: DataTypes.UUID,
    text: DataTypes.STRING(2000),
    fileKey: DataTypes.STRING(200),
    mime: DataTypes.STRING(60),
    sizeBytes: DataTypes.INTEGER,
    sha256: DataTypes.CHAR(64),
    systemRef: DataTypes.JSONB,
    hiddenReason: DataTypes.STRING(200),
    hiddenBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'DisputeEvidence', tableName: 'dispute_evidence', updatedAt: false }
);

class Report extends Model {}
Report.init(
  {
    id,
    code: req(DataTypes.STRING(20)),
    subjectType: req(DataTypes.ENUM('ground', 'booking', 'user', 'review', 'esports_tournament')),
    subjectId: req(DataTypes.UUID),
    subjectOwnerId: DataTypes.UUID,
    reporterId: req(DataTypes.UUID),
    reasonCode: req(DataTypes.ENUM('fake_listing', 'wrong_info', 'unsafe', 'harassment', 'fraud', 'spam', 'offensive', 'cheating', 'other')),
    note: DataTypes.STRING(500),
    eligible: req(DataTypes.BOOLEAN),
    status: { type: DataTypes.ENUM('open', 'escalated', 'resolved', 'dismissed'), allowNull: false, defaultValue: 'open' },
    resolutionAction: DataTypes.ENUM('no_violation', 'content_removed', 'owner_warned', 'user_suspended', 'converted_to_dispute', 'dismissed'),
    resolutionNote: DataTypes.STRING(500),
    resolvedBy: DataTypes.UUID,
    resolvedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'Report', tableName: 'reports' }
);

class Review extends Model {}
Review.init(
  {
    id,
    subjectType: req(DataTypes.ENUM('ground')),
    subjectId: req(DataTypes.UUID),
    sourceType: req(DataTypes.ENUM('booking')),
    sourceId: req(DataTypes.UUID),
    authorId: req(DataTypes.UUID),
    stars: req(DataTypes.SMALLINT),
    text: DataTypes.STRING(1000),
    status: req(DataTypes.ENUM('held', 'published', 'hidden')),
    heldReason: DataTypes.ENUM('dispute', 'content'),
    hiddenReason: DataTypes.STRING(200),
    hiddenBy: DataTypes.UUID,
    hiddenAt: DataTypes.DATE(3),
    replyText: DataTypes.STRING(1000),
    repliedBy: DataTypes.UUID,
    repliedAt: DataTypes.DATE(3),
    editUntil: req(DataTypes.DATE(3)),
    editedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'Review', tableName: 'reviews' }
);

class ReviewAggregate extends Model {}
ReviewAggregate.init(
  {
    subjectType: { type: DataTypes.STRING(20), primaryKey: true },
    subjectId: { type: DataTypes.UUID, primaryKey: true },
    reviewCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    starsSum: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    starsHist: { type: DataTypes.JSONB, allowNull: false, defaultValue: [0, 0, 0, 0, 0] },
  },
  { sequelize, modelName: 'ReviewAggregate', tableName: 'review_aggregates', createdAt: false }
);

Dispute.hasMany(DisputeEvidence, { as: 'evidence', foreignKey: 'disputeId' });

module.exports = { Dispute, DisputeEvidence, Report, Review, ReviewAggregate, DISPUTE_ACTIVE: ACTIVE, DISPUTE_OUTCOMES: OUTCOMES };
