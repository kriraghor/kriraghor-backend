'use strict';

const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { ROLE_LIST } = require('../common/enums');
const { uuid7 } = require('../common/uuid7');
const { toPoisha } = require('../common/money');

const ROLE_STATUSES = ['applied', 'documents_pending', 'in_review', 'changes_requested', 'active', 'rejected', 'suspended', 'withdrawn'];
const PERMS = ['approve_listings', 'approve_documents', 'resolve_reports', 'refund_small', 'view_payouts', 'release_payouts', 'edit_fees', 'manage_staff', 'manage_users', 'manage_catalog', 'manage_esports', 'enter_results', 'view_analytics', 'manage_organisers'];

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };

class User extends Model {
  /** Safe projection for API responses — never includes hashes or NID data. */
  toPublic({ roles = [], permissions = [] } = {}) {
    return {
      id: this.id,
      displayName: this.displayName,
      phone: this.phone,
      email: this.email,
      emailVerified: Boolean(this.emailVerifiedAt),
      username: this.username,
      locale: this.locale,
      status: this.status,
      kycStatus: this.kycStatus,
      hasPassword: Boolean(this.passwordHash),
      lastPanelRole: this.lastPanelRole,
      roles,
      permissions,
      createdAt: this.createdAt,
    };
  }
}
User.init(
  {
    id: uuidPk,
    phone: { type: DataTypes.STRING(16), allowNull: true, unique: true },
    phoneVerifiedAt: DataTypes.DATE(3),
    email: { type: DataTypes.STRING(191), allowNull: true, unique: true },
    emailVerifiedAt: DataTypes.DATE(3),
    username: { type: DataTypes.STRING(30), allowNull: true, unique: true },
    passwordHash: DataTypes.STRING(255),
    displayName: { type: DataTypes.STRING(80), allowNull: false },
    legalName: DataTypes.STRING(120),
    dob: DataTypes.DATEONLY,
    nidHash: { type: DataTypes.CHAR(64), unique: true },
    nidLast4: DataTypes.CHAR(4),
    locale: { type: DataTypes.ENUM('en', 'bn'), allowNull: false, defaultValue: 'en' },
    kycStatus: { type: DataTypes.ENUM('unverified', 'pending', 'verified', 'rejected'), allowNull: false, defaultValue: 'unverified' },
    status: { type: DataTypes.ENUM('active', 'suspended', 'banned', 'closed'), allowNull: false, defaultValue: 'active' },
    authzVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    lastPanelRole: DataTypes.ENUM(...ROLE_LIST),
    failedLoginCount: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    lockedUntil: DataTypes.DATE(3),
    lastLoginAt: DataTypes.DATE(3),
    closedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'User', tableName: 'users' }
);

class UserRole extends Model {
  toPublic() {
    return {
      role: this.role,
      status: this.status,
      meta: this.meta ?? null,
      appliedAt: this.appliedAt,
      activatedAt: this.activatedAt,
      reasonCode: this.statusReasonCode ?? null,
    };
  }
}
UserRole.init(
  {
    id: uuidPk,
    userId: { type: DataTypes.UUID, allowNull: false },
    role: { type: DataTypes.ENUM(...ROLE_LIST), allowNull: false },
    status: { type: DataTypes.ENUM(...ROLE_STATUSES), allowNull: false, defaultValue: 'applied' },
    meta: DataTypes.JSON,
    attempt: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
    appliedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    activatedAt: DataTypes.DATE(3),
    decidedBy: DataTypes.UUID,
    statusReasonCode: DataTypes.STRING(40),
    statusNote: DataTypes.TEXT,
  },
  { sequelize, modelName: 'UserRole', tableName: 'user_roles' }
);

class Session extends Model {}
Session.init(
  {
    id: uuidPk,
    userId: { type: DataTypes.UUID, allowNull: false },
    familyId: { type: DataTypes.UUID, allowNull: false },
    refreshTokenHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    rotatedFrom: DataTypes.UUID,
    userAgent: DataTypes.STRING(512),
    ip: DataTypes.STRING(45),
    deviceLabel: DataTypes.STRING(80),
    twoFactorAt: DataTypes.DATE(3),
    audience: { type: DataTypes.ENUM('api', 'admin'), allowNull: false, defaultValue: 'api' },
    lastSeenAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    expiresAt: { type: DataTypes.DATE(3), allowNull: false },
    revokedAt: DataTypes.DATE(3),
    revokeCause: DataTypes.ENUM('logout', 'rotation', 'rotation_reuse', 'permission_change', 'sanction', 'password_change', 'admin', 'idle', 'expired'),
  },
  { sequelize, modelName: 'Session', tableName: 'sessions' }
);

class OtpCode extends Model {}
OtpCode.init(
  {
    id: uuidPk,
    target: { type: DataTypes.STRING(191), allowNull: false },
    purpose: { type: DataTypes.ENUM('signup', 'login', 'reset', 'phone_change_old', 'phone_change_new', 'email_verify', 'payout_account'), allowNull: false },
    codeHash: { type: DataTypes.CHAR(64), allowNull: false },
    expiresAt: { type: DataTypes.DATE(3), allowNull: false },
    attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    consumedAt: DataTypes.DATE(3),
    ip: DataTypes.STRING(45),
  },
  { sequelize, modelName: 'OtpCode', tableName: 'otp_codes', updatedAt: false }
);

class StaffMember extends Model {}
StaffMember.init(
  {
    id: uuidPk,
    userId: { type: DataTypes.UUID, allowNull: false, unique: true },
    employeeId: { type: DataTypes.STRING(32), allowNull: false, unique: true },
    team: DataTypes.STRING(60),
    isMaster: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: { type: DataTypes.ENUM('invited', 'active', 'suspended', 'offboarded'), allowNull: false, defaultValue: 'invited' },
    totpSecretEnc: DataTypes.STRING(255),
    totpEnabledAt: DataTypes.DATE(3),
    totpLastStep: DataTypes.BIGINT,
    invitedBy: DataTypes.UUID,
    invitedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    offboardedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'StaffMember', tableName: 'staff_members' }
);

class StaffPermission extends Model {}
StaffPermission.init(
  {
    id: uuidPk,
    userId: { type: DataTypes.UUID, allowNull: false },
    permission: { type: DataTypes.ENUM(...PERMS), allowNull: false },
    grantedBy: DataTypes.UUID,
    grantedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    revokedAt: DataTypes.DATE(3),
    revokedBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'StaffPermission', tableName: 'staff_permissions' }
);

class UserSanction extends Model {}
UserSanction.init(
  {
    id: uuidPk,
    userId: { type: DataTypes.UUID, allowNull: false },
    kind: { type: DataTypes.ENUM('suspension', 'ban', 'role_suspension'), allowNull: false },
    role: DataTypes.ENUM(...ROLE_LIST),
    reasonCode: { type: DataTypes.STRING(40), allowNull: false },
    note: DataTypes.TEXT,
    startsAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    endsAt: DataTypes.DATE(3),
    createdBy: DataTypes.UUID,
    source: { type: DataTypes.ENUM('admin', 'risk', 'system'), allowNull: false, defaultValue: 'admin' },
    liftedAt: DataTypes.DATE(3),
    liftedBy: DataTypes.UUID,
    liftNote: DataTypes.TEXT,
  },
  { sequelize, modelName: 'UserSanction', tableName: 'user_sanctions' }
);

class StepUpToken extends Model {}
StepUpToken.init(
  {
    jti: { type: DataTypes.UUID, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    sessionId: { type: DataTypes.UUID, allowNull: false },
    scope: { type: DataTypes.STRING(40), allowNull: false },
    expiresAt: { type: DataTypes.DATE(3), allowNull: false },
    usedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'StepUpToken', tableName: 'step_up_tokens', updatedAt: false }
);

const appendOnlyGuard = (table) => {
  const refuse = () => {
    throw new Error(`${table} is append-only`);
  };
  return { beforeUpdate: refuse, beforeBulkUpdate: refuse, beforeDestroy: refuse, beforeBulkDestroy: refuse };
};

// M04 audit log. created_at is the spec's occurred_at; meta is its metadata. Append-only (DB triggers).
class AuditLog extends Model {}
AuditLog.init(
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    actorType: { type: DataTypes.ENUM('user', 'staff', 'master', 'system', 'provider'), allowNull: false, defaultValue: 'system' },
    actorId: DataTypes.UUID,
    actorRole: DataTypes.STRING(32),
    action: { type: DataTypes.STRING(80), allowNull: false },
    module: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'M01' },
    entityType: DataTypes.STRING(40),
    entityId: DataTypes.STRING(64),
    entityCode: DataTypes.STRING(40),
    before: DataTypes.JSON,
    after: DataTypes.JSON,
    reason: DataTypes.TEXT,
    severity: { type: DataTypes.ENUM('info', 'notice', 'critical'), allowNull: false, defaultValue: 'info' },
    stepUp: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    meta: DataTypes.JSON,
    ip: DataTypes.STRING(45),
    userAgent: DataTypes.STRING(512),
    requestId: DataTypes.STRING(64),
    sessionId: DataTypes.UUID,
    // Millisecond precision in WHERE clauses too (date range filters).
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'AuditLog', tableName: 'audit_logs', updatedAt: false, hooks: appendOnlyGuard('audit_logs') }
);

// M04-FR-05 hash chain over audit_logs, sealed after commit by the audit.chain-seal job.
class AuditChain extends Model {}
AuditChain.init(
  {
    seq: { type: DataTypes.BIGINT, primaryKey: true },
    auditLogId: { type: DataTypes.BIGINT, allowNull: false },
    prevHash: DataTypes.CHAR(64),
    rowHash: { type: DataTypes.CHAR(64), allowNull: false },
    sealedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, modelName: 'AuditChain', tableName: 'audit_chain', timestamps: false, hooks: appendOnlyGuard('audit_chain') }
);

// M04-FR-10 audit exports (CSV in the private bucket).
class AuditExport extends Model {}
AuditExport.init(
  {
    id: uuidPk,
    requestedBy: { type: DataTypes.UUID, allowNull: false },
    filters: { type: DataTypes.JSON, allowNull: false },
    status: { type: DataTypes.ENUM('queued', 'running', 'ready', 'failed', 'expired'), allowNull: false, defaultValue: 'queued' },
    rowCount: DataTypes.INTEGER,
    objectKey: DataTypes.STRING(255),
    error: DataTypes.TEXT,
    completedAt: DataTypes.DATE(3),
    expiresAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'AuditExport', tableName: 'audit_exports' }
);

// M04 transactional outbox and shared inbox.
class OutboxEvent extends Model {}
OutboxEvent.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    name: { type: DataTypes.STRING(80), allowNull: false },
    version: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
    aggregateType: { type: DataTypes.STRING(40), allowNull: false },
    aggregateId: { type: DataTypes.STRING(64), allowNull: false },
    aggregateVersion: DataTypes.INTEGER,
    payload: { type: DataTypes.JSON, allowNull: false },
    metadata: DataTypes.JSON,
    // Left to the DB default (CURRENT_TIMESTAMP(3)), so times come from DB now(), not app time (M04 §12).
    occurredAt: DataTypes.DATE(3),
    availableAt: DataTypes.DATE(3),
    status: { type: DataTypes.ENUM('pending', 'published', 'failed'), allowNull: false, defaultValue: 'pending' },
    publishedAt: DataTypes.DATE(3),
    attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    lastError: DataTypes.TEXT,
  },
  { sequelize, modelName: 'OutboxEvent', tableName: 'outbox_events', timestamps: false }
);

class ConsumedEvent extends Model {}
ConsumedEvent.init(
  {
    consumer: { type: DataTypes.STRING(80), primaryKey: true },
    eventId: { type: DataTypes.UUID, primaryKey: true },
    eventName: { type: DataTypes.STRING(80), allowNull: false },
    status: { type: DataTypes.ENUM('processed', 'dead'), allowNull: false },
    attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
    lastError: DataTypes.TEXT,
    processedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, modelName: 'ConsumedEvent', tableName: 'consumed_events', timestamps: false }
);

class OAuthIdentity extends Model {
  toPublic() {
    return { provider: this.provider, email: this.email, linkedAt: this.createdAt, lastUsedAt: this.lastUsedAt };
  }
}
OAuthIdentity.init(
  {
    id: uuidPk,
    userId: { type: DataTypes.UUID, allowNull: false },
    provider: { type: DataTypes.ENUM('google'), allowNull: false },
    providerUserId: { type: DataTypes.STRING(191), allowNull: false },
    email: DataTypes.STRING(191),
    emailVerified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    displayName: DataTypes.STRING(120),
    pictureUrl: DataTypes.STRING(512),
    lastUsedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'OAuthIdentity', tableName: 'oauth_identities' }
);

// ---- M03 settings engine ----
class PlatformSetting extends Model {}
PlatformSetting.init(
  {
    key: { type: DataTypes.STRING(80), primaryKey: true },
    category: { type: DataTypes.STRING(30), allowNull: false },
    value: { type: DataTypes.JSON, allowNull: false },
    valueType: { type: DataTypes.ENUM('int', 'decimal', 'money', 'bool', 'enum', 'time', 'json', 'int_list', 'string_list'), allowNull: false },
    unit: DataTypes.STRING(12),
    minValue: DataTypes.DECIMAL(18, 2),
    maxValue: DataTypes.DECIMAL(18, 2),
    enumOptions: DataTypes.JSON,
    approval: { type: DataTypes.ENUM('single', 'four_eyes'), allowNull: false, defaultValue: 'single' },
    isPublic: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    labelEn: { type: DataTypes.STRING(160), allowNull: false },
    labelBn: { type: DataTypes.STRING(160), allowNull: false },
    whyEn: DataTypes.TEXT,
    whyBn: DataTypes.TEXT,
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    updatedBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'PlatformSetting', tableName: 'platform_settings' }
);

class SettingsHistory extends Model {}
SettingsHistory.init(
  {
    id: uuidPk,
    key: { type: DataTypes.STRING(80), allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    oldValue: DataTypes.JSON,
    newValue: { type: DataTypes.JSON, allowNull: false },
    effectiveAt: { type: DataTypes.DATE(3), allowNull: false },
    requestId: DataTypes.UUID,
    changedBy: DataTypes.UUID,
    approvedBy: DataTypes.UUID,
    reason: DataTypes.TEXT,
  },
  {
    sequelize,
    modelName: 'SettingsHistory',
    tableName: 'settings_history',
    updatedAt: false,
    // M03-FR-11: the DB triggers reject UPDATE/DELETE; the model refuses before reaching them.
    hooks: appendOnlyGuard('settings_history'),
  }
);

class SettingsChangeRequest extends Model {}
SettingsChangeRequest.init(
  {
    id: uuidPk,
    status: { type: DataTypes.ENUM('proposed', 'approved', 'applied', 'rejected', 'withdrawn', 'superseded'), allowNull: false, defaultValue: 'proposed' },
    source: { type: DataTypes.ENUM('fees_screen', 'simulator', 'risk_desk', 'api'), allowNull: false, defaultValue: 'fees_screen' },
    changes: { type: DataTypes.JSON, allowNull: false },
    projection: DataTypes.JSON,
    reason: { type: DataTypes.TEXT, allowNull: false },
    effectiveAt: { type: DataTypes.DATE(3), allowNull: false },
    needsFourEyes: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    proposedBy: { type: DataTypes.UUID, allowNull: false },
    approvedBy: DataTypes.UUID,
    decidedBy: DataTypes.UUID,
    decidedAt: DataTypes.DATE(3),
    decisionNote: DataTypes.TEXT,
    appliedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'SettingsChangeRequest', tableName: 'settings_change_requests' }
);

// ---- M03 esports catalogue ----
const catalogBase = () => ({
  id: uuidPk,
  key: { type: DataTypes.STRING(40), allowNull: false },
  nameEn: { type: DataTypes.STRING(80), allowNull: false },
  nameBn: { type: DataTypes.STRING(80), allowNull: false },
  sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  createdBy: DataTypes.UUID,
  updatedBy: DataTypes.UUID,
});

class EsportsGame extends Model {}
EsportsGame.init(
  {
    ...catalogBase(),
    publisher: DataTypes.STRING(80),
    platform: { type: DataTypes.ENUM('mobile', 'pc', 'console'), allowNull: false, defaultValue: 'mobile' },
    uidLabelEn: { type: DataTypes.STRING(40), allowNull: false },
    uidLabelBn: { type: DataTypes.STRING(40), allowNull: false },
    uidRegex: { type: DataTypes.STRING(120), allowNull: false },
    ignMaxLen: { type: DataTypes.SMALLINT, allowNull: false },
    icon: DataTypes.STRING(255),
  },
  { sequelize, modelName: 'EsportsGame', tableName: 'esports_games' }
);

class EsportsMode extends Model {}
EsportsMode.init(
  {
    ...catalogBase(),
    gameId: { type: DataTypes.UUID, allowNull: false },
    teamSize: { type: DataTypes.SMALLINT, allowNull: false },
    maxTeams: { type: DataTypes.SMALLINT, allowNull: false },
    maxPlayers: { type: DataTypes.SMALLINT, allowNull: false },
    maxSubs: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
  },
  { sequelize, modelName: 'EsportsMode', tableName: 'esports_modes' }
);

class EsportsMap extends Model {}
EsportsMap.init({ ...catalogBase(), gameId: { type: DataTypes.UUID, allowNull: false } }, { sequelize, modelName: 'EsportsMap', tableName: 'esports_maps' });

class EsportsPointsPreset extends Model {}
EsportsPointsPreset.init(
  {
    ...catalogBase(),
    gameId: { type: DataTypes.UUID, allowNull: false },
    placementPoints: { type: DataTypes.JSON, allowNull: false },
    killPoints: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  },
  { sequelize, modelName: 'EsportsPointsPreset', tableName: 'esports_points_presets' }
);

// ---- M08 notifications ----
const CHANNELS = ['in_app', 'sms', 'email', 'push'];

class Notification extends Model {}
Notification.init(
  {
    // UUIDv7: time-ordered, so the bell's (created_at, id) cursor is stable within one millisecond.
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    userId: { type: DataTypes.UUID, allowNull: false },
    code: { type: DataTypes.STRING(60), allowNull: false },
    category: { type: DataTypes.STRING(30), allowNull: false },
    roleContext: DataTypes.STRING(20),
    title: { type: DataTypes.STRING(140), allowNull: false },
    body: { type: DataTypes.STRING(500), allowNull: false },
    link: DataTypes.STRING(300),
    data: DataTypes.JSON,
    locale: { type: DataTypes.ENUM('en', 'bn'), allowNull: false, defaultValue: 'en' },
    templateVersion: { type: DataTypes.INTEGER, allowNull: false },
    sourceEventId: DataTypes.UUID,
    dedupeKey: { type: DataTypes.STRING(200), allowNull: false, unique: true },
    readAt: DataTypes.DATE(3),
    archivedAt: DataTypes.DATE(3),
    // Millisecond precision in WHERE clauses too (mark-all-read "before", cursors).
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'Notification', tableName: 'notifications', updatedAt: false }
);

class NotificationPref extends Model {}
NotificationPref.init(
  {
    userId: { type: DataTypes.UUID, primaryKey: true },
    category: { type: DataTypes.STRING(30), primaryKey: true },
    channel: { type: DataTypes.ENUM(...CHANNELS), primaryKey: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false },
  },
  { sequelize, modelName: 'NotificationPref', tableName: 'notification_prefs', createdAt: false }
);

class MessageTemplate extends Model {}
MessageTemplate.init(
  {
    id: uuidPk,
    code: { type: DataTypes.STRING(60), allowNull: false },
    channel: { type: DataTypes.ENUM(...CHANNELS), allowNull: false },
    locale: { type: DataTypes.ENUM('en', 'bn'), allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    subject: DataTypes.STRING(160),
    body: { type: DataTypes.TEXT, allowNull: false },
    variables: { type: DataTypes.JSON, allowNull: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    maxSmsSegments: DataTypes.SMALLINT,
    createdBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'MessageTemplate', tableName: 'message_templates', updatedAt: false }
);

class NotificationDelivery extends Model {}
NotificationDelivery.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    notificationId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    channel: { type: DataTypes.ENUM(...CHANNELS), allowNull: false },
    status: { type: DataTypes.ENUM('queued', 'deferred', 'sent', 'delivered', 'failed', 'rate_limited', 'suppressed'), allowNull: false, defaultValue: 'queued' },
    deliverAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    provider: DataTypes.STRING(20),
    providerMessageId: DataTypes.STRING(120),
    errorCode: DataTypes.STRING(60),
    sentAt: DataTypes.DATE(3),
    deliveredAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'NotificationDelivery', tableName: 'notification_deliveries' }
);

class SmsLog extends Model {}
SmsLog.init(
  {
    id: uuidPk,
    deliveryId: DataTypes.UUID,
    route: { type: DataTypes.ENUM('otp', 'trans'), allowNull: false },
    toPhoneHash: { type: DataTypes.CHAR(64), allowNull: false },
    toPhoneMasked: { type: DataTypes.STRING(20), allowNull: false },
    gateway: { type: DataTypes.STRING(20), allowNull: false },
    encoding: { type: DataTypes.ENUM('gsm7', 'ucs2'), allowNull: false },
    segments: { type: DataTypes.SMALLINT, allowNull: false },
    bodyRedacted: { type: DataTypes.TEXT, allowNull: false },
    gatewayMessageId: DataTypes.STRING(120),
    status: { type: DataTypes.STRING(12), allowNull: false },
    dlrStatus: DataTypes.STRING(20),
    costPoisha: DataTypes.INTEGER,
    requestedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    dlrAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'SmsLog', tableName: 'sms_log', timestamps: false }
);

// ---- M06 payments, ledger and escrow ----
// BIGINT columns come back from pg as strings; money getters return checked numbers.
const poisha = (field, extra = {}) => ({
  type: DataTypes.BIGINT,
  allowNull: false,
  defaultValue: 0,
  ...extra,
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? v : toPoisha(v);
  },
});
const PROVIDERS = ['sslcommerz', 'bkash', 'nagad'];
const METHODS = ['bkash', 'nagad', 'card', 'other'];

class IdSequence extends Model {}
IdSequence.init(
  { name: { type: DataTypes.STRING(40), primaryKey: true }, next: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 } },
  { sequelize, modelName: 'IdSequence', tableName: 'id_sequences', timestamps: false }
);

class IdempotencyKey extends Model {}
IdempotencyKey.init(
  {
    scope: { type: DataTypes.STRING(60), primaryKey: true },
    userId: { type: DataTypes.UUID, primaryKey: true },
    key: { type: DataTypes.STRING(80), primaryKey: true },
    requestHash: { type: DataTypes.CHAR(64), allowNull: false },
    statusCode: DataTypes.SMALLINT,
    response: DataTypes.JSON,
    createdAt: DataTypes.DATE(3),
    expiresAt: { type: DataTypes.DATE(3), allowNull: false },
  },
  { sequelize, modelName: 'IdempotencyKey', tableName: 'idempotency_keys', updatedAt: false }
);

class Payment extends Model {}
Payment.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    code: { type: DataTypes.STRING(20), allowNull: false },
    purpose: { type: DataTypes.STRING(30), allowNull: false },
    purposeId: { type: DataTypes.UUID, allowNull: false },
    splitGroupId: DataTypes.UUID,
    payerId: { type: DataTypes.UUID, allowNull: false },
    payeeHintId: DataTypes.UUID,
    amountPoisha: poisha('amountPoisha', { defaultValue: undefined }),
    capturedPoisha: poisha('capturedPoisha'),
    refundedPoisha: poisha('refundedPoisha'),
    status: {
      type: DataTypes.ENUM('initiated', 'pending', 'succeeded', 'failed', 'cancelled', 'expired', 'partially_refunded', 'refunded'),
      allowNull: false,
      defaultValue: 'initiated',
    },
    provider: DataTypes.ENUM(...PROVIDERS),
    method: DataTypes.ENUM(...METHODS),
    methodDisplay: DataTypes.STRING(40),
    providerTrxId: DataTypes.STRING(80),
    title: { type: DataTypes.STRING(120), allowNull: false },
    escrow: { type: DataTypes.JSON, allowNull: false },
    expiresAt: { type: DataTypes.DATE(3), allowNull: false },
    idempotencyKey: { type: DataTypes.STRING(120), allowNull: false },
    succeededAt: DataTypes.DATE(3),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'Payment', tableName: 'payments' }
);

class PaymentAttempt extends Model {}
PaymentAttempt.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    paymentId: { type: DataTypes.UUID, allowNull: false },
    provider: { type: DataTypes.ENUM(...PROVIDERS), allowNull: false },
    method: DataTypes.ENUM(...METHODS),
    providerSessionId: DataTypes.STRING(120),
    status: { type: DataTypes.ENUM('in_flight', 'succeeded', 'failed', 'cancelled', 'unknown'), allowNull: false, defaultValue: 'in_flight' },
    request: DataTypes.JSON,
    response: DataTypes.JSON,
    failureCode: DataTypes.STRING(60),
    startedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    finishedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'PaymentAttempt', tableName: 'payment_attempts', timestamps: false }
);

class ProviderWebhookEvent extends Model {}
ProviderWebhookEvent.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    provider: { type: DataTypes.ENUM(...PROVIDERS), allowNull: false },
    providerEventId: { type: DataTypes.STRING(120), allowNull: false },
    paymentId: DataTypes.UUID,
    signatureOk: { type: DataTypes.BOOLEAN, allowNull: false },
    raw: { type: DataTypes.JSON, allowNull: false },
    receivedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    processedAt: DataTypes.DATE(3),
    result: DataTypes.STRING(30),
  },
  { sequelize, modelName: 'ProviderWebhookEvent', tableName: 'provider_webhook_events', timestamps: false }
);

class Refund extends Model {}
Refund.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    paymentId: { type: DataTypes.UUID, allowNull: false },
    escrowHoldId: DataTypes.UUID,
    amountPoisha: poisha('amountPoisha', { defaultValue: undefined }),
    reasonCode: { type: DataTypes.STRING(40), allowNull: false },
    reasonText: DataTypes.STRING(500),
    kind: { type: DataTypes.ENUM('policy', 'manual', 'dispute', 'late_capture', 'amount_mismatch', 'goodwill'), allowNull: false },
    source: { type: DataTypes.ENUM('escrow', 'goodwill', 'suspense'), allowNull: false, defaultValue: 'escrow' },
    status: {
      type: DataTypes.ENUM('pending_master', 'approved', 'processing', 'succeeded', 'failed', 'manual_required', 'rejected'),
      allowNull: false,
    },
    initiatedBy: DataTypes.UUID,
    initiatorKind: { type: DataTypes.ENUM('system', 'staff', 'master'), allowNull: false },
    recommendedPoisha: poisha('recommendedPoisha', { allowNull: true, defaultValue: null }),
    approvedBy: DataTypes.UUID,
    decisionNote: DataTypes.STRING(500),
    providerRefundId: DataTypes.STRING(120),
    attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    lastError: DataTypes.STRING(120),
    idempotencyKey: { type: DataTypes.STRING(120), allowNull: false },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
    completedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'Refund', tableName: 'refunds' }
);

class LedgerAccount extends Model {}
LedgerAccount.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    code: { type: DataTypes.STRING(120), allowNull: false },
    type: { type: DataTypes.ENUM('asset', 'liability', 'revenue', 'expense', 'equity'), allowNull: false },
    ownerUserId: DataTypes.UUID,
    vertical: DataTypes.STRING(20),
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'LedgerAccount', tableName: 'ledger_accounts', updatedAt: false, hooks: appendOnlyGuard('ledger_accounts') }
);

class LedgerTransaction extends Model {}
LedgerTransaction.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    kind: { type: DataTypes.STRING(40), allowNull: false },
    refType: { type: DataTypes.STRING(30), allowNull: false },
    refId: { type: DataTypes.UUID, allowNull: false },
    idempotencyKey: { type: DataTypes.STRING(160), allowNull: false },
    reversesTxnId: DataTypes.UUID,
    memo: DataTypes.STRING(300),
    totalPoisha: poisha('totalPoisha', { defaultValue: undefined }),
    entryCount: { type: DataTypes.SMALLINT, allowNull: false },
    postedBy: DataTypes.UUID,
    postedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, modelName: 'LedgerTransaction', tableName: 'ledger_transactions', timestamps: false, hooks: appendOnlyGuard('ledger_transactions') }
);

class LedgerEntry extends Model {}
LedgerEntry.init(
  {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    txnId: { type: DataTypes.UUID, allowNull: false },
    accountId: { type: DataTypes.UUID, allowNull: false },
    escrowHoldId: DataTypes.UUID,
    debitPoisha: poisha('debitPoisha'),
    creditPoisha: poisha('creditPoisha'),
  },
  { sequelize, modelName: 'LedgerEntry', tableName: 'ledger_entries', timestamps: false, hooks: appendOnlyGuard('ledger_entries') }
);

class EscrowHold extends Model {}
EscrowHold.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    purpose: { type: DataTypes.STRING(30), allowNull: false },
    purposeId: { type: DataTypes.UUID, allowNull: false },
    paymentId: { type: DataTypes.UUID, allowNull: false },
    splitRef: DataTypes.UUID,
    groupRef: DataTypes.UUID,
    payeeId: DataTypes.UUID,
    vertical: { type: DataTypes.STRING(20), allowNull: false },
    feeBps: { type: DataTypes.INTEGER, allowNull: false },
    feeSettingKey: { type: DataTypes.STRING(80), allowNull: false },
    feeSettingVersion: { type: DataTypes.INTEGER, allowNull: false },
    heldPoisha: poisha('heldPoisha'),
    releasedPoisha: poisha('releasedPoisha'),
    refundedPoisha: poisha('refundedPoisha'),
    feeTakenPoisha: poisha('feeTakenPoisha'),
    releaseRule: { type: DataTypes.JSON, allowNull: false },
    releaseAt: DataTypes.DATE(3),
    releaseCount: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    status: {
      type: DataTypes.ENUM('holding', 'partially_released', 'released', 'refunded', 'frozen', 'closed'),
      allowNull: false,
      defaultValue: 'holding',
    },
    statusBeforeFreeze: DataTypes.STRING(20),
    frozenReason: DataTypes.STRING(40),
    frozenRef: DataTypes.UUID,
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'EscrowHold', tableName: 'escrow_holds' }
);

class ReconciliationRun extends Model {}
ReconciliationRun.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    provider: { type: DataTypes.ENUM(...PROVIDERS), allowNull: false },
    businessDate: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.ENUM('running', 'completed', 'failed'), allowNull: false, defaultValue: 'running' },
    totals: DataTypes.JSON,
    startedBy: DataTypes.UUID,
    error: DataTypes.STRING(300),
    startedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    finishedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'ReconciliationRun', tableName: 'reconciliation_runs', timestamps: false }
);

class ReconciliationItem extends Model {}
ReconciliationItem.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    runId: { type: DataTypes.UUID, allowNull: false },
    type: {
      type: DataTypes.ENUM('matched', 'missing_internal', 'missing_provider', 'amount_mismatch', 'status_mismatch', 'refund_mismatch', 'fee_mismatch'),
      allowNull: false,
    },
    paymentId: DataTypes.UUID,
    refundId: DataTypes.UUID,
    providerRef: DataTypes.STRING(120),
    internalPoisha: poisha('internalPoisha', { allowNull: true, defaultValue: null }),
    providerPoisha: poisha('providerPoisha', { allowNull: true, defaultValue: null }),
    detail: DataTypes.STRING(300),
    resolution: DataTypes.ENUM('auto_healed', 'resolved', 'ignored'),
    resolvedBy: DataTypes.UUID,
    resolvedAt: DataTypes.DATE(3),
    note: DataTypes.STRING(500),
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'ReconciliationItem', tableName: 'reconciliation_items', updatedAt: false }
);

// ---- Associations ----
// ---------------- M07 payouts (§7). Money in poisha; account numbers only encrypted (common/crypto).
class PayoutAccount extends Model {}
PayoutAccount.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    userId: { type: DataTypes.UUID, allowNull: false },
    type: { type: DataTypes.ENUM('bkash', 'nagad'), allowNull: false },
    accountNoEnc: { type: DataTypes.STRING(200), allowNull: false },
    accountNoLast4: { type: DataTypes.CHAR(4), allowNull: false },
    accountNoHash: { type: DataTypes.CHAR(64), allowNull: false },
    accountName: { type: DataTypes.STRING(120), allowNull: false },
    status: { type: DataTypes.ENUM('pending_verification', 'active', 'rejected', 'superseded', 'disabled'), allowNull: false, defaultValue: 'pending_verification' },
    reviewedBy: DataTypes.UUID,
    reviewedAt: DataTypes.DATE(3),
    reviewNote: DataTypes.STRING(300),
    activatedAt: DataTypes.DATE(3),
    holdUntil: DataTypes.DATE(3),
    supersededBy: DataTypes.UUID,
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'PayoutAccount', tableName: 'payout_accounts' }
);

class PayoutBatch extends Model {}
PayoutBatch.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    schedule: { type: DataTypes.ENUM('daily', 'ground_weekly', 'shop_weekly', 'manual', 'refund'), allowNull: false },
    windowEnd: { type: DataTypes.DATE(3), allowNull: false },
    status: { type: DataTypes.ENUM('building', 'ready', 'processing', 'done', 'partially_failed'), allowNull: false, defaultValue: 'building' },
    totals: DataTypes.JSON,
    createdBy: DataTypes.UUID,
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'PayoutBatch', tableName: 'payout_batches' }
);

class Payout extends Model {}
Payout.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    code: { type: DataTypes.STRING(20), allowNull: false },
    batchId: DataTypes.UUID,
    payeeId: { type: DataTypes.UUID, allowNull: false },
    kind: { type: DataTypes.ENUM('earning', 'refund', 'withdrawal'), allowNull: false, defaultValue: 'earning' },
    refundId: DataTypes.UUID,
    payoutAccountId: DataTypes.UUID,
    periodStart: DataTypes.DATE(3),
    periodEnd: DataTypes.DATE(3),
    grossPoisha: poisha('grossPoisha'),
    deductionsPoisha: poisha('deductionsPoisha'),
    nettingPoisha: poisha('nettingPoisha'),
    adjustmentsPoisha: poisha('adjustmentsPoisha'),
    amountPoisha: poisha('amountPoisha', { defaultValue: undefined }),
    status: { type: DataTypes.ENUM('scheduled', 'needs_approval', 'on_hold', 'processing', 'paid', 'failed', 'cancelled'), allowNull: false },
    rulesSnapshot: { type: DataTypes.JSON, allowNull: false },
    channel: DataTypes.ENUM('manual'),
    providerRef: DataTypes.STRING(120),
    attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    failureCode: DataTypes.STRING(60),
    failureNote: DataTypes.STRING(300),
    releasedBy: DataTypes.UUID,
    releasedAt: DataTypes.DATE(3),
    paidBy: DataTypes.UUID,
    paidAt: DataTypes.DATE(3),
    ledgerTxnIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'Payout', tableName: 'payouts' }
);

// Items may be negative (a debit on the payable), so net is a signed BIGINT.
const signedPoisha = (field) => ({
  type: DataTypes.BIGINT,
  allowNull: false,
  get() {
    const v = this.getDataValue(field);
    return v == null ? v : Number(v);
  },
});

class PayoutItem extends Model {}
PayoutItem.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    payoutId: { type: DataTypes.UUID, allowNull: false },
    sourceType: { type: DataTypes.ENUM('escrow_hold', 'pool', 'reversal', 'fee_netting', 'refund'), allowNull: false },
    sourceId: { type: DataTypes.UUID, allowNull: false },
    ledgerEntryId: {
      type: DataTypes.BIGINT,
      get() {
        const v = this.getDataValue('ledgerEntryId');
        return v == null ? null : Number(v);
      },
    },
    grossPoisha: poisha('grossPoisha', { defaultValue: undefined }),
    feePoisha: poisha('feePoisha'),
    netPoisha: signedPoisha('netPoisha'),
    description: { type: DataTypes.STRING(200), allowNull: false },
    status: { type: DataTypes.ENUM('included', 'returned'), allowNull: false, defaultValue: 'included' },
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'PayoutItem', tableName: 'payout_items', updatedAt: false }
);

class PayoutHold extends Model {}
PayoutHold.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    scope: { type: DataTypes.ENUM('payee', 'payout', 'item_source'), allowNull: false },
    payeeId: { type: DataTypes.UUID, allowNull: false },
    payoutId: DataTypes.UUID,
    sourceType: DataTypes.STRING(20),
    sourceId: DataTypes.UUID,
    type: { type: DataTypes.ENUM('account_change', 'risk_freeze', 'dispute', 'kyc', 'account_suspended', 'manual'), allowNull: false },
    reason: DataTypes.STRING(300),
    refId: { type: DataTypes.UUID, allowNull: false },
    until: DataTypes.DATE(3),
    placedBy: DataTypes.UUID,
    placedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    liftedBy: DataTypes.UUID,
    liftedAt: DataTypes.DATE(3),
    liftReason: DataTypes.STRING(300),
  },
  { sequelize, modelName: 'PayoutHold', tableName: 'payout_holds', timestamps: false }
);

class PayoutApproval extends Model {}
PayoutApproval.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    payoutId: { type: DataTypes.UUID, allowNull: false },
    approverId: { type: DataTypes.UUID, allowNull: false },
    step: { type: DataTypes.SMALLINT, allowNull: false },
    approvedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, modelName: 'PayoutApproval', tableName: 'payout_approvals', timestamps: false }
);

class PayoutReveal extends Model {}
PayoutReveal.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    payoutId: { type: DataTypes.UUID, allowNull: false },
    accountId: { type: DataTypes.UUID, allowNull: false },
    staffId: { type: DataTypes.UUID, allowNull: false },
    revealedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, modelName: 'PayoutReveal', tableName: 'payout_reveals', timestamps: false, hooks: appendOnlyGuard('payout_reveals') }
);

// ---------------- M02 KYC (§7). Document fields only encrypted (fields_enc); files in the private bucket.
class DocumentRequirement extends Model {}
DocumentRequirement.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    role: { type: DataTypes.STRING(32), allowNull: false },
    docType: DataTypes.STRING(30),
    derivedKey: DataTypes.STRING(30),
    scope: { type: DataTypes.ENUM('user', 'role', 'hire_role'), allowNull: false, defaultValue: 'user' },
    required: { type: DataTypes.ENUM('always', 'conditional', 'optional'), allowNull: false, defaultValue: 'always' },
    fileSlots: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    fieldSchema: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    labelEn: { type: DataTypes.STRING(120), allowNull: false },
    labelBn: { type: DataTypes.STRING(120), allowNull: false },
    whyEn: DataTypes.STRING(300),
    whyBn: DataTypes.STRING(300),
    sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'DocumentRequirement', tableName: 'document_requirements' }
);

class VerificationDocument extends Model {}
VerificationDocument.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    userId: { type: DataTypes.UUID, allowNull: false },
    docType: { type: DataTypes.ENUM('nid', 'trade_license', 'deed_or_lease', 'tin', 'bin', 'credential', 'police_clearance'), allowNull: false },
    subjectKey: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '' },
    version: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.ENUM('in_review', 'changes_requested', 'approved', 'rejected', 'superseded', 'withdrawn'), allowNull: false },
    isCurrent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    fieldsEnc: { type: DataTypes.TEXT, allowNull: false },
    fieldsPublic: { type: DataTypes.JSON, allowNull: false },
    nidHash: DataTypes.CHAR(64),
    checks: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    decidedBy: DataTypes.UUID,
    decidedAt: DataTypes.DATE(3),
    reasonCode: DataTypes.STRING(40),
    reasonText: DataTypes.STRING(500),
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'VerificationDocument', tableName: 'verification_documents' }
);

class DocumentFile extends Model {}
DocumentFile.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    userId: { type: DataTypes.UUID, allowNull: false },
    documentId: DataTypes.UUID,
    slot: { type: DataTypes.STRING(20), allowNull: false },
    storageKey: { type: DataTypes.STRING(200), allowNull: false },
    mime: { type: DataTypes.ENUM('image/jpeg', 'image/png', 'application/pdf'), allowNull: false },
    sizeBytes: { type: DataTypes.INTEGER, allowNull: false },
    sha256: { type: DataTypes.CHAR(64), allowNull: false },
    scanStatus: { type: DataTypes.ENUM('type_checked', 'clean', 'infected'), allowNull: false, defaultValue: 'type_checked' },
    purgedAt: DataTypes.DATE(3),
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'DocumentFile', tableName: 'document_files', updatedAt: false }
);

// ---------------- M05 moderation (§7).
class RejectionReason extends Model {}
RejectionReason.init(
  {
    code: { type: DataTypes.STRING(40), primaryKey: true },
    labelEn: { type: DataTypes.STRING(120), allowNull: false },
    labelBn: { type: DataTypes.STRING(160), allowNull: false },
    kinds: { type: DataTypes.JSON, allowNull: false },
    requiresText: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'RejectionReason', tableName: 'rejection_reasons', updatedAt: false }
);

class ReviewRubric extends Model {}
ReviewRubric.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    kind: { type: DataTypes.STRING(30), allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    items: { type: DataTypes.JSON, allowNull: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdBy: DataTypes.UUID,
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'ReviewRubric', tableName: 'review_rubrics', updatedAt: false }
);

class Submission extends Model {}
Submission.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    kind: { type: DataTypes.STRING(30), allowNull: false },
    subjectId: { type: DataTypes.UUID, allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    previousSubmissionId: DataTypes.UUID,
    isEdit: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    mode: { type: DataTypes.ENUM('pre', 'post'), allowNull: false, defaultValue: 'pre' },
    payload: { type: DataTypes.JSON, allowNull: false },
    title: { type: DataTypes.STRING(200), allowNull: false },
    submittedBy: { type: DataTypes.UUID, allowNull: false },
    submittedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    status: { type: DataTypes.ENUM('pending_review', 'changes_requested', 'approved', 'rejected', 'withdrawn', 'superseded'), allowNull: false, defaultValue: 'pending_review' },
    slaDueAt: { type: DataTypes.DATE(3), allowNull: false },
    breachNotifiedAt: DataTypes.DATE(3),
    rubricId: DataTypes.UUID,
    rubricResult: DataTypes.JSON,
    decidedBy: DataTypes.UUID,
    decidedAt: DataTypes.DATE(3),
    reasonCode: DataTypes.STRING(40),
    reasonText: DataTypes.STRING(500),
    checkOverrideBy: DataTypes.UUID,
    checkOverrideReason: DataTypes.STRING(500),
    appliedAt: DataTypes.DATE(3),
    applyAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'Submission', tableName: 'submissions' }
);

class SubmissionCheck extends Model {}
SubmissionCheck.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    submissionId: { type: DataTypes.UUID, allowNull: false },
    runNo: { type: DataTypes.INTEGER, allowNull: false },
    key: { type: DataTypes.STRING(60), allowNull: false },
    severity: { type: DataTypes.ENUM('hard', 'soft'), allowNull: false },
    result: { type: DataTypes.ENUM('pass', 'warn', 'fail', 'pending', 'not_computed'), allowNull: false },
    detail: DataTypes.STRING(300),
    computedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, modelName: 'SubmissionCheck', tableName: 'submission_checks', timestamps: false }
);

class ReviewClaim extends Model {}
ReviewClaim.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    submissionId: { type: DataTypes.UUID, allowNull: false },
    staffId: { type: DataTypes.UUID, allowNull: false },
    claimedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    expiresAt: { type: DataTypes.DATE(3), allowNull: false },
    hardExpiresAt: { type: DataTypes.DATE(3), allowNull: false },
    ticks: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    releasedAt: DataTypes.DATE(3),
    releasedReason: DataTypes.ENUM('manual', 'decided', 'ttl', 'superseded', 'permission', 'force', 'withdrawn'),
  },
  { sequelize, modelName: 'ReviewClaim', tableName: 'review_claims', timestamps: false }
);

User.hasMany(UserRole, { as: 'roles', foreignKey: 'userId' });
UserRole.belongsTo(User, { as: 'user', foreignKey: 'userId' });
User.hasMany(Session, { as: 'sessions', foreignKey: 'userId' });
Session.belongsTo(User, { as: 'user', foreignKey: 'userId' });
User.hasOne(StaffMember, { as: 'staff', foreignKey: 'userId' });
StaffMember.belongsTo(User, { as: 'user', foreignKey: 'userId' });
User.hasMany(StaffPermission, { as: 'staffPermissions', foreignKey: 'userId' });
User.hasMany(UserSanction, { as: 'sanctions', foreignKey: 'userId' });
User.hasMany(OAuthIdentity, { as: 'identities', foreignKey: 'userId' });
OAuthIdentity.belongsTo(User, { as: 'user', foreignKey: 'userId' });
NotificationDelivery.belongsTo(Notification, { as: 'notification', foreignKey: 'notificationId' });
Notification.hasMany(NotificationDelivery, { as: 'deliveries', foreignKey: 'notificationId' });
for (const Child of [EsportsMode, EsportsMap, EsportsPointsPreset]) {
  Child.belongsTo(EsportsGame, { as: 'game', foreignKey: 'gameId' });
}
EsportsGame.hasMany(EsportsMode, { as: 'modes', foreignKey: 'gameId' });
EsportsGame.hasMany(EsportsMap, { as: 'maps', foreignKey: 'gameId' });
EsportsGame.hasMany(EsportsPointsPreset, { as: 'presets', foreignKey: 'gameId' });
Payment.hasMany(PaymentAttempt, { as: 'attempts', foreignKey: 'paymentId' });
PaymentAttempt.belongsTo(Payment, { as: 'payment', foreignKey: 'paymentId' });
Payment.hasMany(Refund, { as: 'refunds', foreignKey: 'paymentId' });
Refund.belongsTo(Payment, { as: 'payment', foreignKey: 'paymentId' });
Payment.hasOne(EscrowHold, { as: 'hold', foreignKey: 'paymentId' });
EscrowHold.belongsTo(Payment, { as: 'payment', foreignKey: 'paymentId' });
LedgerTransaction.hasMany(LedgerEntry, { as: 'entries', foreignKey: 'txnId', constraints: false });
LedgerEntry.belongsTo(LedgerTransaction, { as: 'txn', foreignKey: 'txnId', constraints: false });
LedgerEntry.belongsTo(LedgerAccount, { as: 'account', foreignKey: 'accountId' });
ReconciliationRun.hasMany(ReconciliationItem, { as: 'items', foreignKey: 'runId' });
Payout.hasMany(PayoutItem, { as: 'items', foreignKey: 'payoutId' });
PayoutItem.belongsTo(Payout, { as: 'payout', foreignKey: 'payoutId' });
Payout.hasMany(PayoutApproval, { as: 'approvals', foreignKey: 'payoutId' });
Payout.belongsTo(PayoutAccount, { as: 'account', foreignKey: 'payoutAccountId' });
Payout.belongsTo(PayoutBatch, { as: 'batch', foreignKey: 'batchId' });
PayoutBatch.hasMany(Payout, { as: 'payouts', foreignKey: 'batchId' });
VerificationDocument.hasMany(DocumentFile, { as: 'files', foreignKey: 'documentId' });
DocumentFile.belongsTo(VerificationDocument, { as: 'document', foreignKey: 'documentId' });
Submission.hasMany(SubmissionCheck, { as: 'checks', foreignKey: 'submissionId' });
Submission.hasMany(ReviewClaim, { as: 'claims', foreignKey: 'submissionId' });
Submission.belongsTo(ReviewRubric, { as: 'rubric', foreignKey: 'rubricId' });

// ---- M03 places and sports catalogues (models in ./places.js) ----
const places = require('./places');

// ---- M03 item catalogue (models in ./items.js) ----
const items = require('./items');

// ---- M09 grounds (models in ./grounds.js) ----
const grounds = require('./grounds');
grounds.Ground.belongsTo(places.Area, { as: 'area', foreignKey: 'areaId' });
grounds.Ground.belongsTo(User, { as: 'owner', foreignKey: 'ownerId' });
grounds.Court.belongsTo(places.Surface, { as: 'surface', foreignKey: 'surfaceId' });

// ---- M10 bookings (models in ./bookings.js) ----
const bookings = require('./bookings');
bookings.Booking.belongsTo(grounds.Ground, { as: 'ground', foreignKey: 'groundId' });
bookings.Booking.belongsTo(User, { as: 'booker', foreignKey: 'bookerUserId' });
bookings.Booking.belongsTo(grounds.BookingSeries, { as: 'series', foreignKey: 'seriesId' });
grounds.BookingSeries.hasMany(bookings.Booking, { as: 'bookings', foreignKey: 'seriesId' });

// ---- M19 analytics read models (./analytics.js) ----
const analytics = require('./analytics');

// ---- M17 disputes, reports and reviews (./trust.js) ----
const trust = require('./trust');

// ---- M18 risk and trust, M02 document requests (./risk.js) ----
const risk = require('./risk');

// ---- M12 market catalogue, step 1 (./market.js) ----
const market = require('./market');
market.Shop.belongsTo(places.Area, { as: 'area', foreignKey: 'areaId' });
market.Product.belongsTo(items.ItemType, { as: 'itemType', foreignKey: 'itemTypeId' });

// ---- M03 hire taxonomy and M11 hire, step 1 (./hire.js) ----
const hire = require('./hire');

// ---- M20 gym, step 1 (./gym.js) ----
const gym = require('./gym');

// ---- M14 lite organisations and M22 organiser SaaS (./organisations.js) ----
const organisations = require('./organisations');

// ---- M23 esports big events, step 1 (./esports-events.js) ----
const esportsEvents = require('./esports-events');

// ---- M13 orders, step 1 (./orders.js) ----
const orders = require('./orders');

// ---- M21 esports (models in ./esports.js) ----
const esports = require('./esports');
esports.EsportsTournament.belongsTo(EsportsGame, { as: 'game', foreignKey: 'gameId' });
esports.EsportsTournament.belongsTo(EsportsMode, { as: 'mode', foreignKey: 'modeId' });
esports.EsportsMatch.belongsTo(EsportsMap, { as: 'map', foreignKey: 'mapId' });
esports.EsportsGameProfile.belongsTo(EsportsGame, { as: 'game', foreignKey: 'gameId' });
esports.EsportsGameProfile.belongsTo(User, { as: 'user', foreignKey: 'userId' });

module.exports = {
  ...esports,
  ...places,
  ...items,
  ...market,
  ...orders,
  ...hire,
  ...gym,
  ...organisations,
  ...esportsEvents,
  ...grounds,
  ...bookings,
  ...analytics,
  ...trust,
  ...risk,
  sequelize,
  User,
  UserRole,
  Session,
  OtpCode,
  StaffMember,
  StaffPermission,
  UserSanction,
  StepUpToken,
  AuditLog,
  AuditChain,
  AuditExport,
  OutboxEvent,
  ConsumedEvent,
  OAuthIdentity,
  Notification,
  NotificationPref,
  MessageTemplate,
  NotificationDelivery,
  SmsLog,
  PlatformSetting,
  SettingsHistory,
  SettingsChangeRequest,
  EsportsGame,
  EsportsMode,
  EsportsMap,
  EsportsPointsPreset,
  IdSequence,
  IdempotencyKey,
  Payment,
  PaymentAttempt,
  ProviderWebhookEvent,
  Refund,
  LedgerAccount,
  LedgerTransaction,
  LedgerEntry,
  EscrowHold,
  ReconciliationRun,
  ReconciliationItem,
  PayoutAccount,
  PayoutBatch,
  Payout,
  PayoutItem,
  PayoutHold,
  PayoutApproval,
  PayoutReveal,
  DocumentRequirement,
  VerificationDocument,
  DocumentFile,
  RejectionReason,
  ReviewRubric,
  Submission,
  SubmissionCheck,
  ReviewClaim,
};
