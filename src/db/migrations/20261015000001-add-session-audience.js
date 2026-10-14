'use strict';

/**
 * ADR-004 cross-subdomain auth: separate admin sessions.
 *  - sessions.audience: "api" for customer apps (kriraghor.com, esports, vendor, mobile),
 *    "admin" for the admin portal. Refresh only rotates a session through the matching endpoint.
 * Expand-only change (a new column with a default), safe while old pods are still running.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('sessions', 'audience', {
      type: Sequelize.DataTypes.ENUM('api', 'admin'),
      allowNull: false,
      defaultValue: 'api',
      after: 'two_factor_at',
    });
    // Existing staff sessions were all for the admin desks.
    await queryInterface.sequelize.query('UPDATE sessions SET audience = \'admin\' WHERE two_factor_at IS NOT NULL');
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('sessions', 'audience');
  },
};
