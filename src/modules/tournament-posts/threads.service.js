'use strict';

/**
 * M26 private messages (M26-FR-07): a player connects with whoever posted a tournament, one thread per
 * post and player, on the platform. Phones and links are allowed here, unlike in public text, because
 * nothing is sold through Kriraghor and the two people need to arrange things. The page polls.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { sequelize, TournamentPost, TournamentPostThread, TournamentPostMessage } = require('../../models');
const audit = require('../audit').audit;
const events = require('../events').events;
const directory = require('../users').directory;
const rules = require('./tournament-posts.rules');
const c = require('./tournament-posts.common');

const { fail } = c;
const POLL_PAGE = 200;

async function views(threads, viewerId) {
  if (!threads.length) return [];
  const ids = threads.map((t) => t.id);
  const [posts, names, last, unread] = await Promise.all([
    TournamentPost.findAll({ where: { id: threads.map((t) => t.postId) }, attributes: ['id', 'slug', 'title', 'status'] }),
    directory.publicNames(threads.map((t) => rules.otherParty(t, viewerId))),
    Promise.all(ids.map((threadId) => TournamentPostMessage.findOne({ where: { threadId }, order: [['createdAt', 'DESC']], attributes: ['threadId', 'body', 'createdAt', 'senderId'] }))),
    TournamentPostMessage.count({ where: { threadId: ids, senderId: { [Op.ne]: viewerId }, readAt: null }, group: ['threadId'] }),
  ]);
  const postOf = new Map(posts.map((p) => [p.id, p]));
  const lastOf = new Map(last.filter(Boolean).map((m) => [m.threadId, m]));
  const unreadOf = new Map(unread.map((u) => [u.threadId, Number(u.count)]));
  return threads.map((t) => {
    const post = postOf.get(t.postId);
    const who = names.get(rules.otherParty(t, viewerId));
    const m = lastOf.get(t.id);
    return {
      id: t.id,
      post: { id: t.postId, slug: post?.slug ?? '', title: post?.title ?? '', status: post?.status ?? 'removed' },
      other: { displayName: who?.displayName ?? '', username: who?.username ?? null, avatarUrl: who?.avatarUrl ?? null },
      role: t.organiserId === viewerId ? 'organiser' : 'player',
      lastMessage: m ? { body: m.body, at: c.iso(m.createdAt), mine: m.senderId === viewerId } : null,
      unread: unreadOf.get(t.id) ?? 0,
    };
  });
}

/** POST /tournament-posts/:id/threads (gate post_tournament): opens the thread, or finds the one I have. */
async function open(principal, postId, req) {
  const post = await TournamentPost.findByPk(postId, { attributes: ['id', 'authorId', 'status'] });
  if (!post || !rules.isVisible(post.status)) throw fail('TOURNAMENT_POST_NOT_FOUND');
  if (post.authorId === principal.id) throw fail('TOURNAMENT_THREAD_OWN_POST');
  const found = await TournamentPostThread.findOne({ where: { postId: post.id, playerId: principal.id } });
  if (found) return (await views([found], principal.id))[0];
  if (!rules.canOpenThread(post.status)) throw fail('TOURNAMENT_POST_STATE', { status: post.status });
  try {
    const t = await sequelize.transaction(async (transaction) => {
      const row = await TournamentPostThread.create({ postId: post.id, organiserId: post.authorId, playerId: principal.id }, { transaction });
      await audit.record({ action: 'tournament_thread.opened', actor: principal, entityType: 'tournament_post', entityId: post.id, meta: { threadId: row.id }, req }, { transaction });
      return row;
    });
    return (await views([t], principal.id))[0];
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    // Two taps at once: the other request made it.
    const t = await TournamentPostThread.findOne({ where: { postId: post.id, playerId: principal.id } });
    return (await views([t], principal.id))[0];
  }
}

/** GET /me/tournament-threads: my conversations, both as the poster and as a player, latest first. */
async function mine(principal, { cursor, limit = 30 } = {}) {
  const offset = cursor ? Number(cursor) : 0;
  const where = { [Op.or]: [{ organiserId: principal.id }, { playerId: principal.id }] };
  const { rows, count } = await TournamentPostThread.findAndCountAll({ where, order: [[sequelize.literal('last_message_at DESC NULLS LAST')], ['createdAt', 'DESC']], limit, offset });
  return { items: await views(rows, principal.id), total: count, nextCursor: offset + limit < count ? String(offset + limit) : null };
}

async function partyThread(principal, id, opts = {}) {
  const t = await TournamentPostThread.findByPk(id, opts);
  if (!t || !rules.isParty(t, principal.id)) throw fail('TOURNAMENT_THREAD_NOT_FOUND');
  return t;
}

/** GET /me/tournament-threads/:id/messages?after: only the two people; `after` for polling. */
async function messages(principal, id, { after } = {}) {
  const t = await partyThread(principal, id);
  const rows = await TournamentPostMessage.findAll({ where: { threadId: t.id, ...(after ? { createdAt: { [Op.gt]: new Date(after) } } : {}) }, order: [['createdAt', 'ASC']], limit: POLL_PAGE });
  const [thread] = await views([t], principal.id);
  return { thread, items: rows.map((m) => ({ id: m.id, mine: m.senderId === principal.id, body: m.body, at: c.iso(m.createdAt) })), canSend: rules.canMessage(thread.post.status) };
}

/** POST /me/tournament-threads/:id/messages (gate post_tournament). */
async function send(principal, id, { body }) {
  if (body.length > c.config().messageMaxLength) throw fail('TOURNAMENT_MESSAGE_TOO_LONG');
  return sequelize.transaction(async (transaction) => {
    const t = await partyThread(principal, id, { transaction, lock: transaction.LOCK.UPDATE });
    const post = await TournamentPost.findByPk(t.postId, { attributes: ['id', 'slug', 'title', 'status'], transaction });
    if (!rules.canMessage(post.status)) throw fail('TOURNAMENT_POST_STATE', { status: post.status });
    const m = await TournamentPostMessage.create({ threadId: t.id, senderId: principal.id, body }, { transaction });
    await t.update({ lastMessageAt: new Date() }, { transaction });
    await events.publish(transaction, {
      name: 'tournament_message.posted',
      aggregateType: 'tournament_post',
      aggregateId: post.id,
      payload: { postId: post.id, title: post.title, threadId: t.id, messageId: m.id, senderId: principal.id, recipientId: rules.otherParty(t, principal.id) },
      actor: principal,
    });
    return { id: m.id, mine: true, body: m.body, at: c.iso(m.createdAt) };
  });
}

/** POST /me/tournament-threads/:id/read: everything sent to me here is read. */
async function markRead(principal, id) {
  const t = await partyThread(principal, id);
  const [read] = await TournamentPostMessage.update({ readAt: new Date() }, { where: { threadId: t.id, senderId: { [Op.ne]: principal.id }, readAt: null } });
  return { read };
}

module.exports = { open, mine, messages, send, markRead };
