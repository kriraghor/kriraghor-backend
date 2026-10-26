'use strict';

/**
 * M08 notifications, for M24 prompt 2 (§11.1): email to people who have no Kriraghor account (a gym's
 * unlinked members whose email the gym typed). The recipient is a reference (`recipient_type`,
 * `recipient_id`) that a registered adapter resolves to an address at delivery time, so no address is
 * stored here or in any event. One row per message and channel (email only in v1), with the same
 * retry, quiet-hours and de-duplication behaviour as notification_deliveries; there is no bell row.
 * Owned by the notifications module (notification group, ADR-007).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    await h.ensureTable(queryInterface, 'notification_external_deliveries', {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
      code: { type: DataTypes.STRING(60), allowNull: false },
      category: { type: DataTypes.STRING(30), allowNull: false },
      recipient_type: { type: h.ENUM('gym_member'), allowNull: false },
      recipient_id: { type: DataTypes.UUID, allowNull: false },
      channel: { type: h.ENUM('email'), allowNull: false },
      locale: { type: h.ENUM('en', 'bn'), allowNull: false },
      values: { type: DataTypes.JSONB, allowNull: false, defaultValue: Sequelize.literal("'{}'::jsonb") },
      link: { type: DataTypes.STRING(500), allowNull: true },
      template_version: { type: DataTypes.INTEGER, allowNull: true },
      source_event_id: { type: DataTypes.UUID, allowNull: true },
      dedupe_key: { type: DataTypes.STRING(200), allowNull: false },
      status: { type: h.ENUM('queued', 'deferred', 'sent', 'delivered', 'failed', 'suppressed'), allowNull: false, defaultValue: 'queued' },
      deliver_at: { type: h.TS, allowNull: false },
      attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      provider: { type: DataTypes.STRING(30), allowNull: true },
      provider_message_id: { type: DataTypes.STRING(200), allowNull: true },
      sent_at: { type: h.TS, allowNull: true },
      error_code: { type: DataTypes.STRING(60), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await h.ensureIndexSql(queryInterface, 'uq_notification_external_deliveries_dedupe', 'CREATE UNIQUE INDEX uq_notification_external_deliveries_dedupe ON notification_external_deliveries (dedupe_key)');
    await h.ensureIndexSql(queryInterface, 'ix_notification_external_deliveries_due', 'CREATE INDEX ix_notification_external_deliveries_due ON notification_external_deliveries (status, deliver_at)');
    await h.ensureIndexSql(queryInterface, 'ix_notification_external_deliveries_recipient', 'CREATE INDEX ix_notification_external_deliveries_recipient ON notification_external_deliveries (recipient_type, recipient_id, created_at)');
  },

  async down(queryInterface) {
    await queryInterface.dropTable('notification_external_deliveries');
  },
};
