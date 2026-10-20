'use strict';

/**
 * M23 event feed: an append-only timeline (tournament finalised or cancelled, entries qualified, a
 * stream went live, the final is live, staff announcements). Items carry ids and counts; the apps
 * render the words. Each new item pings the event room after commit.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const models = require('../../models');
const audit = require('../audit').audit;
const reads = require('../esports').reads;
const c = require('./events.common');

const { sequelize, EsportsEvent, EsportsEventFeedItem } = models;

async function add(transaction, eventId, { kind, tournamentId = null, refId = null, textEn = null, textBn = null, data = {}, actorId = null }) {
  const item = await EsportsEventFeedItem.create({ eventId, kind, tournamentId, refId, textEn, textBn, data, actorId }, { transaction });
  c.ping(transaction, eventId, 'esports_event.feed_added', { itemId: item.id });
  return item;
}

/** Whether an item of this kind already exists for the tournament (once-only items from the tick). */
const has = async (eventId, kind, tournamentId, { transaction } = {}) => (await EsportsEventFeedItem.count({ where: { eventId, kind, tournamentId }, transaction })) > 0;

const cursorOf = (i) => `${i.createdAt.toISOString()}_${i.id}`;

/** GET /esports/events/:id/feed?before= : newest first. */
async function page(eventId, { before, limit } = {}) {
  const size = Math.min(limit ?? c.config().feedPageSize, 100);
  const where = { eventId };
  if (before) {
    const i = before.lastIndexOf('_');
    const at = new Date(before.slice(0, i));
    const id = before.slice(i + 1);
    where[Op.or] = [{ createdAt: { [Op.lt]: at } }, { createdAt: at, id: { [Op.lt]: id } }];
  }
  const rows = await EsportsEventFeedItem.findAll({ where, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: size + 1 });
  const items = rows.slice(0, size);
  const titles = await reads.tournamentSummary(items.map((i) => i.tournamentId).filter(Boolean));
  return {
    items: items.map((i) => {
      const t = i.tournamentId ? titles.get(i.tournamentId) : null;
      return {
        id: i.id,
        kind: i.kind,
        tournament: t ? { id: t.id, slug: t.slug, titleEn: t.titleEn, titleBn: t.titleBn } : null,
        textEn: i.textEn ?? null,
        textBn: i.textBn ?? null,
        data: i.data,
        createdAt: i.createdAt,
      };
    }),
    nextCursor: rows.length > size ? cursorOf(items[items.length - 1]) : null,
  };
}

/** POST /admin/esports/events/:id/feed: a staff announcement ("The grand final starts in 10 minutes"). */
async function announce(actor, eventId, { textEn, textBn }, req) {
  return sequelize.transaction(async (transaction) => {
    const event = await EsportsEvent.findByPk(eventId, { transaction });
    if (!event) throw E.notFound('Event');
    if (event.status !== 'published') throw c.fail('EVENT_STATE');
    const item = await add(transaction, eventId, { kind: 'announcement', textEn: textEn.trim(), textBn: textBn.trim(), actorId: actor.id });
    await audit.record({ action: 'esports_event.announced', actor, entityType: 'esports_event', entityId: eventId, after: { itemId: item.id }, req }, { transaction });
    return { id: item.id, kind: item.kind, textEn: item.textEn, textBn: item.textBn, createdAt: item.createdAt };
  });
}

module.exports = { add, has, page, announce };
