'use strict';

/**
 * Round B3 views. The owner's team list shows each member's display name and the last four digits of
 * their phone only (never the full number); the staff member's workplaces show the business and the
 * owner's display name. No money, ever.
 */
const rules = require('./business-members.rules');

const iso = (d) => (d ? new Date(d).toISOString() : null);
const businessRef = (type, b, fallbackId) => (b ? { businessType: type, id: b.id, name: b.name ?? null, status: b.status ?? null } : { businessType: type, id: fallbackId, name: null, status: null });

/** One row of the owner's team. */
function teamMemberView(row, { business = null, member = null } = {}) {
  return {
    id: row.id,
    businessType: row.businessType,
    businessId: row.businessId,
    business: business ? businessRef(row.businessType, business, row.businessId) : null,
    member: { id: row.memberId, displayName: member?.displayName ?? null, phoneLast4: member?.phone ? member.phone.slice(-4) : null },
    permissions: [...row.permissions].sort(),
    status: row.status,
    addedAt: iso(row.createdAt),
    removedAt: iso(row.removedAt),
  };
}

/** One of the caller's workplaces. */
function workplaceView(w, { business, ownerName }) {
  return {
    id: w.id,
    businessType: w.businessType,
    businessId: w.businessId,
    business: businessRef(w.businessType, business, w.businessId),
    owner: { id: w.ownerId, displayName: ownerName ?? null },
    permissions: [...w.permissions].sort(),
    since: iso(w.since),
  };
}

/** Every permission of every business type, with its default and what it needs (for the team page). */
function permissionCatalogue() {
  return Object.fromEntries(
    rules.TYPES.map((type) => [type, Object.entries(rules.PERMISSIONS[type]).map(([key, on]) => ({ key, default: on, needs: rules.REQUIRES[type][key] ?? null }))])
  );
}

module.exports = { teamMemberView, workplaceView, permissionCatalogue, forStaff: rules.forStaff };
