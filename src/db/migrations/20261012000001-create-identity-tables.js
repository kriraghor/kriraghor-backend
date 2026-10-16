'use strict';

const ROLES = ['member', 'player', 'pro', 'ground_owner', 'shop_owner', 'organiser', 'gym_owner', 'staff', 'master_admin'];
const ROLE_STATUS = ['applied', 'documents_pending', 'in_review', 'changes_requested', 'active', 'rejected', 'suspended', 'withdrawn'];
const PERMS = ['approve_listings', 'approve_documents', 'resolve_reports', 'refund_small', 'view_payouts', 'release_payouts', 'edit_fees', 'manage_staff', 'manage_users', 'manage_catalog'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.UUID, allowNull: false };

    // Comprehensive Idempotency: Drop all possible existing check constraints to prevent collisions
    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS users DROP CONSTRAINT IF EXISTS ck_users_locale;');
    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS users DROP CONSTRAINT IF EXISTS ck_users_kyc_status;');
    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS users DROP CONSTRAINT IF EXISTS ck_users_status;');
    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS users DROP CONSTRAINT IF EXISTS ck_users_last_panel_role;');
    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS users DROP CONSTRAINT IF EXISTS chk_users_identifier;');

    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS user_roles DROP CONSTRAINT IF EXISTS ck_user_roles_role;');
    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS user_roles DROP CONSTRAINT IF EXISTS ck_user_roles_status;');

    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS sessions DROP CONSTRAINT IF EXISTS ck_sessions_revoke_cause;');
    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS otp_codes DROP CONSTRAINT IF EXISTS ck_otp_codes_purpose;');
    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS staff_members DROP CONSTRAINT IF EXISTS ck_staff_members_status;');
    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS staff_permissions DROP CONSTRAINT IF EXISTS ck_staff_permissions_permission;');
    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS staff_permissions DROP CONSTRAINT IF EXISTS chk_staff_perm_grantable;');

    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS user_sanctions DROP CONSTRAINT IF EXISTS ck_user_sanctions_kind;');
    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS user_sanctions DROP CONSTRAINT IF EXISTS ck_user_sanctions_role;');
    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS user_sanctions DROP CONSTRAINT IF EXISTS ck_user_sanctions_source;');

    await h.createTable(queryInterface, 'users', {
      id: { ...uuid, primaryKey: true },
      phone: { type: DataTypes.STRING(16), allowNull: true, unique: true },
      phone_verified_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      email: { type: DataTypes.STRING(191), allowNull: true, unique: true },
      email_verified_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      password_hash: { type: DataTypes.STRING(255), allowNull: true },
      display_name: { type: DataTypes.STRING(80), allowNull: false },
      legal_name: { type: DataTypes.STRING(120), allowNull: true },
      dob: { type: DataTypes.DATEONLY, allowNull: true },
      nid_hash: { type: DataTypes.CHAR(64), allowNull: true, unique: true },
      nid_last4: { type: DataTypes.CHAR(4), allowNull: true },
      locale: { type: h.ENUM('en', 'bn'), allowNull: false, defaultValue: 'en' },
      kyc_status: { type: h.ENUM('unverified', 'pending', 'verified', 'rejected'), allowNull: false, defaultValue: 'unverified' },
      status: { type: h.ENUM('active', 'suspended', 'banned', 'closed'), allowNull: false, defaultValue: 'active' },
      authz_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      last_panel_role: { type: h.ENUM(...ROLES), allowNull: true },
      failed_login_count: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      locked_until: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      last_login_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      closed_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      created_at: now,
      updated_at: now,
    });

    await queryInterface.sequelize.query(
      'ALTER TABLE users ADD CONSTRAINT chk_users_identifier CHECK (phone IS NOT NULL OR email IS NOT NULL)'
    );

    await h.createTable(queryInterface, 'user_roles', {
      id: { ...uuid, primaryKey: true },
      user_id: { ...uuid, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      role: { type: h.ENUM(...ROLES), allowNull: false },
      status: { type: h.ENUM(...ROLE_STATUS), allowNull: false, defaultValue: 'applied' },
      meta: { type: DataTypes.JSONB, allowNull: true },
      attempt: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
      applied_at: now,
      activated_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      decided_by: { type: DataTypes.UUID, allowNull: true },
      status_reason_code: { type: DataTypes.STRING(40), allowNull: true },
      status_note: { type: DataTypes.TEXT, allowNull: true },
      created_at: now,
      updated_at: now,
    });
    
    try { await queryInterface.removeIndex('user_roles', 'uq_user_roles_user_role'); } catch (e) { void e; }
    try { await queryInterface.removeIndex('user_roles', 'ix_user_roles_role_status'); } catch (e) { void e; }
    await queryInterface.addIndex('user_roles', ['user_id', 'role'], { unique: true, name: 'uq_user_roles_user_role' });
    await queryInterface.addIndex('user_roles', ['role', 'status'], { name: 'ix_user_roles_role_status' });

    await h.createTable(queryInterface, 'sessions', {
      id: { ...uuid, primaryKey: true },
      user_id: { ...uuid, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      family_id: uuid,
      refresh_token_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
      rotated_from: { type: DataTypes.UUID, allowNull: true },
      user_agent: { type: DataTypes.STRING(512), allowNull: true },
      ip: { type: DataTypes.STRING(45), allowNull: true },
      device_label: { type: DataTypes.STRING(80), allowNull: true },
      two_factor_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      last_seen_at: now,
      expires_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false },
      revoked_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      revoke_cause: {
        type: h.ENUM('logout', 'rotation', 'rotation_reuse', 'permission_change', 'sanction', 'password_change', 'admin', 'idle', 'expired'),
        allowNull: true,
      },
      created_at: now,
      updated_at: now,
    });
    try { await queryInterface.removeIndex('sessions', 'ix_sessions_user_active'); } catch (e) { void e; }
    try { await queryInterface.removeIndex('sessions', 'ix_sessions_family'); } catch (e) { void e; }
    await queryInterface.addIndex('sessions', ['user_id', 'revoked_at'], { name: 'ix_sessions_user_active' });
    await queryInterface.addIndex('sessions', ['family_id'], { name: 'ix_sessions_family' });

    await h.createTable(queryInterface, 'otp_codes', {
      id: { ...uuid, primaryKey: true },
      target: { type: DataTypes.STRING(191), allowNull: false },
      purpose: { type: h.ENUM('signup', 'login', 'reset', 'phone_change_old', 'phone_change_new', 'email_verify'), allowNull: false },
      code_hash: { type: DataTypes.CHAR(64), allowNull: false },
      expires_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false },
      attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      consumed_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      ip: { type: DataTypes.STRING(45), allowNull: true },
      created_at: now,
    });
    try { await queryInterface.removeIndex('otp_codes', 'ix_otp_target_purpose_created'); } catch (e) { void e; }
    try { await queryInterface.removeIndex('otp_codes', 'ix_otp_ip_created'); } catch (e) { void e; }
    await queryInterface.addIndex('otp_codes', ['target', 'purpose', 'created_at'], { name: 'ix_otp_target_purpose_created' });
    await queryInterface.addIndex('otp_codes', ['ip', 'created_at'], { name: 'ix_otp_ip_created' });

    await h.createTable(queryInterface, 'staff_members', {
      id: { ...uuid, primaryKey: true },
      user_id: { ...uuid, unique: true, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      employee_id: { type: DataTypes.STRING(32), allowNull: false, unique: true },
      team: { type: DataTypes.STRING(60), allowNull: true },
      is_master: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      status: { type: h.ENUM('invited', 'active', 'suspended', 'offboarded'), allowNull: false, defaultValue: 'invited' },
      totp_secret_enc: { type: DataTypes.STRING(255), allowNull: true },
      totp_enabled_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      totp_last_step: { type: DataTypes.BIGINT, allowNull: true },
      invited_by: { type: DataTypes.UUID, allowNull: true },
      invited_at: now,
      offboarded_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      created_at: now,
      updated_at: now,
    });

    await h.createTable(queryInterface, 'staff_permissions', {
      id: { ...uuid, primaryKey: true },
      user_id: { ...uuid, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      permission: { type: h.ENUM(...PERMS), allowNull: false },
      granted_by: { type: DataTypes.UUID, allowNull: true },
      granted_at: now,
      revoked_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      revoked_by: { type: DataTypes.UUID, allowNull: true },
      created_at: now,
      updated_at: now,
    });
    try { await queryInterface.removeIndex('staff_permissions', 'uq_staff_perm_user_perm'); } catch (e) { void e; }
    await queryInterface.addIndex('staff_permissions', ['user_id', 'permission'], { unique: true, name: 'uq_staff_perm_user_perm' });
    
    await queryInterface.sequelize.query(
      "ALTER TABLE staff_permissions ADD CONSTRAINT chk_staff_perm_grantable CHECK (permission NOT IN ('edit_fees','manage_staff'))"
    );

    await h.createTable(queryInterface, 'user_sanctions', {
      id: { ...uuid, primaryKey: true },
      user_id: { ...uuid, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      kind: { type: h.ENUM('suspension', 'ban', 'role_suspension'), allowNull: false },
      role: { type: h.ENUM(...ROLES), allowNull: true },
      reason_code: { type: DataTypes.STRING(40), allowNull: false },
      note: { type: DataTypes.TEXT, allowNull: true },
      starts_at: now,
      ends_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      source: { type: h.ENUM('admin', 'risk', 'system'), allowNull: false, defaultValue: 'admin' },
      lifted_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      lifted_by: { type: DataTypes.UUID, allowNull: true },
      lift_note: { type: DataTypes.TEXT, allowNull: true },
      created_at: now,
      updated_at: now,
    });
    try { await queryInterface.removeIndex('user_sanctions', 'ix_sanctions_user_open'); } catch (e) { void e; }
    await queryInterface.addIndex('user_sanctions', ['user_id', 'lifted_at'], { name: 'ix_sanctions_user_open' });

    // Single-use step-up tokens (scope-bound). Stored by jti so reuse is rejected.
    await h.createTable(queryInterface, 'step_up_tokens', {
      jti: { ...uuid, primaryKey: true },
      user_id: { ...uuid, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      session_id: uuid,
      scope: { type: DataTypes.STRING(40), allowNull: false },
      expires_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false },
      used_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      created_at: now,
    });

    // Minimal M04 audit log (append-only; the app DB user should have INSERT/SELECT only in production).
    await h.createTable(queryInterface, 'audit_logs', {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      actor_id: { type: DataTypes.UUID, allowNull: true },
      actor_role: { type: DataTypes.STRING(32), allowNull: true },
      action: { type: DataTypes.STRING(80), allowNull: false },
      entity_type: { type: DataTypes.STRING(40), allowNull: true },
      entity_id: { type: DataTypes.STRING(64), allowNull: true },
      before: { type: DataTypes.JSONB, allowNull: true },
      after: { type: DataTypes.JSONB, allowNull: true },
      meta: { type: DataTypes.JSONB, allowNull: true },
      ip: { type: DataTypes.STRING(45), allowNull: true },
      user_agent: { type: DataTypes.STRING(512), allowNull: true },
      request_id: { type: DataTypes.STRING(64), allowNull: true },
      created_at: now,
    });
    try { await queryInterface.removeIndex('audit_logs', 'ix_audit_entity'); } catch (e) { void e; }
    try { await queryInterface.removeIndex('audit_logs', 'ix_audit_actor'); } catch (e) { void e; }
    try { await queryInterface.removeIndex('audit_logs', 'ix_audit_action'); } catch (e) { void e; }
    await queryInterface.addIndex('audit_logs', ['entity_type', 'entity_id', 'created_at'], { name: 'ix_audit_entity' });
    await queryInterface.addIndex('audit_logs', ['actor_id', 'created_at'], { name: 'ix_audit_actor' });
    await queryInterface.addIndex('audit_logs', ['action', 'created_at'], { name: 'ix_audit_action' });
  },

  async down(queryInterface) {
    for (const t of ['audit_logs', 'step_up_tokens', 'user_sanctions', 'staff_permissions', 'staff_members', 'otp_codes', 'sessions', 'user_roles', 'users']) {
      await queryInterface.dropTable(t);
    }
  },
};