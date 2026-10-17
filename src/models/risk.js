'use strict';

/**
 * M18 Risk and Trust models (migration 20261028000002-create-risk), and M02's document requests
 * (migration 20261028000001, owned by M02). index.js re-exports them.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const req = (type) => ({ type, allowNull: false });
const num = (field, allowNull = false) => ({
  type: DataTypes.DECIMAL(12, 2),
  allowNull,
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : Number(v);
  },
});
const SEVERITY = ['info', 'medium', 'high', 'critical'];

class RiskRule extends Model {}
RiskRule.init(
  {
    key: { type: DataTypes.STRING(40), primaryKey: true },
    metric: req(DataTypes.STRING(40)),
    comparator: req(DataTypes.ENUM('gte', 'gt')),
    settingKey: DataTypes.STRING(80),
    severity: req(DataTypes.ENUM(...SEVERITY)),
    description: req(DataTypes.STRING(200)),
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  },
  { sequelize, modelName: 'RiskRule', tableName: 'risk_rules' }
);

class RiskMetric extends Model {}
RiskMetric.init(
  {
    userId: { type: DataTypes.UUID, primaryKey: true },
    metric: { type: DataTypes.STRING(40), primaryKey: true },
    value: num('value'),
    sample: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    detail: DataTypes.JSONB,
    computedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, modelName: 'RiskMetric', tableName: 'risk_metrics', timestamps: false }
);

class RiskFlag extends Model {}
RiskFlag.init(
  {
    id,
    userId: req(DataTypes.UUID),
    ruleKey: req(DataTypes.STRING(40)),
    ruleVersion: req(DataTypes.INTEGER),
    metricValue: num('metricValue'),
    threshold: num('threshold'),
    severity: req(DataTypes.ENUM(...SEVERITY)),
    reasonText: req(DataTypes.STRING(300)),
    status: { type: DataTypes.ENUM('open', 'actioned', 'cleared', 'lapsed'), allowNull: false, defaultValue: 'open' },
    escalated: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    snoozeUntil: DataTypes.DATE(3),
    clearedValue: num('clearedValue', true),
    firstSeenAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    lastSeenAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    closedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'RiskFlag', tableName: 'risk_flags' }
);

class RiskAction extends Model {}
RiskAction.init(
  {
    id,
    userId: req(DataTypes.UUID),
    flagId: DataTypes.UUID,
    action: req(DataTypes.ENUM('freeze_payouts', 'unfreeze_payouts', 'request_documents', 'cancel_document_request', 'clear', 'reopen', 'suspend', 'ban', 'restore')),
    reason: req(DataTypes.STRING(500)),
    actorId: DataTypes.UUID,
    actorRole: req(DataTypes.ENUM('staff', 'master', 'system')),
    reversesActionId: DataTypes.UUID,
    payoutHoldId: DataTypes.UUID,
    documentRequestId: DataTypes.UUID,
    sanctionId: DataTypes.UUID,
    params: DataTypes.JSONB,
  },
  { sequelize, modelName: 'RiskAction', tableName: 'risk_actions', updatedAt: false }
);

class TrustScore extends Model {}
TrustScore.init(
  {
    userId: { type: DataTypes.UUID, primaryKey: true },
    kind: { type: DataTypes.ENUM('owner', 'booker'), primaryKey: true },
    score: DataTypes.SMALLINT,
    sample: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    incidents: num('incidents'),
    shown: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    detail: DataTypes.JSONB,
    computedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, modelName: 'TrustScore', tableName: 'trust_scores', timestamps: false }
);

/** M02-owned (M18-FR-07). */
class DocumentRequest extends Model {}
DocumentRequest.init(
  {
    id,
    userId: req(DataTypes.UUID),
    docType: req(DataTypes.ENUM('nid', 'trade_license', 'deed_or_lease', 'tin')),
    reason: req(DataTypes.STRING(300)),
    source: req(DataTypes.ENUM('risk', 'staff')),
    sourceRef: DataTypes.UUID,
    status: { type: DataTypes.ENUM('open', 'fulfilled', 'cancelled', 'overdue'), allowNull: false, defaultValue: 'open' },
    dueAt: req(DataTypes.DATE(3)),
    requestedBy: DataTypes.UUID,
    fulfilledDocumentId: DataTypes.UUID,
    fulfilledAt: DataTypes.DATE(3),
    cancelledAt: DataTypes.DATE(3),
    cancelledBy: DataTypes.UUID,
    cancelReason: DataTypes.STRING(300),
    overdueAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'DocumentRequest', tableName: 'document_requests' }
);

module.exports = { RiskRule, RiskMetric, RiskFlag, RiskAction, TrustScore, DocumentRequest, RISK_SEVERITIES: SEVERITY };
