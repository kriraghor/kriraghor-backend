'use strict';

/**
 * M03 item catalogue for M12 (migration 20261029000001-create-item-catalog): item_categories,
 * item_types, item_type_fields. index.js re-exports them.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');
const { toPoisha } = require('../common/money');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const by = { createdBy: DataTypes.UUID, updatedBy: DataTypes.UUID };
const names = {
  key: { type: DataTypes.STRING(40), allowNull: false },
  nameEn: { type: DataTypes.STRING(80), allowNull: false },
  nameBn: { type: DataTypes.STRING(80), allowNull: false },
  sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
};
const poisha = (field) => ({
  type: DataTypes.BIGINT,
  allowNull: false,
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? v : toPoisha(v);
  },
});
const decimal = (field) => ({
  type: DataTypes.DECIMAL(12, 2),
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : Number(v);
  },
});

class ItemCategory extends Model {}
ItemCategory.init(
  {
    id,
    ...names,
    sportKey: DataTypes.STRING(40),
    shopTypes: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
    isSupplement: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    icon: DataTypes.STRING(40),
    ...by,
  },
  { sequelize, modelName: 'ItemCategory', tableName: 'item_categories' }
);

class ItemType extends Model {}
ItemType.init(
  {
    id,
    ...names,
    categoryId: { type: DataTypes.UUID, allowNull: false },
    priceFloorPoisha: poisha('priceFloorPoisha'),
    priceCeilingPoisha: poisha('priceCeilingPoisha'),
    placeholderEn: DataTypes.STRING(120),
    placeholderBn: DataTypes.STRING(120),
    ...by,
  },
  { sequelize, modelName: 'ItemType', tableName: 'item_types' }
);

class ItemTypeField extends Model {}
ItemTypeField.init(
  {
    id,
    itemTypeId: { type: DataTypes.UUID, allowNull: false },
    key: { type: DataTypes.STRING(40), allowNull: false },
    labelEn: { type: DataTypes.STRING(80), allowNull: false },
    labelBn: { type: DataTypes.STRING(80), allowNull: false },
    kind: { type: DataTypes.ENUM('select', 'number', 'text', 'date'), allowNull: false },
    options: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    unit: DataTypes.STRING(16),
    minValue: decimal('minValue'),
    maxValue: decimal('maxValue'),
    required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isVariantAxis: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ...by,
  },
  { sequelize, modelName: 'ItemTypeField', tableName: 'item_type_fields' }
);

ItemType.belongsTo(ItemCategory, { as: 'category', foreignKey: 'categoryId' });
ItemType.hasMany(ItemTypeField, { as: 'fields', foreignKey: 'itemTypeId' });

module.exports = { ItemCategory, ItemType, ItemTypeField };
