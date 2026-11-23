'use strict';

// M24 prompt 3b, the SMS add-on (M24-FR-96 to FR-100, §6.7), end to end on the memory SMS driver: off by
// default (a gym never sends an SMS, M24-FR-57); with the platform switch on in this test: the add-on on a
// paid plan and its allowance, the kinds chosen for SMS, a held SMS for a receipt to a phone-only member and
// to a linked one, a payment link by SMS with the short link, the member who turned gym SMS off, parallel
// holds that never overdraw, the low and empty notices, bundles paid at once (and voided unpaid), the
// monthly allowance job, stale holds, the add-on line on the monthly invoice and the master's adjustment.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const gm = require('../fixtures/gym-manage');
const sms = require('../../src/modules/gym-manage/sms.service');
const invoices = require('../../src/modules/gym-manage/invoices.service');
const config = require('../../src/config');

const { api, P, models } = h;
const ON = {
  'gym_saas.sms_addon_enabled': true,
  'gym_saas.sms_addon_price_poisha': 20000,
  'gym_saas.sms_addon_included': 10,
  'gym_saas.sms_bundle_size': 100,
  'gym_saas.sms_bundle_price_poisha': 50000,
};

let master;
beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  h.sms.clear();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const switchOn = async (over = {}) => {
  for (const [k, v] of Object.entries({ ...ON, ...over })) await h.setSettingForTest(k, v);
};
const billing = (who) => ({
  get: (p = '') => api().get(`${P}/manage/billing${p}`).set(h.bearer(who)),
  put: (p, body) => api().put(`${P}/manage/billing${p}`).set(h.bearer(who)).send(body),
  post: (p, body) => api().post(`${P}/manage/billing${p}`).set(h.bearer(who)).set('Idempotency-Key', gm.key('sms')).send(body),
});
const entries = (ownerId) => models.GymSmsEntry.findAll({ where: { ownerId }, order: [['createdAt', 'ASC'], ['id', 'ASC']] }).then((rows) => rows.map((e) => [e.kind, e.units]));
const pay = (g, dueId, amountPoisha = 100000) => g.post(`/dues/${dueId}/payments`, { amountPoisha, method: 'cash' }, true).expect(201);

describe('M24 SMS add-on', () => {
  it('is off by default: nothing to switch on, no SMS kinds, and a gym sends no SMS (M24-FR-57)', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'basic' });
    const view = (await billing(owner).get().expect(200)).body.smsAddon;
    expect(view).toMatchObject({ available: false, enabled: false, status: null, balance: 0 });
    expect((await billing(owner).put('/sms-addon', { enabled: true }).expect(409)).body.code).toBe('GYM_SMS_ADDON_UNAVAILABLE');
    expect((await gm.manage(owner, gym.id).patch('/settings', { smsKinds: ['receipt'] }).expect(409)).body.code).toBe('GYM_SMS_ADDON_OFF');
    const m = await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.today() } });
    await pay(gm.manage(owner, gym.id), m.due.id);
    await h.drainEvents();
    expect(await models.SmsLog.count({ where: { route: 'trans' } })).toBe(0);
    expect(await models.NotificationDelivery.count({ where: { channel: 'sms' } })).toBe(0);
    expect(await models.GymSmsEntry.count()).toBe(0);
  });

  it('switching on, the allowance, a held SMS for receipts and pay links, settling, opting out', async () => {
    await switchOn();
    const free = await gm.privateGym({ name: 'Free Gym', shortCode: 'FG' });
    expect((await billing(free.owner).put('/sms-addon', { enabled: true }).expect(409)).body.code).toBe('GYM_SMS_ADDON_UNAVAILABLE');

    const { owner, gym, pkg } = await gm.privateGym({ tier: 'basic' });
    const g = gm.manage(owner, gym.id);
    const on = (await billing(owner).put('/sms-addon', { enabled: true }).expect(200)).body;
    expect(on).toMatchObject({ available: true, status: 'active', balance: 10, allowanceLeft: 10, pricePoisha: 20000, included: 10, bundle: { size: 100, pricePoisha: 50000 } });
    // Twice in the month: no second allowance.
    await billing(owner).put('/sms-addon', { enabled: true }).expect(200);
    expect(await entries(owner.user.id)).toEqual([['grant', 10]]);
    expect(await models.AuditLog.count({ where: { action: 'gym_sms_addon.started' } })).toBe(1);

    // The kinds that go by SMS (FR-97).
    await g.patch('/settings', { smsKinds: ['receipt'] }).expect(200);
    const page = (await g.get('/reminders').expect(200)).body;
    expect(page.sms).toMatchObject({ available: true, active: true, balance: 10, kinds: ['receipt'] });

    // A receipt to a phone-only member (unlinked, no email): reachable by SMS now (FR-99).
    const phoneOnly = h.nextPhone();
    const a = await gm.addMember(owner, gym.id, { displayName: 'Phone Only', phone: phoneOnly, membership: { packageId: pkg('month').id, startsOn: gm.today() } });
    await pay(g, a.due.id);
    expect(await entries(owner.user.id)).toEqual([['grant', 10], ['reserve', -2]]);
    await h.drainEvents();
    const text = h.sms.lastTo(h.e164(phoneOnly))?.text;
    expect(text).toMatch(/received/);
    expect(text).toContain(gym.name.slice(0, 20));
    const ext = await models.NotificationExternalDelivery.findOne({ where: { code: 'GYM_FEE_RECEIPT', channel: 'sms' } });
    expect(ext).toMatchObject({ status: 'delivered' });
    expect(ext.billingRef).toBeTruthy();
    // The taka sign makes it a Unicode SMS: two segments, exactly what was held (a settle of 0 closes the hold).
    expect(await entries(owner.user.id)).toEqual([['grant', 10], ['reserve', -2], ['settle', 0]]);
    expect(await sms.balanceOf(owner.user.id)).toBe(8);
    const log = await models.GymReminder.findOne({ where: { kind: 'receipt', memberId: a.member.id } });
    expect(log).toMatchObject({ status: 'published', channels: ['sms'] });
    expect(log.smsBillingRef).toBe(ext.billingRef);

    // A linked member: the SMS goes to the account's phone, with in-app as usual.
    const ana = await h.signupUser({ name: 'Ana Linked' });
    const b = await gm.addMember(owner, gym.id, { displayName: 'Ana Linked', phone: ana.phone, membership: { packageId: pkg('month').id, startsOn: gm.today() } });
    await gm.linkMember(owner, gym.id, b.member.id, ana);
    await pay(g, b.due.id);
    await h.drainEvents();
    expect(h.sms.lastTo(h.e164(ana.phone))?.text).toMatch(/received/);
    expect(await models.NotificationDelivery.count({ where: { userId: ana.user.id, channel: 'sms', status: 'delivered' } })).toBe(1);
    expect(await sms.balanceOf(owner.user.id)).toBe(6);

    // The member turned SMS off for gym notices: no SMS, the hold comes back at once (not_sent).
    await api().put(`${P}/me/notification-prefs`).set(h.bearer(ana)).send({ prefs: [{ category: 'gym', channel: 'sms', enabled: false }] }).expect(200);
    await g.post(`/dues/${b.due.id}/payments`, { amountPoisha: 1000, method: 'cash' }, true).expect(201);
    h.sms.clear();
    await h.drainEvents();
    expect(h.sms.lastTo(h.e164(ana.phone))).toBeUndefined();
    expect(await sms.balanceOf(owner.user.id)).toBe(6);
    expect(await models.OutboxEvent.count({ where: { name: 'notification.sms_settled' } })).toBe(3);

    // A payment link by SMS (chosen for this one message): the short link works on the pay page.
    await gm.listOwner(owner); // online fees need the owner's gym_owner role (M24-FR-02)
    const linkPhone = h.nextPhone();
    const c = await gm.addMember(owner, gym.id, { displayName: 'Link By Sms', phone: linkPhone, membership: { packageId: pkg('month').id, startsOn: gm.today() } });
    const before = await sms.balanceOf(owner.user.id);
    const link = (await g.post(`/dues/${c.due.id}/payment-links`, { channels: ['sms'] }, true).expect(201)).body;
    await h.drainEvents();
    const linkText = h.sms.lastTo(h.e164(linkPhone))?.text ?? '';
    const shortLink = /\/p\/([0-9A-HJKMNP-TV-Z]{10})/.exec(linkText);
    expect(linkText).toContain(`${config.apps.gym}/p/`);
    expect(shortLink).toBeTruthy();
    expect((await api().get(`${P}/gym-pay/${shortLink[1]}`).expect(200)).body.link).toMatchObject({ id: link.id, amountPoisha: link.amountPoisha });
    await api().get(`${P}/gym-pay/ABCDEFGHJK`).expect(404);
    expect(await sms.balanceOf(owner.user.id)).toBeLessThan(before);

    // The add-on off: no more holds; the kinds can no longer be chosen.
    await billing(owner).put('/sms-addon', { enabled: false }).expect(200);
    const d = await gm.addMember(owner, gym.id, { displayName: 'After Off', membership: { packageId: pkg('month').id, startsOn: gm.today() } });
    const count = await models.GymSmsEntry.count();
    await pay(g, d.due.id);
    expect(await models.GymSmsEntry.count()).toBe(count);
    expect((await g.patch('/settings', { smsKinds: ['receipt', 'overdue'] }).expect(409)).body.code).toBe('GYM_SMS_ADDON_OFF');
  });

  it('parallel holds never overdraw; low and empty notices once per crossing (FR-99, FR-100)', async () => {
    await switchOn({ 'gym_saas.sms_addon_included': 3, 'gym_saas.sms_low_balance': 2 });
    const { owner, gym } = await gm.privateGym({ tier: 'basic' });
    await billing(owner).put('/sms-addon', { enabled: true }).expect(200);
    await gm.manage(owner, gym.id).patch('/settings', { smsKinds: ['receipt'] }).expect(200);
    const try1 = () =>
      models.sequelize.transaction(async (t) => {
        const plan = await sms.planIn(t, { ownerId: owner.user.id, gymId: gym.id, kind: 'receipt' });
        return plan.ok ? sms.reserveIn(t, { ownerId: owner.user.id, gymId: gym.id, balance: plan.balance }) : plan.reason;
      });
    const results = await Promise.all([try1(), try1(), try1()]);
    expect(results.filter((r) => r === 'balance')).toHaveLength(2);
    expect(await sms.balanceOf(owner.user.id)).toBe(1);
    // 3 → 1 crosses below one hold: depleted, once.
    expect(await models.OutboxEvent.count({ where: { name: 'gym_sms.depleted' } })).toBe(1);
    await h.drainEvents();
    expect(await models.Notification.count({ where: { userId: owner.user.id, code: 'GYM_SMS_DEPLETED' } })).toBe(1);
    // Settled as failed: the units come back; a second settle of the same hold does nothing.
    const ref = (await models.GymSmsEntry.findOne({ where: { kind: 'reserve' } })).billingRef;
    await models.sequelize.transaction((t) => sms.settle({ billingRef: ref, status: 'failed' }, { transaction: t }));
    await models.sequelize.transaction((t) => sms.settle({ billingRef: ref, status: 'failed' }, { transaction: t }));
    expect(await sms.balanceOf(owner.user.id)).toBe(3);
  });

  it('bundles paid at once, never dunned and voided unpaid; the allowance job; stale holds; the invoice line; the master adjusts (FR-96, FR-98)', async () => {
    await switchOn();
    const { owner, gym } = await gm.privateGym({ tier: 'basic' });
    expect((await billing(owner).post('/sms-bundles', { bundles: 1 }).expect(409)).body.code).toBe('GYM_SMS_ADDON_OFF');
    await billing(owner).put('/sms-addon', { enabled: true }).expect(200);

    // Buy two bundles: an invoice of kind sms_bundle; the units arrive with the payment.
    const bought = (await billing(owner).post('/sms-bundles', { bundles: 2 }).expect(201)).body;
    expect(bought).toMatchObject({ units: 200, invoice: { kind: 'sms_bundle', totalPoisha: 100000, status: 'issued' } });
    expect(await sms.balanceOf(owner.user.id)).toBe(10);
    await h.payWithSimulator(owner, bought.payment.id);
    await h.drainEvents();
    expect(await sms.balanceOf(owner.user.id)).toBe(210);
    expect((await models.GymSubscriptionInvoice.findByPk(bought.invoice.id)).status).toBe('paid');
    expect(await models.OutboxEvent.count({ where: { name: 'gym_sms.purchased' } })).toBe(1);

    // An unpaid bundle invoice is never dunned (the subscription stays active) and is voided after its days.
    const unpaid = (await billing(owner).post('/sms-bundles', { bundles: 1 }).expect(201)).body.invoice;
    const later = new Date(Date.now() + 8 * 86400000);
    await invoices.dunning(later);
    expect((await models.GymOwnerSubscription.findOne({ where: { ownerId: owner.user.id } })).status).toBe('active');
    expect((await models.GymSubscriptionInvoice.findByPk(unpaid.id)).status).toBe('issued');
    expect((await sms.daily(later)).invoicesVoided).toBe(1);
    expect((await models.GymSubscriptionInvoice.findByPk(unpaid.id)).status).toBe('void');

    // A hold left open for a day is settled as failed.
    await models.sequelize.transaction(async (t) => {
      const plan = await sms.planIn(t, { ownerId: owner.user.id, gymId: gym.id, kind: 'receipt', explicit: true });
      await sms.reserveIn(t, { ownerId: owner.user.id, gymId: gym.id, balance: plan.balance });
    });
    expect(await sms.balanceOf(owner.user.id)).toBe(208);
    expect((await sms.daily(new Date(Date.now() + 2 * 86400000))).holdsClosed).toBe(1);
    expect(await sms.balanceOf(owner.user.id)).toBe(210);

    // The 1st: this month's allowance left (10, used first: nothing used) expires; the new month is granted.
    // The 1st of next month (40 days ahead skipped a month after the 21st).
    const first = new Date(`${require('../../src/modules/gym-manage/gym-manage.rules').addMonths(gm.today().slice(0, 7) + '-01', 1)}T00:30:00+06:00`);
    const run = await sms.allowance(first);
    expect(run).toEqual({ expired: 10, granted: 10 });
    expect(await sms.allowance(first)).toEqual({ expired: 0, granted: 0 });
    expect(await sms.balanceOf(owner.user.id)).toBe(210);

    // The monthly invoice bills the add-on (active this month).
    await invoices.cycle(first);
    const inv = await models.GymSubscriptionInvoice.findOne({ where: { ownerId: owner.user.id, kind: 'monthly' } });
    const lines = await models.GymSubscriptionInvoiceLine.findAll({ where: { invoiceId: inv.id } });
    expect(lines.find((l) => l.kind === 'sms_addon')).toMatchObject({ amountPoisha: 20000 });

    // The master adjusts (step-up); never below 0.
    const adj = (u, token) => api().post(`${P}/admin/gym-manage/owners/${owner.user.id}/sms-adjust`).set(h.bearer(master)).set('X-Step-Up', token ?? '').send({ units: u, note: 'Goodwill for a gateway outage' });
    await adj(25).expect(403);
    expect((await adj(-1000, await h.stepUp(master, 'settings.write')).expect(409)).body.code).toBe('GYM_SMS_BALANCE_SHORT');
    expect((await adj(25, await h.stepUp(master, 'settings.write')).expect(200)).body.balance).toBe(235);
    expect(await models.AuditLog.count({ where: { action: 'gym_sms.adjusted' } })).toBe(1);
    // The billing card and the entries.
    const card = (await billing(owner).get('/sms-entries').expect(200)).body;
    expect(card.balance).toBe(await sms.balanceOf(owner.user.id));
    expect(card.items.map((e) => e.kind)).toContain('purchase');
  });
});
