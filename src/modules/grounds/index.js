'use strict';

/**
 * The grounds module's public interface (ADR-007 §3): other modules use only this file; everything
 * else in grounds is internal (tests/unit/boundaries.test.js). Each facade lists exactly what other
 * modules call. Functions delegate lazily, so requiring the index never changes load order and cannot
 * create a require cycle at load time.
 */
const lazy = (file, names, values = []) => {
  const out = Object.fromEntries(names.map((n) => [n, (...args) => require(file)[n](...args)]));
  for (const v of values) Object.defineProperty(out, v, { enumerable: true, get: () => require(file)[v] });
  return Object.freeze(out);
};

module.exports = {
  reads: lazy('./grounds.reads', ['courts', 'ground', 'groundsOf', 'hoursFor', 'isOpen', 'liveGroundsOf', 'pendingActions', 'publishedVersionAt', 'versionById']),
  rules: lazy('./grounds.rules', ['isOpenAt', 'toHHMM', 'toMin']),
  grounds: lazy('./grounds.service', ['facts', 'staffActionInTx']),
  occupancyPort: lazy('./occupancy.port', ['register']),
  pricingRules: lazy('./pricing.rules', ['courtBase', 'dhakaInstant', 'dhakaParts', 'hourlyRate', 'price']),
  pricing: lazy('./pricing.service', ['priceSlot']),
};
