'use strict';

/**
 * M08 push channel (deferred from M08 v1 to the mobile app): push_subscriptions and push_receipts,
 * owned by notifications.
 *  - push_subscriptions: one row per device token. A token is active on one account at a time (a
 *    partial unique index WHERE revoked_at IS NULL); rows are revoked, never deleted.
 *    session_family_id ties the device to the sign-in that registered it, so signing out (or a
 *    suspension that ends the sessions) stops pushes to that device without another call.
 *  - push_receipts: one row per message the provider accepted (an Expo ticket), checked later for
 *    the final outcome; DeviceNotRegistered revokes the subscription.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const ts = { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };

    await h.ensureTable(queryInterface, 'push_subscriptions', {
      id: { ...uuid, primaryKey: true },
      user_id: { ...uuid, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      platform: { type: h.ENUM('expo', 'web'), allowNull: false },
      token: { type: DataTypes.STRING(200), allowNull: false },
      session_family_id: { type: DataTypes.UUID, allowNull: true },
      device_label: { type: DataTypes.STRING(80), allowNull: true },
      last_used_at: ts,
      revoked_at: ts,
      revoke_reason: { type: h.ENUM('removed', 'replaced', 'other_account', 'device_not_registered', 'device_limit'), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await h.ensureIndexSql(queryInterface, 'uq_push_subscriptions_active_token', 'CREATE UNIQUE INDEX uq_push_subscriptions_active_token ON push_subscriptions (token) WHERE revoked_at IS NULL');
    await h.ensureIndexSql(queryInterface, 'ix_push_subscriptions_user_active', 'CREATE INDEX ix_push_subscriptions_user_active ON push_subscriptions (user_id) WHERE revoked_at IS NULL');

    await h.ensureTable(queryInterface, 'push_receipts', {
      id: { ...uuid, primaryKey: true },
      delivery_id: { ...uuid, references: { model: 'notification_deliveries', key: 'id' }, onDelete: 'RESTRICT' },
      subscription_id: { ...uuid, references: { model: 'push_subscriptions', key: 'id' }, onDelete: 'RESTRICT' },
      ticket_id: { type: DataTypes.STRING(120), allowNull: false },
      status: { type: h.ENUM('pending', 'ok', 'error', 'expired'), allowNull: false, defaultValue: 'pending' },
      error_code: { type: DataTypes.STRING(60), allowNull: true },
      checked_at: ts,
      created_at: now,
    });
    await h.ensureIndex(queryInterface, 'push_receipts', ['status', 'created_at'], { name: 'ix_push_receipts_due' });
    await h.ensureIndex(queryInterface, 'push_receipts', ['delivery_id'], { name: 'ix_push_receipts_delivery' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('push_receipts');
    await queryInterface.dropTable('push_subscriptions');
  },
};
