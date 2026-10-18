'use strict';

/**
 * M15 lite, built with M14 step 1 (owned by M15): final results entered by the organiser and the
 * standings projection. Live event-sourced scoring, player stats and stat disputes come with M15.
 *  - match_results: one current row per match; an amendment adds a new version and retires the old
 *    one (is_current), so the history stays.
 *  - standings: per stage and group (null for a league), rebuilt from current results.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ ...optUuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const q = (sql) => queryInterface.sequelize.query(sql);
    const int = { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 };

    await h.createTable(queryInterface, 'match_results', {
      id: { ...uuid, primaryKey: true },
      match_id: fk('matches'),
      tournament_id: fk('tournaments'),
      version: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
      outcome: { type: h.ENUM('win', 'draw', 'tie', 'no_result', 'walkover'), allowNull: false },
      winner_team_id: optFk('teams'),
      margin: int,
      score: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      is_current: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      reason: { type: DataTypes.STRING(255), allowNull: true },
      entered_by: uuid,
      superseded_at: at,
      created_at: now,
    });
    await q('CREATE UNIQUE INDEX uq_match_results_current ON match_results (match_id) WHERE is_current');
    await queryInterface.addIndex('match_results', ['tournament_id', 'is_current'], { name: 'ix_match_results_tournament' });

    await h.createTable(queryInterface, 'standings', {
      id: { ...uuid, primaryKey: true },
      tournament_id: fk('tournaments'),
      stage_id: fk('stages'),
      group_id: optFk('groups'),
      team_id: fk('teams'),
      played: int,
      won: int,
      drawn: int,
      lost: int,
      no_result: int,
      points: int,
      score_for: int,
      score_against: int,
      sets_for: int,
      sets_against: int,
      runs_for: int,
      runs_against: int,
      balls_faced: int,
      balls_bowled: int,
      nrr: { type: DataTypes.DECIMAL(8, 3), allowNull: false, defaultValue: 0 },
      position: { type: DataTypes.SMALLINT, allowNull: false },
      needs_lots: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      updated_at: now,
    });
    await q("CREATE UNIQUE INDEX uq_standings_team ON standings (stage_id, COALESCE(group_id, '00000000-0000-0000-0000-000000000000'::uuid), team_id)");
    await queryInterface.addIndex('standings', ['tournament_id'], { name: 'ix_standings_tournament' });
  },

  async down(queryInterface) {
    for (const t of ['standings', 'match_results']) await queryInterface.dropTable(t);
  },
};
