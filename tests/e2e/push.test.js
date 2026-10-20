'use strict';

// M08 push channel for the mobile app: device registration, push mirroring the bell, preferences,
// sign-out, dead tokens, receipts, urgency, and no secrets in a push (M21-FR-15/16).
const fs = require('fs');
const path = require('path');
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const push = require('../../src/providers/push');
const notify = require('../../src/modules/notifications/notify.service');

const { api, P, models } = h;
const { sequelize } = models;

beforeEach(async () => {
  await h.resetDb();
  push.clear();
});
afterAll(async () => {
  await closeAllRedis();
  await sequelize.close();
});

let seq = 0;
const tokenOf = () => `ExponentPushToken[demoToken${String((seq += 1)).padStart(6, '0')}x]`;
const register = (member, token, extra = {}) => api().post(`${P}/me/push-subscriptions`).set(h.bearer(member)).send({ token, platform: 'expo', deviceLabel: 'Galaxy A54', ...extra });

/** A member with an active ground_owner role decision pending (ROLE_ACTIVATED goes in-app + SMS). */
async function memberApplying(opts) {
  const member = await h.signupUser({ role: 'ground_owner', ...opts });
  await h.verifyMember(member.user.id);
  // KYC bumps the authz version (M01-FR-08): refresh, as the app does, before calling the API.
  const r = await h.refreshWeb(member.cookie).expect(200);
  return { ...member, accessToken: r.body.accessToken };
}
const activate = (master, userId) => api().post(`${P}/admin/users/${userId}/roles/ground_owner/status`).set(h.bearer(master)).send({ status: 'active' }).expect(200);
const pushDeliveries = (userId) => models.NotificationDelivery.findAll({ where: { userId, channel: 'push' } });

describe('registering a phone (POST/GET/DELETE /me/push-subscriptions)', () => {
  it('registers once per token, never returns the token, and stops on delete', async () => {
    const member = await h.signupUser();
    const token = tokenOf();
    await api().post(`${P}/me/push-subscriptions`).send({ token, platform: 'expo' }).expect(401);
    const bad = await register(member, 'not-a-token-at-all').expect(422);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    await register(member, token, { platform: 'web' }).expect(422);

    const first = await register(member, token).expect(201);
    expect(first.body).toMatchObject({ platform: 'expo', deviceLabel: 'Galaxy A54', tokenTail: token.slice(-6), current: true });
    expect(JSON.stringify(first.body)).not.toContain(token);
    const again = await register(member, token, { deviceLabel: 'Pixel 8' }).expect(200);
    expect(again.body).toMatchObject({ id: first.body.id, deviceLabel: 'Pixel 8' });

    const list = await api().get(`${P}/me/push-subscriptions`).set(h.bearer(member)).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(token);

    await api().delete(`${P}/me/push-subscriptions/${first.body.id}`).set(h.bearer(member)).expect(204);
    await api().delete(`${P}/me/push-subscriptions/${first.body.id}`).set(h.bearer(member)).expect(204); // already removed: same answer
    expect((await api().get(`${P}/me/push-subscriptions`).set(h.bearer(member)).expect(200)).body.items).toEqual([]);
    expect(await models.PushSubscription.findByPk(first.body.id)).toMatchObject({ revokeReason: 'removed' }); // kept, not deleted
  });

  it("a token moves to the account that registers it; another member cannot remove someone else's device", async () => {
    const a = await h.signupUser();
    const b = await h.signupUser();
    const token = tokenOf();
    const fromA = await register(a, token).expect(201);
    await api().delete(`${P}/me/push-subscriptions/${fromA.body.id}`).set(h.bearer(b)).expect(404);
    await register(b, token).expect(201);
    expect(await models.PushSubscription.findByPk(fromA.body.id)).toMatchObject({ revokeReason: 'other_account' });
    expect(await models.PushSubscription.count({ where: { token, revokedAt: null } })).toBe(1);
  });

  it('a new token from the same sign-in replaces the old one; past notify.push_max_devices the least used phone goes', async () => {
    await h.setSettingForTest('notify.push_max_devices', 2);
    const member = await h.signupUser();
    const one = await register(member, tokenOf()).expect(201);
    const two = await register(member, tokenOf()).expect(201);
    expect(await models.PushSubscription.findByPk(one.body.id)).toMatchObject({ revokeReason: 'replaced' });

    // Two other phones (other sign-ins), one idle for two days.
    const idle = await models.PushSubscription.create({ userId: member.user.id, platform: 'expo', token: tokenOf(), lastUsedAt: new Date(Date.now() - 2 * 86400000) });
    const recent = await models.PushSubscription.create({ userId: member.user.id, platform: 'expo', token: tokenOf(), lastUsedAt: new Date(Date.now() - 3600000) });
    const three = await register(member, tokenOf()).expect(201);
    expect(await models.PushSubscription.findByPk(two.body.id)).toMatchObject({ revokeReason: 'replaced' });
    expect(await models.PushSubscription.findByPk(idle.id)).toMatchObject({ revokeReason: 'device_limit' });
    const active = await models.PushSubscription.findAll({ where: { userId: member.user.id, revokedAt: null } });
    expect(active.map((s) => s.id).sort()).toEqual([recent.id, three.body.id].sort());
  });
});

describe('push mirrors the bell (M08 push channel)', () => {
  it("sends the in-app title and text in the user's language, with where to open; receipts mark it delivered", async () => {
    const master = await h.createSignedInMaster();
    const member = await memberApplying();
    await models.User.update({ locale: 'bn' }, { where: { id: member.user.id } });
    const token = tokenOf();
    await register(member, token).expect(201);

    await activate(master, member.user.id);
    const results = await h.drainEvents();
    expect(results).toEqual(expect.arrayContaining([{ status: 'sent' }]));
    const [n] = await models.Notification.findAll({ where: { userId: member.user.id } });
    const sent = push.lastTo(token);
    expect(sent).toMatchObject({ title: n.title, body: n.body, priority: 'default', data: { notificationId: n.id, code: 'ROLE_ACTIVATED', link: n.link } });
    expect(n.locale).toBe('bn');
    expect(Object.keys(sent.data).sort()).toEqual(['code', 'link', 'notificationId']); // nothing else from the notification

    const [d] = await pushDeliveries(member.user.id);
    expect(d).toMatchObject({ status: 'sent', provider: 'memory' });
    expect(await notify.checkPushReceipts()).toEqual({ checked: 0 }); // not before notify.push_receipt_delay_minutes
    await models.PushReceipt.update({ createdAt: new Date(Date.now() - 20 * 60000) }, { where: { deliveryId: d.id } });
    expect(await notify.checkPushReceipts()).toMatchObject({ checked: 1, ok: 1 });
    expect(await models.NotificationDelivery.findByPk(d.id)).toMatchObject({ status: 'delivered' });
  });

  it('members without a phone get no push row; a category turned off gets none either', async () => {
    const master = await h.createSignedInMaster();
    const noPhone = await memberApplying();
    await activate(master, noPhone.user.id);
    await h.drainEvents();
    expect(await pushDeliveries(noPhone.user.id)).toHaveLength(0);

    const member = await memberApplying();
    await register(member, tokenOf()).expect(201);
    const prefs = await api().get(`${P}/me/notification-prefs`).set(h.bearer(member)).expect(200);
    const cell = prefs.body.categories.find((c) => c.category === 'moderation').channels.find((c) => c.channel === 'push');
    expect(cell).toEqual({ channel: 'push', enabled: true, locked: false, offered: true });
    await api().put(`${P}/me/notification-prefs`).set(h.bearer(member)).send({ prefs: [{ category: 'moderation', channel: 'push', enabled: false }] }).expect(200);
    await activate(master, member.user.id);
    await h.drainEvents();
    expect(await models.Notification.count({ where: { userId: member.user.id } })).toBe(1);
    expect(await pushDeliveries(member.user.id)).toHaveLength(0);
  });

  it('signing out stops pushes to that phone', async () => {
    const master = await h.createSignedInMaster();
    const member = await memberApplying();
    await register(member, tokenOf()).expect(201);
    await api().post(`${P}/auth/logout`).set(h.bearer(member)).expect(204);
    await activate(master, member.user.id);
    await h.drainEvents();
    expect(await pushDeliveries(member.user.id)).toHaveLength(0);
    expect(push.sent()).toHaveLength(0);
  });

  it('urgent notifications go out at high priority, through quiet hours', async () => {
    const now = new Date();
    const dhaka = (d) => new Date(d.getTime() + 6 * 3600 * 1000).toISOString().slice(11, 16);
    await h.setSettingForTest('notify.quiet_hours_start', dhaka(new Date(now.getTime() - 3600 * 1000)));
    await h.setSettingForTest('notify.quiet_hours_end', dhaka(new Date(now.getTime() + 3600 * 1000)));
    const member = await h.signupUser({ password: 'Correct-Horse-91' });
    const token = tokenOf();
    await register(member, token).expect(201);
    await api().post(`${P}/me/password`).set(h.bearer(member)).send({ currentPassword: 'Correct-Horse-91', newPassword: 'Battery-Staple-73' }).expect(204);
    await h.drainEvents();
    expect(push.lastTo(token)).toMatchObject({ priority: 'high', channelId: 'urgent', data: { code: 'PASSWORD_CHANGED' } });
  });

  it('non-urgent pushes wait for the end of quiet hours like texts do', async () => {
    const now = new Date();
    const dhaka = (d) => new Date(d.getTime() + 6 * 3600 * 1000).toISOString().slice(11, 16);
    await h.setSettingForTest('notify.quiet_hours_start', dhaka(new Date(now.getTime() - 3600 * 1000)));
    await h.setSettingForTest('notify.quiet_hours_end', dhaka(new Date(now.getTime() + 3600 * 1000)));
    const master = await h.createSignedInMaster();
    const member = await memberApplying();
    await register(member, tokenOf()).expect(201);
    await activate(master, member.user.id);
    await h.drainEvents();
    const [d] = await pushDeliveries(member.user.id);
    expect(d.status).toBe('deferred');
    expect(push.sent()).toHaveLength(0);
  });
});

describe('dead tokens and failures', () => {
  it('a token the provider rejects at once is revoked and the delivery suppressed', async () => {
    const master = await h.createSignedInMaster();
    const member = await memberApplying();
    const token = tokenOf();
    const reg = await register(member, token).expect(201);
    push.markDead(token, 'ticket');
    await activate(master, member.user.id);
    expect(await h.drainEvents()).toEqual(expect.arrayContaining([{ status: 'suppressed', code: 'no_device' }]));
    expect(await models.PushSubscription.findByPk(reg.body.id)).toMatchObject({ revokeReason: 'device_not_registered' });
  });

  it('a token found dead in the receipt is revoked; a receipt that never comes expires', async () => {
    const master = await h.createSignedInMaster();
    const member = await memberApplying();
    const token = tokenOf();
    const reg = await register(member, token).expect(201);
    push.markDead(token, 'receipt');
    await activate(master, member.user.id);
    await h.drainEvents();
    await models.PushReceipt.update({ createdAt: new Date(Date.now() - 20 * 60000) }, { where: {} });
    expect(await notify.checkPushReceipts()).toMatchObject({ checked: 1, error: 1, revoked: 1 });
    expect(await models.PushSubscription.findByPk(reg.body.id)).toMatchObject({ revokeReason: 'device_not_registered' });
    expect(await models.PushReceipt.findOne()).toMatchObject({ status: 'error', errorCode: 'DeviceNotRegistered' });

    // A receipt the provider never answers for: expired after notify.push_receipt_expire_hours.
    const d = await models.NotificationDelivery.findOne({ where: { channel: 'push' } });
    await models.PushReceipt.create({ deliveryId: d.id, subscriptionId: reg.body.id, ticketId: 'never-answered', createdAt: new Date(Date.now() - 25 * 3600000) });
    expect(await notify.checkPushReceipts()).toMatchObject({ checked: 1, expired: 1 });
  });

  it('retries when the provider cannot be reached, then marks the delivery failed', async () => {
    const master = await h.createSignedInMaster();
    const member = await memberApplying();
    await register(member, tokenOf()).expect(201);
    await activate(master, member.user.id);
    const relay = require('../../src/modules/events/events.relay');
    await relay.relayOnce();
    for (const job of h.consumers.takeTestJobs()) await h.consumers.processConsume(job.data);
    const jobs = notify.takeTestJobs();
    const d = await models.NotificationDelivery.findOne({ where: { userId: member.user.id, channel: 'push' } });
    const job = jobs.find((j) => j.data.deliveryId === d.id);
    jest.spyOn(push, 'send').mockRejectedValue(Object.assign(new Error('Expo push answered 503'), { code: 'expo_http_503' }));
    await expect(notify.deliver(job.data, { attemptsMade: 0 })).rejects.toThrow('503');
    await expect(notify.deliver(job.data, { attemptsMade: 2 })).rejects.toThrow('503');
    expect(await models.NotificationDelivery.findByPk(d.id)).toMatchObject({ status: 'failed', attempts: 2, errorCode: 'expo_http_503' });
    jest.restoreAllMocks();
  });
});

describe('no secrets in a push (M21-FR-15/16)', () => {
  it('push carries only in-app texts, and no in-app template takes room credentials, NID or account numbers', () => {
    const templates = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/db/seed/reference/templates.v1.json'), 'utf8'));
    const list = Array.isArray(templates) ? templates : templates.templates;
    const inApp = list.filter((t) => t.channel === 'in_app');
    expect(inApp.length).toBeGreaterThan(100);
    const SECRET = /password|passcode|room_?id|roomCode|credential|nid|account_?number|accountNo|otp/i; // `code` is a booking or order reference, not a secret
    const offending = inApp.flatMap((t) => (t.variables ?? []).filter((v) => SECRET.test(v.name)).map((v) => `${t.code}.${v.name}`));
    expect(offending).toEqual([]);
    const room = inApp.filter((t) => t.code === 'ESPORTS_ROOM_READY');
    expect(room.map((t) => t.variables.map((v) => v.name).sort())).toEqual([['match', 'title'], ['match', 'title']]);
  });
});
