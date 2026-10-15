'use strict';

/**
 * M04 transactional outbox and shared inbox (M04 §7, FR-12 to FR-16).
 *  - outbox_events: written in the producer's transaction, relayed to BullMQ by outbox.relay.
 *  - consumed_events: one row per (consumer, event); the PK makes delivery idempotent (Q24: one
 *    shared table owned by M04, written only through the inbox).
 * MySQL notes: no LISTEN/NOTIFY (the relay is nudged after commit and polls every second), no partial
 * index (status is the leading column instead), no partitions yet (Q141).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE(3), allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };

    await queryInterface.createTable('outbox_events', {
      id: { type: DataTypes.CHAR(36), primaryKey: true },
      name: { type: DataTypes.STRING(80), allowNull: false },
      version: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
      aggregate_type: { type: DataTypes.STRING(40), allowNull: false },
      aggregate_id: { type: DataTypes.STRING(64), allowNull: false },
      aggregate_version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
      payload: { type: DataTypes.JSON, allowNull: false },
      metadata: { type: DataTypes.JSON, allowNull: true },
      occurred_at: now,
      available_at: now,
      status: { type: DataTypes.ENUM('pending', 'published', 'failed'), allowNull: false, defaultValue: 'pending' },
      published_at: { type: DataTypes.DATE(3), allowNull: true },
      attempts: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      last_error: { type: DataTypes.TEXT, allowNull: true },
    });
    await queryInterface.addIndex('outbox_events', ['status', 'available_at', 'id'], { name: 'ix_outbox_due' });
    await queryInterface.addIndex('outbox_events', ['aggregate_type', 'aggregate_id', 'aggregate_version'], { name: 'ix_outbox_aggregate' });
    await queryInterface.addIndex('outbox_events', ['name', 'occurred_at'], { name: 'ix_outbox_name' });

    await queryInterface.createTable('consumed_events', {
      consumer: { type: DataTypes.STRING(80), primaryKey: true },
      event_id: { type: DataTypes.CHAR(36), primaryKey: true, references: { model: 'outbox_events', key: 'id' }, onDelete: 'RESTRICT' },
      event_name: { type: DataTypes.STRING(80), allowNull: false },
      status: { type: DataTypes.ENUM('processed', 'dead'), allowNull: false },
      attempts: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
      last_error: { type: DataTypes.TEXT, allowNull: true },
      processed_at: now,
    });
    await queryInterface.addIndex('consumed_events', ['status', 'processed_at'], { name: 'ix_consumed_status' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('consumed_events');
    await queryInterface.dropTable('outbox_events');
  },
};
