'use strict';

/**
 * The payments module's public interface (ADR-007 §3, rule 2). Other modules use only this file;
 * everything else in payments is internal. Each function delegates lazily, so requiring the index
 * never changes the order modules load in (and cannot create a require cycle at load time).
 * Phase 4.2 adds the escrow, refunds, fees and ledger facades.
 */
const lazy = (file, names) => Object.freeze(Object.fromEntries(names.map((n) => [n, (...args) => require(file)[n](...args)])));

module.exports = {
  intents: lazy('./payments.service', ['payUrl']),
};
