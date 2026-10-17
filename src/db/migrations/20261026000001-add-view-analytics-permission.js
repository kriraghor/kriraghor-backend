'use strict';

/**
 * M19 (Q104) permission flag view_analytics: staff who see the platform overview and its exports
 * without being masters. Grantable. Expand-only, like 20261023000002.
 */
const BEFORE = ['approve_listings', 'approve_documents', 'resolve_reports', 'refund_small', 'view_payouts', 'release_payouts', 'edit_fees', 'manage_staff', 'manage_users', 'manage_catalog', 'manage_esports', 'enter_results'];
const AFTER = [...BEFORE, 'view_analytics'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.replaceEnumCheck(queryInterface, 'staff_permissions', 'permission', AFTER);
  },

  async down(queryInterface, Sequelize) {
    // Records are never hard-deleted: once granted, keep the wider list.
    const [[{ n }]] = await queryInterface.sequelize.query("SELECT COUNT(*) AS n FROM staff_permissions WHERE permission = 'view_analytics'");
    if (Number(n) > 0) return;
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.replaceEnumCheck(queryInterface, 'staff_permissions', 'permission', BEFORE);
  },
};
