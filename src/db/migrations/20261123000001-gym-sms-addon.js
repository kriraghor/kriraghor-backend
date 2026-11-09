'use strict';

/**
 * M24 prompt 3b, the SMS add-on (M24-FR-96 to FR-100, §6.7, §7.2), owned by gym-manage. Built against the
 * test SMS driver and kept off (gym_saas.sms_addon_enabled = false) until the SMS gateway is signed (G9).
 *  - gym_owner_addons: the owner's add-on (active, paused, ended) with the price snapshot when switched on;
 *    one live row per owner and add-on.
 *  - gym_sms_entries: the owner's SMS units, append-only; the balance is Σ units. Kinds grant, purchase,
 *    reserve, settle, expire, adjust; a reserve and its settle share a billing_ref.
 *  - gym_payment_links.short_code: a 10-character code for the short pay link in an SMS
 *    (gym.kriraghor.com/p/<code>), unique while set; links made before keep their long token only.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ type: DataTypes.UUID, allowNull: true, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const index = (name, sql) => h.ensureIndexSql(queryInterface, name, sql);

    await h.ensureTable(queryInterface, 'gym_owner_addons', {
      id: { ...uuid, primaryKey: true },
      subscription_id: fk('gym_owner_subscriptions'),
      owner_id: fk('users'),
      addon: { type: h.ENUM('sms'), allowNull: false },
      status: { type: h.ENUM('active', 'paused', 'ended'), allowNull: false, defaultValue: 'active' },
      price_poisha: { type: DataTypes.BIGINT, allowNull: false },
      started_at: { type: h.TS, allowNull: false },
      paused_at: { type: h.TS, allowNull: true },
      ended_at: { type: h.TS, allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_owner_addons', 'chk_gym_owner_addons', "CHECK (price_poisha >= 0 AND ((status = 'ended') = (ended_at IS NOT NULL)))");
    await index('uq_gym_owner_addons_live', "CREATE UNIQUE INDEX uq_gym_owner_addons_live ON gym_owner_addons (owner_id, addon) WHERE status IN ('active', 'paused')");

    await h.ensureTable(queryInterface, 'gym_sms_entries', {
      id: { ...uuid, primaryKey: true },
      owner_id: fk('users'),
      kind: { type: h.ENUM('grant', 'purchase', 'reserve', 'settle', 'expire', 'adjust'), allowNull: false },
      units: { type: DataTypes.INTEGER, allowNull: false },
      expires_on: { type: DataTypes.DATEONLY, allowNull: true },
      billing_ref: { type: DataTypes.UUID, allowNull: true },
      invoice_id: optFk('gym_subscription_invoices'),
      gym_id: optFk('gyms'),
      reminder_id: optFk('gym_reminders'),
      note: { type: DataTypes.STRING(200), allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      created_at: now,
    });
    // A settle may be 0 (the message used exactly what was held); it still closes the reservation.
    await h.ensureCheck(queryInterface, 'gym_sms_entries', 'chk_gym_sms_entries', "CHECK ((units <> 0 OR kind = 'settle') AND (kind NOT IN ('reserve', 'settle') OR billing_ref IS NOT NULL) AND (kind <> 'reserve' OR units < 0))");
    await index('uq_gym_sms_entries_ref', 'CREATE UNIQUE INDEX uq_gym_sms_entries_ref ON gym_sms_entries (billing_ref, kind) WHERE billing_ref IS NOT NULL');
    await index('ix_gym_sms_entries_owner', 'CREATE INDEX ix_gym_sms_entries_owner ON gym_sms_entries (owner_id, created_at)');
    await index('ix_gym_sms_entries_open', "CREATE INDEX ix_gym_sms_entries_open ON gym_sms_entries (created_at) WHERE kind = 'reserve'");
    await h.ensureAppendOnly(queryInterface, 'gym_sms_entries');

    await h.ensureColumn(queryInterface, 'gym_payment_links', 'short_code', { type: DataTypes.STRING(10), allowNull: true });
    await index('uq_gym_payment_links_short_code', 'CREATE UNIQUE INDEX uq_gym_payment_links_short_code ON gym_payment_links (short_code) WHERE short_code IS NOT NULL');
  },

  // Expand only: the tables and the column stay.
  async down() {},
};
