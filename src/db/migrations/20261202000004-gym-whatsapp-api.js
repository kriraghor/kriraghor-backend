'use strict';

/**
 * M24 §25 WhatsApp, step 2 (built switched off: gym_whatsapp.api_enabled), owned by the gym-whatsapp module:
 *  - gym_whatsapp_senders: a gym owner's WhatsApp Business number connected through Meta's embedded sign-up
 *    (coexistence: the gym keeps answering in its WhatsApp Business phone app). The access token is
 *    encrypted (common/crypto); one live row per Meta phone number id.
 *  - gym_whatsapp_templates: Kriraghor's message templates created in that account, per code and language,
 *    with Meta's approval state.
 *  - gym_whatsapp_gyms gains the number a branch sends from and the automatic kinds switched on.
 *  - gym_whatsapp_sends: a bulk or single send from the panel (who, what, to which segment, how many).
 *  - gym_whatsapp_messages: one row per message to one member, from queued to delivered, read or failed,
 *    with its unit hold (billing_ref) and Meta's message id. No phone number and no free text of a member
 *    is stored here; automatic messages are once per subject (the receipt, the reminder).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ type: DataTypes.UUID, allowNull: true, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const index = (name, sql) => h.ensureIndexSql(queryInterface, name, sql);
    const KINDS = ['receipt', 'renewal_due', 'ends_today', 'overdue', 'pay_link', 'notice', 'greeting', 'single'];

    await h.ensureTable(queryInterface, 'gym_whatsapp_senders', {
      id: { ...uuid, primaryKey: true },
      owner_id: fk('users'),
      waba_id: { type: DataTypes.STRING(32), allowNull: false },
      phone_number_id: { type: DataTypes.STRING(32), allowNull: false },
      display_number: { type: DataTypes.STRING(24), allowNull: false },
      verified_name: { type: DataTypes.STRING(120), allowNull: true },
      token_enc: { type: DataTypes.TEXT, allowNull: false },
      status: { type: h.ENUM('connected', 'restricted', 'disconnected'), allowNull: false, defaultValue: 'connected' },
      quality: { type: DataTypes.STRING(12), allowNull: true },
      messaging_limit: { type: DataTypes.STRING(24), allowNull: true },
      credit_attached: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      connected_by: { type: DataTypes.UUID, allowNull: false },
      connected_at: { type: h.TS, allowNull: false },
      disconnected_at: at,
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_whatsapp_senders', 'chk_gym_whatsapp_senders', "CHECK ((status = 'disconnected') = (disconnected_at IS NOT NULL))");
    await index('uq_gym_whatsapp_senders_live', "CREATE UNIQUE INDEX uq_gym_whatsapp_senders_live ON gym_whatsapp_senders (phone_number_id) WHERE status <> 'disconnected'");
    await index('ix_gym_whatsapp_senders_owner', 'CREATE INDEX ix_gym_whatsapp_senders_owner ON gym_whatsapp_senders (owner_id)');

    await h.ensureTable(queryInterface, 'gym_whatsapp_templates', {
      id: { ...uuid, primaryKey: true },
      sender_id: fk('gym_whatsapp_senders'),
      code: { type: DataTypes.STRING(30), allowNull: false },
      locale: { type: h.ENUM('en', 'bn'), allowNull: false },
      category: { type: h.ENUM('utility', 'marketing'), allowNull: false },
      meta_id: { type: DataTypes.STRING(40), allowNull: true },
      status: { type: h.ENUM('pending', 'approved', 'rejected', 'paused', 'disabled'), allowNull: false, defaultValue: 'pending' },
      reason: { type: DataTypes.STRING(200), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await index('uq_gym_whatsapp_templates', 'CREATE UNIQUE INDEX uq_gym_whatsapp_templates ON gym_whatsapp_templates (sender_id, code, locale)');

    await h.ensureColumn(queryInterface, 'gym_whatsapp_gyms', 'sender_id', optFk('gym_whatsapp_senders'));
    await h.ensureColumn(queryInterface, 'gym_whatsapp_gyms', 'auto_kinds', { type: DataTypes.JSONB, allowNull: false, defaultValue: Sequelize.literal("'[]'::jsonb") });

    await h.ensureTable(queryInterface, 'gym_whatsapp_sends', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      owner_id: fk('users'),
      kind: { type: h.ENUM('notice', 'greeting', 'single'), allowNull: false },
      template: { type: DataTypes.STRING(30), allowNull: false },
      params: { type: DataTypes.JSONB, allowNull: false },
      segment: { type: DataTypes.JSONB, allowNull: true },
      member_id: optFk('gym_members'),
      target_count: { type: DataTypes.INTEGER, allowNull: false },
      queued_count: { type: DataTypes.INTEGER, allowNull: false },
      units_held: { type: DataTypes.INTEGER, allowNull: false },
      local_date: { type: DataTypes.DATEONLY, allowNull: false },
      sent_by: { type: DataTypes.UUID, allowNull: false },
      created_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_whatsapp_sends', 'chk_gym_whatsapp_sends', "CHECK (target_count >= queued_count AND queued_count >= 0 AND units_held >= 0 AND ((kind = 'single') = (member_id IS NOT NULL)))");
    await index('ix_gym_whatsapp_sends_gym', 'CREATE INDEX ix_gym_whatsapp_sends_gym ON gym_whatsapp_sends (gym_id, created_at DESC)');
    await h.ensureAppendOnly(queryInterface, 'gym_whatsapp_sends');

    await h.ensureTable(queryInterface, 'gym_whatsapp_messages', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      owner_id: fk('users'),
      member_id: fk('gym_members'),
      send_id: optFk('gym_whatsapp_sends'),
      sender_id: fk('gym_whatsapp_senders'),
      kind: { type: h.ENUM(...KINDS), allowNull: false },
      template: { type: DataTypes.STRING(30), allowNull: false },
      locale: { type: h.ENUM('en', 'bn'), allowNull: false },
      category: { type: h.ENUM('utility', 'marketing'), allowNull: false },
      params: { type: DataTypes.JSONB, allowNull: false },
      subject_id: { type: DataTypes.UUID, allowNull: true },
      units: { type: DataTypes.INTEGER, allowNull: false },
      billing_ref: { type: DataTypes.UUID, allowNull: false },
      status: { type: h.ENUM('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'expired'), allowNull: false, defaultValue: 'queued' },
      send_after: { type: h.TS, allowNull: false },
      wamid: { type: DataTypes.STRING(128), allowNull: true },
      error_code: { type: DataTypes.STRING(24), allowNull: true },
      sent_at: at,
      delivered_at: at,
      read_at: at,
      failed_at: at,
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_whatsapp_messages', 'chk_gym_whatsapp_messages', "CHECK (units > 0 AND (status <> 'failed' OR failed_at IS NOT NULL))");
    await index('uq_gym_whatsapp_messages_ref', 'CREATE UNIQUE INDEX uq_gym_whatsapp_messages_ref ON gym_whatsapp_messages (billing_ref)');
    await index('uq_gym_whatsapp_messages_wamid', 'CREATE UNIQUE INDEX uq_gym_whatsapp_messages_wamid ON gym_whatsapp_messages (wamid) WHERE wamid IS NOT NULL');
    // An automatic message goes once per subject (a receipt, a reminder, a payment link).
    await index('uq_gym_whatsapp_messages_subject', "CREATE UNIQUE INDEX uq_gym_whatsapp_messages_subject ON gym_whatsapp_messages (kind, subject_id) WHERE subject_id IS NOT NULL AND kind IN ('receipt', 'renewal_due', 'ends_today', 'overdue', 'pay_link')");
    await index('ix_gym_whatsapp_messages_due', "CREATE INDEX ix_gym_whatsapp_messages_due ON gym_whatsapp_messages (send_after) WHERE status = 'queued'");
    await index('ix_gym_whatsapp_messages_member', 'CREATE INDEX ix_gym_whatsapp_messages_member ON gym_whatsapp_messages (member_id, created_at DESC)');
    await index('ix_gym_whatsapp_messages_send', 'CREATE INDEX ix_gym_whatsapp_messages_send ON gym_whatsapp_messages (send_id) WHERE send_id IS NOT NULL');
  },

  // Expand only: the tables and columns stay.
  async down() {},
};
