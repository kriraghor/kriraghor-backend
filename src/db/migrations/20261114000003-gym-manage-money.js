'use strict';

/**
 * M24 Gym Management, prompt 2 (online money, reminders and billing, §7.2): seven more tables of the
 * gym-manage module (gym group, ADR-007), exactly as §7.2:
 *  - gym_payment_links: a link to pay one due online (one open link per due), its M06 payment, the
 *    hold's release time and what was refunded from the hold;
 *  - gym_reminders: the "sent once" log of member and owner notices (the unique key is inserted before
 *    the event is published, M24-FR-56);
 *  - gym_active_member_counts: one row per owner per Dhaka day (the tier that fits, §6.6);
 *  - gym_subscription_invoices and gym_subscription_invoice_lines (append-only): the owner's monthly
 *    invoice in arrears (GI-26-000123), paid through M06 purpose gym_saas_invoice;
 *  - gym_referrals: one referral fee per (gym, member) on the next invoice;
 *  - gym_fee_overrides: per-owner or per-gym rates of fees.gym_referral_poisha and fees.gym_pct.
 * The foreign key gym_fee_payments.link_id → gym_payment_links (left out in prompt 1) comes with it.
 * Money is BIGINT poisha, value lists are VARCHAR + named CHECK, "one active row" is a partial unique
 * index. Rows are never deleted.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const atReq = { type: h.TS, allowNull: false };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ ...optUuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const money = { type: DataTypes.BIGINT, allowNull: false };
    const money0 = { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 };
    const date = { type: DataTypes.DATEONLY, allowNull: false };
    const optDate = { type: DataTypes.DATEONLY, allowNull: true };
    const str = (n, allowNull = true) => ({ type: DataTypes.STRING(n), allowNull });
    const ts = () => ({ created_at: now, updated_at: now });
    const created = () => ({ created_at: now });
    const index = (name, sql) => h.ensureIndexSql(queryInterface, name, sql);
    const TIERS = ['free', 'basic', 'standard', 'pro'];

    // ---------------- gym_payment_links
    await h.ensureTable(queryInterface, 'gym_payment_links', {
      id: { ...uuid, primaryKey: true },
      due_id: fk('gym_dues'),
      member_id: fk('gym_members'),
      gym_id: fk('gyms'),
      owner_id: fk('users'),
      amount_poisha: money,
      token_nonce: str(24, false),
      origin: { type: h.ENUM('staff', 'member'), allowNull: false },
      channels: { type: DataTypes.JSONB, allowNull: false, defaultValue: Sequelize.literal("'[]'::jsonb") },
      status: { type: h.ENUM('open', 'paid', 'expired', 'cancelled'), allowNull: false, defaultValue: 'open' },
      expires_at: atReq,
      payment_id: optFk('payments'),
      paid_at: at,
      release_at: at,
      released_at: at,
      refunded_poisha: money0,
      created_by: optUuid,
      ...ts(),
    });
    await h.ensureCheck(
      queryInterface,
      'gym_payment_links',
      'chk_gym_payment_links',
      "CHECK (amount_poisha > 0 AND refunded_poisha BETWEEN 0 AND amount_poisha AND ((status = 'paid') = (paid_at IS NOT NULL)))"
    );
    await index('uq_gym_payment_links_open', "CREATE UNIQUE INDEX uq_gym_payment_links_open ON gym_payment_links (due_id) WHERE status = 'open'");
    await index('ix_gym_payment_links_expiry', "CREATE INDEX ix_gym_payment_links_expiry ON gym_payment_links (expires_at) WHERE status = 'open'");
    await index('ix_gym_payment_links_release', "CREATE INDEX ix_gym_payment_links_release ON gym_payment_links (release_at) WHERE status = 'paid' AND released_at IS NULL");
    await index('ix_gym_payment_links_payment', 'CREATE INDEX ix_gym_payment_links_payment ON gym_payment_links (payment_id)');

    // gym_fee_payments.link_id (prompt 1 kept it without a foreign key until this table existed).
    await h.ensureConstraintSql(queryInterface, 'gym_fee_payments', 'fk_gym_fee_payments_link', 'ALTER TABLE gym_fee_payments ADD CONSTRAINT fk_gym_fee_payments_link FOREIGN KEY (link_id) REFERENCES gym_payment_links (id) ON DELETE RESTRICT');

    // ---------------- gym_reminders
    await h.ensureTable(queryInterface, 'gym_reminders', {
      id: { ...uuid, primaryKey: true },
      owner_id: fk('users'),
      gym_id: optFk('gyms'),
      kind: { type: h.ENUM('renewal_due', 'ends_today', 'overdue', 'expired', 'receipt', 'pay_link', 'plan', 'morning', 'monthly', 'tier_notice', 'invoice_due', 'sms_low', 'sms_empty'), allowNull: false },
      subject_type: { type: h.ENUM('membership', 'due', 'fee_payment', 'link', 'assignment', 'gym', 'owner', 'invoice'), allowNull: false },
      subject_id: uuid,
      offset_key: str(20, false),
      member_id: optFk('gym_members'),
      channels: { type: DataTypes.JSONB, allowNull: false, defaultValue: Sequelize.literal("'[]'::jsonb") },
      sms_billing_ref: optUuid,
      status: { type: h.ENUM('published', 'skipped'), allowNull: false },
      skip_reason: str(12),
      ...created(),
    });
    await index('uq_gym_reminders_once', 'CREATE UNIQUE INDEX uq_gym_reminders_once ON gym_reminders (kind, subject_id, offset_key)');
    await index('ix_gym_reminders_gym', 'CREATE INDEX ix_gym_reminders_gym ON gym_reminders (gym_id, created_at) WHERE gym_id IS NOT NULL');
    await index('ix_gym_reminders_owner', 'CREATE INDEX ix_gym_reminders_owner ON gym_reminders (owner_id, created_at)');

    // ---------------- gym_active_member_counts
    await h.ensureTable(queryInterface, 'gym_active_member_counts', {
      owner_id: { ...fk('users'), primaryKey: true },
      local_date: { ...date, primaryKey: true },
      active_count: { type: DataTypes.INTEGER, allowNull: false },
      gyms_count: { type: DataTypes.INTEGER, allowNull: false },
      chosen_tier: { type: h.ENUM(...TIERS), allowNull: false },
      ...ts(),
    });
    await h.ensureCheck(queryInterface, 'gym_active_member_counts', 'chk_gym_active_member_counts', 'CHECK (active_count >= 0 AND gyms_count >= 0)');

    // ---------------- gym_subscription_invoices
    await h.ensureTable(queryInterface, 'gym_subscription_invoices', {
      id: { ...uuid, primaryKey: true },
      number: { ...str(24, false), unique: true },
      owner_id: fk('users'),
      subscription_id: fk('gym_owner_subscriptions'),
      kind: { type: h.ENUM('monthly', 'sms_bundle'), allowNull: false },
      period_start: optDate,
      period_end: optDate,
      billed_tier: { type: h.ENUM(...TIERS), allowNull: true },
      peak_active: { type: DataTypes.INTEGER, allowNull: true },
      subtotal_poisha: money,
      vat_poisha: money0,
      total_poisha: money,
      status: { type: h.ENUM('issued', 'overdue', 'paid', 'void'), allowNull: false, defaultValue: 'issued' },
      issued_at: atReq,
      due_at: atReq,
      paid_at: at,
      payment_id: optFk('payments'),
      voided_at: at,
      voided_by: optUuid,
      void_reason: str(300),
      settings_snapshot: { type: DataTypes.JSONB, allowNull: false },
      ...ts(),
    });
    await h.ensureCheck(
      queryInterface,
      'gym_subscription_invoices',
      'chk_gym_subscription_invoices',
      "CHECK (total_poisha = subtotal_poisha + vat_poisha AND total_poisha > 0 AND vat_poisha >= 0 AND ((kind = 'monthly') = (period_start IS NOT NULL AND period_end IS NOT NULL)) AND ((status = 'paid') = (paid_at IS NOT NULL)) AND ((status = 'void') = (voided_at IS NOT NULL)))"
    );
    await index('uq_gym_subscription_invoices_period', "CREATE UNIQUE INDEX uq_gym_subscription_invoices_period ON gym_subscription_invoices (subscription_id, period_start) WHERE kind = 'monthly' AND status <> 'void'");
    await index('ix_gym_subscription_invoices_owner', 'CREATE INDEX ix_gym_subscription_invoices_owner ON gym_subscription_invoices (owner_id, status)');
    await index('ix_gym_subscription_invoices_due', 'CREATE INDEX ix_gym_subscription_invoices_due ON gym_subscription_invoices (status, due_at)');

    // ---------------- gym_subscription_invoice_lines (append-only)
    await h.ensureTable(queryInterface, 'gym_subscription_invoice_lines', {
      id: { ...uuid, primaryKey: true },
      invoice_id: fk('gym_subscription_invoices'),
      kind: { type: h.ENUM('tier', 'proration', 'founding_free', 'founding_discount', 'referral', 'sms_addon', 'sms_bundle', 'vat', 'adjustment'), allowNull: false },
      description_en: str(200, false),
      description_bn: str(200, false),
      quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      unit_poisha: money,
      amount_poisha: money,
      ref_type: str(10),
      ref_id: optUuid,
      ...created(),
    });
    await index('ix_gym_subscription_invoice_lines', 'CREATE INDEX ix_gym_subscription_invoice_lines ON gym_subscription_invoice_lines (invoice_id)');
    await h.ensureAppendOnly(queryInterface, 'gym_subscription_invoice_lines');

    // ---------------- gym_fee_overrides (before referrals, which reference it)
    await h.ensureTable(queryInterface, 'gym_fee_overrides', {
      id: { ...uuid, primaryKey: true },
      scope_type: { type: h.ENUM('owner', 'gym'), allowNull: false },
      scope_id: uuid,
      owner_id: fk('users'),
      key: { type: h.ENUM('fees.gym_referral_poisha', 'fees.gym_pct'), allowNull: false },
      value: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      reason: str(300, false),
      valid_from: atReq,
      valid_to: at,
      status: { type: h.ENUM('active', 'ended'), allowNull: false, defaultValue: 'active' },
      set_by: uuid,
      ended_by: optUuid,
      ended_at: at,
      end_reason: str(300),
      ...ts(),
    });
    await h.ensureCheck(queryInterface, 'gym_fee_overrides', 'chk_gym_fee_overrides', "CHECK (value >= 0 AND (valid_to IS NULL OR valid_to > valid_from) AND ((status = 'ended') = (ended_at IS NOT NULL)))");
    await index('uq_gym_fee_overrides_active', "CREATE UNIQUE INDEX uq_gym_fee_overrides_active ON gym_fee_overrides (scope_type, scope_id, key) WHERE status = 'active'");
    await index('ix_gym_fee_overrides_owner', 'CREATE INDEX ix_gym_fee_overrides_owner ON gym_fee_overrides (owner_id, status)');
    await index('ix_gym_fee_overrides_end', "CREATE INDEX ix_gym_fee_overrides_end ON gym_fee_overrides (valid_to) WHERE status = 'active' AND valid_to IS NOT NULL");

    // ---------------- gym_referrals
    await h.ensureTable(queryInterface, 'gym_referrals', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      owner_id: fk('users'),
      member_id: fk('gym_members'),
      link_request_id: optFk('gym_link_requests'),
      first_fee_payment_id: fk('gym_fee_payments'),
      amount_poisha: money,
      source: { type: h.ENUM('setting', 'owner_override', 'gym_override'), allowNull: false },
      override_id: optFk('gym_fee_overrides'),
      setting_version: { type: DataTypes.INTEGER, allowNull: true },
      status: { type: h.ENUM('pending', 'invoiced', 'void'), allowNull: false, defaultValue: 'pending' },
      invoice_id: optFk('gym_subscription_invoices'),
      voided_at: at,
      void_reason: str(40),
      ...ts(),
    });
    await h.ensureCheck(
      queryInterface,
      'gym_referrals',
      'chk_gym_referrals',
      "CHECK (amount_poisha > 0 AND ((source = 'setting') = (override_id IS NULL)) AND ((status = 'invoiced') = (invoice_id IS NOT NULL)))"
    );
    await index('uq_gym_referrals_member', "CREATE UNIQUE INDEX uq_gym_referrals_member ON gym_referrals (member_id) WHERE status <> 'void'");
    await index('ix_gym_referrals_owner', 'CREATE INDEX ix_gym_referrals_owner ON gym_referrals (owner_id, status)');
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE gym_fee_payments DROP CONSTRAINT IF EXISTS fk_gym_fee_payments_link');
    for (const t of ['gym_referrals', 'gym_fee_overrides', 'gym_subscription_invoice_lines', 'gym_subscription_invoices', 'gym_active_member_counts', 'gym_reminders', 'gym_payment_links']) {
      await queryInterface.dropTable(t);
    }
  },
};
