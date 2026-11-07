'use strict';

/**
 * Round B3 staff accounts for businesses (Q69, Q169, Q170): the pure rules at 100% branch coverage.
 * Allow-lists and defaults (B3 permission table, Q170 optional-off), permission checks and diffing,
 * actFor (every branch: owner, staff, foreign, 404, 403s), the staff gates work_ground / work_gym /
 * work_shop (M01 gate), the list default, and the staff redaction (no money keys, ever).
 */
require('../env');
const rules = require('../../src/modules/business-members/business-members.rules');
const view = require('../../src/modules/business-members/business-members.serializer');
const gate = require('../../src/modules/auth/gate.service');

const OWNER_ID = '00000000-0000-4000-8000-000000000001';
const STAFF_ID = '00000000-0000-4000-8000-000000000002';
const GROUND = '00000000-0000-4000-8000-0000000000a1';
const GROUND_B = '00000000-0000-4000-8000-0000000000a2';
const SHOP = '00000000-0000-4000-8000-0000000000b1';
const SHOP_B = '00000000-0000-4000-8000-0000000000b2';

const owner = (role = 'active', extra = {}) => ({ id: OWNER_ID, user: { status: 'active', phone: '+8801711111111', phoneVerifiedAt: new Date() }, roles: { member: 'active', ground_owner: role, shop_owner: role, gym_owner: role }, workplaces: [], ...extra });
const work = (businessType, businessId, permissions, ownerId = OWNER_ID) => ({ id: `w-${businessId}`, businessType, businessId, ownerId, permissions, since: new Date() });
const staff = (workplaces, user = {}) => ({ id: STAFF_ID, user: { status: 'active', phone: '+8801722222222', phoneVerifiedAt: new Date(), ...user }, roles: { member: 'applied' }, workplaces });
const code = (fn) => {
  try {
    fn();
  } catch (err) {
    return { status: err.status, code: err.code, meta: err.meta ?? null };
  }
  return null;
};

describe('B3 permission allow-lists and defaults', () => {
  it('venue: the six desk permissions are on; move, cancel and reply to reviews are optional and off (Q170)', () => {
    expect(rules.defaultsFor('venue')).toEqual(['bookings.check_in', 'bookings.collect_balance', 'bookings.extend', 'bookings.no_show', 'bookings.view', 'bookings.walk_in']);
    expect(rules.allowedFor('venue')).toEqual([...rules.defaultsFor('venue'), 'bookings.cancel', 'bookings.move', 'reviews.reply'].sort());
  });
  it('gym: admit, admissions, check-ins and the member list on; the rest optional (M24-FR-04)', () => {
    expect(rules.defaultsFor('gym')).toEqual(['attendance.mark', 'desk.admissions', 'desk.admit', 'members.view']);
    expect(rules.allowedFor('gym')).toEqual(['attendance.mark', 'cash.drawer', 'desk.admissions', 'desk.admit', 'expenses.manage', 'fees.adjust', 'fees.collect', 'lockers.manage', 'members.edit', 'members.trainer', 'members.view', 'passes.view', 'plans.manage', 'pos.sell', 'reports.view', 'stock.manage']);
  });
  it('gym: editing members and collecting fees need the member list; adjusting fees needs collecting (M24-FR-04)', () => {
    expect(rules.normalizePermissions('gym', ['fees.adjust', 'members.view'])).toEqual({ error: 'PERMISSIONS_INVALID', unknown: [], missing: [{ permission: 'fees.adjust', needs: 'fees.collect' }] });
    expect(rules.normalizePermissions('gym', ['members.edit']).missing).toEqual([{ permission: 'members.edit', needs: 'members.view' }]);
    expect(rules.normalizePermissions('gym', ['fees.collect']).missing).toEqual([{ permission: 'fees.collect', needs: 'members.view' }]);
    expect(rules.normalizePermissions('gym', ['fees.adjust', 'fees.collect', 'members.view'])).toEqual({ permissions: ['fees.adjust', 'fees.collect', 'members.view'] });
    // owner.only is a pseudo-permission: never grantable (M24 §3.3).
    expect(rules.normalizePermissions('gym', [rules.OWNER_ONLY]).unknown).toEqual(['owner.only']);
    expect(rules.NEVER.gym).toEqual(expect.arrayContaining(['billing', 'staff', 'imports', 'exports', 'settings', 'refunds']));
  });
  it('shop: view, accept, ship, deliver orders and view and adjust stock on; reject optional', () => {
    expect(rules.defaultsFor('shop')).toEqual(['orders.accept', 'orders.deliver', 'orders.ship', 'orders.view', 'stock.adjust', 'stock.view']);
    expect(rules.allowedFor('shop')).toContain('orders.reject');
    expect(rules.defaultsFor('shop')).not.toContain('orders.reject');
  });
  it('never for staff: pricing, listing, closures, series, analytics, profile, products, prices, settlement, packages, hours', () => {
    for (const type of rules.TYPES) {
      for (const never of rules.NEVER[type]) {
        expect(rules.allowedFor(type).some((p) => p.split('.').includes(never))).toBe(false);
        expect(rules.normalizePermissions(type, [never]).error).toBe('PERMISSIONS_INVALID');
      }
    }
  });
  it('unknown business types are a programming error', () => {
    expect(() => rules.defaultsFor('club')).toThrow('Unknown business type club');
    expect(rules.isType('venue')).toBe(true);
    expect(rules.isType('club')).toBe(false);
  });
  it('the owner role and gates per type', () => {
    expect(rules.OWNER_ROLE).toEqual({ venue: 'ground_owner', gym: 'gym_owner', shop: 'shop_owner' });
    expect(rules.OWNER_GATE).toEqual({ venue: 'list_ground', gym: 'list_gym', shop: 'list_product' });
    expect(rules.WORK_GATE).toEqual({ venue: 'work_ground', gym: 'work_gym', shop: 'work_shop' });
  });
});

describe('normalizePermissions and diffPermissions', () => {
  it('sorts and de-duplicates a valid choice', () => {
    expect(rules.normalizePermissions('venue', ['bookings.view', 'bookings.check_in', 'bookings.view'])).toEqual({ permissions: ['bookings.check_in', 'bookings.view'] });
    expect(rules.normalizePermissions('gym', [])).toEqual({ permissions: [] });
  });
  it('refuses unknown keys and another type’s keys', () => {
    expect(rules.normalizePermissions('gym', ['orders.view', 'desk.admit'])).toEqual({ error: 'PERMISSIONS_INVALID', unknown: ['orders.view'], missing: [] });
  });
  it('refuses a permission without the one it needs', () => {
    expect(rules.normalizePermissions('venue', ['bookings.check_in'])).toEqual({ error: 'PERMISSIONS_INVALID', unknown: [], missing: [{ permission: 'bookings.check_in', needs: 'bookings.view' }] });
    expect(rules.normalizePermissions('shop', ['stock.adjust']).missing).toEqual([{ permission: 'stock.adjust', needs: 'stock.view' }]);
  });
  it('diffs two lists', () => {
    expect(rules.diffPermissions(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'], changed: true });
    expect(rules.diffPermissions(['a'], ['a'])).toEqual({ added: [], removed: [], changed: false });
  });
  it('a team is full at business.team_max_members', () => {
    expect(rules.teamFull({ activeCount: 9, max: 10 })).toBe(false);
    expect(rules.teamFull({ activeCount: 10, max: 10 })).toBe(true);
  });
});

describe('ownerLive, phoneVerified, workplaces', () => {
  it('owner live needs an active account, member and owner role', () => {
    expect(rules.ownerLive(owner(), 'venue')).toBe(true);
    expect(rules.ownerLive(owner('suspended'), 'venue')).toBe(false);
    expect(rules.ownerLive({ ...owner(), user: { status: 'suspended' } }, 'venue')).toBe(false);
    expect(rules.ownerLive({ ...owner(), roles: { ground_owner: 'active' } }, 'venue')).toBe(false);
    expect(rules.ownerLive({ user: { status: 'active' } }, 'venue')).toBe(false);
    expect(rules.ownerLive(null, 'venue')).toBe(false);
  });
  it('a gym owner is live with an active account, a verified phone and gym_owner not suspended, no NID (M24-FR-03)', () => {
    const plain = { id: OWNER_ID, user: { status: 'active', phone: '+8801711111111', phoneVerifiedAt: new Date() }, roles: { member: 'applied' } };
    expect(rules.ownerLive(plain, 'gym')).toBe(true);
    expect(rules.ownerLive({ ...plain, roles: { gym_owner: 'in_review' } }, 'gym')).toBe(true);
    expect(rules.ownerLive({ ...plain, roles: { gym_owner: 'suspended' } }, 'gym')).toBe(false);
    expect(rules.ownerLive({ ...plain, user: { ...plain.user, phoneVerifiedAt: null } }, 'gym')).toBe(false);
    expect(rules.ownerLive({ ...plain, user: { ...plain.user, status: 'banned' } }, 'gym')).toBe(false);
    expect(rules.ownerLive({ ...plain, roles: undefined }, 'gym')).toBe(true);
    expect(rules.ownerRefusal({ ...plain, user: { ...plain.user, phoneVerifiedAt: null } }, 'gym')).toBe('PHONE_REQUIRED');
    expect(rules.ownerRefusal({ ...plain, roles: { gym_owner: 'suspended' } }, 'gym')).toBe('ROLE_SUSPENDED');
    expect(rules.ownerRefusal({ ...plain, roles: {} }, 'venue')).toBe('ROLE_REQUIRED');
  });
  it('phone verified', () => {
    expect(rules.phoneVerified(staff([]))).toBe(true);
    expect(rules.phoneVerified(staff([], { phoneVerifiedAt: null }))).toBe(false);
    expect(rules.phoneVerified(staff([], { phone: null }))).toBe(false);
    expect(rules.phoneVerified(null)).toBe(false);
  });
  it('canWork and assertCanWork: the staff rule (a verified phone and an active account) shared by actFor, the reviews list and the to-do', () => {
    expect(rules.canWork(staff([]))).toBe(true);
    expect(rules.canWork(staff([], { phoneVerifiedAt: null }))).toBe(false);
    expect(rules.canWork(staff([], { status: 'suspended' }))).toBe(false);
    expect(rules.canWork(null)).toBe(false);
    expect(() => rules.assertCanWork(staff([]))).not.toThrow();
    expect(() => rules.assertCanWork(staff([], { phoneVerifiedAt: null }))).toThrow(expect.objectContaining({ status: 403, code: 'PHONE_REQUIRED' }));
  });
  it('workplaceAt, worksAnyOf and businessesWith', () => {
    const p = staff([work('venue', GROUND, ['bookings.view']), work('shop', SHOP, ['orders.view'])]);
    expect(rules.workplaceAt(p, 'venue', GROUND).businessId).toBe(GROUND);
    expect(rules.workplaceAt(p, 'venue', GROUND_B)).toBeNull();
    expect(rules.workplaceAt(null, 'venue', GROUND)).toBeNull();
    expect(rules.worksAnyOf(p, 'shop')).toBe(true);
    expect(rules.worksAnyOf(p, 'gym')).toBe(false);
    expect(rules.worksAnyOf(null, 'gym')).toBe(false);
    expect(rules.businessesWith(p, 'venue', 'bookings.view')).toEqual([GROUND]);
    expect(rules.businessesWith(p, 'venue', 'bookings.check_in')).toEqual([]);
    expect(rules.businessesWith(undefined, 'venue', 'bookings.view')).toEqual([]);
  });
});

describe('actFor (B3)', () => {
  const NOT_OWNER = () => Object.assign(new Error('not owner'), { status: 403, code: 'NOT_OWNER' });
  const opts = (extra = {}) => ({ ownerId: OWNER_ID, notFound: 'Booking', foreign: NOT_OWNER, ...extra });

  it('an unknown permission is a programming error; a null permission checks membership only', () => {
    expect(() => rules.actFor(owner(), 'venue', GROUND, 'orders.view', opts())).toThrow('Unknown venue permission orders.view');
    expect(rules.actFor(staff([work('venue', GROUND, [])]), 'venue', GROUND, null, opts()).as).toBe('staff');
  });
  it('no principal is 401', () => expect(code(() => rules.actFor(null, 'venue', GROUND, 'bookings.view', opts()))).toMatchObject({ status: 401, code: 'AUTH_REQUIRED' }));
  it('the owner acts as before, with every permission, and is the actor', () => {
    const p = owner();
    const ctx = rules.actFor(p, 'venue', GROUND, 'bookings.cancel', opts());
    expect(ctx).toMatchObject({ as: 'owner', staff: false, ownerId: OWNER_ID, businessType: 'venue', businessId: GROUND });
    expect(ctx.actor).toBe(p);
    expect(ctx.permissions).toEqual(rules.allowedFor('venue'));
    expect(rules.can(ctx, 'bookings.cancel')).toBe(true);
  });
  it('an owner whose role is suspended or missing is refused (ROLE_SUSPENDED, ROLE_REQUIRED)', () => {
    expect(code(() => rules.actFor(owner('suspended'), 'venue', GROUND, 'bookings.view', opts()))).toMatchObject({ status: 403, code: 'ROLE_SUSPENDED' });
    expect(code(() => rules.actFor(owner('in_review'), 'venue', GROUND, 'bookings.view', opts()))).toMatchObject({ status: 403, code: 'ROLE_REQUIRED' });
    expect(code(() => rules.actFor({ id: OWNER_ID, user: { status: 'active' } }, 'venue', GROUND, 'bookings.view', opts()))).toMatchObject({ status: 403, code: 'ROLE_REQUIRED' });
  });
  it('another owner keeps the module’s legacy answer (NOT_OWNER) when they staff no business of the type', () => {
    const other = { ...owner(), id: '00000000-0000-4000-8000-000000000009' };
    expect(code(() => rules.actFor(other, 'venue', GROUND, 'bookings.view', opts()))).toMatchObject({ status: 403, code: 'NOT_OWNER' });
  });
  it('staff of another business get the same 404 as a missing id (never reveals existence)', () => {
    const p = staff([work('venue', GROUND_B, rules.defaultsFor('venue'))]);
    expect(code(() => rules.actFor(p, 'venue', GROUND, 'bookings.view', opts()))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(code(() => rules.actFor(p, 'venue', GROUND, 'bookings.view', { ownerId: OWNER_ID }))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(code(() => rules.actFor(p, 'venue', GROUND, 'bookings.view'))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
  it('a workplace whose owner is not the business owner (stale) is a 404', () => {
    const p = staff([work('venue', GROUND, rules.defaultsFor('venue'), '00000000-0000-4000-8000-000000000008')]);
    expect(code(() => rules.actFor(p, 'venue', GROUND, 'bookings.view', opts()))).toMatchObject({ status: 404 });
    // Without an ownerId to compare (a list where the business row is not loaded) the workplace decides.
    expect(rules.actFor(p, 'venue', GROUND, 'bookings.view', { notFound: 'Booking' }).ownerId).toBe('00000000-0000-4000-8000-000000000008');
  });
  it('staff whose phone is no longer verified, or whose account is not active, are refused', () => {
    const w = [work('venue', GROUND, rules.defaultsFor('venue'))];
    expect(code(() => rules.actFor(staff(w, { phoneVerifiedAt: null }), 'venue', GROUND, 'bookings.view', opts()))).toMatchObject({ status: 403, code: 'PHONE_REQUIRED' });
    expect(code(() => rules.actFor(staff(w, { status: 'suspended' }), 'venue', GROUND, 'bookings.view', opts()))).toMatchObject({ status: 403, code: 'PHONE_REQUIRED' });
  });
  it('staff without the permission get 403 PERMISSION_REQUIRED naming it', () => {
    const p = staff([work('venue', GROUND, rules.defaultsFor('venue'))]);
    expect(code(() => rules.actFor(p, 'venue', GROUND, 'bookings.cancel', opts()))).toEqual({ status: 403, code: 'PERMISSION_REQUIRED', meta: { permission: 'bookings.cancel', businessType: 'venue', businessId: GROUND } });
  });
  it('owner.only (M24-FR-06): the owner passes, staff get 403 PERMISSION_REQUIRED naming it', () => {
    const GYM = '00000000-0000-4000-8000-0000000000c1';
    const gymOpts = { ownerId: OWNER_ID, notFound: 'Gym' };
    expect(rules.actFor(owner(), 'gym', GYM, rules.OWNER_ONLY, gymOpts).as).toBe('owner');
    expect(code(() => rules.actFor(staff([work('gym', GYM, rules.allowedFor('gym'))]), 'gym', GYM, rules.OWNER_ONLY, gymOpts))).toEqual({ status: 403, code: 'PERMISSION_REQUIRED', meta: { permission: 'owner.only', businessType: 'gym', businessId: GYM } });
    // A private gym's owner (no documents, no NID) acts with a verified phone; without it PHONE_REQUIRED.
    const plain = { id: OWNER_ID, user: { status: 'active', phone: '+8801711111111', phoneVerifiedAt: new Date() }, roles: { member: 'applied' }, workplaces: [] };
    expect(rules.actFor(plain, 'gym', GYM, 'members.edit', gymOpts).as).toBe('owner');
    expect(code(() => rules.actFor({ ...plain, user: { ...plain.user, phoneVerifiedAt: null } }, 'gym', GYM, 'members.edit', gymOpts))).toMatchObject({ status: 403, code: 'PHONE_REQUIRED' });
    expect(code(() => rules.actFor({ ...plain, roles: { gym_owner: 'suspended' } }, 'gym', GYM, 'members.edit', gymOpts))).toMatchObject({ status: 403, code: 'ROLE_SUSPENDED' });
  });
  it('staff with the permission act for the owner: actor is the staff member, onBehalfOf the owner', () => {
    const p = staff([work('venue', GROUND, rules.defaultsFor('venue'))]);
    const ctx = rules.actFor(p, 'venue', GROUND, 'bookings.check_in', opts());
    expect(ctx).toMatchObject({ as: 'staff', staff: true, ownerId: OWNER_ID, businessType: 'venue', businessId: GROUND });
    expect(ctx.actor).toMatchObject({ id: STAFF_ID, onBehalfOf: OWNER_ID, actingRole: 'business_staff' });
    expect(p.onBehalfOf).toBeUndefined();
    expect(rules.can(ctx, 'bookings.check_in')).toBe(true);
    expect(rules.can(ctx, 'bookings.cancel')).toBe(false);
  });
});

describe('defaultWorkplace (shop lists without ?shopId)', () => {
  it('the live owner keeps today’s behaviour (their own shop)', () => expect(rules.defaultWorkplace(owner(), 'shop', 'orders.view')).toBeNull());
  it('staff with one shop get it', () => expect(rules.defaultWorkplace(staff([work('shop', SHOP, ['orders.view'])]), 'shop', 'orders.view')).toBe(SHOP));
  it('staff of shops without the permission are refused', () =>
    expect(code(() => rules.defaultWorkplace(staff([work('shop', SHOP, ['stock.view'])]), 'shop', 'orders.view'))).toMatchObject({ status: 403, code: 'PERMISSION_REQUIRED' }));
  it('someone who works nowhere falls back to the owner path (the gate refuses them first)', () => expect(rules.defaultWorkplace(staff([]), 'shop', 'orders.view')).toBeNull());
  it('staff of several shops must name one (BUSINESS_REQUIRED)', () =>
    expect(code(() => rules.defaultWorkplace(staff([work('shop', SHOP, ['orders.view']), work('shop', SHOP_B, ['orders.view'])]), 'shop', 'orders.view'))).toEqual({ status: 422, code: 'BUSINESS_REQUIRED', meta: { businessType: 'shop', choices: 2 } }));
  it('fail() without meta', () => expect(rules.fail('TEAM_FULL')).toMatchObject({ status: 409, code: 'TEAM_FULL', meta: undefined }));
});

describe('what staff never see (forStaff, hiddenKeysIn)', () => {
  const owned = {
    booking: { id: 'b', money: { price: 200000, total: 200000, paidOnline: 50000, dueAtVenue: 150000, fee: 10000, released: 40000, retained: 0, refund: 0 } },
    released: { released: 40000, fee: 10000 },
    items: [{ money: { commission: 500, commissionBps: 500, net: 9500, total: 10000 } }, 'x', null, 3],
    kpis: { stockValuePoisha: 99, outOfStock: 1 },
    at: new Date('2026-10-22T00:00:00Z'),
    settlement: { net: 1 },
    payoutsHref: '/vendor/payouts',
    online: { providerCharge: 3000, providerChargePoisha: 3000, amount: 150000 },
  };
  it('removes every hidden key at any depth and keeps the rest (dates too)', () => {
    const out = rules.forStaff(owned);
    expect(rules.hiddenKeysIn(out)).toEqual([]);
    expect(out.booking.money).toEqual({ price: 200000, total: 200000, paidOnline: 50000, dueAtVenue: 150000, refund: 0 });
    expect(out.items[0].money).toEqual({ total: 10000 });
    expect(out.items.slice(1)).toEqual(['x', null, 3]);
    expect(out.kpis).toEqual({ outOfStock: 1 });
    expect(out.at).toEqual(owned.at);
    expect(out.released).toBeUndefined();
    expect(out.online).toEqual({ amount: 150000 }); // M24-FR-04: the provider charge never reaches staff
  });
  it('hiddenKeysIn finds them in the owner’s view', () => {
    expect(rules.hiddenKeysIn(owned)).toEqual(expect.arrayContaining(['booking.money.fee', 'booking.money.released', 'booking.money.retained', 'released', 'items[0].money.commission', 'items[0].money.net', 'kpis.stockValuePoisha', 'settlement', 'payoutsHref']));
    expect(rules.hiddenKeysIn(null)).toEqual([]);
  });
});

describe('the staff gates (M01 gate, Q169)', () => {
  it('the owner passes exactly as with list_*', () => {
    expect(gate.evaluateAction(owner(), 'work_ground')).toEqual({ allowed: true });
    expect(gate.evaluateAction(owner(), 'work_gym')).toEqual({ allowed: true });
    expect(gate.evaluateAction(owner(), 'work_shop')).toEqual({ allowed: true });
  });
  it('staff with a verified phone pass without NID; without it PHONE_REQUIRED', () => {
    expect(gate.evaluateAction(staff([work('venue', GROUND, ['bookings.view'])]), 'work_ground')).toEqual({ allowed: true });
    expect(gate.evaluateAction(staff([work('venue', GROUND, ['bookings.view'])], { phoneVerifiedAt: null }), 'work_ground').code).toBe('PHONE_REQUIRED');
    expect(gate.evaluateAction(staff([work('venue', GROUND, ['bookings.view'])], { status: 'suspended' }), 'work_ground').code).toBe('ACCOUNT_SUSPENDED');
  });
  it('staff of one type do not pass another type’s gate; non-staff get the owner gate’s answer', () => {
    expect(gate.evaluateAction(staff([work('venue', GROUND, ['bookings.view'])]), 'work_shop').code).toBe('KYC_REQUIRED');
    // M24 §3.4: work_gym lets anyone with a verified phone through as a would-be gym owner (run_gym);
    // which gym is checked by actFor (404 for gyms they neither own nor staff).
    expect(gate.evaluateAction(staff([]), 'work_gym')).toEqual({ allowed: true });
    expect(gate.evaluateAction(staff([], { phoneVerifiedAt: null }), 'work_gym').code).toBe('PHONE_REQUIRED');
    expect(gate.evaluateAction({ ...owner('suspended') }, 'work_ground').code).toBe('ROLE_SUSPENDED');
    expect(gate.evaluateAction(null, 'work_ground').code).toBe('AUTH_REQUIRED');
    expect(gate.evaluateAction({ user: { status: 'active' }, roles: { member: 'active' } }, 'work_ground').code).toBe('ROLE_REQUIRED');
  });
});

describe('serializer', () => {
  const row = { id: 'r', businessType: 'shop', businessId: SHOP, memberId: STAFF_ID, permissions: ['stock.view', 'orders.view'], status: 'active', createdAt: new Date('2026-10-22T00:00:00Z'), removedAt: null };
  it('a team row shows the last 4 digits only, never the phone', () => {
    const v = view.teamMemberView(row, { business: { id: SHOP, name: 'Gear', status: 'live' }, member: { displayName: 'Rafi', phone: '+8801722222222' } });
    expect(v).toEqual({ id: 'r', businessType: 'shop', businessId: SHOP, business: { businessType: 'shop', id: SHOP, name: 'Gear', status: 'live' }, member: { id: STAFF_ID, displayName: 'Rafi', phoneLast4: '2222' }, permissions: ['orders.view', 'stock.view'], status: 'active', addedAt: '2026-10-22T00:00:00.000Z', removedAt: null });
    expect(JSON.stringify(v)).not.toContain('8801722222222');
  });
  it('a team row without business or member details', () => {
    const v = view.teamMemberView(row);
    expect(v.business).toBeNull();
    expect(v.member).toEqual({ id: STAFF_ID, displayName: null, phoneLast4: null });
    expect(view.teamMemberView(row, { business: { id: SHOP } }).business).toEqual({ businessType: 'shop', id: SHOP, name: null, status: null });
  });
  it('a workplace', () => {
    const w = work('venue', GROUND, ['bookings.view']);
    expect(view.workplaceView(w, { business: { id: GROUND, name: 'Arena', status: 'live' }, ownerName: 'Owner' })).toMatchObject({ businessType: 'venue', business: { name: 'Arena' }, owner: { id: OWNER_ID, displayName: 'Owner' } });
    expect(view.workplaceView({ ...w, since: null }, { business: null })).toMatchObject({ business: { id: GROUND, name: null }, owner: { displayName: null }, since: null });
  });
  it('the permission catalogue lists every permission with its default and dependency', () => {
    const c = view.permissionCatalogue();
    expect(Object.keys(c)).toEqual(['venue', 'gym', 'shop']);
    expect(c.venue.find((p) => p.key === 'bookings.cancel')).toEqual({ key: 'bookings.cancel', default: false, needs: 'bookings.view' });
    expect(c.gym.find((p) => p.key === 'desk.admit')).toEqual({ key: 'desk.admit', default: true, needs: null });
  });
});
