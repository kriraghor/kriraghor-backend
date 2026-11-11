'use strict';

// M27 conversion report (product owner, 11 Nov 2026; M27-FR-87 to FR-91), end to end: enquiries from the gym
// page, free trial visits and join requests that came in this month and what became of them, the month's new
// members by source, who may read it, the plan tier and the owner's CSV.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const f = require('../fixtures/market');
const gm = require('../fixtures/gym-manage');
const g = require('../fixtures/gym');

const { api, P, models } = h;
jest.setTimeout(300000);

let reviewer;
beforeEach(async () => {
  await h.resetDb();
  // All tests run from one address and the enquiry counters live in Redis (they outlast resetDb); the caps
  // themselves are tested in gym-ops-round2.
  await h.clearVelocity('gym_lead_');
  const master = await h.createSignedInMaster();
  reviewer = await f.staffWith(master, ['approve_listings', 'approve_documents']);
});
afterAll(async () => {
  await h.clearVelocity('gym_lead_');
  await closeAllRedis();
  await models.sequelize.close();
});

const as = (who) => ({
  get: (p) => api().get(`${P}${p}`).set(h.bearer(who)),
  post: (p, body = {}, ik = false) => {
    const r = api().post(`${P}${p}`).set(h.bearer(who));
    if (ik) r.set('Idempotency-Key', gm.key());
    return r.send(body);
  },
});

/** A live gym (M20 review) that uses the panel, on a plan tier. */
async function liveManagedGym(tier, name = 'Iron Yard Fitness', shortCode = 'IY') {
  const owner = await g.gymOwner(reviewer, name);
  const gym = await g.liveGym(owner, reviewer);
  await gm.manage(owner, gym.id).patch('/settings', { shortCode }).expect(200);
  await api().put(`${P}/manage/billing/tier`).set(h.bearer(owner)).send({ tier }).expect(200);
  return { owner, gym, slug: (await models.Gym.findByPk(gym.id)).slug };
}

describe('M27 conversion report', () => {
  it('counts the month’s enquiries, trial visits and join requests and what became of them', async () => {
    const { owner, gym, slug } = await liveManagedGym('standard');
    const m = gm.manage(owner, gym.id);
    const month = gm.today().slice(0, 7);

    // Nothing yet: zeros, and no share to show.
    const empty = (await m.get('/reports/conversion').expect(200)).body;
    expect(empty.period.month).toBe(month);
    expect(empty.enquiries).toEqual({ received: 0, open: 0, contacted: 0, joined: 0, lost: 0, joinedPct: null });
    expect(empty.visits).toMatchObject({ booked: 0, joined: 0, joinedPct: null });
    expect(empty.joinRequests).toEqual({ received: 0, accepted: 0, closed: 0, waiting: 0, joinedPct: null });
    expect(empty.members).toEqual({ total: 0, bySource: { desk: 0, platform: 0, import: 0 }, fromVisit: 0, fromEnquiry: 0 });

    // Three enquiries from the gym page: one contacted, one joined (a member added at the desk), one still new.
    const ask = (name, phone) => api().post(`${P}/gym/gyms/${slug}/enquiries`).send({ name, phone }).expect(202);
    await ask('Nadia', '01711000111');
    await ask('Omar', '01711000222');
    await ask('Purnima', '01711000333');
    const leads = (await m.get('/leads').expect(200)).body.items;
    const lead = (name) => leads.find((x) => x.name === name);
    await m.patch(`/leads/${lead('Omar').id}`, { status: 'contacted' }).expect(200);
    const nadia = await gm.addMember(owner, gym.id, { displayName: 'Nadia' });
    await m.patch(`/leads/${lead('Nadia').id}`, { status: 'joined', memberId: nadia.member.id }).expect(200);
    expect((await models.GymLead.findByPk(lead('Nadia').id)).joinedAt).not.toBeNull();

    // Three free visits: one cancelled by the guest, one attended and made a member, one still to come.
    await m.patch('/settings', { visitsOpen: true }).expect(200);
    const [ana, bo, cy] = [await h.signupUser({ name: 'Guest Ana' }), await h.signupUser({ name: 'Guest Bo' }), await h.signupUser({ name: 'Guest Cy' })];
    const book = async (who, arriveAt) => (await as(who).post('/me/gym-visits', { gymId: gym.id, date: gm.inDays(1), arriveAt }, true).expect(201)).body.visit;
    const va = await book(ana, '10:00');
    const vb = await book(bo, '11:00');
    await book(cy, '12:00');
    await as(bo).post(`/me/gym-visits/${vb.id}/cancel`).expect(200);
    // The visits are dated today, so the report's month holds them whatever day the test runs.
    await models.GymVisit.update({ visitDate: gm.today() }, { where: { gymId: gym.id } });
    await m.post(`/visits/${va.id}/check-in`).expect(200);
    const made = (await m.post(`/visits/${va.id}/convert`).expect(201)).body;
    expect((await models.GymVisit.findByPk(va.id)).convertedAt).not.toBeNull();
    expect(made.member ?? made.visit).toBeDefined();

    // Two join requests from the gym page: one accepted, one waiting.
    const dan = await h.signupUser({ name: 'Dan Roy' });
    const eli = await h.signupUser({ name: 'Eli Das' });
    const asked = (await as(dan).post('/me/gym-join-requests', { gymId: gym.id }).expect(201)).body;
    await m.post(`/requests/${asked.request.id}/accept`, {}, true).expect(200);
    await as(eli).post('/me/gym-join-requests', { gymId: gym.id }).expect(201);

    const r = (await m.get(`/reports/conversion?month=${month}`).expect(200)).body;
    expect(r.enquiries).toEqual({ received: 3, open: 1, contacted: 1, joined: 1, lost: 0, joinedPct: 33.3 });
    expect(r.visits).toEqual({ booked: 3, attended: 1, missed: 0, cancelled: 1, waiting: 1, joined: 1, joinedPct: 50 });
    expect(r.joinRequests).toEqual({ received: 2, accepted: 1, closed: 0, waiting: 1, joinedPct: 50 });
    expect(r.members).toEqual({ total: 3, bySource: { desk: 2, platform: 1, import: 0 }, fromVisit: 1, fromEnquiry: 1 });
    // Counts only: no name and no phone of anyone.
    expect(JSON.stringify(r)).not.toMatch(/Nadia|Guest|Dan Roy|0171/);

    // Another month has nothing; a month ahead falls back to this one.
    const past = (await m.get('/reports/conversion?month=2020-01').expect(200)).body;
    expect(past.period).toEqual({ month: '2020-01', from: '2020-01-01', to: '2020-01-31' });
    expect(past.enquiries.received).toBe(0);
    expect(past.members.total).toBe(0);
    expect((await m.get('/reports/conversion?month=2999-01').expect(200)).body.period.month).toBe(month);
    expect((await m.get('/reports/conversion?month=11-2026').expect(422)).body.code).toBe('VALIDATION_FAILED');

    // Who reads it (M27-FR-90): the owner and reports.view; the CSV is the owner's (M27-FR-91).
    const accountant = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Accountant Mina' }), ['reports.view']);
    const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rumi' }), ['attendance.mark', 'leads.manage']);
    expect((await gm.manage(accountant, gym.id).get('/reports/conversion').expect(200)).body.enquiries.received).toBe(3);
    expect((await gm.manage(desk, gym.id).get('/reports/conversion').expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    await gm.manage(accountant, gym.id).get('/reports/conversion/export').expect(403);
    const file = await m.get(`/reports/conversion/export?month=${month}`).expect(200);
    expect(file.headers['content-type']).toMatch(/text\/csv/);
    expect(file.headers['content-disposition']).toContain(`conversion-${month}.csv`);
    expect(file.text).toContain('"Enquiries","Received","3"');
    expect(file.text).toContain('"Trial visits","Became members","1"');
    expect(file.text).toContain('"New members","Came from an enquiry","1"');
    expect(file.text).not.toMatch(/Nadia|0171/);
    expect(await models.AuditLog.count({ where: { action: 'gym_ops.conversion_exported', entityId: gym.id } })).toBe(1);
  });

  it('needs the reports feature; a plan without enquiries or visits leaves those groups out', async () => {
    const basic = await liveManagedGym('basic');
    expect((await gm.manage(basic.owner, basic.gym.id).get('/reports/conversion').expect(403)).body).toMatchObject({ code: 'GYM_TIER_REQUIRED', feature: 'reports' });
    expect((await gm.manage(basic.owner, basic.gym.id).get('/reports/conversion/export').expect(403)).body.code).toBe('GYM_TIER_REQUIRED');

    // A master moves enquiries and visits to Pro: a Standard gym then reads the report without those two groups.
    const tiers = h.models.PlatformSetting ? await models.PlatformSetting.findOne({ where: { key: 'gym_saas.feature_min_tiers' } }) : null;
    await h.setSettingForTest('gym_saas.feature_min_tiers', { ...tiers.value, leads: 'pro', visits: 'pro' });
    const std = await liveManagedGym('standard', 'Second Gym', 'SG');
    const r = (await gm.manage(std.owner, std.gym.id).get('/reports/conversion').expect(200)).body;
    expect(r.enquiries).toBeNull();
    expect(r.visits).toBeNull();
    expect(r.joinRequests).toMatchObject({ received: 0 });
    expect(r.members.total).toBe(0);
  });
});
