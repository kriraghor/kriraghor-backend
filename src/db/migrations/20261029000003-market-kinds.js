'use strict';

/**
 * M05 kinds and M17 report subjects for M12: shops and products are reviewed on the Moderation desk
 * (kinds `shop`, `product`) and members can report them (subject types `shop`, `product`).
 * Only the CHECKs change. Expand-only: down refuses once a row uses a new value.
 */
const KINDS_BEFORE = ['document', 'game_profile', 'esports_tournament', 'ground'];
const KINDS_AFTER = [...KINDS_BEFORE, 'shop', 'product'];
const SUBJECTS_BEFORE = ['ground', 'booking', 'user', 'review', 'esports_tournament'];
const SUBJECTS_AFTER = [...SUBJECTS_BEFORE, 'shop', 'product'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    for (const t of ['submissions', 'review_rubrics']) await h.replaceEnumCheck(queryInterface, t, 'kind', KINDS_AFTER);
    await queryInterface.sequelize.query('ALTER TABLE reports ALTER COLUMN subject_type TYPE VARCHAR(30)');
    await h.replaceEnumCheck(queryInterface, 'reports', 'subject_type', SUBJECTS_AFTER);
  },

  async down(queryInterface, Sequelize) {
    const [[{ n }]] = await queryInterface.sequelize.query(
      "SELECT (SELECT COUNT(*) FROM submissions WHERE kind IN ('shop', 'product')) + (SELECT COUNT(*) FROM review_rubrics WHERE kind IN ('shop', 'product')) + (SELECT COUNT(*) FROM reports WHERE subject_type IN ('shop', 'product')) AS n"
    );
    if (Number(n) > 0) return;
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    for (const t of ['submissions', 'review_rubrics']) await h.replaceEnumCheck(queryInterface, t, 'kind', KINDS_BEFORE);
    await h.replaceEnumCheck(queryInterface, 'reports', 'subject_type', SUBJECTS_BEFORE);
  },
};
