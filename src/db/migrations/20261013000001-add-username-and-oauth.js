'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Foolproof PL/pgSQL block that catches duplicate column errors safely
    await queryInterface.sequelize.query(`
      DO $$ 
      BEGIN
        ALTER TABLE sessions ADD COLUMN audience VARCHAR(32);
      EXCEPTION
        WHEN duplicate_column THEN 
          NULL;
      END $$;
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      'ALTER TABLE sessions DROP COLUMN IF EXISTS audience;'
    );
  },
};