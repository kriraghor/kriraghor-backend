'use strict';

/**
 * M03 item catalogue for M12 (M03-FR-09, §7; Q77): item_categories, item_types, item_type_fields.
 * Same base columns and rules as the other catalogues: rows are never deleted (is_active) and keys
 * are immutable. M12 validates product specs against item_type_fields; fields flagged
 * is_variant_axis (size, flavour, weight) become the variant attributes.
 *  - item_categories.shop_types: the shop types that may sell in the category (market.shop_types);
 *    is_supplement marks categories whose products need importer or BSTI details (v3).
 *  - item_types: the price range a product must fall in (FR-03 automatic check).
 *  - item_type_fields: key unique per item type; select options are [{ value, labelEn, labelBn }].
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
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

    await h.createTable(queryInterface, 'item_categories', {
      ...base(),
      sport_key: { type: DataTypes.STRING(40), allowNull: true },
      shop_types: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
      is_supplement: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      icon: { type: DataTypes.STRING(40), allowNull: true },
      ...audit(),
    });
    await queryInterface.addIndex('item_categories', ['key'], { unique: true, name: 'uq_item_categories_key' });
    await q('ALTER TABLE item_categories ADD CONSTRAINT chk_item_categories_shop_types CHECK (cardinality(shop_types) >= 1)');

    await h.createTable(queryInterface, 'item_types', {
      ...base(),
      category_id: fk('item_categories'),
      price_floor_poisha: { type: DataTypes.BIGINT, allowNull: false },
      price_ceiling_poisha: { type: DataTypes.BIGINT, allowNull: false },
      placeholder_en: { type: DataTypes.STRING(120), allowNull: true },
      placeholder_bn: { type: DataTypes.STRING(120), allowNull: true },
      ...audit(),
    });
    await queryInterface.addIndex('item_types', ['key'], { unique: true, name: 'uq_item_types_key' });
    await queryInterface.addIndex('item_types', ['category_id'], { name: 'ix_item_types_category' });
    await q('ALTER TABLE item_types ADD CONSTRAINT chk_item_types_price CHECK (price_floor_poisha > 0 AND price_ceiling_poisha > price_floor_poisha)');

    await h.createTable(queryInterface, 'item_type_fields', {
      id: { ...uuid, primaryKey: true },
      item_type_id: fk('item_types'),
      key: { type: DataTypes.STRING(40), allowNull: false },
      label_en: { type: DataTypes.STRING(80), allowNull: false },
      label_bn: { type: DataTypes.STRING(80), allowNull: false },
      kind: { type: h.ENUM('select', 'number', 'text', 'date'), allowNull: false },
      options: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      unit: { type: DataTypes.STRING(16), allowNull: true },
      min_value: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
      max_value: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
      required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      is_variant_axis: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      ...audit(),
    });
    await queryInterface.addIndex('item_type_fields', ['item_type_id', 'key'], { unique: true, name: 'uq_item_type_fields_key' });
    // A variant axis is a pick-list (sizes, flavours), so the variants of a product are comparable.
    await q("ALTER TABLE item_type_fields ADD CONSTRAINT chk_item_type_fields_axis CHECK (NOT is_variant_axis OR kind = 'select')");
    await q('ALTER TABLE item_type_fields ADD CONSTRAINT chk_item_type_fields_range CHECK (min_value IS NULL OR max_value IS NULL OR max_value >= min_value)');
  },

  async down(queryInterface) {
    for (const t of ['item_type_fields', 'item_types', 'item_categories']) await queryInterface.dropTable(t);
  },
};
