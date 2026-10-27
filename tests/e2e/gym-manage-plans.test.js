'use strict';

// M24 prompt 3 (public site, member area, plans) end to end: join requests from a live gym's page, the
// gym's answer and the referral on the first payment (FR-16, FR-17, FR-91, FR-92); trainers and their
// consumers (FR-21, FR-23); workout plans and diet charts: versions, the assign scope, replacing, the
// member's view and ticks (FR-62 to FR-69); the entrance QR check-in (FR-51); the directory by distance
// and price (§4.1); the landing page's founding offer; jobs run twice; the privacy scan (FR-108).
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const crypto = require('../../src/common/crypto');
const f = require('../fixtures/market');
const gm = require('../fixtures/gym-manage');
const g = require('../fixtures/gym');
const rules = require('../../src/modules/gym-manage/gym-manage.rules');
const jobs = require('../../src/modules/gym-manage/gym-manage.jobs');
const s = require('../../src/modules/gym-manage/gym-manage.schemas');
const gs = require('../../src/modules/gym/gym.schemas');

const { api, P, models } = h;
jest.setTimeout(300000);

let master;
let reviewer;
beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  reviewer = await f.staffWith(master, ['approve_listings', 'approve_documents']);
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const conforms = (schema, body) => expect(schema.safeParse(body).error?.issues ?? []).toEqual([]);
const PHONE = /(\+?880|\b0)1[3-9]\d{8}/;
const as = (who) => ({
  get: (p) => api().get(`${P}${p}`).set(h.bearer(who)),
  post: (p, body = {}, ik = false) => {
    const r = api().post(`${P}${p}`).set(h.bearer(who));
    if (ik) r.set('Idempotency-Key', gm.key());
    return r.send(body);
  },
  put: (p, body = {}) => api().put(`${P}${p}`).set(h.bearer(who)).send(body),
});
const countOf = (userId, code) => models.Notification.count({ where: { userId, code } });

/** A live gym (M20 review) that uses the panel: short code set, plan `tier`; its month package sold at the desk too. */
async function liveManagedGym({ tier = 'standard', owner = null, opts = {}, shortCode = 'IY' } = {}) {
  const o = owner ?? (await g.gymOwner(reviewer, 'Iron Yard Fitness'));
  const gym = await g.liveGym(o, reviewer, opts);
  await gm.manage(o, gym.id).patch('/settings', { shortCode }).expect(200);
  if (tier) await api().put(`${P}/manage/billing/tier`).set(h.bearer(o)).send({ tier }).expect(200);
  return { owner: o, gym, month: gym.packages.find((p) => p.kind === 'month') };
}

/** A person asks to join; the owner accepts (optionally with a membership); returns the person and the answer. */
async function joined(owner, gym, body = {}) {
  const person = await h.signupUser({ name: 'Ayesha Rahman' });
  const r = (await as(person).post('/me/gym-join-requests', { gymId: gym.id }).expect(201)).body;
  const acc = (await gm.manage(owner, gym.id).post(`/requests/${r.request.id}/accept`, body, true).expect(200)).body;
  return { person, member: acc.member, accepted: acc };
}

describe('join requests (M24-FR-16, FR-17, FR-91)', () => {
  it('a person asks a live gym, the gym sees who asks, accepts with a membership and the first payment; the referral charges once', async () => {
    const { owner, gym, month } = await liveManagedGym();
    const desk = gm.manage(owner, gym.id);
    const viewer = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Viewer' }), ['members.view']);
    const editor = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Editor' }), ['members.view', 'members.edit']);
    // M20's gym page shows "Join this gym".
    expect((await api().get(`${P}/gym/gyms/${gym.slug}`).expect(200)).body.joinRequestsOpen).toBe(true);

    const person = await h.signupUser({ name: 'Ayesha Rahman' });
    // FR-16: an unknown package, then a valid request with a package and a note.
    expect((await as(person).post('/me/gym-join-requests', { gymId: gym.id, packageId: '01936f3a-0000-7000-8000-000000000001' }).expect(422)).body.code).toBe('GYM_PACKAGE_UNAVAILABLE');
    const made = (await as(person).post('/me/gym-join-requests', { gymId: gym.id, packageId: month.id, note: 'Evenings after 6' }).expect(201)).body;
    conforms(s.JoinRequestResult, made);
    expect(made.request).toMatchObject({ direction: 'join_request', status: 'pending', gym: { id: gym.id }, package: { id: month.id, kind: 'month' }, note: 'Evenings after 6', canCancel: true, memberId: null });
    expect((await as(person).post('/me/gym-join-requests', { gymId: gym.id }).expect(409)).body.code).toBe('GYM_LINK_REQUEST_PENDING');
    // The owner cannot ask to join their own gym.
    expect((await as(owner).post('/me/gym-join-requests', { gymId: gym.id }).expect(409)).body).toMatchObject({ code: 'GYM_JOIN_NOT_OPEN', reason: 'own_gym' });

    // My side: listed with the invites; the gym side: who asks (name, last 4 digits), the package and the note.
    const mine = (await as(person).get('/me/gym-requests').expect(200)).body;
    conforms(s.MyRequests, mine);
    expect(mine.items.map((x) => x.direction)).toEqual(['join_request']);
    const list = (await desk.get('/requests?direction=join_request').expect(200)).body;
    conforms(s.RequestList, list);
    expect(list.items[0]).toMatchObject({ requester: { displayName: 'Ayesha Rahman', phoneLast4: person.phone.slice(-4) }, package: { id: month.id, pricePoisha: 450000 }, note: 'Evenings after 6', member: null });
    expect(JSON.stringify(list)).not.toMatch(PHONE);
    // The invitee-side answers are for gym invites only.
    expect((await as(person).post(`/me/gym-requests/${made.request.id}/accept`).expect(404)).body.code).toBe('NOT_FOUND');

    // Notices: the owner and members.view staff (GYM_JOIN_REQUEST_NEW); staff to-do for members.edit (M19).
    await h.drainEvents();
    expect(await countOf(owner.user.id, 'GYM_JOIN_REQUEST_NEW')).toBe(1);
    expect(await countOf(viewer.user.id, 'GYM_JOIN_REQUEST_NEW')).toBe(1);
    const todo = (await as(editor).get('/me/dashboard/actions?role=business_staff').expect(200)).body;
    expect(todo.items.find((x) => x.key === 'gym_requests_waiting')).toMatchObject({ count: 1 });
    expect((await desk.get('/overview').expect(200)).body.tiles.requestsWaiting).toBe(1);

    // FR-17: members.view alone cannot answer; the owner accepts with the package, a start and the first payment.
    expect((await gm.manage(viewer, gym.id).post(`/requests/${made.request.id}/accept`, {}, true).expect(403)).body.permission).toBe('members.edit');
    await desk.post(`/requests/${made.request.id}/accept`, {}).expect(400);
    const acc = (await desk.post(`/requests/${made.request.id}/accept`, { packageId: month.id, startsOn: gm.today(), payment: { amountPoisha: 200000, method: 'cash' } }, true).expect(200)).body;
    conforms(s.JoinAcceptResult, acc);
    expect(acc).toMatchObject({ linkedExisting: false, member: { source: 'platform', linked: true, displayName: 'Ayesha Rahman', phoneLast4: person.phone.slice(-4) }, request: { status: 'accepted', memberId: acc.member.id }, membership: { packageKind: 'month' }, payment: { amountPoisha: 200000 } });
    expect((await desk.post(`/requests/${made.request.id}/accept`, {}, true).expect(409)).body.code).toBe('GYM_LINK_REQUEST_STATE');
    // FR-91: the first positive payment charges the referral once; a second payment does not.
    expect(await models.GymReferral.findAll()).toEqual([expect.objectContaining({ memberId: acc.member.id, amountPoisha: 20000, linkRequestId: made.request.id, status: 'pending' })]);
    await desk.post(`/dues/${acc.due.id}/payments`, { amountPoisha: 100000, method: 'cash' }, true).expect(201);
    expect(await models.GymReferral.count()).toBe(1);

    // The person: GYM_JOIN_ACCEPTED; the gym in my memberships, linked; my request accepted with its member.
    await h.drainEvents();
    expect(await countOf(person.user.id, 'GYM_JOIN_ACCEPTED')).toBe(1);
    expect(await countOf(owner.user.id, 'GYM_LINK_ACCEPTED')).toBe(0);
    const ms = (await as(person).get('/me/gym-memberships').expect(200)).body;
    conforms(s.MyMemberships, ms);
    expect(ms.items).toEqual([expect.objectContaining({ memberId: acc.member.id, linked: true, plans: [] })]);
    expect((await as(person).get('/me/gym-requests?status=accepted').expect(200)).body.items[0]).toMatchObject({ memberId: acc.member.id, canCancel: false });
    // FR-18: after an unlink the gym stays under Past (found through the accepted join request).
    await as(person).post(`/me/gym-memberships/${acc.member.id}/unlink`).expect(200);
    expect((await as(person).get('/me/gym-memberships').expect(200)).body.items).toEqual([expect.objectContaining({ memberId: acc.member.id, linked: false })]);
    // A linked person cannot ask again; after the unlink they can.
    const again = (await as(person).post('/me/gym-join-requests', { gymId: gym.id }).expect(201)).body.request;
    // Accepting links the existing unlinked member with the same phone (no new member, no new referral).
    const relink = (await gm.manage(editor, gym.id).post(`/requests/${again.id}/accept`, {}, true).expect(200)).body;
    expect(relink).toMatchObject({ linkedExisting: true, member: { id: acc.member.id, linked: true }, membership: null });
    expect(await models.GymMember.count({ where: { gymId: gym.id } })).toBe(1);
    expect(await models.AuditLog.count({ where: { action: 'gym_link.join_accepted' } })).toBe(2);
    expect(await models.AuditLog.count({ where: { action: 'gym_link.join_requested' } })).toBe(2);
  });

  it('closed gyms refuse (private, switched off, paused); a member cancels; a declined request makes the desk member a referral (FR-92); expiry', async () => {
    const { owner, gym, month } = await liveManagedGym({ tier: 'basic' });
    const desk = gm.manage(owner, gym.id);
    const person = await h.signupUser({ name: 'Rafiq Hasan' });
    // A private gym (draft) and a gym that switched join requests off.
    const priv = await gm.privateGym({ name: 'Private Yard', shortCode: 'PY' });
    expect((await as(person).post('/me/gym-join-requests', { gymId: priv.gym.id }).expect(409)).body).toMatchObject({ code: 'GYM_JOIN_NOT_OPEN', reason: 'not_live' });
    await desk.patch('/settings', { joinRequestsOpen: false }).expect(200);
    expect((await as(person).post('/me/gym-join-requests', { gymId: gym.id }).expect(409)).body).toMatchObject({ code: 'GYM_JOIN_NOT_OPEN', reason: 'closed' });
    expect((await api().get(`${P}/gym/gyms/${gym.slug}`).expect(200)).body.joinRequestsOpen).toBe(false);
    await desk.patch('/settings', { joinRequestsOpen: true }).expect(200);
    // An unverified phone is refused by the gate.
    const unverified = await h.signupUser();
    await models.User.update({ phoneVerifiedAt: null }, { where: { id: unverified.user.id } });
    await models.User.increment('authzVersion', { where: { id: unverified.user.id } });
    await f.refresh(unverified);
    expect((await as(unverified).post('/me/gym-join-requests', { gymId: gym.id }).expect(403)).body.code).toBe('PHONE_REQUIRED');

    // Cancel my own request (and only mine, once).
    const r1 = (await as(person).post('/me/gym-join-requests', { gymId: gym.id }).expect(201)).body.request;
    const other = await h.signupUser();
    await as(other).post(`/me/gym-requests/${r1.id}/cancel`).expect(404);
    expect((await as(person).post(`/me/gym-requests/${r1.id}/cancel`).expect(200)).body.request.status).toBe('cancelled');
    expect((await as(person).post(`/me/gym-requests/${r1.id}/cancel`).expect(409)).body.code).toBe('GYM_LINK_REQUEST_STATE');
    // The gym cannot cancel a join request (invites only) or accept a cancelled one.
    expect((await desk.post(`/requests/${r1.id}/cancel`).expect(409)).body.code).toBe('GYM_LINK_REQUEST_STATE');

    // Decline: the person is told; then the same phone added at the desk is a referral on its first payment.
    const r2 = (await as(person).post('/me/gym-join-requests', { gymId: gym.id, packageId: month.id }).expect(201)).body.request;
    const dec = (await desk.post(`/requests/${r2.id}/decline`, { reason: 'Full this month' }).expect(200)).body;
    conforms(s.RequestResult, dec);
    expect(dec.request).toMatchObject({ status: 'declined', direction: 'join_request' });
    await h.drainEvents();
    expect(await countOf(person.user.id, 'GYM_JOIN_DECLINED')).toBe(1);
    const pk = (await desk.get('/packages').expect(200)).body.items.find((p) => p.kind === 'month');
    const added = await gm.addMember(owner, gym.id, { displayName: 'Rafiq Hasan', phone: person.phone, membership: { packageId: pk.id, startsOn: gm.today() }, payment: { amountPoisha: 100000, method: 'cash' } });
    expect(added.member.source).toBe('platform');
    expect(await models.GymReferral.findOne({ where: { memberId: added.member.id } })).toMatchObject({ linkRequestId: r2.id, status: 'pending' });

    // Expiry (job, twice): a pending request past expires_at → expired, once.
    const late = await h.signupUser();
    const r3 = (await as(late).post('/me/gym-join-requests', { gymId: gym.id }).expect(201)).body.request;
    await models.GymLinkRequest.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { id: r3.id } });
    expect((await desk.post(`/requests/${r3.id}/accept`, {}, true).expect(409)).body).toMatchObject({ code: 'GYM_LINK_REQUEST_STATE', status: 'expired' });
    // A stale pending row does not block a new request (it is expired on the spot).
    const r4 = (await as(late).post('/me/gym-join-requests', { gymId: gym.id }).expect(201)).body.request;
    expect((await models.GymLinkRequest.findByPk(r3.id)).status).toBe('expired');
    await models.GymLinkRequest.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { id: r4.id } });
    expect(await jobs.requestsExpire()).toEqual({ expired: 1 });
    expect(await jobs.requestsExpire()).toEqual({ expired: 0 });

    // A paused gym takes no new requests.
    await models.Gym.update({ status: 'paused' }, { where: { id: gym.id } });
    expect((await as(await h.signupUser()).post('/me/gym-join-requests', { gymId: gym.id }).expect(409)).body.reason).toBe('not_live');
  });
});

describe('trainers (M24-FR-21, FR-23) and their consumers', () => {
  it('the tier gate, who can be picked, assign and clear, the list filter, a trainer sees only their members; removal and permission changes clear it', async () => {
    const { owner, gym } = await liveManagedGym({ tier: 'basic' });
    const desk = gm.manage(owner, gym.id);
    const a = (await gm.addMember(owner, gym.id, { displayName: 'Anika Member' })).member;
    const b = (await gm.addMember(owner, gym.id, { displayName: 'Bashir Member' })).member;
    const coach = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Coach Sabbir' }), ['members.trainer', 'plans.manage']);
    const cashier = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Cashier Mitu' }), ['members.view', 'fees.collect']);
    const writer = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Writer Nila' }), ['members.view', 'plans.manage']);
    const bmOf = async (who) => (await models.BusinessMember.findOne({ where: { memberId: who.user.id, status: 'active' } })).id;
    const coachBm = await bmOf(coach);
    // Basic has no trainers (Standard and up).
    expect((await desk.get('/trainers').expect(403)).body).toMatchObject({ code: 'GYM_TIER_REQUIRED', feature: 'trainers', minTier: 'standard' });
    await api().put(`${P}/manage/billing/tier`).set(h.bearer(owner)).send({ tier: 'standard' }).expect(200);

    const list = (await desk.get('/trainers').expect(200)).body;
    conforms(s.Trainers, list);
    expect(list.items.map((x) => [x.displayName, x.permissions, x.assignedMembers])).toEqual([
      ['Coach Sabbir', ['members.trainer', 'plans.manage'], 0],
      ['Writer Nila', ['plans.manage'], 0],
    ]);
    // A cashier is not a trainer.
    expect((await desk.put(`/members/${a.id}/trainer`, { businessMemberId: await bmOf(cashier) }).expect(422)).body.code).toBe('GYM_TRAINER_INVALID');
    expect((await gm.manage(cashier, gym.id).put(`/members/${a.id}/trainer`, { businessMemberId: coachBm }).expect(403)).body.permission).toBe('members.edit');
    const prof = (await desk.put(`/members/${a.id}/trainer`, { businessMemberId: coachBm }).expect(200)).body;
    conforms(s.MemberProfile, prof);
    expect(prof.member.trainer).toEqual({ businessMemberId: coachBm, displayName: 'Coach Sabbir' });
    expect(prof.can).toMatchObject({ assignTrainer: true, plans: true });
    // Same again changes nothing (no second event).
    await desk.put(`/members/${a.id}/trainer`, { businessMemberId: coachBm }).expect(200);
    expect(await models.AuditLog.count({ where: { action: 'gym_member.trainer_assigned' } })).toBe(1);

    // FR-23: the trainer filter, the trainer on list rows; a trainer-only caller sees only their members.
    const filtered = (await desk.get(`/members?trainerId=${coachBm}`).expect(200)).body;
    conforms(s.MemberList, filtered);
    expect(filtered.items.map((x) => [x.id, x.trainer?.displayName])).toEqual([[a.id, 'Coach Sabbir']]);
    expect((await gm.manage(coach, gym.id).get('/members').expect(200)).body.items.map((x) => x.id)).toEqual([a.id]);
    await gm.manage(coach, gym.id).get(`/members/${b.id}`).expect(404);
    expect((await desk.get('/trainers').expect(200)).body.items[0].assignedMembers).toBe(1);

    // Consumers: taking away one of the two permissions keeps it; both clears it.
    await desk.put(`/members/${b.id}/trainer`, { businessMemberId: await bmOf(writer) }).expect(200);
    await api().patch(`${P}/me/team/${coachBm}`).set(h.bearer(owner)).send({ permissions: ['members.trainer'] }).expect(200);
    await h.drainEvents();
    expect((await models.GymMember.findByPk(a.id)).trainerBusinessMemberId).toBe(coachBm);
    await api().patch(`${P}/me/team/${coachBm}`).set(h.bearer(owner)).send({ permissions: ['members.view'] }).expect(200);
    await h.drainEvents();
    expect((await models.GymMember.findByPk(a.id)).trainerBusinessMemberId).toBeNull();
    // Removing the writer from the team clears their member.
    await api().post(`${P}/me/team/${await bmOf(writer)}/remove`).set(h.bearer(owner)).expect(200);
    await h.drainEvents();
    expect((await models.GymMember.findByPk(b.id)).trainerBusinessMemberId).toBeNull();
    const evs = h.events.recorded().filter((e) => e.name === 'gym_member.trainer_assigned').map((e) => e.payload.reason);
    expect(evs).toEqual(['assigned', 'assigned', 'permissions_removed', 'staff_removed']);
    expect(await models.AuditLog.count({ where: { action: 'gym_member.trainer_cleared' } })).toBe(2);
    // Clearing by hand.
    await desk.put(`/members/${b.id}/trainer`, { businessMemberId: null }).expect(200);
  });
});

const WORKOUT = {
  kind: 'workout',
  days: [
    {
      key: 'd1',
      name: { en: 'Chest and triceps', bn: 'বুক ও ট্রাইসেপস' },
      items: [
        { ref: 'i1', name: { en: 'Bench press', bn: 'বেঞ্চ প্রেস' }, sets: 4, reps: '8-10', restSec: 90, weightNote: '70% of max', note: null, videoUrl: 'https://example.com/v' },
        { ref: 'i2', name: { en: 'Dips' }, sets: 3, reps: '12' },
      ],
    },
    { key: 'd2', name: { en: 'Legs' }, items: [{ ref: 'i3', name: { en: 'Squat' }, sets: 5, reps: '5' }] },
  ],
};
const DIET = {
  kind: 'diet',
  meals: [{ ref: 'm1', name: { en: 'Breakfast', bn: 'সকালের নাস্তা' }, time: '08:00', items: [{ ref: 'f1', name: { en: 'Two eggs', bn: 'দুটি ডিম' }, portion: '2 pcs', kcal: 140, proteinG: 12 }] }],
  notes: { en: '3 litres of water a day', bn: 'দিনে ৩ লিটার পানি' },
};

describe('workout plans and diet charts (M24-FR-62 to FR-69)', () => {
  it('write with checks, versions for assigned members, the assign scope, replacing, member views, ticks and the window, who sees what, retire, end', async () => {
    const { owner, gym, month } = await liveManagedGym({ tier: 'basic' });
    const desk = gm.manage(owner, gym.id);
    // FR-07: Basic has no plans.
    expect((await desk.post('/plans', { kind: 'workout', title: 'Push', content: WORKOUT }).expect(403)).body).toMatchObject({ code: 'GYM_TIER_REQUIRED', feature: 'plans', minTier: 'standard' });
    await api().put(`${P}/manage/billing/tier`).set(h.bearer(owner)).send({ tier: 'standard' }).expect(200);

    // FR-62, FR-68: invalid content with paths, a javascript: link, source ai, and the live item limit.
    const bad = (await desk.post('/plans', { kind: 'workout', title: 'Push', source: 'ai', content: { kind: 'workout', days: [{ key: 'd1', name: {}, items: [{ ref: 'x 1', name: { en: 'A' }, videoUrl: 'javascript:alert(1)' }] }] } }).expect(422)).body;
    expect(bad.code).toBe('VALIDATION_FAILED');
    expect(bad.errors.map((e) => e.field)).toEqual(expect.arrayContaining(['source', 'content.days.0.name', 'content.days.0.items.0.ref', 'content.days.0.items.0.videoUrl']));
    await h.setSettingForTest('gym_manage.plan_max_items', 5);
    const many = { kind: 'workout', days: [{ key: 'd1', name: { en: 'Day' }, items: Array.from({ length: 6 }, (_, i) => ({ ref: `i${i}`, name: { en: `Ex ${i}` } })) }] };
    expect((await desk.post('/plans', { kind: 'workout', title: 'Too long', content: many }).expect(422)).body.errors).toEqual([{ field: 'content.days[0].items', message: 'At most 5 items' }]);
    expect((await desk.post('/plans', { kind: 'diet', title: 'Mismatch', content: WORKOUT }).expect(422)).body.code).toBe('VALIDATION_FAILED');

    const plan = (await desk.post('/plans', { kind: 'workout', title: 'Push and legs', isTemplate: true, content: WORKOUT }).expect(201)).body;
    conforms(s.PlanDetail, plan);
    expect(plan).toMatchObject({ kind: 'workout', currentVersion: 1, isTemplate: true, source: 'gym', status: 'active', activeAssignments: 0, versions: [{ version: 1 }] });
    const chart = (await desk.post('/plans', { kind: 'diet', title: 'Lean bulk', content: DIET }).expect(201)).body;
    conforms(s.PlanList, (await desk.get('/plans').expect(200)).body);
    expect((await desk.get('/plans?kind=diet').expect(200)).body.items.map((x) => x.id)).toEqual([chart.id]);
    expect((await desk.get('/plans?template=true').expect(200)).body.items.map((x) => x.id)).toEqual([plan.id]);

    // Members: Ayesha linked (join request), Bashir at the desk; a trainer with plans.manage for Bashir only.
    const { person, member: ayesha } = await joined(owner, gym, { packageId: month.id });
    const bashir = (await gm.addMember(owner, gym.id, { displayName: 'Bashir Member' })).member;
    const coach = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Coach Sabbir' }), ['members.trainer', 'plans.manage']);
    const coachBm = (await models.BusinessMember.findOne({ where: { memberId: coach.user.id } })).id;
    await desk.put(`/members/${bashir.id}/trainer`, { businessMemberId: coachBm }).expect(200);
    const trainerDesk = gm.manage(coach, gym.id);
    const start = gm.inDays(-10);

    // FR-64: the trainer may assign only to their members.
    expect((await trainerDesk.post(`/plans/${plan.id}/assign`, { memberIds: [ayesha.id, bashir.id], startsOn: start }).expect(403)).body).toMatchObject({ code: 'GYM_PLAN_ASSIGN_SCOPE', memberIds: [ayesha.id] });
    const byTrainer = (await trainerDesk.post(`/plans/${plan.id}/assign`, { memberIds: [bashir.id], startsOn: start }).expect(201)).body;
    conforms(s.AssignResult, byTrainer);
    expect(byTrainer).toMatchObject({ replaced: 0, assignments: [{ memberId: bashir.id, version: 1, status: 'active' }] });
    expect((await desk.post(`/plans/${plan.id}/assign`, { memberIds: [ayesha.id], startsOn: gm.inDays(-400) }).expect(422)).body.code).toBe('GYM_DATE_OUT_OF_RANGE');
    const asg = (await desk.post(`/plans/${plan.id}/assign`, { memberIds: [ayesha.id], startsOn: start }).expect(201)).body.assignments[0];
    await desk.post(`/plans/${chart.id}/assign`, { memberIds: [ayesha.id], startsOn: start }).expect(201);
    await h.drainEvents();
    expect(await countOf(person.user.id, 'GYM_PLAN_ASSIGNED')).toBe(2);

    // FR-65: my plans: today's workout by the day mapping (10 days in, 2 days → day 0), today's meals, the week.
    const my = (await as(person).get('/me/gym-plans').expect(200)).body;
    conforms(s.MyPlans, my);
    const w = my.items.find((x) => x.kind === 'workout');
    expect(w).toMatchObject({ assignmentId: asg.id, todayIndex: 10 % 2, readOnly: false, title: 'Push and legs', safety: { en: `Given by ${gym.name}, not medical advice` } });
    expect(w.week.map((d) => d.index)).toEqual([0, 1, 0, 1, 0, 1, 0]);
    expect(my.items.find((x) => x.kind === 'diet')).toMatchObject({ todayIndex: 0, content: { meals: [{ ref: 'm1' }] } });
    expect((await as(person).get('/me/gym-memberships').expect(200)).body.items[0].plans.map((x) => x.kind).sort()).toEqual(['diet', 'workout']);

    // Ticks: today's items only, today and 7 days back; the latest tick per item and date wins.
    const log = (body, status = 201) => as(person).post(`/me/gym-plans/${asg.id}/logs`, body).expect(status);
    conforms(s.PlanLogResult, (await log({ localDate: gm.today(), itemRef: 'i1', done: true })).body);
    await log({ localDate: gm.today(), itemRef: 'i1', done: false, note: 'Shoulder hurt' });
    expect((await log({ localDate: gm.today(), itemRef: 'i3', done: true }, 422)).body.errors[0].field).toBe('itemRef');
    expect((await log({ localDate: gm.inDays(-7), itemRef: 'i3', done: true })).body.log.itemRef).toBe('i3');
    expect((await log({ localDate: gm.inDays(-8), itemRef: 'i1', done: true }, 422)).body.code).toBe('GYM_PLAN_LOG_WINDOW');
    expect((await log({ localDate: gm.inDays(1), itemRef: 'i3', done: true }, 422)).body.code).toBe('GYM_PLAN_LOG_WINDOW');
    const ticks = (await as(person).get('/me/gym-plans').expect(200)).body.items.find((x) => x.kind === 'workout').ticks;
    expect(ticks.filter((t) => t.localDate === gm.today())).toEqual([expect.objectContaining({ itemRef: 'i1', done: false, note: 'Shoulder hurt' })]);
    await as(await h.signupUser()).get(`/me/gym-plans/${asg.id}`).expect(404);

    // FR-63: a new version moves the assigned members (told once); with the box off they keep theirs.
    const v2 = { ...WORKOUT, days: [WORKOUT.days[0], { ...WORKOUT.days[1], items: [{ ref: 'i3', name: { en: 'Front squat' }, sets: 4, reps: '6' }] }] };
    const edited = (await desk.patch(`/plans/${plan.id}`, { title: 'Push and legs v2', content: v2 }).expect(200)).body;
    expect(edited).toMatchObject({ currentVersion: 2, movedAssignments: 2, title: 'Push and legs v2' });
    await desk.patch(`/plans/${plan.id}`, { content: WORKOUT, applyToAssigned: false }).expect(200);
    expect((await desk.get(`/plans/${plan.id}`).expect(200)).body).toMatchObject({ currentVersion: 3, versions: [{ version: 3 }, { version: 2 }, { version: 1 }] });
    await h.drainEvents();
    expect(await countOf(person.user.id, 'GYM_PLAN_UPDATED')).toBe(1);
    const mine = (await as(person).get(`/me/gym-plans/${asg.id}`).expect(200)).body;
    conforms(s.MyPlanDetail, mine);
    expect(mine).toMatchObject({ version: 2, versions: [{ version: 2 }, { version: 1 }] });
    // Newest tick first (the later tick for 7 days ago, then today's latest).
    expect(mine.logs.map((l) => [l.localDate, l.itemRef, l.done])).toEqual([
      [gm.inDays(-7), 'i3', true],
      [gm.today(), 'i1', false],
    ]);
    // Adherence on the plan page; a content edit of the wrong kind is refused.
    // (7 days back is outside the 7-day adherence column; yesterday, day 2 of the plan, counts.)
    await log({ localDate: gm.inDays(-1), itemRef: 'i3', done: true });
    const page = (await desk.get(`/plans/${plan.id}`).expect(200)).body;
    expect(page.assignments.find((x) => x.memberId === ayesha.id)).toMatchObject({ lastTickOn: gm.today(), doneLast7Days: 1, version: 2 });
    expect((await trainerDesk.get(`/plans/${plan.id}`).expect(200)).body.assignments.map((x) => x.memberId)).toEqual([bashir.id]);
    expect((await desk.patch(`/plans/${plan.id}`, { content: DIET }).expect(422)).body.code).toBe('VALIDATION_FAILED');

    // FR-66: who sees what about a member's plans.
    await as(person).put(`/me/gym-memberships/${ayesha.id}/health-note`, { text: 'Asthma' }).expect(200);
    const full = (await desk.get(`/members/${ayesha.id}/plans`).expect(200)).body;
    conforms(s.MemberPlans, full);
    expect(full).toMatchObject({ healthNote: 'Asthma' });
    expect(full.items.find((x) => x.kind === 'workout').logs.length).toBe(3);
    const cashier = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Cashier Mitu' }), ['members.view', 'fees.collect']);
    const titles = (await gm.manage(cashier, gym.id).get(`/members/${ayesha.id}/plans`).expect(200)).body;
    expect(titles.healthNote).toBeUndefined();
    expect(titles.items.every((x) => x.content === undefined && x.logs === undefined)).toBe(true);
    expect((await gm.manage(cashier, gym.id).get('/plans').expect(403)).body.permission).toBe('plans.manage');

    // Replacing: a new workout plan replaces the old one; the old stays readable.
    const other = (await desk.post('/plans', { kind: 'workout', title: 'Full body', content: WORKOUT }).expect(201)).body;
    expect((await desk.post(`/plans/${other.id}/assign`, { memberIds: [ayesha.id], startsOn: gm.today() }).expect(201)).body.replaced).toBe(1);
    expect((await models.GymPlanAssignment.findByPk(asg.id)).status).toBe('replaced');
    expect((await as(person).get(`/me/gym-plans/${asg.id}`).expect(200)).body.readOnly).toBe(true);
    expect((await log({ localDate: gm.today(), itemRef: 'i1', done: true }, 409)).body.code).toBe('GYM_PLAN_STATE');

    // Retire: no new assignments; end an assignment; the daily job ends assignments past their end date (twice).
    await desk.post(`/plans/${other.id}/retire`).expect(200);
    expect((await desk.post(`/plans/${other.id}/retire`).expect(409)).body.code).toBe('GYM_PLAN_STATE');
    expect((await desk.post(`/plans/${other.id}/assign`, { memberIds: [bashir.id], startsOn: gm.today() }).expect(409)).body.code).toBe('GYM_PLAN_STATE');
    expect((await desk.patch(`/plans/${other.id}`, { title: 'Nope' }).expect(409)).body.code).toBe('GYM_PLAN_STATE');
    const bashirAsg = byTrainer.assignments[0];
    conforms(s.AssignmentResult, (await trainerDesk.post(`/plan-assignments/${bashirAsg.id}/end`).expect(200)).body);
    expect((await trainerDesk.post(`/plan-assignments/${bashirAsg.id}/end`).expect(409)).body.code).toBe('GYM_PLAN_STATE');
    const dietAsg = await models.GymPlanAssignment.findOne({ where: { memberId: ayesha.id, kind: 'diet', status: 'active' } });
    await dietAsg.update({ endsOn: gm.inDays(-1) });
    expect((await jobs.daily()).plansEnded).toBe(1);
    expect((await jobs.daily()).plansEnded).toBe(0);
    // FR-67: after unlinking, my plans are read-only.
    await as(person).post(`/me/gym-memberships/${ayesha.id}/unlink`).expect(200);
    expect((await as(person).get('/me/gym-plans').expect(200)).body.items.every((x) => x.readOnly)).toBe(true);
    // §8.8: removing a member ends their plans (Bashir has none active now; give one and remove).
    await desk.post(`/plans/${chart.id}/assign`, { memberIds: [bashir.id], startsOn: gm.today() }).expect(201);
    await desk.post(`/members/${bashir.id}/remove`, { reason: 'Added by mistake' }).expect(200);
    expect(await models.GymPlanAssignment.count({ where: { memberId: bashir.id, status: 'active' } })).toBe(0);
    // The logs and versions are append-only.
    await expect(models.sequelize.query('UPDATE gym_plan_logs SET done = true')).rejects.toThrow();
    await expect(models.sequelize.query('UPDATE gym_plan_versions SET version = 9')).rejects.toThrow();
    for (const a of ['gym_plan.created', 'gym_plan.updated', 'gym_plan.assigned', 'gym_plan.ended', 'gym_plan.retired', 'gym_plan.logged']) expect([a, (await models.AuditLog.count({ where: { action: a } })) > 0]).toEqual([a, true]);
  });
});

describe('the entrance QR check-in (M24-FR-51)', () => {
  it('the tablet token (no-store), a linked member scans it, a repeat, block with the gym’s message, an old code, not a member, the tier', async () => {
    const { owner, gym, month } = await liveManagedGym({ tier: 'free' });
    const desk = gm.manage(owner, gym.id);
    expect((await desk.get('/entrance-token').expect(403)).body).toMatchObject({ code: 'GYM_TIER_REQUIRED', feature: 'attendance' });
    const { person, member } = await joined(owner, gym, { packageId: month.id });
    // The member scanning a Free gym's code is refused by the tier too.
    const w = rules.windowOf(Date.now(), 30);
    const code = rules.entranceToken({ gymId: gym.id, window: w }, crypto.hmac);
    expect((await as(person).post('/me/gym-checkins', { token: code }).expect(403)).body.code).toBe('GYM_TIER_REQUIRED');
    await api().put(`${P}/manage/billing/tier`).set(h.bearer(owner)).send({ tier: 'basic' }).expect(200);

    const tok = await desk.get('/entrance-token').expect(200);
    expect(tok.headers['cache-control']).toBe('no-store');
    conforms(s.EntranceToken, tok.body);
    expect(tok.body).toMatchObject({ gymId: gym.id, gymName: gym.name, seconds: 30 });
    expect(tok.body.token.startsWith('v1.ge.')).toBe(true);
    const viewer = await gm.hire(owner, gym.id, await h.signupUser(), ['members.view']);
    expect((await gm.manage(viewer, gym.id).get('/entrance-token').expect(403)).body.permission).toBe('attendance.mark');

    const first = await as(person).post('/me/gym-checkins', { token: tok.body.token }).expect(201);
    conforms(s.EntranceCheckin, first.body);
    expect(first.body).toMatchObject({ counted: true, method: 'entrance_qr', member: { id: member.id }, decision: 'allow', membership: { status: 'active' } });
    const repeat = await as(person).post('/me/gym-checkins', { token: tok.body.token }).expect(200);
    expect(repeat.body).toMatchObject({ counted: false, firstCheckInToday: first.body.checkedInAt });
    expect(await models.GymAttendance.findAll({ where: { memberId: member.id } })).toEqual([expect.objectContaining({ method: 'entrance_qr', counted: true }), expect.objectContaining({ method: 'entrance_qr', counted: false })]);

    // An old code (two windows ago), a desk member QR, garbage; someone not linked to the gym.
    const old = rules.entranceToken({ gymId: gym.id, window: w - 2 }, crypto.hmac);
    for (const t of [old, 'v1.ge.nope.1.zz', rules.memberToken({ memberId: member.id, window: w }, crypto.hmac)]) {
      expect((await as(person).post('/me/gym-checkins', { token: t }).expect(422)).body.code).toBe('GYM_CHECKIN_TOKEN_INVALID');
    }
    expect((await as(await h.signupUser()).post('/me/gym-checkins', { token: tok.body.token }).expect(403)).body.code).toBe('GYM_NOT_A_MEMBER');

    // block: a linked member with no membership is refused with the gym's message and no override.
    await desk.patch('/settings', { entryPolicy: 'block' }).expect(200);
    const { person: newcomer } = await joined(owner, gym);
    const blocked = (await as(newcomer).post('/me/gym-checkins', { token: tok.body.token }).expect(409)).body;
    expect(blocked).toMatchObject({ code: 'GYM_ENTRY_BLOCKED', reasons: ['none'], canOverride: false, gym: { id: gym.id } });
    expect(blocked.detail).toContain(gym.name);
    // warn lets them in with the reasons.
    await desk.patch('/settings', { entryPolicy: 'warn' }).expect(200);
    expect((await as(newcomer).post('/me/gym-checkins', { token: tok.body.token }).expect(201)).body).toMatchObject({ decision: 'warn', reasons: ['none'], membership: null });
    // The desk path still works through the same core.
    expect((await desk.post('/checkins', { memberId: member.id }).expect(200)).body.counted).toBe(false);
    expect(await models.AuditLog.count({ where: { action: 'gym_attendance.entrance' } })).toBe(3);
  });
});

describe('the directory by distance and price (M20 for §4.1), the landing page offer', () => {
  it('nearest from a position (pin, else the area centre), a radius, the monthly price cap, distanceM on cards; founding places on pricing', async () => {
    const owner = await g.gymOwner(reviewer, 'Gym Chain');
    const cheap = [
      { kind: 'day', title: 'Day pass', price: 30000 },
      { kind: 'month', title: 'Monthly', price: 300000 },
    ];
    const gulshan = await g.liveGym(owner, reviewer, { name: 'Gulshan Gym', lat: 23.7925, lng: 90.4078 });
    const uttara = await g.liveGym(owner, reviewer, { name: 'Uttara Gym', lat: 23.8759, lng: 90.3795, packages: cheap });
    const noPin = await g.liveGym(owner, reviewer, { name: 'Banani Gym' });
    const near = { lat: 23.794, lng: 90.405 };
    const list = (await api().get(`${P}/gym/gyms?lat=${near.lat}&lng=${near.lng}`).expect(200)).body;
    conforms(gs.GymList, list);
    // Nearest first: every card carries its distance, in order.
    const ds = list.items.map((x) => x.distanceM);
    expect(ds).toEqual([...ds].sort((a, b) => a - b));
    const d = Object.fromEntries(list.items.map((x) => [x.name, x.distanceM]));
    expect(d['Gulshan Gym']).toBeLessThan(1000);
    expect(d['Uttara Gym']).toBeGreaterThan(8000);
    expect(d['Banani Gym']).toEqual(expect.any(Number));
    expect(list.items.at(-1).name).toBe('Uttara Gym');
    // The radius, the monthly price cap, the plain list without a position.
    expect((await api().get(`${P}/gym/gyms?lat=${near.lat}&lng=${near.lng}&radiusKm=5`).expect(200)).body.items.map((x) => x.name).sort()).toEqual(['Banani Gym', 'Gulshan Gym']);
    expect((await api().get(`${P}/gym/gyms?priceMax=350000`).expect(200)).body.items.map((x) => x.id)).toEqual([uttara.id]);
    const plain = (await api().get(`${P}/gym/gyms`).expect(200)).body;
    expect(plain.items[0]).toMatchObject({ id: uttara.id, distanceM: null });
    expect(plain.items.map((x) => x.id).sort()).toEqual([gulshan.id, uttara.id, noPin.id].sort());
    // Explicit sorts with a position, and the checks.
    expect((await api().get(`${P}/gym/gyms?lat=${near.lat}&lng=${near.lng}&sort=price`).expect(200)).body.items[0].id).toBe(uttara.id);
    expect((await api().get(`${P}/gym/gyms?sort=nearest`).expect(422)).body.code).toBe('VALIDATION_FAILED');
    expect((await api().get(`${P}/gym/gyms?radiusKm=3`).expect(422)).body.code).toBe('VALIDATION_FAILED');
    expect((await api().get(`${P}/gym/gyms?lat=23.7`).expect(422)).body.code).toBe('VALIDATION_FAILED');

    // The landing page: tiers and the founding partner offer while places are left.
    const pricing = (await api().get(`${P}/gym-manage/pricing`).expect(200)).body;
    conforms(s.Pricing, pricing);
    expect(pricing).toMatchObject({ foundingPlacesLeft: 20, founding: { limit: 20, freeMonths: 2, discountPct: 25, discountMonths: 12 } });
    await h.setSettingForTest('gym_saas.founding_partner_limit', 0);
    expect((await api().get(`${P}/gym-manage/pricing`).expect(200)).body.foundingPlacesLeft).toBe(0);
  });
});

describe('privacy (M24-FR-108)', () => {
  it('prompt 3 events carry ids only; the requests list shows the last 4 digits of a phone', async () => {
    const { owner, gym, month } = await liveManagedGym();
    const { person, member } = await joined(owner, gym, { packageId: month.id });
    const desk = gm.manage(owner, gym.id);
    const plan = (await desk.post('/plans', { kind: 'workout', title: 'Push', content: WORKOUT }).expect(201)).body;
    await desk.post(`/plans/${plan.id}/assign`, { memberIds: [member.id], startsOn: gm.today() }).expect(201);
    await desk.patch(`/plans/${plan.id}`, { content: WORKOUT }).expect(200);
    await as(person).post('/me/gym-checkins', { token: (await desk.get('/entrance-token').expect(200)).body.token }).expect(201);
    await h.drainEvents();
    const names = new Set();
    for (const e of h.events.recorded().filter((x) => x.name.startsWith('gym_'))) {
      names.add(e.name);
      expect(JSON.stringify(e.payload)).not.toMatch(PHONE);
      expect(JSON.stringify(e.payload)).not.toContain('Ayesha');
    }
    expect([...names]).toEqual(expect.arrayContaining(['gym_link.requested', 'gym_link.accepted', 'gym_member.added', 'gym_plan.assigned', 'gym_plan.updated', 'gym_attendance.recorded']));
    expect(JSON.stringify((await desk.get('/requests?status=accepted').expect(200)).body)).not.toMatch(PHONE);
  });
});
