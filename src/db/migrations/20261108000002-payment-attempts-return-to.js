'use strict';

/**
 * M06: where the payer goes back to after the gateway. 'web' (the result page on the website, as
 * before) or 'app' (the mobile app's URL scheme, APP_RETURN_URL). Expand-only: existing attempts keep
 * NULL, read as 'web'.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    await h.ensureColumn(queryInterface, 'payment_attempts', 'return_to', { type: h.ENUM('web', 'app'), allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('payment_attempts', 'return_to');
  },
};
