'use strict';

/**
 * M23 viewers: follows (in-app alerts) and free polls (no stakes, no prizes: Q114).
 *
 *   poll: draft ─open─▶ open ─close / closes_at passed (tick)─▶ closed
 *   vote: one per member per poll, final (UNIQUE poll + user; votes are append-only). Results show
 *   totals and the caller's own vote, never voters. Counts are GROUP BY over an index, cached in Redis
 *   for esports_events.poll_cache_seconds; the room gets at most one ping per poll_push_ms.
 */
const { UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const config = require('../../config');
const logger = require('../../common/logger');
const { getRedis } = require('../../common/redis');
const models = require('../../models');
const audit = require('../audit').audit;
const gates = require('../auth').gate;
const rules = require('./events.rules');
const c = require('./events.common');

const { sequelize, EsportsEvent, EsportsEventPoll, EsportsEventPollOption, EsportsEventPollVote, EsportsEventFollow } = models;

const countsKey = (pollId) => `${config.redis.prefix}:esev:poll:${pollId}`;
const pushKey = (pollId) => `${config.redis.prefix}:esev:pollping:${pollId}`;

async function published(eventId, transaction) {
  const e = await EsportsEvent.findByPk(eventId, { transaction });
  if (!e || e.status !== 'published') throw E.notFound('Event');
  return e;
}

// ---------------------------------------------------------------- follows

/** POST /esports/events/:id/follow and /unfollow (signed in): one row per member, toggled. */
async function setFollow(principal, eventId, on, req) {
  return sequelize.transaction(async (transaction) => {
    await published(eventId, transaction);
    const [row] = await EsportsEventFollow.findOrCreate({ where: { eventId, userId: principal.user.id }, defaults: { status: on ? 'active' : 'removed' }, transaction });
    if (row.status !== (on ? 'active' : 'removed')) await row.update({ status: on ? 'active' : 'removed' }, { transaction });
    await audit.record({ action: on ? 'esports_event.followed' : 'esports_event.unfollowed', actor: principal, entityType: 'esports_event', entityId: eventId, req }, { transaction });
    const followers = await EsportsEventFollow.count({ where: { eventId, status: 'active' }, transaction });
    return { following: on, followers };
  });
}

/** GET /esports/events/:id/me (signed in): following and my votes (kept out of the cacheable bundle). */
async function me(principal, eventId) {
  const follow = await EsportsEventFollow.findOne({ where: { eventId, userId: principal.user.id } });
  const polls = await EsportsEventPoll.findAll({ where: { eventId }, attributes: ['id'] });
  const votes = polls.length ? await EsportsEventPollVote.findAll({ where: { pollId: polls.map((p) => p.id), userId: principal.user.id } }) : [];
  return { following: follow?.status === 'active', votes: Object.fromEntries(votes.map((v) => [v.pollId, v.optionId])) };
}

/** GET /me/esports/events: the events I follow. */
async function mine(principal) {
  const rows = await EsportsEventFollow.findAll({ where: { userId: principal.user.id, status: 'active' }, attributes: ['eventId'] });
  const events = rows.length ? await EsportsEvent.findAll({ where: { id: rows.map((r) => r.eventId), status: ['published', 'cancelled'] }, order: [['startsAt', 'DESC']] }) : [];
  return { items: await require('./events.service').cards(events) };
}

// ---------------------------------------------------------------- polls

async function countsFor(pollId, optionIds) {
  const redis = getRedis();
  try {
    const hit = await redis.get(countsKey(pollId));
    if (hit) return new Map(Object.entries(JSON.parse(hit)).map(([k, v]) => [k, Number(v)]));
  } catch (err) {
    logger.warn({ err: err.message }, 'poll counts cache unavailable');
  }
  const rows = await EsportsEventPollVote.findAll({ where: { pollId }, attributes: ['optionId', [sequelize.fn('COUNT', sequelize.col('id')), 'n']], group: ['optionId'], raw: true });
  const counts = new Map(optionIds.map((id) => [id, 0]));
  for (const r of rows) counts.set(r.optionId, Number(r.n));
  try {
    await redis.set(countsKey(pollId), JSON.stringify(Object.fromEntries(counts)), 'EX', Math.max(1, c.config().pollCacheSeconds));
  } catch (err) {
    logger.warn({ err: err.message }, 'poll counts cache unavailable');
  }
  return counts;
}

async function pollView(p, options) {
  const ids = options.map((o) => o.id);
  return {
    id: p.id,
    questionEn: p.questionEn,
    questionBn: p.questionBn,
    status: p.status,
    closesAt: p.closesAt ?? null,
    options: options.map((o) => ({ id: o.id, labelEn: o.labelEn, labelBn: o.labelBn })),
    results: rules.pollTotals(ids, p.status === 'draft' ? new Map() : await countsFor(p.id, ids)),
  };
}

const optionsOf = async (pollIds, transaction) => {
  const rows = pollIds.length ? await EsportsEventPollOption.findAll({ where: { pollId: pollIds }, order: [['sort', 'ASC']], transaction }) : [];
  return (id) => rows.filter((o) => o.pollId === id);
};

/** The event's polls for the bundle (drafts for staff only). */
async function publicPolls(eventId, { staff = false } = {}) {
  const polls = await EsportsEventPoll.findAll({ where: { eventId, ...(staff ? {} : { status: ['open', 'closed'] }) }, order: [['createdAt', 'DESC']] });
  const of = await optionsOf(polls.map((p) => p.id));
  return Promise.all(polls.map((p) => pollView(p, of(p.id))));
}

/** POST /admin/esports/events/:id/polls: a draft poll. */
async function createPoll(actor, eventId, { questionEn, questionBn, options, closesAt }, req) {
  const block = rules.pollOptionsBlock(options, c.config().pollOptionsMax);
  if (block) throw c.fail(block);
  return sequelize.transaction(async (transaction) => {
    const e = await EsportsEvent.findByPk(eventId, { transaction });
    if (!e) throw E.notFound('Event');
    if (e.status === 'cancelled') throw c.fail('EVENT_STATE');
    const p = await EsportsEventPoll.create({ eventId, questionEn: questionEn.trim(), questionBn: questionBn.trim(), closesAt: closesAt ? new Date(closesAt) : null, createdBy: actor.id }, { transaction });
    await EsportsEventPollOption.bulkCreate(
      options.map((o, i) => ({ pollId: p.id, labelEn: o.labelEn.trim(), labelBn: o.labelBn.trim(), sort: i })),
      { transaction }
    );
    await audit.record({ action: 'esports_event.poll_created', actor, entityType: 'esports_event', entityId: eventId, after: { pollId: p.id, options: options.length }, req }, { transaction });
    return pollView(p, (await optionsOf([p.id], transaction))(p.id));
  });
}

/** POST /admin/esports/events/:id/polls/:pollId/open | close */
async function movePoll(actor, eventId, pollId, to, req) {
  return sequelize.transaction(async (transaction) => {
    const p = await EsportsEventPoll.findOne({ where: { id: pollId, eventId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!p) throw E.notFound('Poll');
    if (to === 'open') {
      if (p.status !== 'draft') throw c.fail('POLL_STATE');
      await published(eventId, transaction);
      await p.update({ status: 'open', openedAt: new Date() }, { transaction });
    } else {
      if (p.status !== 'open') throw c.fail('POLL_STATE');
      await p.update({ status: 'closed', closedAt: new Date() }, { transaction });
    }
    await audit.record({ action: `esports_event.poll_${to === 'open' ? 'opened' : 'closed'}`, actor, entityType: 'esports_event', entityId: eventId, after: { pollId: p.id }, req }, { transaction });
    c.ping(transaction, eventId, 'esports_event.poll_updated', { pollId: p.id });
    return pollView(p, (await optionsOf([p.id], transaction))(p.id));
  });
}

/** Tick: open polls past closes_at close. */
async function closeDue(now = new Date()) {
  const { Op } = require('sequelize');
  const due = await EsportsEventPoll.findAll({ where: { status: 'open', closesAt: { [Op.lte]: now } } });
  for (const p of due) {
    await sequelize.transaction(async (transaction) => {
      const locked = await EsportsEventPoll.findByPk(p.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (locked.status !== 'open') return;
      await locked.update({ status: 'closed', closedAt: now }, { transaction });
      c.ping(transaction, locked.eventId, 'esports_event.poll_updated', { pollId: locked.id });
    });
  }
  return due.length;
}

/** At most one poll ping per window (the room re-fetches the counts). */
async function throttledPing(eventId, pollId) {
  try {
    const ok = await getRedis().set(pushKey(pollId), '1', 'PX', Math.max(100, c.config().pollPushMs), 'NX');
    if (ok) c.ping(null, eventId, 'esports_event.poll_updated', { pollId });
  } catch (err) {
    logger.warn({ err: err.message }, 'poll ping skipped');
  }
}

/** POST /esports/events/:id/polls/:pollId/vote (verified phone): one vote, final. */
async function vote(principal, eventId, pollId, { optionId }, req) {
  const g = gates.evaluateAction(principal, 'vote_poll');
  if (!g.allowed) throw E.forbidden(g.code, 'You cannot vote yet', undefined, { next: g.next });
  const out = await sequelize.transaction(async (transaction) => {
    await published(eventId, transaction);
    const p = await EsportsEventPoll.findOne({ where: { id: pollId, eventId }, transaction });
    if (!p) throw E.notFound('Poll');
    const options = (await optionsOf([p.id], transaction))(p.id);
    const block = rules.voteBlock(p, optionId, options.map((o) => o.id), new Date());
    if (block) throw c.fail(block);
    try {
      await sequelize.transaction({ transaction }, (sp) => EsportsEventPollVote.create({ pollId: p.id, optionId, userId: principal.user.id }, { transaction: sp }));
    } catch (err) {
      if (err instanceof UniqueConstraintError) throw c.fail('POLL_ALREADY_VOTED');
      throw err;
    }
    await audit.record({ action: 'esports_event.poll_voted', actor: principal, entityType: 'esports_event', entityId: eventId, after: { pollId: p.id }, req }, { transaction });
    return { p, options };
  });
  try {
    await getRedis().del(countsKey(pollId));
  } catch (err) {
    logger.warn({ err: err.message }, 'poll counts cache not cleared');
  }
  await throttledPing(eventId, pollId);
  return { ...(await pollView(out.p, out.options)), myVote: optionId };
}

module.exports = { setFollow, me, mine, publicPolls, createPoll, movePoll, closeDue, vote };
