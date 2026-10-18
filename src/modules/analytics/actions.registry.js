'use strict';

/**
 * M19 "Needs your action" (FR-11, FR-12): asks each owning module's provider in parallel (800 ms each;
 * a slow or failing provider is skipped, never the whole list), then sorts by due time and severity.
 * Items carry a key, a count and a link to the owning screen; M19 never acts on them itself.
 */
const logger = require('../../common/logger');

const TIMEOUT_MS = 800;
const SEVERITY = { high: 0, normal: 1, low: 2 };

/** Providers per role: (principal) → items. Each module exposes its own pendingActions. */
const PROVIDERS = {
  member: [
    (p) => require('../bookings/bookings.reads').pendingActions(p, 'member'),
    // M13: parcels marked delivered that the buyer has not confirmed.
    (p) => require('../orders/orders.reads').pendingActions(p, 'member'),
    // M11: requests to pay and jobs to confirm (managers); requests to answer and today's jobs (players and pros).
    (p) => require('../hire/hire.reads').pendingActions(p, 'member'),
    async (p) => (['player', 'pro'].some((r) => p.roles?.[r] === 'active') ? require('../hire/hire.reads').pendingActions(p, 'pro') : []),
    // M20: trainer renewals to pay (members).
    (p) => require('../gym/gym.reads').pendingActions(p, 'member'),
    async (p) => (p.roles?.member === 'active' ? [] : [{ key: p.roles?.member === 'in_review' ? 'nid_in_review' : 'verify_nid', count: 1, severity: 'normal', dueAt: null, href: '/account/verification' }]),
  ],
  ground_owner: [(p) => require('../bookings/bookings.reads').pendingActions(p, 'ground_owner'), (p) => require('../grounds/grounds.reads').pendingActions(p)],
  // M12: the shop and products with changes requested, and stock running low, out or blocked for expiry.
  // M13: orders to accept and to ship.
  shop_owner: [(p) => require('../market/market.reads').pendingActions(p), (p) => require('../orders/orders.reads').pendingActions(p, 'shop_owner')],
  // M20: gyms with changes requested.
  gym_owner: [(p) => require('../gym/gym.reads').pendingActions(p, 'gym_owner')],
  staff: [
    async (p) => {
      const s = await require('../moderation/moderation.service').stats(p);
      return [...(s.inQueue ? [{ key: 'review_queue', count: s.inQueue, severity: s.overdue ? 'high' : 'normal', dueAt: null, href: '/admin/moderation' }] : [])];
    },
    // M18: open risk flags, for staff who work the risk desk (manage_users) and masters.
    async (p) => {
      if (!p.isMaster && !p.permissions?.has?.('manage_users')) return [];
      const c = await require('../risk/flags.service').counts();
      const n = c.critical + c.high + c.medium + c.info;
      return n ? [{ key: 'risk_flags', count: n, severity: c.critical || c.high ? 'high' : 'normal', dueAt: null, href: '/admin/risk' }] : [];
    },
  ],
};

const withTimeout = (promise) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('provider timed out')), TIMEOUT_MS))]);

async function list(principal, role, { limit = 6 } = {}) {
  const providers = PROVIDERS[role] ?? [];
  const results = await Promise.allSettled(providers.map((fn) => withTimeout(fn(principal))));
  const items = [];
  for (const r of results) {
    if (r.status === 'fulfilled') items.push(...r.value);
    else logger.warn({ err: r.reason?.message, role }, 'action provider skipped');
  }
  items.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'));
  return { items: items.slice(0, limit), total: items.length };
}

module.exports = { list, PROVIDERS };
