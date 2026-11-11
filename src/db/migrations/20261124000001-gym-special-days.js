'use strict';

/**
 * M20 holidays and special hours (product owner, 11 Nov 2026; M20-FR-16 to FR-22): a gym marks a range of
 * dates as closed (Eid, a repair) or gives it its own opening windows (Ramadan timings). The weekly hours
 * stay in gym_hours and the reviewed live_snapshot; special days apply at once, like a venue's closures.
 *  - gym_special_days: one row per range; kind closed | hours; windows (the same shape as a weekday's
 *    windows) only for `hours`; a title the public sees; active → removed, never deleted.
 * M27 conversion report (M27-FR-87): when an enquiry or a trial visit became a member.
 *  - gym_leads.joined_at, gym_visits.converted_at: backfilled from updated_at for rows already joined or
 *    converted, written by the services from now on (expand only).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const db = queryInterface.sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ type: DataTypes.UUID, allowNull: true, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });

    await h.ensureTable(queryInterface, 'gym_special_days', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      from_on: { type: DataTypes.DATEONLY, allowNull: false },
      to_on: { type: DataTypes.DATEONLY, allowNull: false },
      kind: { type: h.ENUM('closed', 'hours'), allowNull: false },
      windows: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      title: { type: DataTypes.STRING(80), allowNull: false },
      status: { type: h.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
      created_by: fk('users'),
      removed_by: optFk('users'),
      removed_at: at,
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(
      queryInterface,
      'gym_special_days',
      'chk_gym_special_days',
      "CHECK (from_on <= to_on AND jsonb_typeof(windows) = 'array' AND ((kind = 'closed') = (jsonb_array_length(windows) = 0)) AND ((status = 'removed') = (removed_at IS NOT NULL)))"
    );
    await h.ensureIndexSql(queryInterface, 'ix_gym_special_days_gym', "CREATE INDEX ix_gym_special_days_gym ON gym_special_days (gym_id, to_on) WHERE status = 'active'");

    // The special day that cancelled a class session, so removing it can bring the session back (M20-FR-21).
    await h.ensureColumn(queryInterface, 'gym_class_sessions', 'special_day_id', { type: DataTypes.UUID, allowNull: true });

    await h.ensureColumn(queryInterface, 'gym_leads', 'joined_at', at);
    await h.ensureColumn(queryInterface, 'gym_visits', 'converted_at', at);
    await db.query("UPDATE gym_leads SET joined_at = updated_at WHERE status = 'joined' AND joined_at IS NULL");
    await db.query('UPDATE gym_visits SET converted_at = updated_at WHERE member_id IS NOT NULL AND converted_at IS NULL');
  },

  // Expand only: the table and the two columns stay.
  async down() {},
};
