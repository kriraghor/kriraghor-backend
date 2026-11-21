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
    // Step 2 (migration 20261202000004): the number this branch sends from, and the automatic kinds on.
    senderId: DataTypes.UUID,
    autoKinds: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
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

const KINDS = ['receipt', 'renewal_due', 'ends_today', 'overdue', 'pay_link', 'notice', 'greeting', 'single'];

/** Step 2: a WhatsApp Business number connected through Meta's embedded sign-up; `tokenEnc` never leaves the module. */
class GymWhatsappSender extends Model {}
GymWhatsappSender.init(
  {
    id,
    ownerId: req(DataTypes.UUID),
    wabaId: req(DataTypes.STRING(32)),
    phoneNumberId: req(DataTypes.STRING(32)),
    displayNumber: req(DataTypes.STRING(24)),
    verifiedName: DataTypes.STRING(120),
    tokenEnc: req(DataTypes.TEXT),
    status: enumOf(['connected', 'restricted', 'disconnected'], { defaultValue: 'connected' }),
    quality: DataTypes.STRING(12),
    messagingLimit: DataTypes.STRING(24),
    creditAttached: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    connectedBy: req(DataTypes.UUID),
    connectedAt: req(DataTypes.DATE(3)),
    disconnectedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'GymWhatsappSender', tableName: 'gym_whatsapp_senders' }
);

class GymWhatsappTemplate extends Model {}
GymWhatsappTemplate.init(
  {
    id,
    senderId: req(DataTypes.UUID),
    code: req(DataTypes.STRING(30)),
    locale: enumOf(['en', 'bn']),
    category: enumOf(['utility', 'marketing']),
    metaId: DataTypes.STRING(40),
    status: enumOf(['pending', 'approved', 'rejected', 'paused', 'disabled'], { defaultValue: 'pending' }),
    reason: DataTypes.STRING(200),
  },
  { sequelize, modelName: 'GymWhatsappTemplate', tableName: 'gym_whatsapp_templates' }
);

class GymWhatsappSend extends Model {}
GymWhatsappSend.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    ownerId: req(DataTypes.UUID),
    kind: enumOf(['notice', 'greeting', 'single']),
    template: req(DataTypes.STRING(30)),
    params: { type: DataTypes.JSONB, allowNull: false },
    segment: DataTypes.JSONB,
    memberId: DataTypes.UUID,
    targetCount: req(DataTypes.INTEGER),
    queuedCount: req(DataTypes.INTEGER),
    unitsHeld: req(DataTypes.INTEGER),
    localDate: req(DataTypes.DATEONLY),
    sentBy: req(DataTypes.UUID),
  },
  { sequelize, modelName: 'GymWhatsappSend', tableName: 'gym_whatsapp_sends', updatedAt: false }
);

class GymWhatsappMessage extends Model {}
GymWhatsappMessage.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    ownerId: req(DataTypes.UUID),
    memberId: req(DataTypes.UUID),
    sendId: DataTypes.UUID,
    senderId: req(DataTypes.UUID),
    kind: enumOf(KINDS),
    template: req(DataTypes.STRING(30)),
    locale: enumOf(['en', 'bn']),
    category: enumOf(['utility', 'marketing']),
    params: { type: DataTypes.JSONB, allowNull: false },
    subjectId: DataTypes.UUID,
    units: req(DataTypes.INTEGER),
    billingRef: req(DataTypes.UUID),
    status: enumOf(['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'expired'], { defaultValue: 'queued' }),
    sendAfter: req(DataTypes.DATE(3)),
    wamid: DataTypes.STRING(128),
    errorCode: DataTypes.STRING(24),
    sentAt: DataTypes.DATE(3),
    deliveredAt: DataTypes.DATE(3),
    readAt: DataTypes.DATE(3),
    failedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'GymWhatsappMessage', tableName: 'gym_whatsapp_messages' }
);

module.exports = { GymWhatsappOwner, GymWhatsappGym, GymWhatsappConsent, GymWhatsappSender, GymWhatsappTemplate, GymWhatsappSend, GymWhatsappMessage };
