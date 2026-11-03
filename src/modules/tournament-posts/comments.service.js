'use strict';

/**
 * M26 comments (M26-FR-06): public and flat, on open posts. Phones, emails and links are refused here
 * as on the post, so numbers don't get scraped; private messages allow them. A commenter or the post's
 * author can remove a comment, staff through M17 reports. Removal is a status.
 */
const { sequelize, TournamentPost, TournamentPostComment } = require('../../models');
const audit = require('../audit').audit;
const directory = require('../users').directory;
const rules = require('./tournament-posts.rules');
const c = require('./tournament-posts.common');

const { fail } = c;

/** GET /tournament-posts/:id/comments: oldest first, paged. */
async function list(postId, { cursor, limit = 30 } = {}, viewerId = null) {
  const post = await TournamentPost.findByPk(postId, { attributes: ['id', 'authorId', 'status'] });
  if (!post || (!rules.isVisible(post.status) && post.authorId !== viewerId)) throw fail('TOURNAMENT_POST_NOT_FOUND');
  const offset = cursor ? Number(cursor) : 0;
  const { rows, count } = await TournamentPostComment.findAndCountAll({ where: { postId, status: 'visible' }, order: [['createdAt', 'ASC']], limit, offset });
  const names = await directory.publicNames(rows.map((r) => r.authorId));
  return {
    items: rows.map((r) => {
      const who = names.get(r.authorId);
      return {
        id: r.id,
        body: r.body,
        at: c.iso(r.createdAt),
        author: { displayName: who?.displayName ?? '', username: who?.username ?? null, avatarUrl: who?.avatarUrl ?? null },
        mine: r.authorId === viewerId,
        canRemove: Boolean(viewerId) && (r.authorId === viewerId || post.authorId === viewerId),
      };
    }),
    total: count,
    nextCursor: offset + limit < count ? String(offset + limit) : null,
  };
}

/** POST /tournament-posts/:id/comments (gate post_tournament). */
async function add(principal, postId, { body }, req) {
  if (body.length > c.config().commentMaxLength) throw fail('TOURNAMENT_COMMENT_TOO_LONG');
  if (rules.hasContact(body)) throw fail('CONTACT_NOT_ALLOWED', { field: 'body' });
  return sequelize.transaction(async (transaction) => {
    const post = await c.lockPost(postId, transaction);
    if (!rules.canComment(post.status)) throw fail('TOURNAMENT_POST_STATE', { status: post.status });
    const r = await TournamentPostComment.create({ postId: post.id, authorId: principal.id, body }, { transaction });
    await post.update({ commentCount: post.commentCount + 1, lastActivityAt: new Date() }, { transaction });
    await audit.record({ action: 'tournament_comment.added', actor: principal, entityType: 'tournament_post', entityId: post.id, meta: { commentId: r.id }, req }, { transaction });
    await c.publish(transaction, 'tournament_post.commented', post, { commentId: r.id, commenterId: principal.id }, principal);
    return { id: r.id, body: r.body, at: c.iso(r.createdAt), mine: true, canRemove: true };
  });
}

async function hide(r, post, { actor, transaction, req, reason = null }) {
  await r.update({ status: 'removed', removedBy: actor.id, removedAt: new Date() }, { transaction });
  await post.update({ commentCount: Math.max(0, post.commentCount - 1) }, { transaction });
  await audit.record({ action: 'tournament_comment.removed', actor, entityType: 'tournament_post', entityId: post.id, meta: { commentId: r.id }, reason, req }, { transaction });
}

/** POST /tournament-posts/:id/comments/:commentId/remove: the commenter or the post's author. */
async function remove(principal, postId, commentId, req) {
  return sequelize.transaction(async (transaction) => {
    const post = await c.lockPost(postId, transaction);
    const r = await TournamentPostComment.findOne({ where: { id: commentId, postId: post.id, status: 'visible' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!r) throw fail('TOURNAMENT_COMMENT_NOT_FOUND');
    if (r.authorId !== principal.id && post.authorId !== principal.id) throw fail('TOURNAMENT_COMMENT_NOT_YOURS');
    await hide(r, post, { actor: principal, transaction, req });
    return { removed: r.id };
  });
}

/** In the caller's transaction: M17 reports call this when a comment is upheld as content_removed. */
async function removeInTx(actor, commentId, { reason, transaction, req }) {
  const r = await TournamentPostComment.findByPk(commentId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!r || r.status !== 'visible') return;
  const post = await c.lockPost(r.postId, transaction);
  await hide(r, post, { actor, transaction, req, reason });
}

/** For M17 reports: who wrote it and how it reads on the desk. */
async function facts(id) {
  const r = await TournamentPostComment.findByPk(id, { attributes: ['id', 'authorId', 'postId', 'body', 'status'] });
  return r ? { id: r.id, authorId: r.authorId, postId: r.postId, body: r.body, status: r.status } : null;
}

module.exports = { list, add, remove, removeInTx, facts };
