'use strict';

/**
 * The gym module's public interface (ADR-007 §3): other modules use only this file; everything
 * else in gym is internal (tests/unit/boundaries.test.js). Each facade lists exactly what other
 * modules call. Functions delegate lazily, so requiring the index never changes load order and cannot
 * create a require cycle at load time.
 */
const lazy = (file, names, values = []) => {
  const out = Object.fromEntries(names.map((n) => [n, (...args) => require(file)[n](...args)]));
  for (const v of values) Object.defineProperty(out, v, { enumerable: true, get: () => require(file)[v] });
  return Object.freeze(out);
};

module.exports = {
  // Round B3: the gym adapter of the business-members port (registered by registry.registerAll).
  businessPort: lazy('./gym.business', ['register']),
  disputes: lazy('./gym.disputes', ['register']),
  reviewSource: lazy('./gym.reviews', ['register']),
  reads: lazy('./gym.reads', ['exportPassKpiFacts', 'passFacts', 'passKpiFact', 'pendingActions']),
  gyms: lazy('./gyms.service', ['facts']),
};
