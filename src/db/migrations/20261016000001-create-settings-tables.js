'use strict';

/**
 * M03 settings engine: platform_settings, settings_history, settings_change_requests.
 * MySQL 8 notes vs the Postgres-oriented spec (M03 §7):
 *  - jsonb → JSON, text[] → JSON array, timestamptz → DATETIME(3) in UTC.
 *  - settings_history is append-only (M03-FR-11). The spec asks for INSERT/SELECT-only grants;
 *    the app and migrations share one DB user here, so BEFORE UPDATE/DELETE triggers enforce it.
 *    With binary logging on, creating triggers needs log_bin_trust_function_creators=1 (or SUPER).
 *  - settings_change_requests has no "draft" status: the Fees and rules screen keeps drafts client-side.
 */
const VALUE_TYPES = ['int', 'decimal', 'money', 'bool', 'enum', 'time', 'json', 'int_list', 'string_list'];
const REQUEST_STATUS = ['proposed', 'approved', 'applied', 'rejected', 'withdrawn', 'superseded'];
const SOURCES = ['fees_screen', 'simulator', 'risk_desk', 'api'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE(3), allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.CHAR(36), allowNull: false };
    const uuidNull = { type: DataTypes.CHAR(36), allowNull: true };

    await queryInterface.createTable('platform_settings', {
      key: { type: DataTypes.STRING(80), primaryKey: true, allowNull: false },
      category: { type: DataTypes.STRING(30), allowNull: false },
      value: { type: DataTypes.JSON, allowNull: false },
      value_type: { type: DataTypes.ENUM(...VALUE_TYPES), allowNull: false },
      unit: { type: DataTypes.STRING(12), allowNull: true },
      min_value: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
      max_value: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
      enum_options: { type: DataTypes.JSON, allowNull: true },
      approval: { type: DataTypes.ENUM('single', 'four_eyes'), allowNull: false, defaultValue: 'single' },
      is_public: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      label_en: { type: DataTypes.STRING(160), allowNull: false },
      label_bn: { type: DataTypes.STRING(160), allowNull: false },
      why_en: { type: DataTypes.TEXT, allowNull: true },
      why_bn: { type: DataTypes.TEXT, allowNull: true },
      version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      updated_by: uuidNull,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('platform_settings', ['category'], { name: 'ix_platform_settings_category' });

    await queryInterface.createTable('settings_change_requests', {
      id: { ...uuid, primaryKey: true },
      status: { type: DataTypes.ENUM(...REQUEST_STATUS), allowNull: false, defaultValue: 'proposed' },
      source: { type: DataTypes.ENUM(...SOURCES), allowNull: false, defaultValue: 'fees_screen' },
      changes: { type: DataTypes.JSON, allowNull: false },
      projection: { type: DataTypes.JSON, allowNull: true },
      reason: { type: DataTypes.TEXT, allowNull: false },
      effective_at: { type: DataTypes.DATE(3), allowNull: false },
      needs_four_eyes: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      proposed_by: { ...uuid, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      approved_by: { ...uuidNull, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      decided_by: { ...uuidNull, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      decided_at: { type: DataTypes.DATE(3), allowNull: true },
      decision_note: { type: DataTypes.TEXT, allowNull: true },
      applied_at: { type: DataTypes.DATE(3), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('settings_change_requests', ['status', 'effective_at'], { name: 'ix_settings_cr_status_effective' });
    // M03-FR-12: a four-eyes approver is never the proposer (NULL approver passes).
    await queryInterface.sequelize.query(
      'ALTER TABLE settings_change_requests ADD CONSTRAINT chk_settings_cr_four_eyes CHECK (approved_by IS NULL OR approved_by <> proposed_by)'
    );

    await queryInterface.createTable('settings_history', {
      id: { ...uuid, primaryKey: true },
      key: { type: DataTypes.STRING(80), allowNull: false, references: { model: 'platform_settings', key: 'key' }, onDelete: 'RESTRICT' },
      version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      old_value: { type: DataTypes.JSON, allowNull: true },
      new_value: { type: DataTypes.JSON, allowNull: false },
      effective_at: { type: DataTypes.DATE(3), allowNull: false },
      request_id: { ...uuidNull, references: { model: 'settings_change_requests', key: 'id' }, onDelete: 'RESTRICT' },
      changed_by: uuidNull,
      approved_by: uuidNull,
      reason: { type: DataTypes.TEXT, allowNull: true },
      created_at: now,
    });
    await queryInterface.addIndex('settings_history', ['key', 'version'], { unique: true, name: 'uq_settings_history_key_version' });
    await queryInterface.sequelize.query('CREATE INDEX ix_settings_history_key_effective ON settings_history (`key`, effective_at DESC)');
    for (const op of ['UPDATE', 'DELETE']) {
      await queryInterface.sequelize.query(
        `CREATE TRIGGER trg_settings_history_no_${op.toLowerCase()} BEFORE ${op} ON settings_history FOR EACH ROW ` +
          "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'settings_history is append-only'"
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS trg_settings_history_no_update');
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS trg_settings_history_no_delete');
    await queryInterface.dropTable('settings_history');
    await queryInterface.dropTable('settings_change_requests');
    await queryInterface.dropTable('platform_settings');
  },
};
