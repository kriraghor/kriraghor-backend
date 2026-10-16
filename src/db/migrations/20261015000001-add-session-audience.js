'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);

    // Safe check: Add column only if it truly doesn't exist
    const [results] = await queryInterface.sequelize.query(`
      SELECT 1 
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
        AND table_name = 'sessions' 
        AND column_name = 'audience'
    `);

    if (results.length === 0) {
      await h.addColumn(queryInterface, 'sessions', 'audience', {
        type: h.ENUM('api', 'admin'),
        allowNull: false,
        defaultValue: 'api',
      });
    }
    
    // Safe update query
    await queryInterface.sequelize.query("UPDATE sessions SET audience = 'admin' WHERE two_factor_at IS NOT NULL AND audience = 'api'");
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('sessions', 'audience');
  },
};
