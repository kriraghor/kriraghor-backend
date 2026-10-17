'use strict';

/**
 * M17 disputes on M13 shop sub-orders: source type `sub_order`, category `not_received` (the buyer
 * says the parcel never came). The shop is the respondent, as the owner is on a booking, so the
 * money check's respondent clause covers both. Only CHECKs change. Expand-only: down refuses once
 * a row uses a new value.
 */
const SOURCES_BEFORE = ['booking', 'esports_result'];
const SOURCES_AFTER = [...SOURCES_BEFORE, 'sub_order'];
const CATEGORIES_BEFORE = ['no_show_contest', 'venue_problem', 'cash_problem', 'result_wrong'];
const CATEGORIES_AFTER = [...CATEGORIES_BEFORE, 'not_received'];

const MONEY =
  'paid_poisha >= 0 AND held_poisha BETWEEN 0 AND paid_poisha ' +
  'AND (refund_poisha IS NULL OR refund_poisha BETWEEN 0 AND held_poisha) AND (money OR COALESCE(refund_poisha, 0) = 0) ' +
  "AND (status <> 'resolved' OR (outcome IS NOT NULL AND decided_by IS NOT NULL AND resolved_at IS NOT NULL)) ";

async function money(queryInterface, respondentClause) {
  await queryInterface.sequelize.query('ALTER TABLE disputes DROP CONSTRAINT IF EXISTS chk_disputes_money');
  await queryInterface.sequelize.query(`ALTER TABLE disputes ADD CONSTRAINT chk_disputes_money CHECK (${MONEY}AND (${respondentClause}))`);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.replaceEnumCheck(queryInterface, 'disputes', 'source_type', SOURCES_AFTER);
    await h.replaceEnumCheck(queryInterface, 'disputes', 'category', CATEGORIES_AFTER);
    await money(queryInterface, "(source_type IN ('booking', 'sub_order')) = (respondent_id IS NOT NULL)");
  },

  async down(queryInterface, Sequelize) {
    const [[{ n }]] = await queryInterface.sequelize.query("SELECT COUNT(*) AS n FROM disputes WHERE source_type = 'sub_order' OR category = 'not_received'");
    if (Number(n) > 0) return;
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await money(queryInterface, "(source_type = 'booking') = (respondent_id IS NOT NULL)");
    await h.replaceEnumCheck(queryInterface, 'disputes', 'category', CATEGORIES_BEFORE);
    await h.replaceEnumCheck(queryInterface, 'disputes', 'source_type', SOURCES_BEFORE);
  },
};
