'use strict';

// Suspension is a total freeze (tester feedback, 19 Nov 2026): a gym Kriraghor suspends is shut to staff
// and members, the owner may only look, and booked visits are cancelled; suspending the owner's account
// suspends every gym of the owner, and restoring the account brings them back to the status they had.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const f = require('../fixtures/market');
const gm = require('../fixtures/gym-manage');

const { api, P, models } = h;
const HOURS = { hours: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, openTime: '06:00', closeTime: '22:00', womenOnly: false })) };

let master;
let support;
beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  support = await f.staffWith(master, ['manage_users']);
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const admin = (who, p, body) => api().post(`${P}${p}`).set(h.bearer(who)).send(body);
const me = (who, p, body = {}) => api().post(`${P}${p}`).set(h.bearer(who)).set('Idempotency-Key', gm.key()).send(body);
const gymOf = (id) => models.Gym.findByPk(id);

describe('suspension is a total freeze', () => {
  it('a suspended private gym: staff shut out, the owner only reads, members refused; a master restores it as it was', async () => {
    const { owner, gym } = await gm.privateGym({ tier: 'basic' });
    const g = gm.manage(owner, gym.id);
    const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rumi' }), ['members.view', 'members.edit', 'attendance.mark']);
    const added = await gm.addMember(owner, gym.id, { displayName: 'Rafiq Hasan' });
    expect((await gymOf(gym.id)).status).toBe('draft');

    // Staff with manage_users suspend a private gym (it was refused before: only live or paused).
    expect((await admin(support, `/admin/gym/gyms/${gym.id}/suspend`, { reason: 'Members complained about fees' }).expect(200)).body.status).toBe('suspended');
    const row = await gymOf(gym.id);
    expect(row).toMatchObject({ status: 'suspended', suspendCause: 'staff', suspendedFrom: 'draft' });

    // The owner may look, never change.
    await g.get('/members').expect(200);
    expect((await g.patch('/settings', { shortCode: 'IY' }).expect(423)).body.code).toBe('GYM_SUSPENDED');
    expect((await gm.addMember(owner, gym.id, { displayName: 'Nadia Islam' }, 423)).code).toBe('GYM_SUSPENDED');
    // Staff cannot even look; the M27 routes are frozen too.
    expect((await gm.manage(desk, gym.id).get('/members').expect(423)).body.code).toBe('GYM_SUSPENDED');
    expect((await g.post('/expenses', { categoryId: '00000000-0000-0000-0000-000000000000', amountPoisha: 1000, method: 'cash' }).expect(423)).body.code).toBe('GYM_SUSPENDED');

    // Restoring is for masters, and puts the gym back as it was (a private draft).
    await admin(support, `/admin/gym/gyms/${gym.id}/restore`, { reason: 'Fees explained' }).expect(403);
    expect((await admin(master, `/admin/gym/gyms/${gym.id}/restore`, { reason: 'Fees explained' }).expect(200)).body.status).toBe('draft');
    expect(await gymOf(gym.id)).toMatchObject({ status: 'draft', suspendCause: null, suspendedFrom: null });
    await gm.addMember(owner, gym.id, { displayName: 'Nadia Islam' });
    await gm.manage(desk, gym.id).get(`/members/${added.member.id}`).expect(200);
    expect(await models.AuditLog.count({ where: { action: ['gym.suspended', 'gym.restored'], entityId: gym.id } })).toBe(2);
  });

  it('booked visits are cancelled and members cannot book, check in or pay at a suspended gym', async () => {
    const { owner, gym } = await gm.privateGym({ tier: 'basic' });
    await models.Gym.update({ status: 'live', liveVersion: 1, liveSnapshot: { name: gym.name, ...HOURS } }, { where: { id: gym.id } });
    await gm.manage(owner, gym.id).patch('/settings', { visitsOpen: true, visitDailyCap: 5, visitPerPerson: 2 }).expect(200);
    const ana = await h.signupUser({ name: 'Guest Ana' });
    await me(ana, '/me/gym-visits', { gymId: gym.id, date: gm.inDays(1), arriveAt: '18:00' }).expect(201);

    await admin(support, `/admin/gym/gyms/${gym.id}/suspend`, { reason: 'Unsafe equipment reported' }).expect(200);
    expect(await gymOf(gym.id)).toMatchObject({ status: 'suspended', suspendedFrom: 'live' });
    await h.drainEvents();
    expect(await models.GymVisit.count({ where: { gymId: gym.id, status: 'cancelled', cancelBy: 'gym' } })).toBe(1);
    expect((await me(ana, '/me/gym-visits', { gymId: gym.id, date: gm.inDays(2), arriveAt: '18:00' }).expect(423)).body.code).toBe('GYM_SUSPENDED');
    // The public page is gone (M20 shows live and paused gyms only).
    const slug = (await gymOf(gym.id)).slug;
    await api().get(`${P}/gym/gyms/${slug}`).expect(404);
  });

  it("suspending the owner's account suspends every gym; restoring the account brings each back as it was", async () => {
    const { owner, gym } = await gm.privateGym({ tier: 'pro' });
    const second = await gm.privateGym({ owner, name: 'Iron Yard Uttara', shortCode: 'IU', tier: 'pro' });
    await models.Gym.update({ status: 'live', liveVersion: 1, liveSnapshot: { name: second.gym.name, ...HOURS } }, { where: { id: second.gym.id } });

    // One gym Kriraghor already suspended stays suspended for its own reason.
    const third = await gm.privateGym({ owner, name: 'Iron Yard Mirpur', shortCode: 'IM', tier: 'pro' });
    await admin(support, `/admin/gym/gyms/${third.gym.id}/suspend`, { reason: 'Fake photos' }).expect(200);

    await admin(support, `/admin/users/${owner.user.id}/suspend`, { reasonCode: 'fraud', note: 'Taking fees for a closed gym' }).expect(200);
    await h.drainEvents();
    expect(await gymOf(gym.id)).toMatchObject({ status: 'suspended', suspendCause: 'owner_account', suspendedFrom: 'draft' });
    expect(await gymOf(second.gym.id)).toMatchObject({ status: 'suspended', suspendCause: 'owner_account', suspendedFrom: 'live' });
    expect(await gymOf(third.gym.id)).toMatchObject({ suspendCause: 'staff' });
    // A gym suspended with the account comes back only with the account.
    expect((await admin(master, `/admin/gym/gyms/${gym.id}/restore`, { reason: 'Too early' }).expect(409)).body.code).toBe('GYM_OWNER_SUSPENDED');

    await admin(support, `/admin/users/${owner.user.id}/restore`, { note: 'Refunds made' }).expect(200);
    await h.drainEvents();
    expect(await gymOf(gym.id)).toMatchObject({ status: 'draft', suspendCause: null });
    expect(await gymOf(second.gym.id)).toMatchObject({ status: 'live', suspendCause: null });
    expect(await gymOf(third.gym.id)).toMatchObject({ status: 'suspended', suspendCause: 'staff' });
  });
});
