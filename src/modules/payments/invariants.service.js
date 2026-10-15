'use strict';

/**
 * Ledger invariants (M06 FR-19, §10 ledger.invariants, nightly 02:30 Dhaka). Read-only checks:
 *   trial_balance        Σ debit = Σ credit over the whole ledger
 *   no_orphan_entries    every entry belongs to a posted transaction
 *   escrow_matches_holds each escrow account = Σ money still in its purpose's holds
 *   holds_match_ledger   each hold's sub-ledger (entries tagged with it) = what the hold row says it still holds
 *   no_negative          no escrow:* or payable:* account below zero
 *   clearing_age         provider_clearing not settled for payments.clearing_alert_days (0 = off until settlement import)
 * Any failure publishes ledger.invariant_failed (M08 alerts masters and finance).
 */
const { sequelize } = require('../../models');
const settings = require('../settings/settings.service');
const events = require('../events/events.service');
const { toPoisha } = require('../../common/money');
const ledger = require('./ledger.service');
const purposes = require('./payments.purposes');

async function check({ publish = true } = {}) {
  const results = [];
  const add = (name, ok, detail = null) => results.push({ name, ok, detail });

  const tb = await ledger.trialBalance();
  add('trial_balance', tb.difference === 0, tb.difference === 0 ? null : `Debit − credit = ${tb.difference}`);

  const [[orphans]] = await sequelize.query('SELECT COUNT(*) AS n FROM ledger_entries e LEFT JOIN ledger_transactions t ON t.id = e.txn_id WHERE t.id IS NULL');
  add('no_orphan_entries', Number(orphans.n) === 0, Number(orphans.n) ? `${orphans.n} entries without a transaction` : null);

  const escrowBalances = await ledger.balancesByPrefix('escrow:');
  const [holdRows] = await sequelize.query(
    "SELECT purpose, COALESCE(SUM(held_poisha - released_poisha - refunded_poisha), 0) AS amount FROM escrow_holds GROUP BY purpose"
  );
  const holdsByAccount = new Map();
  for (const r of holdRows) {
    const account = purposes.PURPOSES[r.purpose]?.escrowAccount ?? `escrow:${r.purpose}`;
    holdsByAccount.set(account, (holdsByAccount.get(account) ?? 0) + toPoisha(r.amount));
  }
  const accounts = new Set([...escrowBalances.keys(), ...holdsByAccount.keys()]);
  const escrowDiffs = [...accounts].filter((a) => (escrowBalances.get(a) ?? 0) !== (holdsByAccount.get(a) ?? 0));
  add('escrow_matches_holds', escrowDiffs.length === 0, escrowDiffs.length ? `Differs: ${escrowDiffs.join(', ')}` : null);

  const [holdLedger] = await sequelize.query(
    'SELECT h.id, h.held_poisha - h.released_poisha - h.refunded_poisha AS expected, ' +
      'COALESCE((SELECT SUM(e.credit_poisha) - SUM(e.debit_poisha) FROM ledger_entries e WHERE e.escrow_hold_id = h.id), 0) AS actual ' +
      'FROM escrow_holds h HAVING expected <> actual LIMIT 20'
  );
  add('holds_match_ledger', holdLedger.length === 0, holdLedger.length ? `Holds out of line: ${holdLedger.map((r) => r.id).join(', ')}` : null);

  const payables = await ledger.balancesByPrefix('payable:');
  const negatives = [...escrowBalances, ...payables].filter(([, v]) => v < 0).map(([k]) => k);
  add('no_negative', negatives.length === 0, negatives.length ? `Below zero: ${negatives.join(', ')}` : null);

  const days = settings.get('payments.clearing_alert_days');
  if (days > 0) {
    const [aged] = await sequelize.query(
      'SELECT a.code FROM ledger_accounts a JOIN ledger_entries e ON e.account_id = a.id JOIN ledger_transactions t ON t.id = e.txn_id ' +
        "WHERE a.code LIKE 'provider_clearing:%' GROUP BY a.code HAVING SUM(e.debit_poisha) - SUM(e.credit_poisha) > 0 AND MIN(t.posted_at) < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)",
      { replacements: [days] }
    );
    add('clearing_age', aged.length === 0, aged.length ? `Unsettled for over ${days} days: ${aged.map((r) => r.code).join(', ')}` : null);
  }

  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  if (failed.length && publish) {
    await sequelize.transaction((transaction) =>
      events.publish(transaction, { name: 'ledger.invariant_failed', aggregateType: 'ledger', aggregateId: 'ledger', payload: { failed, checkedAt: new Date().toISOString() } })
    );
  }
  return { ok: failed.length === 0, checks: results, checkedAt: new Date().toISOString() };
}

module.exports = { check };
