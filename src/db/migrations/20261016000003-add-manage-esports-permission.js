'use strict';

/**
 * M01 §3 [v3] permission flag manage_esports (esports catalogue, M21 tournaments, room-credential
 * rotation). Grantable, so chk_staff_perm_grantable is unchanged. Expand-only: widening the value
 * CHECK is safe while old pods are still running.
 */
const BEFORE = ['approve_listings', 'approve_documents', 'resolve_reports', 'refund_small', 'view_payouts', 'release_payouts', 'edit_fees', 'manage_staff', 'manage_users', 'manage_catalog'];
const AFTER = [...BEFORE, 'manage_esports'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.replaceEnumCheck(queryInterface, 'staff_permissions', 'permission', AFTER);
  },

  async down(queryInterface, Sequelize) {
    // Records are never hard-deleted. Once the flag has been granted, keep the wider list:
    // older code ignores a permission it does not know, so leaving it is safe.
    const [[{ n }]] = await queryInterface.sequelize.query("SELECT COUNT(*) AS n FROM staff_permissions WHERE permission = 'manage_esports'");
    if (Number(n) > 0) return;
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.replaceEnumCheck(queryInterface, 'staff_permissions', 'permission', BEFORE);
  },
};
