'use strict';

/**
 * M23 follow alerts (in-app only; M08 category event_alerts). One alert row per key (idempotent) and a
 * cooldown per event and kind for stream alerts. The fan-out is paged: one
 * esports_event.followers_alerted event per `esports_events.fanout_batch` followers, carrying a
 * user-id range (never a list), so each page is its own M08 consumer transaction and the outbox holds
 * no user lists. M08 asks pageRecipients() for the page.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const models = require('../../models');
const rules = require('./events.rules');
const c = require('./events.common');

const { sequelize, EsportsEventAlert, EsportsEventFollow } = models;

/**
 * Send `kind` to the event's followers once per `key`. Stream alerts respect the cooldown. Runs in the
 * caller's transaction; returns the alert row or null when nothing was sent.
 */
async function send(eventId, kind, key, { transaction, now = new Date() }) {
  if (await EsportsEventAlert.count({ where: { key }, transaction })) return null;
  if (kind === 'stream_live') {
    const last = await EsportsEventAlert.findOne({ where: { eventId, kind }, order: [['sentAt', 'DESC']], transaction });
    if (!rules.cooldownOver(last?.sentAt, now, c.config().cooldownMinutes)) return null;
  }
  let alert;
  try {
    alert = await sequelize.transaction({ transaction }, (sp) => EsportsEventAlert.create({ eventId, kind, key, sentAt: now }, { transaction: sp }));
  } catch (err) {
    if (err instanceof UniqueConstraintError) return null;
    throw err;
  }
  const size = c.config().fanoutBatch;
  let after = null;
  let followers = 0;
  let pages = 0;
  for (;;) {
    const rows = await EsportsEventFollow.findAll({
      where: { eventId, status: 'active', ...(after ? { userId: { [Op.gt]: after } } : {}) },
      attributes: ['userId'],
      order: [['userId', 'ASC']],
      limit: size,
      transaction,
    });
    if (!rows.length) break;
    const from = rows[0].userId;
    const to = rows[rows.length - 1].userId;
    await c.publish(transaction, 'esports_event.followers_alerted', 'esports_event', eventId, { eventId, alertId: alert.id, kind, fromUserId: from, toUserId: to });
    followers += rows.length;
    pages += 1;
    after = to;
    if (rows.length < size) break;
  }
  await alert.update({ followerCount: followers, pages }, { transaction });
  return alert;
}

/** M08 recipients for one page: the event's active followers in [from, to]. */
async function pageRecipients({ eventId, fromUserId, toUserId }) {
  const rows = await EsportsEventFollow.findAll({ where: { eventId, status: 'active', userId: { [Op.between]: [fromUserId, toUserId] } }, attributes: ['userId'] });
  return rows.map((r) => r.userId);
}

module.exports = { send, pageRecipients };
