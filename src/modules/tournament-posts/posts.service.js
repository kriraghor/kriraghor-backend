'use strict';

/**
 * M26 posts: anyone with a verified phone posts a tournament they run elsewhere, and it shows at once
 * (M26-FR-01). The feed filters and sorts them (M26-FR-05). Authors edit and close their own posts;
 * staff can remove and restore them, and an open post expires a while after its last day (M26-FR-08).
 */
const crypto = require('crypto');
const { Op, fn, col, where: sqlWhere } = require('sequelize');
const { E } = require('../../common/errors');
const storage = require('../../common/storage');
const { sniffMime, PHOTO_TYPES, fileBlock } = require('../../common/filetype');
const { uuid7 } = require('../../common/uuid7');
const { sequelize, TournamentPost, TournamentPostPhoto, TournamentPostThread } = require('../../models');
const { Sport, Division, District, Area } = require('../catalog').reference;
const audit = require('../audit').audit;
const directory = require('../users').directory;
const rules = require('./tournament-posts.rules');
const c = require('./tournament-posts.common');

const { fail } = c;
const DAY_MS = 86400000;
const label = (row) => (row ? { id: row.id, en: row.nameEn, bn: row.nameBn } : null);
const today = () => rules.dhakaDate(new Date());
const ORDER = {
  newest: [['createdAt', 'DESC']],
  starts_soon: [['startDate', 'ASC'], ['createdAt', 'DESC']],
  deadline_soon: [['registrationDeadline', 'ASC'], ['createdAt', 'DESC']],
  most_discussed: [['commentCount', 'DESC'], ['lastActivityAt', 'DESC NULLS LAST'], ['createdAt', 'DESC']],
};
const escapeLike = (text) => text.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Everything the cards need for these posts, in one read per table. */
async function lookups(posts) {
  const of = (key) => [...new Set(posts.map((p) => p[key]).filter(Boolean))];
  const [sports, divisions, districts, areas, photos, names] = await Promise.all([
    Sport.findAll({ where: { id: of('sportId') } }),
    Division.findAll({ where: { id: of('divisionId') } }),
    District.findAll({ where: { id: of('districtId') } }),
    Area.findAll({ where: { id: of('areaId') } }),
    TournamentPostPhoto.findAll({ where: { postId: posts.map((p) => p.id), status: 'active' }, order: [['sort', 'ASC'], ['createdAt', 'ASC']] }),
    directory.publicNames(posts.map((p) => p.authorId)),
  ]);
  const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
  const photosOf = new Map();
  for (const ph of photos) photosOf.set(ph.postId, [...(photosOf.get(ph.postId) ?? []), ph]);
  return { sports: byId(sports), divisions: byId(divisions), districts: byId(districts), areas: byId(areas), photosOf, names };
}

const photoView = (ph) => ({ id: ph.id, url: storage.publicUrl(ph.storageKey) });

function card(p, l) {
  const sport = l.sports.get(p.sportId);
  const who = l.names.get(p.authorId);
  const cover = l.photosOf.get(p.id)?.[0];
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    sport: { key: sport?.key ?? '', en: sport?.nameEn ?? '', bn: sport?.nameBn ?? '' },
    format: p.format,
    division: label(l.divisions.get(p.divisionId)),
    district: label(l.districts.get(p.districtId)),
    area: label(l.areas.get(p.areaId)),
    venueName: p.venueName,
    startDate: p.startDate,
    endDate: p.endDate ?? null,
    registrationDeadline: p.registrationDeadline,
    registrationOpen: rules.registrationOpen(p, today()),
    entryFee: p.entryFeePoisha,
    prizePool: p.prizePoolPoisha,
    gender: p.gender,
    ageGroup: p.ageGroup ?? null,
    skillLevel: p.skillLevel ?? null,
    organiserName: p.organiserName,
    cover: cover ? storage.publicUrl(cover.storageKey) : null,
    commentCount: p.commentCount,
    status: p.status,
    author: { displayName: who?.displayName ?? '', username: who?.username ?? null, avatarUrl: who?.avatarUrl ?? null },
    createdAt: c.iso(p.createdAt),
  };
}

async function cards(posts) {
  if (!posts.length) return [];
  const l = await lookups(posts);
  return posts.map((p) => card(p, l));
}

/** The full post, for its page and for its author. `viewerId` adds what this person can do. */
async function pageOf(p, viewerId = null) {
  const l = await lookups([p]);
  const mine = Boolean(viewerId) && p.authorId === viewerId;
  const thread = viewerId && !mine ? await TournamentPostThread.findOne({ where: { postId: p.id, playerId: viewerId }, attributes: ['id'] }) : null;
  return {
    ...card(p, l),
    address: p.address ?? null,
    mapLink: p.mapLink ?? null,
    prizeDetails: p.prizeDetails ?? null,
    teamLimit: p.teamLimit ?? null,
    playersPerTeam: p.playersPerTeam ?? null,
    description: p.description,
    rules: p.rules ?? null,
    photos: (l.photosOf.get(p.id) ?? []).map(photoView),
    removedReason: mine ? (p.removedReason ?? null) : null,
    mine,
    threadId: thread?.id ?? null,
    can: {
      edit: mine && rules.canEdit(p.status),
      close: mine && rules.canClose(p.status),
      comment: rules.canComment(p.status),
      message: !mine && rules.canOpenThread(p.status),
    },
  };
}

/** The feed's filters as a where clause; `status` defaults to open posts. */
function feedWhere({ sport, divisionId, districtId, areaId, from, to, fee, format, gender, skill, registrationOpen, q }, sportId) {
  const where = { status: 'open' };
  if (sport) where.sportId = sportId;
  if (divisionId) where.divisionId = divisionId;
  if (districtId) where.districtId = districtId;
  if (areaId) where.areaId = areaId;
  if (from || to) where.startDate = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lte]: to } : {}) };
  const feeRule = rules.feeWhere(fee);
  if (feeRule) where.entryFeePoisha = feeRule.gt === undefined ? 0 : { [Op.gt]: 0 };
  if (format) where.format = format;
  if (gender) where.gender = gender;
  if (skill) where.skillLevel = skill;
  if (registrationOpen) where.registrationDeadline = { [Op.gte]: today() };
  if (q) {
    const needle = `%${escapeLike(q.toLowerCase())}%`;
    where[Op.or] = ['title', 'organiser_name', 'venue_name'].map((name) => sqlWhere(fn('lower', col(name)), { [Op.like]: needle }));
  }
  return where;
}

/** GET /tournament-posts: the feed (M26-FR-05). */
async function list(query) {
  const { sort = 'newest', cursor, limit = 20 } = query;
  let sportId = null;
  if (query.sport) {
    const s = await Sport.findOne({ where: { key: query.sport }, attributes: ['id'] });
    if (!s) return { items: [], total: 0, nextCursor: null };
    sportId = s.id;
  }
  const offset = cursor ? Number(cursor) : 0;
  const { rows, count } = await TournamentPost.findAndCountAll({ where: feedWhere(query, sportId), order: ORDER[sort], limit, offset });
  return { items: await cards(rows), total: count, nextCursor: offset + limit < count ? String(offset + limit) : null };
}

/** GET /tournament-posts/:slug: anyone, unless staff removed it (then only its author). */
async function page(slug, viewerId = null) {
  const p = await TournamentPost.findOne({ where: { slug } });
  if (!p || (!rules.isVisible(p.status) && p.authorId !== viewerId)) throw fail('TOURNAMENT_POST_NOT_FOUND');
  return pageOf(p, viewerId);
}

/** The sport and place behind a post's ids, checked against the catalogue. */
async function placed({ sport, districtId, areaId }) {
  const s = await Sport.findOne({ where: { key: sport, isActive: true }, attributes: ['id'] });
  if (!s) throw fail('TOURNAMENT_POST_SPORT_UNKNOWN');
  const d = await District.findByPk(districtId, { attributes: ['id', 'divisionId'] });
  if (!d) throw fail('TOURNAMENT_POST_PLACE_UNKNOWN');
  if (areaId) {
    const a = await Area.findByPk(areaId, { attributes: ['id', 'districtId'] });
    if (!a || a.districtId !== d.id) throw fail('TOURNAMENT_POST_PLACE_UNKNOWN');
  }
  return { sportId: s.id, divisionId: d.divisionId, districtId: d.id, areaId: areaId ?? null };
}

/** The refusals every save shares (M26-FR-03, M26-FR-04). */
function checkContent(fields, dates) {
  const block = rules.datesBlock(fields, today(), dates);
  if (block) throw fail(block);
  if (!rules.mapLinkOk(fields.mapLink)) throw fail('TOURNAMENT_POST_MAP_LINK');
  const field = rules.contactField(fields);
  if (field) throw fail('CONTACT_NOT_ALLOWED', { field });
}

const contentOf = (body) => ({
  title: body.title,
  format: body.format,
  venueName: body.venueName,
  address: body.address ?? null,
  mapLink: body.mapLink ?? null,
  startDate: body.startDate,
  endDate: body.endDate ?? null,
  registrationDeadline: body.registrationDeadline,
  entryFeePoisha: body.entryFee,
  prizePoolPoisha: body.prizePool ?? null,
  prizeDetails: body.prizeDetails ?? null,
  teamLimit: body.teamLimit ?? null,
  playersPerTeam: body.playersPerTeam ?? null,
  gender: body.gender ?? 'open',
  ageGroup: body.ageGroup ?? null,
  skillLevel: body.skillLevel ?? null,
  organiserName: body.organiserName,
  description: body.description,
  rules: body.rules ?? null,
});

/** POST /me/tournament-posts (gate post_tournament): live at once (M26-FR-01). */
async function create(principal, body, req) {
  const content = contentOf(body);
  checkContent(content, { isNew: true });
  const place = await placed(body);
  return sequelize.transaction(async (transaction) => {
    const open = await TournamentPost.count({ where: { authorId: principal.id, status: 'open' }, transaction });
    if (open >= c.config().maxActivePerUser) throw fail('TOURNAMENT_POST_LIMIT');
    // Counted from real posts, not attempts: a refused form (a typo, a phone number) costs nothing.
    const today = await TournamentPost.count({ where: { authorId: principal.id, createdAt: { [Op.gt]: new Date(Date.now() - DAY_MS) } }, transaction });
    if (today >= c.config().postsPerDay) throw fail('TOURNAMENT_POST_DAILY_LIMIT');
    const id = uuid7();
    const p = await TournamentPost.create({ id, slug: rules.slugOf(content.title, id), authorId: principal.id, ...content, ...place, status: 'open', lastActivityAt: new Date() }, { transaction });
    await audit.record({ action: 'tournament_post.created', actor: principal, entityType: 'tournament_post', entityId: p.id, after: { title: p.title }, req }, { transaction });
    await c.publish(transaction, 'tournament_post.created', p, {}, principal);
    return { id: p.id, slug: p.slug };
  });
}

/** The author's post, locked. */
async function ownedPost(principal, id, transaction) {
  const p = await c.lockPost(id, transaction);
  if (p.authorId !== principal.id) throw fail('TOURNAMENT_POST_NOT_YOURS');
  return p;
}

/** PATCH /me/tournament-posts/:id: the whole form again, while the post is open. */
async function update(principal, id, body, req) {
  const content = contentOf(body);
  const place = await placed(body);
  return sequelize.transaction(async (transaction) => {
    const p = await ownedPost(principal, id, transaction);
    if (!rules.canEdit(p.status)) throw fail('TOURNAMENT_POST_STATE', { status: p.status });
    checkContent(content, { startChanged: content.startDate !== p.startDate });
    await p.update({ ...content, ...place, lastActivityAt: new Date() }, { transaction });
    await audit.record({ action: 'tournament_post.updated', actor: principal, entityType: 'tournament_post', entityId: p.id, req }, { transaction });
    return { id: p.id, slug: p.slug };
  });
}

/** POST /me/tournament-posts/:id/close: the author takes it off the feed. */
async function close(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const p = await ownedPost(principal, id, transaction);
    if (!rules.canClose(p.status)) throw fail('TOURNAMENT_POST_STATE', { status: p.status });
    await p.update({ status: 'closed', closedAt: new Date() }, { transaction });
    await audit.record({ action: 'tournament_post.closed', actor: principal, entityType: 'tournament_post', entityId: p.id, req }, { transaction });
    await c.publish(transaction, 'tournament_post.closed', p, {}, principal);
    return { id: p.id, status: p.status };
  });
}

/** GET /me/tournament-posts: my posts, removed ones included so I can see why. */
async function mine(principal, { cursor, limit = 20 } = {}) {
  const offset = cursor ? Number(cursor) : 0;
  const { rows, count } = await TournamentPost.findAndCountAll({ where: { authorId: principal.id }, order: [['createdAt', 'DESC']], limit, offset });
  const l = rows.length ? await lookups(rows) : null;
  return { items: rows.map((p) => ({ ...card(p, l), removedReason: p.removedReason ?? null })), total: count, nextCursor: offset + limit < count ? String(offset + limit) : null };
}

/** POST /me/tournament-posts/:id/photos (raw body): one photo, the first is the cover. */
async function addPhoto(principal, id, { contentType, body }, req) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const cfg = c.config();
  const block = fileBlock({ declared, sniffed: sniffMime(buf), size: buf.length, max: cfg.photoMaxBytes });
  if (block) throw fail(block);
  return sequelize.transaction(async (transaction) => {
    const p = await ownedPost(principal, id, transaction);
    if (!rules.canEdit(p.status)) throw fail('TOURNAMENT_POST_STATE', { status: p.status });
    const count = await TournamentPostPhoto.count({ where: { postId: p.id, status: 'active' }, transaction });
    if (count >= cfg.maxPhotos) throw fail('PHOTO_LIMIT');
    const photoId = uuid7();
    const storageKey = `tournament-posts/${p.id}/${photoId}.${PHOTO_TYPES[declared]}`;
    await storage.putPublic(storageKey, buf, declared);
    const top = await TournamentPostPhoto.max('sort', { where: { postId: p.id, status: 'active' }, transaction });
    const photo = await TournamentPostPhoto.create(
      { id: photoId, postId: p.id, storageKey, mime: declared, sizeBytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), sort: Number.isFinite(top) ? top + 1 : 0, createdBy: principal.id },
      { transaction }
    );
    await audit.record({ action: 'tournament_post.photo_added', actor: principal, entityType: 'tournament_post', entityId: p.id, meta: { photoId: photo.id }, req }, { transaction });
    return photoView(photo);
  });
}

/** POST /me/tournament-posts/:id/photos/:photoId/remove: removal is a status. */
async function removePhoto(principal, id, photoId, req) {
  return sequelize.transaction(async (transaction) => {
    const p = await ownedPost(principal, id, transaction);
    if (!rules.canEdit(p.status)) throw fail('TOURNAMENT_POST_STATE', { status: p.status });
    const photo = await TournamentPostPhoto.findOne({ where: { id: photoId, postId: p.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!photo) throw fail('PHOTO_NOT_FOUND');
    await photo.update({ status: 'removed' }, { transaction });
    await audit.record({ action: 'tournament_post.photo_removed', actor: principal, entityType: 'tournament_post', entityId: p.id, meta: { photoId }, req }, { transaction });
    return { removed: photo.id };
  });
}

// ---------------------------------------------------------------- staff

/** In the caller's transaction: M17 reports call this when a post is upheld as content_removed. */
async function removeInTx(actor, id, { reason, transaction, req }) {
  const p = await c.lockPost(id, transaction);
  if (!rules.canRemove(p.status)) return p;
  await p.update({ statusBeforeRemoval: p.status, status: 'removed', removedReason: reason, removedBy: actor.id, removedAt: new Date() }, { transaction });
  await audit.record({ action: 'tournament_post.removed', actor, entityType: 'tournament_post', entityId: p.id, reason, req }, { transaction });
  await c.publish(transaction, 'tournament_post.removed', p, { reason }, actor);
  return p;
}

/** POST /admin/tournament-posts/:id/remove { reason } (M26-FR-09). */
async function staffRemove(actor, id, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const p = await removeInTx(actor, id, { reason, transaction, req });
    return { id: p.id, status: p.status };
  });
}

/** POST /admin/tournament-posts/:id/restore { reason }: back to what it was. */
async function staffRestore(actor, id, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const p = await c.lockPost(id, transaction);
    if (!rules.canRestore(p.status)) throw fail('TOURNAMENT_POST_STATE', { status: p.status });
    await p.update({ status: rules.restoredStatus(p), statusBeforeRemoval: null, removedReason: null, removedBy: null, removedAt: null }, { transaction });
    await audit.record({ action: 'tournament_post.restored', actor, entityType: 'tournament_post', entityId: p.id, reason, req }, { transaction });
    await c.publish(transaction, 'tournament_post.restored', p, {}, actor);
    return { id: p.id, status: p.status };
  });
}

/** GET /admin/tournament-posts?status&q&cursor&limit: every post, removed ones too. */
async function staffList({ status, q, cursor, limit = 25 } = {}) {
  const where = {};
  if (status) where.status = status;
  if (q) where.title = { [Op.iLike]: `%${escapeLike(q)}%` };
  const offset = cursor ? Number(cursor) : 0;
  const { rows, count } = await TournamentPost.findAndCountAll({ where, order: [['createdAt', 'DESC']], limit, offset });
  const l = rows.length ? await lookups(rows) : null;
  return { items: rows.map((p) => ({ ...card(p, l), removedReason: p.removedReason ?? null })), total: count, nextCursor: offset + limit < count ? String(offset + limit) : null };
}

/** GET /admin/tournament-posts/:id: the whole post, removed or not. */
async function staffGet(id) {
  const p = await TournamentPost.findByPk(id);
  if (!p) throw E.notFound('Post');
  return { ...(await pageOf(p)), removedReason: p.removedReason ?? null };
}

// ---------------------------------------------------------------- the job

/** Job tournament_posts.tick: open posts past their last day plus the setting expire (M26-FR-08). */
async function expireDue(now = new Date()) {
  const day = rules.dhakaDate(now);
  const days = c.config().expireDaysAfterEnd;
  const cut = rules.addDays(day, -days);
  const due = await TournamentPost.findAll({ where: { status: 'open', startDate: { [Op.lt]: cut }, [Op.or]: [{ endDate: null }, { endDate: { [Op.lt]: cut } }] }, attributes: ['id'], limit: 200 });
  let expired = 0;
  for (const { id } of due) {
    await sequelize.transaction(async (transaction) => {
      const p = await c.lockPost(id, transaction);
      if (!rules.expiryDue(p, day, days)) return;
      await p.update({ status: 'expired', expiredAt: now }, { transaction });
      await c.publish(transaction, 'tournament_post.expired', p, {}, null);
      expired += 1;
    });
  }
  return { expired };
}

/** For M17 reports: who owns it and how it reads on the desk (no PII). */
async function facts(id) {
  const p = await TournamentPost.findByPk(id, { attributes: ['id', 'authorId', 'title', 'slug', 'status'] });
  return p ? { id: p.id, authorId: p.authorId, title: p.title, slug: p.slug, status: p.status } : null;
}

module.exports = { list, page, create, update, close, mine, addPhoto, removePhoto, removeInTx, staffRemove, staffRestore, staffList, staffGet, expireDue, facts };
