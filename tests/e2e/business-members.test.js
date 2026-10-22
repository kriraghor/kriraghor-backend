'use strict';

// Round B3 end to end: staff accounts for businesses (Q69, Q168, Q169, Q170; plan B3).
//  - membership lifecycle: add by verified phone (defaults), every refusal, the cap under a race,
//    change permissions, remove, events, notifications (TEAM_ADDED, TEAM_REMOVED) and audit;
//  - access: workplaces in the principal, authz_version refresh on every change and on the owner's
//    role or account change, a suspended or banned owner's staff losing access at once;
//  - a route-by-route matrix of every staff-capable route (venue, gym, shop): the owner (unchanged),
//    staff with the permission, staff without it (403 PERMISSION_REQUIRED), staff of another business
//    (404), removed staff (403); staff answers carry no money keys and no full phones (except the
//    audited shop shipping contact, Q168); owner-only routes stay closed to staff;
//  - staff notifications and the staff to-do; audit rows name the staff member, onBehalfOf the owner,
//    and the money still goes to the owner.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const ledger = require('../../src/modules/payments/ledger.service');
const bookingsSvc = require('../../src/modules/bookings/bookings.service');
const rules = require('../../src/modules/business-members/business-members.rules');
const bk = require('../fixtures/bookings');
const f = require('../fixtures/market');
const b = require('../fixtures/business');

const { api, P, models } = h;
const HALF = 30 * 60 * 1000;
let seq = 0;
const key = (p) => `${p}-${Date.now()}-${(seq += 1)}`;
const ALL_VENUE = rules.allowedFor('venue');
const ALL_GYM = rules.allowedFor('gym');
const ALL_SHOP = rules.allowedFor('shop');
// The shop and gym cases onboard two businesses each through M02 and M05 (documents and listing reviews).
jest.setTimeout(120000);

let master;
let reviewer;
beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const slot = (days = 1, plusHalfHours = 0) => new Date(Math.ceil((Date.now() + days * 86400000) / HALF) * HALF + plusHalfHours * HALF).toISOString();
const team = (who) => ({
  add: (body) => api().post(`${P}/me/team`).set(h.bearer(who)).send(body),
  list: (q = '') => api().get(`${P}/me/team${q}`).set(h.bearer(who)),
  patch: (id, permissions) => api().patch(`${P}/me/team/${id}`).set(h.bearer(who)).send({ permissions }),
  remove: (id) => api().post(`${P}/me/team/${id}/remove`).set(h.bearer(who)),
});

/** Add `who` to a business and give them a fresh token (their authz_version moved). */
async function hire(ownerSession, businessType, businessId, who, permissions) {
  const r = await team(ownerSession).add({ businessType, businessId, phone: who.phone, ...(permissions ? { permissions } : {}) }).expect(201);
  await bk.refresh(who);
  return r.body.member;
}

/** Staff answers: no fee, net, released or retained amounts, no settlement, no full phone numbers. */
function expectStaffSafe(body, { allowPhone = false } = {}) {
  expect(rules.hiddenKeysIn(body)).toEqual([]);
  if (!allowPhone) expect(JSON.stringify(body)).not.toMatch(/(\+?880|0)1[3-9]\d{8}/);
}

async function book(m, g, { court = g.courts[0], start = slot(), minutes = 60, payment = 'advance' } = {}) {
  const r = await api().post(`${P}/bookings/holds`).set(h.bearer(m)).set('Idempotency-Key', key('hold')).send({ groundId: g.id, courtIds: [court], start, minutes, payment }).expect(201);
  await h.payWithSimulator(m, r.body.payment.id);
  await h.drainEvents();
  return models.Booking.findByPk(r.body.booking.id);
}

// ====================================================================================== membership

describe('Round B3 membership lifecycle (Q169, Q170)', () => {
  it('adds a member by verified phone with the defaults; the event, audit, TEAM_ADDED and a stale token follow', async () => {
    const o = await bk.owner('Kamal Hossain');
    const g = await bk.liveGround(o, { name: 'Dhanmondi Arena' });
    const s = await h.signupUser({ name: 'Rafi Counter' });
    const oldToken = { accessToken: s.accessToken };

    const r = await team(o).add({ businessType: 'venue', businessId: g.id, phone: s.phone }).expect(201);
    expect(r.body.member).toMatchObject({ businessType: 'venue', businessId: g.id, business: { name: 'Dhanmondi Arena' }, member: { id: s.user.id, displayName: 'Rafi Counter', phoneLast4: s.phone.slice(-4) }, permissions: rules.defaultsFor('venue'), status: 'active', removedAt: null });
    expect(JSON.stringify(r.body)).not.toContain(s.phone.slice(1));

    const row = await models.BusinessMember.findByPk(r.body.member.id);
    expect(row).toMatchObject({ ownerId: o.user.id, memberId: s.user.id, addedBy: o.user.id });
    const ev = await models.OutboxEvent.findOne({ where: { name: 'business_member.added' } });
    expect(ev.payload).toMatchObject({ businessMemberId: row.id, businessType: 'venue', businessId: g.id, ownerId: o.user.id, memberId: s.user.id, permissions: rules.defaultsFor('venue') });
    const a = await models.AuditLog.findOne({ where: { action: 'business_member.added' } });
    expect(a).toMatchObject({ actorId: o.user.id, entityType: 'business_member', entityId: row.id });

    // The staff member's token is stale (authz_version moved): AUTHZ_STALE until they refresh.
    expect((await api().get(`${P}/me`).set(h.bearer(oldToken)).expect(401)).body.code).toBe('AUTHZ_STALE');
    await bk.refresh(s);
    const me = await api().get(`${P}/me`).set(h.bearer(s)).expect(200);
    expect(me.body.workplaces).toEqual([{ id: row.id, businessType: 'venue', businessId: g.id, permissions: rules.defaultsFor('venue') }]);
    const wp = await api().get(`${P}/me/workplaces`).set(h.bearer(s)).expect(200);
    expect(wp.body.items).toEqual([expect.objectContaining({ businessType: 'venue', businessId: g.id, business: { businessType: 'venue', id: g.id, name: 'Dhanmondi Arena', status: 'live' }, owner: { id: o.user.id, displayName: 'Kamal Hossain' }, permissions: rules.defaultsFor('venue') })]);

    await h.drainEvents();
    const note = await models.Notification.findOne({ where: { userId: s.user.id, code: 'TEAM_ADDED' } });
    expect(note.body).toContain('Kamal Hossain');
    expect(note.body).toContain('Dhanmondi Arena');
    expect(await models.NotificationDelivery.count({ where: { notificationId: note.id, channel: 'sms' } })).toBe(1);
  });

  it('refuses unknown numbers, the owner, Kriraghor staff, unverified phones, members already on the team, bad permissions and other owners’ businesses', async () => {
    reviewer = await f.staffWith(master, ['approve_listings']);
    const o = await bk.owner();
    const g = await bk.liveGround(o);
    const o2 = await bk.owner('Shafiq Rahman');
    const g2 = await bk.liveGround(o2);
    const s = await h.signupUser({ name: 'Mitu Akter' });
    const add = (body) => team(o).add({ businessType: 'venue', businessId: g.id, ...body });

    expect((await add({ phone: '01799999998' }).expect(404)).body.code).toBe('MEMBER_NOT_FOUND');
    expect((await add({ phone: 'not a phone' }).expect(422)).body.code).toBe('VALIDATION_FAILED');
    expect((await add({ phone: o.phone }).expect(422)).body.code).toBe('MEMBER_IS_OWNER');
    expect((await add({ phone: reviewer.phone }).expect(422)).body.code).toBe('MEMBER_IS_STAFF');
    const unverified = await h.signupUser({ name: 'Unverified Phone' });
    await models.User.update({ phoneVerifiedAt: null }, { where: { id: unverified.user.id } });
    expect((await add({ phone: unverified.phone }).expect(422)).body.code).toBe('PHONE_NOT_VERIFIED');
    const bad = await add({ phone: s.phone, permissions: ['bookings.view', 'pricing.publish'] }).expect(422);
    expect(bad.body).toMatchObject({ code: 'PERMISSIONS_INVALID', unknown: ['pricing.publish'] });
    expect((await add({ phone: s.phone, permissions: ['bookings.check_in'] }).expect(422)).body.missing).toEqual([{ permission: 'bookings.check_in', needs: 'bookings.view' }]);
    expect((await add({ phone: s.phone, permissions: ['desk.admit'] }).expect(422)).body.code).toBe('PERMISSIONS_INVALID');

    // Another owner's venue, a gym id passed as a venue, and a member with no business at all: 404.
    expect((await add({ businessId: g2.id, phone: s.phone }).expect(404)).body.code).toBe('NOT_FOUND');
    expect((await team(o).add({ businessType: 'gym', businessId: g.id, phone: s.phone }).expect(404)).body.code).toBe('NOT_FOUND');
    expect((await team(s).add({ businessType: 'venue', businessId: g.id, phone: o2.phone }).expect(404)).body.code).toBe('NOT_FOUND');

    await add({ phone: s.phone, permissions: ['bookings.view'] }).expect(201);
    expect((await add({ phone: s.phone }).expect(409)).body.code).toBe('ALREADY_MEMBER');
    // The same person may work at another owner's venue too (scope is per business, Q170).
    await team(o2).add({ businessType: 'venue', businessId: g2.id, phone: s.phone }).expect(201);
    expect(await models.BusinessMember.count({ where: { memberId: s.user.id, status: 'active' } })).toBe(2);
    expect(await models.AuditLog.count({ where: { action: 'business_member.added' } })).toBe(2);
  });

  it('caps the team at business.team_max_members, also when two adds race (advisory lock)', async () => {
    const o = await bk.owner();
    const g = await bk.liveGround(o);
    await h.setSettingForTest('business.team_max_members', 2);
    const people = [];
    for (const n of ['A One', 'B Two', 'C Three', 'D Four']) people.push(await h.signupUser({ name: n }));
    await team(o).add({ businessType: 'venue', businessId: g.id, phone: people[0].phone }).expect(201);
    const race = await Promise.all(people.slice(1, 3).map((p) => team(o).add({ businessType: 'venue', businessId: g.id, phone: p.phone })));
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(race.find((r) => r.status === 409).body).toMatchObject({ code: 'TEAM_FULL', max: 2 });
    expect(await models.BusinessMember.count({ where: { businessId: g.id, status: 'active' } })).toBe(2);
    // Removing one frees a place.
    const listed = (await team(o).list().expect(200)).body;
    expect(listed).toMatchObject({ maxMembers: 2, businesses: [{ businessType: 'venue', id: g.id }] });
    expect(listed.permissionCatalogue.venue.find((p) => p.key === 'bookings.cancel')).toEqual({ key: 'bookings.cancel', default: false, needs: 'bookings.view' });
    await team(o).remove(listed.items[0].id).expect(200);
    await team(o).add({ businessType: 'venue', businessId: g.id, phone: people[3].phone }).expect(201);
  });

  it('lists the team without full phones, changes permissions (diffed, audited, an event) and removes (TEAM_REMOVED, access gone)', async () => {
    const o = await bk.owner('Kamal Hossain');
    const g = await bk.liveGround(o, { name: 'Mirpur Turf' });
    const s = await h.signupUser({ name: 'Sakib Desk' });
    const m = await hire(o, 'venue', g.id, s);

    const list = await team(o).list(`?businessType=venue&businessId=${g.id}`).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(s.phone.slice(1));
    expect((await team(o).list(`?businessId=${g.id}`).expect(422)).body.code).toBe('VALIDATION_FAILED');
    const stranger = await bk.owner('Stranger Owner');
    expect((await team(stranger).list(`?businessType=venue&businessId=${g.id}`).expect(404)).body.code).toBe('NOT_FOUND');
    expect((await team(stranger).patch(m.id, ['bookings.view']).expect(404)).body.code).toBe('NOT_FOUND');
    expect((await team(stranger).remove(m.id).expect(404)).body.code).toBe('NOT_FOUND');

    const stale = { accessToken: s.accessToken };
    const next = [...rules.defaultsFor('venue'), 'bookings.cancel'];
    const p = await team(o).patch(m.id, next).expect(200);
    expect(p.body.member.permissions).toEqual([...next].sort());
    expect((await api().get(`${P}/me`).set(h.bearer(stale)).expect(401)).body.code).toBe('AUTHZ_STALE');
    const ev = await models.OutboxEvent.findOne({ where: { name: 'business_member.permissions_changed' } });
    expect(ev.payload).toMatchObject({ added: ['bookings.cancel'], removed: [] });
    const a = await models.AuditLog.findOne({ where: { action: 'business_member.permissions_changed' } });
    expect(a.before).toEqual({ permissions: rules.defaultsFor('venue') });
    expect(a.meta).toMatchObject({ added: ['bookings.cancel'], removed: [] });
    // The same list again changes nothing: no event, no audit row.
    expect((await team(o).patch(m.id, next).expect(200)).body.unchanged).toBe(true);
    expect(await models.OutboxEvent.count({ where: { name: 'business_member.permissions_changed' } })).toBe(1);
    expect((await team(o).patch(m.id, ['bookings.move']).expect(422)).body.code).toBe('PERMISSIONS_INVALID');

    await bk.refresh(s);
    await api().get(`${P}/me/ground-bookings?groundId=${g.id}`).set(h.bearer(s)).expect(200);
    const r = await team(o).remove(m.id).expect(200);
    expect(r.body.member).toMatchObject({ status: 'removed' });
    expect(r.body.member.removedAt).toBeTruthy();
    expect((await team(o).remove(m.id).expect(404)).body.code).toBe('NOT_FOUND');
    expect((await team(o).patch(m.id, ['bookings.view']).expect(404)).body.code).toBe('NOT_FOUND');
    const row = await models.BusinessMember.findByPk(m.id);
    expect(row).toMatchObject({ status: 'removed', removedBy: o.user.id });
    await bk.refresh(s);
    expect((await api().get(`${P}/me/ground-bookings?groundId=${g.id}`).set(h.bearer(s)).expect(403)).body.code).toBe('KYC_REQUIRED');
    expect((await api().get(`${P}/me/workplaces`).set(h.bearer(s)).expect(200)).body.items).toEqual([]);
    expect((await team(o).list('?status=all').expect(200)).body.items.map((x) => x.status)).toEqual(['removed']);
    await h.drainEvents();
    expect(await models.Notification.count({ where: { userId: s.user.id, code: 'TEAM_REMOVED' } })).toBe(1);
    expect(await models.AuditLog.count({ where: { action: 'business_member.removed' } })).toBe(1);
    // Re-adding later is a new row (history kept).
    await team(o).add({ businessType: 'venue', businessId: g.id, phone: s.phone }).expect(201);
    expect(await models.BusinessMember.count({ where: { memberId: s.user.id } })).toBe(2);
  });

  it('an owner whose role is suspended cannot change the team but can still remove staff', async () => {
    const o = await bk.owner();
    const g = await bk.liveGround(o);
    const s = await h.signupUser({ name: 'Nabil Desk' });
    const other = await h.signupUser({ name: 'Other Person' });
    const m = await hire(o, 'venue', g.id, s);
    await api().post(`${P}/admin/users/${o.user.id}/roles/ground_owner/status`).set(h.bearer(master)).send({ status: 'suspended', reasonCode: 'other' }).expect(200);
    await bk.refresh(o);
    expect((await team(o).add({ businessType: 'venue', businessId: g.id, phone: other.phone }).expect(403)).body.code).toBe('ROLE_SUSPENDED');
    expect((await team(o).patch(m.id, ['bookings.view']).expect(403)).body.code).toBe('ROLE_SUSPENDED');
    await team(o).remove(m.id).expect(200);
  });
});

// ====================================================================================== access

describe('Round B3 access: workplaces follow the owner (authz_version)', () => {
  it('a suspended owner role, a suspended or banned owner: staff lose access at once; restored, it comes back; tokens go stale', async () => {
    const o = await bk.owner('Kamal Hossain');
    const g = await bk.liveGround(o);
    const s = await h.signupUser({ name: 'Rafi Counter' });
    await hire(o, 'venue', g.id, s);
    const timeline = () => api().get(`${P}/me/ground-bookings?groundId=${g.id}`).set(h.bearer(s));
    await timeline().expect(200);

    // The owner's role is suspended: the very next request has no workplace (no event needed).
    await api().post(`${P}/admin/users/${o.user.id}/roles/ground_owner/status`).set(h.bearer(master)).send({ status: 'suspended', reasonCode: 'other' }).expect(200);
    expect((await timeline().expect(403)).body.code).toBe('KYC_REQUIRED');
    expect((await api().get(`${P}/me/workplaces`).set(h.bearer(s)).expect(200)).body.items).toEqual([]);
    // The consumer then makes every staff token stale, so the panel reloads.
    await h.drainEvents();
    expect((await timeline().expect(401)).body.code).toBe('AUTHZ_STALE');
    await bk.refresh(s);
    await api().post(`${P}/admin/users/${o.user.id}/roles/ground_owner/status`).set(h.bearer(master)).send({ status: 'active' }).expect(200);
    await timeline().expect(200);
    await h.drainEvents();
    await bk.refresh(s);
    await timeline().expect(200);

    // The owner's account is suspended, then restored.
    await api().post(`${P}/admin/users/${o.user.id}/suspend`).set(h.bearer(master)).send({ reasonCode: 'other', note: 'Checking the venue' }).expect(200);
    expect((await timeline().expect(403)).body.code).toBe('KYC_REQUIRED');
    await h.drainEvents();
    await bk.refresh(s);
    expect((await timeline().expect(403)).body.code).toBe('KYC_REQUIRED');
    await api().post(`${P}/admin/users/${o.user.id}/restore`).set(h.bearer(master)).send({ note: 'All clear' }).expect(200);
    await h.drainEvents();
    await bk.refresh(s);
    await timeline().expect(200);

    // Banned: gone for good.
    await api().post(`${P}/admin/users/${o.user.id}/ban`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'user.ban')).send({ reasonCode: 'other', note: 'Fraud' }).expect(200);
    await h.drainEvents();
    await bk.refresh(s);
    expect((await timeline().expect(403)).body.code).toBe('KYC_REQUIRED');
  });

  it('staff whose own phone is no longer verified are refused (PHONE_REQUIRED)', async () => {
    const o = await bk.owner();
    const g = await bk.liveGround(o);
    const s = await h.signupUser({ name: 'Phone Gone' });
    await hire(o, 'venue', g.id, s);
    await models.User.update({ phoneVerifiedAt: null }, { where: { id: s.user.id } });
    expect((await api().get(`${P}/me/ground-bookings?groundId=${g.id}`).set(h.bearer(s)).expect(403)).body.code).toBe('PHONE_REQUIRED');
  });
});

// ====================================================================================== venue matrix

describe('Round B3 venue desk: route-by-route matrix', () => {
  let o;
  let g;
  let o2;
  let g2;
  let full; // every venue permission
  let none; // on the team, no permission
  let other; // every permission, at another owner's venue
  let gone; // removed
  let m;

  beforeEach(async () => {
    o = await bk.owner('Kamal Hossain');
    g = await bk.liveGround(o, { courts: 2, name: 'Dhanmondi Arena' });
    o2 = await bk.owner('Shafiq Rahman');
    g2 = await bk.liveGround(o2, { name: 'Uttara Turf' });
    full = await h.signupUser({ name: 'Full Counter' });
    none = await h.signupUser({ name: 'No Permission' });
    other = await h.signupUser({ name: 'Other Venue' });
    gone = await h.signupUser({ name: 'Removed Staff' });
    m = await h.signupUser({ name: 'Rafi Ahmed' });
    await hire(o, 'venue', g.id, full, ALL_VENUE);
    await hire(o, 'venue', g.id, none, []);
    await hire(o2, 'venue', g2.id, other, ALL_VENUE);
    const removed = await hire(o, 'venue', g.id, gone);
    await team(o).remove(removed.id).expect(200);
    await bk.refresh(gone);
  });

  /**
   * The matrix for one route: staff of another venue 404, staff without the permission 403
   * PERMISSION_REQUIRED, removed staff 403, then staff with it succeed (no money keys, no phones);
   * the owner, on a fresh state, gets today's answer.
   */
  async function matrix({ permission, prepare, call, ok = 200, staffCheck, ownerCheck, removedCode = 'KYC_REQUIRED' }) {
    const s1 = await prepare();
    const foreign = await call(other, s1);
    expect([foreign.status, foreign.body.code]).toEqual([404, 'NOT_FOUND']);
    const without = await call(none, s1);
    expect([without.status, without.body.code, without.body.permission]).toEqual([403, 'PERMISSION_REQUIRED', permission]);
    const removed = await call(gone, s1);
    expect([removed.status, removed.body.code]).toEqual([403, removedCode]);
    const staff = await call(full, s1);
    expect([staff.status, staff.status === ok ? null : staff.body.code]).toEqual([ok, null]);
    expectStaffSafe(staff.body);
    if (staffCheck) await staffCheck(staff.body, s1);
    const s2 = await prepare();
    const owner = await call(o, s2);
    expect(owner.status).toBe(ok);
    if (ownerCheck) await ownerCheck(owner.body, s2);
    return { staff: staff.body, owner: owner.body };
  }

  // Bookings moved to the same time alternate courts (one active slot per court and time).
  let court = 0;
  const nextCourt = () => g.courts[(court += 1) % 2];
  const future = () => book(m, g, { start: slot(1, (seq += 2)) });
  const now = async () => bk.moveTo(await book(m, g, { court: nextCourt(), start: slot(2, (seq += 2)) }), new Date());
  const late = async () => bk.moveTo(await book(m, g, { court: nextCourt(), start: slot(2, (seq += 2)) }), new Date(Date.now() - 30 * 60000));
  const checkedIn = async () => {
    const x = await now();
    await api().post(`${P}/me/ground-bookings/${x.id}/check-in`).set(h.bearer(o)).expect(200);
    return x.reload();
  };

  it('GET /me/ground-bookings (bookings.view): the day without fee, released or retained', async () => {
    await now(); // today's day (Dhaka) is the default
    await matrix({
      permission: 'bookings.view',
      prepare: async () => null,
      call: (who) => api().get(`${P}/me/ground-bookings?groundId=${g.id}`).set(h.bearer(who)),
      staffCheck: (body) => expect(body.bookings[0].money).toMatchObject({ price: 200000, dueAtVenue: 150000 }),
      ownerCheck: (body) => expect(body.bookings[0].money).toMatchObject({ fee: 10000, released: 0 }),
    });
  });

  it('GET /me/ground-bookings/search (bookings.view): staff search their venues only', async () => {
    const x = await future();
    const mine = await book(m, g2, { start: slot(1, 9) });
    const r = await matrix({
      permission: 'bookings.view',
      prepare: async () => x,
      call: (who) => api().get(`${P}/me/ground-bookings/search?q=BK&groundId=${g.id}`).set(h.bearer(who)),
    });
    expect(r.staff.items.map((i) => i.code)).toEqual([x.code]);
    // Without groundId: every venue where they hold bookings.view, never another owner's.
    const all = await api().get(`${P}/me/ground-bookings/search?q=BK`).set(h.bearer(full)).expect(200);
    expect(all.body.items.map((i) => i.code)).toEqual([x.code]);
    expect((await api().get(`${P}/me/ground-bookings/search?q=BK`).set(h.bearer(other)).expect(200)).body.items.map((i) => i.code)).toEqual([mine.code]);
    expect((await api().get(`${P}/me/ground-bookings/search?q=BK`).set(h.bearer(none)).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
  });

  it('GET /me/ground-bookings/:id (bookings.view)', async () => {
    await matrix({
      permission: 'bookings.view',
      prepare: future,
      call: (who, x) => api().get(`${P}/me/ground-bookings/${x.id}`).set(h.bearer(who)),
      staffCheck: (body, x) => expect(body.booking).toMatchObject({ id: x.id, code: x.code }),
      ownerCheck: (body) => expect(body.booking.money.fee).toBe(10000),
    });
    // A missing id answers exactly like another venue's id.
    expect((await api().get(`${P}/me/ground-bookings/00000000-0000-4000-8000-000000000000`).set(h.bearer(other)).expect(404)).body).toMatchObject({ code: 'NOT_FOUND', title: 'Booking not found' });
  });

  it('POST check-in (bookings.check_in): released to the owner, audited as the staff member on behalf of the owner', async () => {
    const r = await matrix({
      permission: 'bookings.check_in',
      prepare: now,
      call: (who, x) => api().post(`${P}/me/ground-bookings/${x.id}/check-in`).set(h.bearer(who)),
      staffCheck: async (body, x) => {
        expect(body.released).toBeUndefined();
        expect(body.booking.status).toBe('checked_in');
        // Money still goes to the owner: ৳500 online − ৳100 fee = ৳400 (CLAUDE.md worked example).
        expect(await ledger.balance(`payable:user:${o.user.id}`)).toBe(40000);
        expect(await ledger.balance(`payable:user:${full.user.id}`)).toBe(0);
        const a = await models.AuditLog.findOne({ where: { action: 'booking.check_in_recorded', entityId: x.id } });
        expect(a).toMatchObject({ actorId: full.user.id, actorRole: 'business_staff' });
        expect(a.meta).toMatchObject({ onBehalfOf: o.user.id });
        expect((await models.CheckIn.findOne({ where: { bookingId: x.id } })).checkedInBy).toBe(full.user.id);
      },
      ownerCheck: (body) => expect(body.released).toMatchObject({ released: 50000, fee: 10000 }),
    });
    expect(r.owner.booking.money.fee).toBe(10000);
  });

  it('POST no-show (bookings.no_show): the retained amount stays hidden from staff', async () => {
    await matrix({
      permission: 'bookings.no_show',
      prepare: late,
      call: (who, x) => api().post(`${P}/me/ground-bookings/${x.id}/no-show`).set(h.bearer(who)),
      staffCheck: (body) => expect(body.settled).toEqual({ refunded: 0, settleDueAt: expect.any(String) }),
      ownerCheck: (body) => expect(body.settled.retained).toBe(50000),
    });
  });

  it('POST extend (bookings.extend)', async () => {
    await matrix({
      permission: 'bookings.extend',
      prepare: checkedIn,
      call: (who, x) => api().post(`${P}/me/ground-bookings/${x.id}/extend`).set(h.bearer(who)),
      staffCheck: (body) => expect(body.amount).toBe(100000),
    });
  });

  it('POST collect-balance (bookings.collect_balance)', async () => {
    await matrix({
      permission: 'bookings.collect_balance',
      prepare: checkedIn,
      call: (who, x) => api().post(`${P}/me/ground-bookings/${x.id}/collect-balance`).set(h.bearer(who)).send({ method: 'cash', amount: 150000 }),
      staffCheck: async (body, x) => {
        expect(body.booking.money.balanceStatus).toBe('collected');
        expect((await x.reload()).balanceCollectedBy).toBe(full.user.id);
      },
    });
  });

  it('POST cancel (bookings.cancel, optional and off by default, Q170): 100% back to the member', async () => {
    const dflt = await h.signupUser({ name: 'Default Staff' });
    await hire(o, 'venue', g.id, dflt);
    const x = await future();
    expect((await api().post(`${P}/me/ground-bookings/${x.id}/cancel`).set(h.bearer(dflt)).send({ reason: 'weather' }).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    await matrix({
      permission: 'bookings.cancel',
      prepare: future,
      call: (who, y) => api().post(`${P}/me/ground-bookings/${y.id}/cancel`).set(h.bearer(who)).send({ reason: 'weather' }),
      staffCheck: (body) => expect(body.refund).toBe(50000),
    });
  });

  it('GET move-targets and POST move (bookings.move, optional): staff move within their venue only', async () => {
    await matrix({
      permission: 'bookings.move',
      prepare: future,
      call: (who, x) => api().get(`${P}/me/ground-bookings/${x.id}/move-targets`).set(h.bearer(who)),
      staffCheck: (body) => expect(body.items.every((t) => t.groundId === g.id)).toBe(true),
    });
    await matrix({
      permission: 'bookings.move',
      prepare: future,
      call: (who, x) => api().post(`${P}/me/ground-bookings/${x.id}/move`).set(h.bearer(who)).send({ courtId: g.courts[1] }),
      staffCheck: (body) => expect(body.booking.courtIds).toEqual([g.courts[1]]),
    });
    // The owner's other venue is not a target for staff (one venue, Q170).
    const g3 = await bk.liveGround(o, { name: 'Second Venue' });
    const x = await future();
    const targets = (await api().get(`${P}/me/ground-bookings/${x.id}/move-targets`).set(h.bearer(full)).expect(200)).body.items;
    expect(targets.some((t) => t.groundId === g3.id)).toBe(false);
    expect((await api().get(`${P}/me/ground-bookings/${x.id}/move-targets`).set(h.bearer(o)).expect(200)).body.items.some((t) => t.groundId === g3.id)).toBe(true);
    expect((await api().post(`${P}/me/ground-bookings/${x.id}/move`).set(h.bearer(full)).send({ courtId: g3.courts[0] }).expect(422)).body.code).toBe('MOVE_TARGET_INVALID');
  });

  it('POST /me/grounds/:id/walk-ins (bookings.walk_in): the fee is owed by the owner', async () => {
    let n = 0;
    await matrix({
      permission: 'bookings.walk_in',
      ok: 201,
      prepare: async () => ({ start: slot(3, (n += 4)) }),
      call: (who, x) => api().post(`${P}/me/grounds/${g.id}/walk-ins`).set(h.bearer(who)).set('Idempotency-Key', key('walk')).send({ courtIds: [g.courts[0]], start: x.start, minutes: 60, name: 'Walk-in Team', phone: '01711222333' }),
      staffCheck: async (body) => {
        expect(body.booking).toMatchObject({ source: 'walk_in', phoneLast4: '2333' });
        expect((await models.Booking.findByPk(body.booking.id)).ownerId).toBe(o.user.id);
      },
    });
    // A walk-in at another owner's venue: 404 for staff (never reveals it).
    expect((await api().post(`${P}/me/grounds/${g2.id}/walk-ins`).set(h.bearer(full)).set('Idempotency-Key', key('walk')).send({ courtIds: [g2.courts[0]], start: slot(3, 30), minutes: 60, name: 'Team' }).expect(404)).body.code).toBe('NOT_FOUND');
  });

  it('reply to reviews (reviews.reply, optional): venue staff reply, others cannot', async () => {
    const newReview = async () =>
      models.Review.create({ subjectType: 'ground', subjectId: g.id, subjectOwnerId: o.user.id, sourceType: 'booking', sourceId: (await future()).id, authorId: m.user.id, stars: 5, text: 'Great turf', status: 'published', editUntil: new Date(Date.now() + 86400000) });
    await matrix({
      permission: 'reviews.reply',
      removedCode: 'NOT_OWNER', // /me/reviews has no gate: a former staff member is any member
      prepare: newReview,
      call: (who, r) => api().post(`${P}/me/reviews/${r.id}/reply`).set(h.bearer(who)).send({ text: 'Thank you for playing with us!' }),
      staffCheck: async (body, r) => {
        expect(body.review.reply).toBeTruthy();
        const a = await models.AuditLog.findOne({ where: { action: 'review.replied', entityId: r.id } });
        expect(a).toMatchObject({ actorId: full.user.id, actorRole: 'business_staff' });
        expect(a.meta.onBehalfOf).toBe(o.user.id);
      },
    });
    const list = await api().get(`${P}/me/reviews?subjectType=ground&subjectId=${g.id}`).set(h.bearer(full)).expect(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect((await api().get(`${P}/me/reviews?subjectType=ground&subjectId=${g.id}`).set(h.bearer(none)).expect(200)).body.items).toEqual([]);
  });

  it('owner-only venue routes stay closed to staff (pricing, listing, closures, series, analytics)', async () => {
    const closed = [
      api().get(`${P}/me/grounds`).set(h.bearer(full)),
      api().get(`${P}/me/grounds/${g.id}`).set(h.bearer(full)),
      api().get(`${P}/me/grounds/${g.id}/pricing`).set(h.bearer(full)),
      api().patch(`${P}/me/grounds/${g.id}`).set(h.bearer(full)).send({ name: 'Mine now' }),
      api().post(`${P}/me/grounds/${g.id}/closures/preview`).set(h.bearer(full)).send({}),
      api().get(`${P}/me/grounds/${g.id}/series`).set(h.bearer(full)),
      api().get(`${P}/me/dashboard?role=ground_owner`).set(h.bearer(full)),
      api().get(`${P}/me/dashboard/export?dataset=owner_revenue`).set(h.bearer(full)),
      api().get(`${P}/me/ground-reviews`).set(h.bearer(full)),
    ];
    for (const r of await Promise.all(closed)) expect([r.status, ['KYC_REQUIRED', 'ROLE_REQUIRED'].includes(r.body.code)]).toEqual([403, true]);
  });
});

// ====================================================================================== gym matrix

describe('Round B3 gym front desk: route-by-route matrix', () => {
  it('admit (desk.admit), the day’s admissions (desk.admissions), passes sold (passes.view, no money); owner-only closed', async () => {
    reviewer = await f.staffWith(master, ['approve_listings', 'approve_documents']);
    const { owner, gym } = await b.liveGym(reviewer, reviewer);
    const other = await b.liveGym(reviewer, reviewer, 'Gold Gym Gulshan');
    const full = await h.signupUser({ name: 'Front Desk Full' });
    const dflt = await h.signupUser({ name: 'Front Desk Default' });
    const none = await h.signupUser({ name: 'Front Desk None' });
    const foreign = await h.signupUser({ name: 'Other Gym Desk' });
    await hire(owner, 'gym', gym.id, full, ALL_GYM);
    await hire(owner, 'gym', gym.id, dflt);
    await hire(owner, 'gym', gym.id, none, []);
    await hire(other.owner, 'gym', other.gym.id, foreign, ALL_GYM);
    const member = await h.signupUser({ name: 'Nadia Islam' });
    const admit = (who, pass) => api().post(`${P}/me/gyms/${gym.id}/redemptions`).set(h.bearer(who)).send({ token: pass.token });

    const p1 = await b.paidPass(member, gym, 'day');
    expect((await admit(foreign, p1).expect(404)).body.code).toBe('NOT_FOUND');
    expect((await admit(none, p1).expect(403)).body).toMatchObject({ code: 'PERMISSION_REQUIRED', permission: 'desk.admit' });
    const card = (await admit(full, p1).expect(201)).body;
    expect(card).toMatchObject({ passCode: p1.code, status: 'redeemed' });
    expectStaffSafe(card);
    const pass = await models.GymPass.findOne({ where: { code: p1.code } });
    expect(await ledger.balance(`payable:user:${owner.user.id}`)).toBeGreaterThan(0);
    expect(await ledger.balance(`payable:user:${full.user.id}`)).toBe(0);
    expect(pass.status).toBe('redeemed');
    const a = await models.AuditLog.findOne({ where: { action: 'gym_pass.redeemed' } });
    expect(a).toMatchObject({ actorId: full.user.id, actorRole: 'business_staff' });
    expect(a.meta).toMatchObject({ onBehalfOf: owner.user.id });
    const p2 = await b.paidPass(member, gym, 'month');
    expect((await admit(owner, p2).expect(201)).body.released).toBeGreaterThan(0); // the owner's card is unchanged

    const day = (who) => api().get(`${P}/me/gyms/${gym.id}/redemptions`).set(h.bearer(who));
    expect((await day(foreign).expect(404)).body.code).toBe('NOT_FOUND');
    expect((await day(none).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    expect((await day(dflt).expect(200)).body.items).toHaveLength(2);
    expectStaffSafe((await day(full).expect(200)).body);

    const sold = (who) => api().get(`${P}/me/gyms/${gym.id}/passes`).set(h.bearer(who));
    expect((await sold(foreign).expect(404)).body.code).toBe('NOT_FOUND');
    expect((await sold(dflt).expect(403)).body.permission).toBe('passes.view');
    const staffSold = (await sold(full).expect(200)).body;
    expect(staffSold.items).toHaveLength(2);
    expect(staffSold.items.every((i) => i.money === undefined)).toBe(true);
    expect((await sold(owner).expect(200)).body.items[0].money).toBeDefined();
    expect((await api().get(`${P}/me/gyms/00000000-0000-4000-8000-000000000000/passes`).set(h.bearer(foreign)).expect(404)).body.code).toBe('NOT_FOUND');

    // Owner-only: listing, packages, hours, photos, dashboards.
    for (const r of await Promise.all([
      api().get(`${P}/me/gyms`).set(h.bearer(full)),
      api().get(`${P}/me/gyms/${gym.id}`).set(h.bearer(full)),
      api().put(`${P}/me/gyms/${gym.id}/hours`).set(h.bearer(full)).send({ hours: [] }),
      api().put(`${P}/me/gyms/${gym.id}/packages`).set(h.bearer(full)).send({ packages: [] }),
      api().post(`${P}/me/gyms/${gym.id}/pause`).set(h.bearer(full)),
      api().get(`${P}/me/dashboard?role=gym_owner`).set(h.bearer(full)),
    ])) {
      expect(r.status).toBe(403);
    }
    // A removed desk member is closed out at once.
    const listed = (await team(owner).list(`?businessType=gym&businessId=${gym.id}`).expect(200)).body.items.find((x) => x.member.id === dflt.user.id);
    await team(owner).remove(listed.id).expect(200);
    await bk.refresh(dflt);
    expect((await day(dflt).expect(403)).body.code).toBe('KYC_REQUIRED');
  });
});

// ====================================================================================== shop matrix

describe('Round B3 shop desk: route-by-route matrix', () => {
  let shop;
  let shopB;
  let shopId;
  let full;
  let dflt;
  let viewer; // orders.view and stock.view only
  let none;
  let foreign;
  let gone;
  let buyer;
  let size;

  beforeEach(async () => {
    size = 0;
    reviewer = await f.staffWith(master, ['approve_listings', 'approve_documents']);
    shop = await b.bootShop(reviewer, reviewer);
    shopB = await b.bootShop(reviewer, reviewer, { name: 'Gulshan Gear' });
    shopId = shop.product.shopId;
    full = await h.signupUser({ name: 'Packer Full' });
    dflt = await h.signupUser({ name: 'Packer Default' });
    viewer = await h.signupUser({ name: 'Packer Viewer' });
    none = await h.signupUser({ name: 'Packer None' });
    foreign = await h.signupUser({ name: 'Other Shop Packer' });
    gone = await h.signupUser({ name: 'Removed Packer' });
    buyer = await h.signupUser({ name: 'Tanvir Hasan' });
    await hire(shop.owner, 'shop', shopId, full, ALL_SHOP);
    await hire(shop.owner, 'shop', shopId, dflt);
    await hire(shop.owner, 'shop', shopId, viewer, ['orders.view', 'stock.view']);
    await hire(shop.owner, 'shop', shopId, none, []);
    await hire(shopB.owner, 'shop', shopB.product.shopId, foreign, ALL_SHOP);
    const removed = await hire(shop.owner, 'shop', shopId, gone);
    await team(shop.owner).remove(removed.id).expect(200);
    await bk.refresh(gone);
  });

  async function matrix({ permission, prepare, call, ok = 200, staffCheck, ownerCheck, staff = () => full }) {
    const s1 = await prepare();
    const x = await call(foreign, s1);
    expect([x.status, x.body.code]).toEqual([404, 'NOT_FOUND']);
    const w = await call(none, s1);
    expect([w.status, w.body.code, w.body.permission]).toEqual([403, 'PERMISSION_REQUIRED', permission]);
    const r = await call(gone, s1);
    expect([r.status, r.body.code]).toEqual([403, 'KYC_REQUIRED']);
    const st = await call(staff(), s1);
    expect([st.status, st.status === ok ? null : st.body.code]).toEqual([ok, null]);
    expectStaffSafe(st.body);
    if (staffCheck) await staffCheck(st.body, s1);
    const s2 = await prepare();
    const ow = await call(shop.owner, s2);
    expect(ow.status).toBe(ok);
    if (ownerCheck) await ownerCheck(ow.body, s2);
    return { staff: st.body, owner: ow.body };
  }

  // One pair per order, cycling sizes 40 to 45 (three in stock each).
  const placed = () => b.paidOrder(buyer, shop, [String(40 + (size++ % 6))]);
  const accepted = async () => {
    const s = await placed();
    await b.shopPost(shop.owner, s.id, 'accept').expect(200);
    return s;
  };
  const shipped = async () => {
    const s = await accepted();
    await b.shopPost(shop.owner, s.id, 'ship', { courierName: 'Pathao', trackingNo: 'PTH-123456' }).expect(200);
    return s;
  };

  it('GET /shop/sub-orders (orders.view): staff see their shop’s orders without commission, net or contact', async () => {
    const s = await placed();
    const list = (who, q = '') => api().get(`${P}/shop/sub-orders?tab=to_accept${q}`).set(h.bearer(who));
    expect((await list(foreign, `&shopId=${shopId}`).expect(404)).body.code).toBe('NOT_FOUND');
    // Without shopId, staff of another shop see their own shop, never this one.
    expect((await list(foreign).expect(200)).body.items).toEqual([]);
    expect((await list(none).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    expect((await list(gone).expect(403)).body.code).toBe('KYC_REQUIRED');
    const st = (await list(dflt).expect(200)).body;
    expect(st.items.map((i) => i.id)).toEqual([s.id]);
    expect(st.counts.to_accept).toBe(1);
    expectStaffSafe(st);
    expect((await list(dflt, `&shopId=${shopId}`).expect(200)).body.items).toHaveLength(1);
    const own = (await list(shop.owner).expect(200)).body.items[0];
    expect(own.money).toMatchObject({ commission: expect.any(Number), net: expect.any(Number) });
    // Someone working at two shops must name one (BUSINESS_REQUIRED).
    await hire(shopB.owner, 'shop', shopB.product.shopId, dflt, ['orders.view']);
    expect((await list(dflt).expect(422)).body.code).toBe('BUSINESS_REQUIRED');
    expect((await list(dflt, `&shopId=${shopId}`).expect(200)).body.items).toHaveLength(1);
  });

  it('GET /shop/sub-orders/:id (orders.view): the buyer’s contact only with orders.ship once accepted, every view audited (Q168)', async () => {
    const s = await accepted();
    const get = (who) => api().get(`${P}/shop/sub-orders/${s.id}`).set(h.bearer(who));
    expect((await get(foreign).expect(404)).body.code).toBe('NOT_FOUND');
    expect((await get(none).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    const v = (await get(viewer).expect(200)).body;
    expect(v).toMatchObject({ shipTo: null, contactHidden: true });
    expectStaffSafe(v);
    expect(await models.AuditLog.count({ where: { action: 'sub_order.contact_viewed' } })).toBe(0);
    const shipper = (await get(dflt).expect(200)).body;
    expect(shipper.shipTo).toMatchObject({ name: b.SHIP.name, phone: '+8801711000111', line: b.SHIP.line });
    expectStaffSafe(shipper, { allowPhone: true });
    await get(dflt).expect(200);
    const views = await models.AuditLog.findAll({ where: { action: 'sub_order.contact_viewed', entityId: s.id } });
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({ actorId: dflt.user.id, actorRole: 'business_staff' });
    expect(views[0].meta).toMatchObject({ onBehalfOf: shop.owner.user.id, shopId });
    // Before acceptance nobody sees it; the owner's view is unchanged and not audited.
    const p = await placed();
    expect((await get(dflt).expect(200)).body.shipTo).toBeTruthy();
    expect((await api().get(`${P}/shop/sub-orders/${p.id}`).set(h.bearer(dflt)).expect(200)).body.shipTo).toBeNull();
    expect((await get(shop.owner).expect(200)).body.shipTo.phone).toBe('+8801711000111');
    expect(await models.AuditLog.count({ where: { action: 'sub_order.contact_viewed', actorId: shop.owner.user.id } })).toBe(0);
  });

  it('POST accept (orders.accept): the answer carries no contact for staff', async () => {
    await matrix({
      permission: 'orders.accept',
      prepare: placed,
      call: (who, s) => b.shopPost(who, s.id, 'accept'),
      staffCheck: async (body, s) => {
        expect(body).toMatchObject({ status: 'accepted', shipTo: null, contactHidden: true });
        const a = await models.AuditLog.findOne({ where: { action: 'sub_order.accepted', entityId: s.id } });
        expect(a.meta).toMatchObject({ onBehalfOf: shop.owner.user.id });
      },
      ownerCheck: (body) => expect(body.shipTo.phone).toBe('+8801711000111'),
    });
  });

  it('POST reject (orders.reject, optional and off by default): refunds the buyer', async () => {
    const s = await placed();
    expect((await b.shopPost(dflt, s.id, 'reject', { reason: 'out_of_stock' }).expect(403)).body.permission).toBe('orders.reject');
    await matrix({
      permission: 'orders.reject',
      prepare: placed,
      call: (who, x) => b.shopPost(who, x.id, 'reject', { reason: 'out_of_stock' }),
      staffCheck: (body) => expect(body.status).toBe('rejected'),
    });
  });

  it('POST ship (orders.ship) and delivered (orders.deliver)', async () => {
    await matrix({
      permission: 'orders.ship',
      prepare: accepted,
      call: (who, s) => b.shopPost(who, s.id, 'ship', { courierName: 'Pathao', trackingNo: 'PTH-123456' }),
      staffCheck: (body) => expect(body).toMatchObject({ status: 'shipped', courier: { name: 'Pathao' } }),
    });
    await matrix({
      permission: 'orders.deliver',
      prepare: shipped,
      call: (who, s) => api().post(`${P}/shop/sub-orders/${s.id}/delivered`).set(h.bearer(who)),
      staffCheck: (body) => expect(body.status).toBe('delivered'),
    });
  });

  it('stock: adjust (stock.adjust), movements and inventory (stock.view, never the stock value)', async () => {
    const variant = shop.variant('42');
    await matrix({
      permission: 'stock.adjust',
      prepare: async () => variant,
      call: (who, v) => api().post(`${P}/shop/variants/${v}/adjust`).set(h.bearer(who)).send({ delta: 1, reasonCode: 'received' }),
      staffCheck: async () => {
        const a = await models.AuditLog.findOne({ where: { action: 'inventory.adjusted', actorId: full.user.id } });
        expect(a.meta).toMatchObject({ onBehalfOf: shop.owner.user.id });
      },
    });
    expect((await api().post(`${P}/shop/variants/${variant}/adjust`).set(h.bearer(viewer)).send({ delta: 1, reasonCode: 'received' }).expect(403)).body.permission).toBe('stock.adjust');
    await matrix({
      permission: 'stock.view',
      prepare: async () => variant,
      call: (who, v) => api().get(`${P}/shop/variants/${v}/movements`).set(h.bearer(who)),
      staffCheck: (body) => expect(body.items.length).toBeGreaterThan(0),
    });
    const inv = await matrix({
      permission: 'stock.view',
      prepare: async () => null,
      call: (who) => api().get(`${P}/shop/inventory${who === foreign ? `?shopId=${shopId}` : ''}`).set(h.bearer(who)),
      staffCheck: (body) => expect(body.kpis.stockValuePoisha).toBeUndefined(),
    });
    expect(inv.owner.kpis.stockValuePoisha).toBeGreaterThan(0);
  });

  it('owner-only shop routes stay closed to staff (profile, products and prices, settlement, analytics)', async () => {
    for (const r of await Promise.all([
      api().get(`${P}/shop/profile`).set(h.bearer(full)),
      api().patch(`${P}/shop/profile`).set(h.bearer(full)).send({ about: 'mine' }),
      api().get(`${P}/shop/products`).set(h.bearer(full)),
      api().patch(`${P}/shop/products/${shop.product.id}`).set(h.bearer(full)).send({ description: 'mine' }),
      api().patch(`${P}/shop/variants/${shop.variant('42')}`).set(h.bearer(full)).send({ priceOverridePoisha: 1 }),
      api().get(`${P}/shop/settlement`).set(h.bearer(full)),
      api().get(`${P}/me/dashboard?role=shop_owner`).set(h.bearer(full)),
    ])) {
      expect([r.status, ['KYC_REQUIRED', 'ROLE_REQUIRED'].includes(r.body.code)]).toEqual([403, true]);
    }
    await api().get(`${P}/shop/settlement`).set(h.bearer(shop.owner)).expect(200);
  });

  it('notifications: shop staff hear new orders, reminders and stock alerts by permission; never completed-order money', async () => {
    const s = await placed();
    await h.drainEvents();
    const codes = async (who) => (await models.Notification.findAll({ where: { userId: who.user.id } })).map((n) => n.code);
    expect(await codes(full)).toContain('SHOP_NEW_ORDER');
    expect(await codes(viewer)).toContain('SHOP_NEW_ORDER');
    expect(await codes(none)).not.toContain('SHOP_NEW_ORDER');
    expect(await codes(foreign)).not.toContain('SHOP_NEW_ORDER');
    // The order took the size down to the low-stock line (3): the owner and stock.view staff hear it.
    await api().post(`${P}/shop/variants/${shop.variant('45')}/adjust`).set(h.bearer(full)).send({ setTo: 1, reasonCode: 'count_correction' }).expect(200);
    await h.drainEvents();
    const lows = await models.Notification.count({ where: { userId: shop.owner.user.id, code: 'STOCK_LOW' } });
    expect(lows).toBeGreaterThan(0);
    expect(await models.Notification.count({ where: { userId: viewer.user.id, code: 'STOCK_LOW' } })).toBe(lows);
    expect(await models.Notification.count({ where: { userId: full.user.id, code: 'STOCK_LOW' } })).toBe(lows);
    expect(await codes(none)).not.toContain('STOCK_LOW');
    expect(await codes(foreign)).not.toContain('STOCK_LOW');
    await b.shopPost(full, s.id, 'accept').expect(200);
    await b.shopPost(full, s.id, 'ship', { courierName: 'Pathao', trackingNo: 'PTH-123456' }).expect(200);
    await api().post(`${P}/shop/sub-orders/${s.id}/delivered`).set(h.bearer(full)).expect(200);
    await api().post(`${P}/me/sub-orders/${s.id}/received`).set(h.bearer(buyer)).expect(200);
    await h.drainEvents();
    expect(await models.Notification.count({ where: { userId: shop.owner.user.id, code: 'ORDER_COMPLETED' } })).toBe(1);
    for (const who of [full, viewer, dflt]) expect(await codes(who)).not.toContain('ORDER_COMPLETED');

    // The staff to-do: orders to accept and stock, per workplace, by permission.
    await placed();
    const todo = (await api().get(`${P}/me/dashboard/actions?role=business_staff`).set(h.bearer(viewer)).expect(200)).body.items;
    expect(todo).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'stock_low', businessType: 'shop', businessId: shopId })]));
    expect(todo.some((i) => i.key === 'orders_to_accept')).toBe(false); // viewer cannot accept
    const fullTodo = (await api().get(`${P}/me/dashboard/actions?role=business_staff`).set(h.bearer(full)).expect(200)).body.items;
    expect(fullTodo).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'orders_to_accept', count: 1, href: `/vendor/orders?tab=to_accept&shopId=${shopId}` })]));
    expectStaffSafe(fullTodo);
    expect((await api().get(`${P}/me/dashboard/actions?role=business_staff`).set(h.bearer(buyer)).expect(200)).body.items).toEqual([]);
  });
});

// ====================================================================================== venue notifications

describe('Round B3 venue staff notifications and to-do', () => {
  it('new bookings, cancellations and check-in reminders reach staff with the permission, without money they never see', async () => {
    const o = await bk.owner('Kamal Hossain');
    const g = await bk.liveGround(o, { name: 'Dhanmondi Arena' });
    const desk = await h.signupUser({ name: 'Desk Staff' });
    const none = await h.signupUser({ name: 'No Permission' });
    await hire(o, 'venue', g.id, desk);
    await hire(o, 'venue', g.id, none, []);
    const m = await h.signupUser({ name: 'Rafi Ahmed' });
    const x = await book(m, g, { start: slot(2) });
    const notes = async (who, code) => models.Notification.findAll({ where: { userId: who.user.id, code } });

    const [n] = await notes(desk, 'TEAM_BOOKING_NEW');
    expect(n.body).toContain(x.code);
    expect(n.body).toContain('Dhanmondi Arena');
    expect(n.link.endsWith(`/bookings?groundId=${g.id}`)).toBe(true);
    expect(await notes(none, 'TEAM_BOOKING_NEW')).toHaveLength(0);
    expect(await notes(o, 'BOOKING_NEW_FOR_OWNER')).toHaveLength(1);
    expect(await notes(desk, 'BOOKING_NEW_FOR_OWNER')).toHaveLength(0);

    // A check-in reminder (booking.reminded) for staff who check teams in.
    await bk.moveTo(x, new Date(Date.now() + 60 * 60000));
    await bookingsSvc.tick();
    await h.drainEvents();
    expect(await notes(desk, 'TEAM_CHECKIN_SOON')).toHaveLength(1);
    expect(await notes(none, 'TEAM_CHECKIN_SOON')).toHaveLength(0);
    const todo = (await api().get(`${P}/me/dashboard/actions?role=business_staff`).set(h.bearer(desk)).expect(200)).body.items;
    expect(todo).toEqual([expect.objectContaining({ key: 'check_in_due', count: 1, businessType: 'venue', businessId: g.id, href: `/vendor/bookings?groundId=${g.id}` })]);

    // The member cancels: staff hear it, without what the owner keeps.
    const y = await book(m, g, { start: slot(3) });
    const terms = await api().post(`${P}/me/bookings/${y.id}/cancel-preview`).set(h.bearer(m)).expect(200);
    await api().post(`${P}/me/bookings/${y.id}/cancel`).set(h.bearer(m)).send({ expectedRefund: terms.body.refund }).expect(200);
    await h.drainEvents();
    const [c] = await notes(desk, 'TEAM_BOOKING_CANCELLED');
    expect(c.body).toContain(y.code);
    expect(c.body).not.toMatch(/keep|৳/);
    expect((await notes(o, 'BOOKING_CANCELLED_FOR_OWNER'))[0].body).toContain('keep');
  });
});
