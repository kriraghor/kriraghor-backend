'use strict';

/**
 * M08 notifications core (M08 §7): notifications, notification_prefs, message_templates,
 * notification_deliveries and sms_log. Notes vs the spec:
 *  - one active template version per code/channel/locale: a partial unique index WHERE is_active;
 *  - (user_id, read_at, created_at) serves the unread count and the list;
 *  - sms_log.gateway_message_id is unique per gateway (NULLs are allowed many times).
 * Broadcasts, broadcast_recipients and push_subscriptions come with M21 (deferred).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const userFk = { ...uuid, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' };
    const CHANNELS = ['in_app', 'sms', 'email', 'push'];

    await h.createTable(queryInterface, 'notifications', {
      id: { ...uuid, primaryKey: true },
      user_id: userFk,
      code: { type: DataTypes.STRING(60), allowNull: false },
      category: { type: DataTypes.STRING(30), allowNull: false },
      role_context: { type: DataTypes.STRING(20), allowNull: true },
      title: { type: DataTypes.STRING(140), allowNull: false },
      body: { type: DataTypes.STRING(500), allowNull: false },
      link: { type: DataTypes.STRING(300), allowNull: true },
      data: { type: DataTypes.JSONB, allowNull: true },
      locale: { type: h.ENUM('en', 'bn'), allowNull: false, defaultValue: 'en' },
      template_version: { type: DataTypes.INTEGER, allowNull: false },
      source_event_id: { type: DataTypes.UUID, allowNull: true },
      dedupe_key: { type: DataTypes.STRING(200), allowNull: false, unique: true },
      read_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      archived_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      created_at: now,
    });
    await queryInterface.addIndex('notifications', ['user_id', 'read_at', 'created_at'], { name: 'ix_notifications_user_unread' });
    await queryInterface.addIndex('notifications', ['user_id', 'created_at'], { name: 'ix_notifications_user' });

    await h.createTable(queryInterface, 'notification_prefs', {
      user_id: { ...userFk, primaryKey: true },
      category: { type: DataTypes.STRING(30), allowNull: false, primaryKey: true },
      channel: { type: h.ENUM(...CHANNELS), allowNull: false, primaryKey: true },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false },
      updated_at: now,
    });

    await h.createTable(queryInterface, 'message_templates', {
      id: { ...uuid, primaryKey: true },
      code: { type: DataTypes.STRING(60), allowNull: false },
      channel: { type: h.ENUM(...CHANNELS), allowNull: false },
      locale: { type: h.ENUM('en', 'bn'), allowNull: false },
      version: { type: DataTypes.INTEGER, allowNull: false },
      subject: { type: DataTypes.STRING(160), allowNull: true },
      body: { type: DataTypes.TEXT, allowNull: false },
      variables: { type: DataTypes.JSONB, allowNull: false },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      max_sms_segments: { type: DataTypes.SMALLINT, allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      created_at: now,
    });
    await queryInterface.addIndex('message_templates', ['code', 'channel', 'locale', 'version'], { unique: true, name: 'uq_message_templates_version' });
    await queryInterface.addIndex('message_templates', ['code', 'channel', 'locale'], { unique: true, name: 'uq_message_templates_active', where: { is_active: true } });

    await h.createTable(queryInterface, 'notification_deliveries', {
      id: { ...uuid, primaryKey: true },
      notification_id: { ...uuid, references: { model: 'notifications', key: 'id' }, onDelete: 'RESTRICT' },
      user_id: userFk,
      channel: { type: h.ENUM(...CHANNELS), allowNull: false },
      status: { type: h.ENUM('queued', 'deferred', 'sent', 'delivered', 'failed', 'rate_limited', 'suppressed'), allowNull: false, defaultValue: 'queued' },
      deliver_at: now,
      attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      provider: { type: DataTypes.STRING(20), allowNull: true },
      provider_message_id: { type: DataTypes.STRING(120), allowNull: true },
      error_code: { type: DataTypes.STRING(60), allowNull: true },
      sent_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      delivered_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('notification_deliveries', ['status', 'deliver_at'], { name: 'ix_deliveries_due' });
    await queryInterface.addIndex('notification_deliveries', ['user_id', 'created_at'], { name: 'ix_deliveries_user' });

    await h.createTable(queryInterface, 'sms_log', {
      id: { ...uuid, primaryKey: true },
      delivery_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'notification_deliveries', key: 'id' }, onDelete: 'RESTRICT' },
      route: { type: h.ENUM('otp', 'trans'), allowNull: false },
      to_phone_hash: { type: DataTypes.CHAR(64), allowNull: false },
      to_phone_masked: { type: DataTypes.STRING(20), allowNull: false },
      gateway: { type: DataTypes.STRING(20), allowNull: false },
      encoding: { type: h.ENUM('gsm7', 'ucs2'), allowNull: false },
      segments: { type: DataTypes.SMALLINT, allowNull: false },
      body_redacted: { type: DataTypes.TEXT, allowNull: false },
      gateway_message_id: { type: DataTypes.STRING(120), allowNull: true },
      status: { type: DataTypes.STRING(12), allowNull: false },
      dlr_status: { type: DataTypes.STRING(20), allowNull: true },
      cost_poisha: { type: DataTypes.INTEGER, allowNull: true },
      requested_at: now,
      dlr_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: true },
    });
    await queryInterface.addIndex('sms_log', ['gateway', 'gateway_message_id'], { unique: true, name: 'uq_sms_log_gateway_id' });
    await queryInterface.addIndex('sms_log', ['to_phone_hash', 'requested_at'], { name: 'ix_sms_log_phone' });
  },

  async down(queryInterface) {
    for (const t of ['sms_log', 'notification_deliveries', 'message_templates', 'notification_prefs', 'notifications']) await queryInterface.dropTable(t);
  },
};
