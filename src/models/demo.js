'use strict';

/**
 * Demo data (migration 20261107000001): which records the demo seeder created. Owned by
 * src/modules/demo; index.js re-exports it.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');

const DEMO_ENTITIES = ['user', 'staff', 'ground', 'shop', 'product', 'gym', 'hire_profile', 'organisation', 'sports_tournament', 'esports_tournament', 'esports_event', 'team'];

class DemoRecord extends Model {}
DemoRecord.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    runId: { type: DataTypes.STRING(40), allowNull: false },
    profile: { type: DataTypes.ENUM('listings', 'full'), allowNull: false },
    entity: { type: DataTypes.ENUM(...DEMO_ENTITIES), allowNull: false },
    entityId: { type: DataTypes.UUID, allowNull: false },
    label: { type: DataTypes.STRING(120), allowNull: true },
  },
  { sequelize, modelName: 'DemoRecord', tableName: 'demo_records', updatedAt: false }
);

module.exports = { DemoRecord, DEMO_ENTITIES };
