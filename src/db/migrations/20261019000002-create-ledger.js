'use strict';

/**
 * M06 double-entry ledger (§6.2, §7, FR-11, FR-12).
 *
 * MySQL has no deferred constraint triggers, so the balance rule (Σ debit = Σ credit, FR-12) is
 * enforced when the transaction header is written: LedgerService.post() inserts the entries first
 * and the ledger_transactions row last, inside one database transaction. The BEFORE INSERT trigger
 * on ledger_transactions sums that txn's entries and refuses the header unless they balance, match
 * total_poisha and entry_count, and there are at least two. Entries for a txn whose header already
 * exists are refused, so a sealed transaction can never grow. ledger_entries.txn_id therefore has no
 * foreign key (the header does not exist yet when entries are written); the nightly invariants job
 * reports entries without a header.
 *
 * FR-11: all three tables are append-only (UPDATE/DELETE triggers; corrections are reversing
 * transactions). Needs log_bin_trust_function_creators=1, as for audit_logs (Q140).
 */
const APPEND_ONLY = ['ledger_accounts', 'ledger_transactions', 'ledger_entries'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const q = (sql) => queryInterface.sequelize.query(sql);
    const now = { type: DataTypes.DATE(3), allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.CHAR(36), allowNull: false };

    await queryInterface.createTable('ledger_accounts', {
      id: { ...uuid, primaryKey: true },
      code: { type: DataTypes.STRING(120), allowNull: false, unique: true },
      type: { type: DataTypes.ENUM('asset', 'liability', 'revenue', 'expense', 'equity'), allowNull: false },
      owner_user_id: { type: DataTypes.CHAR(36), allowNull: true },
      vertical: { type: DataTypes.STRING(20), allowNull: true },
      created_at: now,
    });
    await queryInterface.addIndex('ledger_accounts', ['owner_user_id'], { name: 'ix_ledger_accounts_owner' });

    await queryInterface.createTable('ledger_transactions', {
      id: { ...uuid, primaryKey: true },
      kind: { type: DataTypes.STRING(40), allowNull: false },
      ref_type: { type: DataTypes.STRING(30), allowNull: false },
      ref_id: uuid,
      idempotency_key: { type: DataTypes.STRING(160), allowNull: false, unique: true },
      reverses_txn_id: { type: DataTypes.CHAR(36), allowNull: true, references: { model: 'ledger_transactions', key: 'id' }, onDelete: 'RESTRICT' },
      memo: { type: DataTypes.STRING(300), allowNull: true },
      total_poisha: { type: DataTypes.BIGINT, allowNull: false },
      entry_count: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
      posted_by: { type: DataTypes.CHAR(36), allowNull: true },
      posted_at: now,
    });
    await queryInterface.addIndex('ledger_transactions', ['ref_type', 'ref_id'], { name: 'ix_ledger_txn_ref' });
    await queryInterface.addIndex('ledger_transactions', ['posted_at'], { name: 'ix_ledger_txn_posted' });

    await queryInterface.createTable('ledger_entries', {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      txn_id: uuid,
      account_id: { ...uuid, references: { model: 'ledger_accounts', key: 'id' }, onDelete: 'RESTRICT' },
      escrow_hold_id: { type: DataTypes.CHAR(36), allowNull: true },
      debit_poisha: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      credit_poisha: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    });
    await queryInterface.addIndex('ledger_entries', ['account_id', 'id'], { name: 'ix_ledger_entries_account' });
    await queryInterface.addIndex('ledger_entries', ['txn_id'], { name: 'ix_ledger_entries_txn' });
    await queryInterface.addIndex('ledger_entries', ['escrow_hold_id'], { name: 'ix_ledger_entries_hold' });
    await q(
      'ALTER TABLE ledger_entries ADD CONSTRAINT ck_ledger_entries_sides CHECK (debit_poisha >= 0 AND credit_poisha >= 0 AND ((debit_poisha = 0) <> (credit_poisha = 0)))'
    );

    await q(
      'CREATE TRIGGER trg_ledger_entries_sealed BEFORE INSERT ON ledger_entries FOR EACH ROW BEGIN ' +
        'IF EXISTS (SELECT 1 FROM ledger_transactions WHERE id = NEW.txn_id) THEN ' +
        "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger transaction is already posted'; END IF; END"
    );
    await q(
      'CREATE TRIGGER trg_ledger_txn_balanced BEFORE INSERT ON ledger_transactions FOR EACH ROW BEGIN ' +
        'DECLARE d BIGINT; DECLARE c BIGINT; DECLARE n INT; ' +
        'SELECT COALESCE(SUM(debit_poisha), 0), COALESCE(SUM(credit_poisha), 0), COUNT(*) INTO d, c, n FROM ledger_entries WHERE txn_id = NEW.id; ' +
        'IF n < 2 OR d <> c OR d <> NEW.total_poisha OR n <> NEW.entry_count THEN ' +
        "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger transaction is unbalanced'; END IF; END"
    );
    for (const table of APPEND_ONLY) {
      for (const op of ['UPDATE', 'DELETE']) {
        await q(
          `CREATE TRIGGER trg_${table}_no_${op.toLowerCase()} BEFORE ${op} ON ${table} FOR EACH ROW ` +
            `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${table} is append-only'`
        );
      }
    }
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP TRIGGER IF EXISTS trg_ledger_entries_sealed');
    await q('DROP TRIGGER IF EXISTS trg_ledger_txn_balanced');
    for (const table of APPEND_ONLY) for (const op of ['update', 'delete']) await q(`DROP TRIGGER IF EXISTS trg_${table}_no_${op}`);
    for (const t of ['ledger_entries', 'ledger_transactions', 'ledger_accounts']) await queryInterface.dropTable(t);
  },
};
