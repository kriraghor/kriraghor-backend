'use strict';

/**
 * The other modules' lists for M14 step 1 (only CHECKs change; expand-only, down refuses once a row
 * uses a new value):
 *  - M14 lite organisations: kind `sports` (physical-sport tournaments) beside `esports`.
 *  - M05 kind `tournament`: a physical-sport tournament reviewed before registration opens.
 */
const KINDS_BEFORE = ['document', 'game_profile', 'esports_tournament', 'ground', 'shop', 'product', 'hire_profile', 'gym', 'organisation'];
const KINDS_AFTER = [...KINDS_BEFORE, 'tournament'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.replaceEnumCheck(queryInterface, 'organisations', 'kind', ['esports', 'sports']);
    for (const t of ['submissions', 'review_rubrics']) await h.replaceEnumCheck(queryInterface, t, 'kind', KINDS_AFTER);
  },

  async down(queryInterface, Sequelize) {
    const [[{ n }]] = await queryInterface.sequelize.query(
      "SELECT (SELECT COUNT(*) FROM organisations WHERE kind = 'sports') + (SELECT COUNT(*) FROM submissions WHERE kind = 'tournament') + (SELECT COUNT(*) FROM review_rubrics WHERE kind = 'tournament') AS n"
    );
    if (Number(n) > 0) return;
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    for (const t of ['submissions', 'review_rubrics']) await h.replaceEnumCheck(queryInterface, t, 'kind', KINDS_BEFORE);
    await h.replaceEnumCheck(queryInterface, 'organisations', 'kind', ['esports']);
  },
};
