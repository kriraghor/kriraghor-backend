'use strict';

/**
 * The other modules' lists for M22 (only CHECKs change; expand-only, down refuses once a row uses a
 * new value):
 *  - M05 kind `organisation` (an esports organisation, reviewed before it can sign a contract).
 *  - M02 doc type `org_registration` (the organisation's registration, trade licence or institution
 *    letter, kept under the organiser role).
 *  - M01 staff permission `manage_organisers` (organisations, contracts and invoices; grantable).
 *  - M01 OTP purpose `org_finalise`: an organisation admin confirms paying out a tournament with a
 *    code sent to their phone (staff use step-up instead; customers have no authenticator).
 */
const KINDS_BEFORE = ['document', 'game_profile', 'esports_tournament', 'ground', 'shop', 'product', 'hire_profile', 'gym'];
const KINDS_AFTER = [...KINDS_BEFORE, 'organisation'];
const DOCS_BEFORE = ['nid', 'trade_license', 'deed_or_lease', 'tin', 'bin', 'credential', 'police_clearance'];
const DOCS_AFTER = [...DOCS_BEFORE, 'org_registration'];
const OTP_BEFORE = ['signup', 'login', 'reset', 'phone_change_old', 'phone_change_new', 'email_verify', 'payout_account'];
const OTP_AFTER = [...OTP_BEFORE, 'org_finalise'];
const PERMS_BEFORE = ['approve_listings', 'approve_documents', 'resolve_reports', 'refund_small', 'view_payouts', 'release_payouts', 'edit_fees', 'manage_staff', 'manage_users', 'manage_catalog', 'manage_esports', 'enter_results', 'view_analytics'];
const PERMS_AFTER = [...PERMS_BEFORE, 'manage_organisers'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    for (const t of ['submissions', 'review_rubrics']) await h.replaceEnumCheck(queryInterface, t, 'kind', KINDS_AFTER);
    await h.replaceEnumCheck(queryInterface, 'verification_documents', 'doc_type', DOCS_AFTER);
    await h.replaceEnumCheck(queryInterface, 'otp_codes', 'purpose', OTP_AFTER);
    await h.replaceEnumCheck(queryInterface, 'staff_permissions', 'permission', PERMS_AFTER);
  },

  async down(queryInterface, Sequelize) {
    const [[{ n }]] = await queryInterface.sequelize.query(
      "SELECT (SELECT COUNT(*) FROM submissions WHERE kind = 'organisation') + (SELECT COUNT(*) FROM review_rubrics WHERE kind = 'organisation') + (SELECT COUNT(*) FROM verification_documents WHERE doc_type = 'org_registration') + (SELECT COUNT(*) FROM otp_codes WHERE purpose = 'org_finalise') + (SELECT COUNT(*) FROM staff_permissions WHERE permission = 'manage_organisers') AS n"
    );
    if (Number(n) > 0) return;
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.replaceEnumCheck(queryInterface, 'staff_permissions', 'permission', PERMS_BEFORE);
    await h.replaceEnumCheck(queryInterface, 'otp_codes', 'purpose', OTP_BEFORE);
    await h.replaceEnumCheck(queryInterface, 'verification_documents', 'doc_type', DOCS_BEFORE);
    for (const t of ['submissions', 'review_rubrics']) await h.replaceEnumCheck(queryInterface, t, 'kind', KINDS_BEFORE);
  },
};
