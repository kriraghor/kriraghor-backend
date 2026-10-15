'use strict';

/**
 * ADR-004 cross-subdomain auth: separate admin sessions.
 *  - sessions.audience: "api" for customer apps (kriraghor.com, esports, vendor, mobile),
 *    "admin" for the admin portal. Refresh only rotates a session through the matching endpoint.
 * Expand-only change (a new column with a default), safe while old pods are still running.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.addColumn(queryInterface, 'sessions', 'audience', {
      type: h.ENUM('api', 'admin'),
      allowNull: false,
      defaultValue: 'api',
    });
    // Existing staff sessions were all for the admin desks.
    await queryInterface.sequelize.query('UPDATE sessions SET audience = \'admin\' WHERE two_factor_at IS NOT NULL');
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('sessions', 'audience');
  },
};
