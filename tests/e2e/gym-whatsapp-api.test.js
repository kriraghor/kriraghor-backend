'use strict';

// M24 §25 WhatsApp, step 2 (built switched off; M24-FR-161 to FR-170), end to end against the memory driver:
// everything refused while gym_whatsapp.api_enabled is off; connecting a number (token encrypted, Kriraghor's
// templates created, branches pointed at it); Meta's webhook (signature, template approval, statuses, STOP);
// units held, settled on delivery and given back on failure or expiry; bulk and single sends with consent,
// quiet hours, the daily cap and the permission; automatic receipts that replace the SMS; disconnecting.
const crypto = require('crypto');
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const gm = require('../fixtures/gym-manage');
const provider = require('../../src/providers/whatsapp');
const jobs = require('../../src/modules/gym-whatsapp/gym-whatsapp.jobs');
const units = require('../../src/modules/gym-manage/whatsapp-units.service');
const s = require('../../src/modules/gym-whatsapp/gym-whatsapp.schemas');

const { api, P, models } = h;
jest.setTimeout(400000);

const ON = {
  'gym_whatsapp.api_enabled': true,
  'gym_whatsapp.included': 20,
  'gym_whatsapp.bundle_price_poisha': 50000,
  // No quiet window, so marketing goes at once whatever the clock says (the window itself is unit-tested).
  'notify.quiet_hours_start': '03:00',
  'notify.quiet_hours_end': '03:00',
};
const switchOn = async (over = {}) => {
  for (const [k, v] of Object.entries({ ...ON, ...over })) await h.setSettingForTest(k, v);
};

beforeEach(async () => {
  await h.resetDb();
  await h.createSignedInMaster();
  provider.clear();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const conforms = (schema, body) => expect(schema.safeParse(body).error?.issues ?? []).toEqual([]);
const owner = (who) => ({
  get: () => api().get(`${P}/manage/whatsapp`).set(h.bearer(who)),
  connect: (body, key = gm.key('wa')) => {
    const r = api().post(`${P}/manage/whatsapp/senders`).set(h.bearer(who));
    if (key) r.set('Idempotency-Key', key);
    return r.send(body);
  },
  disconnect: (id) => api().post(`${P}/manage/whatsapp/senders/${id}/disconnect`).set(h.bearer(who)),
  addon: (enabled) => api().put(`${P}/manage/billing/whatsapp-addon`).set(h.bearer(who)).send({ enabled }),
});
const NUMBER = { code: 'code-123', wabaId: '1110001', phoneNumberId: '2220002' };
const balance = (who) => units.balanceOf(who.user.id);
const entries = (who) => models.GymWhatsappEntry.findAll({ where: { ownerId: who.user.id }, order: [['createdAt', 'ASC'], ['id', 'ASC']] }).then((rows) => rows.map((e) => [e.kind, e.units]));

/** Meta's webhook, signed with the test app secret (or not). */
function hook(body, { secret = 'test-meta-app-secret' } = {}) {
  const raw = JSON.stringify(body);
  const sig = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return api().post(`${P}/webhooks/whatsapp`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(raw);
}
const change = (wabaId, field, value) => ({ object: 'whatsapp_business_account', entry: [{ id: wabaId, changes: [{ field, value }] }] });
const approveAll = async () => {
  for (const t of await models.GymWhatsappTemplate.findAll()) {
    await hook(change(NUMBER.wabaId, 'message_template_status_update', { event: 'APPROVED', message_template_id: t.metaId, message_template_name: t.code, message_template_language: t.locale })).expect(200);
  }
};
const status = (wamid, st, extra = {}) => hook(change(NUMBER.wabaId, 'messages', { messaging_product: 'whatsapp', metadata: { phone_number_id: NUMBER.phoneNumberId }, statuses: [{ id: wamid, status: st, timestamp: String(Math.floor(Date.now() / 1000)), ...extra }] }));

/** A Standard gym, WhatsApp on with its allowance, a number connected and every template approved. */
async function ready({ tier = 'standard' } = {}) {
  await switchOn();
  const made = await gm.privateGym({ tier });
  await owner(made.owner).addon(true).expect(200);
  await owner(made.owner).connect(NUMBER).expect(201);
  await approveAll();
  return made;
}

/** An active member with a membership, and their WhatsApp consents recorded at the desk. */
async function member(o, gym, pkg, { service = true, news = true, name = 'Rafiq Hasan' } = {}) {
  const phone = h.nextPhone();
  const added = await gm.addMember(o, gym.id, { displayName: name, phone, membership: { packageId: pkg('month').id, startsOn: gm.today() } });
  if (service || news) await gm.manage(o, gym.id).put(`/members/${added.member.id}/whatsapp`, { service, news }).expect(200);
  return { ...added, phone, digits: h.e164(phone).slice(1) };
}

describe('M24 §25 WhatsApp, step 2', () => {
  it('is refused while switched off, and below the plan', async () => {
    const { owner: o, gym } = await gm.privateGym({ tier: 'standard' });
    const view = (await owner(o).get().expect(200)).body;
    conforms(s.OwnerWhatsapp, view);
    expect(view).toMatchObject({ apiEnabled: false, signUp: null, senders: [], units: { available: false, balance: 0 } });
    expect((await owner(o).connect(NUMBER).expect(409)).body.code).toBe('GYM_WHATSAPP_API_OFF');
    expect((await owner(o).addon(true).expect(409)).body.code).toBe('GYM_WHATSAPP_UNAVAILABLE');
    expect((await gm.manage(o, gym.id).post('/whatsapp/estimate', { kind: 'notice', segment: { kind: 'active' } }).expect(409)).body.code).toBe('GYM_WHATSAPP_API_OFF');
    expect(provider.calls()).toEqual([]);

    // On, but Basic is below the plan of the whatsapp feature (Standard).
    await switchOn();
    const basic = await gm.privateGym({ tier: 'basic', name: 'Basic Gym', shortCode: 'BG' });
    expect((await owner(basic.owner).connect(NUMBER).expect(409)).body.code).toBe('GYM_WHATSAPP_UNAVAILABLE');
    expect((await gm.manage(basic.owner, basic.gym.id).post('/whatsapp/estimate', { kind: 'notice', segment: { kind: 'active' } }).expect(403)).body.code).toBe('GYM_TIER_REQUIRED');
    expect((await owner(o).get().expect(200)).body.signUp).toEqual({ appId: '1234567890', configId: '9876543210' });
  });

  it('connecting, the webhook, units, bulk and single sends, statuses, STOP, the cap and who may send', async () => {
    await switchOn();
    const { owner: o, gym, pkg } = await gm.privateGym({ tier: 'standard' });
    const second = await gm.privateGym({ owner: o, name: 'Iron Yard Gulshan', shortCode: 'IG' });
    const g = gm.manage(o, gym.id);

    // Units: on with the month's allowance (M24-FR-166).
    expect((await owner(o).addon(true).expect(200)).body).toMatchObject({ available: true, status: 'active', balance: 20 });
    await owner(o).addon(true).expect(200);
    expect(await entries(o)).toEqual([['grant', 20]]);

    // Connecting: a bad code is Meta's refusal; the number is kept with its token encrypted (M24-FR-161 to FR-163).
    await owner(o).connect(NUMBER, null).expect(400);
    expect((await owner(o).connect({ ...NUMBER, code: 'bad-code' }).expect(502)).body).toMatchObject({ code: 'GYM_WHATSAPP_META_FAILED', step: 'exchange' });
    const senders = (await owner(o).connect(NUMBER).expect(201)).body;
    conforms(s.Senders, senders);
    expect(senders).toHaveLength(1);
    expect(senders[0]).toMatchObject({ displayNumber: '+880 1700-000000', status: 'connected', templates: { approved: 0, pending: 16, rejected: 0 } });
    const row = await models.GymWhatsappSender.findOne();
    expect(row.tokenEnc).not.toContain('code-123');
    expect(JSON.stringify(senders)).not.toContain('token');
    expect(provider.calls().filter((c) => c.fn === 'createTemplate')).toHaveLength(16);
    // Both branches now send from it; another owner cannot take the number.
    expect((await owner(o).get().expect(200)).body.gyms.map((x) => x.senderId)).toEqual([row.id, row.id]);
    const other = await gm.privateGym({ tier: 'standard', name: 'Other Gym', shortCode: 'OG' });
    expect((await owner(other.owner).connect(NUMBER).expect(409)).body.code).toBe('GYM_WHATSAPP_NUMBER_TAKEN');

    // The webhook: the check, the signature, then the templates approved (M24-FR-169).
    expect((await api().get(`${P}/webhooks/whatsapp`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': '42' }).expect(200)).text).toBe('42');
    await api().get(`${P}/webhooks/whatsapp`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '42' }).expect(403);
    expect((await hook(change(NUMBER.wabaId, 'account_update', {}), { secret: 'wrong' }).expect(401)).body.code).toBe('WEBHOOK_SIGNATURE_INVALID');

    // Three members: news and receipts, receipts only, nothing.
    const a = await member(o, gym, pkg, { name: 'Amin' });
    const b = await member(o, gym, pkg, { news: false, name: 'Bithi' });
    const cMember = await member(o, gym, pkg, { service: false, news: false, name: 'Chandan' });
    const segment = { kind: 'active' };
    const est0 = (await g.post('/whatsapp/estimate', { kind: 'notice', segment }).expect(200)).body;
    expect(est0).toMatchObject({ members: 3, reachable: 0, template: 3 });
    await approveAll();
    const est = (await g.post('/whatsapp/estimate', { kind: 'notice', segment }).expect(200)).body;
    conforms(s.Estimate, est);
    expect(est).toMatchObject({ members: 3, reachable: 1, no_consent: 2, unitsNeeded: 4, balance: 20, bulkLeft: 2, senderConnected: true, addonActive: true });

    // A notice: only Amin, 4 units held, sent by the job, settled on delivery (M24-FR-166 to FR-168, FR-170).
    await g.post('/whatsapp/sends', { kind: 'notice', segment, title: 'New Zumba class', message: 'From Monday at 7 pm.' }).expect(400);
    const sent = (await g.post('/whatsapp/sends', { kind: 'notice', segment, title: 'New Zumba class', message: 'From Monday at 7 pm.' }, true).expect(201)).body;
    conforms(s.Send, sent);
    expect(sent).toMatchObject({ kind: 'notice', targetCount: 3, queuedCount: 1, unitsHeld: 4 });
    expect(await balance(o)).toBe(16);
    expect(await jobs.send()).toEqual({ sent: 1, failed: 0 });
    const out = provider.sent();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ to: a.digits, template: 'kg_notice', locale: 'en', values: ['Iron Yard Banani', 'New Zumba class', 'From Monday at 7 pm.'] });
    const msg = await models.GymWhatsappMessage.findOne({ where: { memberId: a.member.id } });
    expect(msg).toMatchObject({ status: 'sent', category: 'marketing', units: 4 });
    expect(JSON.stringify(msg.toJSON())).not.toContain(a.digits);
    await status(msg.wamid, 'delivered').expect(200);
    await status(msg.wamid, 'read').expect(200);
    await status(msg.wamid, 'sent').expect(200); // never backwards
    expect((await msg.reload()).status).toBe('read');
    expect(await balance(o)).toBe(16);
    expect((await entries(o)).slice(-2)).toEqual([['reserve', -4], ['settle', 0]]);

    // A single update to Bithi (receipts and reminders only): utility, 1 unit; Meta fails it, the unit comes back.
    const one = (await g.post('/whatsapp/sends', { kind: 'single', memberId: b.member.id, message: 'Your locker key is ready.' }, true).expect(201)).body;
    expect(one).toMatchObject({ kind: 'single', queuedCount: 1, unitsHeld: 1 });
    expect(await balance(o)).toBe(15);
    await jobs.send();
    const bMsg = await models.GymWhatsappMessage.findOne({ where: { memberId: b.member.id } });
    expect(bMsg.template).toBe('kg_update');
    await status(bMsg.wamid, 'failed', { errors: [{ code: 131026 }] }).expect(200);
    expect(await bMsg.reload()).toMatchObject({ status: 'failed', errorCode: '131026' });
    expect(await balance(o)).toBe(16);
    // Chandan agreed to nothing: a single message is refused.
    expect((await g.post('/whatsapp/sends', { kind: 'single', memberId: cMember.member.id, message: 'Hi' }, true).expect(409)).body).toMatchObject({ code: 'GYM_WHATSAPP_BLOCKED', reason: 'no_consent' });

    // History (M24-FR-170).
    const list = (await g.get('/whatsapp/sends').expect(200)).body;
    conforms(s.Sends, list);
    expect(list.items.map((x) => [x.kind, x.status.read, x.status.failed])).toEqual([
      ['single', 0, 1],
      ['notice', 1, 0],
    ]);
    const hist = (await g.get(`/whatsapp/messages?memberId=${a.member.id}`).expect(200)).body;
    conforms(s.Messages, hist);
    expect(hist.items[0].text).toContain('New Zumba class');

    // The daily cap of bulk sends (M24-FR-167).
    await h.setSettingForTest('gym_whatsapp.bulk_daily_cap', 1);
    expect((await g.post('/whatsapp/sends', { kind: 'greeting', segment, message: 'Eid Mubarak!' }, true).expect(429)).body.code).toBe('GYM_WHATSAPP_CAP');
    await h.setSettingForTest('gym_whatsapp.bulk_daily_cap', 2);

    // Amin replies STOP: opted out of everything at this owner's gyms (M24-FR-169).
    await hook(change(NUMBER.wabaId, 'messages', { messaging_product: 'whatsapp', metadata: { phone_number_id: NUMBER.phoneNumberId }, messages: [{ from: a.digits, type: 'text', text: { body: ' Stop ' } }] })).expect(200);
    expect((await g.get(`/members/${a.member.id}/whatsapp`).expect(200)).body).toMatchObject({ service: false, news: false, source: 'stop_reply' });
    expect((await g.post('/whatsapp/sends', { kind: 'greeting', segment, message: 'Eid Mubarak!' }, true).expect(409)).body).toMatchObject({ code: 'GYM_WHATSAPP_BLOCKED', reason: 'nobody' });

    // Staff: whatsapp.send is needed (and members.view with it).
    const desk = await gm.hire(o, gym.id, await h.signupUser({ name: 'Desk Rumi' }), ['members.view', 'members.edit']);
    expect((await gm.manage(desk, gym.id).post('/whatsapp/estimate', { kind: 'notice', segment }).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    const sender = await gm.hire(o, gym.id, await h.signupUser({ name: 'Sender Mitu' }), ['members.view', 'whatsapp.send']);
    await gm.manage(sender, gym.id).post('/whatsapp/estimate', { kind: 'notice', segment }).expect(200);
    await gm.manage(sender, gym.id).get('/whatsapp').expect(200);
    expect((await gm.manage(sender, gym.id).patch('/whatsapp', { autoKinds: ['receipt'] }).expect(403)).body.code).toBe('PERMISSION_REQUIRED');

    // Disconnecting: both branches stop; sending says connect first (M24-FR-161).
    expect((await owner(o).disconnect(row.id).expect(200)).body).toEqual([]);
    expect(await models.GymWhatsappGym.count({ where: { senderId: row.id } })).toBe(0);
    expect((await g.post('/whatsapp/sends', { kind: 'single', memberId: b.member.id, message: 'Hi' }, true).expect(409)).body.code).toBe('GYM_WHATSAPP_NO_SENDER');
    await owner(o).disconnect(row.id).expect(409);
    expect(await models.OutboxEvent.count({ where: { name: 'gym_whatsapp.disconnected' } })).toBe(1);
    expect(second.gym.id).toBeTruthy();
  });

  it('automatic receipts on WhatsApp instead of SMS, a resend, expiry, and Meta removing the number', async () => {
    const { owner: o, gym, pkg } = await ready();
    // The SMS add-on is on too, with receipts by SMS.
    for (const [k, v] of Object.entries({ 'gym_saas.sms_addon_enabled': true, 'gym_saas.sms_addon_included': 10, 'gym_saas.sms_bundle_size': 100, 'gym_saas.sms_bundle_price_poisha': 50000 })) await h.setSettingForTest(k, v);
    await api().put(`${P}/manage/billing/sms-addon`).set(h.bearer(o)).send({ enabled: true }).expect(200);
    const g = gm.manage(o, gym.id);
    await g.patch('/settings', { smsKinds: ['receipt'] }).expect(200);
    const auto = (await g.patch('/whatsapp', { autoKinds: ['receipt', 'nonsense'] }).expect(422)).body;
    expect(auto.code).toBe('VALIDATION_FAILED');
    expect((await g.patch('/whatsapp', { autoKinds: ['receipt'] }).expect(200)).body.autoKinds).toEqual(['receipt']);

    const pay = (dueId) => g.post(`/dues/${dueId}/payments`, { amountPoisha: 100000, method: 'cash' }, true).expect(201).then((r) => r.body);
    const smsHeld = () => models.GymSmsEntry.count({ where: { kind: 'reserve' } });

    // A member who agreed to receipts: the receipt goes on WhatsApp, no SMS is held (M24-FR-165).
    const a = await member(o, gym, pkg, { news: false });
    const paid = await pay(a.due.id);
    await h.drainEvents();
    expect(await smsHeld()).toBe(0);
    const receipt = await models.GymWhatsappMessage.findOne({ where: { memberId: a.member.id, kind: 'receipt' } });
    expect(receipt).toMatchObject({ status: 'queued', category: 'utility', units: 1, template: 'kg_receipt' });
    await jobs.send();
    expect(provider.sent().pop()).toMatchObject({ to: a.digits, template: 'kg_receipt' });
    // Once per payment: replaying the event queues nothing new.
    await h.drainEvents();
    expect(await models.GymWhatsappMessage.count({ where: { kind: 'receipt' } })).toBe(1);

    // A member who agreed to nothing: the SMS as before.
    const b = await member(o, gym, pkg, { service: false, news: false });
    await pay(b.due.id);
    await h.drainEvents();
    expect(await smsHeld()).toBe(1);
    expect(await models.GymWhatsappMessage.count({ where: { memberId: b.member.id } })).toBe(0);

    // Resending a receipt from the panel; an opening balance or a stranger's payment has nothing to send.
    const feePaymentId = (await models.GymFeePayment.findOne({ where: { memberId: a.member.id } })).id;
    expect(paid).toBeTruthy();
    expect((await g.post(`/fee-payments/${feePaymentId}/whatsapp`).expect(201)).body).toMatchObject({ queued: true });
    expect((await g.post(`/fee-payments/${crypto.randomUUID()}/whatsapp`).expect(409)).body.code).toBe('GYM_WHATSAPP_RECEIPT');
    expect((await g.post(`/fee-payments/${(await models.GymFeePayment.findOne({ where: { memberId: b.member.id } })).id}/whatsapp`).expect(409)).body.reason).toBe('no_consent');

    // Not delivered within a day: expired, the unit comes back.
    const before = await balance(o);
    expect((await jobs.daily(new Date(Date.now() + 2 * 86400000))).expired).toBe(2);
    expect(await balance(o)).toBe(before + 2);
    expect(await models.GymWhatsappMessage.count({ where: { status: 'expired' } })).toBe(2);

    // Meta removes Kriraghor from the account: the number is disconnected and the owner is told.
    await hook(change(NUMBER.wabaId, 'account_update', { event: 'PARTNER_REMOVED' })).expect(200);
    expect((await models.GymWhatsappSender.findOne()).status).toBe('disconnected');
    expect(await models.OutboxEvent.count({ where: { name: 'gym_whatsapp.disconnected' } })).toBe(1);
    // Nothing goes out while the platform switch is off again.
    await h.setSettingForTest('gym_whatsapp.api_enabled', false);
    expect(await jobs.send()).toEqual({ sent: 0, failed: 0 });
  });
});
