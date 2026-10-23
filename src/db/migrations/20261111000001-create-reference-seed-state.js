'use strict';

/**
 * Reference seed state (owned by src/db/seed, like demo_records belongs to the demo tooling): one row
 * holding the fingerprint of the reference JSON and seed code that was last applied. The API start
 * skips the seed (about 900 sequential queries) when the fingerprint is unchanged, so a deploy opens
 * its port in seconds instead of minutes on a remote database.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    await h.ensureTable(queryInterface, 'reference_seed_state', {
      id: { type: DataTypes.SMALLINT, allowNull: false, primaryKey: true },
      fingerprint: { type: DataTypes.STRING(64), allowNull: false },
      seeded_at: { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') },
    });
    await h.ensureCheck(queryInterface, 'reference_seed_state', 'ck_reference_seed_state_single_row', 'CHECK (id = 1)');
  },

  async down(queryInterface) {
    await queryInterface.dropTable('reference_seed_state');
  },
};
