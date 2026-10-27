'use strict';

/**
 * M24 Gym Management, prompt 3 (workout plans and diet charts, §5.8, §6.10, §7.2): four more tables of
 * the gym-manage module (gym group, ADR-007), exactly as §7.2:
 *  - gym_plans: a gym's workout plan or diet chart (source `gym`; `ai` and `self` are reserved for the
 *    later member subscription and refused by the API, M24-FR-68), its current version and a template flag;
 *  - gym_plan_versions (append-only): every edit is version n+1 with the content JSON (§6.10, at most
 *    64 KiB), so a member keeps reading what they were given (M24-FR-63, FR-67);
 *  - gym_plan_assignments: a plan version given to a member from a date; one active workout plan and one
 *    active diet chart per member (partial unique index; a new one replaces the old, M24-FR-64);
 *  - gym_plan_logs (append-only): the member's ticks and notes per Dhaka date and item; the latest row
 *    per (assignment, date, item) wins (M24-FR-65).
 * Value lists are VARCHAR + named CHECK; rows are never deleted.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ ...optUuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const index = (name, sql) => h.ensureIndexSql(queryInterface, name, sql);
    const KINDS = ['workout', 'diet'];

    // ---------------- gym_plans
    await h.ensureTable(queryInterface, 'gym_plans', {
      id: { ...uuid, primaryKey: true },
      gym_id: optFk('gyms'),
      member_user_id: optFk('users'),
      kind: { type: h.ENUM(...KINDS), allowNull: false },
      title: { type: DataTypes.STRING(120), allowNull: false },
      is_template: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      source: { type: h.ENUM('gym', 'ai', 'self'), allowNull: false, defaultValue: 'gym' },
      current_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      status: { type: h.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
      retired_at: at,
      created_by: optUuid,
      updated_by: optUuid,
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(
      queryInterface,
      'gym_plans',
      'chk_gym_plans',
      "CHECK (((source = 'gym') = (gym_id IS NOT NULL)) AND ((source = 'gym') = (member_user_id IS NULL)))"
    );
    await index('ix_gym_plans_gym', 'CREATE INDEX ix_gym_plans_gym ON gym_plans (gym_id, kind, status)');

    // ---------------- gym_plan_versions (append-only)
    await h.ensureTable(queryInterface, 'gym_plan_versions', {
      id: { ...uuid, primaryKey: true },
      plan_id: fk('gym_plans'),
      version: { type: DataTypes.INTEGER, allowNull: false },
      content: { type: DataTypes.JSONB, allowNull: false },
      content_bytes: { type: DataTypes.INTEGER, allowNull: false },
      created_by: fk('users'),
      created_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_plan_versions', 'chk_gym_plan_versions', 'CHECK (version >= 1 AND content_bytes <= 65536)');
    await index('uq_gym_plan_versions', 'CREATE UNIQUE INDEX uq_gym_plan_versions ON gym_plan_versions (plan_id, version)');
    await h.ensureAppendOnly(queryInterface, 'gym_plan_versions');

    // ---------------- gym_plan_assignments
    await h.ensureTable(queryInterface, 'gym_plan_assignments', {
      id: { ...uuid, primaryKey: true },
      plan_id: fk('gym_plans'),
      plan_version_id: fk('gym_plan_versions'),
      kind: { type: h.ENUM(...KINDS), allowNull: false },
      member_id: fk('gym_members'),
      gym_id: fk('gyms'),
      starts_on: { type: DataTypes.DATEONLY, allowNull: false },
      ends_on: { type: DataTypes.DATEONLY, allowNull: true },
      status: { type: h.ENUM('active', 'replaced', 'ended'), allowNull: false, defaultValue: 'active' },
      assigned_by: fk('users'),
      ended_at: at,
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_plan_assignments', 'chk_gym_plan_assignments', "CHECK (ends_on IS NULL OR ends_on >= starts_on)");
    await index('uq_gym_plan_assignments_active', "CREATE UNIQUE INDEX uq_gym_plan_assignments_active ON gym_plan_assignments (member_id, kind) WHERE status = 'active'");
    await index('ix_gym_plan_assignments_plan', 'CREATE INDEX ix_gym_plan_assignments_plan ON gym_plan_assignments (plan_id, status)');
    await index('ix_gym_plan_assignments_gym', 'CREATE INDEX ix_gym_plan_assignments_gym ON gym_plan_assignments (gym_id, status)');

    // ---------------- gym_plan_logs (append-only; the latest row per assignment, date and item wins)
    await h.ensureTable(queryInterface, 'gym_plan_logs', {
      id: { ...uuid, primaryKey: true },
      assignment_id: fk('gym_plan_assignments'),
      plan_version_id: fk('gym_plan_versions'),
      local_date: { type: DataTypes.DATEONLY, allowNull: false },
      item_ref: { type: DataTypes.STRING(20), allowNull: false },
      done: { type: DataTypes.BOOLEAN, allowNull: false },
      note: { type: DataTypes.STRING(300), allowNull: true },
      by_user: fk('users'),
      created_at: now,
    });
    await index('ix_gym_plan_logs', 'CREATE INDEX ix_gym_plan_logs ON gym_plan_logs (assignment_id, local_date, item_ref, created_at DESC)');
    await h.ensureAppendOnly(queryInterface, 'gym_plan_logs');
  },

  async down(queryInterface) {
    for (const t of ['gym_plan_logs', 'gym_plan_assignments', 'gym_plan_versions', 'gym_plans']) {
      await queryInterface.dropTable(t);
    }
  },
};
