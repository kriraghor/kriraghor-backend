'use strict';

/**
 * M22 Esports organiser SaaS, step 1 (§7): contracts, invoices and their lines, prize funds and
 * branding; and the columns M22 needs on M21's esports_tournaments (added here, M22 §7 note):
 *  - organiser_contracts: percentage (pct, NULL = fees.esports_saas_pct) or flat (flat_fee_poisha per
 *    cycle); one active contract per organisation (partial unique index).
 *  - organiser_invoices: KG-INV-26-000123; vat_poisha stays 0 until saas.vat_enabled (Q136).
 *  - organiser_prize_funds: the guaranteed prize pool an organiser deposits (M06 purpose
 *    esports_prize_fund, holds grouped by this row's id) before its tournament can be submitted.
 *  - organisation_branding: logo, colours, tagline and the subdomain {sub}.esports.kriraghor.com.
 *  - esports_tournaments: saas_fee_model and saas_fee_bps snapshotted at publish, contract_id, and
 *    max_paid_kills (an organiser's per-kill reward needs a cap so the fund can cover it).
 */
const CONTRACT_STATUSES = ['draft', 'active', 'suspended', 'ended'];
const INVOICE_STATUSES = ['draft', 'issued', 'paid', 'overdue', 'voided'];
const FUND_STATUSES = ['pending', 'funded', 'consumed', 'returned'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const optFk = (table) => ({ ...optUuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const poisha0 = { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 };
    const audit = () => ({ created_by: optUuid, updated_by: optUuid, created_at: now, updated_at: now });
    const q = (sql) => queryInterface.sequelize.query(sql);

    await h.createTable(queryInterface, 'organiser_contracts', {
      id: { ...uuid, primaryKey: true },
      organisation_id: fk('organisations'),
      model: { type: h.ENUM('percentage', 'flat'), allowNull: false },
      pct: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
      flat_fee_poisha: { type: DataTypes.BIGINT, allowNull: true },
      billing_cycle: { type: h.ENUM('monthly', 'quarterly', 'per_tournament'), allowNull: false },
      starts_on: { type: DataTypes.DATEONLY, allowNull: false },
      ends_on: { type: DataTypes.DATEONLY, allowNull: true },
      status: { type: h.ENUM(...CONTRACT_STATUSES), allowNull: false, defaultValue: 'draft' },
      signed_document_key: { type: DataTypes.STRING(255), allowNull: true },
      notes: { type: DataTypes.STRING(500), allowNull: true },
      activated_at: at,
      suspended_at: at,
      suspend_reason: { type: DataTypes.STRING(300), allowNull: true },
      ended_at: at,
      end_reason: { type: DataTypes.STRING(300), allowNull: true },
      expiry_notified_at: at,
      ...audit(),
    });
    await q("CREATE UNIQUE INDEX uq_organiser_contracts_active ON organiser_contracts (organisation_id) WHERE status = 'active'");
    await queryInterface.addIndex('organiser_contracts', ['organisation_id', 'status'], { name: 'ix_organiser_contracts_org' });
    await q(
      "ALTER TABLE organiser_contracts ADD CONSTRAINT chk_organiser_contracts_model CHECK ((model = 'percentage' AND flat_fee_poisha IS NULL AND (pct IS NULL OR pct BETWEEN 0 AND 100)) OR (model = 'flat' AND pct IS NULL AND flat_fee_poisha > 0 AND billing_cycle <> 'per_tournament'))"
    );
    await q('ALTER TABLE organiser_contracts ADD CONSTRAINT chk_organiser_contracts_dates CHECK (ends_on IS NULL OR ends_on >= starts_on)');

    await h.createTable(queryInterface, 'organiser_invoices', {
      id: { ...uuid, primaryKey: true },
      number: { type: DataTypes.STRING(24), allowNull: false },
      organisation_id: fk('organisations'),
      contract_id: fk('organiser_contracts'),
      period_start: { type: DataTypes.DATEONLY, allowNull: false },
      period_end: { type: DataTypes.DATEONLY, allowNull: false },
      subtotal_poisha: poisha0,
      vat_poisha: poisha0,
      total_poisha: poisha0,
      status: { type: h.ENUM(...INVOICE_STATUSES), allowNull: false, defaultValue: 'issued' },
      due_at: at,
      payment_id: optFk('payments'),
      issued_at: at,
      paid_at: at,
      overdue_at: at,
      voided_at: at,
      void_reason: { type: DataTypes.STRING(255), allowNull: true },
      idempotency_key: { type: DataTypes.STRING(120), allowNull: false },
      ...audit(),
    });
    await queryInterface.addIndex('organiser_invoices', ['number'], { unique: true, name: 'uq_organiser_invoices_number' });
    await queryInterface.addIndex('organiser_invoices', ['idempotency_key'], { unique: true, name: 'uq_organiser_invoices_key' });
    await queryInterface.addIndex('organiser_invoices', ['organisation_id', 'status'], { name: 'ix_organiser_invoices_org' });
    await queryInterface.addIndex('organiser_invoices', ['status', 'due_at'], { name: 'ix_organiser_invoices_due' });
    await q('ALTER TABLE organiser_invoices ADD CONSTRAINT chk_organiser_invoices CHECK (period_end >= period_start AND subtotal_poisha >= 0 AND vat_poisha >= 0 AND total_poisha = subtotal_poisha + vat_poisha)');

    await h.createTable(queryInterface, 'organiser_invoice_lines', {
      id: { ...uuid, primaryKey: true },
      invoice_id: fk('organiser_invoices'),
      kind: { type: h.ENUM('flat_fee', 'percentage_fee', 'adjustment'), allowNull: false },
      tournament_id: optFk('esports_tournaments'),
      description: { type: DataTypes.STRING(200), allowNull: false },
      amount_poisha: { type: DataTypes.BIGINT, allowNull: false },
      payable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: now,
    });
    await queryInterface.addIndex('organiser_invoice_lines', ['invoice_id'], { name: 'ix_organiser_invoice_lines_invoice' });

    await h.createTable(queryInterface, 'organiser_prize_funds', {
      id: { ...uuid, primaryKey: true },
      tournament_id: fk('esports_tournaments'),
      organisation_id: fk('organisations'),
      required_poisha: poisha0,
      deposited_poisha: poisha0,
      paid_poisha: poisha0,
      returned_poisha: poisha0,
      status: { type: h.ENUM(...FUND_STATUSES), allowNull: false, defaultValue: 'pending' },
      payment_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      funded_at: at,
      settled_at: at,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('organiser_prize_funds', ['tournament_id'], { unique: true, name: 'uq_organiser_prize_funds_tournament' });
    await queryInterface.addIndex('organiser_prize_funds', ['organisation_id', 'status'], { name: 'ix_organiser_prize_funds_org' });
    await q('ALTER TABLE organiser_prize_funds ADD CONSTRAINT chk_organiser_prize_funds CHECK (required_poisha >= 0 AND deposited_poisha >= 0 AND paid_poisha >= 0 AND returned_poisha >= 0 AND paid_poisha + returned_poisha <= deposited_poisha)');

    await h.createTable(queryInterface, 'organisation_branding', {
      organisation_id: { ...fk('organisations'), primaryKey: true },
      subdomain: { type: DataTypes.STRING(30), allowNull: true },
      logo_key: { type: DataTypes.STRING(255), allowNull: true },
      primary_hex: { type: DataTypes.STRING(7), allowNull: false, defaultValue: '#0b7a4b' },
      accent_hex: { type: DataTypes.STRING(7), allowNull: false, defaultValue: '#f2a33a' },
      tagline_en: { type: DataTypes.STRING(120), allowNull: true },
      tagline_bn: { type: DataTypes.STRING(120), allowNull: true },
      status: { type: h.ENUM('draft', 'live', 'suspended'), allowNull: false, defaultValue: 'draft' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      updated_by: optUuid,
      created_at: now,
      updated_at: now,
    });
    await q('CREATE UNIQUE INDEX uq_organisation_branding_subdomain ON organisation_branding (subdomain) WHERE subdomain IS NOT NULL');
    await q("ALTER TABLE organisation_branding ADD CONSTRAINT chk_organisation_branding CHECK (primary_hex ~ '^#[0-9a-f]{6}$' AND accent_hex ~ '^#[0-9a-f]{6}$' AND (subdomain IS NULL OR subdomain ~ '^[a-z0-9]([a-z0-9-]{1,28})[a-z0-9]$'))");

    // M21 columns for organiser tournaments (M22 §7).
    await h.addColumn(queryInterface, 'esports_tournaments', 'saas_fee_model', { type: h.ENUM('none', 'percentage', 'flat'), allowNull: false, defaultValue: 'none' });
    await h.addColumn(queryInterface, 'esports_tournaments', 'saas_fee_bps', { type: DataTypes.INTEGER, allowNull: true });
    await h.addColumn(queryInterface, 'esports_tournaments', 'contract_id', optFk('organiser_contracts'));
    await h.addColumn(queryInterface, 'esports_tournaments', 'max_paid_kills', { type: DataTypes.INTEGER, allowNull: true });
    await q('ALTER TABLE esports_tournaments ADD CONSTRAINT fk_esports_tournaments_organisation FOREIGN KEY (organisation_id) REFERENCES organisations (id) ON DELETE RESTRICT');
    await queryInterface.addIndex('esports_tournaments', ['organisation_id', 'status'], { name: 'ix_esports_tournaments_org' });
    await q(
      "ALTER TABLE esports_tournaments ADD CONSTRAINT chk_esports_tournaments_organiser CHECK ((organiser_type = 'kriraghor' AND organisation_id IS NULL AND saas_fee_model = 'none') OR (organiser_type = 'organisation' AND organisation_id IS NOT NULL)) NOT VALID"
    );
    await q('ALTER TABLE esports_tournaments ADD CONSTRAINT chk_esports_tournaments_kill_cap CHECK (max_paid_kills IS NULL OR max_paid_kills BETWEEN 1 AND 10000)');
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE esports_tournaments DROP CONSTRAINT IF EXISTS chk_esports_tournaments_kill_cap');
    await q('ALTER TABLE esports_tournaments DROP CONSTRAINT IF EXISTS chk_esports_tournaments_organiser');
    await queryInterface.removeIndex('esports_tournaments', 'ix_esports_tournaments_org');
    await q('ALTER TABLE esports_tournaments DROP CONSTRAINT IF EXISTS fk_esports_tournaments_organisation');
    for (const c of ['max_paid_kills', 'contract_id', 'saas_fee_bps', 'saas_fee_model']) await queryInterface.removeColumn('esports_tournaments', c);
    for (const t of ['organisation_branding', 'organiser_prize_funds', 'organiser_invoice_lines', 'organiser_invoices', 'organiser_contracts']) await queryInterface.dropTable(t);
  },
};
