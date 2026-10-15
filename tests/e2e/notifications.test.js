'use strict';

// M08 notifications core: routing, channels, preferences, quiet hours, rate limits, retries, OTP,
// the bell API, the support view, and the Phase 1 exit check (fee change → audit → notification).
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const sms = require('../../src/providers/sms');
const notify = require('../../src/modules/notifications/notify.service');
const consumers = require('../../src/modules/events/events.consumers');
const relay = require('../../src/modules/events/events.relay');

const { api, P, models, mail } = h;
const { sequelize } = models;

beforeEach(h.resetDb);
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await closeAllRedis();
  await sequelize.close();
});

const withEmail = async (userId, email) => models.User.update({ email, emailVerifiedAt: new Date() }, { where: { id: userId } });
/** Role and KYC changes bump the member's authz version (M01-FR-08), so refresh the access token first. */
async function fresh(member) {
  const r = await h.refreshWeb(member.cookie).expect(200);
  return { ...member, accessToken: r.body.accessToken };
}
const notificationsOf = (userId) => models.Notification.findAll({ where: { userId }, order: [['createdAt', 'ASC']] });

async function proposeFee(master, to) {
  const token = await h.stepUp(master, 'settings.write');
  return api().post(`${P}/admin/settings/change-requests`).set(h.bearer(master)).set('X-Step-Up', token).send({ changes: [{ key: 'fees.shop_commission_pct', to }], reason: 'Courier costs went up' });
}

/** A member with an active ground_owner role decision pending. */
async function memberApplying() {
  const member = await h.signupUser({ role: 'ground_owner' });
  await h.verifyMember(member.user.id);
  return member;
}
const decideRole = (master, userId, status, extra = {}) =>
  api()
    .post(`${P}/admin/users/${userId}/roles/ground_owner/status`)
    .set(h.bearer(master))
    .send({ status, ...extra });

describe('Phase 1 exit check: a fee change with step-up is audited and notifies the masters', () => {
  it('A proposes → B is asked to approve (in-app + email); B approves → A gets the critical alert, B does not', async () => {
    const a = await h.createSignedInMaster();
    const b = await h.createSecondMaster();
    await models.User.update({ displayName: 'Rahim Uddin' }, { where: { id: b.userId } });
    await withEmail(a.userId, 'ayesha@kriraghor.test');
    await withEmail(b.userId, 'rahim@kriraghor.test');

    const proposed = await proposeFee(a, 6);
    expect(proposed.body.status).toBe('proposed');
    await h.drainEvents();

    const forB = await notificationsOf(b.userId);
    expect(forB.map((n) => n.code)).toEqual(['SETTING_CHANGE_PROPOSED']);
    expect(forB[0]).toMatchObject({ category: 'staff_ops', title: 'Approval needed', link: '/admin/fees' });
    expect(forB[0].body).toMatch(/^Ayesha .+ proposed fees\.shop_commission_pct 5 → 6, effective .+\. Another master must approve\.$/);
    expect(mail.lastTo('rahim@kriraghor.test')).toMatchObject({ subject: 'Kriraghor: approve a settings change' });
    expect(mail.lastTo('rahim@kriraghor.test').text).toContain('Courier costs went up');
    expect(await notificationsOf(a.userId)).toEqual([]); // the proposer is not asked

    const token = await h.stepUp(b, 'settings.write');
    await api().post(`${P}/admin/settings/change-requests/${proposed.body.id}/approve`).set(h.bearer(b)).set('X-Step-Up', token).send({}).expect(200);
    await h.drainEvents();

    const forA = await notificationsOf(a.userId);
    expect(forA.map((n) => n.code)).toEqual(['AUDIT_CRITICAL']);
    expect(forA[0].body).toBe('Rahim Uddin: Changed fees.shop_commission_pct from 5 to 6');
    expect(forA[0].link).toMatch(/^\/admin\/audit\?id=\d+$/);
    expect(mail.lastTo('ayesha@kriraghor.test')).toMatchObject({ subject: 'Kriraghor: critical change by Rahim Uddin' });
    expect(mail.lastTo('ayesha@kriraghor.test').html).toContain('Changed fees.shop_commission_pct from 5 to 6');
    // B made the change, so B gets no alert about it (but did get the earlier approval request).
    expect((await notificationsOf(b.userId)).map((n) => n.code)).toEqual(['SETTING_CHANGE_PROPOSED']);

    // The admin bell shows it, and the unread count was pushed in realtime.
    const bell = await api().get(`${P}/admin/me/notifications`).set(h.bearer(a)).expect(200);
    expect(bell.body).toMatchObject({ unreadCount: 1, items: [expect.objectContaining({ code: 'AUDIT_CRITICAL', title: 'Critical change', readAt: null })] });
    expect(h.realtime.emitted()).toEqual(expect.arrayContaining([{ userId: a.userId, name: 'notification.created', data: { notificationId: forA[0].id, unreadCount: 1 } }]));
    const deliveries = await models.NotificationDelivery.findAll({ where: { userId: a.userId } });
    expect(deliveries.map((d) => [d.channel, d.status])).toEqual([['email', 'sent']]);
  });
});

describe('routing and channels (M08-FR-01 to FR-03, FR-06)', () => {
  it('a role decision notifies the member in-app and by SMS; the SMS log is masked', async () => {
    const master = await h.createSignedInMaster();
    const member = await memberApplying();
    await decideRole(master, member.user.id, 'active').expect(200);
    const results = await h.drainEvents();
    expect(results).toEqual([{ status: 'delivered' }]);

    const [n] = await notificationsOf(member.user.id);
    expect(n).toMatchObject({ code: 'ROLE_ACTIVATED', category: 'moderation', roleContext: 'ground_owner', title: 'Ground owner is active', locale: 'en', templateVersion: 1 });
    expect(h.sms.lastTo(h.e164(member.phone)).text).toBe('Kriraghor: your Ground owner account is approved. You can start now.');
    const log = await models.SmsLog.findOne({ where: { route: 'trans' } });
    expect(log).toMatchObject({ toPhoneMasked: expect.stringMatching(/^\+8801•+\d{4}$/), encoding: 'gsm7', segments: 1, status: 'sent', gateway: 'memory' });
    expect(log.toPhoneHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Bangla users get Bangla text (UCS-2 SMS)', async () => {
    const master = await h.createSignedInMaster();
    const member = await memberApplying();
    await models.User.update({ locale: 'bn' }, { where: { id: member.user.id } });
    await decideRole(master, member.user.id, 'rejected', { reasonCode: 'blurry_photos' }).expect(200);
    await h.drainEvents();
    const [n] = await notificationsOf(member.user.id);
    expect(n).toMatchObject({ code: 'ROLE_REJECTED', locale: 'bn', title: 'মাঠ মালিক আবেদন অনুমোদিত হয়নি' });
    expect(n.body).toContain('blurry photos');
    expect(await models.SmsLog.findOne({ where: { route: 'trans' } })).toMatchObject({ encoding: 'ucs2' });
  });

  it('a re-delivered event notifies once (inbox + dedupe key)', async () => {
    const master = await h.createSignedInMaster();
    const member = await memberApplying();
    await decideRole(master, member.user.id, 'active').expect(200);
    await relay.relayOnce();
    const job = consumers.takeTestJobs().find((j) => j.data.consumer === 'notify.ROLE_ACTIVATED');
    await consumers.processConsume(job.data);
    expect(await consumers.processConsume(job.data)).toEqual({ status: 'skipped' });
    // Even with the inbox row gone (a replay), the dedupe key stops a second notification.
    await sequelize.query('DELETE FROM consumed_events WHERE consumer = ?', { replacements: ['notify.ROLE_ACTIVATED'] });
    await consumers.processConsume(job.data);
    expect(await models.Notification.count({ where: { userId: member.user.id } })).toBe(1);
  });

  it('preferences turn optional channels off; mandatory cells cannot be turned off', async () => {
    const master = await h.createSignedInMaster();
    const member = await fresh(await memberApplying());
    const prefs = await api().get(`${P}/me/notification-prefs`).set(h.bearer(member)).expect(200);
    const security = prefs.body.categories.find((c) => c.category === 'security');
    expect(security.channels.find((c) => c.channel === 'sms')).toEqual({ channel: 'sms', enabled: true, locked: true, offered: true });
    // resetDb sets an empty window (00:00–00:00) so the suite sends at any hour; the seed default is 22:00–08:00.
    expect(prefs.body).toMatchObject({ quietHours: true, quietWindow: { start: '00:00', end: '00:00' }, locale: 'en' });
    expect(prefs.body.categories.map((c) => c.category)).not.toContain('staff_ops');

    const locked = await api().put(`${P}/me/notification-prefs`).set(h.bearer(member)).send({ prefs: [{ category: 'security', channel: 'sms', enabled: false }] }).expect(422);
    expect(locked.body.code).toBe('PREF_MANDATORY');
    await api().put(`${P}/me/notification-prefs`).set(h.bearer(member)).send({ prefs: [{ category: 'nope', channel: 'sms', enabled: false }] }).expect(422);
    const saved = await api().put(`${P}/me/notification-prefs`).set(h.bearer(member)).send({ prefs: [{ category: 'moderation', channel: 'sms', enabled: false }], quietHours: false }).expect(200);
    expect(saved.body.quietHours).toBe(false);
    expect(saved.body.categories.find((c) => c.category === 'moderation').channels.find((c) => c.channel === 'sms').enabled).toBe(false);

    await decideRole(master, member.user.id, 'active').expect(200);
    await h.drainEvents();
    expect(await models.Notification.count({ where: { userId: member.user.id } })).toBe(1); // the bell still gets it (FR-03)
    expect(await models.NotificationDelivery.count({ where: { userId: member.user.id } })).toBe(0);
  });

  it('inactive users only get security and money messages; missing contact details suppress the channel', async () => {
    const master = await h.createSignedInMaster();
    const member = await memberApplying();
    await decideRole(master, member.user.id, 'active').expect(200);
    await relay.relayOnce();
    for (const job of consumers.takeTestJobs()) await consumers.processConsume(job.data);
    await models.User.update({ status: 'banned' }, { where: { id: member.user.id } });
    const [d] = notify.takeTestJobs();
    expect(await notify.deliver(d.data)).toEqual({ status: 'suppressed', code: 'user_inactive' });

    // A suspension is security: it still goes out by SMS; email is suppressed (no email on file).
    const other = await h.signupUser();
    await api().post(`${P}/admin/users/${other.user.id}/suspend`).set(h.bearer(master)).send({ reasonCode: 'abuse', note: 'Abusive messages' }).expect(200);
    const results = await h.drainEvents();
    expect(results).toEqual(expect.arrayContaining([{ status: 'delivered' }, { status: 'suppressed', code: 'no_email' }]));
    expect(h.sms.lastTo(h.e164(other.phone)).text).toBe('Kriraghor: your account is suspended. Contact support if you think this is a mistake.');
  });
});

describe('quiet hours, rate limits and retries (M08-FR-10, FR-11, FR-13)', () => {
  it('defers non-urgent texts inside the quiet window and releases them after', async () => {
    const now = new Date();
    const dhaka = (d) => new Date(d.getTime() + 6 * 3600 * 1000).toISOString().slice(11, 16);
    await h.setSettingForTest('notify.quiet_hours_start', dhaka(new Date(now.getTime() - 3600 * 1000)));
    await h.setSettingForTest('notify.quiet_hours_end', dhaka(new Date(now.getTime() + 3600 * 1000)));
    const master = await h.createSignedInMaster();
    const member = await memberApplying();
    await decideRole(master, member.user.id, 'active').expect(200);
    expect(await h.drainEvents()).toEqual([]);
    const d = await models.NotificationDelivery.findOne({ where: { userId: member.user.id } });
    expect(d.status).toBe('deferred');
    expect(d.deliverAt.getTime()).toBeGreaterThan(Date.now());
    expect(await notify.releaseDeferred()).toEqual({ released: 0 });

    await models.NotificationDelivery.update({ deliverAt: new Date(Date.now() - 1000) }, { where: { id: d.id } });
    expect(await notify.releaseDeferred()).toEqual({ released: 1 });
    const [job] = notify.takeTestJobs();
    expect(await notify.deliver(job.data)).toEqual({ status: 'delivered' });
  });

  it('over the per-user SMS cap the text is dropped and the in-app notification kept', async () => {
    await h.setSettingForTest('notify.sms_per_user_per_hour', 1);
    const master = await h.createSignedInMaster();
    const member = await memberApplying();
    await decideRole(master, member.user.id, 'active').expect(200);
    await decideRole(master, member.user.id, 'suspended', { reasonCode: 'no_show' }).expect(200);
    const results = await h.drainEvents();
    expect(results).toEqual([{ status: 'delivered' }, { status: 'rate_limited' }]);
    expect(await models.Notification.count({ where: { userId: member.user.id } })).toBe(2);
  });

  it('retries a failing gateway, then marks the delivery failed', async () => {
    const master = await h.createSignedInMaster();
    const member = await memberApplying();
    await decideRole(master, member.user.id, 'active').expect(200);
    await relay.relayOnce();
    for (const job of consumers.takeTestJobs()) await consumers.processConsume(job.data);
    const [job] = notify.takeTestJobs();
    jest.spyOn(sms, 'send').mockRejectedValue(Object.assign(new Error('gateway timeout'), { code: 'ETIMEDOUT' }));
    await expect(notify.deliver(job.data, { attemptsMade: 0 })).rejects.toThrow('gateway timeout');
    await expect(notify.deliver(job.data, { attemptsMade: 1 })).rejects.toThrow('gateway timeout');
    expect(await models.NotificationDelivery.findByPk(job.data.deliveryId)).toMatchObject({ status: 'queued', attempts: 2, errorCode: 'ETIMEDOUT' });
    await expect(notify.deliver(job.data, { attemptsMade: 2 })).rejects.toThrow('gateway timeout');
    expect(await models.NotificationDelivery.findByPk(job.data.deliveryId)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(await notify.deliver(job.data)).toEqual({ status: 'failed', skipped: true });
    expect(notify.retryDelay(1)).toBe(30000);
    expect(notify.retryDelay(3)).toBe(600000);
    expect(notify.retryDelay(9)).toBe(600000);
  });

  it('fails a text without a delivery receipt after a day', async () => {
    const master = await h.createSignedInMaster();
    const member = await memberApplying();
    await decideRole(master, member.user.id, 'active').expect(200);
    await h.drainEvents();
    await models.NotificationDelivery.update({ status: 'sent', sentAt: new Date(Date.now() - 25 * 3600 * 1000) }, { where: { userId: member.user.id } });
    expect(await notify.dlrTimeout()).toEqual({ failed: 1 });
  });

  it('a missing template fails closed (no notification, the consumer retries)', async () => {
    await models.MessageTemplate.update({ isActive: false }, { where: { code: 'ROLE_ACTIVATED', channel: 'in_app' } });
    const master = await h.createSignedInMaster();
    const member = await memberApplying();
    await decideRole(master, member.user.id, 'active').expect(200);
    await relay.relayOnce();
    const job = consumers.takeTestJobs().find((j) => j.data.consumer === 'notify.ROLE_ACTIVATED');
    await expect(consumers.processConsume(job.data)).rejects.toThrow('No active template ROLE_ACTIVATED.in_app');
    expect(await models.Notification.count()).toBe(0);
  });
});

describe('OTP on the priority route (M08-FR-08, FR-15)', () => {
  it('logs the OTP SMS with the code redacted', async () => {
    const phone = h.nextPhone();
    await api().post(`${P}/auth/otp/send`).send({ target: phone, purpose: 'signup' }).expect(202);
    const code = h.lastCode(phone);
    const log = await models.SmsLog.findOne({ where: { route: 'otp' } });
    expect(log.bodyRedacted).toContain('••••••');
    expect(log.bodyRedacted).not.toContain(code);
    expect(log).toMatchObject({ deliveryId: null, status: 'sent', toPhoneMasked: expect.stringMatching(/\d{4}$/) });
  });

  it('a gateway failure is logged and the response does not change', async () => {
    jest.spyOn(sms, 'send').mockRejectedValue(new Error('down'));
    await api().post(`${P}/auth/otp/send`).send({ target: h.nextPhone(), purpose: 'signup' }).expect(202);
    expect(await models.SmsLog.findOne({ where: { route: 'otp' } })).toMatchObject({ status: 'failed', gatewayMessageId: null });
  });
});

describe('bell API (M08-FR-04, FR-05) and the support view', () => {
  async function memberWithThree() {
    const master = await h.createSignedInMaster();
    const member = await memberApplying();
    await decideRole(master, member.user.id, 'active').expect(200);
    await decideRole(master, member.user.id, 'suspended', { reasonCode: 'no_show' }).expect(200);
    await decideRole(master, member.user.id, 'active').expect(200);
    await h.drainEvents();
    // One minute apart, oldest first, so time-based reads are deterministic.
    const rows = await models.Notification.findAll({ where: { userId: member.user.id }, order: [['id', 'ASC']] });
    for (const [i, row] of rows.entries()) {
      await sequelize.query('UPDATE notifications SET created_at = clock_timestamp() - make_interval(mins => ?) WHERE id = ?', { replacements: [rows.length - i, row.id] });
    }
    return { master, member };
  }

  it('lists with a cursor, counts unread, marks read by id and all-before', async () => {
    const { master, member: stale } = await memberWithThree();
    const member = await fresh(stale);
    const page1 = await api().get(`${P}/me/notifications?limit=2`).set(h.bearer(member)).expect(200);
    expect(page1.body.items.map((i) => i.code)).toEqual(['ROLE_ACTIVATED', 'ROLE_SUSPENDED']);
    expect(page1.body.unreadCount).toBe(3);
    const page2 = await api().get(`${P}/me/notifications?limit=2&cursor=${page1.body.nextCursor}`).set(h.bearer(member)).expect(200);
    expect(page2.body.items.map((i) => i.code)).toEqual(['ROLE_ACTIVATED']);
    expect(page2.body.nextCursor).toBeNull();
    await api().get(`${P}/me/notifications?cursor=bad`).set(h.bearer(member)).expect(422);

    const read = await api().post(`${P}/me/notifications/read`).set(h.bearer(member)).send({ ids: [page1.body.items[0].id] }).expect(200);
    expect(read.body).toEqual({ updated: 1, unreadCount: 2 });
    expect(h.realtime.emitted()).toEqual(expect.arrayContaining([{ userId: member.user.id, name: 'notification.read', data: { unreadCount: 2 } }]));
    const unread = await api().get(`${P}/me/notifications?unread=true&category=moderation`).set(h.bearer(member)).expect(200);
    expect(unread.body.items).toHaveLength(2);

    const oldest = page2.body.items[0];
    const before = await api().post(`${P}/me/notifications/read`).set(h.bearer(member)).send({ all: true, before: oldest.createdAt }).expect(200);
    expect(before.body).toEqual({ updated: 1, unreadCount: 1 });
    const all = await api().post(`${P}/me/notifications/read`).set(h.bearer(member)).send({ all: true }).expect(200);
    expect(all.body.unreadCount).toBe(0);
    expect((await api().get(`${P}/me/notifications/unread-count`).set(h.bearer(member)).expect(200)).body).toEqual({ unreadCount: 0 });

    // Customer and admin audiences stay apart (ADR-004).
    await api().get(`${P}/admin/me/notifications`).set(h.bearer(member)).expect(401);
    await api().get(`${P}/me/notifications`).set(h.bearer(master)).expect(401);
  });

  it('staff with manage_users see deliveries with masked phones; others cannot', async () => {
    const { master, member } = await memberWithThree();
    const all = await api().get(`${P}/admin/notifications/deliveries?userId=${member.user.id}`).set(h.bearer(master)).expect(200);
    expect(all.body.items).toHaveLength(3);
    expect(all.body.items[0]).toMatchObject({ channel: 'sms', status: 'delivered', code: 'ROLE_ACTIVATED', phone: expect.stringMatching(/^\+8801•+\d{4}$/), segments: 1 });
    const suffix = h.e164(member.phone).slice(-4);
    const byPhone = await api().get(`${P}/admin/notifications/deliveries?phoneSuffix=${suffix}&code=ROLE_SUSPENDED`).set(h.bearer(master)).expect(200);
    expect(byPhone.body.items.map((i) => i.code)).toEqual(['ROLE_SUSPENDED']);

    const staffUser = await h.signupUser();
    const token = await h.stepUp(master, 'staff.write');
    await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', token).send({ userId: staffUser.user.id, employeeId: 'KG-N-1', permissions: ['approve_documents'] }).expect(201);
    const staff = await h.signInStaff(staffUser.phone, staffUser.user.id);
    await api().get(`${P}/admin/notifications/deliveries`).set(h.bearer(staff)).expect(403);
  });

  it('staff invitations and permission changes notify the staff member', async () => {
    const master = await h.createSignedInMaster();
    const staffUser = await h.signupUser();
    await withEmail(staffUser.user.id, 'nusrat@kriraghor.test');
    const token = await h.stepUp(master, 'staff.write');
    await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', token).send({ userId: staffUser.user.id, employeeId: 'KG-N-2', permissions: [] }).expect(201);
    const token2 = await h.stepUp(master, 'staff.write');
    await api()
      .put(`${P}/admin/staff/permissions`)
      .set(h.bearer(master))
      .set('X-Step-Up', token2)
      .send({ changes: [{ userId: staffUser.user.id, grant: ['manage_users'] }], reason: 'Support rota' })
      .expect(200);
    await h.drainEvents();
    expect((await notificationsOf(staffUser.user.id)).map((n) => n.code)).toEqual(['STAFF_INVITED', 'STAFF_PERMISSIONS_CHANGED']);
    expect(mail.lastTo('nusrat@kriraghor.test')).toMatchObject({ subject: 'Your Kriraghor staff permissions changed' });
    expect(mail.lastTo('nusrat@kriraghor.test').text).toContain('Added: manage_users');
  });
});
