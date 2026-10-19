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

/**
 * Reference data (places, item catalogue, hire taxonomy, esports catalogue), READ-ONLY outside catalog:
 * other modules may read and join these models; only catalog writes them (the boundary test fails on
 * any write from another group). When a service is split, these become a replicated read model.
 */
const reference = Object.freeze(
  Object.defineProperties(
    {},
    Object.fromEntries(['Sport', 'Division', 'District', 'Area', 'Facility', 'Surface', 'SportRuleSchema', 'ItemCategory', 'ItemType', 'ItemTypeField', 'HireCategory', 'HireRole', 'EsportsGame', 'EsportsMode', 'EsportsMap', 'EsportsPointsPreset'].map((n) => [n, { enumerable: true, get: () => require('../../models')[n] }]))
  )
);

module.exports = {
  reference,
  catalog: lazy('./catalog.service', ['publicAreas', 'publicGames', 'publicItems']),
  hireReads: lazy('./hire.reads', ['role', 'taxonomy']),
  sportRulesRules: lazy('./sport-rules.rules', ['playersOf', 'summary', 'validate']),
  sportRules: lazy('./sport-rules.service', ['bySportKey', 'schemaFor']),
};
