'use strict';

const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { ROLE_LIST } = require('../common/enums');

const ROLE_STATUSES = ['applied', 'documents_pending', 'in_review', 'changes_requested', 'active', 'rejected', 'suspended', 'withdrawn'];
const PERMS = ['approve_listings', 'approve_documents', 'resolve_reports', 'refund_small', 'view_payouts', 'release_payouts', 'edit_fees', 'manage_staff', 'manage_users', 'manage_catalog', 'manage_esports'];

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
    authzVersion: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    lastPanelRole: DataTypes.ENUM(...ROLE_LIST),
    failedLoginCount: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
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
    attempt: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
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
    purpose: { type: DataTypes.ENUM('signup', 'login', 'reset', 'phone_change_old', 'phone_change_new', 'email_verify'), allowNull: false },
    codeHash: { type: DataTypes.CHAR(64), allowNull: false },
    expiresAt: { type: DataTypes.DATE(3), allowNull: false },
    attempts: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
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
    id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
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
  },
  { sequelize, modelName: 'AuditLog', tableName: 'audit_logs', updatedAt: false, hooks: appendOnlyGuard('audit_logs') }
);

// M04-FR-05 hash chain over audit_logs, sealed after commit by the audit.chain-seal job.
class AuditChain extends Model {}
AuditChain.init(
  {
    seq: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    auditLogId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
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
    rowCount: DataTypes.INTEGER.UNSIGNED,
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
    version: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
    aggregateType: { type: DataTypes.STRING(40), allowNull: false },
    aggregateId: { type: DataTypes.STRING(64), allowNull: false },
    aggregateVersion: DataTypes.INTEGER.UNSIGNED,
    payload: { type: DataTypes.JSON, allowNull: false },
    metadata: DataTypes.JSON,
    // Left to the DB default (CURRENT_TIMESTAMP(3)), so times come from DB now(), not app time (M04 §12).
    occurredAt: DataTypes.DATE(3),
    availableAt: DataTypes.DATE(3),
    status: { type: DataTypes.ENUM('pending', 'published', 'failed'), allowNull: false, defaultValue: 'pending' },
    publishedAt: DataTypes.DATE(3),
    attempts: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
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
    attempts: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
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
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    updatedBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'PlatformSetting', tableName: 'platform_settings' }
);

class SettingsHistory extends Model {}
SettingsHistory.init(
  {
    id: uuidPk,
    key: { type: DataTypes.STRING(80), allowNull: false },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
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
    ignMaxLen: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    icon: DataTypes.STRING(255),
  },
  { sequelize, modelName: 'EsportsGame', tableName: 'esports_games' }
);

class EsportsMode extends Model {}
EsportsMode.init(
  {
    ...catalogBase(),
    gameId: { type: DataTypes.UUID, allowNull: false },
    teamSize: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    maxTeams: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    maxPlayers: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
    maxSubs: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
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
    killPoints: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
  },
  { sequelize, modelName: 'EsportsPointsPreset', tableName: 'esports_points_presets' }
);

// ---- Associations ----
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
for (const Child of [EsportsMode, EsportsMap, EsportsPointsPreset]) {
  Child.belongsTo(EsportsGame, { as: 'game', foreignKey: 'gameId' });
}
EsportsGame.hasMany(EsportsMode, { as: 'modes', foreignKey: 'gameId' });
EsportsGame.hasMany(EsportsMap, { as: 'maps', foreignKey: 'gameId' });
EsportsGame.hasMany(EsportsPointsPreset, { as: 'presets', foreignKey: 'gameId' });

module.exports = {
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
  PlatformSetting,
  SettingsHistory,
  SettingsChangeRequest,
  EsportsGame,
  EsportsMode,
  EsportsMap,
  EsportsPointsPreset,
};
