'use strict';

/**
 * M03 sport rule schemas for M14 (M14-FR-08, §6.10): typed fields with ranges and presets per sport
 * and version, and the tiebreakers each sport allows (§6.5). Tournaments store the version they used;
 * a new version never changes old tournaments.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    await h.createTable(queryInterface, 'sport_rule_schemas', {
      id: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
      sport_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'sports', key: 'id' }, onDelete: 'RESTRICT' },
      version: { type: DataTypes.SMALLINT, allowNull: false },
      fields: { type: DataTypes.JSONB, allowNull: false },
      presets: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      tiebreakers: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('sport_rule_schemas', ['sport_id', 'version'], { unique: true, name: 'uq_sport_rule_schemas_version' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('sport_rule_schemas');
  },
};
