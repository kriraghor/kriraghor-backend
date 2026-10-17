'use strict';

/**
 * M17 reviews (§5.3, FR-20 to FR-26; Q98: one-sided). A member rates a ground once per played
 * booking (checked in or completed, ended, within reviews.window_days), and may edit it for
 * reviews.edit_days. A review waits ("held") while its booking has an open dispute, or when its text
 * has a link or a phone number, until staff publish it. The ground owner can reply once (and edit the
 * reply). review_aggregates is rebuilt from the published reviews on every change, and
 * review.aggregate_updated lets M09 show the rating on the ground (the average shows from
 * reviews.min_count_display reviews).
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, Review, ReviewAggregate } = require('../../models');
const settings = require('../settings/settings.service');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const directory = require('../users/directory.service');
const { fail } = require('./trust.errors');
const rules = require('./trust.rules');

const DAY = 24 * 3600 * 1000;
const iso = (d) => (d ? new Date(d).toISOString() : null);
const bookingReads = () => require('../bookings/bookings.reads');
const groundReads = () => require('../grounds/grounds.reads');
const disputes = () => require('./disputes.service');

const payload = (r, extra = {}) => ({ reviewId: r.id, subjectType: r.subjectType, subjectId: r.subjectId, authorId: r.authorId, ...extra });
const publish = (transaction, name, r, extra, actor = null) => events.publish(transaction, { name, aggregateType: 'review', aggregateId: r.id, payload: payload(r, extra), actor });

function view(r, names = new Map(), { staff = false } = {}) {
  return {
    id: r.id,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    bookingId: r.sourceId,
    stars: r.stars,
    text: r.text ?? null,
    status: r.status,
    heldReason: r.heldReason ?? null,
    author: { displayName: names.get(r.authorId)?.displayName ?? null, ...(staff ? { id: r.authorId } : {}) },
    reply: r.replyText ? { text: r.replyText, at: iso(r.repliedAt) } : null,
    editUntil: iso(r.editUntil),
    createdAt: iso(r.createdAt),
    editedAt: iso(r.editedAt),
    ...(staff ? { hiddenReason: r.hiddenReason ?? null, hiddenAt: iso(r.hiddenAt) } : {}),
  };
}

// ---------------------------------------------------------------- aggregates

async function recompute(subjectType, subjectId, { transaction }) {
  const rows = await Review.findAll({ where: { subjectType, subjectId, status: 'published' }, attributes: ['stars'], transaction });
  const hist = [0, 0, 0, 0, 0];
  for (const r of rows) hist[r.stars - 1] += 1;
  const agg = rules.aggregate(hist, settings.get('reviews.min_count_display'));
  await ReviewAggregate.upsert({ subjectType, subjectId, reviewCount: agg.count, starsSum: agg.sum, starsHist: hist }, { transaction });
  await events.publish(transaction, { name: 'review.aggregate_updated', aggregateType: 'review_subject', aggregateId: subjectId, payload: { subjectType, subjectId, count: agg.count, avg: agg.avg } });
  return agg;
}

async function summary(subjectType, subjectId) {
  const a = await ReviewAggregate.findOne({ where: { subjectType, subjectId } });
  const hist = a?.starsHist ?? [0, 0, 0, 0, 0];
  const agg = rules.aggregate(hist, settings.get('reviews.min_count_display'));
  return { count: agg.count, avg: agg.display, histogram: hist };
}

/** The raw rating (M09 stores it; the public views apply reviews.min_count_display). */
async function ratingOf(subjectType, subjectId, { transaction } = {}) {
  const a = await ReviewAggregate.findOne({ where: { subjectType, subjectId }, transaction });
  const agg = rules.aggregate(a?.starsHist ?? [0, 0, 0, 0, 0], 0);
  return { count: agg.count, avg: agg.avg };
}

// ---------------------------------------------------------------- disputes hold reviews (FR-24)

async function holdForSource(sourceType, sourceId, { transaction }) {
  if (sourceType !== 'booking') return 0;
  const rows = await Review.findAll({ where: { sourceType, sourceId, status: 'published' }, transaction, lock: transaction.LOCK.UPDATE });
  for (const r of rows) await r.update({ status: 'held', heldReason: 'dispute' }, { transaction });
  for (const subjectId of new Set(rows.map((r) => r.subjectId))) await recompute('ground', subjectId, { transaction });
  return rows.length;
}

async function releaseForSource(sourceType, sourceId, { transaction }) {
  if (sourceType !== 'booking') return 0;
  const rows = await Review.findAll({ where: { sourceType, sourceId, status: 'held', heldReason: 'dispute' }, transaction, lock: transaction.LOCK.UPDATE });
  for (const r of rows) {
    const next = rules.initialReview({ disputeActive: false, text: r.text });
    await r.update({ status: next.status, heldReason: next.heldReason }, { transaction });
  }
  for (const subjectId of new Set(rows.map((r) => r.subjectId))) await recompute('ground', subjectId, { transaction });
  return rows.length;
}

// ---------------------------------------------------------------- the member (FR-20 to FR-22)

/** GET /me/reviewable: played bookings still waiting for a rating. */
async function reviewable(principal) {
  const since = new Date(Date.now() - settings.get('reviews.window_days') * DAY);
  const played = await bookingReads().playedBy(principal.id, since);
  const done = new Set((await Review.findAll({ where: { authorId: principal.id, sourceType: 'booking', sourceId: played.map((b) => b.bookingId) }, attributes: ['sourceId'] })).map((r) => r.sourceId));
  const items = [];
  for (const b of played.filter((x) => !done.has(x.bookingId))) {
    const f = await require('../grounds/grounds.service').facts(b.groundId).catch(() => null);
    items.push({ bookingId: b.bookingId, code: b.code, groundId: b.groundId, groundName: f?.name ?? null, groundSlug: f?.slug ?? null, end: iso(b.end) });
  }
  return { items };
}

/** POST /reviews { bookingId, stars, text } */
async function post(principal, { bookingId, stars, text = null }, req) {
  const b = await bookingReads().reviewSource(bookingId);
  if (!b) throw E.notFound('Booking');
  const block = rules.reviewBlock({ isBooker: b.bookerUserId === principal.id, status: b.status, endAt: b.end, now: new Date(), windowDays: settings.get('reviews.window_days') });
  if (block) throw fail(block);
  try {
    return await sequelize.transaction(async (transaction) => {
      const disputeActive = await disputes().activeFor('booking', b.bookingId, { transaction });
      const first = rules.initialReview({ disputeActive, text });
      const r = await Review.create(
        { subjectType: 'ground', subjectId: b.groundId, sourceType: 'booking', sourceId: b.bookingId, authorId: principal.id, stars, text, status: first.status, heldReason: first.heldReason, editUntil: new Date(Date.now() + settings.get('reviews.edit_days') * DAY) },
        { transaction }
      );
      if (r.status === 'published') await recompute('ground', r.subjectId, { transaction });
      await publish(transaction, 'review.posted', r, { ownerId: b.ownerId, stars, status: r.status }, principal);
      await audit.record({ action: 'review.posted', actor: principal, entityType: 'review', entityId: r.id, after: { stars, status: r.status }, req }, { transaction });
      return { review: view(r, await directory.publicNames([principal.id], { transaction })) };
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw fail('REVIEW_EXISTS');
    throw err;
  }
}

/** PATCH /reviews/:id { stars?, text? } (the author, within reviews.edit_days). */
async function edit(principal, id, patch, req) {
  return sequelize.transaction(async (transaction) => {
    const r = await Review.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!r || r.authorId !== principal.id) throw E.notFound('Review');
    const block = rules.editBlock({ status: r.status, editUntil: r.editUntil, now: new Date() });
    if (block) throw fail(block);
    const text = patch.text !== undefined ? patch.text : r.text;
    const disputeActive = r.heldReason === 'dispute';
    const next = rules.initialReview({ disputeActive, text });
    await r.update({ stars: patch.stars ?? r.stars, text, status: next.status, heldReason: next.heldReason, editedAt: new Date() }, { transaction });
    await recompute(r.subjectType, r.subjectId, { transaction });
    await publish(transaction, 'review.edited', r, { stars: r.stars, status: r.status }, principal);
    await audit.record({ action: 'review.edited', actor: principal, entityType: 'review', entityId: r.id, after: { stars: r.stars, status: r.status }, req }, { transaction });
    return { review: view(r, await directory.publicNames([principal.id], { transaction })) };
  });
}

/** GET /me/reviews: the member's own reviews. */
async function listMine(principal) {
  const rows = await Review.findAll({ where: { authorId: principal.id }, order: [['createdAt', 'DESC']], limit: 100 });
  const names = await directory.publicNames([principal.id]);
  return { items: rows.map((r) => view(r, names)) };
}

// ---------------------------------------------------------------- public and the owner (FR-23, FR-25)

/** GET /grounds/:id/reviews?cursor: published reviews, newest first, with the summary. */
async function publicList(groundId, { cursor, limit = 20 } = {}) {
  const where = { subjectType: 'ground', subjectId: groundId, status: 'published' };
  if (cursor) where.createdAt = { [Op.lt]: new Date(cursor) };
  const rows = await Review.findAll({ where, order: [['createdAt', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const names = await directory.publicNames(page.map((r) => r.authorId));
  return { summary: await summary('ground', groundId), items: page.map((r) => view(r, names)), nextCursor: rows.length > limit ? iso(page[page.length - 1].createdAt) : null };
}

/** GET /me/ground-reviews?groundId: the owner's reviews (published), to reply to. */
async function ownerList(principal, { groundId, cursor, limit = 50 } = {}) {
  const mine = (await groundReads().groundsOf(principal.id)).map((g) => g.id);
  const ids = groundId ? mine.filter((g) => g === groundId) : mine;
  const where = { subjectType: 'ground', subjectId: ids, status: 'published' };
  if (cursor) where.createdAt = { [Op.lt]: new Date(cursor) };
  const rows = await Review.findAll({ where, order: [['createdAt', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const names = await directory.publicNames(page.map((r) => r.authorId));
  return { items: page.map((r) => view(r, names)), nextCursor: rows.length > limit ? iso(page[page.length - 1].createdAt) : null };
}

/** POST /me/reviews/:id/reply { text } (the ground's owner). */
async function reply(principal, id, { text }, req) {
  return sequelize.transaction(async (transaction) => {
    const r = await Review.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!r) throw E.notFound('Review');
    const g = await groundReads().ground(r.subjectId, { transaction });
    if (!g || g.ownerId !== principal.id) throw fail('NOT_OWNER');
    if (r.status !== 'published') throw fail('REVIEW_STATE', { status: r.status });
    await r.update({ replyText: text, repliedBy: principal.id, repliedAt: new Date() }, { transaction });
    await publish(transaction, 'review.replied', r, {}, principal);
    await audit.record({ action: 'review.replied', actor: principal, entityType: 'review', entityId: r.id, req }, { transaction });
    return { review: view(r, await directory.publicNames([r.authorId], { transaction })) };
  });
}

// ---------------------------------------------------------------- staff (FR-26) and reports

async function hideInTx(r, { reason, actor, transaction }) {
  if (r.status === 'hidden') return r;
  await r.update({ status: 'hidden', heldReason: null, hiddenReason: reason, hiddenBy: actor?.id ?? null, hiddenAt: new Date() }, { transaction });
  await recompute(r.subjectType, r.subjectId, { transaction });
  await publish(transaction, 'review.hidden', r, { reason: reason.slice(0, 60) }, actor);
  return r;
}

async function restoreInTx(r, { actor, transaction }) {
  if (r.status !== 'hidden') throw fail('REVIEW_STATE', { status: r.status });
  const disputeActive = await disputes().activeFor(r.sourceType, r.sourceId, { transaction });
  const next = rules.initialReview({ disputeActive, text: null });
  await r.update({ status: next.status, heldReason: next.heldReason, hiddenReason: null, hiddenBy: null, hiddenAt: null }, { transaction });
  await recompute(r.subjectType, r.subjectId, { transaction });
  await publish(transaction, 'review.restored', r, {}, actor);
  return r;
}

const lockReview = async (id, transaction) => {
  const r = await Review.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!r) throw E.notFound('Review');
  return r;
};

/** GET /admin/reviews?status=held|hidden|published */
async function adminList({ status = 'held', groundId, cursor, limit = 50 } = {}) {
  const where = { status };
  if (groundId) where.subjectId = groundId;
  if (cursor) where.createdAt = { [Op.lt]: new Date(cursor) };
  const rows = await Review.findAll({ where, order: [['createdAt', 'ASC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const names = await directory.publicNames(page.map((r) => r.authorId));
  return { items: page.map((r) => view(r, names, { staff: true })), nextCursor: rows.length > limit ? iso(page[page.length - 1].createdAt) : null };
}

async function staffAction(actor, id, action, { reason = null } = {}, req) {
  return sequelize.transaction(async (transaction) => {
    const r = await lockReview(id, transaction);
    if (action === 'hide') await hideInTx(r, { reason, actor, transaction });
    else if (action === 'restore') await restoreInTx(r, { actor, transaction });
    else {
      if (r.status !== 'held') throw fail('REVIEW_STATE', { status: r.status });
      await r.update({ status: 'published', heldReason: null }, { transaction });
      await recompute(r.subjectType, r.subjectId, { transaction });
      await publish(transaction, 'review.published', r, {}, actor);
    }
    await audit.record({ action: `review.${action === 'hide' ? 'hidden' : action === 'restore' ? 'restored' : 'published'}`, actor, entityType: 'review', entityId: r.id, reason, req }, { transaction });
    return { review: view(r, await directory.publicNames([r.authorId], { transaction }), { staff: true }) };
  });
}

/** Reports: the subject behind a review (its author and ground) and a locked row. */
const get = (id, { transaction } = {}) => Review.findByPk(id, { transaction });

/** Display facts for notifications. */
async function facts(id) {
  const r = await Review.findByPk(id);
  if (!r) throw E.notFound('Review');
  const g = await require('../grounds/grounds.service').facts(r.subjectId).catch(() => null);
  return { stars: r.stars, groundName: g?.name ?? '', groundSlug: g?.slug ?? null, hiddenReason: r.hiddenReason ?? null };
}

module.exports = { recompute, summary, ratingOf, holdForSource, releaseForSource, reviewable, post, edit, listMine, publicList, ownerList, reply, hideInTx, restoreInTx, lockReview, adminList, staffAction, get, facts, view };
