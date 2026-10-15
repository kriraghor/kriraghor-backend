'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('sessions', 'audience', {
      type: Sequelize.DataTypes.ENUM('api', 'admin'),
      allowNull: false,
      defaultValue: 'api',
    });
    
    await queryInterface.sequelize.query("UPDATE sessions SET audience = 'admin' WHERE two_factor_at IS NOT NULL");
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('sessions', 'audience');
  },
};