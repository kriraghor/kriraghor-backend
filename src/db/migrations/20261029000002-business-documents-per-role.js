'use strict';

/**
 * M02 business documents per role (with M12, 17 Oct 2026 decision): a shop owner's trade licence is
 * not a ground owner's. Business documents are keyed by role through the existing subject_key
 * (the partial unique indexes already include it), and BIN (business identification number, VAT) is
 * a new document type for shop owners.
 *  - data: existing business documents get the role they were sent for (fields_public.role,
 *    ground_owner when missing). NID rows keep subject_key ''.
 *  - doc_type CHECK gains 'bin'. Expand-only: older code never writes it.
 */
const BEFORE = ['nid', 'trade_license', 'deed_or_lease', 'tin'];
const AFTER = [...BEFORE, 'bin'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.replaceEnumCheck(queryInterface, 'verification_documents', 'doc_type', AFTER);
    await queryInterface.sequelize.query(
      "UPDATE verification_documents SET subject_key = COALESCE(fields_public->>'role', 'ground_owner') WHERE doc_type <> 'nid' AND subject_key = ''"
    );
  },

  async down(queryInterface, Sequelize) {
    const [[{ n }]] = await queryInterface.sequelize.query("SELECT COUNT(*) AS n FROM verification_documents WHERE doc_type = 'bin' OR (doc_type <> 'nid' AND subject_key <> 'ground_owner')");
    if (Number(n) > 0) return;
    await queryInterface.sequelize.query("UPDATE verification_documents SET subject_key = '' WHERE doc_type <> 'nid'");
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.replaceEnumCheck(queryInterface, 'verification_documents', 'doc_type', BEFORE);
  },
};
