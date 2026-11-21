'use strict';

/**
 * M24 §25 WhatsApp (migration 20261202000001), owned by the gym-whatsapp module (gym group, ADR-007):
 * the chat numbers of an owner and of each branch, and members' WhatsApp numbers with their consents.
 * index.js re-exports them. `numberEnc` holds a common/crypto envelope and never leaves the module.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const req = (type) => ({ type, allowNull: false });
const enumOf = (values, extra = {}) => ({ type: DataTypes.ENUM(...values), allowNull: false, ...extra });

class GymWhatsappOwner extends Model {}
GymWhatsappOwner.init(
  {
    ownerId: { type: DataTypes.UUID, primaryKey: true },
    number: DataTypes.STRING(16),
    updatedBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymWhatsappOwner', tableName: 'gym_whatsapp_owners' }
);

class GymWhatsappGym extends Model {}
GymWhatsappGym.init(
  {
    gymId: { type: DataTypes.UUID, primaryKey: true },
    ownerId: req(DataTypes.UUID),
    number: DataTypes.STRING(16),
    showOnPage: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    updatedBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymWhatsappGym', tableName: 'gym_whatsapp_gyms' }
);

class GymWhatsappConsent extends Model {}
GymWhatsappConsent.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    memberId: req(DataTypes.UUID),
    numberEnc: req(DataTypes.TEXT),
    numberHash: req(DataTypes.STRING(64)),
    numberLast4: req(DataTypes.STRING(4)),
    service: req(DataTypes.BOOLEAN),
    news: req(DataTypes.BOOLEAN),
    consentVersion: req(DataTypes.INTEGER),
    source: enumOf(['member', 'desk', 'stop_reply']),
    changedBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymWhatsappConsent', tableName: 'gym_whatsapp_consents', updatedAt: false }
);

module.exports = { GymWhatsappOwner, GymWhatsappGym, GymWhatsappConsent };
