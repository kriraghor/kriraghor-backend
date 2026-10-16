'use strict';

/**
 * M02 business-role documents, lite (for M09 ground owners): trade licence, deed or lease, TIN.
 * doc_type was sized to 'nid'; widen it, then swap the CHECK. Expand-only: old code never writes
 * the new types, and down refuses once a business document exists.
 */
const BEFORE = ['nid'];
const AFTER = [...BEFORE, 'trade_license', 'deed_or_lease', 'tin'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await queryInterface.sequelize.query('ALTER TABLE verification_documents ALTER COLUMN doc_type TYPE VARCHAR(30)');
    await h.replaceEnumCheck(queryInterface, 'verification_documents', 'doc_type', AFTER);
  },

  async down(queryInterface, Sequelize) {
    const [[{ n }]] = await queryInterface.sequelize.query("SELECT COUNT(*) AS n FROM verification_documents WHERE doc_type <> 'nid'");
    if (Number(n) > 0) return;
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.replaceEnumCheck(queryInterface, 'verification_documents', 'doc_type', BEFORE);
  },
};
