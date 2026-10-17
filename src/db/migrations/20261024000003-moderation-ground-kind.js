'use strict';

/**
 * M05 kind for M09: ground (listing review, with a diff for edits of a live ground).
 * The kind columns are already VARCHAR(30) (20261023000003); only the CHECKs change. Expand-only.
 */
const BEFORE = ['document', 'game_profile', 'esports_tournament'];
const AFTER = [...BEFORE, 'ground'];
const TABLES = ['submissions', 'review_rubrics'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    for (const t of TABLES) await h.replaceEnumCheck(queryInterface, t, 'kind', AFTER);
  },

  async down(queryInterface, Sequelize) {
    const [[{ n }]] = await queryInterface.sequelize.query("SELECT (SELECT COUNT(*) FROM submissions WHERE kind = 'ground') + (SELECT COUNT(*) FROM review_rubrics WHERE kind = 'ground') AS n");
    if (Number(n) > 0) return;
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    for (const t of TABLES) await h.replaceEnumCheck(queryInterface, t, 'kind', BEFORE);
  },
};
