'use strict';

/**
 * M08 for the gym SMS add-on (M24 §6.7, M24-FR-99): an SMS paid from a gym owner's units carries the
 * reservation's billing_ref, so M08 can report how it went (notification.sms_settled).
 *  - notification_deliveries.billing_ref: set on the one SMS delivery of a billed member notice.
 *  - notification_external_deliveries: channel sms beside email (a phone-only member of a gym, resolved in
 *    memory by the gym_member adapter), status rate_limited, and billing_ref.
 * Expand only.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const db = queryInterface.sequelize;
    await h.ensureColumn(queryInterface, 'notification_deliveries', 'billing_ref', { type: DataTypes.UUID, allowNull: true });
    await h.ensureIndexSql(queryInterface, 'ix_notification_deliveries_billing_ref', 'CREATE INDEX ix_notification_deliveries_billing_ref ON notification_deliveries (billing_ref) WHERE billing_ref IS NOT NULL');

    await db.query('ALTER TABLE notification_external_deliveries ALTER COLUMN channel TYPE VARCHAR(5)');
    await h.replaceEnumCheck(queryInterface, 'notification_external_deliveries', 'channel', ['email', 'sms']);
    await db.query('ALTER TABLE notification_external_deliveries ALTER COLUMN status TYPE VARCHAR(12)');
    await h.replaceEnumCheck(queryInterface, 'notification_external_deliveries', 'status', ['queued', 'deferred', 'sent', 'delivered', 'failed', 'rate_limited', 'suppressed']);
    await h.ensureColumn(queryInterface, 'notification_external_deliveries', 'billing_ref', { type: DataTypes.UUID, allowNull: true });
  },

  async down() {},
};
