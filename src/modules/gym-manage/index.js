'use strict';

/**
 * The gym-manage module's public interface (ADR-007 §3, M24 §7.4): other modules use only this file;
 * everything else in gym-manage is internal (tests/unit/boundaries.test.js). Functions delegate lazily,
 * so requiring the index never changes load order and cannot create a require cycle at load time.
 *
 *   owners     M20 creates the owner's subscription row with their first gym (M24-FR-09, FR-81)
 *   facts      M08 template facts (a member's code; never a name or phone)
 *   consumers  registered by registry.registerAll
 */
const lazy = (file, names, values = []) => {
  const out = Object.fromEntries(names.map((n) => [n, (...args) => require(file)[n](...args)]));
  for (const v of values) Object.defineProperty(out, v, { enumerable: true, get: () => require(file)[v] });
  return Object.freeze(out);
};

module.exports = {
  owners: lazy('./gym-manage.common', ['ensureSubscription']),
  facts: Object.freeze({ member: (...args) => require('./gyms.service').memberFacts(...args) }),
  consumers: lazy('./gym-manage.consumers', ['registerGymManageConsumers']),
};
