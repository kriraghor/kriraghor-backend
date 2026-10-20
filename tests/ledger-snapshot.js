'use strict';

/**
 * Ledger snapshot (ADR-007 Q163), loaded only when LEDGER_SNAPSHOT is set (jest.config.js). After
 * each test it records every ledger transaction the test posted, with ids replaced by stable
 * placeholders, and stores them in the JSON file named by LEDGER_SNAPSHOT. Two runs of the money
 * suites (before and after a refactor) must produce identical files.
 *
 *   LEDGER_SNAPSHOT=before.json npx jest tests/e2e/bookings.test.js …
 *
 * Ordering is canonical, so random ids never decide it: transactions by time, then by their shape;
 * entries by account code with ids masked, then amounts. Placeholders are numbered in that order.
 */
const fs = require('fs');

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const mask = (s) => String(s).replace(UUID, '*');

afterEach(async () => {
  // Unit tests post nothing and some mock or close the database: only end-to-end tests are recorded.
  if (!/[\\/]e2e[\\/]/.test(expect.getState().testPath ?? '')) return;
  const { sequelize } = require('../src/models');
  const [rows] = await sequelize.query(
    `SELECT t.id AS txn, t.posted_at, t.kind, t.ref_type, t.total_poisha, a.code, e.debit_poisha, e.credit_poisha
       FROM ledger_transactions t JOIN ledger_entries e ON e.txn_id = t.id JOIN ledger_accounts a ON a.id = e.account_id`
  );
  const byTxn = new Map();
  for (const r of rows) {
    if (!byTxn.has(r.txn)) byTxn.set(r.txn, { at: new Date(r.posted_at).getTime(), kind: r.kind, ref: r.ref_type, total: String(r.total_poisha), entries: [] });
    byTxn.get(r.txn).entries.push({ code: r.code, dr: String(r.debit_poisha), cr: String(r.credit_poisha) });
  }
  const shape = (t) => `${t.kind}|${t.ref}|${t.total}|${t.entries.map((e) => `${mask(e.code)}:${e.dr}:${e.cr}`).join(',')}`;
  const txns = [...byTxn.values()];
  for (const t of txns) t.entries.sort((a, b) => `${mask(a.code)}:${a.dr.padStart(15, '0')}:${a.cr.padStart(15, '0')}`.localeCompare(`${mask(b.code)}:${b.dr.padStart(15, '0')}:${b.cr.padStart(15, '0')}`));
  txns.sort((a, b) => a.at - b.at || shape(a).localeCompare(shape(b)));

  const ids = new Map();
  const stable = (s) => String(s).replace(UUID, (u) => (ids.has(u) ? ids.get(u) : (ids.set(u, `#${ids.size + 1}`), ids.get(u))));
  const out = txns.map((t) => ({ kind: t.kind, ref: t.ref, total: t.total, entries: t.entries.map((e) => `${stable(e.code)} Dr ${e.dr} Cr ${e.cr}`) }));

  const { currentTestName, testPath } = expect.getState();
  const file = process.env.LEDGER_SNAPSHOT;
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  all[`${testPath.split(/[\\/]/).pop()} › ${currentTestName}`] = out;
  fs.writeFileSync(file, JSON.stringify(all, null, 1));
});
