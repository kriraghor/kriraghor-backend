'use strict';

/**
 * M03 §6.1, §6.3, §7 catalogues that M09 Grounds needs first (M03-FR-03 rows, FR-06, FR-07):
 * sports (rows only; rule schemas come with M14), divisions, districts, areas, facilities, surfaces.
 * Same base columns and rules as the esports catalogue: rows are never deleted (is_active) and keys
 * are immutable. Areas carry aliases (GIN) for search; pg_trgm serves fuzzy name search here and in
 * M09 (ground names, the duplicate check).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
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
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const latLng = (allowNull) => ({ type: DataTypes.DECIMAL(9, 6), allowNull });

    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');

    await h.createTable(queryInterface, 'sports', {
      ...base(),
      engine: { type: h.ENUM('ball_by_ball', 'clock', 'rally', 'none'), allowNull: false },
      official_label_en: { type: DataTypes.STRING(40), allowNull: true },
      official_label_bn: { type: DataTypes.STRING(40), allowNull: true },
      default_tiebreakers: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
      // Bits: 1 grounds, 2 hire, 4 market, 8 tournaments, 16 gyms.
      vertical_flags: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      icon: { type: DataTypes.STRING(40), allowNull: true },
      tint: { type: DataTypes.STRING(16), allowNull: true },
      ...audit(),
    });
    await queryInterface.addIndex('sports', ['key'], { unique: true, name: 'uq_sports_key' });

    await h.createTable(queryInterface, 'divisions', { ...base(), bbs_code: { type: DataTypes.CHAR(2), allowNull: false }, ...audit() });
    await queryInterface.addIndex('divisions', ['key'], { unique: true, name: 'uq_divisions_key' });
    await queryInterface.addIndex('divisions', ['bbs_code'], { unique: true, name: 'uq_divisions_bbs_code' });

    await h.createTable(queryInterface, 'districts', {
      ...base(),
      division_id: fk('divisions'),
      bbs_code: { type: DataTypes.CHAR(4), allowNull: false },
      lat: latLng(true),
      lng: latLng(true),
      ...audit(),
    });
    await queryInterface.addIndex('districts', ['key'], { unique: true, name: 'uq_districts_key' });
    await queryInterface.addIndex('districts', ['bbs_code'], { unique: true, name: 'uq_districts_bbs_code' });
    await queryInterface.addIndex('districts', ['division_id'], { name: 'ix_districts_division' });

    await h.createTable(queryInterface, 'areas', {
      ...base(),
      district_id: fk('districts'),
      parent_area_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'areas', key: 'id' }, onDelete: 'RESTRICT' },
      lat: latLng(false),
      lng: latLng(false),
      is_dhaka_metro: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      dhaka_zone: { type: h.ENUM('north', 'south'), allowNull: true },
      aliases: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
      // Bits: 1 grounds listing enabled, 2 delivery (M13).
      service_flags: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      ...audit(),
    });
    await queryInterface.addIndex('areas', ['key'], { unique: true, name: 'uq_areas_key' });
    await queryInterface.addIndex('areas', ['district_id'], { name: 'ix_areas_district' });
    await queryInterface.sequelize.query('CREATE INDEX ix_areas_aliases ON areas USING GIN (aliases)');
    await queryInterface.sequelize.query('CREATE INDEX ix_areas_name_trgm ON areas USING GIN (name_en gin_trgm_ops)');
    await queryInterface.sequelize.query('ALTER TABLE areas ADD CONSTRAINT chk_areas_zone CHECK (dhaka_zone IS NULL OR is_dhaka_metro)');

    await h.createTable(queryInterface, 'facilities', { ...base(), icon: { type: DataTypes.STRING(40), allowNull: true }, ...audit() });
    await queryInterface.addIndex('facilities', ['key'], { unique: true, name: 'uq_facilities_key' });

    await h.createTable(queryInterface, 'surfaces', { ...base(), indoor_typical: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, ...audit() });
    await queryInterface.addIndex('surfaces', ['key'], { unique: true, name: 'uq_surfaces_key' });
  },

  async down(queryInterface) {
    for (const t of ['surfaces', 'facilities', 'areas', 'districts', 'divisions', 'sports']) await queryInterface.dropTable(t);
    // pg_trgm stays: dropping an extension other objects may use is not this migration's call.
  },
};
