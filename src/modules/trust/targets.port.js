'use strict';

/**
 * M17 targets port: the modules a dispute can be about. M17 never reads or writes their tables; each
 * source module registers an implementation (M10 bookings.disputes, M21 esports.disputes, M13
 * orders.disputes, M11 hire.disputes, M20 gym.disputes):
 *
 *   permission                                      the staff permission that sees and decides its cases
 *   snapshot({ sourceId, category, principal, transaction })
 *                                                   eligibility (window, payer, status) and what the case
 *                                                   is about: { ref, claimantId, respondentId, money,
 *                                                   paid, held, policyKey, policy }; throws a stable code
 *   options({ sourceId, principal })                the categories the member can open now
 *   freeze / unfreeze({ sourceId, ref, actor, transaction }) (ref: the dispute id)
 *                                                   stop and restart the source's money (escrow)
 *   applyOutcome({ sourceId, dispute, plan, rows, actor, transaction })
 *                                                   carry out the decision in the decision transaction
 *   describe(sourceId)                              a summary for the desk and the parties (no PII)
 *
 * The implementations load on first use, so the api, the worker and the tests all have them.
 */
const targets = new Map();
let loaded = false;

function register(sourceType, impl) {
  targets.set(sourceType, impl);
}

function ensure() {
  if (loaded) return;
  loaded = true;
  require('../bookings/bookings.disputes').register();
  require('../esports/esports.disputes').register();
  require('../orders/orders.disputes').register();
  require('../hire/hire.disputes').register();
  require('../gym/gym.disputes').register();
}

function get(sourceType) {
  ensure();
  const t = targets.get(sourceType);
  if (!t) throw new Error(`No dispute target for ${sourceType}`);
  return t;
}

/** Source types a staff member may work on (by the target's permission; masters see all). */
function visibleTo(actor, hasPermission) {
  ensure();
  return [...targets.entries()].filter(([, t]) => actor.isMaster || hasPermission(actor, t.permission)).map(([type]) => type);
}

module.exports = { register, get, visibleTo };
