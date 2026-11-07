'use strict';

/**
 * M27 Gym operations, round 1 (product owner, 7 Nov 2026): the gym's own books beyond fees. Like M24's
 * counter money (M24-FR-34) this is bookkeeping only: no M06 ledger, no payout.
 *
 * New tables of the gym-ops module (gym group, ADR-007):
 *  - gym_expense_categories, gym_expenses: what the gym spends (M27-FR-01..05); voided, never deleted;
 *  - gym_cash_sessions: the day's cash drawer, opened with a float and closed with the counted cash (M27-FR-06..09);
 *  - gym_products, gym_stock_moves (append-only): the counter shop and its stock (M27-FR-10..16);
 *  - gym_sales, gym_sale_lines (lines append-only): counter sales of products and locker fees (M27-FR-17..21);
 *  - gym_lockers, gym_locker_rentals: the locker room (M27-FR-22..26).
 * Columns added to gym-manage tables (gym-manage still owns and writes them):
 *  - gym_members: blood group, height, weight, conditions and injuries (encrypted) (M27-FR-30);
 *  - gym_manage_settings: VAT on member receipts, off by default (M27-FR-28);
 *  - gym_fee_payments: the VAT rate a payment was recorded at (snapshot; the table stays append-only).
 * Settings: gym_saas.feature_min_tiers gains the round's features without overwriting a value a master
 * changed; gym_manage.remind_before_days is replaced by the list gym_manage.renewal_remind_days (its row
 * stays, relabelled, with its history).
 * Value lists are VARCHAR + named CHECK; nothing is deleted.
 */
const crypto = require('node:crypto');

const NEW_FEATURES = { expenses: 'basic', lockers: 'basic', pos: 'standard', pnl: 'standard' };
const RETIRED = ['gym_manage.remind_before_days'];
const METHODS = ['cash', 'owner_bkash', 'owner_nagad', 'card_counter', 'bank', 'other'];
const SALE_METHODS = ['cash', 'owner_bkash', 'owner_nagad', 'card_counter', 'other'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes, QueryTypes } = Sequelize;
    const db = queryInterface.sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ ...optUuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const money = { type: DataTypes.BIGINT, allowNull: false };
    const optMoney = { type: DataTypes.BIGINT, allowNull: true };
    const index = (name, sql) => h.ensureIndexSql(queryInterface, name, sql);

    // ---------------- gym-manage columns
    await h.ensureColumn(queryInterface, 'gym_members', 'blood_group', { type: h.ENUM('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'), allowNull: true });
    await h.ensureColumn(queryInterface, 'gym_members', 'height_cm', { type: DataTypes.SMALLINT, allowNull: true });
    await h.ensureColumn(queryInterface, 'gym_members', 'weight_kg', { type: DataTypes.DECIMAL(5, 1), allowNull: true });
    await h.ensureColumn(queryInterface, 'gym_members', 'medical_enc', { type: DataTypes.TEXT, allowNull: true });
    await h.ensureCheck(queryInterface, 'gym_members', 'chk_gym_members_body', 'CHECK ((height_cm IS NULL OR height_cm BETWEEN 50 AND 250) AND (weight_kg IS NULL OR weight_kg BETWEEN 10 AND 400))');
    await h.ensureColumn(queryInterface, 'gym_manage_settings', 'vat_enabled', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    await h.ensureColumn(queryInterface, 'gym_manage_settings', 'vat_bps', { type: DataTypes.INTEGER, allowNull: true });
    await h.ensureCheck(queryInterface, 'gym_manage_settings', 'chk_gym_manage_settings_vat', 'CHECK (vat_bps IS NULL OR vat_bps BETWEEN 0 AND 10000)');
    await h.ensureColumn(queryInterface, 'gym_fee_payments', 'vat_bps', { type: DataTypes.INTEGER, allowNull: true });

    // ---------------- gym_expense_categories, gym_expenses
    await h.ensureTable(queryInterface, 'gym_expense_categories', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      key: { type: DataTypes.STRING(30), allowNull: true },
      name: { type: DataTypes.STRING(60), allowNull: false },
      sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      status: { type: h.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
      created_at: now,
      updated_at: now,
    });
    await index('uq_gym_expense_categories_key', 'CREATE UNIQUE INDEX uq_gym_expense_categories_key ON gym_expense_categories (gym_id, key) WHERE key IS NOT NULL');
    await index('uq_gym_expense_categories_name', "CREATE UNIQUE INDEX uq_gym_expense_categories_name ON gym_expense_categories (gym_id, lower(name)) WHERE status = 'active'");

    await h.ensureTable(queryInterface, 'gym_expenses', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      category_id: fk('gym_expense_categories'),
      amount_poisha: money,
      spent_on: { type: DataTypes.DATEONLY, allowNull: false },
      method: { type: h.ENUM(...METHODS), allowNull: false },
      from_drawer: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      payee: { type: DataTypes.STRING(80), allowNull: true },
      note: { type: DataTypes.STRING(300), allowNull: true },
      source: { type: h.ENUM('manual', 'payroll', 'asset'), allowNull: false, defaultValue: 'manual' },
      source_id: optUuid,
      status: { type: h.ENUM('recorded', 'void'), allowNull: false, defaultValue: 'recorded' },
      void_reason: { type: DataTypes.STRING(300), allowNull: true },
      voided_by: optUuid,
      voided_at: at,
      created_by: fk('users'),
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_expenses', 'chk_gym_expenses', "CHECK (amount_poisha > 0 AND (NOT from_drawer OR method = 'cash') AND ((status = 'void') = (voided_at IS NOT NULL)))");
    await index('ix_gym_expenses_gym', 'CREATE INDEX ix_gym_expenses_gym ON gym_expenses (gym_id, spent_on DESC)');

    // ---------------- gym_cash_sessions (one drawer per gym per day)
    await h.ensureTable(queryInterface, 'gym_cash_sessions', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      business_date: { type: DataTypes.DATEONLY, allowNull: false },
      opening_poisha: money,
      opened_by: fk('users'),
      opened_at: now,
      status: { type: h.ENUM('open', 'closed'), allowNull: false, defaultValue: 'open' },
      counted_poisha: optMoney,
      expected_poisha: optMoney,
      difference_poisha: optMoney,
      close_note: { type: DataTypes.STRING(300), allowNull: true },
      closed_by: optUuid,
      closed_at: at,
      created_at: now,
      updated_at: now,
    });
    await index('uq_gym_cash_sessions_day', 'CREATE UNIQUE INDEX uq_gym_cash_sessions_day ON gym_cash_sessions (gym_id, business_date)');
    await h.ensureCheck(
      queryInterface,
      'gym_cash_sessions',
      'chk_gym_cash_sessions',
      "CHECK (opening_poisha >= 0 AND ((status = 'closed') = (closed_at IS NOT NULL AND counted_poisha IS NOT NULL AND expected_poisha IS NOT NULL)))"
    );

    // ---------------- gym_products, gym_stock_moves (append-only)
    await h.ensureTable(queryInterface, 'gym_products', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      name: { type: DataTypes.STRING(80), allowNull: false },
      barcode: { type: DataTypes.STRING(40), allowNull: true },
      category: { type: h.ENUM('supplement', 'drink', 'snack', 'gear', 'apparel', 'accessory', 'other'), allowNull: false },
      price_poisha: money,
      cost_poisha: optMoney,
      stock_qty: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      reorder_level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      batch_no: { type: DataTypes.STRING(40), allowNull: true },
      expires_on: { type: DataTypes.DATEONLY, allowNull: true },
      importer: { type: DataTypes.STRING(120), allowNull: true },
      low_alerted_at: at,
      expiry_alerted_on: { type: DataTypes.DATEONLY, allowNull: true },
      status: { type: h.ENUM('active', 'retired'), allowNull: false, defaultValue: 'active' },
      created_by: optUuid,
      updated_by: optUuid,
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_products', 'chk_gym_products', 'CHECK (price_poisha > 0 AND (cost_poisha IS NULL OR cost_poisha >= 0) AND stock_qty >= 0 AND reorder_level >= 0)');
    await index('uq_gym_products_barcode', "CREATE UNIQUE INDEX uq_gym_products_barcode ON gym_products (gym_id, barcode) WHERE barcode IS NOT NULL AND status = 'active'");
    await index('ix_gym_products_gym', 'CREATE INDEX ix_gym_products_gym ON gym_products (gym_id, status, name)');

    await h.ensureTable(queryInterface, 'gym_stock_moves', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      product_id: fk('gym_products'),
      kind: { type: h.ENUM('in', 'sale', 'sale_reversal', 'adjust', 'write_off'), allowNull: false },
      qty: { type: DataTypes.INTEGER, allowNull: false },
      qty_after: { type: DataTypes.INTEGER, allowNull: false },
      unit_cost_poisha: optMoney,
      sale_id: optUuid,
      note: { type: DataTypes.STRING(200), allowNull: true },
      by_user: optUuid,
      created_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_stock_moves', 'chk_gym_stock_moves', 'CHECK (qty <> 0 AND qty_after >= 0)');
    await index('ix_gym_stock_moves_product', 'CREATE INDEX ix_gym_stock_moves_product ON gym_stock_moves (product_id, created_at DESC)');
    await h.ensureAppendOnly(queryInterface, 'gym_stock_moves');

    // ---------------- gym_lockers, gym_locker_rentals
    await h.ensureTable(queryInterface, 'gym_lockers', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      number: { type: DataTypes.STRING(10), allowNull: false },
      zone: { type: DataTypes.STRING(30), allowNull: true },
      size: { type: h.ENUM('small', 'medium', 'large'), allowNull: false, defaultValue: 'medium' },
      monthly_fee_poisha: money,
      status: { type: h.ENUM('available', 'out_of_service', 'retired'), allowNull: false, defaultValue: 'available' },
      note: { type: DataTypes.STRING(200), allowNull: true },
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_lockers', 'chk_gym_lockers', 'CHECK (monthly_fee_poisha >= 0)');
    await index('uq_gym_lockers_number', "CREATE UNIQUE INDEX uq_gym_lockers_number ON gym_lockers (gym_id, upper(number)) WHERE status <> 'retired'");

    // ---------------- gym_sales, gym_sale_lines (append-only)
    await h.ensureTable(queryInterface, 'gym_sales', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      receipt_no: { type: DataTypes.STRING(24), allowNull: false },
      kind: { type: h.ENUM('pos', 'locker'), allowNull: false },
      member_id: optFk('gym_members'),
      total_poisha: money,
      cost_poisha: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      method: { type: h.ENUM(...SALE_METHODS), allowNull: false },
      vat_bps: { type: DataTypes.INTEGER, allowNull: true },
      sold_on: { type: DataTypes.DATEONLY, allowNull: false },
      sold_by: fk('users'),
      status: { type: h.ENUM('recorded', 'reversed'), allowNull: false, defaultValue: 'recorded' },
      reverse_reason: { type: DataTypes.STRING(300), allowNull: true },
      reversed_on: { type: DataTypes.DATEONLY, allowNull: true },
      reversed_by: optUuid,
      reversed_at: at,
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_sales', 'chk_gym_sales', "CHECK (total_poisha > 0 AND cost_poisha >= 0 AND ((status = 'reversed') = (reversed_at IS NOT NULL)))");
    await index('uq_gym_sales_receipt', 'CREATE UNIQUE INDEX uq_gym_sales_receipt ON gym_sales (gym_id, receipt_no)');
    await index('ix_gym_sales_gym', 'CREATE INDEX ix_gym_sales_gym ON gym_sales (gym_id, sold_on DESC)');

    await h.ensureTable(queryInterface, 'gym_sale_lines', {
      id: { ...uuid, primaryKey: true },
      sale_id: fk('gym_sales'),
      product_id: optFk('gym_products'),
      locker_rental_id: optUuid,
      description: { type: DataTypes.STRING(120), allowNull: false },
      qty: { type: DataTypes.INTEGER, allowNull: false },
      unit_price_poisha: money,
      unit_cost_poisha: optMoney,
      line_total_poisha: money,
      created_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_sale_lines', 'chk_gym_sale_lines', 'CHECK (qty > 0 AND unit_price_poisha > 0 AND line_total_poisha = qty * unit_price_poisha)');
    await index('ix_gym_sale_lines_sale', 'CREATE INDEX ix_gym_sale_lines_sale ON gym_sale_lines (sale_id)');
    await h.ensureAppendOnly(queryInterface, 'gym_sale_lines');

    await h.ensureTable(queryInterface, 'gym_locker_rentals', {
      id: { ...uuid, primaryKey: true },
      gym_id: fk('gyms'),
      locker_id: fk('gym_lockers'),
      member_id: fk('gym_members'),
      starts_on: { type: DataTypes.DATEONLY, allowNull: false },
      ends_on: { type: DataTypes.DATEONLY, allowNull: false },
      fee_poisha: money,
      paid_sale_id: optFk('gym_sales'),
      status: { type: h.ENUM('active', 'ended', 'cancelled'), allowNull: false, defaultValue: 'active' },
      end_reason: { type: DataTypes.STRING(200), allowNull: true },
      ended_at: at,
      ended_by: optUuid,
      reminded_on: { type: DataTypes.DATEONLY, allowNull: true },
      created_by: fk('users'),
      created_at: now,
      updated_at: now,
    });
    await h.ensureCheck(queryInterface, 'gym_locker_rentals', 'chk_gym_locker_rentals', "CHECK (ends_on >= starts_on AND fee_poisha >= 0 AND ((status = 'active') = (ended_at IS NULL)))");
    await index('uq_gym_locker_rentals_active', "CREATE UNIQUE INDEX uq_gym_locker_rentals_active ON gym_locker_rentals (locker_id) WHERE status = 'active'");
    await index('ix_gym_locker_rentals_member', 'CREATE INDEX ix_gym_locker_rentals_member ON gym_locker_rentals (member_id, status)');

    // ---------------- settings: new features into the tier map, the old reminder key retired
    await db.transaction(async (transaction) => {
      const rows = await db.query("SELECT value, version FROM platform_settings WHERE key = 'gym_saas.feature_min_tiers' FOR UPDATE", { type: QueryTypes.SELECT, transaction });
      if (rows.length) {
        const { value, version } = rows[0];
        const next = { ...NEW_FEATURES, ...(value ?? {}) };
        if (JSON.stringify(next) !== JSON.stringify(value)) {
          await db.query("UPDATE platform_settings SET value = CAST(:next AS jsonb), version = :v, updated_at = CURRENT_TIMESTAMP(3) WHERE key = 'gym_saas.feature_min_tiers'", {
            replacements: { next: JSON.stringify(next), v: Number(version) + 1 },
            transaction,
          });
          await db.query(
            `INSERT INTO settings_history (id, key, version, old_value, new_value, effective_at, request_id, changed_by, approved_by, reason, created_at)
             VALUES (:id, 'gym_saas.feature_min_tiers', :v, CAST(:old AS jsonb), CAST(:next AS jsonb), CURRENT_TIMESTAMP(3), NULL, NULL, NULL, :reason, CURRENT_TIMESTAMP(3))`,
            {
              replacements: { id: crypto.randomUUID(), v: Number(version) + 1, old: JSON.stringify(value), next: JSON.stringify(next), reason: 'M27 round 1 (7 Nov 2026): new gym features; values already set were kept' },
              transaction,
            }
          );
        }
      }
      await db.query(
        `UPDATE platform_settings
            SET label_en = 'No longer used: ' || label_en, label_bn = 'আর ব্যবহার হয় না: ' || label_bn
          WHERE key IN (:keys) AND label_en NOT LIKE 'No longer used%'`,
        { replacements: { keys: RETIRED }, transaction }
      );
    });
  },

  // Tables and columns stay (expand and contract); settings history is append-only.
  async down() {},
};
