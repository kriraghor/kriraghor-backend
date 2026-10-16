'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Check information_schema first so it never throws an error if column exists
    await queryInterface.sequelize.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 
          FROM information_schema.columns 
          WHERE table_schema = 'public' 
            AND table_name = 'sessions' 
            AND column_name = 'audience'
        ) THEN
          ALTER TABLE sessions ADD COLUMN audience VARCHAR(32);
        END IF;
      END $$;
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      'ALTER TABLE sessions DROP COLUMN IF EXISTS audience;'
    );
  },
};