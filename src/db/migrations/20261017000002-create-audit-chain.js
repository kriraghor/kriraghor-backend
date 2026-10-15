'use strict';

/**
 * M04-FR-05 tamper evidence, sealed after commit. audit_chain is an append-only hash chain over
 * audit_logs: row_hash = SHA-256(prev_hash ‖ canonical_json(audit row)). The audit.chain-seal job
 * appends unsealed rows in id order, so business transactions never wait on a chain lock.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('audit_chain', {
      seq: { type: DataTypes.BIGINT, primaryKey: true },
      audit_log_id: { type: DataTypes.BIGINT, allowNull: false, unique: true, references: { model: 'audit_logs', key: 'id' }, onDelete: 'RESTRICT' },
      prev_hash: { type: DataTypes.CHAR(64), allowNull: true },
      row_hash: { type: DataTypes.CHAR(64), allowNull: false },
      sealed_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') },
    });
    await h.appendOnly(queryInterface, 'audit_chain');
  },

  async down(queryInterface, Sequelize) {
    await require('../migration-helpers/pg-v1')(Sequelize).dropAppendOnly(queryInterface, 'audit_chain');
    await queryInterface.dropTable('audit_chain');
  },
};
