'use strict';

/**
 * M04 audit log (M04 §7, FR-02, FR-04, FR-08). Expands the minimal M01 table in place:
 *  - new columns actor_type, module, severity, step_up, reason, session_id, entity_code;
 *    `id` stays BIGINT (ordered, used as the cursor and chain order), `created_at` (DB time at insert)
 *    is the spec's `occurred_at` and `meta` is its `metadata`;
 *  - existing rows are backfilled, then a BEFORE UPDATE OR DELETE trigger makes the table append-only;
 *  - FR-08 indexes: M01 already has (entity, created_at), (actor, created_at), (action, created_at);
 *    this adds (created_at).
 * Monthly partitions (FR-04) are deferred: the launch volume is small (Q141); Postgres can add them
 * later with declarative partitioning. Expand-only, safe while old pods run.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const q = (sql) => queryInterface.sequelize.query(sql);

    await h.addColumn(queryInterface, 'audit_logs', 'actor_type', { type: h.ENUM('user', 'staff', 'master', 'system', 'provider'), allowNull: false, defaultValue: 'system' });
    await h.addColumn(queryInterface, 'audit_logs', 'module', { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'M01' });
    await h.addColumn(queryInterface, 'audit_logs', 'entity_code', { type: DataTypes.STRING(40), allowNull: true });
    await h.addColumn(queryInterface, 'audit_logs', 'reason', { type: DataTypes.TEXT, allowNull: true });
    await h.addColumn(queryInterface, 'audit_logs', 'severity', { type: h.ENUM('info', 'notice', 'critical'), allowNull: false, defaultValue: 'info' });
    await h.addColumn(queryInterface, 'audit_logs', 'step_up', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    await h.addColumn(queryInterface, 'audit_logs', 'session_id', { type: DataTypes.UUID, allowNull: true });

    // Backfill rows written before M04 (no triggers yet).
    await q(
      "UPDATE audit_logs SET actor_type = CASE WHEN actor_id IS NULL THEN 'system' WHEN actor_role LIKE 'master%' THEN 'master' WHEN actor_role = 'staff' THEN 'staff' ELSE 'user' END"
    );
    await q("UPDATE audit_logs SET module = 'M03' WHERE action LIKE 'setting.%' OR action LIKE 'catalog_item.%'");
    await q("UPDATE audit_logs SET severity = 'critical' WHERE meta->>'severity' = 'critical'");
    await q("UPDATE audit_logs SET step_up = TRUE WHERE (meta->>'stepUp')::boolean IS TRUE");

    await queryInterface.addIndex('audit_logs', ['created_at'], { name: 'ix_audit_created' });

    await h.appendOnly(queryInterface, 'audit_logs');
  },

  async down(queryInterface, Sequelize) {
    await require('../migration-helpers/pg-v1')(Sequelize).dropAppendOnly(queryInterface, 'audit_logs');
    await queryInterface.removeIndex('audit_logs', 'ix_audit_created');
    for (const col of ['session_id', 'step_up', 'severity', 'reason', 'entity_code', 'module', 'actor_type']) await queryInterface.removeColumn('audit_logs', col);
  },
};
