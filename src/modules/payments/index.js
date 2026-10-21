'use strict';

/**
 * The payments module's public interface (ADR-007 §3, rule 2): only the payment group touches the
 * ledger, escrow and refunds, and every other module calls them through this file. Everything else
 * in payments is internal (the boundary test enforces it).
 *
 * Each function delegates lazily (it requires its file on first call), so requiring the index never
 * changes the order modules load in and cannot create a require cycle at load time. Callers keep their
 * transactions: the money calls below run in the caller's transaction, as before, so a booking
 * check-in still releases escrow, takes the fee and pays the owner atomically.
 */
const lazy = (file, names, constants = []) => {
  const out = Object.fromEntries(names.map((n) => [n, (...args) => require(file)[n](...args)]));
  for (const c of constants) Object.defineProperty(out, c, { enumerable: true, get: () => require(file)[c] });
  return Object.freeze(out);
};

module.exports = {
  /** Payment intents: create and cancel what a payer pays, and where they pay it. */
  intents: lazy('./payments.service', ['createIntent', 'cancelIntent', 'payUrl', 'facts', 'paymentFact', 'exportPaymentFacts', 'payeeRefundStats']),

  /** Purpose hooks: a module registers what happens when its payments are captured or closed. */
  purposes: lazy('./payments.purposes', ['register'], ['PURPOSES']),

  /** Escrow holds: open on capture; lock, freeze, release, settle and collect inside the caller's transaction. */
  escrow: lazy('./escrow.service', [
    'getOne',
    'list',
    'holdIdForPayment',
    'lockHoldForPayment',
    'lockOpenHoldsForPurpose',
    'freezeInTx',
    'unfreezeInTx',
    'releaseInTx',
    'settlePool',
    'settleOrganiserPool',
    'collectToRevenueInTx',
    'reverseToOrganiser',
    'reversePoolCredit',
  ]),

  /** Refunds of a payment (full or partial), and the facts analytics reads. */
  refunds: lazy('./refunds.service', ['refundPayment', 'settleManually', 'facts']),

  /** The fee snapshot taken when an obligation is created, and fee receivables. */
  fees: lazy('./fee.service', ['snapshot', 'accrueReceivable', 'reverseReceivable']),

  /** Ledger reads; post and reverse are for the payment group (payouts) only. */
  ledger: lazy('./ledger.service', ['balance', 'payableEntries', 'earningsBy', 'transactionsFor', 'feeFact', 'exportFeeFacts', 'post', 'reverse']),

  /** Ledger invariants other modules add (checked by the payments invariants job). */
  invariants: lazy('./invariants.service', ['register']),
};
