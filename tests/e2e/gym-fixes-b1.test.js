'use strict';

// Tester feedback batch 1 (19 Nov 2026): a photo on a counter-shop product (M27), and a master removing
// any gym, suspended included, with the held money refunded and what was already paid to the gym listed.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const f = require('../fixtures/market');
const g = require('../fixtures/gym');
const gm = require('../fixtures/gym-manage');

const { api, P, models } = h;

let master;
let reviewer;
let docsReviewer;
let seq = 0;
const key = (p) => `${p}-${Date.now()}-${(seq += 1)}`;

beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  reviewer = await f.staffWith(master, ['approve_listings', 'manage_users']);
  docsReviewer = await f.staffWith(master, ['approve_documents']);
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const photo = (who, gymId, productId, buf, type) => api().post(`${P}/manage/gyms/${gymId}/products/${productId}/photo`).set(h.bearer(who)).set('Content-Type', type).send(buf);

describe('tester feedback batch 1', () => {
  it('a product photo: set, replaced, refused when it is not a photo or the staff member lacks stock.manage, removed', async () => {
    const { owner, gym } = await gm.privateGym({ tier: 'standard' });
    const m = gm.manage(owner, gym.id);
    const p = (await m.post('/products', { name: 'Whey 1kg', category: 'supplement', pricePoisha: 450000 }).expect(201)).body;
    expect(p.photoUrl).toBeNull();

    const set = (await photo(owner, gym.id, p.id, Buffer.concat([f.PNG, Buffer.from(f.uniq('pp'))]), 'image/png').expect(200)).body;
    expect(set.photoUrl).toMatch(/gym-products\/.+\.png$/);
    const replaced = (await photo(owner, gym.id, p.id, Buffer.concat([f.JPEG, Buffer.from(f.uniq('pp'))]), 'image/jpeg').expect(200)).body;
    expect(replaced.photoUrl).toMatch(/\.jpg$/);
    expect(replaced.photoUrl).not.toBe(set.photoUrl);
    expect((await m.get('/products').expect(200)).body.items[0].photoUrl).toBe(replaced.photoUrl);

    expect((await photo(owner, gym.id, p.id, Buffer.from('not a photo'), 'image/png').expect(415)).body.code).toBe('FILE_TYPE_MISMATCH');
    expect((await photo(owner, gym.id, p.id, Buffer.alloc(0), 'image/png').expect(422)).body.code).toBe('FILE_EMPTY');
    const cashier = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Cashier Mitu' }), ['pos.sell']);
    expect((await photo(cashier, gym.id, p.id, f.PNG, 'image/png').expect(403)).body.code).toBe('PERMISSION_REQUIRED');

    expect((await m.post(`/products/${p.id}/photo/remove`).expect(200)).body.photoUrl).toBeNull();
    expect(await models.AuditLog.count({ where: { action: ['gym_product.photo_set', 'gym_product.photo_removed'] } })).toBe(3);
  });

  it('a master removes a suspended gym: the unused subscription is refunded, the used one is listed as paid to the gym', async () => {
    const owner = await g.gymOwner(docsReviewer);
    const gym = await g.liveGym(owner, reviewer);
    const month = gym.packages.find((x) => x.kind === 'month').id;
    const buyPaid = async (who) => {
      const r = (await api().post(`${P}/gym/passes`).set(h.bearer(who)).set('Idempotency-Key', key('gp')).send({ packageId: month, validFrom: g.today() }).expect(201)).body;
      await h.payWithSimulator(who, r.payment.id);
      await h.drainEvents();
      return (await api().get(`${P}/me/passes/${r.pass.code}`).set(h.bearer(who)).expect(200)).body.pass;
    };
    const used = await buyPaid(await h.signupUser({ name: 'Arif Hasan' }));
    const unused = await buyPaid(await h.signupUser({ name: 'Mitu Akter' }));
    await api().post(`${P}/me/gyms/${gym.id}/redemptions`).set(h.bearer(owner)).send({ token: used.token }).expect(201);

    await api().post(`${P}/admin/gym/gyms/${gym.id}/suspend`).set(h.bearer(reviewer)).send({ reason: 'Complaints from members' }).expect(200);
    // The owner cannot remove a suspended gym (nor one with running subscriptions).
    expect((await api().post(`${P}/me/gyms/${gym.id}/remove`).set(h.bearer(owner)).send({ confirmName: gym.name }).expect(409)).body.code).toBe('GYM_STATE');

    // Staff who are not masters, and a master without step-up, are refused.
    await api().post(`${P}/admin/gym/gyms/${gym.id}/remove`).set(h.bearer(reviewer)).send({ reason: 'Closed for good' }).expect(403);
    expect((await api().post(`${P}/admin/gym/gyms/${gym.id}/remove`).set(h.bearer(master)).send({ reason: 'Closed for good' }).expect(403)).body.code).toBe('STEP_UP_REQUIRED');

    const out = (await api().post(`${P}/admin/gym/gyms/${gym.id}/remove`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'escrow.manage')).send({ reason: 'Closed for good' }).expect(200)).body;
    expect(out.status).toBe('removed');
    expect(out.refunded).toEqual([{ code: unused.code, refunded: 450000 }]);
    expect(out.paidToGym).toEqual([expect.objectContaining({ code: used.code, paidToGym: expect.any(Number) })]);
    expect(out.paidToGym[0].paidToGym).toBeGreaterThan(0);
    expect((await models.Gym.findByPk(gym.id)).status).toBe('removed');
    expect((await models.GymPass.findOne({ where: { code: unused.code } })).status).toBe('refunded');
    await api().get(`${P}/gym/gyms/${gym.slug}`).expect(404);
    expect(await models.AuditLog.count({ where: { action: 'gym.removed_by_staff', entityId: gym.id } })).toBe(1);

    // Removing again is refused.
    expect((await api().post(`${P}/admin/gym/gyms/${gym.id}/remove`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'escrow.manage')).send({ reason: 'Closed for good' }).expect(409)).body.code).toBe('GYM_STATE');
  });
});
