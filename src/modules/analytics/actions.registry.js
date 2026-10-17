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
    async (p) => (p.roles?.member === 'active' ? [] : [{ key: p.roles?.member === 'in_review' ? 'nid_in_review' : 'verify_nid', count: 1, severity: 'normal', dueAt: null, href: '/account/verification' }]),
  ],
  ground_owner: [(p) => require('../bookings/bookings.reads').pendingActions(p, 'ground_owner'), (p) => require('../grounds/grounds.reads').pendingActions(p)],
  staff: [
    async (p) => {
      const s = await require('../moderation/moderation.service').stats(p);
      return [...(s.inQueue ? [{ key: 'review_queue', count: s.inQueue, severity: s.overdue ? 'high' : 'normal', dueAt: null, href: '/admin/moderation' }] : [])];
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
