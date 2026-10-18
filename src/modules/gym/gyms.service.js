'use strict';

/**
 * M20 gym listings (FR-01, FR-02), owner side on vendor.kriraghor.com (/me/gyms; gate list_gym).
 *  - The owner edits a working copy: basics, facilities, weekly windows (some women-only), photos and
 *    one package per kind (day, month, quarter). Submit sends it to the Moderation desk (M05 kind
 *    `gym`) with the automatic checks; approval writes live_snapshot (hours and packages included),
 *    which is all the public and the front desk read. An edit of a live gym waits beside it.
 *  - Staff suspend (manage_users) and restore (masters); a sanctioned owner's gyms pause.
 */
const crypto = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const { E } = require('../../common/errors');
const storage = require('../../common/storage');
const { sniffMime } = require('../../common/filetype');
const { uuid7 } = require('../../common/uuid7');
const { sequelize, Gym, GymHours, GymPhoto, GymPackage, Area, Facility } = require('../../models');
const audit = require('../audit/audit.service');
const moderation = require('../moderation/moderation.service');
const authz = require('../auth/authz.service');
const { slugify } = require('../market/market.rules');
const rules = require('./gym.rules');
const c = require('./gym.common');

const { fail } = c;
const PUBLISHED = ['live', 'paused', 'suspended'];
const isPublished = (s) => PUBLISHED.includes(s);
const inReview = (g) => g.status === 'pending_review' || g.editStatus === 'pending_review';
const FIELDS = ['name', 'areaId', 'addressLine', 'lat', 'lng', 'about', 'facilityIds', 'dailyCapacity'];
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// ---------------------------------------------------------------- working copy and snapshot

async function loadWorking(gymId, { transaction } = {}) {
  const gym = await Gym.findByPk(gymId, { transaction });
  if (!gym) return null;
  const [photos, hours, packages] = await Promise.all([
    GymPhoto.findAll({ where: { gymId, status: 'active' }, order: [['sort', 'ASC'], ['createdAt', 'ASC']], transaction }),
    GymHours.findAll({ where: { gymId, removedAt: null }, transaction }),
    GymPackage.findAll({ where: { gymId, status: 'active' }, transaction }),
  ]);
  return { gym, photos, hours: c.hoursView(hours), packages: packages.sort((a, b) => rules.KINDS.indexOf(a.kind) - rules.KINDS.indexOf(b.kind)) };
}

const packageView = (p) => ({ id: p.id, kind: p.kind, title: p.title, price: p.pricePoisha, days: p.days });

/** The public version (live_snapshot), built from the working copy at approval. */
const snapshotOf = ({ gym: g, photos, hours, packages }, version) => ({
  version,
  name: g.name,
  areaId: g.areaId,
  addressLine: g.addressLine,
  lat: g.lat,
  lng: g.lng,
  about: g.about ?? null,
  facilityIds: g.facilityIds,
  dailyCapacity: g.dailyCapacity ?? null,
  photos: photos.map((p) => ({ id: p.id, key: p.storageKey })),
  hours,
  packages: packages.map(packageView),
});

/** What changed between two versions (photos compared by id). */
function diffOf(live, next) {
  const shape = (s) => (s ? { ...s, photos: (s.photos ?? []).map((p) => p.id), version: undefined } : {});
  const a = shape(live);
  const b = shape(next);
  return Object.fromEntries(
    Object.keys(b)
      .filter((k) => k !== 'version' && JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null))
      .map((k) => [k, { from: a[k] ?? null, to: b[k] }])
  );
}

function ownerView(w) {
  const g = w.gym;
  return {
    id: g.id,
    slug: g.slug,
    status: g.status,
    editStatus: g.editStatus ?? null,
    liveVersion: g.liveVersion,
    name: g.name,
    areaId: g.areaId,
    addressLine: g.addressLine,
    lat: g.lat,
    lng: g.lng,
    about: g.about ?? null,
    facilityIds: g.facilityIds,
    dailyCapacity: g.dailyCapacity ?? null,
    photos: w.photos.map((p) => ({ id: p.id, url: storage.publicUrl(p.storageKey) })),
    hours: w.hours,
    packages: w.packages.map(packageView),
    reviewReason: g.reviewReasonCode ? { code: g.reviewReasonCode, text: g.reviewReasonText ?? null } : null,
    limits: { dayMin: c.config().dayMin, dayMax: c.config().dayMax, minPhotos: c.config().minPhotos, maxPhotos: c.config().maxPhotos },
    firstLiveAt: c.iso(g.firstLiveAt),
  };
}

const view = async (id, { transaction } = {}) => ownerView(await loadWorking(id, { transaction }));

async function owned(principal, id, { transaction, lock = false } = {}) {
  const g = lock ? await c.lockGym(id, transaction) : await Gym.findByPk(id, { transaction });
  if (!g || g.status === 'removed') throw E.notFound('Gym');
  if (g.ownerId !== principal.id) throw fail('NOT_OWNER');
  return g;
}

/** An edit is allowed unless the gym is in review, rejected, suspended or removed; a live gym marks an edit. */
function editable(g) {
  if (inReview(g)) throw fail('GYM_IN_REVIEW');
  if (['rejected', 'suspended', 'removed'].includes(g.status)) throw fail('GYM_STATE');
}
const markEdited = (g) => (isPublished(g.status) ? { editStatus: 'draft' } : {});

async function validFields(body, transaction) {
  if (body.areaId) {
    const a = await Area.findByPk(body.areaId, { transaction });
    if (!a || a.isActive === false) throw fail('AREA_UNKNOWN');
  }
  if (body.facilityIds?.length) {
    const unique = [...new Set(body.facilityIds)];
    if ((await Facility.count({ where: { id: unique, isActive: true }, transaction })) !== unique.length) throw fail('CATALOG_ITEM_UNKNOWN');
  }
}

// ---------------------------------------------------------------- owner

/** POST /me/gyms: a draft gym. */
async function create(principal, body, req) {
  const id = await sequelize.transaction(async (transaction) => {
    await validFields(body, transaction);
    const area = await Area.findByPk(body.areaId, { transaction });
    const base = slugify(`${body.name} ${area.key}`, 'gym');
    let slug = base;
    for (let i = 2; await Gym.findOne({ where: { slug }, attributes: ['id'], transaction }); i += 1) slug = `${base}-${i}`;
    const g = await Gym.create({ ownerId: principal.id, slug, ...Object.fromEntries(FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]])), status: 'draft', createdBy: principal.id, updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'gym.created', actor: principal, entityType: 'gym', entityId: g.id, after: { name: g.name, status: g.status }, req }, { transaction });
    return g.id;
  });
  return view(id);
}

/** GET /me/gyms. */
async function listMine(principal) {
  const rows = await Gym.findAll({ where: { ownerId: principal.id, status: { [Op.ne]: 'removed' } }, order: [['createdAt', 'ASC']], attributes: ['id'] });
  return { items: await Promise.all(rows.map((r) => view(r.id))) };
}

async function getMine(principal, id) {
  await owned(principal, id);
  return view(id);
}

/** PATCH /me/gyms/:id: the working copy. */
async function update(principal, id, patch, req) {
  await sequelize.transaction(async (transaction) => {
    const g = await owned(principal, id, { transaction, lock: true });
    editable(g);
    await validFields(patch, transaction);
    const changes = Object.fromEntries(FIELDS.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]]));
    await g.update({ ...changes, ...markEdited(g), updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'gym.updated', actor: principal, entityType: 'gym', entityId: g.id, after: { fields: Object.keys(changes) }, req }, { transaction });
  });
  return view(id);
}

/** PUT /me/gyms/:id/hours: the whole week of windows. */
async function setHours(principal, id, rows, req) {
  const errors = rules.hoursErrors(rows);
  if (errors.length) throw E.validation(errors);
  await sequelize.transaction(async (transaction) => {
    const g = await owned(principal, id, { transaction, lock: true });
    editable(g);
    await GymHours.update({ removedAt: new Date() }, { where: { gymId: g.id, removedAt: null }, transaction });
    await GymHours.bulkCreate(rows.map((r) => ({ gymId: g.id, dow: r.dow, openTime: r.openTime, closeTime: r.closeTime, womenOnly: Boolean(r.womenOnly) })), { transaction });
    await g.update({ ...markEdited(g), updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'gym.hours_set', actor: principal, entityType: 'gym', entityId: g.id, after: { windows: rows.length }, req }, { transaction });
  });
  return view(id);
}

/** PUT /me/gyms/:id/packages: the active package of each kind (an omitted kind is retired). */
async function setPackages(principal, id, items, req) {
  const cfg = c.config();
  const errors = rules.packageErrors(items.map((p) => ({ kind: p.kind, price: p.price })), cfg);
  if (new Set(items.map((p) => p.kind)).size !== items.length) errors.push({ field: 'packages', message: 'One package per kind' });
  if (errors.length) throw E.validation(errors);
  await sequelize.transaction(async (transaction) => {
    const g = await owned(principal, id, { transaction, lock: true });
    editable(g);
    const current = await GymPackage.findAll({ where: { gymId: g.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    for (const p of current) {
      const next = items.find((i) => i.kind === p.kind);
      if (!next || next.price !== p.pricePoisha || next.title !== p.title) await p.update({ status: 'retired', updatedBy: principal.id }, { transaction });
    }
    for (const i of items) {
      const same = current.find((p) => p.kind === i.kind && p.pricePoisha === i.price && p.title === i.title);
      if (!same) await GymPackage.create({ gymId: g.id, kind: i.kind, title: i.title, pricePoisha: i.price, days: rules.daysOf(i.kind, cfg), createdBy: principal.id, updatedBy: principal.id }, { transaction });
    }
    await g.update({ ...markEdited(g), updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'gym.packages_set', actor: principal, entityType: 'gym', entityId: g.id, after: { packages: items.map((i) => `${i.kind}:${i.price}`) }, req }, { transaction });
  });
  return view(id);
}

/** Why an upload is refused, or null (declared type, real type, size). */
function fileBlock({ declared, sniffed, size, max }) {
  if (!size) return 'FILE_EMPTY';
  if (size > max) return 'FILE_TOO_LARGE';
  if (!PHOTO_TYPES[declared]) return 'FILE_TYPE_NOT_ALLOWED';
  if (sniffed !== declared) return 'FILE_TYPE_MISMATCH';
  return null;
}

/** POST /me/gyms/:id/photos (raw body): one photo, appended last (public bucket, key never reused). */
async function addPhoto(principal, id, { contentType, body }, req) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const cfg = c.config();
  const block = fileBlock({ declared, sniffed: sniffMime(buf), size: buf.length, max: cfg.photoMaxBytes });
  if (block) throw fail(block);
  return sequelize.transaction(async (transaction) => {
    const g = await owned(principal, id, { transaction, lock: true });
    editable(g);
    if ((await GymPhoto.count({ where: { gymId: g.id, status: 'active' }, transaction })) >= cfg.maxPhotos) throw fail('PHOTO_LIMIT');
    const photoId = uuid7();
    const storageKey = `gyms/${g.id}/${photoId}.${PHOTO_TYPES[declared]}`;
    await storage.putPublic(storageKey, buf, declared);
    const top = await GymPhoto.max('sort', { where: { gymId: g.id, status: 'active' }, transaction });
    const photo = await GymPhoto.create(
      { id: photoId, gymId: g.id, storageKey, mime: declared, sizeBytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), sort: Number.isFinite(top) ? top + 1 : 0, versionAdded: g.liveVersion + 1, createdBy: principal.id, updatedBy: principal.id },
      { transaction }
    );
    await g.update({ ...markEdited(g), updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'gym_photo.added', actor: principal, entityType: 'gym', entityId: g.id, meta: { photoId, sizeBytes: buf.length }, req }, { transaction });
    return { id: photo.id, url: storage.publicUrl(storageKey) };
  });
}

/** PUT /me/gyms/:id/photos/order: every active photo id, first = cover. */
async function reorderPhotos(principal, id, ids, req) {
  await sequelize.transaction(async (transaction) => {
    const g = await owned(principal, id, { transaction, lock: true });
    editable(g);
    const photos = await GymPhoto.findAll({ where: { gymId: g.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    if (photos.length !== ids.length || new Set(ids).size !== ids.length || photos.some((p) => !ids.includes(p.id))) throw fail('PHOTOS_MISMATCH');
    for (const p of photos) await p.update({ sort: ids.indexOf(p.id) }, { transaction });
    await g.update({ ...markEdited(g), updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'gym_photo.reordered', actor: principal, entityType: 'gym', entityId: g.id, meta: { order: ids }, req }, { transaction });
  });
  return view(id);
}

/** POST /me/gyms/:id/photos/:photoId/remove: status `removed` (the object stays for the version history). */
async function removePhoto(principal, id, photoId, req) {
  await sequelize.transaction(async (transaction) => {
    const g = await owned(principal, id, { transaction, lock: true });
    editable(g);
    const photo = await GymPhoto.findOne({ where: { id: photoId, gymId: g.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!photo) throw E.notFound('Photo');
    await photo.update({ status: 'removed', removedAt: new Date(), updatedBy: principal.id }, { transaction });
    await g.update({ ...markEdited(g), updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'gym_photo.removed', actor: principal, entityType: 'gym', entityId: g.id, meta: { photoId }, req }, { transaction });
  });
  return view(id);
}

/** What the listing still lacks before review (field errors). */
function completeness(w) {
  const cfg = c.config();
  const problems = [];
  if (w.photos.length < cfg.minPhotos) problems.push({ field: 'photos', message: `Add at least ${cfg.minPhotos} photos` });
  if (!rules.hasOpenDay(w.hours)) problems.push({ field: 'hours', message: 'Add the opening hours' });
  problems.push(...rules.packageErrors(w.packages.map((p) => ({ kind: p.kind, price: p.pricePoisha })), cfg));
  return problems;
}

/** POST /me/gyms/:id/submit: send the gym (or its edit) to the Moderation desk. */
async function submit(principal, id, req) {
  await sequelize.transaction(async (transaction) => {
    const g = await owned(principal, id, { transaction, lock: true });
    if (inReview(g)) throw fail('GYM_IN_REVIEW');
    const w = await loadWorking(g.id, { transaction });
    const problems = completeness(w);
    if (problems.length) throw fail('GYM_INCOMPLETE', { errors: problems });
    const published = isPublished(g.status);
    let diff;
    if (published) {
      if (!['draft', 'changes_requested', 'rejected'].includes(g.editStatus)) throw fail('NOTHING_TO_REVIEW');
      diff = diffOf(g.liveSnapshot, snapshotOf(w, null));
      if (!Object.keys(diff).length) throw fail('NOTHING_TO_REVIEW');
    } else {
      if (!['draft', 'changes_requested', 'withdrawn'].includes(g.status)) throw fail('GYM_STATE');
      diff = diffOf(null, snapshotOf(w, null));
    }
    const version = g.liveVersion + 1;
    const day = w.packages.find((p) => p.kind === 'day');
    const sub = await moderation.submit(
      { kind: 'gym', subjectId: g.id, payload: { gymId: g.id, version, isEdit: published, diff, dayPrice: day.pricePoisha, photos: w.photos.length }, title: `${g.name} · v${version}${published ? ' (edit)' : ''}`, submittedBy: principal.id, isEdit: published },
      { transaction }
    );
    await g.update({ ...(published ? { editStatus: 'pending_review' } : { status: 'pending_review', statusChangedAt: new Date() }), currentSubmissionId: sub.id, reviewReasonCode: null, reviewReasonText: null, updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'gym.submitted', actor: principal, entityType: 'gym', entityId: g.id, meta: { submissionId: sub.id, version, isEdit: published }, req }, { transaction });
    await c.publish(transaction, 'gym.submitted', 'gym', g.id, { gymId: g.id, ownerId: g.ownerId, version, isEdit: published });
  });
  return view(id);
}

/** POST /me/gyms/:id/pause | /resume: stop or start selling passes. */
async function setPaused(principal, id, paused, req) {
  await sequelize.transaction(async (transaction) => {
    const g = await owned(principal, id, { transaction, lock: true });
    if (g.status !== (paused ? 'live' : 'paused')) throw fail('GYM_STATE');
    await g.update({ status: paused ? 'paused' : 'live', statusChangedAt: new Date() }, { transaction });
    await audit.record({ action: paused ? 'gym.paused' : 'gym.resumed', actor: principal, entityType: 'gym', entityId: g.id, req }, { transaction });
    await c.publish(transaction, paused ? 'gym.paused' : 'gym.resumed', 'gym', g.id, { gymId: g.id, ownerId: g.ownerId });
  });
  return view(id);
}

// ---------------------------------------------------------------- M05 (adapter in gym.moderation)

const DECIDED_EVENT = { changes_requested: 'gym.changes_requested', rejected: 'gym.rejected' };

async function applyDecision(submissionId, status, { transaction }) {
  const sub = await moderation.getById(submissionId, { transaction });
  if (!sub) return null;
  const ack = () =>
    c.publish(transaction, 'submission.applied', 'submission', sub.id, { submissionId: sub.id, kind: sub.kind, subjectId: sub.subjectId, version: sub.version, submittedBy: sub.submittedBy });
  const g = await c.lockGym(sub.payload.gymId, transaction);
  if (!g || g.currentSubmissionId !== sub.id) {
    if (status === 'approved') await ack();
    return null;
  }
  const isEdit = Boolean(sub.payload.isEdit);
  const now = new Date();
  if (status === 'withdrawn') {
    await g.update({ ...(isEdit ? { editStatus: 'draft' } : { status: 'withdrawn', statusChangedAt: now }), currentSubmissionId: null }, { transaction });
    return 'withdrawn';
  }
  if (status !== 'approved') {
    await g.update({ ...(isEdit ? { editStatus: status } : { status, statusChangedAt: now }), currentSubmissionId: null, reviewReasonCode: sub.reasonCode ?? null, reviewReasonText: sub.reasonText ?? null }, { transaction });
    await audit.record({ action: DECIDED_EVENT[status], actor: null, entityType: 'gym', entityId: g.id, after: { status: g.status, editStatus: g.editStatus ?? null, reasonCode: sub.reasonCode ?? null }, meta: { submissionId: sub.id } }, { transaction });
    await c.publish(transaction, DECIDED_EVENT[status], 'gym', g.id, { gymId: g.id, ownerId: g.ownerId, isEdit, reasonCode: sub.reasonCode ?? null });
    return status;
  }
  const first = !isPublished(g.status);
  const version = g.liveVersion + 1;
  const snap = snapshotOf(await loadWorking(g.id, { transaction }), version);
  const price = (k) => snap.packages.find((p) => p.kind === k)?.price ?? null;
  await g.update(
    {
      status: first ? 'live' : g.status,
      editStatus: null,
      liveVersion: version,
      liveSnapshot: snap,
      publicName: snap.name,
      publicAreaId: snap.areaId,
      publicDayPricePoisha: price('day'),
      publicMonthPricePoisha: price('month'),
      currentSubmissionId: null,
      reviewReasonCode: null,
      reviewReasonText: null,
      ...(first ? { firstLiveAt: now, statusChangedAt: now } : {}),
    },
    { transaction }
  );
  await audit.record({ action: 'gym.published', actor: null, entityType: 'gym', entityId: g.id, after: { status: g.status, version }, meta: { submissionId: sub.id, first } }, { transaction });
  await c.publish(transaction, 'gym.published', 'gym', g.id, { gymId: g.id, ownerId: g.ownerId, version, first });
  await ack();
  return 'approved';
}

/** The M05 automatic checks of a gym submission (FR-02). */
async function checksFor(gymId, { transaction }) {
  const w = await loadWorking(gymId, { transaction });
  if (!w) return [];
  const g = w.gym;
  const cfg = c.config();
  const ok = (key, pass, severity, detail = null) => ({ key, severity, result: pass ? 'pass' : 'fail', detail: pass ? null : detail });
  const owner = await authz.loadPrincipal(g.ownerId);
  const [{ n }] = await sequelize.query(
    "SELECT COUNT(*)::int AS n FROM gyms WHERE id <> :id AND area_id = :area AND status IN ('live', 'paused', 'pending_review') AND similarity(name, :name) > 0.6",
    { replacements: { id: g.id, area: g.areaId, name: g.name }, type: QueryTypes.SELECT, transaction }
  );
  return [
    ok('owner_kyc_approved', owner?.roles?.gym_owner === 'active', 'hard', 'The gym owner role is not approved'),
    ok('photos_min', w.photos.length >= cfg.minPhotos, 'hard', `Fewer than ${cfg.minPhotos} photos`),
    ok('hours_valid', rules.hasOpenDay(w.hours) && !rules.hoursErrors(w.hours).length, 'hard', 'The opening hours are missing or invalid'),
    ok('packages_valid', !rules.packageErrors(w.packages.map((p) => ({ kind: p.kind, price: p.pricePoisha })), cfg).length, 'hard', 'The packages are missing or outside the limits'),
    ok('name_unique_in_area', n === 0, 'soft', 'Another gym in this area has a similar name'),
  ];
}

/** gym_owner suspended or withdrawn, or the account sanctioned: live gyms pause. */
async function pauseAllOf(userId, reason, { transaction }) {
  const live = await Gym.findAll({ where: { ownerId: userId, status: 'live' }, transaction, lock: transaction.LOCK.UPDATE });
  for (const g of live) {
    await g.update({ status: 'paused', statusChangedAt: new Date() }, { transaction });
    await c.publish(transaction, 'gym.paused', 'gym', g.id, { gymId: g.id, ownerId: g.ownerId, reason });
  }
  return live.length;
}

// ---------------------------------------------------------------- staff

async function staffList({ status, q, limit = 50 } = {}) {
  const rows = await Gym.findAll({ where: { ...(status ? { status } : { status: { [Op.ne]: 'draft' } }), ...(q ? { name: { [Op.iLike]: `%${q}%` } } : {}) }, order: [['updatedAt', 'DESC']], limit, attributes: ['id', 'ownerId'] });
  return { items: await Promise.all(rows.map((r) => view(r.id).then((v) => ({ ...v, ownerId: r.ownerId })))) };
}

/** Staff: one gym's working copy (the Moderation desk panel and /admin/gym). */
async function staffGet(id) {
  const g = await Gym.findByPk(id, { attributes: ['id', 'ownerId'] });
  if (!g) throw E.notFound('Gym');
  return { ...(await view(g.id)), ownerId: g.ownerId };
}

/** Staff: suspend (manage_users) or restore (masters) a gym, with a reason. */
async function staffAction(actor, id, action, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const g = await c.lockGym(id, transaction);
    if (!g) throw E.notFound('Gym');
    const to = action === 'suspend' ? (['live', 'paused'].includes(g.status) ? 'suspended' : null) : g.status === 'suspended' ? 'live' : null;
    if (!to) throw fail('GYM_STATE');
    await g.update({ status: to, statusChangedAt: new Date() }, { transaction });
    await audit.record({ action: `gym.${action === 'suspend' ? 'suspended' : 'restored'}`, actor, entityType: 'gym', entityId: g.id, after: { status: to }, reason, req }, { transaction });
    await c.publish(transaction, action === 'suspend' ? 'gym.suspended' : 'gym.restored', 'gym', g.id, { gymId: g.id, ownerId: g.ownerId, reason }, actor);
    return { id: g.id, status: g.status };
  });
}

/** Display facts for notifications (M08). */
async function facts(gymId) {
  const g = await Gym.findByPk(gymId, { attributes: ['name', 'slug', 'reviewReasonCode'] });
  return g ? { name: g.name, slug: g.slug, reasonCode: g.reviewReasonCode ?? null } : null;
}

module.exports = {
  loadWorking,
  snapshotOf,
  diffOf,
  create,
  listMine,
  getMine,
  update,
  setHours,
  setPackages,
  fileBlock,
  addPhoto,
  reorderPhotos,
  removePhoto,
  submit,
  setPaused,
  applyDecision,
  checksFor,
  pauseAllOf,
  staffList,
  staffGet,
  staffAction,
  facts,
  view,
};
