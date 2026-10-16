'use strict';

/**
 * M03 §7.1 [v3] esports catalogue: games, modes, maps and points presets. M21 and M05 read it.
 * Catalogue rows are never deleted (is_active), and keys are immutable after create (M03-FR-01).
 * Notes: points arrays are JSONB; points presets are immutable rows, so an edit inserts
 * version n+1 and tournaments snapshot the version they used.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const base = () => ({
      id: { ...uuid, primaryKey: true },
      key: { type: DataTypes.STRING(40), allowNull: false },
      name_en: { type: DataTypes.STRING(80), allowNull: false },
      name_bn: { type: DataTypes.STRING(80), allowNull: false },
      sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    });
    const audit = () => ({
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      created_at: now,
      updated_at: now,
    });
    const gameFk = { ...uuid, references: { model: 'esports_games', key: 'id' }, onDelete: 'RESTRICT' };

    await h.ensureTable(queryInterface, 'esports_games', {
      ...base(),
      publisher: { type: DataTypes.STRING(80), allowNull: true },
      platform: { type: h.ENUM('mobile', 'pc', 'console'), allowNull: false, defaultValue: 'mobile' },
      uid_label_en: { type: DataTypes.STRING(40), allowNull: false },
      uid_label_bn: { type: DataTypes.STRING(40), allowNull: false },
      uid_regex: { type: DataTypes.STRING(120), allowNull: false },
      ign_max_len: { type: DataTypes.SMALLINT, allowNull: false },
      icon: { type: DataTypes.STRING(255), allowNull: true },
      ...audit(),
    });
    await h.ensureIndex(queryInterface, 'esports_games', ['key'], { unique: true, name: 'uq_esports_games_key' });

    await h.ensureTable(queryInterface, 'esports_modes', {
      ...base(),
      game_id: gameFk,
      team_size: { type: DataTypes.SMALLINT, allowNull: false },
      max_teams: { type: DataTypes.SMALLINT, allowNull: false },
      max_players: { type: DataTypes.SMALLINT, allowNull: false },
      max_subs: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      ...audit(),
    });
    await h.ensureIndex(queryInterface, 'esports_modes', ['game_id', 'key'], { unique: true, name: 'uq_esports_modes_game_key' });
    await h.ensureCheck(queryInterface, 'esports_modes', 'chk_esports_modes_capacity',
      'CHECK (team_size >= 1 AND max_teams >= 1 AND max_teams * team_size <= max_players)'
    );

    await h.ensureTable(queryInterface, 'esports_maps', {
      ...base(),
      game_id: gameFk,
      ...audit(),
    });
    await h.ensureIndex(queryInterface, 'esports_maps', ['game_id', 'key'], { unique: true, name: 'uq_esports_maps_game_key' });

    await h.ensureTable(queryInterface, 'esports_points_presets', {
      ...base(),
      game_id: gameFk,
      placement_points: { type: DataTypes.JSONB, allowNull: false },
      kill_points: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      ...audit(),
    });
    await h.ensureIndex(queryInterface, 'esports_points_presets', ['game_id', 'key', 'version'], { unique: true, name: 'uq_esports_presets_game_key_version' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('esports_points_presets');
    await queryInterface.dropTable('esports_maps');
    await queryInterface.dropTable('esports_modes');
    await queryInterface.dropTable('esports_games');
  },
};
