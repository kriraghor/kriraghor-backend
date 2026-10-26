'use strict';

/**
 * M07 payouts, for M24 prompt 2 (M24-FR-46, §6.3): a payout line shows the payment provider's charge
 * passed through at cost on online gym membership fees, next to the gross, the platform fee and the
 * net. Expand-only: a new column with a default; every existing line keeps 0.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    await h.ensureColumn(queryInterface, 'payout_items', 'provider_charge_poisha', { type: Sequelize.DataTypes.BIGINT, allowNull: false, defaultValue: 0 });
    await h.ensureCheck(queryInterface, 'payout_items', 'chk_payout_items_provider_charge', 'CHECK (provider_charge_poisha >= 0)');
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('payout_items', 'provider_charge_poisha');
  },
};
