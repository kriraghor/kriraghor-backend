'use strict';

/**
 * M03 hire taxonomy for M11 (M03-FR-08, §7): hire_categories and hire_roles. Same base columns and
 * rules as the other catalogues: rows are never deleted (is_active) and keys are immutable.
 *  - hire_categories.for_role: the platform role that works in the category (category 01 is for
 *    `player`, the rest for `pro`, Q2).
 *  - hire_roles: allowed units (hourly, match); format_priced roles price each match format (cricket
 *    T10, T20, OD, TAPE; Q73); base_hourly_poisha is the suggested rate the M03 multipliers and the
 *    rate band apply to (rate limits per role and unit, Q74); credential tiers name the four
 *    experience levels for the role; requires_credential and police_check_for_u16 gate the profile
 *    and under-16 jobs.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const base = () => ({
      id: { ...uuid, primaryKey: true },
      key: { type: DataTypes.STRING(40), allowNull: false },
      name_en: { type: DataTypes.STRING(80), allowNull: false },
      name_bn: { type: DataTypes.STRING(80), allowNull: false },
      sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    });
    const audit = () => ({ created_by: { type: DataTypes.UUID, allowNull: true }, updated_by: { type: DataTypes.UUID, allowNull: true }, created_at: now, updated_at: now });
    const q = (sql) => queryInterface.sequelize.query(sql);

    await h.createTable(queryInterface, 'hire_categories', {
      ...base(),
      code: { type: DataTypes.CHAR(2), allowNull: false },
      for_role: { type: h.ENUM('player', 'pro'), allowNull: false },
      tint: { type: DataTypes.STRING(9), allowNull: true },
      ...audit(),
    });
    await queryInterface.addIndex('hire_categories', ['key'], { unique: true, name: 'uq_hire_categories_key' });
    await queryInterface.addIndex('hire_categories', ['code'], { unique: true, name: 'uq_hire_categories_code' });

    await h.createTable(queryInterface, 'hire_roles', {
      ...base(),
      category_id: { ...uuid, references: { model: 'hire_categories', key: 'id' }, onDelete: 'RESTRICT' },
      sport_keys: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
      allowed_units: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false },
      format_priced: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      formats: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
      base_hourly_poisha: { type: DataTypes.BIGINT, allowNull: false },
      specialisations: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      credential_tiers: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      requires_credential: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      police_check_for_u16: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      is_official: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      ...audit(),
    });
    await queryInterface.addIndex('hire_roles', ['key'], { unique: true, name: 'uq_hire_roles_key' });
    await queryInterface.addIndex('hire_roles', ['category_id'], { name: 'ix_hire_roles_category' });
    await q("ALTER TABLE hire_roles ADD CONSTRAINT chk_hire_roles_units CHECK (cardinality(allowed_units) >= 1 AND allowed_units <@ ARRAY['hourly', 'match']::text[])");
    await q("ALTER TABLE hire_roles ADD CONSTRAINT chk_hire_roles_formats CHECK (formats <@ ARRAY['T10', 'T20', 'OD', 'TAPE']::text[] AND (NOT format_priced OR (cardinality(formats) >= 1 AND 'match' = ANY (allowed_units))))");
    await q('ALTER TABLE hire_roles ADD CONSTRAINT chk_hire_roles_rate CHECK (base_hourly_poisha > 0)');
  },

  async down(queryInterface) {
    for (const t of ['hire_roles', 'hire_categories']) await queryInterface.dropTable(t);
  },
};
