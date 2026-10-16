'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;

    // Idempotent column check: Add audience column only if it doesn't already exist
    const tableInfo = await queryInterface.describeTable('sessions');
    if (!tableInfo.audience) {
      await h.addColumn(queryInterface, 'sessions', 'audience', { 
        type: DataTypes.STRING(32), 
        allowNull: true 
      });
    }

    // Safely handle any indexes if applicable
    try {
      await queryInterface.addIndex('sessions', ['audience'], { name: 'ix_sessions_audience' });
    } catch (e) {
      // Index might already exist
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.removeIndex('sessions', 'ix_sessions_audience');
    } catch (e) {
      void e;
    }
    try {
      await queryInterface.removeColumn('sessions', 'audience');
    } catch (e) {
      void e;
    }
  },
};