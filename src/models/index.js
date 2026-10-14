'use strict';

const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { ROLE_LIST } = require('../common/enums');

const ROLE_STATUSES = ['applied', 'documents_pending', 'in_review', 'changes_requested', 'active', 'rejected', 'suspended', 'withdrawn'];
const PERMS = ['approve_listings', 'approve_documents', 'resolve_reports', 'refund_small', 'view_payouts', 'release_payouts', 'edit_fees', 'manage_staff', 'manage_users', 'manage_catalog'];

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

class AuditLog extends Model {}
AuditLog.init(
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
    actorId: DataTypes.UUID,
    actorRole: DataTypes.STRING(32),
    action: { type: DataTypes.STRING(80), allowNull: false },
    entityType: DataTypes.STRING(40),
    entityId: DataTypes.STRING(64),
    before: DataTypes.JSON,
    after: DataTypes.JSON,
    meta: DataTypes.JSON,
    ip: DataTypes.STRING(45),
    userAgent: DataTypes.STRING(512),
    requestId: DataTypes.STRING(64),
  },
  { sequelize, modelName: 'AuditLog', tableName: 'audit_logs', updatedAt: false }
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

module.exports = { sequelize, User, UserRole, Session, OtpCode, StaffMember, StaffPermission, UserSanction, StepUpToken, AuditLog, OAuthIdentity };
