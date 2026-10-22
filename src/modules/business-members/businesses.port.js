'use strict';

/**
 * Round B3 business port (ADR-007): the businesses staff can work at. business-members never imports
 * the verticals; each one registers an adapter from its own index.js at boot (the composition root,
 * modules/registry.js): M09 grounds → `venue`, M20 gym → `gym`, M12 market → `shop`.
 *
 *   business(id, { transaction })  → null | { id, ownerId, name, status }   (display data only)
 *   businessesOf(ownerId)          → [{ id, name, status }] the owner's businesses (not removed)
 *   staffActions(businessId, permissions, now) → [{ key, count, severity, dueAt, href }] (optional:
 *                                    the staff to-do for one workplace, by the staff's permissions)
 *
 * describe() adds the owner's live role status (M01 users directory), so the caller can tell whether
 * staff of a suspended owner may still work there.
 */
const directory = require('../users').directory;
const rules = require('./business-members.rules');

const adapters = new Map();

function register(type, impl) {
  if (!rules.isType(type)) throw new Error(`Unknown business type ${type}`);
  adapters.set(type, impl);
}

function get(type) {
  const a = adapters.get(type);
  if (!a) throw new Error(`No business adapter registered for ${type} (modules/registry.js registers them at boot)`);
  return a;
}

const registered = () => [...adapters.keys()];

/** One business with its owner's role status: null when unknown or removed. */
async function describe(type, id, { transaction } = {}) {
  const b = await get(type).business(id, { transaction });
  if (!b || b.status === 'removed') return null;
  const [roleStatus, member, accounts] = await Promise.all([
    directory.roleStatus(b.ownerId, rules.OWNER_ROLE[type], { transaction }),
    directory.roleStatus(b.ownerId, 'member', { transaction }),
    directory.accounts([b.ownerId]),
  ]);
  const ownerLive = roleStatus === 'active' && member === 'active' && accounts.get(b.ownerId)?.status === 'active';
  return { ...b, businessType: type, ownerRoleStatus: roleStatus, ownerLive };
}

/** The owner's businesses of every type: [{ businessType, id, name, status }]. */
async function ownedBy(ownerId) {
  const out = [];
  for (const type of rules.TYPES) {
    if (!adapters.has(type)) continue;
    for (const b of await get(type).businessesOf(ownerId)) out.push({ businessType: type, ...b });
  }
  return out;
}

/** The to-do of one workplace (empty when the vertical has none). */
async function staffActions(type, businessId, permissions, now = new Date()) {
  const a = get(type);
  return a.staffActions ? a.staffActions(businessId, permissions, now) : [];
}

module.exports = { register, get, registered, describe, ownedBy, staffActions };
