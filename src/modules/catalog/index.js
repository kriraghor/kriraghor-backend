'use strict';

/**
 * The catalog module's public interface (ADR-007 §3): other modules use only this file; everything
 * else in catalog is internal (tests/unit/boundaries.test.js). Each facade lists exactly what other
 * modules call. Functions delegate lazily, so requiring the index never changes load order and cannot
 * create a require cycle at load time.
 */
const lazy = (file, names, values = []) => {
  const out = Object.fromEntries(names.map((n) => [n, (...args) => require(file)[n](...args)]));
  for (const v of values) Object.defineProperty(out, v, { enumerable: true, get: () => require(file)[v] });
  return Object.freeze(out);
};

module.exports = {
  catalog: lazy('./catalog.service', ['publicAreas', 'publicGames', 'publicItems']),
  hireReads: lazy('./hire.reads', ['role', 'taxonomy']),
  sportRulesRules: lazy('./sport-rules.rules', ['playersOf', 'summary', 'validate']),
  sportRules: lazy('./sport-rules.service', ['bySportKey', 'schemaFor']),
};
