'use strict';

/**
 * The other modules' lists for M20 (only CHECKs change; expand-only, down refuses once a row uses a
 * new value):
 *  - M05 kind `gym` (gym listings, reviewed like M09 grounds).
 *  - M17 disputes on trainer subscriptions: source `trainer_subscription`, category `service_problem`;
 *    the trainer is the respondent, so the money CHECK pairs a respondent with booking, sub_order,
 *    hire_job and trainer_subscription.
 */
const KINDS_BEFORE = ['document', 'game_profile', 'esports_tournament', 'ground', 'shop', 'product', 'hire_profile'];
const KINDS_AFTER = [...KINDS_BEFORE, 'gym'];
const SOURCES_BEFORE = ['booking', 'esports_result', 'sub_order', 'hire_job'];
const SOURCES_AFTER = [...SOURCES_BEFORE, 'trainer_subscription'];
const CATEGORIES_BEFORE = ['no_show_contest', 'venue_problem', 'cash_problem', 'result_wrong', 'not_received', 'no_show', 'job_problem'];
const CATEGORIES_AFTER = [...CATEGORIES_BEFORE, 'service_problem'];

const MONEY =
  'paid_poisha >= 0 AND held_poisha BETWEEN 0 AND paid_poisha ' +
  'AND (refund_poisha IS NULL OR refund_poisha BETWEEN 0 AND held_poisha) AND (money OR COALESCE(refund_poisha, 0) = 0) ' +
  "AND (status <> 'resolved' OR (outcome IS NOT NULL AND decided_by IS NOT NULL AND resolved_at IS NOT NULL)) ";

async function money(queryInterface, sources) {
  await queryInterface.sequelize.query('ALTER TABLE disputes DROP CONSTRAINT IF EXISTS chk_disputes_money');
  await queryInterface.sequelize.query(`ALTER TABLE disputes ADD CONSTRAINT chk_disputes_money CHECK (${MONEY}AND ((source_type IN (${sources.map((s) => `'${s}'`).join(', ')})) = (respondent_id IS NOT NULL)))`);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    for (const t of ['submissions', 'review_rubrics']) await h.replaceEnumCheck(queryInterface, t, 'kind', KINDS_AFTER);
    // The column was sized to its longest value at creation (esports_result, 14); trainer_subscription needs 20.
    await queryInterface.sequelize.query('ALTER TABLE disputes ALTER COLUMN source_type TYPE VARCHAR(24)');
    await h.replaceEnumCheck(queryInterface, 'disputes', 'source_type', SOURCES_AFTER);
    await h.replaceEnumCheck(queryInterface, 'disputes', 'category', CATEGORIES_AFTER);
    await money(queryInterface, ['booking', 'sub_order', 'hire_job', 'trainer_subscription']);
  },

  async down(queryInterface, Sequelize) {
    const [[{ n }]] = await queryInterface.sequelize.query(
      "SELECT (SELECT COUNT(*) FROM submissions WHERE kind = 'gym') + (SELECT COUNT(*) FROM review_rubrics WHERE kind = 'gym') + (SELECT COUNT(*) FROM disputes WHERE source_type = 'trainer_subscription') AS n"
    );
    if (Number(n) > 0) return;
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await money(queryInterface, ['booking', 'sub_order', 'hire_job']);
    await h.replaceEnumCheck(queryInterface, 'disputes', 'category', CATEGORIES_BEFORE);
    await h.replaceEnumCheck(queryInterface, 'disputes', 'source_type', SOURCES_BEFORE);
    for (const t of ['submissions', 'review_rubrics']) await h.replaceEnumCheck(queryInterface, t, 'kind', KINDS_BEFORE);
  },
};
