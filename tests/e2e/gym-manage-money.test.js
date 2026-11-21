'use strict';

// M24 prompt 2 (online money, reminders and billing) end to end: payment links and online fees with no
// margin (M24-FR-40 to FR-46, the §6.3 worked example), the provider charge on the payout line, owner
// refunds from the hold and the window (FR-44), a cash payment landing first (FR-42), reminders sent once
// across a fake-clock week (FR-55 to FR-61), the morning summary and monthly report, reports and exports
// (FR-70 to FR-74), the owner's invoice with the §6.6 worked example and dunning to restricted and back
// (FR-81 to FR-89), referrals and fee overrides changing a referral and a pass commission (FR-91 to
// FR-95), the admin desk, the staff matrix of the new routes and the privacy scans (FR-106 to FR-108).
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const f = require('../fixtures/market');
const g = require('../fixtures/gym');
const gm = require('../fixtures/gym-manage');
const rules = require('../../src/modules/gym-manage/gym-manage.rules');
const jobs = require('../../src/modules/gym-manage/gym-manage.jobs');
const s = require('../../src/modules/gym-manage/gym-manage.schemas');
const ledger = require('../../src/modules/payments/ledger.service');
const invariants = require('../../src/modules/payments/invariants.service');
const payouts = require('../../src/modules/payouts/payouts.service');
const config = require('../../src/config');

const { api, P, models } = h;
jest.setTimeout(240000);

let master;
beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const conforms = (schema, body) => expect(schema.safeParse(body).error?.issues ?? []).toEqual([]);
const PHONE = /(\+?880|\b0)1[3-9]\d{8}/;
const HOUR = 3600000;
const DAY = 86400000;
const codesOf = async (userId) => (await models.Notification.findAll({ where: { userId }, order: [['createdAt', 'ASC']] })).map((n) => n.code);
const countOf = (userId, code) => models.Notification.count({ where: { userId, code } });

/** A Basic gym whose owner may take fees online, a member (phone of `payer` when given) with a monthly membership and an unpaid due. */
async function onlineGym({ tier = 'basic', memberPhone = null, email = null } = {}) {
  const { owner, gym, pkg } = await gm.privateGym({ tier });
  await gm.listOwner(owner);
  const added = await gm.addMember(owner, gym.id, { displayName: 'Rafiq Hasan', phone: memberPhone ?? h.nextPhone(), ...(email ? { email } : {}), membership: { packageId: pkg('month').id, startsOn: gm.today() } });
  return { owner, gym, pkg, member: added.member, due: added.due, g: gm.manage(owner, gym.id) };
}

const link = (who, gymId, dueId, body = {}, status = 201) => gm.manage(who, gymId).post(`/dues/${dueId}/payment-links`, body, true).expect(status);
const payLink = (who, token, body = {}, status = 201) => api().post(`${P}/gym-pay/${token}/pay`).set(h.bearer(who)).set('Idempotency-Key', gm.key('lp')).send(body).expect(status);
const tokenOf = (url) => url.split('/p/')[1];

describe('online fee payments, no margin (M24-FR-40 to FR-46)', () => {
  it('the §6.3 worked example: link → pay by bKash → receipt → release with the ৳30 charge → payout line ৳1,470', async () => {
    const payer = await h.signupUser({ name: 'Rafiq Hasan' });
    const { owner, gym, due, member, g: desk, pkg } = await (async () => {
      const { owner: o, gym: gy, pkg: p } = await gm.privateGym({ tier: null });
      const added = await gm.addMember(o, gy.id, { displayName: 'Rafiq Hasan', phone: payer.phone, membership: { packageId: p('month').id, startsOn: gm.today() } });
      return { owner: o, gym: gy, pkg: p, due: added.due, member: added.member, g: gm.manage(o, gy.id) };
    })();
    void pkg;
    // M24-FR-02: a private owner (no documents) → role; then the plan (Free) → tier.
    expect((await link(owner, gym.id, due.id, {}, 403)).body).toMatchObject({ code: 'GYM_ONLINE_FEES_UNAVAILABLE', reason: 'role' });
    await gm.listOwner(owner);
    expect((await link(owner, gym.id, due.id, {}, 403)).body).toMatchObject({ code: 'GYM_ONLINE_FEES_UNAVAILABLE', reason: 'tier' });
    await api().put(`${P}/manage/billing/tier`).set(h.bearer(owner)).send({ tier: 'basic' }).expect(200);
    expect((await link(owner, gym.id, due.id, { amountPoisha: 999999 }, 422)).body.code).toBe('GYM_PAYMENT_EXCEEDS_DUE');

    const l = (await link(owner, gym.id, due.id, { amountPoisha: 150000, channels: ['in_app', 'email'] })).body;
    conforms(s.PaymentLink, l);
    expect(l).toMatchObject({ amountPoisha: 150000, status: 'open', origin: 'staff', channels: ['in_app', 'email'] });
    expect(l.url).toMatch(new RegExp(`^${config.apps.gym}/p/v1\\.`));
    expect(l.qr).toBe(l.url);
    expect((await link(owner, gym.id, due.id, {}, 409)).body).toMatchObject({ code: 'GYM_PAY_LINK_OPEN', linkId: l.id });
    expect((await desk.get(`/payment-links?dueId=${due.id}`).expect(200)).body.items.map((x) => x.id)).toEqual([l.id]);
    await h.drainEvents();
    expect(await models.GymReminder.count({ where: { kind: 'pay_link', subjectId: l.id } })).toBe(1);

    // The public page: gym, package, amount, member code and first name; the viewer may link.
    const token = tokenOf(l.url);
    const pub = await api().get(`${P}/gym-pay/${token}`).expect(200);
    expect(pub.headers['x-robots-tag']).toBe('noindex');
    conforms(s.PayLinkSummary, pub.body);
    expect(pub.body).toMatchObject({ link: { status: 'open', amountPoisha: 150000 }, gym: { id: gym.id }, member: { memberCode: member.memberCode, firstName: 'Rafiq' }, membership: { title: 'Monthly' }, onlineFees: true, viewer: null });
    expect(JSON.stringify(pub.body)).not.toMatch(PHONE);
    expect((await api().get(`${P}/gym-pay/${token}`).set(h.bearer(payer)).expect(200)).body.viewer).toEqual({ phoneMatches: true, linked: false, canLink: true });
    await api().get(`${P}/gym-pay/${token.slice(0, -2)}xx`).expect(404);

    // M24-FR-41: pay and link; M24-FR-104: the pay page and its result on the gym app.
    const start = (await payLink(payer, token, { linkAccount: true })).body;
    conforms(s.PayStart, start);
    expect(start).toMatchObject({ amountPoisha: 150000, willLink: true, payUrl: `${config.apps.gym}/pay/${start.paymentId}` });
    const { returnTo } = await h.payWithSimulator(payer, start.paymentId, { method: 'bkash' });
    expect(returnTo).toBe(`${config.apps.gym}/pay/${start.paymentId}/result`);
    await h.drainEvents();

    // M24-FR-42, FR-43: the fee payment row, the provider charge snapshot, the link paid, the member linked.
    const fee = await models.GymFeePayment.findOne({ where: { paymentId: start.paymentId } });
    expect(fee).toMatchObject({ method: 'online', amountPoisha: 150000, providerChargeBps: 200, providerChargePoisha: 3000, payerUserId: payer.user.id, linkId: l.id, receivedBy: null });
    expect(fee.receiptNo).toMatch(/^IY-R\d{2}-\d{6}$/);
    const paidLink = await models.GymPaymentLink.findByPk(l.id);
    expect(paidLink).toMatchObject({ status: 'paid', paymentId: start.paymentId });
    expect(new Date(paidLink.releaseAt) - new Date(paidLink.paidAt)).toBe(72 * HOUR);
    expect((await models.GymMember.findByPk(member.id)).userId).toBe(payer.user.id);
    expect((await models.GymDue.findByPk(due.id)).paidPoisha).toBe(150000);
    expect((await api().get(`${P}/gym-pay/${token}`).expect(200)).body).toMatchObject({ link: { status: 'paid' }, receipt: { receiptNo: fee.receiptNo } });
    expect((await payLink(payer, token, {}, 409)).body.code).toBe('GYM_DUE_STATE');

    // Notices: the owner hears of the online fee; the payer (now linked) gets the receipt.
    expect(await codesOf(owner.user.id)).toContain('GYM_ONLINE_FEE_PAID');
    expect(await codesOf(payer.user.id)).toEqual(expect.arrayContaining(['GYM_FEE_RECEIPT']));

    // The owner sees the charge; staff never do; the member never does (FR-43, §3.3).
    const ownerDues = (await desk.get(`/members/${member.id}`).expect(200)).body.dues[0];
    expect(ownerDues.payments[0].providerCharge).toEqual({ bps: 200, poisha: 3000, netPoisha: 147000 });
    const cashier = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Cashier' }), ['members.view', 'fees.collect']);
    const staffDues = (await gm.manage(cashier, gym.id).get(`/members/${member.id}`).expect(200)).body.dues[0];
    expect(staffDues.payments[0].providerCharge).toBeUndefined();
    const mine = (await api().get(`${P}/me/gym-memberships/${member.id}`).set(h.bearer(payer)).expect(200)).body;
    expect(mine.dues[0].payments[0].providerCharge).toBeNull();

    // M24-FR-45: captured into escrow; nothing to fee_revenue.
    expect(await ledger.balance('escrow:gym_membership_fee')).toBe(150000);
    expect(await ledger.balance('fee_revenue:gym_fee')).toBe(0);

    // M24-FR-44: release after 72 hours, with the provider charge recovered at cost.
    expect(await jobs.onlineFeeRelease(new Date(Date.now() + 71 * HOUR))).toEqual({ due: 0, released: 0 });
    expect(await jobs.onlineFeeRelease(new Date(Date.now() + 73 * HOUR))).toEqual({ due: 1, released: 1 });
    expect(await jobs.onlineFeeRelease(new Date(Date.now() + 74 * HOUR))).toEqual({ due: 0, released: 0 });
    expect(await ledger.balance('escrow:gym_membership_fee')).toBe(0);
    expect(await ledger.balance(`payable:user:${owner.user.id}`)).toBe(147000);
    expect(await ledger.balance('provider_fee_expense')).toBe(3000);
    expect(await ledger.balance('fee_revenue:gym_fee')).toBe(0);
    expect((await models.GymPaymentLink.findByPk(l.id)).releasedAt).not.toBeNull();
    expect((await desk.post(`/fee-payments/${fee.id}/refund`, { amountPoisha: 100, reason: 'Mistake' }, true).expect(409)).body.code).toBe('GYM_REFUND_WINDOW_CLOSED');
    expect((await invariants.check({ publish: false })).ok).toBe(true);

    // M24-FR-46: the weekly payout line shows gross ৳1,500, provider charge ৳30, net ৳1,470.
    const batch = await payouts.buildBatch({ schedule: 'ground_weekly', windowEnd: new Date(Date.now() + DAY) });
    void batch;
    const payout = await models.Payout.findOne({ where: { payeeId: owner.user.id } });
    const items = await models.PayoutItem.findAll({ where: { payoutId: payout.id } });
    expect(items.map((i) => [i.grossPoisha, i.feePoisha, i.providerChargePoisha, i.netPoisha])).toEqual([[150000, 0, 3000, 147000]]);
    expect(payout.amountPoisha).toBe(147000);
    const csv = await api().get(`${P}/me/payouts/${payout.id}/statement.csv`).set(h.bearer(owner)).expect(200);
    expect(csv.text).toContain('Provider charge');
    expect(csv.text).toContain('"30.00"');
  });

  it('M24-FR-42: cash recorded while the member is on the pay page → the online payment is refunded in full', async () => {
    const { owner, gym, due, g: desk } = await onlineGym();
    const payer = await h.signupUser();
    const l = (await link(owner, gym.id, due.id)).body;
    const start = (await payLink(payer, tokenOf(l.url))).body;
    await desk.post(`/dues/${due.id}/payments`, { amountPoisha: 100000, method: 'cash' }, true).expect(201);
    expect((await models.GymPaymentLink.findByPk(l.id)).status).toBe('cancelled');
    await h.payWithSimulator(payer, start.paymentId);
    await h.drainPaymentJobs();
    await h.drainEvents();
    expect(await models.GymFeePayment.count({ where: { paymentId: start.paymentId } })).toBe(0);
    expect((await models.Payment.findByPk(start.paymentId)).status).toBe('refunded');
    expect((await models.GymDue.findByPk(due.id)).paidPoisha).toBe(100000);
    expect(await ledger.balance('escrow:gym_membership_fee')).toBe(0);
    expect((await invariants.check({ publish: false })).ok).toBe(true);
    // A cancelled link is gone for the payer.
    expect((await payLink(payer, tokenOf(l.url), {}, 410)).body.code).toBe('GYM_PAY_LINK_EXPIRED');
  });

  it('M24-FR-44: the owner refunds from the hold before release (once), the reversal row follows; after release → 409', async () => {
    const { owner, gym, due, member, g: desk } = await onlineGym();
    const payer = await h.signupUser();
    const l = (await link(owner, gym.id, due.id, { amountPoisha: 150000 })).body;
    const start = (await payLink(payer, tokenOf(l.url), { linkAccount: true })).body;
    expect(start.willLink).toBe(false); // a different phone pays: paid, not linked (FR-41)
    await h.payWithSimulator(payer, start.paymentId, { method: 'nagad' });
    await h.drainEvents();
    expect((await models.GymMember.findByPk(member.id)).userId).toBeNull();
    const fee = await models.GymFeePayment.findOne({ where: { paymentId: start.paymentId } });

    // Staff never refund (owner only, §3.3).
    const cashier = await gm.hire(owner, gym.id, await h.signupUser(), ['members.view', 'fees.collect', 'fees.adjust']);
    expect((await gm.manage(cashier, gym.id).post(`/fee-payments/${fee.id}/refund`, { amountPoisha: 100, reason: 'x x' }, true).expect(403)).body).toMatchObject({ code: 'PERMISSION_REQUIRED', permission: 'owner.only' });
    // Online payments are refunded, not reversed (FR-35).
    expect((await desk.post(`/fee-payments/${fee.id}/reverse`, { reason: 'Mistake' }, true).expect(409)).body.code).toBe('GYM_PAYMENT_NOT_REVERSIBLE');
    expect((await desk.post(`/fee-payments/${fee.id}/refund`, { amountPoisha: 150001, reason: 'Too much' }, true).expect(422)).body.code).toBe('GYM_REFUND_EXCEEDS_PAID');

    // At "71 hours": still in the window.
    await models.GymPaymentLink.update({ releaseAt: new Date(Date.now() + HOUR) }, { where: { id: l.id } });
    const r = (await desk.post(`/fee-payments/${fee.id}/refund`, { amountPoisha: 50000, reason: 'Paid twice by mistake' }, true).expect(201)).body;
    conforms(s.RefundResult, r);
    expect(r).toMatchObject({ refund: { amountPoisha: 50000 }, link: { refundedPoisha: 50000 } });
    expect((await desk.post(`/fee-payments/${fee.id}/refund`, { amountPoisha: 100, reason: 'Again' }, true).expect(409)).body.code).toBe('GYM_PAYMENT_NOT_REVERSIBLE');
    await h.drainPaymentJobs();
    await h.drainEvents();
    const reversal = await models.GymFeePayment.findOne({ where: { reversesId: fee.id } });
    expect(reversal).toMatchObject({ amountPoisha: -50000, method: 'online', paymentId: start.paymentId });
    expect((await models.GymDue.findByPk(due.id)).paidPoisha).toBe(100000);
    expect(await models.AuditLog.count({ where: { action: 'gym_fee.refunded' } })).toBe(1);

    // The release takes what is left, less the charge snapshotted on the full amount (200 bps of ৳1,500).
    expect(await jobs.onlineFeeRelease(new Date(Date.now() + 2 * HOUR))).toEqual({ due: 1, released: 1 });
    expect(await ledger.balance(`payable:user:${owner.user.id}`)).toBe(100000 - 3000);
    expect(await ledger.balance('provider_fee_expense')).toBe(3000);
    expect((await invariants.check({ publish: false })).ok).toBe(true);
  });

  it('pass-through off (a master decision): the owner receives the full amount and Kriraghor bears the charge', async () => {
    await h.setSettingForTest('gym_manage.online_fee_provider_passthrough', false);
    const { owner, gym, due } = await onlineGym();
    const payer = await h.signupUser();
    const l = (await link(owner, gym.id, due.id, { amountPoisha: 150000 })).body;
    const start = (await payLink(payer, tokenOf(l.url))).body;
    await h.payWithSimulator(payer, start.paymentId, { method: 'card' });
    expect(await models.GymFeePayment.findOne({ where: { paymentId: start.paymentId } })).toMatchObject({ providerChargeBps: 0, providerChargePoisha: 0 });
    await jobs.onlineFeeRelease(new Date(Date.now() + 73 * HOUR));
    expect(await ledger.balance(`payable:user:${owner.user.id}`)).toBe(150000);
    expect(await ledger.balance('provider_fee_expense')).toBe(0);
  });

  it('/me/gym-dues and paying one reuses the open link; links expire (§8.5)', async () => {
    const payer = await h.signupUser({ name: 'Rafiq Hasan' });
    const { owner, gym, member, due } = await onlineGym({ memberPhone: payer.phone });
    await gm.linkMember(owner, gym.id, member.id, payer);
    const dues = (await api().get(`${P}/me/gym-dues`).set(h.bearer(payer)).expect(200)).body;
    conforms(s.MyDues, dues);
    expect(dues.items).toHaveLength(1);
    expect(dues.items[0]).toMatchObject({ dueId: due.id, outstandingPoisha: 350000, onlineFees: true, onlineFeesReason: null, openLink: null });
    expect((await api().get(`${P}/me/gym-memberships`).set(h.bearer(payer)).expect(200)).body.items[0].onlineFees).toBe(true);
    const a = (await api().post(`${P}/me/gym-dues/${due.id}/pay`).set(h.bearer(payer)).set('Idempotency-Key', gm.key('md')).expect(201)).body;
    expect(a).toMatchObject({ amountPoisha: 350000, payUrl: `${config.apps.gym}/pay/${a.paymentId}` });
    const open = await models.GymPaymentLink.findAll({ where: { dueId: due.id } });
    expect(open.map((x) => [x.origin, x.status, x.channels])).toEqual([['member', 'open', []]]);
    // A second click reuses the link (another payment intent on the same link).
    await api().post(`${P}/me/gym-dues/${due.id}/pay`).set(h.bearer(payer)).set('Idempotency-Key', gm.key('md')).expect(201);
    expect(await models.GymPaymentLink.count({ where: { dueId: due.id } })).toBe(1);
    // Someone else's due is not mine.
    const other = await h.signupUser();
    await api().post(`${P}/me/gym-dues/${due.id}/pay`).set(h.bearer(other)).set('Idempotency-Key', gm.key('md')).expect(404);
    // links-expire.
    expect(await jobs.linksExpire(new Date(Date.now() + 73 * HOUR))).toEqual({ expired: 1 });
    expect((await models.GymPaymentLink.findOne({ where: { dueId: due.id } })).status).toBe('expired');
    // A cancelled staff link → 410.
    const l = (await link(owner, gym.id, due.id)).body;
    await gm.manage(owner, gym.id).post(`/payment-links/${l.id}/cancel`).expect(200);
    expect((await payLink(payer, tokenOf(l.url), {}, 410)).body.code).toBe('GYM_PAY_LINK_EXPIRED');
    expect(await models.AuditLog.count({ where: { action: ['gym_payment_link.created', 'gym_payment_link.cancelled'] } })).toBe(2);
  });
});

describe('reminders and notices (M24-FR-55 to FR-61)', () => {
  it('a fake-clock week: each reminder once (jobs run twice a day), the switch-off, the unlinked member by email, the log', async () => {
    const linked = await h.signupUser({ name: 'Linked Member' });
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'basic' });
    const desk = gm.manage(owner, gym.id);
    const start = gm.inDays(-26); // a 30-day month ends in 3 days
    const a = await gm.addMember(owner, gym.id, { displayName: 'Ayesha Akter', phone: linked.phone, membership: { packageId: pkg('month').id, startsOn: start } });
    await gm.linkMember(owner, gym.id, a.member.id, linked);
    const email = 'member.b@example.test';
    await gm.addMember(owner, gym.id, { displayName: 'Babul Mia', email, membership: { packageId: pkg('month').id, startsOn: start } });
    const late = await h.signupUser({ name: 'Late Payer' });
    const c = await gm.addMember(owner, gym.id, { displayName: 'Chandni', phone: late.phone, membership: { packageId: pkg('month').id, startsOn: gm.inDays(-3) } });
    await gm.linkMember(owner, gym.id, c.member.id, late);
    await gm.addMember(owner, gym.id, { displayName: 'No Contact', membership: { packageId: pkg('month').id, startsOn: start } });
    await h.drainEvents();

    const at = (d) => new Date(Date.now() + d * DAY);
    const runDay = async (d) => {
      for (let i = 0; i < 2; i += 1) {
        await jobs.daily(at(d));
        await jobs.reminders(at(d));
      }
      await h.drainEvents();
    };
    await runDay(0);
    expect(await countOf(linked.user.id, 'GYM_RENEWAL_DUE')).toBe(1);
    expect(await countOf(late.user.id, 'GYM_FEE_OVERDUE')).toBe(1);
    const ext = await models.NotificationExternalDelivery.findAll({ where: { code: 'GYM_RENEWAL_DUE' } });
    expect(ext.map((x) => [x.recipientType, x.status])).toEqual([['gym_member', 'sent']]);
    expect(h.mail.lastTo(email).text).toContain(`${config.apps.gym}/me/memberships/`);
    expect(JSON.stringify(ext[0].get({ plain: true }))).not.toContain(email);

    // The owner switches off "ends today" (FR-55).
    await desk.patch('/settings', { remindersOff: ['ends_today'] }).expect(200);
    for (const d of [1, 2, 3]) await runDay(d);
    expect(await countOf(linked.user.id, 'GYM_MEMBERSHIP_ENDS_TODAY')).toBe(0);
    await runDay(4);
    expect(await countOf(linked.user.id, 'GYM_MEMBERSHIP_EXPIRED')).toBe(1);
    // M27: renewal reminders at 7, 3 and 1 days before the end: day 0 was d-3, day 2 was d-1, each once.
    expect(await countOf(linked.user.id, 'GYM_RENEWAL_DUE')).toBe(2);
    expect(await countOf(late.user.id, 'GYM_FEE_OVERDUE')).toBe(1);
    expect(await models.NotificationExternalDelivery.count({ where: { code: 'GYM_RENEWAL_DUE' } })).toBe(2);
    // The unlinked member with an email also heard that the package started (GYM_MEMBERSHIP_STARTED, by email only).
    expect(await models.NotificationExternalDelivery.count({ where: { code: 'GYM_MEMBERSHIP_STARTED' } })).toBe(1);

    // The reminders page: offsets, members reachable only by SMS, the log (no text, no phone) (FR-59, FR-61).
    const page = (await desk.get('/reminders').expect(200)).body;
    conforms(s.RemindersPage, page);
    expect(page).toMatchObject({ feature: { reminders: true }, offsets: { renewalRemindDays: [7, 3, 1], overdueRemindDays: [3], morningSummaryTime: '08:00' }, sms: { available: false } });
    expect(page.kinds.find((k) => k.kind === 'ends_today').on).toBe(false);
    expect(page.reachability.smsOnly).toBe(0); // the expired members are no longer active; see below
    expect(page.log.items.filter((x) => x.kind === 'renewal_due').map((x) => x.status).sort()).toEqual(['published', 'published', 'published', 'published', 'skipped', 'skipped']); // 3 members × d-3 and d-1
    expect(page.log.items.find((x) => x.skipReason === 'no_contact')).toBeTruthy();
    expect(JSON.stringify(page)).not.toMatch(PHONE);
    // Staff never see the reminders page (owner only).
    const staff = await gm.hire(owner, gym.id, await h.signupUser(), ['members.view']);
    expect((await gm.manage(staff, gym.id).get('/reminders').expect(403)).body.permission).toBe('owner.only');
  });

  it('nothing for a Free gym; the morning summary once a day after the summary time; the monthly report on Standard', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'free' });
    const who = await h.signupUser();
    const m = await gm.addMember(owner, gym.id, { phone: who.phone, membership: { packageId: pkg('month').id, startsOn: gm.inDays(-26) } });
    await gm.linkMember(owner, gym.id, m.member.id, who);
    expect(await jobs.reminders(new Date())).toEqual({ renewal_due: 0, ends_today: 0, expired: 0, overdue: 0 });
    expect(await models.GymReminder.count({ where: { kind: 'renewal_due' } })).toBe(0);

    await api().put(`${P}/manage/billing/tier`).set(h.bearer(owner)).send({ tier: 'standard' }).expect(200);
    const collector = await gm.hire(owner, gym.id, await h.signupUser(), ['members.view', 'fees.collect']);
    const today = gm.today();
    const before = new Date(rules.instantOf(today).getTime() + 7 * HOUR + 59 * 60000); // 07:59 Dhaka
    const after = new Date(rules.instantOf(today).getTime() + 8 * HOUR + 5 * 60000);
    expect(await jobs.morningSummary(before)).toEqual({ sent: 0, skipped: 0 });
    // The member's due is overdue (started 26 days ago, unpaid).
    expect(await jobs.morningSummary(after)).toEqual({ sent: 1, skipped: 0 });
    expect(await jobs.morningSummary(after)).toEqual({ sent: 0, skipped: 0 });
    await h.drainEvents();
    expect(await countOf(owner.user.id, 'GYM_OWNER_MORNING')).toBe(1);
    expect(await countOf(collector.user.id, 'GYM_OWNER_MORNING')).toBe(1);

    await gm.manage(owner, gym.id).post(`/dues/${m.due.id}/payments`, { amountPoisha: 100000, method: 'cash' }, true).expect(201);
    const first = rules.addMonths(today, 1);
    const r1 = await jobs.monthlyReport(new Date(rules.instantOf(first).getTime() + 8 * HOUR));
    expect(r1).toMatchObject({ sent: 1, month: rules.monthOf(today) });
    expect((await jobs.monthlyReport(new Date(rules.instantOf(first).getTime() + 9 * HOUR))).sent).toBe(0);
    await h.drainEvents();
    const n = await models.Notification.findOne({ where: { userId: owner.user.id, code: 'GYM_OWNER_MONTHLY_REPORT' } });
    expect(n.body).toContain('৳1,000');
    expect(n.link).toBe(`${config.apps.gym}/manage/${gym.id}/reports?month=${rules.monthOf(today)}`);
  });
});

describe('reports and exports (M24-FR-70 to FR-74)', () => {
  it('members, money and attendance for a month; not seen; CSV exports for the owner; all gyms', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'free' });
    const desk = gm.manage(owner, gym.id);
    expect((await desk.get('/reports').expect(403)).body).toMatchObject({ code: 'GYM_TIER_REQUIRED', feature: 'reports', minTier: 'standard' });
    await api().put(`${P}/manage/billing/tier`).set(h.bearer(owner)).send({ tier: 'standard' }).expect(200);
    const a = await gm.addMember(owner, gym.id, { displayName: 'Ayesha Akter', membership: { packageId: pkg('month').id, startsOn: gm.inDays(-20) }, payment: { amountPoisha: 350000, method: 'cash' } });
    const b = await gm.addMember(owner, gym.id, { displayName: 'Babul Mia', membership: { packageId: pkg('quarter').id, startsOn: gm.today() } });
    await desk.post(`/dues/${b.due.id}/payments`, { amountPoisha: 200000, method: 'owner_bkash' }, true).expect(201);
    await desk.post('/checkins', { memberId: a.member.id }).expect(201);
    const month = rules.monthOf(gm.today());
    const rep = (await desk.get(`/reports?month=${month}`).expect(200)).body;
    conforms(s.GymReport, rep);
    expect(rep.money).toMatchObject({ byMethod: { owner_bkash: 200000 }, onlinePoisha: 0 });
    expect(rep.attendance.visits).toBe(1);
    expect(rep.money.monthOverMonth).toHaveLength(6);
    // Dashboards (M24-FR-154, FR-155): money per day up to today, visit methods, the period before.
    expect(rep.money.daily.at(-1).date).toBe(gm.today());
    expect(rep.money.daily.reduce((n, d) => n + d.collectedPoisha, 0)).toBe(rep.money.collectedPoisha);
    expect(rep.attendance).toMatchObject({ byMethod: { desk: 1 }, averageVisitMinutes: null });
    expect(rep.previous.period).toEqual(rules.previousPeriod(rep.period, gm.today()));
    expect(rep.previous).toMatchObject({ money: { collectedPoisha: 0 }, attendance: { visits: 0 }, members: { new: 0 } });
    await desk.get('/reports?from=2026-01-01&to=2027-06-01').expect(422);

    const absent = (await desk.get('/reports/absent').expect(200)).body;
    conforms(s.AbsentList, absent);

    const csv = await desk.get(`/reports/export?dataset=members&month=${month}`).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.text).toContain('"Member code","Name","Phone"');
    expect(csv.text).toMatch(/"'\+8801\d{9}"/); // the gym's own record, full phone (FR-73); a leading + is quoted against formulas
    const pay = await desk.get(`/reports/export?dataset=payments&month=${month}`).expect(200);
    expect(pay.text).toContain('"2000.00"');
    await desk.get(`/reports/export?dataset=attendance&month=${month}`).expect(200);
    expect(await models.AuditLog.count({ where: { action: 'gym_manage.exported' } })).toBe(3);
    await h.setSettingForTest('analytics.export_sync_max_rows', 1);
    expect((await desk.get(`/reports/export?dataset=members&month=${month}`).expect(422)).body.code).toBe('EXPORT_TOO_LARGE');

    // Staff: reports.view reads reports; exports stay the owner's (§3.3).
    const viewer = await gm.hire(owner, gym.id, await h.signupUser(), ['members.view', 'reports.view']);
    await gm.manage(viewer, gym.id).get(`/reports?month=${month}`).expect(200);
    expect((await gm.manage(viewer, gym.id).get(`/reports/export?dataset=members&month=${month}`).expect(403)).body.permission).toBe('owner.only');
    const plain = await gm.hire(owner, gym.id, await h.signupUser(), ['members.view']);
    expect((await gm.manage(plain, gym.id).get('/reports').expect(403)).body.permission).toBe('reports.view');
    await gm.manage(plain, gym.id).get('/reports/absent').expect(200);

    const all = (await api().get(`${P}/manage/reports?month=${month}`).set(h.bearer(owner)).expect(200)).body;
    expect(all.previous.money.collectedPoisha).toBe(0);
    conforms(s.AllGymsReport, all);
    expect(all).toMatchObject({ multiGym: false, perGym: null, passSales: { available: false } });
  });
});

/**
 * A join request through the API (M24 prompt 3, FR-16) that the owner declines, so the same phone added
 * at the desk later is a referral (FR-92); returns that phone. A private gym takes no join requests, so it
 * is shown as live for the request only (an M20 row written directly, like gm.listOwner writes the role).
 */
async function declinedJoinRequest(gym, owner) {
  const person = await h.signupUser();
  const row = await models.Gym.findByPk(gym.id);
  const was = { status: row.status, liveSnapshot: row.liveSnapshot };
  // chk_gyms_snapshot: a live gym has a public snapshot (unused by the join request).
  if (was.status !== 'live') await row.update({ status: 'live', liveSnapshot: was.liveSnapshot ?? {} });
  const r = await api().post(`${P}/me/gym-join-requests`).set(h.bearer(person)).send({ gymId: gym.id }).expect(201);
  if (was.status !== 'live') await row.update(was);
  await gm.manage(owner, gym.id).post(`/requests/${r.body.request.id}/decline`, {}).expect(200);
  return person.phone;
}

describe('the owner invoice, dunning, referrals and founding partners (M24-FR-81 to FR-92)', () => {
  it('the §6.6 November example (৳1,525), dunning to restricted and back on payment', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'basic' });
    const desk = gm.manage(owner, gym.id);
    // Two referred members (a declined join request, then the desk) pay their first fee.
    for (const name of ['Ref One', 'Ref Two']) {
      const phone = await declinedJoinRequest(gym, owner);
      const r = await gm.addMember(owner, gym.id, { displayName: name, phone, membership: { packageId: pkg('month').id, startsOn: gm.today() }, payment: { amountPoisha: 100000, method: 'cash' } });
      expect(r.member.source).toBe('platform');
      // A second payment never charges again (FR-91).
      await desk.post(`/dues/${r.due.id}/payments`, { amountPoisha: 100000, method: 'cash' }, true).expect(201);
    }
    expect((await models.GymReferral.findAll()).map((x) => [x.amountPoisha, x.source, x.status])).toEqual([
      [20000, 'setting', 'pending'],
      [20000, 'setting', 'pending'],
    ]);
    // A desk member without a matching request is not a referral.
    expect((await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.today() }, payment: { amountPoisha: 100000, method: 'cash' } })).member.source).toBe('desk');

    // Founding partner (master, step-up settings.write), on a paid tier for 4 months: the 25% discount month.
    await api().put(`${P}/admin/gym-manage/owners/${owner.user.id}/founding-partner`).set(h.bearer(master)).send({ on: true, reason: 'Pilot gym' }).expect(403);
    const fp = await api().put(`${P}/admin/gym-manage/owners/${owner.user.id}/founding-partner`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'settings.write')).send({ on: true, reason: 'Pilot gym' }).expect(200);
    expect(fp.body).toMatchObject({ foundingPartner: true, foundingNo: 1 });
    const today = gm.today();
    await models.GymOwnerSubscription.update({ startedOn: rules.addMonths(today, -6), paidTierSince: rules.addMonths(today, -3) }, { where: { ownerId: owner.user.id } });
    // The month's peak: 142 active members (the active-count job writes one row a day).
    await models.GymActiveMemberCount.create({ ownerId: owner.user.id, localDate: today, activeCount: 142, gymsCount: 1, chosenTier: 'basic' });
    const billing = (await api().get(`${P}/manage/billing`).set(h.bearer(owner)).expect(200)).body;
    conforms(s.Billing, billing);
    expect(billing).toMatchObject({ activeMembers: { monthPeak: 142, fitTier: 'standard' }, subscription: { foundingPartner: true, foundingNo: 1 }, fees: { referral: { valuePoisha: 20000, source: 'setting' }, passCommission: { pct: 5, source: 'setting' } }, openInvoices: [] });

    // invoice-cycle on the 1st (02:00 Dhaka), in arrears.
    const first = rules.addMonths(today, 1);
    const cycleAt = new Date(rules.instantOf(first).getTime() + 2 * HOUR);
    expect(await jobs.invoiceCycle(cycleAt)).toMatchObject({ issued: 1, period: rules.monthOf(today) });
    expect(await jobs.invoiceCycle(cycleAt)).toMatchObject({ issued: 0 });
    const inv = (await api().get(`${P}/manage/billing/invoices`).set(h.bearer(owner)).expect(200)).body.items[0];
    const detail = (await api().get(`${P}/manage/billing/invoices/${inv.id}`).set(h.bearer(owner)).expect(200)).body;
    conforms(s.Invoice, detail);
    expect(detail).toMatchObject({ number: expect.stringMatching(/^GI-\d{2}-\d{6}$/), billedTier: 'standard', peakActive: 142, subtotalPoisha: 152500, vatPoisha: 0, totalPoisha: 152500, status: 'issued' });
    expect(detail.lines.map((l) => [l.kind, l.amountPoisha])).toEqual([
      ['tier', 150000],
      ['founding_discount', -37500],
      ['referral', 40000],
    ]);
    expect(await models.GymReferral.count({ where: { status: 'invoiced', invoiceId: inv.id } })).toBe(2);
    expect((await models.GymOwnerSubscription.findOne({ where: { ownerId: owner.user.id } })).monthOf).toBe(rules.firstOfMonth(first));

    // Dunning: d-3 and d0 reminders, overdue → past_due, restricted after the grace days (FR-86).
    const issueDay = rules.dhakaDate(cycleAt);
    const atDay = (n) => new Date(rules.instantOf(rules.addDays(issueDay, n)).getTime() + 10 * HOUR);
    for (const n of [4, 4, 7, 7]) await jobs.invoiceDunning(atDay(n));
    expect(await models.GymReminder.count({ where: { kind: 'invoice_due', subjectId: inv.id } })).toBe(2);
    expect(await jobs.invoiceDunning(atDay(8))).toMatchObject({ overdue: 1, pastDue: 1 });
    expect((await models.GymOwnerSubscription.findOne({ where: { ownerId: owner.user.id } })).status).toBe('past_due');
    expect(await jobs.invoiceDunning(atDay(14))).toMatchObject({ restricted: 0 });
    expect(await jobs.invoiceDunning(atDay(15))).toMatchObject({ restricted: 1 });
    await h.drainEvents();
    expect(await codesOf(owner.user.id)).toEqual(expect.arrayContaining(['GYM_INVOICE_ISSUED', 'GYM_INVOICE_DUE_SOON', 'GYM_INVOICE_OVERDUE', 'GYM_ACCOUNT_RESTRICTED']));
    expect(await countOf(owner.user.id, 'GYM_INVOICE_DUE_SOON')).toBe(2);
    // G19: the money category sends the overdue and restricted notices by SMS.
    expect(h.sms.lastTo(h.e164(owner.phone))).toBeTruthy();

    // Restricted mode (FR-08): no new members; counter payments and billing still work.
    expect((await desk.post('/members', { displayName: 'Too Late', phone: h.nextPhone() }, true).expect(403)).body.code).toBe('GYM_ACCOUNT_RESTRICTED');
    const someDue = (await desk.get('/dues').expect(200)).body.items[0];
    await desk.post(`/dues/${someDue.id}/payments`, { amountPoisha: 100, method: 'cash' }, true).expect(201);
    expect((await api().get(`${P}/manage/billing`).set(h.bearer(owner)).expect(200)).body.subscription).toMatchObject({ status: 'restricted' });

    // Paying the invoice restores the panel at once; the money is gym SaaS revenue (FR-85).
    const pay = (await api().post(`${P}/manage/billing/invoices/${inv.id}/pay`).set(h.bearer(owner)).set('Idempotency-Key', gm.key('ip')).expect(201)).body;
    conforms(s.InvoicePayResult, pay);
    expect(pay.payment.payUrl).toBe(`${config.apps.gym}/pay/${pay.payment.id}`);
    await h.payWithSimulator(owner, pay.payment.id);
    await h.drainEvents();
    expect((await models.GymSubscriptionInvoice.findByPk(inv.id)).status).toBe('paid');
    expect((await models.GymOwnerSubscription.findOne({ where: { ownerId: owner.user.id } })).status).toBe('active');
    expect(await ledger.balance('fee_revenue:gym_saas')).toBe(152500);
    expect(await ledger.balance('escrow:gym_saas_invoice')).toBe(0);
    expect(await codesOf(owner.user.id)).toEqual(expect.arrayContaining(['GYM_INVOICE_PAID', 'GYM_ACCOUNT_RESTORED']));
    await desk.post('/members', { displayName: 'Back Again', phone: h.nextPhone() }, true).expect(201);
    expect((await api().post(`${P}/manage/billing/invoices/${inv.id}/pay`).set(h.bearer(owner)).set('Idempotency-Key', gm.key('ip')).expect(409)).body.code).toBe('GYM_INVOICE_STATE');
    // FR-89: a paid invoice cannot be voided.
    expect((await api().post(`${P}/admin/gym-manage/invoices/${inv.id}/void`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'escrow.manage')).send({ reason: 'Duplicate' }).expect(409)).body.code).toBe('GYM_INVOICE_STATE');
    expect((await invariants.check({ publish: false })).ok).toBe(true);

    // Admin reads (manage_gyms or view_payouts): owners, owner detail (counts only), invoices.
    const owners = (await api().get(`${P}/admin/gym-manage/owners?founding=true`).set(h.bearer(master)).expect(200)).body;
    conforms(s.AdminOwners, owners);
    expect(owners.items.map((x) => x.ownerId)).toEqual([owner.user.id]);
    const od = (await api().get(`${P}/admin/gym-manage/owners/${owner.user.id}`).set(h.bearer(master)).expect(200)).body;
    conforms(s.AdminOwnerDetail, od);
    expect(JSON.stringify(od)).not.toMatch(/Ref One|Ref Two/);
    const invs = (await api().get(`${P}/admin/gym-manage/invoices?status=paid`).set(h.bearer(master)).expect(200)).body;
    expect(invs.totals.paid).toEqual({ count: 1, totalPoisha: 152500 });
    const support = await f.staffWith(master, ['manage_gyms']);
    await api().get(`${P}/admin/gym-manage/owners`).set(h.bearer(support)).expect(200);
    expect((await api().put(`${P}/admin/gym-manage/owners/${owner.user.id}/founding-partner`).set(h.bearer(support)).send({ on: false, reason: 'No' }).expect(403)).body.code).toBe('MASTER_REQUIRED');
  });

  it('M24-FR-89: a void returns its referrals to pending and restores the owner; M24-FR-88: founding places are limited; FR-91: a reversal voids a referral', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'free' });
    const desk = gm.manage(owner, gym.id);
    const phone = await declinedJoinRequest(gym, owner);
    const r = await gm.addMember(owner, gym.id, { phone, membership: { packageId: pkg('month').id, startsOn: gm.today() }, payment: { amountPoisha: 100000, method: 'cash' } });
    // A reversal before invoicing voids the referral (FR-91).
    await desk.post(`/fee-payments/${r.payment.id}/reverse`, { reason: 'Wrong member' }, true).expect(201);
    expect((await models.GymReferral.findOne()).status).toBe('void');
    // The next first payment charges again.
    await desk.post(`/dues/${r.due.id}/payments`, { amountPoisha: 100000, method: 'cash' }, true).expect(201);
    expect(await models.GymReferral.count({ where: { status: 'pending' } })).toBe(1);

    // A Free owner with only a referral is still invoiced (the referral line).
    await models.GymOwnerSubscription.update({ startedOn: rules.addMonths(gm.today(), -2) }, { where: { ownerId: owner.user.id } });
    const cycleAt = new Date(rules.instantOf(rules.addMonths(gm.today(), 1)).getTime() + 2 * HOUR);
    await jobs.invoiceCycle(cycleAt);
    const inv = await models.GymSubscriptionInvoice.findOne({ where: { ownerId: owner.user.id } });
    expect(inv).toMatchObject({ totalPoisha: 20000, billedTier: 'free' });
    const voided = await api().post(`${P}/admin/gym-manage/invoices/${inv.id}/void`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'escrow.manage')).send({ reason: 'Goodwill for the pilot' }).expect(200);
    expect(voided.body.status).toBe('void');
    expect((await models.GymReferral.findOne({ where: { status: { [require('sequelize').Op.ne]: 'void' } } })).toJSON()).toMatchObject({ status: 'pending', invoiceId: null });
    expect(await models.AuditLog.count({ where: { action: 'gym_invoice.voided' } })).toBe(1);

    // Founding places: limit 1.
    await h.setSettingForTest('gym_saas.founding_partner_limit', 1);
    const other = await gm.privateGym({ shortCode: 'OT' });
    const put = async (ownerId, status) =>
      api().put(`${P}/admin/gym-manage/owners/${ownerId}/founding-partner`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'settings.write')).send({ on: true, reason: 'Pilot' }).expect(status);
    await put(owner.user.id, 200);
    expect((await put(other.owner.user.id, 409)).body.code).toBe('GYM_FOUNDING_FULL');
  });
});

describe('fee overrides change a referral and a pass commission (M24-FR-93 to FR-95)', () => {
  it('owner override of the referral fee, gym override of the pass commission; one active per scope; bounds; the job ends them', async () => {
    const reviewer = await f.staffWith(master, ['approve_listings']);
    const docsReviewer = await f.staffWith(master, ['approve_documents']);
    const owner = await g.gymOwner(docsReviewer);
    const live = await g.liveGym(owner, reviewer);
    const step = () => h.stepUp(master, 'settings.write');
    const create = async (body, status = 201) => api().post(`${P}/admin/gym-manage/fee-overrides`).set(h.bearer(master)).set('X-Step-Up', await step()).send(body).expect(status);

    const pct = (await create({ scopeType: 'gym', scopeId: live.id, key: 'fees.gym_pct', value: 3, reason: 'Launch deal' })).body;
    conforms(s.FeeOverride, pct);
    expect(pct).toMatchObject({ source: 'gym_override', value: 3, status: 'active' });
    expect((await create({ scopeType: 'gym', scopeId: live.id, key: 'fees.gym_pct', value: 2, reason: 'Again' }, 409)).body).toMatchObject({ code: 'GYM_OVERRIDE_ACTIVE', overrideId: pct.id });
    expect((await create({ scopeType: 'owner', scopeId: owner.user.id, key: 'fees.gym_pct', value: 26, reason: 'Too high' }, 422)).body.code).toBe('GYM_OVERRIDE_OUT_OF_BOUNDS');
    const ref = (await create({ scopeType: 'owner', scopeId: owner.user.id, key: 'fees.gym_referral_poisha', value: 15000, reason: 'Founding deal', validTo: new Date(Date.now() + 30 * DAY).toISOString() })).body;
    await h.drainEvents();
    const notice = await models.Notification.findOne({ where: { userId: owner.user.id, code: 'GYM_FEE_OVERRIDE_SET' } });
    expect(notice).toBeTruthy();
    // FR-90: the owner sees the special rates on the billing page.
    expect((await api().get(`${P}/manage/billing`).set(h.bearer(owner)).expect(200)).body.fees).toMatchObject({ referral: { valuePoisha: 15000, source: 'owner_override' }, passCommission: { pct: 5, source: 'setting' } });

    // FR-95: a pass bought at the gym snapshots 300 bps and the override id.
    const buyer = await h.signupUser();
    const monthPkg = live.packages.find((p) => p.kind === 'month');
    const bought = await api().post(`${P}/gym/passes`).set(h.bearer(buyer)).set('Idempotency-Key', gm.key('gp')).send({ packageId: monthPkg.id, validFrom: gm.today() }).expect(201);
    const pass = await models.GymPass.findOne({ where: { code: bought.body.pass.code } });
    expect(pass).toMatchObject({ feeBps: 300, feeOverrideId: pct.id });

    // FR-91 with the owner override: the referral snapshots ৳150 and the override.
    await api().patch(`${P}/manage/gyms/${live.id}/settings`).set(h.bearer(owner)).send({ shortCode: 'LV' }).expect(200);
    const phone = await declinedJoinRequest(live, owner);
    const pk = (await api().get(`${P}/manage/gyms/${live.id}/packages`).set(h.bearer(owner)).expect(200)).body.items.find((p) => p.kind === 'month') ?? (await api().get(`${P}/manage/gyms/${live.id}/packages`).set(h.bearer(owner)).expect(200)).body.items[0];
    await gm.addMember(owner, live.id, { phone, membership: { packageId: pk.id, startsOn: gm.today() }, payment: { amountPoisha: 100, method: 'cash' } });
    expect(await models.GymReferral.findOne()).toMatchObject({ amountPoisha: 15000, source: 'owner_override', overrideId: ref.id, settingVersion: null });

    // Lists, end by a master, end by the job.
    expect((await api().get(`${P}/admin/gym-manage/fee-overrides?ownerId=${owner.user.id}`).set(h.bearer(master)).expect(200)).body.items).toHaveLength(2);
    const ended = await api().post(`${P}/admin/gym-manage/fee-overrides/${pct.id}/end`).set(h.bearer(master)).set('X-Step-Up', await step()).send({ reason: 'Deal over' }).expect(200);
    expect(ended.body.status).toBe('ended');
    expect(await jobs.overridesEnd(new Date(Date.now() + 31 * DAY))).toEqual({ ended: 1 });
    expect(await models.GymFeeOverride.count({ where: { status: 'active' } })).toBe(0);
    expect(await models.AuditLog.count({ where: { action: ['gym_fee_override.set', 'gym_fee_override.ended'] } })).toBe(3);
  });
});

describe('to-dos, active counts and privacy (M19, M24-FR-83, FR-106 to FR-108)', () => {
  it('the owner and staff to-dos; the active-count job; no phone or email in gym events', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'basic' });
    await gm.addMember(owner, gym.id, { email: 'someone@example.test', membership: { packageId: pkg('month').id, startsOn: gm.inDays(-5) } });
    await gm.listOwner(owner);
    const todo = (await api().get(`${P}/me/dashboard/actions?role=gym_owner`).set(h.bearer(owner)).expect(200)).body;
    expect(todo.items.map((x) => x.key)).toContain('gym_dues_overdue');
    const collector = await gm.hire(owner, gym.id, await h.signupUser(), ['members.view', 'fees.collect']);
    const staffTodo = (await api().get(`${P}/me/dashboard/actions?role=business_staff`).set(h.bearer(collector)).expect(200)).body;
    expect(staffTodo.items.map((x) => x.key)).toContain('gym_dues_overdue');

    expect(await jobs.activeCount(new Date())).toMatchObject({ counted: 1 });
    expect(await jobs.activeCount(new Date())).toMatchObject({ counted: 1 });
    expect(await models.GymActiveMemberCount.count()).toBe(1);
    expect(await jobs.reconcile()).toEqual({ gym_dues_paid_match: true, gym_dues_status_match: true, gym_fee_released_has_release: true, gym_sms_balance_not_negative: true, gym_whatsapp_balance_not_negative: true });

    for (const e of h.events.recorded().filter((x) => x.name.startsWith('gym_'))) {
      expect(JSON.stringify(e.payload)).not.toMatch(PHONE);
      expect(JSON.stringify(e.payload)).not.toContain('@example.test');
    }
  });
});
