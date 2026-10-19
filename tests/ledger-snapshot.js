'use strict';

/**
 * Ledger snapshot (ADR-007 Q163), loaded only when LEDGER_SNAPSHOT is set (jest.config.js). After
 * each test it records every ledger transaction the test posted, in order, with ids replaced by
 * stable placeholders, and appends them to the JSON file named by LEDGER_SNAPSHOT. Two runs of the
 * money suites (before and after a refactor) must produce identical files.
 *
 *   LEDGER_SNAPSHOT=before.json npx jest tests/e2e/bookings.test.js …
 */
const fs = require('fs');

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

afterEach(async () => {
  const { sequelize } = require('../src/models');
  const [rows] = await sequelize.query(
    `SELECT t.id AS txn, t.kind, t.ref_type, t.total_poisha, a.code, e.debit_poisha, e.credit_poisha
       FROM ledger_transactions t JOIN ledger_entries e ON e.txn_id = t.id JOIN ledger_accounts a ON a.id = e.account_id
      ORDER BY t.created_at, t.id, a.code, e.debit_poisha, e.credit_poisha`
  );
  const ids = new Map();
  const stable = (s) => String(s).replace(UUID, (u) => (ids.has(u) ? ids.get(u) : (ids.set(u, `#${ids.size + 1}`), ids.get(u))));
  const txns = [];
  for (const r of rows) {
    let t = txns.at(-1);
    if (!t || t.id !== r.txn) txns.push((t = { id: r.txn, kind: r.kind, ref: r.ref_type, total: String(r.total_poisha), entries: [] }));
    t.entries.push(`${stable(r.code)} Dr ${r.debit_poisha} Cr ${r.credit_poisha}`);
  }
  const { currentTestName, testPath } = expect.getState();
  const file = process.env.LEDGER_SNAPSHOT;
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  all[`${testPath.split(/[\\/]/).pop()} › ${currentTestName}`] = txns.map(({ id, ...t }) => t);
  fs.writeFileSync(file, JSON.stringify(all, null, 1));
});
