'use strict';

/**
 * M21 §3 [v3] permission flag enter_results: staff who type match results (placement, kills) without
 * the rest of manage_esports. Grantable. Expand-only, like 20261016000003.
 */
const BEFORE = ['approve_listings', 'approve_documents', 'resolve_reports', 'refund_small', 'view_payouts', 'release_payouts', 'edit_fees', 'manage_staff', 'manage_users', 'manage_catalog', 'manage_esports'];
const AFTER = [...BEFORE, 'enter_results'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.replaceEnumCheck(queryInterface, 'staff_permissions', 'permission', AFTER);
  },

  async down(queryInterface, Sequelize) {
    // Records are never hard-deleted: once granted, keep the wider list.
    const [[{ n }]] = await queryInterface.sequelize.query("SELECT COUNT(*) AS n FROM staff_permissions WHERE permission = 'enter_results'");
    if (Number(n) > 0) return;
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.replaceEnumCheck(queryInterface, 'staff_permissions', 'permission', BEFORE);
  },
};
