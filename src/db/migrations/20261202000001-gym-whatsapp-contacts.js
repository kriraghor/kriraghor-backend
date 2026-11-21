'use strict';

/**
 * M24 §25 WhatsApp, step 1 (tester feedback item 5, 19 and 21 Nov 2026), owned by the gym-whatsapp module:
 *  - gym_whatsapp_owners: the owner's chat number used by every branch (M24-FR-157);
 *  - gym_whatsapp_gyms: a branch's own chat number, which wins over the owner's, and whether the gym page
 *    shows a WhatsApp button (M24-FR-157, FR-158);
 *  - gym_whatsapp_consents: a member's WhatsApp number and two consents (receipts and reminders; news and
 *    offers), append-only: the latest row per member is the current one (M24-FR-159, FR-160).
 * Chat numbers are the business's public contact, kept as E.164 text. A member's number is personal data:
 * encrypted (common/crypto), with a keyed hash (to match a STOP reply) and the last 4 digits for display.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const index = (name, sql) => h.ensureIndexSql(queryInterface, name, sql);
    const E164 = "~ '^\\+8801[3-9][0-9]{8}$'";

    await h.ensureTable(queryInterface, 'gym_whatsapp_owners', {
      owner_id: { ...fk('users'), primaryKey: true },
      number: { type: DataTypes.STRING(16), allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_whatsapp_owners', 'chk_gym_whatsapp_owners_number', `CHECK (number IS NULL OR number ${E164})`);

    await h.ensureTable(queryInterface, 'gym_whatsapp_gyms', {
      gym_id: { ...fk('gyms'), primaryKey: true },
      owner_id: fk('users'),
      number: { type: DataTypes.STRING(16), allowNull: true },
      show_on_page: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_whatsapp_gyms', 'chk_gym_whatsapp_gyms_number', `CHECK (number IS NULL OR number ${E164})`);
    await index('ix_gym_whatsapp_gyms_owner', 'CREATE INDEX ix_gym_whatsapp_gyms_owner ON gym_whatsapp_gyms (owner_id)');

    await h.ensureTable(queryInterface, 'gym_whatsapp_consents', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      member_id: fk('gym_members'),
      number_enc: { type: DataTypes.TEXT, allowNull: false },
      number_hash: { type: DataTypes.STRING(64), allowNull: false },
      number_last4: { type: DataTypes.STRING(4), allowNull: false },
      service: { type: DataTypes.BOOLEAN, allowNull: false },
      news: { type: DataTypes.BOOLEAN, allowNull: false },
      consent_version: { type: DataTypes.INTEGER, allowNull: false },
      source: { type: h.ENUM('member', 'desk', 'stop_reply'), allowNull: false },
      changed_by: { type: DataTypes.UUID, allowNull: true },
      created_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_whatsapp_consents', 'chk_gym_whatsapp_consents', "CHECK (consent_version > 0 AND number_last4 ~ '^[0-9]{4}$' AND (source = 'stop_reply' OR changed_by IS NOT NULL))");
    await index('ix_gym_whatsapp_consents_member', 'CREATE INDEX ix_gym_whatsapp_consents_member ON gym_whatsapp_consents (member_id, created_at DESC, id DESC)');
    await index('ix_gym_whatsapp_consents_hash', 'CREATE INDEX ix_gym_whatsapp_consents_hash ON gym_whatsapp_consents (number_hash)');
    await h.ensureAppendOnly(queryInterface, 'gym_whatsapp_consents');
  },

  // Expand only: the tables stay.
  async down() {},
};
