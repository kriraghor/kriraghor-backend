'use strict';

// M24 §19 (product owner, 11 Nov 2026; M24-FR-121 to FR-127), end to end: a linked member reads whether they
// can renew, renews and pays at the counter (the gym is told) or online (through the simulator), takes a
// renewal back, and every refusal: too early, switched off by the gym, a renewal already waiting, a package
// the gym does not sell online, a gym that cannot take fees online, someone else's membership.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const gm = require('../fixtures/gym-manage');
const s = require('../../src/modules/gym-manage/gym-manage.schemas');

const { api, P, models } = h;
jest.setTimeout(300000);

beforeEach(async () => {
  await h.resetDb();
  await h.createSignedInMaster();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const conforms = (schema, body) => expect(schema.safeParse(body).error?.issues ?? []).toEqual([]);
const countOf = (userId, code) => models.Notification.count({ where: { userId, code } });
const me = (who, memberId) => ({
  options: () => api().get(`${P}/me/gym-memberships/${memberId}/renewal`).set(h.bearer(who)),
  renew: (body, key = gm.key('rn')) => {
    const r = api().post(`${P}/me/gym-memberships/${memberId}/renew`).set(h.bearer(who));
    if (key) r.set('Idempotency-Key', key);
    return r.send(body);
  },
  cancel: () => api().post(`${P}/me/gym-memberships/${memberId}/renewal/cancel`).set(h.bearer(who)),
});

/**
 * A Basic gym with a member linked to an account, on a Monthly package that started `startedDaysAgo` days
 * ago (30 days, so it ends in 29 − startedDaysAgo days). `online`: the owner may take fees online.
 */
async function linked({ startedDaysAgo = 20, online = true } = {}) {
  const { owner, gym, pkg } = await gm.privateGym({ tier: 'basic' });
  if (online) await gm.listOwner(owner);
  const who = await h.signupUser({ name: 'Rafiq Hasan' });
  const added = await gm.addMember(owner, gym.id, { displayName: 'Rafiq Hasan', phone: who.phone, membership: { packageId: pkg('month').id, startsOn: gm.inDays(-startedDaysAgo) } });
  await gm.linkMember(owner, gym.id, added.member.id, who);
  return { owner, gym, pkg, who, member: added.member, first: added.membership, g: gm.manage(owner, gym.id), m: me(who, added.member.id) };
}

describe('M24 a member renews by themselves', () => {
  it('reads the choices, renews for the counter, the gym is told, and takes it back', async () => {
    const { owner, gym, pkg, who, member, first, g, m } = await linked();
    const collector = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rumi' }), ['fees.collect', 'members.view']);
    const trainer = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Trainer Tania' }), ['members.trainer']);

    // The read (M24-FR-122): nine days left, so it is open; the dates continue from the old end; the price is
    // the package price; the desk-only package is not offered.
    const o = (await m.options().expect(200)).body;
    conforms(s.MyRenewal, o);
    expect(o).toMatchObject({ memberId: member.id, can: true, reason: null, opensOn: null, daysBefore: 14, renewal: null, onlineFees: true });
    expect(o.current).toMatchObject({ title: 'Monthly', endsOn: first.endsOn, status: 'active' });
    expect(o.packages.map((p) => p.title)).toEqual(['Monthly', 'Quarterly']);
    expect(o.packages[0]).toMatchObject({ packageId: pkg('month').id, current: true, pricePoisha: 250000, startsOn: gm.inDays(10), endsOn: gm.inDays(39), days: 30 });
    expect(o.packages[1]).toMatchObject({ current: false, pricePoisha: 650000, startsOn: gm.inDays(10) });

    // Checks before anything is made.
    await m.renew({ pay: 'counter' }, null).expect(400);
    expect((await m.renew({ pay: 'cash' }).expect(422)).body.code).toBe('VALIDATION_FAILED');
    expect((await m.renew({ pay: 'counter', packageId: pkg('custom').id }).expect(422)).body.code).toBe('GYM_PACKAGE_UNAVAILABLE');
    expect(await models.GymMembership.count({ where: { memberId: member.id } })).toBe(1);

    // Renew for the counter (M24-FR-123): the desk's membership and due, made by the member, no admission fee.
    const key = gm.key('rn');
    const made = (await m.renew({ pay: 'counter' }, key).expect(201)).body;
    conforms(s.RenewedByMember, made);
    expect(made.membership).toMatchObject({ origin: 'renewal', createdVia: 'member', previousId: first.id, status: 'upcoming', startsOn: gm.inDays(10), endsOn: gm.inDays(39), pricePoisha: 250000, admissionFeePoisha: 0, discountPoisha: 0 });
    expect(made.due).toMatchObject({ amountPoisha: 250000, status: 'unpaid' });
    expect(made.payment).toBeNull();
    // The same key replays the same answer; a new key finds the renewal waiting.
    expect((await m.renew({ pay: 'counter' }, key).expect(201)).body.membership.id).toBe(made.membership.id);
    expect((await m.renew({ pay: 'counter' }).expect(409)).body).toMatchObject({ code: 'GYM_RENEWAL_EXISTS', membershipId: made.membership.id });
    expect(await models.GymMembership.count({ where: { memberId: member.id } })).toBe(2);
    expect(await models.AuditLog.count({ where: { action: 'gym_membership.renewed_by_member', entityId: made.membership.id } })).toBe(1);

    // The gym is told (M24-FR-124): the owner and staff who take fees, not the trainer, not the member.
    await h.drainEvents();
    expect(await countOf(owner.user.id, 'GYM_RENEWAL_BY_MEMBER')).toBe(1);
    expect(await countOf(collector.user.id, 'GYM_RENEWAL_BY_MEMBER')).toBe(1);
    expect(await countOf(trainer.user.id, 'GYM_RENEWAL_BY_MEMBER')).toBe(0);
    expect(await countOf(who.user.id, 'GYM_RENEWAL_BY_MEMBER')).toBe(0);
    const note = await models.Notification.findOne({ where: { userId: owner.user.id, code: 'GYM_RENEWAL_BY_MEMBER' } });
    expect(JSON.stringify(note.toJSON())).not.toContain(who.phone.slice(-10));
    // The desk sees who made it (M24-FR-126), and the fee waits with the other dues.
    const profile = (await g.get(`/members/${member.id}`).expect(200)).body;
    expect(JSON.stringify(profile)).toContain('"createdVia":"member"');

    // The read now shows the waiting renewal, which can be taken back (M24-FR-125).
    const waiting = (await m.options().expect(200)).body;
    expect(waiting).toMatchObject({ can: false, reason: 'GYM_RENEWAL_EXISTS', packages: [] });
    expect(waiting.renewal).toMatchObject({ membershipId: made.membership.id, createdVia: 'member', dueId: made.due.dueId, amountPoisha: 250000, outstandingPoisha: 250000, cancellable: true });
    const back = (await m.cancel().expect(200)).body;
    expect(back).toMatchObject({ can: true, renewal: null });
    expect((await models.GymMembership.findByPk(made.membership.id)).status).toBe('cancelled');
    expect((await models.GymDue.findByPk(made.due.dueId)).status).toBe('void');
    expect(await models.AuditLog.count({ where: { action: 'gym_membership.renewal_cancelled_by_member', entityId: made.membership.id } })).toBe(1);
    expect((await m.cancel().expect(409)).body.code).toBe('GYM_NOTHING_TO_RENEW');

    // A renewal the desk made is not the member's to cancel, and blocks a second one.
    const atDesk = (await g.post(`/memberships/${first.id}/renew`, {}, true).expect(201)).body;
    expect((await models.GymMembership.findByPk(atDesk.membership.id)).createdVia).toBe('desk');
    expect((await m.cancel().expect(409)).body).toMatchObject({ code: 'GYM_MEMBERSHIP_STATE', reason: 'made_at_desk' });
    expect((await m.options().expect(200)).body.renewal).toMatchObject({ createdVia: 'desk', cancellable: false });
    expect((await m.renew({ pay: 'counter' }).expect(409)).body.code).toBe('GYM_RENEWAL_EXISTS');

    // Nobody else's membership.
    const other = await h.signupUser({ name: 'Other Person' });
    await me(other, member.id).options().expect(404);
    await me(other, member.id).renew({ pay: 'counter' }).expect(404);
    await me(other, member.id).cancel().expect(404);
  });

  it('pays online through the gateway; a paid renewal cannot be taken back', async () => {
    const { who, member, m } = await linked({ startedDaysAgo: 25 });
    const made = (await m.renew({ pay: 'online', packageId: (await m.options().expect(200)).body.packages[1].packageId }).expect(201)).body;
    expect(made.membership).toMatchObject({ title: 'Quarterly', createdVia: 'member', status: 'upcoming', startsOn: gm.inDays(5) });
    expect(made.due).toMatchObject({ amountPoisha: 650000, status: 'unpaid' });
    expect(made.payment).toMatchObject({ amountPoisha: 650000 });
    expect(made.payment.payUrl).toContain(made.payment.paymentId);
    const link = await models.GymPaymentLink.findOne({ where: { dueId: made.due.dueId } });
    expect(link.toJSON()).toMatchObject({ origin: 'member', status: 'open', amountPoisha: 650000 });

    // Before the payment lands the member can still pay the due later (it is with their dues).
    const dues = (await api().get(`${P}/me/gym-dues`).set(h.bearer(who)).expect(200)).body;
    expect(dues.items.find((d) => d.dueId === made.due.dueId)).toMatchObject({ outstandingPoisha: 650000, onlineFees: true });

    await h.payWithSimulator(who, made.payment.paymentId);
    await h.drainEvents();
    expect((await models.GymDue.findByPk(made.due.dueId)).toJSON()).toMatchObject({ status: 'paid', paidPoisha: 650000 });
    expect(await models.GymFeePayment.count({ where: { dueId: made.due.dueId } })).toBe(1);
    const after = (await m.options().expect(200)).body;
    expect(after.renewal).toMatchObject({ membershipId: made.membership.id, outstandingPoisha: 0, cancellable: false });
    expect((await m.cancel().expect(409)).body).toMatchObject({ code: 'GYM_MEMBERSHIP_STATE', reason: 'paid' });
    expect((await models.GymMembership.findByPk(made.membership.id)).status).toBe('upcoming');
    expect(await models.GymMembership.count({ where: { memberId: member.id } })).toBe(2);
  });

  it('refuses when it is too early, when the gym switched it off, and online pay at a gym without online fees; an expired membership starts today', async () => {
    // Too early: 29 days left of 30.
    const early = await linked({ startedDaysAgo: 0, online: false });
    const o = (await early.m.options().expect(200)).body;
    expect(o).toMatchObject({ can: false, reason: 'GYM_RENEW_TOO_EARLY', opensOn: gm.inDays(15), packages: [], onlineFees: false });
    expect((await early.m.renew({ pay: 'counter' }).expect(409)).body).toMatchObject({ code: 'GYM_RENEW_TOO_EARLY', from: gm.inDays(15) });

    // The membership ran out 40 days ago (past the grace days): the renewal starts today and is active at once.
    await models.GymMembership.update({ startsOn: gm.inDays(-70), endsOn: gm.inDays(-41), status: 'expired' }, { where: { id: early.first.id } });
    await models.GymMember.update({ status: 'expired' }, { where: { id: early.member.id } });
    const open = (await early.m.options().expect(200)).body;
    expect(open).toMatchObject({ can: true, onlineFees: false });
    expect(open.packages[0]).toMatchObject({ startsOn: gm.today(), endsOn: gm.inDays(29) });
    // This gym cannot take fees online: asking to pay online makes nothing.
    expect((await early.m.renew({ pay: 'online' }).expect(403)).body.code).toBe('GYM_ONLINE_FEES_UNAVAILABLE');
    expect(await models.GymMembership.count({ where: { memberId: early.member.id } })).toBe(1);
    const made = (await early.m.renew({ pay: 'counter' }).expect(201)).body;
    expect(made.membership).toMatchObject({ status: 'active', startsOn: gm.today(), endsOn: gm.inDays(29), createdVia: 'member' });
    expect((await models.GymMember.findByPk(early.member.id)).status).toBe('active');
    // It has started, so it is the desk's to cancel; and it is too early to renew again.
    expect((await early.m.cancel().expect(409)).body.code).toBe('GYM_NOTHING_TO_RENEW');
    expect((await early.m.options().expect(200)).body).toMatchObject({ can: false, reason: 'GYM_RENEW_TOO_EARLY' });

    // The gym's switch (M24-FR-121): on by default, the owner's to change, staff cannot.
    const off = await linked({ online: false });
    const settings = (await off.g.get('/settings').expect(200)).body;
    expect(settings).toMatchObject({ selfRenewOpen: true, selfRenewDaysBefore: 14 });
    expect((await off.g.patch('/settings', { selfRenewOpen: false }).expect(200)).body.selfRenewOpen).toBe(false);
    expect((await off.m.options().expect(200)).body).toMatchObject({ can: false, reason: 'GYM_SELF_RENEW_OFF', packages: [] });
    expect((await off.m.renew({ pay: 'counter' }).expect(409)).body).toMatchObject({ code: 'GYM_SELF_RENEW_OFF', reason: 'off' });
    await off.g.patch('/settings', { selfRenewOpen: true }).expect(200);
    // A member who left cannot renew by themselves.
    await off.g.post(`/members/${off.member.id}/leave`, { reason: 'moved' }).expect(200);
    expect((await off.m.options().expect(200)).body).toMatchObject({ can: false, reason: 'GYM_MEMBER_STATE' });
    expect((await off.m.renew({ pay: 'counter' }).expect(409)).body).toMatchObject({ code: 'GYM_MEMBER_STATE', reason: 'left' });
    // An account that is no longer linked gets nothing.
    await models.GymMember.update({ userId: null }, { where: { id: off.member.id } });
    await off.m.options().expect(404);
    await off.m.renew({ pay: 'counter' }).expect(404);
  });
});
