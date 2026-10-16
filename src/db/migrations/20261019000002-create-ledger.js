'use strict';

/**
 * M06 double-entry ledger (§6.2, §7, FR-11, FR-12), the spec's Postgres design (ADR-005):
 *  - ledger_entries.txn_id references ledger_transactions with a DEFERRABLE INITIALLY DEFERRED foreign
 *    key, so a transaction's header and entries can be written in any order inside one database
 *    transaction;
 *  - FR-12: a DEFERRABLE constraint trigger checks every touched ledger transaction at COMMIT: at
 *    least two entries, entry_count matches, Σ debit = Σ credit = total_poisha. Entries added later
 *    (in another database transaction) change the count, so a posted transaction never grows;
 *  - FR-11: all three tables are append-only (kg_forbid_change); corrections are reversing transactions.
 * LedgerService.post() validates the lines before writing; these checks are the database's backstop.
 */
const APPEND_ONLY = ['ledger_accounts', 'ledger_transactions', 'ledger_entries'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v2')(Sequelize);
    const { DataTypes } = Sequelize;
    const q = (sql) => queryInterface.sequelize.query(sql);
    const now = { type: 'TIMESTAMP(3) WITH TIME ZONE', allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const uuid = { type: DataTypes.UUID, allowNull: false };

    await h.ensureTable(queryInterface, 'ledger_accounts', {
      id: { ...uuid, primaryKey: true },
      code: { type: DataTypes.STRING(120), allowNull: false, unique: true },
      type: { type: h.ENUM('asset', 'liability', 'revenue', 'expense', 'equity'), allowNull: false },
      owner_user_id: { type: DataTypes.UUID, allowNull: true },
      vertical: { type: DataTypes.STRING(20), allowNull: true },
      created_at: now,
    });
    await h.ensureIndex(queryInterface, 'ledger_accounts', ['owner_user_id'], { name: 'ix_ledger_accounts_owner' });

    await h.ensureTable(queryInterface, 'ledger_transactions', {
      id: { ...uuid, primaryKey: true },
      kind: { type: DataTypes.STRING(40), allowNull: false },
      ref_type: { type: DataTypes.STRING(30), allowNull: false },
      ref_id: uuid,
      idempotency_key: { type: DataTypes.STRING(160), allowNull: false, unique: true },
      reverses_txn_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'ledger_transactions', key: 'id' }, onDelete: 'RESTRICT' },
      memo: { type: DataTypes.STRING(300), allowNull: true },
      total_poisha: { type: DataTypes.BIGINT, allowNull: false },
      entry_count: { type: DataTypes.SMALLINT, allowNull: false },
      posted_by: { type: DataTypes.UUID, allowNull: true },
      posted_at: now,
    });
    await h.ensureIndex(queryInterface, 'ledger_transactions', ['ref_type', 'ref_id'], { name: 'ix_ledger_txn_ref' });
    await h.ensureIndex(queryInterface, 'ledger_transactions', ['posted_at'], { name: 'ix_ledger_txn_posted' });

    await h.ensureTable(queryInterface, 'ledger_entries', {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      txn_id: uuid,
      account_id: { ...uuid, references: { model: 'ledger_accounts', key: 'id' }, onDelete: 'RESTRICT' },
      escrow_hold_id: { type: DataTypes.UUID, allowNull: true },
      debit_poisha: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      credit_poisha: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    });
    await h.ensureIndex(queryInterface, 'ledger_entries', ['account_id', 'id'], { name: 'ix_ledger_entries_account' });
    await h.ensureIndex(queryInterface, 'ledger_entries', ['txn_id'], { name: 'ix_ledger_entries_txn' });
    await h.ensureIndex(queryInterface, 'ledger_entries', ['escrow_hold_id'], { name: 'ix_ledger_entries_hold' });
    await h.ensureCheck(queryInterface, 'ledger_entries', 'ck_ledger_entries_sides',
      'CHECK (debit_poisha >= 0 AND credit_poisha >= 0 AND ((debit_poisha = 0) <> (credit_poisha = 0)))'
    );

    await h.ensureConstraintSql(queryInterface, 'ledger_entries', 'fk_ledger_entries_txn',
      'ALTER TABLE ledger_entries ADD CONSTRAINT fk_ledger_entries_txn FOREIGN KEY (txn_id) REFERENCES ledger_transactions (id) ' +
        'ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED'
    );

    await q(`CREATE OR REPLACE FUNCTION kg_ledger_check_txn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t uuid;
  hdr ledger_transactions%ROWTYPE;
  d bigint; c bigint; n int;
BEGIN
  -- Separate branches: NEW has txn_id only for ledger_entries rows.
  IF TG_TABLE_NAME = 'ledger_entries' THEN t := NEW.txn_id; ELSE t := NEW.id; END IF;
  SELECT * INTO hdr FROM ledger_transactions WHERE id = t;
  IF NOT FOUND THEN RAISE EXCEPTION 'ledger entries without a posted transaction' USING ERRCODE = 'P0001'; END IF;
  SELECT COALESCE(SUM(debit_poisha), 0), COALESCE(SUM(credit_poisha), 0), COUNT(*) INTO d, c, n FROM ledger_entries WHERE txn_id = t;
  IF n > hdr.entry_count THEN RAISE EXCEPTION 'ledger transaction is already posted' USING ERRCODE = 'P0001'; END IF;
  IF n < 2 OR n <> hdr.entry_count OR d <> c OR d <> hdr.total_poisha THEN
    RAISE EXCEPTION 'ledger transaction is unbalanced' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$`);
    for (const table of ['ledger_entries', 'ledger_transactions']) {
      await h.ensureTrigger(
        queryInterface,
        table,
        `trg_${table}_balanced`,
        `CREATE CONSTRAINT TRIGGER trg_${table}_balanced AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED ` +
          'FOR EACH ROW EXECUTE FUNCTION kg_ledger_check_txn()'
      );
    }
    for (const table of APPEND_ONLY) await h.ensureAppendOnly(queryInterface, table);
  },

  async down(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const table of APPEND_ONLY) await h.dropAppendOnly(queryInterface, table);
    for (const table of ['ledger_entries', 'ledger_transactions']) await q(`DROP TRIGGER IF EXISTS trg_${table}_balanced ON ${table}`);
    await q('DROP FUNCTION IF EXISTS kg_ledger_check_txn()');
    for (const t of ['ledger_entries', 'ledger_transactions', 'ledger_accounts']) await queryInterface.dropTable(t);
  },
};
