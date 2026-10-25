'use strict';

/**
 * M24 prompt 1 (Desk MVP): the changes M24 needs in other modules' tables (each owner's own table, so
 * only CHECKs and columns change; expand-only, the down step refuses once a row uses a new value).
 *  - M01 staff permission `manage_gyms` (Kriraghor staff upload a gym's member list with the owner's
 *    consent, M24-FR-79).
 *  - M20 gym_packages (§7.1, G2): kinds `half_year`, `year`, `custom`; columns admission_fee_poisha,
 *    channel (desk, online, both; existing packages were sold online, so `both`), visit_limit and sort;
 *    the one-active-per-kind index skips `custom` (M24-FR-24).
 *  - M20 gym_passes: the new kinds (a 6- or 12-month or custom package can be sold online) and
 *    fee_override_id (gym_fee_overrides.id of prompt 2; no FK, another module's table).
 */
const KINDS_BEFORE = ['day', 'month', 'quarter'];
const KINDS_AFTER = [...KINDS_BEFORE, 'half_year', 'year', 'custom'];
const PERMS_BEFORE = ['approve_listings', 'approve_documents', 'resolve_reports', 'refund_small', 'view_payouts', 'release_payouts', 'edit_fees', 'manage_staff', 'manage_users', 'manage_catalog', 'manage_esports', 'enter_results', 'view_analytics', 'manage_organisers'];
const PERMS_AFTER = [...PERMS_BEFORE, 'manage_gyms'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const q = (sql) => queryInterface.sequelize.query(sql);

    await h.replaceEnumCheck(queryInterface, 'staff_permissions', 'permission', PERMS_AFTER);

    await q('ALTER TABLE gym_packages ALTER COLUMN kind TYPE varchar(9)');
    await h.replaceEnumCheck(queryInterface, 'gym_packages', 'kind', KINDS_AFTER);
    await h.ensureColumn(queryInterface, 'gym_packages', 'admission_fee_poisha', { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 });
    await h.ensureColumn(queryInterface, 'gym_packages', 'channel', { type: h.ENUM('desk', 'online', 'both'), allowNull: false, defaultValue: 'both' });
    await h.ensureColumn(queryInterface, 'gym_packages', 'visit_limit', { type: DataTypes.SMALLINT, allowNull: true });
    await h.ensureColumn(queryInterface, 'gym_packages', 'sort', { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 });
    await h.ensureCheck(queryInterface, 'gym_packages', 'chk_gym_packages_m24', 'CHECK (admission_fee_poisha >= 0 AND (visit_limit IS NULL OR visit_limit BETWEEN 1 AND 1000))');
    await q('DROP INDEX IF EXISTS uq_gym_packages_kind');
    await q("CREATE UNIQUE INDEX uq_gym_packages_kind ON gym_packages (gym_id, kind) WHERE status = 'active' AND kind <> 'custom'");

    await q('ALTER TABLE gym_passes ALTER COLUMN kind TYPE varchar(9)');
    await h.replaceEnumCheck(queryInterface, 'gym_passes', 'kind', KINDS_AFTER);
    await h.ensureColumn(queryInterface, 'gym_passes', 'fee_override_id', { type: DataTypes.UUID, allowNull: true });
  },

  async down(queryInterface, Sequelize) {
    const [[{ n }]] = await queryInterface.sequelize.query(
      "SELECT (SELECT COUNT(*) FROM gym_packages WHERE kind IN ('half_year', 'year', 'custom')) + (SELECT COUNT(*) FROM gym_passes WHERE kind IN ('half_year', 'year', 'custom')) + (SELECT COUNT(*) FROM staff_permissions WHERE permission = 'manage_gyms') AS n"
    );
    if (Number(n) > 0) return;
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const q = (sql) => queryInterface.sequelize.query(sql);
    await queryInterface.removeColumn('gym_passes', 'fee_override_id');
    await h.replaceEnumCheck(queryInterface, 'gym_passes', 'kind', KINDS_BEFORE);
    await q('DROP INDEX IF EXISTS uq_gym_packages_kind');
    await q("CREATE UNIQUE INDEX uq_gym_packages_kind ON gym_packages (gym_id, kind) WHERE status = 'active'");
    await q('ALTER TABLE gym_packages DROP CONSTRAINT IF EXISTS chk_gym_packages_m24');
    await q('ALTER TABLE gym_packages DROP CONSTRAINT IF EXISTS ck_gym_packages_channel');
    for (const c of ['sort', 'visit_limit', 'channel', 'admission_fee_poisha']) await queryInterface.removeColumn('gym_packages', c);
    await h.replaceEnumCheck(queryInterface, 'gym_packages', 'kind', KINDS_BEFORE);
    await h.replaceEnumCheck(queryInterface, 'staff_permissions', 'permission', PERMS_BEFORE);
  },
};
