'use strict';

/**
 * Round B3 business members (migration 20261111000001): staff accounts working at one venue, gym or
 * shop for its owner (Q69, Q169, Q170). Owned by the business-members module (identity group,
 * ADR-007); index.js re-exports it.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');

class BusinessMember extends Model {}
BusinessMember.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() },
    businessType: { type: DataTypes.ENUM('venue', 'gym', 'shop'), allowNull: false },
    businessId: { type: DataTypes.UUID, allowNull: false },
    ownerId: { type: DataTypes.UUID, allowNull: false },
    memberId: { type: DataTypes.UUID, allowNull: false },
    permissions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    status: { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
    addedBy: DataTypes.UUID,
    removedBy: DataTypes.UUID,
    removedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'BusinessMember', tableName: 'business_members' }
);

module.exports = { BusinessMember };
