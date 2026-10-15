'use strict';

/**
 * NotificationService (M08). Routing (FR-01 to FR-03, FR-06, FR-10), delivery with suppression, rate
 * limits, logging and retries (FR-08, FR-11 to FR-13, FR-15), OTP on the priority route (FR-08), the
 * bell API (FR-04, FR-05) and preferences (§4.3).
 */
const { Op } = require('sequelize');
const config = require('../../config');
const logger = require('../../common/logger');
const { AppError, E } = require('../../common/errors');
const { hmac } = require('../../common/crypto');
const { getRedis } = require('../../common/redis');
const { sequelize, Notification, NotificationPref, NotificationDelivery, SmsLog } = require('../../models');
const settings = require('../settings/settings.service');
const directory = require('../users/directory.service');
const sms = require('../../providers/sms');
const email = require('../../providers/email');
const templates = require('./notify.templates');
const realtime = require('./notify.realtime');
const rules = require('./notify.rules');
const { emailHtml } = require('./notify.email');

const DELIVER_JOB = 'notify.deliver';
const MAX_DELIVERY_ATTEMPTS = 3; // FR-13: 30 s, 2 min, 10 min
const RETRY_DELAYS_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];
const QUIET = '_quiet_hours';

// ---------------------------------------------------------------- job dispatch
const testJobs = [];
function dispatchDeliver(deliveryId) {
  if (config.isTest) {
    testJobs.push({ name: DELIVER_JOB, data: { deliveryId } });
    return;
  }
  const { getQueue, QUEUES } = require('../../jobs/queues');
  getQueue(QUEUES.NOTIFY)
    .add(DELIVER_JOB, { deliveryId }, { jobId: `deliver-${deliveryId}`, attempts: MAX_DELIVERY_ATTEMPTS, backoff: { type: 'notify' }, removeOnComplete: 1000, removeOnFail: 5000 })
    .catch((err) => logger.warn({ err: err.message, deliveryId }, 'could not queue delivery; the release job will pick it up'));
}
const retryDelay = (attemptsMade) => RETRY_DELAYS_MS[Math.min(Math.max(attemptsMade, 1), RETRY_DELAYS_MS.length) - 1];

async function prefsFor(userIds, transaction) {
  const rows = await NotificationPref.findAll({ where: { userId: userIds }, transaction });
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.userId)) byUser.set(r.userId, new Map());
    byUser.get(r.userId).set(`${r.category}:${r.channel}`, r.enabled);
  }
  return byUser;
}

async function unreadCount(userId) {
  return Notification.count({ where: { userId, readAt: null, archivedAt: null } });
}

// ---------------------------------------------------------------- routing (one catalogue entry, one event)
/**
 * Create one notification per recipient plus a delivery row per other channel, in the consumer's
 * transaction (M04 inbox). Duplicates (same dedupe key) are skipped. Returns the created count.
 */
async function route(entry, event, { transaction }) {
  const userIds = [...new Set(await entry.recipients(event))];
  if (!userIds.length) return { created: 0 };
  const contacts = await directory.contactFor(userIds);
  const prefs = await prefsFor(userIds, transaction);
  const now = new Date();
  const windowHours = settings.get('notify.dedupe_hours');
  const quietStart = settings.get('notify.quiet_hours_start');
  const quietEnd = settings.get('notify.quiet_hours_end');
  let created = 0;

  for (const userId of userIds) {
    const contact = contacts.get(userId);
    if (!contact) continue;
    const locale = contact.locale === 'bn' ? 'bn' : 'en';
    const values = await entry.values(event, { locale, userId });
    const inApp = await templates.renderFor(entry.code, 'in_app', locale, values); // fails closed (FR-07)
    const dedupeKey = rules.dedupeKey({ code: entry.code, subjectId: event.id, userId, at: now, windowHours });
    let notification;
    try {
      // A savepoint, so a duplicate (FR-02) does not abort the consumer's transaction on Postgres.
      notification = await sequelize.transaction({ transaction }, (savepoint) =>
        Notification.create(
          {
            userId,
            code: entry.code,
            category: entry.category,
            roleContext: entry.roleContext?.(event) ?? null,
            title: (inApp.title ?? entry.code).slice(0, 140),
            body: inApp.body.slice(0, 500),
            link: entry.link?.(event) ?? null,
            data: { values },
            locale: inApp.locale,
            templateVersion: inApp.version,
            sourceEventId: event.id,
            dedupeKey,
          },
          { transaction: savepoint }
        )
      );
    } catch (err) {
      if (err?.name === 'SequelizeUniqueConstraintError') continue; // FR-02
      throw err;
    }
    created += 1;

    const userPrefs = prefs.get(userId) ?? new Map();
    const quietEnabled = userPrefs.get(`${QUIET}:sms`) !== false;
    const channels = rules.resolveChannels({ category: entry.category, channels: entry.channels.filter((c) => c !== 'in_app'), prefs: userPrefs });
    for (const channel of channels) {
      const at = rules.deliverAt({ now, urgent: Boolean(entry.urgent), channel, quietStart, quietEnd, quietEnabled });
      const delivery = await NotificationDelivery.create(
        { notificationId: notification.id, userId, channel, status: at > now ? 'deferred' : 'queued', deliverAt: at },
        { transaction }
      );
      if (delivery.status === 'queued') transaction.afterCommit(() => dispatchDeliver(delivery.id));
    }
    transaction.afterCommit(async () => {
      realtime.toUser(userId, 'notification.created', { notificationId: notification.id, unreadCount: await unreadCount(userId).catch(() => null) });
    });
  }
  return { created };
}

// ---------------------------------------------------------------- delivery
/** FR-11: Redis counters per user per hour and day. True when the SMS may go out. */
async function smsAllowed(userId) {
  const redis = getRedis();
  const now = new Date();
  const hourKey = `${config.redis.prefix}:notify:sms:${userId}:h:${now.toISOString().slice(0, 13)}`;
  const dayKey = `${config.redis.prefix}:notify:sms:${userId}:d:${now.toISOString().slice(0, 10)}`;
  const [[, hour], , [, day]] = await redis.multi().incr(hourKey).expire(hourKey, 3600).incr(dayKey).expire(dayKey, 86400).exec();
  return hour <= settings.get('notify.sms_per_user_per_hour') && day <= settings.get('notify.sms_per_user_per_day');
}

async function logSms({ deliveryId = null, route, phone, text, result, status }) {
  const { encoding, segments } = rules.smsSegments(text);
  await SmsLog.create({
    deliveryId,
    route,
    toPhoneHash: hmac(`phone:${phone}`),
    toPhoneMasked: rules.maskPhone(phone),
    gateway: result?.provider ?? config.sms.driver,
    encoding,
    segments,
    bodyRedacted: rules.redactCodes(text),
    gatewayMessageId: result?.messageId ?? null,
    status,
  });
}

/**
 * Job notify.deliver: send one channel of one notification. Throws on transient failures so BullMQ
 * retries; the last attempt marks the delivery failed (FR-13).
 */
async function deliver({ deliveryId }, { attemptsMade = 0 } = {}) {
  const d = await NotificationDelivery.findByPk(deliveryId);
  if (!d || d.status !== 'queued') return { status: d?.status ?? 'missing', skipped: true };
  if (d.deliverAt > new Date()) return { status: 'deferred', skipped: true };
  const n = await Notification.findByPk(d.notificationId);
  const contact = (await directory.contactFor([d.userId])).get(d.userId);

  const suppress = (code) => d.update({ status: 'suppressed', errorCode: code }).then(() => ({ status: 'suppressed', code }));
  // Edge case 5: inactive users get only security and money messages.
  if (!contact || (contact.status !== 'active' && !['security', 'money'].includes(n.category))) return suppress('user_inactive');
  if (d.channel === 'sms' && !contact.phone) return suppress('no_phone');
  if (d.channel === 'email' && !contact.email) return suppress('no_email');
  if (d.channel === 'sms' && !(await smsAllowed(d.userId))) {
    await d.update({ status: 'rate_limited', errorCode: 'sms_rate_limit' });
    return { status: 'rate_limited' };
  }

  const rendered = await templates.renderFor(n.code, d.channel, n.locale, n.data?.values ?? {});
  try {
    let result;
    if (d.channel === 'sms') {
      result = await sms.send({ to: contact.phone, text: rendered.body, route: 'trans' });
      await logSms({ deliveryId: d.id, route: 'trans', phone: contact.phone, text: rendered.body, result, status: 'sent' });
    } else {
      result = await email.send({ to: contact.email, subject: rendered.title, text: rendered.body, html: emailHtml(rendered, n.locale) });
    }
    const now = new Date();
    await d.update({ status: result.delivered ? 'delivered' : 'sent', attempts: d.attempts + 1, provider: result.provider, providerMessageId: result.messageId, sentAt: now, deliveredAt: result.delivered ? now : null, errorCode: null });
    return { status: d.status };
  } catch (err) {
    const last = attemptsMade + 1 >= MAX_DELIVERY_ATTEMPTS;
    await d.update({ attempts: d.attempts + 1, errorCode: String(err?.code ?? err?.message ?? 'send_failed').slice(0, 60), ...(last ? { status: 'failed' } : {}) });
    logger.warn({ deliveryId, channel: d.channel, attempt: attemptsMade + 1, err: err?.message }, last ? 'delivery failed' : 'delivery will retry');
    throw err;
  }
}

/** Job notify.release-deferred: quiet hours are over for these (FR-10). */
async function releaseDeferred() {
  const due = await NotificationDelivery.findAll({ where: { status: 'deferred', deliverAt: { [Op.lte]: sequelize.literal('clock_timestamp()') } }, attributes: ['id'], limit: 1000 });
  if (!due.length) return { released: 0 };
  const ids = due.map((r) => r.id);
  await NotificationDelivery.update({ status: 'queued' }, { where: { id: ids, status: 'deferred' } });
  ids.forEach(dispatchDeliver);
  return { released: ids.length };
}

/** Job notify.dlr-timeout: SMS accepted more than a day ago with no receipt are failed (§10). */
async function dlrTimeout() {
  const [n] = await NotificationDelivery.update(
    { status: 'failed', errorCode: 'dlr_timeout' },
    { where: { status: 'sent', channel: 'sms', sentAt: { [Op.lt]: new Date(Date.now() - 24 * 3600 * 1000) } } }
  );
  return { failed: n };
}

// ---------------------------------------------------------------- OTP (FR-08)
/**
 * Priority path for M01: sends at once (no quiet hours, no M08 rate limit) and logs the SMS with the
 * code redacted. Never throws: the caller answers the same way whether delivery worked or not.
 */
async function sendOtp({ target, text, email: mail }) {
  try {
    if (target.type === 'phone') {
      let result = null;
      let status = 'sent';
      try {
        result = await sms.send({ to: target.value, text, route: 'otp' });
      } catch (err) {
        status = 'failed';
        logger.error({ err: err.message }, 'OTP SMS failed');
      }
      await logSms({ route: 'otp', phone: target.value, text, result, status });
    } else {
      await email.send({ to: target.value, ...mail });
    }
  } catch (err) {
    logger.error({ err: err.message }, 'OTP send failed');
  }
}

// ---------------------------------------------------------------- bell API (FR-04, FR-05)
const encodeCursor = (row) => Buffer.from(`${new Date(row.createdAt).toISOString()}|${row.id}`).toString('base64url');
function decodeCursor(cursor) {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!id || Number.isNaN(Date.parse(at))) throw E.validation([{ field: 'cursor', message: 'Invalid cursor' }]);
  return { at: new Date(at), id };
}

function serialize(n) {
  return {
    id: n.id,
    code: n.code,
    category: n.category,
    roleContext: n.roleContext ?? null,
    title: n.title,
    body: n.body,
    link: n.link ?? null,
    readAt: n.readAt ? new Date(n.readAt).toISOString() : null,
    createdAt: new Date(n.createdAt).toISOString(),
  };
}

async function list(userId, { unread, category, cursor, limit = 20 } = {}) {
  const where = { userId, archivedAt: null };
  if (unread) where.readAt = null;
  if (category) where.category = category;
  if (cursor) {
    const c = decodeCursor(cursor);
    where[Op.or] = [{ createdAt: { [Op.lt]: c.at } }, { createdAt: c.at, id: { [Op.lt]: c.id } }];
  }
  const rows = await Notification.findAll({ where, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  return { items: page.map(serialize), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null, unreadCount: await unreadCount(userId) };
}

/** {ids} or {all: true, before}: `before` keeps a newer arrival unread (FR-05). */
async function markRead(userId, { ids, all, before }) {
  const where = { userId, readAt: null };
  if (all) where.createdAt = { [Op.lte]: before ? new Date(before) : new Date() };
  else where.id = ids;
  const [updated] = await Notification.update({ readAt: new Date() }, { where });
  const count = await unreadCount(userId);
  realtime.toUser(userId, 'notification.read', { unreadCount: count });
  return { updated, unreadCount: count };
}

// ---------------------------------------------------------------- preferences (§4.3, FR-06)
const PREF_CATEGORIES = Object.keys(rules.CATEGORIES).filter((c) => c !== 'staff_ops');

async function getPrefs(userId) {
  const map = (await prefsFor([userId])).get(userId) ?? new Map();
  const contact = (await directory.contactFor([userId])).get(userId);
  return {
    categories: PREF_CATEGORIES.map((category) => ({
      category,
      channels: rules.CHANNELS.map((channel) => {
        const locked = rules.isMandatory(category, channel);
        const offered = rules.CATEGORIES[category].defaults.includes(channel) || locked;
        return { channel, enabled: offered && (locked || map.get(`${category}:${channel}`) !== false), locked, offered };
      }),
    })),
    quietHours: map.get(`${QUIET}:sms`) !== false,
    quietWindow: { start: settings.get('notify.quiet_hours_start'), end: settings.get('notify.quiet_hours_end') },
    locale: contact?.locale ?? 'en',
  };
}

async function putPrefs(userId, { prefs = [], quietHours }) {
  for (const p of prefs) {
    if (!rules.CATEGORIES[p.category] || p.category === 'staff_ops') throw E.validation([{ field: 'category', message: `Unknown category ${p.category}` }]);
    if (!p.enabled && rules.isMandatory(p.category, p.channel)) {
      throw new AppError(422, 'PREF_MANDATORY', 'This one cannot be turned off', { detail: 'Required for your security and payments', errors: [{ field: `${p.category}.${p.channel}`, message: 'Required' }] });
    }
  }
  await sequelize.transaction(async (transaction) => {
    for (const p of prefs) await NotificationPref.upsert({ userId, category: p.category, channel: p.channel, enabled: p.enabled }, { transaction });
    if (quietHours !== undefined) await NotificationPref.upsert({ userId, category: QUIET, channel: 'sms', enabled: quietHours }, { transaction });
  });
  return getPrefs(userId);
}

// ---------------------------------------------------------------- support view (masked)
async function deliveries({ userId, code, status, phoneSuffix, limit = 50 }) {
  const where = {};
  if (userId) where.userId = userId;
  if (status) where.status = status;
  const include = [{ model: Notification, as: 'notification', attributes: ['code', 'category', 'title'], ...(code ? { where: { code } } : {}) }];
  if (phoneSuffix) {
    const logs = await SmsLog.findAll({ where: { toPhoneMasked: { [Op.like]: `%${phoneSuffix}` } }, attributes: ['deliveryId'], limit: 500 });
    where.id = logs.map((l) => l.deliveryId).filter(Boolean);
  }
  const rows = await NotificationDelivery.findAll({ where, include, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit });
  const logs = new Map((await SmsLog.findAll({ where: { deliveryId: rows.map((r) => r.id) } })).map((l) => [l.deliveryId, l]));
  return {
    items: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      code: r.notification?.code ?? null,
      category: r.notification?.category ?? null,
      channel: r.channel,
      status: r.status,
      attempts: r.attempts,
      provider: r.provider ?? null,
      errorCode: r.errorCode ?? null,
      phone: logs.get(r.id)?.toPhoneMasked ?? null,
      segments: logs.get(r.id)?.segments ?? null,
      deliverAt: new Date(r.deliverAt).toISOString(),
      sentAt: r.sentAt ? new Date(r.sentAt).toISOString() : null,
      createdAt: new Date(r.createdAt).toISOString(),
    })),
  };
}

module.exports = {
  DELIVER_JOB,
  route,
  deliver,
  releaseDeferred,
  dlrTimeout,
  sendOtp,
  list,
  markRead,
  unreadCount,
  getPrefs,
  putPrefs,
  deliveries,
  retryDelay,
  takeTestJobs: () => testJobs.splice(0, testJobs.length),
};
