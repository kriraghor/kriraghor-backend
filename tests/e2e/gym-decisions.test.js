'use strict';

// Product owner decisions of 23 Nov 2026, end to end:
//  - billing pauses while a gym is suspended (M24-FR-171 to FR-173): a suspended branch's members are not
//    counted; days with every gym suspended are frozen and credited on the monthly invoice; a fully frozen
//    month issues nothing; dunning never gets worse while frozen;
//  - gym staff trainers show their account photo (M24-FR-174): the trainers list, a member's trainer, plan
//    authors, class trainers, and the member's own "your trainer".
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const gm = require('../fixtures/gym-manage');
const rules = require('../../src/modules/gym-manage/gym-manage.rules');
const jobs = require('../../src/modules/gym-manage/gym-manage.jobs');
const s = require('../../src/modules/gym-manage/gym-manage.schemas');

const { api, P, models } = h;
jest.setTimeout(400000);
const HOUR = 3600000;

beforeEach(async () => {
  await h.resetDb();
  await h.createSignedInMaster();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const conforms = (schema, body) => expect(schema.safeParse(body).error?.issues ?? []).toEqual([]);
const suspend = (gymId) => models.Gym.update({ status: 'suspended', suspendCause: 'staff', suspendedFrom: 'draft' }, { where: { id: gymId } });
const restore = (gymId) => models.Gym.update({ status: 'draft', suspendCause: null, suspendedFrom: null }, { where: { id: gymId } });
const countRow = (ownerId) => models.GymActiveMemberCount.findOne({ where: { ownerId }, order: [['localDate', 'DESC']] });

describe('decisions of 23 Nov 2026', () => {
  it('billing pauses while suspended: the count, frozen days, the credit line, nothing issued, dunning holds', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'standard' });
    const two = await gm.privateGym({ owner, name: 'Iron Yard Gulshan', shortCode: 'IG' });
    const pay = { payment: { amountPoisha: 100000, method: 'cash' } };
    await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.today() }, ...pay });
    await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.today() }, ...pay });
    await gm.addMember(owner, two.gym.id, { membership: { packageId: two.pkg('month').id, startsOn: gm.today() }, ...pay });
    const tomorrow = new Date(Date.now() + 24 * HOUR);

    // Both gyms open: all three members count.
    await jobs.activeCount(tomorrow);
    expect(await countRow(owner.user.id)).toMatchObject({ activeCount: 3, gymsCount: 2, frozen: false });

    // One branch suspended: its members are left out (M24-FR-171).
    await suspend(gym.id);
    await jobs.activeCount(tomorrow);
    expect(await countRow(owner.user.id)).toMatchObject({ activeCount: 1, gymsCount: 1, frozen: false });

    // Every gym suspended: the day is frozen.
    await suspend(two.gym.id);
    await jobs.activeCount(tomorrow);
    expect(await countRow(owner.user.id)).toMatchObject({ activeCount: 0, frozen: true });

    // A month with 10 frozen days of 30: the plan is credited 10/30 (M24-FR-172).
    const month = rules.firstOfMonth(rules.addMonths(gm.today(), -1));
    const days = Array.from({ length: rules.daysInMonth(month) }, (_, i) => rules.addDays(month, i));
    await models.GymActiveMemberCount.destroy({ where: { ownerId: owner.user.id } });
    await models.GymActiveMemberCount.bulkCreate(days.map((d, i) => ({ ownerId: owner.user.id, localDate: d, activeCount: 120, gymsCount: 2, chosenTier: 'standard', frozen: i < 10 })));
    await models.GymOwnerSubscription.update({ startedOn: rules.addMonths(month, -3) }, { where: { ownerId: owner.user.id } });
    const cycleAt = new Date(rules.instantOf(rules.addMonths(month, 1)).getTime() + 2 * HOUR);
    expect(await jobs.invoiceCycle(cycleAt)).toMatchObject({ issued: 1 });
    const inv = (await api().get(`${P}/manage/billing/invoices`).set(h.bearer(owner)).expect(200)).body.items[0];
    const detail = (await api().get(`${P}/manage/billing/invoices/${inv.id}`).set(h.bearer(owner)).expect(200)).body;
    conforms(s.Invoice, detail);
    const price = detail.lines.find((l) => l.kind === 'tier').amountPoisha;
    const credit = Math.round((price * 10) / days.length);
    expect(detail.lines.map((l) => [l.kind, l.amountPoisha])).toEqual([
      ['tier', price],
      ['suspension_pause', -credit],
    ]);
    expect(detail.lines[1].descriptionEn).toBe(`Paused while suspended: 10 of ${days.length} days`);
    expect(detail.totalPoisha).toBe(price - credit);

    // Dunning holds while every gym is suspended (M24-FR-173): overdue, but the plan stays active.
    const issueDay = rules.dhakaDate(cycleAt);
    const atDay = (n) => new Date(rules.instantOf(rules.addDays(issueDay, n)).getTime() + 10 * HOUR);
    await jobs.invoiceDunning(atDay(30));
    expect((await models.GymSubscriptionInvoice.findByPk(inv.id)).status).toBe('overdue');
    expect((await models.GymOwnerSubscription.findOne({ where: { ownerId: owner.user.id } })).status).toBe('active');
    // Restored: dunning goes on as before.
    await restore(gym.id);
    await jobs.invoiceDunning(atDay(31));
    expect((await models.GymOwnerSubscription.findOne({ where: { ownerId: owner.user.id } })).status).toBe('restricted');

    // A whole month frozen bills nothing: no invoice is issued.
    const other = await gm.privateGym({ tier: 'standard', name: 'Frozen Gym', shortCode: 'FZ' });
    await suspend(other.gym.id);
    await models.GymActiveMemberCount.bulkCreate(days.map((d) => ({ ownerId: other.owner.user.id, localDate: d, activeCount: 120, gymsCount: 1, chosenTier: 'standard', frozen: true })));
    await models.GymOwnerSubscription.update({ startedOn: rules.addMonths(month, -3) }, { where: { ownerId: other.owner.user.id } });
    await jobs.invoiceCycle(cycleAt);
    expect(await models.GymSubscriptionInvoice.count({ where: { ownerId: other.owner.user.id } })).toBe(0);
  });

  it('trainers show their account photo: list, member, plan author, class, and the member’s own trainer', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'pro' });
    const coach = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Coach Tania' }), ['members.view', 'members.trainer', 'plans.manage']);
    await models.User.update({ avatarKey: 'avatars/coach-tania.webp' }, { where: { id: coach.user.id } });
    const who = await h.signupUser({ name: 'Rafiq Hasan' });
    const added = await gm.addMember(owner, gym.id, { displayName: 'Rafiq Hasan', phone: who.phone, membership: { packageId: pkg('month').id, startsOn: gm.today() } });
    await gm.linkMember(owner, gym.id, added.member.id, who);
    const g = gm.manage(owner, gym.id);

    const trainers = (await g.get('/trainers').expect(200)).body;
    conforms(s.Trainers, trainers);
    const t = trainers.items[0];
    expect(t).toMatchObject({ displayName: 'Coach Tania' });
    expect(t.avatarUrl).toMatch(/coach-tania\.webp$/);

    await g.put(`/members/${added.member.id}/trainer`, { businessMemberId: t.businessMemberId }).expect(200);
    const member = (await g.get(`/members/${added.member.id}`).expect(200)).body;
    expect(member.member?.trainer ?? member.trainer).toMatchObject({ displayName: 'Coach Tania', avatarUrl: expect.stringMatching(/coach-tania\.webp$/) });

    // The member sees the trainer the gym assigned, with the photo.
    const mine = (await api().get(`${P}/me/gym-memberships/${added.member.id}`).set(h.bearer(who)).expect(200)).body;
    conforms(s.MyMembership, mine);
    expect(mine.trainer).toEqual({ displayName: 'Coach Tania', avatarUrl: expect.stringMatching(/coach-tania\.webp$/) });

    // A trainer with no photo: null, and the member of a gym with no trainer sees none.
    await models.User.update({ avatarKey: null }, { where: { id: coach.user.id } });
    expect((await g.get('/trainers').expect(200)).body.items[0].avatarUrl).toBeNull();
    await g.put(`/members/${added.member.id}/trainer`, { businessMemberId: null }).expect(200);
    expect((await api().get(`${P}/me/gym-memberships/${added.member.id}`).set(h.bearer(who)).expect(200)).body.trainer).toBeNull();
  });
});
