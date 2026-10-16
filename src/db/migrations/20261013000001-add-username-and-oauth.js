'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // PostgreSQL native IF NOT EXISTS - foolproof and clean
    await queryInterface.sequelize.query(
      'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS audience VARCHAR(32);'
    );
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      'ALTER TABLE sessions DROP COLUMN IF EXISTS audience;'
    );
  },
};