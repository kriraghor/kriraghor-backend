'use strict';

/**
 * M03 settings engine: platform_settings, settings_history, settings_change_requests.
 * PostgreSQL (ADR-005) notes vs the spec (M03 §7):
 *  - text[] → JSONB array (one value type for every setting).
 *  - settings_history is append-only (M03-FR-11). The spec asks for INSERT/SELECT-only grants;
 *    the app and migrations share one DB user here, so a BEFORE UPDATE OR DELETE trigger
 *    (kg_forbid_change, migration-helpers/pg-v1) enforces it.
 *  - settings_change_requests has no "draft" status: the Fees and rules screen keeps drafts client-side.
 */
const VALUE_TYPES = ['int', 'decimal', 'money', 'bool', 'enum', 'time', 'json', 'int_list', 'string_list'];
const REQUEST_STATUS = ['proposed', 'approved', 'applied', 'rejected', 'withdrawn', 'superseded'];
const SOURCES = ['fees_screen', 'simulator', 'risk_desk', 'api'];

module.exports = {
  async up(queryInterface, Sequelize) {
    // pg-v2: every statement below is safe to re-run against a database that already has these
    // objects (createTable is CREATE TABLE IF NOT EXISTS, and the CHECKs would otherwise collide).
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const uuidNull = { type: DataTypes.UUID, allowNull: true };

    await h.ensureTable(queryInterface, 'platform_settings', {
      key: { type: DataTypes.STRING(80), primaryKey: true, allowNull: false },
      category: { type: DataTypes.STRING(30), allowNull: false },
      value: { type: DataTypes.JSONB, allowNull: false },
      value_type: { type: h.ENUM(...VALUE_TYPES), allowNull: false },
      unit: { type: DataTypes.STRING(12), allowNull: true },
      min_value: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
      max_value: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
      enum_options: { type: DataTypes.JSONB, allowNull: true },
      approval: { type: h.ENUM('single', 'four_eyes'), allowNull: false, defaultValue: 'single' },
      is_public: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      label_en: { type: DataTypes.STRING(160), allowNull: false },
      label_bn: { type: DataTypes.STRING(160), allowNull: false },
      why_en: { type: DataTypes.TEXT, allowNull: true },
      why_bn: { type: DataTypes.TEXT, allowNull: true },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      updated_by: uuidNull,
      created_at: now,
      updated_at: now,
    });
    await h.ensureIndex(queryInterface, 'platform_settings', ['category'], { name: 'ix_platform_settings_category' });

    await h.ensureTable(queryInterface, 'settings_change_requests', {
      id: { ...uuid, primaryKey: true },
      status: { type: h.ENUM(...REQUEST_STATUS), allowNull: false, defaultValue: 'proposed' },
      source: { type: h.ENUM(...SOURCES), allowNull: false, defaultValue: 'fees_screen' },
      changes: { type: DataTypes.JSONB, allowNull: false },
      projection: { type: DataTypes.JSONB, allowNull: true },
      reason: { type: DataTypes.TEXT, allowNull: false },
      effective_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false },
      needs_four_eyes: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      proposed_by: { ...uuid, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      approved_by: { ...uuidNull, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      decided_by: { ...uuidNull, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      decided_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      decision_note: { type: DataTypes.TEXT, allowNull: true },
      applied_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await h.ensureIndex(queryInterface, 'settings_change_requests', ['status', 'effective_at'], { name: 'ix_settings_cr_status_effective' });
    // M03-FR-12: a four-eyes approver is never the proposer (NULL approver passes).
    await h.ensureCheck(queryInterface, 'settings_change_requests', 'chk_settings_cr_four_eyes',
      'CHECK (approved_by IS NULL OR approved_by <> proposed_by)'
    );

    await h.ensureTable(queryInterface, 'settings_history', {
      id: { ...uuid, primaryKey: true },
      key: { type: DataTypes.STRING(80), allowNull: false, references: { model: 'platform_settings', key: 'key' }, onDelete: 'RESTRICT' },
      version: { type: DataTypes.INTEGER, allowNull: false },
      old_value: { type: DataTypes.JSONB, allowNull: true },
      new_value: { type: DataTypes.JSONB, allowNull: false },
      effective_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false },
      request_id: { ...uuidNull, references: { model: 'settings_change_requests', key: 'id' }, onDelete: 'RESTRICT' },
      changed_by: uuidNull,
      approved_by: uuidNull,
      reason: { type: DataTypes.TEXT, allowNull: true },
      created_at: now,
    });
    await h.ensureIndex(queryInterface, 'settings_history', ['key', 'version'], { unique: true, name: 'uq_settings_history_key_version' });
    await h.ensureIndexSql(queryInterface, 'ix_settings_history_key_effective',
      'CREATE INDEX ix_settings_history_key_effective ON settings_history ("key", effective_at DESC)');
    await h.ensureAppendOnly(queryInterface, 'settings_history');
  },

  async down(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.dropAppendOnly(queryInterface, 'settings_history');
    // The first migration that needs it creates kg_forbid_change(); this one is the earliest.
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS kg_forbid_change()');
    await queryInterface.dropTable('settings_history');
    await queryInterface.dropTable('settings_change_requests');
    await queryInterface.dropTable('platform_settings');
  },
};
