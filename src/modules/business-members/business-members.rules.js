'use strict';

/**
 * Round B3 staff accounts for businesses: the pure rules (Q69, Q169, Q170; plan B3). No I/O.
 *
 *  - PERMISSIONS: one allow-list per business type. `true` = on by default when an owner adds a staff
 *    member, `false` = optional (off by default). Anything not listed is never available to staff
 *    (B3-NEVER below documents what that covers). Q170: replying to reviews, cancelling and moving
 *    are optional and off by default; the plan's table listed venue cancel as "never", Q170 wins.
 *  - REQUIRES: a permission that only makes sense with another one (every venue desk action needs
 *    the bookings list, every order action the orders list, adjusting stock the stock list).
 *  - actFor(): who is acting for which business. The owner acts as before; a staff member acts with
 *    their workplace's permissions; anyone else gets a 404 (never reveals that the business exists).
 *  - STAFF_HIDDEN_KEYS / forStaff(): what staff never see (fees, net, released and retained amounts,
 *    commission, stock value, settlement and payouts).
 */
const { AppError, E } = require('../../common/errors');

const TYPES = Object.freeze(['venue', 'gym', 'shop']);

/** The owner's role and public gate per business type (M01 gate actions), and the staff gate. */
const OWNER_ROLE = Object.freeze({ venue: 'ground_owner', gym: 'gym_owner', shop: 'shop_owner' });
const OWNER_GATE = Object.freeze({ venue: 'list_ground', gym: 'list_gym', shop: 'list_product' });
const WORK_GATE = Object.freeze({ venue: 'work_ground', gym: 'work_gym', shop: 'work_shop' });

/** B3 permission allow-lists: key → on by default. */
const PERMISSIONS = Object.freeze({
  venue: Object.freeze({
    'bookings.view': true,
    'bookings.check_in': true,
    'bookings.no_show': true,
    'bookings.extend': true,
    'bookings.collect_balance': true,
    'bookings.walk_in': true,
    'bookings.move': false,
    'bookings.cancel': false,
    'reviews.reply': false,
  }),
  gym: Object.freeze({
    'desk.admit': true,
    'desk.admissions': true,
    'passes.view': false,
  }),
  shop: Object.freeze({
    'orders.view': true,
    'orders.accept': true,
    'orders.ship': true,
    'orders.deliver': true,
    'stock.view': true,
    'stock.adjust': true,
    'orders.reject': false,
  }),
});

/** Never for staff (plan B3): documented here so tests can assert none of it can be granted. */
const NEVER = Object.freeze({
  venue: ['pricing', 'listing', 'closures', 'series', 'analytics', 'payouts', 'settlement'],
  gym: ['listing', 'packages', 'hours', 'analytics', 'payouts', 'settlement'],
  shop: ['profile', 'products', 'prices', 'settlement', 'analytics', 'payouts'],
});

/** A permission → the permission it needs alongside it. */
const REQUIRES = Object.freeze({
  venue: { 'bookings.check_in': 'bookings.view', 'bookings.no_show': 'bookings.view', 'bookings.extend': 'bookings.view', 'bookings.collect_balance': 'bookings.view', 'bookings.walk_in': 'bookings.view', 'bookings.move': 'bookings.view', 'bookings.cancel': 'bookings.view' },
  gym: {},
  shop: { 'orders.accept': 'orders.view', 'orders.ship': 'orders.view', 'orders.deliver': 'orders.view', 'orders.reject': 'orders.view', 'stock.adjust': 'stock.view' },
});

/** Keys staff responses never carry (the owner's view is unchanged). */
const STAFF_HIDDEN_KEYS = Object.freeze(['fee', 'feeBps', 'feePoisha', 'commission', 'commissionBps', 'commissionPoisha', 'net', 'netPoisha', 'released', 'releasedPoisha', 'retained', 'retainedPoisha', 'stockValuePoisha', 'settlement', 'payout', 'payouts', 'payoutsHref']);

const isType = (t) => TYPES.includes(t);
const allowList = (type) => {
  if (!isType(type)) throw new Error(`Unknown business type ${type}`);
  return PERMISSIONS[type];
};

/** The permissions on by default for a business type, sorted. */
const defaultsFor = (type) =>
  Object.entries(allowList(type))
    .filter(([, on]) => on)
    .map(([k]) => k)
    .sort();

/** Every permission a business type allows, sorted. */
const allowedFor = (type) => Object.keys(allowList(type)).sort();

/**
 * Check an owner's choice against the allow-list. Returns { permissions } (sorted, unique) or
 * { error: 'PERMISSIONS_INVALID', unknown, missing } (unknown keys, or a permission without the one
 * it needs).
 */
function normalizePermissions(type, list) {
  const allowed = allowList(type);
  const unique = [...new Set(list)].sort();
  const unknown = unique.filter((p) => !Object.prototype.hasOwnProperty.call(allowed, p));
  const missing = unique.filter((p) => REQUIRES[type][p] && !unique.includes(REQUIRES[type][p])).map((p) => ({ permission: p, needs: REQUIRES[type][p] }));
  if (unknown.length || missing.length) return { error: 'PERMISSIONS_INVALID', unknown, missing };
  return { permissions: unique };
}

/** What changed between two permission lists: { added, removed, changed }. */
function diffPermissions(before, after) {
  const b = new Set(before);
  const a = new Set(after);
  const added = [...a].filter((p) => !b.has(p)).sort();
  const removed = [...b].filter((p) => !a.has(p)).sort();
  return { added, removed, changed: added.length + removed.length > 0 };
}

/** Is the team full? (business.team_max_members; the setting is passed in.) */
const teamFull = ({ activeCount, max }) => activeCount >= max;

/** Is this principal's owner role for the business type live (account active, NID member, role active)? */
function ownerLive(principal, type) {
  const roles = principal?.roles ?? {};
  return principal?.user?.status === 'active' && roles.member === 'active' && roles[OWNER_ROLE[type]] === 'active';
}

const phoneVerified = (principal) => Boolean(principal?.user?.phone && principal?.user?.phoneVerifiedAt);

/** The principal's workplace at one business, or null. */
const workplaceAt = (principal, type, businessId) => (principal?.workplaces ?? []).find((w) => w.businessType === type && w.businessId === businessId) ?? null;
const worksAnyOf = (principal, type) => (principal?.workplaces ?? []).some((w) => w.businessType === type);

/**
 * actFor(principal, businessType, businessId, permission, { ownerId, notFound, foreign }) (B3):
 *   ownerId   the business's owner, from the owning module's row (required)
 *   notFound  the label of the module's own 404 ("Booking"), so a foreign id answers exactly like a
 *             missing one
 *   foreign   optional: the module's legacy "not yours" error for callers who staff no business of
 *             this type (owners keep today's NOT_OWNER answers); staff always get the 404
 * Returns { as: 'owner' | 'staff', staff, ownerId, businessType, businessId, permissions, actor }.
 * `actor` is what audit and events record: the principal itself for the owner; for staff the staff
 * member's principal with onBehalfOf = the owner (audit meta) and actingRole business_staff.
 * Throws 404 (not related), 403 PERMISSION_REQUIRED (staff without the permission), 403 PHONE_REQUIRED
 * (staff whose phone is no longer verified), 403 ROLE_SUSPENDED / ROLE_REQUIRED (the owner's own role
 * is not live).
 */
function actFor(principal, businessType, businessId, permission, { ownerId, notFound = 'Business', foreign = null } = {}) {
  const allowed = allowList(businessType);
  if (permission !== null && !Object.prototype.hasOwnProperty.call(allowed, permission)) throw new Error(`Unknown ${businessType} permission ${permission}`);
  if (!principal) throw E.unauthorized();
  if (ownerId && principal.id === ownerId) {
    if (!ownerLive(principal, businessType)) {
      const suspended = principal.roles?.[OWNER_ROLE[businessType]] === 'suspended';
      throw E.forbidden(suspended ? 'ROLE_SUSPENDED' : 'ROLE_REQUIRED', 'You cannot do this yet', undefined, { role: OWNER_ROLE[businessType] });
    }
    return { as: 'owner', staff: false, ownerId, businessType, businessId, permissions: allowedFor(businessType), actor: principal };
  }
  const w = workplaceAt(principal, businessType, businessId);
  if (!w || (ownerId && w.ownerId !== ownerId)) {
    if (foreign && !worksAnyOf(principal, businessType)) throw foreign();
    throw E.notFound(notFound);
  }
  if (!phoneVerified(principal) || principal.user.status !== 'active') throw E.forbidden('PHONE_REQUIRED', 'Verify your phone number to work at this business', undefined, { next: '/me' });
  if (permission !== null && !w.permissions.includes(permission)) {
    throw new AppError(403, 'PERMISSION_REQUIRED', 'The owner has not given you this permission', { meta: { permission, businessType, businessId } });
  }
  const actor = { ...principal, onBehalfOf: w.ownerId, actingRole: 'business_staff' };
  return { as: 'staff', staff: true, ownerId: w.ownerId, businessType, businessId, permissions: [...w.permissions], actor };
}

/** Can this acting context do a permission? (owners can do everything on a staff-capable desk). */
const can = (ctx, permission) => ctx.as === 'owner' || ctx.permissions.includes(permission);

/** Businesses of a type where the principal holds a permission (for lists across workplaces). */
const businessesWith = (principal, type, permission) =>
  (principal?.workplaces ?? []).filter((w) => w.businessType === type && w.permissions.includes(permission)).map((w) => w.businessId);

/**
 * The business a list endpoint shows when the caller named none (shop lists take ?shopId=): null for
 * an owner whose own business it is (today's behaviour), the only workplace of that type where the
 * caller holds the permission, or BUSINESS_REQUIRED when there are several.
 */
function defaultWorkplace(principal, type, permission) {
  if (ownerLive(principal, type)) return null;
  const ids = businessesWith(principal, type, permission);
  if (ids.length === 1) return ids[0];
  if (!ids.length && worksAnyOf(principal, type)) {
    throw new AppError(403, 'PERMISSION_REQUIRED', 'The owner has not given you this permission', { meta: { permission, businessType: type } });
  }
  if (!ids.length) return null;
  throw fail('BUSINESS_REQUIRED', { businessType: type, choices: ids.length });
}

/** Stable error codes of the module (problem+json). */
const ERRORS = {
  MEMBER_NOT_FOUND: [404, 'No Kriraghor account has this phone number'],
  MEMBER_IS_OWNER: [422, 'You own this business. Add someone else'],
  MEMBER_IS_STAFF: [422, 'Kriraghor team accounts cannot work for a business'],
  PHONE_NOT_VERIFIED: [422, 'This person has not verified their phone number yet'],
  TEAM_FULL: [409, 'Your team is full. Remove someone first'],
  ALREADY_MEMBER: [409, 'This person is already on the team'],
  PERMISSIONS_INVALID: [422, 'Choose permissions from the list for this business'],
  BUSINESS_REQUIRED: [422, 'Choose which business to open'],
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : undefined);

/** Deep copy without the keys staff never see (arrays and nested objects included; dates kept). */
function forStaff(value) {
  if (Array.isArray(value)) return value.map(forStaff);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !STAFF_HIDDEN_KEYS.includes(k))
      .map(([k, v]) => [k, forStaff(v)])
  );
}

/** The keys of STAFF_HIDDEN_KEYS found anywhere in a value (tests assert none in staff responses). */
function hiddenKeysIn(value, path = '') {
  if (Array.isArray(value)) return value.flatMap((v, i) => hiddenKeysIn(v, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const here = path ? `${path}.${k}` : k;
    return [...(STAFF_HIDDEN_KEYS.includes(k) ? [here] : []), ...hiddenKeysIn(v, here)];
  });
}

module.exports = {
  TYPES,
  OWNER_ROLE,
  OWNER_GATE,
  WORK_GATE,
  PERMISSIONS,
  NEVER,
  REQUIRES,
  STAFF_HIDDEN_KEYS,
  isType,
  defaultsFor,
  allowedFor,
  normalizePermissions,
  diffPermissions,
  teamFull,
  ownerLive,
  phoneVerified,
  workplaceAt,
  worksAnyOf,
  actFor,
  can,
  businessesWith,
  defaultWorkplace,
  ERRORS,
  fail,
  forStaff,
  hiddenKeysIn,
};
