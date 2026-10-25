'use strict';

/**
 * M02-FR-05 (product owner, 25 Oct 2026): explicit, versioned consent with every NID and business
 * document. Expand-only: two nullable columns on verification_documents, so documents sent before
 * this change stay NULL ("consent not recorded") and older code keeps working during a deploy.
 *  - consent_version: the consent version the member accepted (kyc-requirements.v1.json consent.version);
 *  - consented_at:    when they accepted it (UTC).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    await h.ensureColumn(queryInterface, 'verification_documents', 'consent_version', { type: Sequelize.DataTypes.INTEGER, allowNull: true });
    await h.ensureColumn(queryInterface, 'verification_documents', 'consented_at', { type: h.TS, allowNull: true });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('verification_documents', 'consented_at');
    await queryInterface.removeColumn('verification_documents', 'consent_version');
  },
};
