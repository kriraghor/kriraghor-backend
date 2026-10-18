'use strict';

/**
 * M03 catalogues for M09 and later verticals (migration 20261024000001-create-places-catalog):
 * sports, divisions, districts, areas, facilities, surfaces. index.js re-exports them.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');

const base = () => ({
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
  key: { type: DataTypes.STRING(40), allowNull: false },
  nameEn: { type: DataTypes.STRING(80), allowNull: false },
  nameBn: { type: DataTypes.STRING(80), allowNull: false },
  sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  createdBy: DataTypes.UUID,
  updatedBy: DataTypes.UUID,
});
// DECIMAL comes back from pg as a string; coordinates are read as numbers.
const coord = (field, allowNull) => ({
  type: DataTypes.DECIMAL(9, 6),
  allowNull,
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : Number(v);
  },
});

class Sport extends Model {}
Sport.init(
  {
    ...base(),
    engine: { type: DataTypes.ENUM('ball_by_ball', 'clock', 'rally', 'none'), allowNull: false },
    officialLabelEn: DataTypes.STRING(40),
    officialLabelBn: DataTypes.STRING(40),
    defaultTiebreakers: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
    verticalFlags: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    icon: DataTypes.STRING(40),
    tint: DataTypes.STRING(16),
    // M16: positions a player can list, [{ key, en, bn }].
    positions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  },
  { sequelize, modelName: 'Sport', tableName: 'sports' }
);

class Division extends Model {}
Division.init({ ...base(), bbsCode: { type: DataTypes.CHAR(2), allowNull: false } }, { sequelize, modelName: 'Division', tableName: 'divisions' });

class District extends Model {}
District.init(
  { ...base(), divisionId: { type: DataTypes.UUID, allowNull: false }, bbsCode: { type: DataTypes.CHAR(4), allowNull: false }, lat: coord('lat', true), lng: coord('lng', true) },
  { sequelize, modelName: 'District', tableName: 'districts' }
);

class Area extends Model {}
Area.init(
  {
    ...base(),
    districtId: { type: DataTypes.UUID, allowNull: false },
    parentAreaId: DataTypes.UUID,
    lat: coord('lat', false),
    lng: coord('lng', false),
    isDhakaMetro: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    dhakaZone: DataTypes.ENUM('north', 'south'),
    aliases: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
    serviceFlags: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  { sequelize, modelName: 'Area', tableName: 'areas' }
);

class Facility extends Model {}
Facility.init({ ...base(), icon: DataTypes.STRING(40) }, { sequelize, modelName: 'Facility', tableName: 'facilities' });

class Surface extends Model {}
Surface.init({ ...base(), indoorTypical: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false } }, { sequelize, modelName: 'Surface', tableName: 'surfaces' });

District.belongsTo(Division, { as: 'division', foreignKey: 'divisionId' });
Area.belongsTo(District, { as: 'district', foreignKey: 'districtId' });

/** Area service flags (bits). */
const AREA_FLAGS = { GROUNDS: 1, DELIVERY: 2 };

module.exports = { Sport, Division, District, Area, Facility, Surface, AREA_FLAGS };
