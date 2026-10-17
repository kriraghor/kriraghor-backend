'use strict';

/**
 * The other modules' lists for M11 (only CHECKs change; expand-only, down refuses once a row uses a
 * new value):
 *  - M02 document types `credential` (a hire role's qualification: kept per hire role, subject_key
 *    `hire:<roleKey>`) and `police_clearance` (for under-16 work).
 *  - M05 kind `hire_profile`; M17 report subject `hire_profile`.
 *  - M17 disputes on hire jobs: source `hire_job`, categories `no_show` and `job_problem`; the pro is
 *    the respondent, so the money CHECK pairs a respondent with booking, sub_order and hire_job.
 */
const DOCS_BEFORE = ['nid', 'trade_license', 'deed_or_lease', 'tin', 'bin'];
const DOCS_AFTER = [...DOCS_BEFORE, 'credential', 'police_clearance'];
const KINDS_BEFORE = ['document', 'game_profile', 'esports_tournament', 'ground', 'shop', 'product'];
const KINDS_AFTER = [...KINDS_BEFORE, 'hire_profile'];
const SUBJECTS_BEFORE = ['ground', 'booking', 'user', 'review', 'esports_tournament', 'shop', 'product'];
const SUBJECTS_AFTER = [...SUBJECTS_BEFORE, 'hire_profile'];
const SOURCES_BEFORE = ['booking', 'esports_result', 'sub_order'];
const SOURCES_AFTER = [...SOURCES_BEFORE, 'hire_job'];
const CATEGORIES_BEFORE = ['no_show_contest', 'venue_problem', 'cash_problem', 'result_wrong', 'not_received'];
const CATEGORIES_AFTER = [...CATEGORIES_BEFORE, 'no_show', 'job_problem'];

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
    await h.replaceEnumCheck(queryInterface, 'verification_documents', 'doc_type', DOCS_AFTER);
    for (const t of ['submissions', 'review_rubrics']) await h.replaceEnumCheck(queryInterface, t, 'kind', KINDS_AFTER);
    await h.replaceEnumCheck(queryInterface, 'reports', 'subject_type', SUBJECTS_AFTER);
    await h.replaceEnumCheck(queryInterface, 'disputes', 'source_type', SOURCES_AFTER);
    await h.replaceEnumCheck(queryInterface, 'disputes', 'category', CATEGORIES_AFTER);
    await money(queryInterface, ['booking', 'sub_order', 'hire_job']);
  },

  async down(queryInterface, Sequelize) {
    const [[{ n }]] = await queryInterface.sequelize.query(
      "SELECT (SELECT COUNT(*) FROM verification_documents WHERE doc_type IN ('credential', 'police_clearance')) + (SELECT COUNT(*) FROM submissions WHERE kind = 'hire_profile') + (SELECT COUNT(*) FROM review_rubrics WHERE kind = 'hire_profile') + (SELECT COUNT(*) FROM reports WHERE subject_type = 'hire_profile') + (SELECT COUNT(*) FROM disputes WHERE source_type = 'hire_job') AS n"
    );
    if (Number(n) > 0) return;
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await money(queryInterface, ['booking', 'sub_order']);
    await h.replaceEnumCheck(queryInterface, 'disputes', 'category', CATEGORIES_BEFORE);
    await h.replaceEnumCheck(queryInterface, 'disputes', 'source_type', SOURCES_BEFORE);
    await h.replaceEnumCheck(queryInterface, 'reports', 'subject_type', SUBJECTS_BEFORE);
    for (const t of ['submissions', 'review_rubrics']) await h.replaceEnumCheck(queryInterface, t, 'kind', KINDS_BEFORE);
    await h.replaceEnumCheck(queryInterface, 'verification_documents', 'doc_type', DOCS_BEFORE);
  },
};
