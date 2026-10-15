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

/** Transactions that reference something (a payment, a refund, a hold). */
async function transactionsFor(refs) {
  const rows = await LedgerTransaction.findAll({ where: { [Op.or]: refs.map(([refType, refId]) => ({ refType, refId })) }, order: [['postedAt', 'ASC'], ['id', 'ASC']] });
  return rows.map((t) => ({ id: t.id, kind: t.kind, refType: t.refType, refId: t.refId, total: t.totalPoisha, postedAt: t.postedAt }));
}

module.exports = { ensureAccount, post, reverse, balance, balancesByPrefix, trialBalance, listAccounts, accountEntries, getTransaction, transactionsFor };
