'use strict';

/**
 * M24-FR-171 to FR-173 (product owner, 23 Nov 2026: billing pauses while a gym is suspended), gym-manage:
 *  - gym_active_member_counts.frozen: every gym of the owner was suspended that day (those days are credited
 *    on the monthly invoice); counts from before this migration are false.
 *  - invoice lines gain the credit kind 'suspension_pause'.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    await h.ensureColumn(queryInterface, 'gym_active_member_counts', 'frozen', { type: Sequelize.DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    await h.replaceEnumCheck(queryInterface, 'gym_subscription_invoice_lines', 'kind', ['tier', 'proration', 'founding_free', 'founding_discount', 'referral', 'sms_addon', 'sms_bundle', 'whatsapp_bundle', 'suspension_pause', 'vat', 'adjustment']);
  },

  // Expand only.
  async down() {},
};
