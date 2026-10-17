'use strict';

/**
 * M05 kinds for M21: game_profile (UID screenshot check) and esports_tournament (pre-publish review).
 * The kind columns were sized to 'document' (VARCHAR(8)); widen them, then swap the CHECKs.
 * Expand-only: old code never writes the new kinds.
 */
const BEFORE = ['document'];
const AFTER = [...BEFORE, 'game_profile', 'esports_tournament'];
const TABLES = ['submissions', 'review_rubrics'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    for (const t of TABLES) {
      await queryInterface.sequelize.query(`ALTER TABLE ${t} ALTER COLUMN kind TYPE VARCHAR(30)`);
      await h.replaceEnumCheck(queryInterface, t, 'kind', AFTER);
    }
  },

  async down(queryInterface, Sequelize) {
    const [[{ n }]] = await queryInterface.sequelize.query("SELECT (SELECT COUNT(*) FROM submissions WHERE kind <> 'document') + (SELECT COUNT(*) FROM review_rubrics WHERE kind <> 'document') AS n");
    if (Number(n) > 0) return;
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    for (const t of TABLES) await h.replaceEnumCheck(queryInterface, t, 'kind', BEFORE);
  },
};
