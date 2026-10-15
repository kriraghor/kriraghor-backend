'use strict';

/**
 * M06 reconciliation (§7, FR-18): one run per provider and business day (Asia/Dhaka), with one item
 * per payment or refund compared. Exceptions keep a resolution, the resolver and a note.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.UUID, allowNull: false };

    await h.createTable(queryInterface, 'reconciliation_runs', {
      id: { ...uuid, primaryKey: true },
      provider: { type: h.ENUM('sslcommerz', 'bkash', 'nagad'), allowNull: false },
      business_date: { type: DataTypes.DATEONLY, allowNull: false },
      status: { type: h.ENUM('running', 'completed', 'failed'), allowNull: false, defaultValue: 'running' },
      totals: { type: DataTypes.JSONB, allowNull: true },
      started_by: { type: DataTypes.UUID, allowNull: true },
      error: { type: DataTypes.STRING(300), allowNull: true },
      started_at: now,
      finished_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
    });
    await queryInterface.addIndex('reconciliation_runs', ['provider', 'business_date'], { unique: true, name: 'uq_recon_runs_day' });

    await h.createTable(queryInterface, 'reconciliation_items', {
      id: { ...uuid, primaryKey: true },
      run_id: { ...uuid, references: { model: 'reconciliation_runs', key: 'id' }, onDelete: 'RESTRICT' },
      type: {
        type: h.ENUM('matched', 'missing_internal', 'missing_provider', 'amount_mismatch', 'status_mismatch', 'refund_mismatch', 'fee_mismatch'),
        allowNull: false,
      },
      payment_id: { type: DataTypes.UUID, allowNull: true },
      refund_id: { type: DataTypes.UUID, allowNull: true },
      provider_ref: { type: DataTypes.STRING(120), allowNull: true },
      internal_poisha: { type: DataTypes.BIGINT, allowNull: true },
      provider_poisha: { type: DataTypes.BIGINT, allowNull: true },
      detail: { type: DataTypes.STRING(300), allowNull: true },
      // auto_healed: the run fixed it (missed capture verified); otherwise a person resolves it.
      resolution: { type: h.ENUM('auto_healed', 'resolved', 'ignored'), allowNull: true },
      resolved_by: { type: DataTypes.UUID, allowNull: true },
      resolved_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      note: { type: DataTypes.STRING(500), allowNull: true },
      created_at: now,
    });
    await queryInterface.addIndex('reconciliation_items', ['run_id', 'type'], { name: 'ix_recon_items_run' });
    await queryInterface.addIndex('reconciliation_items', ['payment_id'], { name: 'ix_recon_items_payment' });
  },

  async down(queryInterface) {
    for (const t of ['reconciliation_items', 'reconciliation_runs']) await queryInterface.dropTable(t);
  },
};
