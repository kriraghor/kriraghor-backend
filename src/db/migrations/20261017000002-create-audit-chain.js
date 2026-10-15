'use strict';

/**
 * M04-FR-05 tamper evidence, sealed after commit. audit_chain is an append-only hash chain over
 * audit_logs: row_hash = SHA-256(prev_hash ‖ canonical_json(audit row)). The audit.chain-seal job
 * appends unsealed rows in id order, so business transactions never wait on a chain lock.
 */
const TRIGGERS = ['UPDATE', 'DELETE'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('audit_chain', {
      seq: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
      audit_log_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, unique: true, references: { model: 'audit_logs', key: 'id' }, onDelete: 'RESTRICT' },
      prev_hash: { type: DataTypes.CHAR(64), allowNull: true },
      row_hash: { type: DataTypes.CHAR(64), allowNull: false },
      sealed_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') },
    });
    for (const op of TRIGGERS) {
      await queryInterface.sequelize.query(
        `CREATE TRIGGER trg_audit_chain_no_${op.toLowerCase()} BEFORE ${op} ON audit_chain FOR EACH ROW ` +
          "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_chain is append-only'"
      );
    }
  },

  async down(queryInterface) {
    for (const op of TRIGGERS) await queryInterface.sequelize.query(`DROP TRIGGER IF EXISTS trg_audit_chain_no_${op.toLowerCase()}`);
    await queryInterface.dropTable('audit_chain');
  },
};
