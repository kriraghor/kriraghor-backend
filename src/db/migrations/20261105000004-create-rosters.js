'use strict';

/**
 * M16 rosters and stored eligibility, built with M14 step 1 (owned by M16):
 *  - rosters: one per M14 registration (the squad a team takes into a tournament).
 *  - roster_players: members on a roster; a player is on at most one active roster per tournament
 *    (M16-FR-07, PLAYER_IN_OTHER_TEAM).
 *  - eligibility_checks: the last evaluation per (tournament, player, check), re-run on KYC, gender and
 *    membership changes (M16-FR-08); captains and organisers see booleans only.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const q = (sql) => queryInterface.sequelize.query(sql);

    await h.createTable(queryInterface, 'rosters', {
      id: { ...uuid, primaryKey: true },
      registration_id: fk('registrations'),
      tournament_id: fk('tournaments'),
      team_id: fk('teams'),
      status: { type: h.ENUM('active', 'released'), allowNull: false, defaultValue: 'active' },
      frozen_at: at,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('rosters', ['registration_id'], { unique: true, name: 'uq_rosters_registration' });

    await h.createTable(queryInterface, 'roster_players', {
      id: { ...uuid, primaryKey: true },
      roster_id: fk('rosters'),
      tournament_id: fk('tournaments'),
      team_id: fk('teams'),
      user_id: fk('users'),
      status: { type: h.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
      added_by: { type: DataTypes.UUID, allowNull: true },
      removed_at: at,
      created_at: now,
      updated_at: now,
    });
    await q("CREATE UNIQUE INDEX uq_roster_players_tournament ON roster_players (tournament_id, user_id) WHERE status = 'active'");
    await queryInterface.addIndex('roster_players', ['roster_id', 'status'], { name: 'ix_roster_players_roster' });
    await queryInterface.addIndex('roster_players', ['user_id', 'status'], { name: 'ix_roster_players_user' });

    await h.createTable(queryInterface, 'eligibility_checks', {
      id: { ...uuid, primaryKey: true },
      tournament_id: fk('tournaments'),
      user_id: fk('users'),
      check_key: { type: h.ENUM('nid_verified', 'age', 'gender'), allowNull: false },
      status: { type: h.ENUM('pass', 'fail', 'pending', 'missing', 'n_a'), allowNull: false },
      fix: { type: DataTypes.STRING(20), allowNull: true },
      evaluated_at: now,
    });
    await queryInterface.addIndex('eligibility_checks', ['tournament_id', 'user_id', 'check_key'], { unique: true, name: 'uq_eligibility_checks' });
  },

  async down(queryInterface) {
    for (const t of ['eligibility_checks', 'roster_players', 'rosters']) await queryInterface.dropTable(t);
  },
};
