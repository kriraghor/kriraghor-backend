'use strict';

/**
 * M08 push channel for the mobile app: device registration, sending and receipts.
 *
 * Push mirrors the bell (notify.rules.withPush): the message is the in-app title and text, already in
 * the recipient's language (FR-07), plus the notification id, code and link so the app can open the
 * right screen. Nothing else from the notification goes out; the in-app texts never carry room
 * credentials, NID or account numbers (M21-FR-15/16), and a test holds push to the same rule.
 *
 * A device is tied to the sign-in that registered it (session family): after a sign-out, a "sign out
 * everywhere" or a suspension, that device gets nothing until the app signs in and registers again.
 */
const { Op } = require('sequelize');
const logger = require('../../common/logger');
const { E } = require('../../common/errors');
const { sequelize, PushSubscription, PushReceipt, NotificationDelivery } = require('../../models');
const settings = require('../settings').settings;
const sessions = require('../auth').session;
const push = require('../../providers/push');

const tail = (token) => String(token).slice(-6);

function serialize(sub, currentFamilyId) {
  return {
    id: sub.id,
    platform: sub.platform,
    deviceLabel: sub.deviceLabel ?? null,
    tokenTail: tail(sub.token),
    current: Boolean(currentFamilyId && sub.sessionFamilyId === currentFamilyId),
    lastUsedAt: sub.lastUsedAt ? new Date(sub.lastUsedAt).toISOString() : null,
    createdAt: new Date(sub.createdAt).toISOString(),
  };
}

const revoke = (where, reason, transaction) => PushSubscription.update({ revokedAt: new Date(), revokeReason: reason }, { where: { ...where, revokedAt: null }, transaction });

// ---------------------------------------------------------------- devices (/me/push-subscriptions)
/**
 * Register this phone's token for the signed-in user. Idempotent per token: the same token again
 * refreshes the row (and moves it to this sign-in). A token active on another account moves to this
 * one (the phone changed hands or accounts). Past notify.push_max_devices, the least recently used
 * device of this user is dropped. Returns { created, device }.
 */
async function subscribe(userId, familyId, { token, platform, deviceLabel }) {
  if (platform === 'expo' && !push.EXPO_TOKEN.test(token)) throw E.validation([{ field: 'token', message: 'Not an Expo push token' }]);
  return sequelize.transaction(async (transaction) => {
    const existing = await PushSubscription.findOne({ where: { token, revokedAt: null }, transaction, lock: transaction.LOCK.UPDATE });
    if (existing && existing.userId === userId) {
      await existing.update({ sessionFamilyId: familyId, deviceLabel: deviceLabel ?? existing.deviceLabel, platform }, { transaction });
      return { created: false, device: serialize(existing, familyId) };
    }
    if (existing) await revoke({ id: existing.id }, 'other_account', transaction);
    // One token per sign-in: an app that got a new token replaces the one it registered before.
    if (familyId) await revoke({ userId, sessionFamilyId: familyId }, 'replaced', transaction);

    const max = settings.get('notify.push_max_devices');
    const active = await PushSubscription.findAll({ where: { userId, revokedAt: null }, order: [[sequelize.literal('COALESCE(last_used_at, created_at)'), 'ASC']], attributes: ['id'], transaction });
    const over = active.length - (max - 1);
    if (over > 0) await revoke({ id: active.slice(0, over).map((r) => r.id) }, 'device_limit', transaction);

    const sub = await PushSubscription.create({ userId, platform, token, sessionFamilyId: familyId, deviceLabel: deviceLabel ?? null }, { transaction });
    return { created: true, device: serialize(sub, familyId) };
  });
}

async function listDevices(userId, familyId) {
  const rows = await PushSubscription.findAll({ where: { userId, revokedAt: null }, order: [['createdAt', 'DESC']] });
  return { items: rows.map((r) => serialize(r, familyId)) };
}

/** Stop pushes to one of the user's devices (the app calls this before signing out). */
async function unsubscribe(userId, id) {
  const [n] = await revoke({ id, userId }, 'removed');
  if (!n && !(await PushSubscription.findOne({ where: { id, userId } }))) throw E.notFound('Device');
}

// ---------------------------------------------------------------- sending
/** Users among these with at least one device that can receive (used when routing, FR-06). */
async function reachable(userIds, { transaction } = {}) {
  if (!userIds.length) return new Set();
  const rows = await PushSubscription.findAll({ where: { userId: userIds, revokedAt: null }, attributes: ['userId', 'sessionFamilyId'], transaction });
  const live = await sessions.activeFamilies([...new Set(rows.map((r) => r.sessionFamilyId).filter(Boolean))]);
  return new Set(rows.filter((r) => live.has(r.sessionFamilyId)).map((r) => r.userId));
}

/** The message for one device: the bell's title and text, plus where the app should open. */
function message(token, notification, { urgent }) {
  return {
    to: token,
    title: notification.title,
    body: notification.body,
    data: { notificationId: notification.id, code: notification.code, link: notification.link ?? null },
    sound: 'default',
    priority: urgent ? 'high' : 'default',
    channelId: urgent ? 'urgent' : 'default',
  };
}

/**
 * Send one push delivery to every live device of the user. Returns { status, provider, messageId,
 * errorCode }: 'sent' when the provider accepted at least one message, 'suppressed' with no_device
 * when there is nowhere to send. Throws when the provider could not be reached (the delivery retries).
 */
async function send(delivery, notification, { urgent = false } = {}) {
  const subs = await PushSubscription.findAll({ where: { userId: delivery.userId, revokedAt: null } });
  const live = await sessions.activeFamilies([...new Set(subs.map((s) => s.sessionFamilyId).filter(Boolean))]);
  const targets = subs.filter((s) => live.has(s.sessionFamilyId));
  if (!targets.length) return { status: 'suppressed', errorCode: 'no_device' };

  const tickets = await push.send(targets.map((s) => message(s.token, notification, { urgent })));
  const now = new Date();
  let firstId = null;
  await sequelize.transaction(async (transaction) => {
    for (const [i, t] of tickets.entries()) {
      const sub = targets[i];
      if (t.ok) {
        firstId ??= t.id;
        await PushReceipt.create({ deliveryId: delivery.id, subscriptionId: sub.id, ticketId: t.id }, { transaction });
        await sub.update({ lastUsedAt: now }, { transaction });
      } else if (t.error === 'DeviceNotRegistered') {
        await revoke({ id: sub.id }, 'device_not_registered', transaction);
      } else {
        logger.warn({ deliveryId: delivery.id, error: t.error }, 'push rejected for one device');
      }
    }
  });
  if (firstId) return { status: 'sent', provider: push.name(), messageId: firstId };
  const errors = tickets.map((t) => t.error);
  return { status: 'suppressed', errorCode: errors.every((e) => e === 'DeviceNotRegistered') ? 'no_device' : String(errors[0] ?? 'push_rejected').slice(0, 60) };
}

// ---------------------------------------------------------------- receipts (job notify.push-receipts)
/**
 * Ask the provider how the accepted messages ended, once notify.push_receipt_delay_minutes have
 * passed. ok → the delivery is delivered; DeviceNotRegistered → that device is revoked; no answer
 * after notify.push_receipt_expire_hours → expired.
 */
async function checkReceipts({ batch = 500 } = {}) {
  const due = new Date(Date.now() - settings.get('notify.push_receipt_delay_minutes') * 60000);
  const rows = await PushReceipt.findAll({ where: { status: 'pending', createdAt: { [Op.lte]: due } }, order: [['createdAt', 'ASC']], limit: batch });
  if (!rows.length) return { checked: 0 };
  const answers = await push.receipts(rows.map((r) => r.ticketId));
  const expireBefore = Date.now() - settings.get('notify.push_receipt_expire_hours') * 3600000;
  const counts = { ok: 0, error: 0, expired: 0, revoked: 0 };
  const now = new Date();
  for (const r of rows) {
    const a = answers.get(r.ticketId);
    if (!a) {
      if (new Date(r.createdAt).getTime() < expireBefore) {
        await r.update({ status: 'expired', checkedAt: now });
        counts.expired += 1;
      }
      continue;
    }
    await sequelize.transaction(async (transaction) => {
      if (a.ok) {
        await r.update({ status: 'ok', checkedAt: now }, { transaction });
        await NotificationDelivery.update({ status: 'delivered', deliveredAt: now }, { where: { id: r.deliveryId, status: 'sent' }, transaction });
        counts.ok += 1;
      } else {
        await r.update({ status: 'error', errorCode: String(a.error).slice(0, 60), checkedAt: now }, { transaction });
        counts.error += 1;
        if (a.error === 'DeviceNotRegistered') {
          const [n] = await revoke({ id: r.subscriptionId }, 'device_not_registered', transaction);
          counts.revoked += n;
        }
      }
    });
  }
  return { checked: rows.length, ...counts };
}

module.exports = { subscribe, listDevices, unsubscribe, reachable, message, send, checkReceipts };
