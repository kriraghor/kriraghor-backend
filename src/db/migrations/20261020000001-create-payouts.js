'use strict';

/**
 * M07 payouts (§7, §8). Step 1: bKash and Nagad accounts, batches built from the M06 ledger, holds,
 * four-eyes approvals and manual disbursement (a staff member reveals one wallet number at a time).
 *
 *  - payout_accounts: the number is encrypted (common/crypto), with last 4 digits for display and an
 *    HMAC to spot one wallet on several users (edge case 8). One active account per user;
 *  - payout_items: each payable ledger entry is used once (FR-03): a partial unique index on
 *    ledger_entry_id over included items (a cancelled payout returns its items to the pool);
 *  - payouts: one open earning payout per payee, so two schedules never pay the same balance;
 *  - payout_holds: unique (type, ref_id), so M17/M18 placing the same hold twice is harmless (§2.4);
 *  - payout_approvals: two distinct masters (FR-07);
 *  - payout_reveals: append-only record of every wallet-number reveal (alongside the audit row).
 * The same migration adds the OTP purpose payout_account (confirming a new account, §4.1).
 */
const OTP_BEFORE = ['signup', 'login', 'reset', 'phone_change_old', 'phone_change_new', 'email_verify'];
const OTP_AFTER = [...OTP_BEFORE, 'payout_account'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const TS = 'TIMESTAMP(3) WITH TIME ZONE';
    const now = { type: TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const poisha = { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 };
    const user = { references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' };

    await h.createTable(queryInterface, 'payout_accounts', {
      id: { ...uuid, primaryKey: true },
      user_id: { ...uuid, ...user },
      type: { type: h.ENUM('bkash', 'nagad'), allowNull: false },
      account_no_enc: { type: DataTypes.STRING(200), allowNull: false },
      account_no_last4: { type: DataTypes.CHAR(4), allowNull: false },
      account_no_hash: { type: DataTypes.CHAR(64), allowNull: false },
      account_name: { type: DataTypes.STRING(120), allowNull: false },
      status: { type: h.ENUM('pending_verification', 'active', 'rejected', 'superseded', 'disabled'), allowNull: false, defaultValue: 'pending_verification' },
      reviewed_by: optUuid,
      reviewed_at: { type: TS, allowNull: true },
      review_note: { type: DataTypes.STRING(300), allowNull: true },
      activated_at: { type: TS, allowNull: true },
      hold_until: { type: TS, allowNull: true },
      superseded_by: { ...optUuid, references: { model: 'payout_accounts', key: 'id' }, onDelete: 'RESTRICT' },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('payout_accounts', ['user_id'], { unique: true, name: 'uq_payout_accounts_one_active', where: { status: 'active' } });
    await queryInterface.addIndex('payout_accounts', ['user_id', 'created_at'], { name: 'ix_payout_accounts_user' });
    await queryInterface.addIndex('payout_accounts', ['account_no_hash'], { name: 'ix_payout_accounts_hash' });
    await queryInterface.addIndex('payout_accounts', ['status', 'created_at'], { name: 'ix_payout_accounts_status' });

    await h.createTable(queryInterface, 'payout_batches', {
      id: { ...uuid, primaryKey: true },
      schedule: { type: h.ENUM('daily', 'ground_weekly', 'shop_weekly', 'manual', 'refund'), allowNull: false },
      window_end: { type: TS, allowNull: false },
      status: { type: h.ENUM('building', 'ready', 'processing', 'done', 'partially_failed'), allowNull: false, defaultValue: 'building' },
      totals: { type: DataTypes.JSONB, allowNull: true },
      created_by: optUuid,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addConstraint('payout_batches', { fields: ['schedule', 'window_end'], type: 'unique', name: 'uq_payout_batches_window' });

    await h.createTable(queryInterface, 'payouts', {
      id: { ...uuid, primaryKey: true },
      code: { type: DataTypes.STRING(20), allowNull: false, unique: true },
      batch_id: { ...optUuid, references: { model: 'payout_batches', key: 'id' }, onDelete: 'RESTRICT' },
      payee_id: { ...uuid, ...user },
      kind: { type: h.ENUM('earning', 'refund'), allowNull: false, defaultValue: 'earning' },
      // For refund payouts: the M06 refund being paid by hand (FR-15).
      refund_id: optUuid,
      payout_account_id: { ...optUuid, references: { model: 'payout_accounts', key: 'id' }, onDelete: 'RESTRICT' },
      period_start: { type: TS, allowNull: true },
      period_end: { type: TS, allowNull: true },
      gross_poisha: poisha,
      deductions_poisha: poisha,
      netting_poisha: poisha,
      adjustments_poisha: poisha,
      amount_poisha: { type: DataTypes.BIGINT, allowNull: false },
      status: { type: h.ENUM('scheduled', 'needs_approval', 'on_hold', 'processing', 'paid', 'failed', 'cancelled'), allowNull: false },
      // Threshold, minimum and auto-release limit used for this payout (no magic numbers, snapshotted).
      rules_snapshot: { type: DataTypes.JSONB, allowNull: false },
      channel: { type: h.ENUM('manual'), allowNull: true },
      provider_ref: { type: DataTypes.STRING(120), allowNull: true },
      attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      failure_code: { type: DataTypes.STRING(60), allowNull: true },
      failure_note: { type: DataTypes.STRING(300), allowNull: true },
      released_by: optUuid,
      released_at: { type: TS, allowNull: true },
      paid_by: optUuid,
      paid_at: { type: TS, allowNull: true },
      ledger_txn_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.sequelize.query(
      'ALTER TABLE payouts ADD CONSTRAINT ck_payouts_amounts CHECK (amount_poisha > 0 AND gross_poisha >= 0 AND deductions_poisha >= 0 AND netting_poisha >= 0)'
    );
    await queryInterface.addIndex('payouts', ['payee_id'], {
      unique: true,
      name: 'uq_payouts_one_open_earning',
      where: { kind: 'earning', status: ['scheduled', 'needs_approval', 'on_hold'] },
    });
    await queryInterface.addIndex('payouts', ['refund_id'], { unique: true, name: 'uq_payouts_refund', where: { refund_id: { [Sequelize.Op.ne]: null } } });
    await queryInterface.addIndex('payouts', ['status', 'created_at'], { name: 'ix_payouts_status' });
    await queryInterface.addIndex('payouts', ['payee_id', 'created_at'], { name: 'ix_payouts_payee' });
    await queryInterface.addIndex('payouts', ['batch_id'], { name: 'ix_payouts_batch' });

    await h.createTable(queryInterface, 'payout_items', {
      id: { ...uuid, primaryKey: true },
      payout_id: { ...uuid, references: { model: 'payouts', key: 'id' }, onDelete: 'RESTRICT' },
      source_type: { type: h.ENUM('escrow_hold', 'pool', 'reversal', 'fee_netting', 'refund'), allowNull: false },
      source_id: uuid,
      ledger_entry_id: { type: DataTypes.BIGINT, allowNull: true },
      gross_poisha: { type: DataTypes.BIGINT, allowNull: false },
      fee_poisha: poisha,
      net_poisha: { type: DataTypes.BIGINT, allowNull: false },
      description: { type: DataTypes.STRING(200), allowNull: false },
      status: { type: h.ENUM('included', 'returned'), allowNull: false, defaultValue: 'included' },
      created_at: now,
    });
    await queryInterface.addIndex('payout_items', ['ledger_entry_id'], {
      unique: true,
      name: 'uq_payout_items_entry_once',
      where: { status: 'included', ledger_entry_id: { [Sequelize.Op.ne]: null } },
    });
    await queryInterface.addIndex('payout_items', ['payout_id'], { name: 'ix_payout_items_payout' });
    await queryInterface.addIndex('payout_items', ['source_type', 'source_id'], { name: 'ix_payout_items_source' });

    await h.createTable(queryInterface, 'payout_holds', {
      id: { ...uuid, primaryKey: true },
      scope: { type: h.ENUM('payee', 'payout', 'item_source'), allowNull: false },
      payee_id: { ...uuid, ...user },
      payout_id: { ...optUuid, references: { model: 'payouts', key: 'id' }, onDelete: 'RESTRICT' },
      source_type: { type: DataTypes.STRING(20), allowNull: true },
      source_id: optUuid,
      type: { type: h.ENUM('account_change', 'risk_freeze', 'dispute', 'kyc', 'account_suspended', 'manual'), allowNull: false },
      reason: { type: DataTypes.STRING(300), allowNull: true },
      ref_id: uuid,
      until: { type: TS, allowNull: true },
      placed_by: optUuid,
      placed_at: now,
      lifted_by: optUuid,
      lifted_at: { type: TS, allowNull: true },
      lift_reason: { type: DataTypes.STRING(300), allowNull: true },
    });
    await queryInterface.addConstraint('payout_holds', { fields: ['type', 'ref_id'], type: 'unique', name: 'uq_payout_holds_type_ref' });
    await queryInterface.addIndex('payout_holds', ['payee_id'], { name: 'ix_payout_holds_active', where: { lifted_at: null } });
    await queryInterface.addIndex('payout_holds', ['type', 'until'], { name: 'ix_payout_holds_expiry', where: { lifted_at: null } });

    await h.createTable(queryInterface, 'payout_approvals', {
      id: { ...uuid, primaryKey: true },
      payout_id: { ...uuid, references: { model: 'payouts', key: 'id' }, onDelete: 'RESTRICT' },
      approver_id: { ...uuid, ...user },
      step: { type: DataTypes.SMALLINT, allowNull: false },
      approved_at: now,
    });
    await queryInterface.sequelize.query('ALTER TABLE payout_approvals ADD CONSTRAINT ck_payout_approvals_step CHECK (step IN (1, 2))');
    await queryInterface.addConstraint('payout_approvals', { fields: ['payout_id', 'step'], type: 'unique', name: 'uq_payout_approvals_step' });
    await queryInterface.addConstraint('payout_approvals', { fields: ['payout_id', 'approver_id'], type: 'unique', name: 'uq_payout_approvals_approver' });

    await h.createTable(queryInterface, 'payout_reveals', {
      id: { ...uuid, primaryKey: true },
      payout_id: { ...uuid, references: { model: 'payouts', key: 'id' }, onDelete: 'RESTRICT' },
      account_id: { ...uuid, references: { model: 'payout_accounts', key: 'id' }, onDelete: 'RESTRICT' },
      staff_id: { ...uuid, ...user },
      revealed_at: now,
    });
    await queryInterface.addIndex('payout_reveals', ['payout_id'], { name: 'ix_payout_reveals_payout' });
    await h.appendOnly(queryInterface, 'payout_reveals');

    await h.replaceEnumCheck(queryInterface, 'otp_codes', 'purpose', OTP_AFTER);
  },

  async down(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const [[{ n }]] = await queryInterface.sequelize.query("SELECT COUNT(*) AS n FROM otp_codes WHERE purpose = 'payout_account'");
    // Records are never hard-deleted: keep the wider list once a payout_account code exists.
    if (Number(n) === 0) await h.replaceEnumCheck(queryInterface, 'otp_codes', 'purpose', OTP_BEFORE);
    await h.dropAppendOnly(queryInterface, 'payout_reveals');
    for (const table of ['payout_reveals', 'payout_approvals', 'payout_holds', 'payout_items', 'payouts', 'payout_batches', 'payout_accounts']) {
      await queryInterface.dropTable(table);
    }
  },
};
