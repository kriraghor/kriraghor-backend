'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.addColumn(queryInterface, 'sessions', 'audience', {
      type: h.ENUM('api', 'admin'),
      allowNull: false,
      defaultValue: 'api',
    });
    
    await queryInterface.sequelize.query("UPDATE sessions SET audience = 'admin' WHERE two_factor_at IS NOT NULL");
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('sessions', 'audience');
  },
};