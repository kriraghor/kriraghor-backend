'use strict';

/**
 * M17 reviews (§5.3, FR-30 to FR-36; Q98: one-sided). A member rates what they paid for, once per
 * source, through the review-sources port (review-sources.port.js):
 *   booking   → ground        played (checked in or completed) and ended            (M10)
 *   hire_job  → hire_profile  the job's money was released to the pro               (M11)
 *   sub_order → shop          the sub-order is completed                             (M13)
 *   gym_pass  → gym           the pass was used at the front desk; ONE review per gym: a newer pass
 *                             updates the member's review instead of adding one     (M20-FR-10)
 * within reviews.window_days of the source being done, and may edit it for reviews.edit_days. A
 * review waits ("held") while its source has an open dispute (FR-33: bookings, sub-orders and hire
 * jobs), or when its text has a link or a phone number (FR-32), until staff publish it. The subject's
 * owner (subject_owner_id: the venue owner, the pro, the seller, the gym owner) can reply once and
 * edit the reply; a reply with contact details is refused (FR-34, REPLY_HAS_CONTACT) and the author is
 * told (review.replied). review_aggregates is rebuilt per (subject_type, subject_id) from the
 * published reviews on every change, and review.aggregate_updated lets M09, M11, M12 and M20 show the
 * rating (the average shows from reviews.min_count_display reviews, FR-35).
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, Review, ReviewAggregate } = require('../../models');
const settings = require('../settings').settings;
const audit = require('../audit').audit;
const events = require('../events').events;
const directory = require('../users').directory;
const { fail } = require('./trust.errors');
const rules = require('./trust.rules');
const port = require('./review-sources.port');

const DAY = 24 * 3600 * 1000;
const iso = (d) => (d ? new Date(d).toISOString() : null);
const disputes = () => require('./disputes.service');
// Round B3: venue staff may reply to reviews with the optional reviews.reply permission (Q170).
const access = () => require('../business-members').access;
const NOUNS = { booking: 'Booking', hire_job: 'Job', sub_order: 'Order', gym_pass: 'Pass' };

const payload = (r, extra = {}) => ({ reviewId: r.id, subjectType: r.subjectType, subjectId: r.subjectId, authorId: r.authorId, ...extra });
const publish = (transaction, name, r, extra, actor = null) => events.publish(transaction, { name, aggregateType: 'review', aggregateId: r.id, payload: payload(r, extra), actor });

/** scope: 'public' (no source), 'member' (the author or the owner), 'staff'. */
function view(r, names = new Map(), { staff = false, scope = staff ? 'staff' : 'member', subjects = null } = {}) {
  const s = subjects?.get(`${r.subjectType}:${r.subjectId}`);
  return {
    id: r.id,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    ...(subjects ? { subjectName: s?.name ?? null, subjectSlug: s?.slug ?? null } : {}),
    ...(scope === 'public' ? {} : { sourceType: r.sourceType, sourceId: r.sourceId }),
    bookingId: r.sourceType === 'booking' ? r.sourceId : null,
    stars: r.stars,
    text: r.text ?? null,
    status: r.status,
    heldReason: r.heldReason ?? null,
    author: { displayName: names.get(r.authorId)?.displayName ?? null, ...(staff ? { id: r.authorId } : {}) },
    reply: r.replyText ? { text: r.replyText, at: iso(r.repliedAt) } : null,
    editUntil: iso(r.editUntil),
    createdAt: iso(r.createdAt),
    editedAt: iso(r.editedAt),
    ...(staff ? { hiddenReason: r.hiddenReason ?? null, hiddenAt: iso(r.hiddenAt), subjectOwnerId: r.subjectOwnerId ?? null } : {}),
  };
}

/** The display name and slug of each subject in the rows (one lookup per subject, through the port). */
async function subjectsOf(rows) {
  const keys = [...new Set(rows.map((r) => `${r.subjectType}:${r.subjectId}`))];
  const found = await Promise.all(keys.map((k) => port.subjectOf(...k.split(':'))));
  return new Map(keys.map((k, i) => [k, found[i]]));
}

const page = (rows, limit) => {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? iso(items[items.length - 1].createdAt) : null };
};

// ---------------------------------------------------------------- aggregates (FR-35)

async function recompute(subjectType, subjectId, { transaction }) {
  const rows = await Review.findAll({ where: { subjectType, subjectId, status: 'published' }, attributes: ['stars'], transaction });
  const hist = [0, 0, 0, 0, 0];
  for (const r of rows) hist[r.stars - 1] += 1;
  const agg = rules.aggregate(hist, settings.get('reviews.min_count_display'));
  await ReviewAggregate.upsert({ subjectType, subjectId, reviewCount: agg.count, starsSum: agg.sum, starsHist: hist }, { transaction });
  await events.publish(transaction, { name: 'review.aggregate_updated', aggregateType: 'review_subject', aggregateId: subjectId, payload: { subjectType, subjectId, count: agg.count, avg: agg.avg } });
  return agg;
}

/** Recompute each distinct subject of `rows` once. */
async function recomputeAll(rows, { transaction }) {
  const subjects = new Map(rows.map((r) => [`${r.subjectType}:${r.subjectId}`, r]));
  for (const r of subjects.values()) await recompute(r.subjectType, r.subjectId, { transaction });
}

async function summary(subjectType, subjectId) {
  const a = await ReviewAggregate.findOne({ where: { subjectType, subjectId } });
  const hist = a?.starsHist ?? [0, 0, 0, 0, 0];
  const agg = rules.aggregate(hist, settings.get('reviews.min_count_display'));
  return { count: agg.count, avg: agg.display, histogram: hist };
}

/** The raw rating (the subject's module stores it; the public views apply reviews.min_count_display). */
async function ratingOf(subjectType, subjectId, { transaction } = {}) {
  const a = await ReviewAggregate.findOne({ where: { subjectType, subjectId }, transaction });
  const agg = rules.aggregate(a?.starsHist ?? [0, 0, 0, 0, 0], 0);
  return { count: agg.count, avg: agg.avg };
}

// ---------------------------------------------------------------- disputes hold reviews (FR-33)

/** Dispute sources that are also review sources (booking, sub_order, hire_job) hold their reviews. */
const reviewSource = (sourceType) => Boolean(port.get(sourceType));

async function holdForSource(sourceType, sourceId, { transaction }) {
  if (!reviewSource(sourceType)) return 0;
  const rows = await Review.findAll({ where: { sourceType, sourceId, status: 'published' }, transaction, lock: transaction.LOCK.UPDATE });
  for (const r of rows) await r.update({ status: 'held', heldReason: 'dispute' }, { transaction });
  await recomputeAll(rows, { transaction });
  return rows.length;
}

async function releaseForSource(sourceType, sourceId, { transaction }) {
  if (!reviewSource(sourceType)) return 0;
  const rows = await Review.findAll({ where: { sourceType, sourceId, status: 'held', heldReason: 'dispute' }, transaction, lock: transaction.LOCK.UPDATE });
  for (const r of rows) {
    const next = rules.initialReview({ disputeActive: false, text: r.text });
    await r.update({ status: next.status, heldReason: next.heldReason }, { transaction });
  }
  await recomputeAll(rows, { transaction });
  return rows.length;
}

// ---------------------------------------------------------------- the member (FR-30 to FR-33)

/**
 * GET /me/reviewable: what is waiting for a rating, newest first: played bookings, released hire
 * jobs, completed sub-orders and used gym passes (one per gym, until the gym is reviewed). Booking
 * items keep their v1 fields (bookingId, code, groundId, groundName, groundSlug, end).
 */
async function reviewable(principal) {
  const windowDays = settings.get('reviews.window_days');
  const since = new Date(Date.now() - windowDays * DAY);
  const items = [];
  for (const [sourceType, src] of port.all()) {
    const rows = await src.reviewableBy(principal.id, since);
    if (!rows.length) continue;
    const done = new Set((await Review.findAll({ where: { authorId: principal.id, sourceType, sourceId: rows.map((x) => x.sourceId) }, attributes: ['sourceId'] })).map((r) => r.sourceId));
    // One review per subject (gyms, M20-FR-10): after a later visit the item comes back to update that review.
    const existing = src.oneReviewPerSubject
      ? new Map((await Review.findAll({ where: { authorId: principal.id, subjectType: src.subjectType, subjectId: rows.map((x) => x.subjectId) }, attributes: ['id', 'subjectId', 'status', 'createdAt', 'editedAt'] })).map((r) => [r.subjectId, r]))
      : new Map();
    const open = (y) => {
      const r = existing.get(y.subjectId);
      return !r || (r.status !== 'hidden' && new Date(y.doneAt) > (r.editedAt ?? r.createdAt));
    };
    for (const x of rows.filter((y) => !done.has(y.sourceId) && open(y))) {
      const s = await port.subjectOf(src.subjectType, x.subjectId);
      const legacy = sourceType === 'booking' ? { ...x.extra, end: iso(x.extra.end), groundName: s?.name ?? null, groundSlug: s?.slug ?? null } : {};
      items.push({
        sourceType,
        sourceId: x.sourceId,
        ref: x.ref,
        subjectType: src.subjectType,
        subjectId: x.subjectId,
        subjectName: s?.name ?? null,
        subjectSlug: s?.slug ?? null,
        doneAt: iso(x.doneAt),
        closesAt: iso(new Date(new Date(x.doneAt).getTime() + windowDays * DAY)),
        existingReviewId: existing.get(x.subjectId)?.id ?? null,
        ...legacy,
      });
    }
  }
  items.sort((a, b) => (a.doneAt < b.doneAt ? 1 : a.doneAt > b.doneAt ? -1 : 0));
  return { items };
}

/** The gym rule (M20-FR-10): a newer pass updates the member's one review of the gym. */
async function repost(principal, existing, d, { stars, text }, { transaction, req }) {
  const block = rules.repostBlock({ sameSource: existing.sourceId === d.sourceId, status: existing.status });
  if (block) throw fail(block);
  const disputeActive = await disputes().activeFor(d.sourceType, d.sourceId, { transaction });
  const next = rules.initialReview({ disputeActive, text });
  const before = { stars: existing.stars, status: existing.status, sourceId: existing.sourceId };
  await existing.update(
    { sourceId: d.sourceId, subjectOwnerId: d.ownerId, stars, text, status: next.status, heldReason: next.heldReason, editUntil: new Date(Date.now() + settings.get('reviews.edit_days') * DAY), editedAt: new Date() },
    { transaction }
  );
  await recompute(existing.subjectType, existing.subjectId, { transaction });
  await publish(transaction, 'review.edited', existing, { stars, status: existing.status }, principal);
  await audit.record({ action: 'review.edited', actor: principal, entityType: 'review', entityId: existing.id, before, after: { stars, status: existing.status, sourceId: d.sourceId }, reason: 'newer gym pass', req }, { transaction });
  return { review: view(existing, await directory.publicNames([principal.id], { transaction })), updated: true };
}

/**
 * POST /reviews { sourceType, sourceId, stars | rating, text } (v1: { bookingId, stars, text }).
 * Returns { review } (201), or { review, updated: true } (200) when a gym review was updated.
 */
async function post(principal, body, req) {
  const sourceType = body.sourceType ?? 'booking';
  const sourceId = body.sourceId ?? body.bookingId;
  const stars = body.stars ?? body.rating;
  const text = body.text ?? null;
  const d = await port.describe(sourceType, sourceId, principal.id);
  if (!d) throw E.notFound(NOUNS[sourceType] ?? 'Source');
  if (!d.eligible) throw fail(d.reason);
  d.sourceId = sourceId;
  try {
    return await sequelize.transaction(async (transaction) => {
      if (d.oneReviewPerSubject) {
        const existing = await Review.findOne({ where: { authorId: principal.id, subjectType: d.subjectType, subjectId: d.subjectId }, transaction, lock: transaction.LOCK.UPDATE });
        if (existing) return repost(principal, existing, d, { stars, text }, { transaction, req });
      }
      const disputeActive = await disputes().activeFor(sourceType, sourceId, { transaction });
      const first = rules.initialReview({ disputeActive, text });
      const r = await Review.create(
        {
          subjectType: d.subjectType,
          subjectId: d.subjectId,
          subjectOwnerId: d.ownerId,
          sourceType,
          sourceId,
          authorId: principal.id,
          stars,
          text,
          status: first.status,
          heldReason: first.heldReason,
          editUntil: new Date(Date.now() + settings.get('reviews.edit_days') * DAY),
        },
        { transaction }
      );
      if (r.status === 'published') await recompute(r.subjectType, r.subjectId, { transaction });
      await publish(transaction, 'review.posted', r, { ownerId: d.ownerId, stars, status: r.status }, principal);
      await audit.record({ action: 'review.posted', actor: principal, entityType: 'review', entityId: r.id, after: { stars, status: r.status, sourceType }, req }, { transaction });
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
  const [names, subjects] = await Promise.all([directory.publicNames([principal.id]), subjectsOf(rows)]);
  return { items: rows.map((r) => view(r, names, { subjects })) };
}

// ---------------------------------------------------------------- public and the owner (FR-34, FR-35)

/** GET /reviews?subjectType&subjectId&cursor: published reviews, newest first, with the summary. */
async function publicListFor(subjectType, subjectId, { cursor, limit = 20 } = {}) {
  const where = { subjectType, subjectId, status: 'published' };
  if (cursor) where.createdAt = { [Op.lt]: new Date(cursor) };
  const rows = await Review.findAll({ where, order: [['createdAt', 'DESC']], limit: limit + 1 });
  const p = page(rows, limit);
  const names = await directory.publicNames(p.items.map((r) => r.authorId));
  return { summary: await summary(subjectType, subjectId), items: p.items.map((r) => view(r, names, { scope: 'public' })), nextCursor: p.nextCursor };
}

/** GET /grounds/:id/reviews (v1). */
const publicList = (groundId, query = {}) => publicListFor('ground', groundId, query);

/**
 * GET /me/reviews?role=owner&subjectType&subjectId&cursor: published reviews of what the caller owns
 * (their venues, pro profiles, shops and gyms), to reply to. /me/ground-reviews is the ground alias.
 */
async function ownerList(principal, { subjectType, subjectId, groundId, cursor, limit = 50 } = {}) {
  const where = { subjectOwnerId: principal.id, status: 'published' };
  // Round B3 (Q170): venue staff with the optional reviews.reply permission see that venue's reviews,
  // under actFor's staff rule (a verified phone and an active account, else 403 PHONE_REQUIRED).
  const venueId = (subjectType === 'ground' || subjectType === undefined) ? subjectId ?? groundId : null;
  const w = venueId ? access().workplaceAt(principal, 'venue', venueId) : null;
  if (w && w.permissions.includes('reviews.reply')) where.subjectOwnerId = access().actFor(principal, 'venue', venueId, 'reviews.reply', { ownerId: w.ownerId, notFound: 'Venue' }).ownerId;
  if (subjectType) where.subjectType = subjectType;
  if (subjectId ?? groundId) where.subjectId = subjectId ?? groundId;
  if (cursor) where.createdAt = { [Op.lt]: new Date(cursor) };
  const rows = await Review.findAll({ where, order: [['createdAt', 'DESC']], limit: limit + 1 });
  const p = page(rows, limit);
  const [names, subjects] = await Promise.all([directory.publicNames(p.items.map((r) => r.authorId)), subjectsOf(p.items)]);
  return { items: p.items.map((r) => view(r, names, { subjects })), nextCursor: p.nextCursor };
}

/** The owner of a review's subject: stored at posting; asked of the source for a row without it. */
async function ownerOf(r, { transaction }) {
  if (r.subjectOwnerId) return r.subjectOwnerId;
  const src = await port.get(r.sourceType)?.source(r.sourceId, { transaction });
  return src?.ownerId ?? null;
}

/**
 * Who may reply: the subject's owner (FR-34), or for a venue its staff with the optional
 * reviews.reply permission (Round B3, Q170; off by default). Staff of another venue get a 404.
 */
async function replier(principal, r, { transaction }) {
  const ownerId = await ownerOf(r, { transaction });
  if (ownerId === principal.id) return { actor: principal };
  if (r.subjectType !== 'ground') throw fail('NOT_OWNER');
  return access().actFor(principal, 'venue', r.subjectId, 'reviews.reply', { ownerId, notFound: 'Review', foreign: () => fail('NOT_OWNER') });
}

/** POST /me/reviews/:id/reply { text } (the subject's owner, or venue staff with reviews.reply; FR-34). */
async function reply(principal, id, { text }, req) {
  return sequelize.transaction(async (transaction) => {
    const r = await Review.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!r) throw E.notFound('Review');
    const { actor } = await replier(principal, r, { transaction });
    if (r.status !== 'published') throw fail('REVIEW_STATE', { status: r.status });
    const block = rules.replyBlock(text);
    if (block) throw fail(block);
    const firstReply = !r.replyText;
    await r.update({ replyText: text, repliedBy: principal.id, repliedAt: new Date() }, { transaction });
    await publish(transaction, 'review.replied', r, { firstReply }, actor);
    await audit.record({ action: 'review.replied', actor, entityType: 'review', entityId: r.id, after: { firstReply }, req }, { transaction });
    return { review: view(r, await directory.publicNames([r.authorId], { transaction })) };
  });
}

// ---------------------------------------------------------------- staff (FR-36) and reports

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

/** GET /admin/reviews?status=held|hidden|published&subjectType&subjectId (groundId: v1) */
async function adminList({ status = 'held', subjectType, subjectId, groundId, cursor, limit = 50 } = {}) {
  const where = { status };
  if (subjectType) where.subjectType = subjectType;
  if (subjectId ?? groundId) where.subjectId = subjectId ?? groundId;
  if (cursor) where.createdAt = { [Op.lt]: new Date(cursor) };
  const rows = await Review.findAll({ where, order: [['createdAt', 'ASC']], limit: limit + 1 });
  const p = page(rows, limit);
  const names = await directory.publicNames(p.items.map((r) => r.authorId));
  return { items: p.items.map((r) => view(r, names, { staff: true })), nextCursor: p.nextCursor };
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

/** Reports: the subject behind a review (its author and subject) and a locked row. */
const get = (id, { transaction } = {}) => Review.findByPk(id, { transaction });

/** Display facts for notifications (groundName/groundSlug: the v1 names, now any subject's name). */
async function facts(id) {
  const r = await Review.findByPk(id);
  if (!r) throw E.notFound('Review');
  const s = await port.subjectOf(r.subjectType, r.subjectId);
  const name = s?.name ?? '';
  const slug = s?.slug ?? null;
  return { stars: r.stars, subjectType: r.subjectType, subjectName: name, subjectSlug: slug, groundName: name, groundSlug: slug, hiddenReason: r.hiddenReason ?? null };
}

module.exports = { recompute, summary, ratingOf, holdForSource, releaseForSource, reviewable, post, edit, listMine, publicListFor, publicList, ownerList, reply, hideInTx, restoreInTx, lockReview, adminList, staffAction, get, facts, view };
