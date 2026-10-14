'use strict';

/**
 * M01 §3 [v3] permission flag manage_esports (esports catalogue, M21 tournaments, room-credential
 * rotation). Grantable, so chk_staff_perm_grantable is unchanged. Expand-only: adding an ENUM
 * value at the end is safe while old pods are still running.
 */
const BEFORE = ['approve_listings', 'approve_documents', 'resolve_reports', 'refund_small', 'view_payouts', 'release_payouts', 'edit_fees', 'manage_staff', 'manage_users', 'manage_catalog'];
const AFTER = [...BEFORE, 'manage_esports'];

const enumSql = (values) => `ENUM(${values.map((v) => `'${v}'`).join(', ')})`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE staff_permissions MODIFY permission ${enumSql(AFTER)} NOT NULL`);
  },

  async down(queryInterface) {
    // Records are never hard-deleted. Once the flag has been granted, keep the wider ENUM:
    // older code ignores a permission it does not know, so leaving it is safe.
    const [[{ n }]] = await queryInterface.sequelize.query("SELECT COUNT(*) AS n FROM staff_permissions WHERE permission = 'manage_esports'");
    if (Number(n) > 0) return;
    await queryInterface.sequelize.query(`ALTER TABLE staff_permissions MODIFY permission ${enumSql(BEFORE)} NOT NULL`);
  },
};
