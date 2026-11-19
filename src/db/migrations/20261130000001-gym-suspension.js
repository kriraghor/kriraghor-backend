'use strict';

/**
 * M20 suspension (tester feedback, 19 Nov 2026): a suspended gym is a total freeze, and an owner's
 * account suspension suspends every gym of the owner. Two nullable columns say why a gym is suspended
 * and what it goes back to:
 *  - suspend_cause: 'staff' (Kriraghor suspended this gym) or 'owner_account' (the owner's account is
 *    suspended or banned; restoring the account restores the gym);
 *  - suspended_from: the status before (draft for a private gym, live, paused …).
 * Gyms suspended before this migration were suspended by staff from live (the only way then).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    await h.ensureColumn(queryInterface, 'gyms', 'suspend_cause', { type: DataTypes.STRING(16), allowNull: true });
    await h.ensureColumn(queryInterface, 'gyms', 'suspended_from', { type: DataTypes.STRING(20), allowNull: true });
    await queryInterface.sequelize.query("UPDATE gyms SET suspend_cause = 'staff', suspended_from = 'live' WHERE status = 'suspended' AND suspend_cause IS NULL");
    // A private gym (a draft, never published) can be suspended now: only a gym that is live or paused, or
    // suspended from live or paused, needs its published snapshot (was: suspended always needed one).
    await queryInterface.sequelize.query('ALTER TABLE gyms DROP CONSTRAINT IF EXISTS chk_gyms_snapshot');
    await queryInterface.sequelize.query("ALTER TABLE gyms ADD CONSTRAINT chk_gyms_snapshot CHECK (live_snapshot IS NOT NULL OR (status NOT IN ('live', 'paused') AND NOT (status = 'suspended' AND suspended_from IN ('live', 'paused'))))");
    await h.ensureCheck(
      queryInterface,
      'gyms',
      'chk_gyms_suspension',
      "CHECK ((status = 'suspended') = (suspend_cause IS NOT NULL) AND (suspend_cause IS NULL OR suspend_cause IN ('staff', 'owner_account')) AND (suspend_cause IS NULL) = (suspended_from IS NULL) AND (suspended_from IS NULL OR suspended_from IN ('draft', 'pending_review', 'changes_requested', 'live', 'paused')))"
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE gyms DROP CONSTRAINT IF EXISTS chk_gyms_suspension');
    await queryInterface.sequelize.query('ALTER TABLE gyms DROP CONSTRAINT IF EXISTS chk_gyms_snapshot');
    await queryInterface.sequelize.query("ALTER TABLE gyms ADD CONSTRAINT chk_gyms_snapshot CHECK (live_snapshot IS NOT NULL OR status NOT IN ('live', 'paused', 'suspended'))");
    for (const c of ['suspended_from', 'suspend_cause']) await queryInterface.removeColumn('gyms', c);
  },
};
