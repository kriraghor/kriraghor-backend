'use strict';

/**
 * M06 ledger service (§6.2, FR-11, FR-12, FR-19). The only writer of ledger_* tables.
 *
 * post() runs inside the caller's transaction:
 *   1. returns the existing transaction when the idempotency key was already posted;
 *   2. creates missing accounts (lazily, ensureAccount);
 *   3. locks every guarded account (escrow:*, payable:*) that this posting debits, in id order (no
 *      deadlocks), and refuses a posting that would take one below zero;
 *   4. writes the entries and the header; a deferred constraint trigger re-checks the balance at COMMIT;
 *   5. publishes ledger.transaction_posted through the outbox.
 * Balances are computed from entries (never stored), so the ledger stays the single source of truth.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { AppError } = require('../../common/errors');
const { toPoisha } = require('../../common/money');
const { uuid7 } = require('../../common/uuid7');
const { sequelize, LedgerAccount, LedgerTransaction, LedgerEntry } = require('../../models');
const events = require('../events/events.service');
const rules = require('./ledger.rules');

const insufficient = (code, balance, needed) =>
  new AppError(409, 'LEDGER_INSUFFICIENT_BALANCE', 'Not enough money in the account for this posting', { meta: { account: code, balance, needed } });

/** Find or create an account by code (accounts are append-only; codes are unique). */
async function ensureAccount(code, transaction) {
  const type = rules.accountType(code);
  const found = await LedgerAccount.findOne({ where: { code }, transaction });
  if (found) return found;
  try {
    // A savepoint: on Postgres a failed statement would otherwise abort the caller's whole transaction.
    return await sequelize.transaction({ transaction }, (savepoint) =>
      LedgerAccount.create({ code, type, ownerUserId: rules.ownerOf(code), vertical: rules.verticalOf(code) }, { transaction: savepoint })
    );
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    return LedgerAccount.findOne({ where: { code }, transaction });
  }
}

/** Credit − debit of one account (liabilities and revenue are positive when they hold money). */
async function balanceOfId(accountId, transaction) {
  const [[row]] = await sequelize.query(
    'SELECT COALESCE(SUM(credit_poisha), 0) AS c, COALESCE(SUM(debit_poisha), 0) AS d FROM ledger_entries WHERE account_id = ?',
    { replacements: [accountId], transaction }
  );
  return toPoisha(row.c) - toPoisha(row.d);
}

/**
 * Post a balanced transaction. `lines` as in ledger.rules. Returns { id, existing }.
 * @param {{kind, refType, refId, idempotencyKey, lines, memo?, postedBy?, reversesTxnId?, publish?}} txn
 */
async function post(txn, { transaction }) {
  if (!transaction) throw new Error('ledger.post must run inside a transaction');
  const total = (() => {
    try {
      return rules.validateLines(txn.lines);
    } catch (err) {
      throw new AppError(500, 'LEDGER_UNBALANCED', 'A ledger posting was refused', { detail: err.message });
    }
  })();

  const existing = await LedgerTransaction.findOne({ where: { idempotencyKey: txn.idempotencyKey }, transaction });
  if (existing) return { id: existing.id, existing: true };

  const codes = [...new Set(txn.lines.map((l) => l.account))];
  const accounts = new Map();
  for (const code of codes.sort()) accounts.set(code, await ensureAccount(code, transaction));

  // Guard: lock debited escrow/payable accounts in id order, then check their balances.
  const net = rules.netByAccount(txn.lines);
  const guarded = codes.filter((c) => rules.isGuarded(c) && net.get(c) < 0).map((c) => accounts.get(c));
  guarded.sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const acc of guarded) {
    await LedgerAccount.findByPk(acc.id, { transaction, lock: transaction.LOCK.UPDATE });
    const balance = await balanceOfId(acc.id, transaction);
    if (balance + net.get(acc.code) < 0) throw insufficient(acc.code, balance, -net.get(acc.code));
  }

  const id = uuid7();
  await LedgerEntry.bulkCreate(
    txn.lines.map((l) => ({
      txnId: id,
      accountId: accounts.get(l.account).id,
      escrowHoldId: l.holdId ?? null,
      debitPoisha: l.debit ?? 0,
      creditPoisha: l.credit ?? 0,
    })),
    { transaction }
  );
  await LedgerTransaction.create(
    {
      id,
      kind: txn.kind,
      refType: txn.refType,
      refId: txn.refId,
      idempotencyKey: txn.idempotencyKey,
      reversesTxnId: txn.reversesTxnId ?? null,
      memo: txn.memo ?? null,
      totalPoisha: total,
      entryCount: txn.lines.length,
      postedBy: txn.postedBy ?? null,
    },
    { transaction }
  );
  await events.publish(transaction, {
    name: 'ledger.transaction_posted',
    aggregateType: 'ledger_transaction',
    aggregateId: id,
    payload: { transactionId: id, kind: txn.kind, refType: txn.refType, refId: txn.refId, total },
  });
  return { id, existing: false };
}

/** Post the mirror of an earlier transaction (FR-11: corrections are reversals). */
async function reverse(txnId, { idempotencyKey, memo, postedBy, kind = 'reversal' }, { transaction }) {
  const original = await LedgerTransaction.findByPk(txnId, { transaction });
  if (!original) throw new AppError(404, 'NOT_FOUND', 'Ledger transaction not found');
  const entries = await LedgerEntry.findAll({ where: { txnId }, include: [{ association: 'account', attributes: ['code'] }], transaction });
  const lines = rules.mirror(
    entries.map((e) => ({ account: e.account.code, holdId: e.escrowHoldId ?? undefined, ...(e.debitPoisha ? { debit: e.debitPoisha } : { credit: e.creditPoisha }) }))
  );
  return post({ kind, refType: original.refType, refId: original.refId, idempotencyKey, lines, memo, postedBy, reversesTxnId: txnId }, { transaction });
}

/** The transaction posted with an idempotency key (null when none). */
const findByKey = (idempotencyKey, transaction) => LedgerTransaction.findOne({ where: { idempotencyKey }, transaction });

/** Balance of an account by code (0 for an account that has never been used). */
async function balance(code, transaction) {
  const acc = await LedgerAccount.findOne({ where: { code }, transaction });
  return acc ? balanceOfId(acc.id, transaction) : 0;
}

/** Credit − debit per account code matching a prefix (e.g. 'escrow:'). */
async function balancesByPrefix(prefix, transaction) {
  const [rows] = await sequelize.query(
    'SELECT a.code, COALESCE(SUM(e.credit_poisha), 0) - COALESCE(SUM(e.debit_poisha), 0) AS bal ' +
      'FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id WHERE a.code LIKE ? GROUP BY a.code',
    { replacements: [`${prefix}%`], transaction }
  );
  return new Map(rows.map((r) => [r.code, Number(r.bal)]));
}

/** Trial balance: totals per account type and overall debit − credit (must be 0). */
async function trialBalance() {
  const [rows] = await sequelize.query(
    'SELECT a.type, COALESCE(SUM(e.debit_poisha), 0) AS d, COALESCE(SUM(e.credit_poisha), 0) AS c ' +
      'FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id GROUP BY a.type'
  );
  const byType = Object.fromEntries(rows.map((r) => [r.type, { debit: toPoisha(r.d), credit: toPoisha(r.c) }]));
  const debit = rows.reduce((s, r) => s + toPoisha(r.d), 0);
  const credit = rows.reduce((s, r) => s + toPoisha(r.c), 0);
  return { debit, credit, difference: debit - credit, byType };
}

/** Accounts for the finance desk, with balances. */
async function listAccounts({ code, limit = 50 } = {}) {
  const [rows] = await sequelize.query(
    'SELECT a.id, a.code, a.type, a.owner_user_id AS "ownerUserId", a.vertical, ' +
      'COALESCE(SUM(e.debit_poisha), 0) AS d, COALESCE(SUM(e.credit_poisha), 0) AS c, COUNT(e.id) AS n ' +
      'FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id ' +
      `${code ? 'WHERE a.code ILIKE ? ' : ''}GROUP BY a.id ORDER BY a.code LIMIT ${Number(limit)}`,
    { replacements: code ? [`%${code}%`] : [] }
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    type: r.type,
    ownerUserId: r.ownerUserId,
    vertical: r.vertical,
    debit: toPoisha(r.d),
    credit: toPoisha(r.c),
    balance: ['asset', 'expense'].includes(r.type) ? toPoisha(r.d) - toPoisha(r.c) : toPoisha(r.c) - toPoisha(r.d),
    entries: Number(r.n),
  }));
}

/** Entries of one account, newest first, cursor = last entry id. */
async function accountEntries(accountId, { cursor, limit = 50 } = {}) {
  const account = await LedgerAccount.findByPk(accountId);
  if (!account) throw new AppError(404, 'NOT_FOUND', 'Ledger account not found');
  const where = { accountId, ...(cursor ? { id: { [Op.lt]: cursor } } : {}) };
  const rows = await LedgerEntry.findAll({ where, include: [{ association: 'txn', attributes: ['kind', 'refType', 'refId', 'memo', 'postedAt'] }], order: [['id', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  return {
    account: { id: account.id, code: account.code, type: account.type, balance: await balanceOfId(account.id) },
    items: page.map((e) => ({
      id: Number(e.id),
      txnId: e.txnId,
      kind: e.txn?.kind,
      refType: e.txn?.refType,
      refId: e.txn?.refId,
      memo: e.txn?.memo ?? null,
      postedAt: e.txn?.postedAt,
      holdId: e.escrowHoldId,
      debit: e.debitPoisha,
      credit: e.creditPoisha,
    })),
    nextCursor: rows.length > limit ? String(page[page.length - 1].id) : null,
  };
}

/** One transaction with its lines. */
async function getTransaction(id) {
  const txn = await LedgerTransaction.findByPk(id, { include: [{ association: 'entries', include: [{ association: 'account', attributes: ['code', 'type'] }] }] });
  if (!txn) throw new AppError(404, 'NOT_FOUND', 'Ledger transaction not found');
  return {
    id: txn.id,
    kind: txn.kind,
    refType: txn.refType,
    refId: txn.refId,
    memo: txn.memo,
    total: txn.totalPoisha,
    reversesTxnId: txn.reversesTxnId,
    postedBy: txn.postedBy,
    postedAt: txn.postedAt,
    lines: txn.entries
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((e) => ({ entryId: Number(e.id), account: e.account.code, type: e.account.type, holdId: e.escrowHoldId, debit: e.debitPoisha, credit: e.creditPoisha })),
  };
}

/**
 * M19 facts: the platform fee lines of a transaction (fee_revenue:{vertical} credits are revenue,
 * debits are reversals); null when the transaction has none.
 */
function feeFactOf(txn, entries) {
  const lines = entries.filter((e) => e.account.code.startsWith('fee_revenue:'));
  if (!lines.length) return null;
  return {
    txnId: txn.id,
    postedAt: txn.postedAt,
    kind: txn.kind,
    vertical: lines[0].account.code.slice('fee_revenue:'.length),
    feeRevenue: lines.reduce((n, e) => n + e.creditPoisha, 0),
    feeReversal: lines.reduce((n, e) => n + e.debitPoisha, 0),
  };
}
async function feeFact(txnId) {
  const txn = await LedgerTransaction.findByPk(txnId);
  if (!txn) return null;
  const entries = await LedgerEntry.findAll({ where: { txnId }, include: [{ association: 'account', attributes: ['code'] }] });
  return feeFactOf(txn, entries);
}

/** M19 reconcile: fee lines of the transactions posted in [since, until). */
async function exportFeeFacts({ since, until }) {
  const txns = await LedgerTransaction.findAll({ where: { postedAt: { [Op.gte]: since, [Op.lt]: until } }, order: [['postedAt', 'ASC']] });
  const entries = txns.length ? await LedgerEntry.findAll({ where: { txnId: txns.map((t) => t.id) }, include: [{ association: 'account', attributes: ['code'] }] }) : [];
  return txns.map((t) => feeFactOf(t, entries.filter((e) => e.txnId === t.id))).filter(Boolean);
}

/** Transactions that reference something (a payment, a refund, a hold). */
async function transactionsFor(refs) {
  const rows = await LedgerTransaction.findAll({ where: { [Op.or]: refs.map(([refType, refId]) => ({ refType, refId })) }, order: [['postedAt', 'ASC'], ['id', 'ASC']] });
  return rows.map((t) => ({ id: t.id, kind: t.kind, refType: t.refType, refId: t.refId, total: t.totalPoisha, postedAt: t.postedAt }));
}

/**
 * M07 §2.1 payableLines: entries on payee accounts (payable:user:*) posted up to `upTo`, except M07's
 * own payout postings, each traced to its source so M07 can schedule it:
 *   source   escrow_hold (a release, or its reversal) | pool (esports pool settlement) | other
 *   purpose  the payment purpose of the source (M07 reads payments.purposes payoutSchedule)
 *   fee      the platform fee M06 took in the same release posting (0 for pools and debits)
 * Optionally only for some payees. Oldest first.
 */
async function payableEntries({ upTo, payeeIds = null, transaction } = {}) {
  const [rows] = await sequelize.query(
    'SELECT e.id, a.owner_user_id AS "payeeId", e.credit_poisha AS c, e.debit_poisha AS d, t.id AS "txnId", t.kind, t.posted_at AS "postedAt", ' +
      'COALESCE(o.ref_type, t.ref_type) AS "srcType", COALESCE(o.ref_id, t.ref_id) AS "srcId", ' +
      'COALESCE(h.purpose, (SELECT g.purpose FROM escrow_holds g WHERE g.group_ref = COALESCE(o.ref_id, t.ref_id) LIMIT 1)) AS purpose, ' +
      "CASE WHEN t.kind LIKE 'escrow.release%' AND e.credit_poisha > 0 THEN (SELECT COALESCE(SUM(f.credit_poisha), 0) FROM ledger_entries f " +
      "JOIN ledger_accounts fa ON fa.id = f.account_id WHERE f.txn_id = t.id AND fa.code LIKE 'fee_revenue:%') ELSE 0 END AS fee " +
      'FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id JOIN ledger_transactions t ON t.id = e.txn_id ' +
      'LEFT JOIN ledger_transactions o ON o.id = t.reverses_txn_id ' +
      "LEFT JOIN escrow_holds h ON COALESCE(o.ref_type, t.ref_type) = 'escrow_hold' AND h.id = COALESCE(o.ref_id, t.ref_id) " +
      "WHERE a.code LIKE 'payable:user:%' AND t.kind NOT LIKE 'payout.%' AND t.posted_at <= ? " +
      `${payeeIds ? 'AND a.owner_user_id IN (?) ' : ''}ORDER BY e.id`,
    { replacements: payeeIds ? [upTo, payeeIds] : [upTo], transaction }
  );
  return rows.map((r) => ({
    entryId: Number(r.id),
    payeeId: r.payeeId,
    credit: toPoisha(r.c),
    debit: toPoisha(r.d),
    txnId: r.txnId,
    kind: r.kind,
    postedAt: r.postedAt,
    source: r.srcType === 'escrow_hold' ? 'escrow_hold' : r.srcType === 'escrow_group' ? 'pool' : 'other',
    sourceId: r.srcId,
    purpose: r.purpose ?? null,
    fee: toPoisha(r.fee),
  }));
}

module.exports = { ensureAccount, post, reverse, findByKey, feeFact, exportFeeFacts, balance, balancesByPrefix, trialBalance, listAccounts, accountEntries, getTransaction, transactionsFor, payableEntries };
