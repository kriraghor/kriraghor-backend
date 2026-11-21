'use strict';

/**
 * M24 §25 WhatsApp, step 2: the owner's WhatsApp units (product owner, 21 Nov 2026: Kriraghor pays Meta and
 * resells units, like the SMS bundles), owned by gym-manage beside the SMS add-on:
 *  - gym_owner_addons.addon gains 'whatsapp' (the column was VARCHAR(3) for 'sms'; widened first);
 *  - gym_whatsapp_entries: the owner's WhatsApp units, append-only; the balance is Σ units. Kinds grant,
 *    purchase, reserve, settle, expire, adjust; a reserve and its settle share a billing_ref. A message
 *    holds its units when queued (reserve) and is settled when Meta reports it delivered (settle 0) or
 *    failed, or after a day without delivery (settle gives the units back);
 *  - bundle invoices: gym_subscription_invoices.kind and the line kind gain 'whatsapp_bundle'.
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
    const q = (sql) => queryInterface.sequelize.query(sql);

    // The add-on: 'whatsapp' beside 'sms'.
    await q('ALTER TABLE gym_owner_addons ALTER COLUMN addon TYPE VARCHAR(8)');
    await h.replaceEnumCheck(queryInterface, 'gym_owner_addons', 'addon', ['sms', 'whatsapp']);

    // Bundle invoices and their line.
    await q('ALTER TABLE gym_subscription_invoices ALTER COLUMN kind TYPE VARCHAR(15)');
    await h.replaceEnumCheck(queryInterface, 'gym_subscription_invoices', 'kind', ['monthly', 'sms_bundle', 'whatsapp_bundle']);
    await h.replaceEnumCheck(queryInterface, 'gym_subscription_invoice_lines', 'kind', ['tier', 'proration', 'founding_free', 'founding_discount', 'referral', 'sms_addon', 'sms_bundle', 'whatsapp_bundle', 'vat', 'adjustment']);

    await h.ensureTable(queryInterface, 'gym_whatsapp_entries', {
      id: { ...uuid, primaryKey: true },
      owner_id: fk('users'),
      kind: { type: h.ENUM('grant', 'purchase', 'reserve', 'settle', 'expire', 'adjust'), allowNull: false },
      units: { type: DataTypes.INTEGER, allowNull: false },
      expires_on: { type: DataTypes.DATEONLY, allowNull: true },
      billing_ref: { type: DataTypes.UUID, allowNull: true },
      invoice_id: optFk('gym_subscription_invoices'),
      gym_id: optFk('gyms'),
      note: { type: DataTypes.STRING(200), allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      created_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_whatsapp_entries', 'chk_gym_whatsapp_entries', "CHECK ((units <> 0 OR kind = 'settle') AND (kind NOT IN ('reserve', 'settle') OR billing_ref IS NOT NULL) AND (kind <> 'reserve' OR units < 0))");
    await index('uq_gym_whatsapp_entries_ref', 'CREATE UNIQUE INDEX uq_gym_whatsapp_entries_ref ON gym_whatsapp_entries (billing_ref, kind) WHERE billing_ref IS NOT NULL');
    await index('ix_gym_whatsapp_entries_owner', 'CREATE INDEX ix_gym_whatsapp_entries_owner ON gym_whatsapp_entries (owner_id, created_at)');
    await h.ensureAppendOnly(queryInterface, 'gym_whatsapp_entries');
  },

  // Expand only: the table and the wider value lists stay.
  async down() {},
};
