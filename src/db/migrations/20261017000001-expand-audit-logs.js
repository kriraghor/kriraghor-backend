'use strict';

/**
 * M04 audit log (M04 §7, FR-02, FR-04, FR-08). Expands the minimal M01 table in place:
 *  - new columns actor_type, module, severity, step_up, reason, session_id, entity_code;
 *    `id` stays BIGINT (ordered, used as the cursor and chain order), `created_at` (DB time at insert)
 *    is the spec's `occurred_at` and `meta` is its `metadata`;
 *  - existing rows are backfilled, then BEFORE UPDATE/DELETE triggers make the table append-only;
 *  - FR-08 indexes: M01 already has (entity, created_at), (actor, created_at), (action, created_at);
 *    this adds (created_at).
 * Monthly partitions (FR-04) are deferred: MySQL partitioned tables cannot have foreign keys and the
 * launch volume is small (Q141). Expand-only, safe while old pods run.
 */
const TRIGGERS = ['UPDATE', 'DELETE'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const q = (sql) => queryInterface.sequelize.query(sql);

    await queryInterface.addColumn('audit_logs', 'actor_type', { type: DataTypes.ENUM('user', 'staff', 'master', 'system', 'provider'), allowNull: false, defaultValue: 'system', after: 'id' });
    await queryInterface.addColumn('audit_logs', 'module', { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'M01', after: 'action' });
    await queryInterface.addColumn('audit_logs', 'entity_code', { type: DataTypes.STRING(40), allowNull: true, after: 'entity_id' });
    await queryInterface.addColumn('audit_logs', 'reason', { type: DataTypes.TEXT, allowNull: true, after: 'after' });
    await queryInterface.addColumn('audit_logs', 'severity', { type: DataTypes.ENUM('info', 'notice', 'critical'), allowNull: false, defaultValue: 'info', after: 'reason' });
    await queryInterface.addColumn('audit_logs', 'step_up', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, after: 'severity' });
    await queryInterface.addColumn('audit_logs', 'session_id', { type: DataTypes.CHAR(36), allowNull: true, after: 'request_id' });

    // Backfill rows written before M04 (no triggers yet).
    await q(
      "UPDATE audit_logs SET actor_type = CASE WHEN actor_id IS NULL THEN 'system' WHEN actor_role LIKE 'master%' THEN 'master' WHEN actor_role = 'staff' THEN 'staff' ELSE 'user' END"
    );
    await q("UPDATE audit_logs SET module = 'M03' WHERE action LIKE 'setting.%' OR action LIKE 'catalog_item.%'");
    await q("UPDATE audit_logs SET severity = 'critical' WHERE JSON_UNQUOTE(JSON_EXTRACT(meta, '$.severity')) = 'critical'");
    await q("UPDATE audit_logs SET step_up = TRUE WHERE JSON_EXTRACT(meta, '$.stepUp') = TRUE");

    await queryInterface.addIndex('audit_logs', ['created_at'], { name: 'ix_audit_created' });

    for (const op of TRIGGERS) {
      await q(
        `CREATE TRIGGER trg_audit_logs_no_${op.toLowerCase()} BEFORE ${op} ON audit_logs FOR EACH ROW ` +
          "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only'"
      );
    }
  },

  async down(queryInterface) {
    for (const op of TRIGGERS) await queryInterface.sequelize.query(`DROP TRIGGER IF EXISTS trg_audit_logs_no_${op.toLowerCase()}`);
    await queryInterface.removeIndex('audit_logs', 'ix_audit_created');
    for (const col of ['session_id', 'step_up', 'severity', 'reason', 'entity_code', 'module', 'actor_type']) await queryInterface.removeColumn('audit_logs', col);
  },
};
