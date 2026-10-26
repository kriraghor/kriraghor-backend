'use strict';

/**
 * M24 test fixtures (jest and the Postman runner): a private gym owner (a verified phone only, no NID,
 * no documents; M24-FR-01), their draft gym with desk packages and a short code, staff hired through
 * M01 /me/team with chosen permissions, and helpers for members, payments and dates.
 */
const h = require('../helpers');
const f = require('./market');
const rules = require('../../src/modules/gym-manage/gym-manage.rules');

const { api, P } = h;
let seq = 0;
const key = (p = 'gm') => `${p}-${Date.now()}-${(seq += 1)}`;

/** Monthly ৳2,500 with a ৳1,000 admission fee, quarterly ৳6,500, a 45-day custom package (desk only). */
const PACKAGES = [
  { kind: 'month', title: 'Monthly', price: 250000, admissionFee: 100000, channel: 'both', sort: 1 },
  { kind: 'quarter', title: 'Quarterly', price: 650000, admissionFee: 100000, channel: 'both', sort: 2 },
  { kind: 'custom', title: '45 days', price: 350000, days: 45, channel: 'desk', visitLimit: 3, sort: 3 },
];

const today = () => rules.dhakaDate(new Date());
const inDays = (n) => rules.addDays(today(), n);

/** A private gym: owner (verified phone only), draft gym, packages, short code; tier `tier` when given. */
async function privateGym({ name = 'Iron Yard Banani', owner = null, shortCode = 'IY', tier = null, packages = PACKAGES } = {}) {
  const o = owner ?? (await h.signupUser({ name: 'Karim Uddin' }));
  const g = (await api().post(`${P}/me/gyms`).set(h.bearer(o)).send({ name, areaId: await f.areaId('banani'), addressLine: 'House 9, Road 11, Banani, Dhaka' }).expect(201)).body;
  const withPkgs = (await api().put(`${P}/me/gyms/${g.id}/packages`).set(h.bearer(o)).send({ packages }).expect(200)).body;
  if (shortCode) await api().patch(`${P}/manage/gyms/${g.id}/settings`).set(h.bearer(o)).send({ shortCode }).expect(200);
  if (tier) await api().put(`${P}/manage/billing/tier`).set(h.bearer(o)).send({ tier }).expect(200);
  const pkg = (kind) => withPkgs.packages.find((p) => p.kind === kind);
  return { owner: o, gym: withPkgs, pkg };
}

/** Hire a member as staff of the gym with exactly these permissions; returns their refreshed session. */
async function hire(owner, gymId, who, permissions) {
  await api().post(`${P}/me/team`).set(h.bearer(owner)).send({ businessType: 'gym', businessId: gymId, phone: who.phone, permissions }).expect(201);
  await f.refresh(who);
  return who;
}

const manage = (who, gymId) => ({
  get: (p) => api().get(`${P}/manage/gyms/${gymId}${p}`).set(h.bearer(who)),
  post: (p, body = {}, ik = false) => {
    const r = api().post(`${P}/manage/gyms/${gymId}${p}`).set(h.bearer(who));
    if (ik) r.set('Idempotency-Key', typeof ik === 'string' ? ik : key());
    return r.send(body);
  },
  patch: (p, body) => api().patch(`${P}/manage/gyms/${gymId}${p}`).set(h.bearer(who)).send(body),
  put: (p, body) => api().put(`${P}/manage/gyms/${gymId}${p}`).set(h.bearer(who)).send(body),
});

/** Add a member (Idempotency-Key); `phone` defaults to a fresh number. */
async function addMember(who, gymId, body = {}, status = 201) {
  return (
    await manage(who, gymId)
      .post('/members', { displayName: 'Rafiq Hasan', phone: h.nextPhone(), ...body }, true)
      .expect(status)
  ).body;
}

/**
 * M24 prompt 2: the owner's gym_owner role active (documents approved, gate list_gym), so the gym can take
 * fees online (M24-FR-02). Written directly, like helpers.verifyMember; the session is refreshed.
 */
async function listOwner(owner) {
  await h.models.UserRole.destroy({ where: { userId: owner.user.id, role: 'gym_owner' } });
  await h.models.UserRole.create({ userId: owner.user.id, role: 'gym_owner', status: 'active', activatedAt: new Date() });
  await h.models.User.increment('authzVersion', { where: { id: owner.user.id } });
  await f.refresh(owner);
  return owner;
}

/** Invite a member to link `who`'s account by their phone and accept it (M24-FR-14, FR-15). */
async function linkMember(owner, gymId, memberId, who) {
  await manage(owner, gymId).post(`/members/${memberId}/invite`, { phone: who.phone }).expect(201);
  const mine = (await api().get(`${P}/me/gym-requests`).set(h.bearer(who)).expect(200)).body;
  const req = mine.items[0];
  await api().post(`${P}/me/gym-requests/${req.id}/accept`).set(h.bearer(who)).expect(200);
}

module.exports = { PACKAGES, key, today, inDays, privateGym, hire, manage, addMember, listOwner, linkMember };
