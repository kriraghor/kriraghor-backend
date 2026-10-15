'use strict';

/**
 * M06 ledger rules (§6.2, §6.3, FR-12, FR-13): the chart of accounts and the posting builders. Pure
 * functions, no I/O, 100% branch coverage (CLAUDE.md: money code). A line is
 *   { account: 'escrow:test_charge', debit: 10000, holdId? }  or  { account, credit, holdId? }
 * Amounts are integer poisha. Every builder returns balanced lines; validateLines() re-checks.
 */
const { assertPoisha, sum } = require('../../common/money');

// §6.2 chart of accounts, by the part before the first ':'.
const ACCOUNT_TYPES = {
  platform_bank: 'asset',
  provider_clearing: 'asset',
  cod_receivable: 'asset',
  fee_receivable: 'asset',
  escrow: 'liability',
  payable: 'liability',
  courier_payable: 'liability',
  refund_clearing: 'liability',
  payout_clearing: 'liability',
  suspense: 'liability',
  fee_revenue: 'revenue',
  provider_fee_expense: 'expense',
  goodwill_expense: 'expense',
  prize_subsidy_expense: 'expense',
};

const CODE_RE = /^[a-z_]+(:[a-z0-9_-]+)*$/;

/** asset | liability | revenue | expense for an account code. Throws on unknown codes. */
function accountType(code) {
  if (typeof code !== 'string' || !CODE_RE.test(code) || code.length > 120) throw new TypeError(`Invalid account code: ${code}`);
  const type = ACCOUNT_TYPES[code.split(':')[0]];
  if (!type) throw new TypeError(`Unknown account: ${code}`);
  return type;
}

/** Liabilities that must never go below zero: customer money in escrow, and money owed to payees. */
const isGuarded = (code) => code.startsWith('escrow:') || code.startsWith('payable:');

/** For a payee account, the user id it belongs to (`payable:user:<uuid>`). */
const ownerOf = (code) => (code.startsWith('payable:user:') ? code.slice('payable:user:'.length) : null);
const verticalOf = (code) => (code.startsWith('fee_revenue:') ? code.slice('fee_revenue:'.length) : null);

/** Checks a set of lines and returns their total. Throws a LedgerError on anything wrong. */
function validateLines(lines) {
  if (!Array.isArray(lines) || lines.length < 2) throw new LedgerError('A ledger transaction needs at least two lines');
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    accountType(line.account);
    const d = line.debit ?? 0;
    const c = line.credit ?? 0;
    assertPoisha(d, 'debit');
    assertPoisha(c, 'credit');
    if ((d > 0) === (c > 0)) throw new LedgerError(`Line on ${line.account} must have exactly one positive side`);
    debit += d;
    credit += c;
  }
  if (debit !== credit) throw new LedgerError(`Unbalanced: debit ${debit} ≠ credit ${credit}`);
  return debit;
}

class LedgerError extends Error {}

/** Net change per account (credit − debit), for the negative-balance guard. */
function netByAccount(lines) {
  const net = new Map();
  for (const l of lines) net.set(l.account, (net.get(l.account) ?? 0) + (l.credit ?? 0) - (l.debit ?? 0));
  return net;
}

/** The mirror of a transaction (corrections are reversals, FR-11). */
const mirror = (lines) => lines.map(({ account, debit, credit, holdId }) => ({ account, holdId, ...(debit ? { credit: debit } : { debit: credit }) }));

const dr = (account, amount, holdId) => ({ account, debit: amount, ...(holdId ? { holdId } : {}) });
const cr = (account, amount, holdId) => ({ account, credit: amount, ...(holdId ? { holdId } : {}) });

/** FR-06: captured money moves from the provider into escrow (tagged with the hold). */
const captureLines = ({ provider, escrowAccount, amount, holdId }) => [dr(`provider_clearing:${provider}`, amount), cr(escrowAccount, amount, holdId)];

/** Edge case 3: money captured with the wrong amount waits in suspense until refunded. */
const mismatchLines = ({ provider, amount }) => [dr(`provider_clearing:${provider}`, amount), cr('suspense', amount)];

/** FR-13: escrow → payee (net) + platform fee. A zero fee posts no fee line. */
function releaseLines({ escrowAccount, holdId, payeeId, vertical, gross, fee }) {
  if (fee > gross) throw new LedgerError('The fee cannot exceed the released amount');
  const lines = [dr(escrowAccount, gross, holdId), cr(`payable:user:${payeeId}`, gross - fee)];
  if (fee > 0) lines.push(cr(`fee_revenue:${vertical}`, fee));
  return lines.filter((l) => (l.debit ?? l.credit) > 0);
}

/** A refund leaves its source (escrow hold, goodwill or suspense) for refund_clearing until the provider confirms. */
function refundReserveLines({ source, escrowAccount, holdId, amount }) {
  const from = { escrow: escrowAccount, goodwill: 'goodwill_expense', suspense: 'suspense' }[source];
  if (!from) throw new LedgerError(`Unknown refund source: ${source}`);
  return [dr(from, amount, source === 'escrow' ? holdId : undefined), cr('refund_clearing', amount)];
}

/** The provider confirmed the refund: the money has left the provider balance. */
const refundSettleLines = ({ provider, amount }) => [dr('refund_clearing', amount), cr(`provider_clearing:${provider}`, amount)];

/**
 * Spread `total` over holds in order, never more than each hold's available amount. Used to record
 * how much of a pool settlement each hold paid out as fee. Returns amounts aligned with `holds`.
 */
function allocate(total, holds) {
  let left = total;
  return holds.map((h) => {
    const take = Math.min(left, h.available);
    left -= take;
    return take;
  });
}

/**
 * Pool settlement (M21 §6.5, FR-23, FR-25): every open hold of a tournament is paid out at once.
 *   Dr escrow (each hold's available)  +  Dr prize_subsidy_expense (shortfall, if prizes > collected)
 *   Cr payable:user:{winner} (each prize)  +  Cr fee_revenue:{vertical} (remainder = collected − prizes)
 * The spec posts the subsidy into escrow first and pays out of escrow; the net effect on every account
 * is the same, and escrow never goes negative either way.
 */
function poolSettlement({ escrowAccount, vertical, holds, prizes }) {
  const collected = sum(holds.map((h) => assertPoisha(h.available, 'hold available')));
  const paid = sum(prizes.map((p) => assertPoisha(p.amount, 'prize')));
  if (prizes.some((p) => p.amount === 0)) throw new LedgerError('A prize line must be more than zero');
  const subsidy = Math.max(0, paid - collected);
  const remainder = Math.max(0, collected - paid);
  const lines = [
    ...holds.filter((h) => h.available > 0).map((h) => dr(escrowAccount, h.available, h.id)),
    ...(subsidy ? [dr('prize_subsidy_expense', subsidy)] : []),
    ...prizes.map((p) => cr(`payable:user:${p.payeeId}`, p.amount)),
    ...(remainder ? [cr(`fee_revenue:${vertical}`, remainder)] : []),
  ];
  const feeByHold = allocate(remainder, holds);
  return { lines, collected, paid, subsidy, remainder, feeByHold };
}

module.exports = {
  ACCOUNT_TYPES,
  accountType,
  isGuarded,
  ownerOf,
  verticalOf,
  validateLines,
  netByAccount,
  mirror,
  captureLines,
  mismatchLines,
  releaseLines,
  refundReserveLines,
  refundSettleLines,
  allocate,
  poolSettlement,
  LedgerError,
};
