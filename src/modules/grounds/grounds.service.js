'use strict';

/**
 * M09 listings (§5.1, §5.2): owner CRUD, courts and hours, review through M05, live versions.
 *
 *   draft ─submit─▶ pending_review ─approved─▶ live ⇄ paused
 *                                  ─changes──▶ changes_requested ─submit─▶ pending_review
 *                                  ─rejected─▶ rejected
 *   pending_review ─withdraw─▶ withdrawn ─submit─▶ pending_review
 *   live/paused ─staff─▶ suspended ─master─▶ live;  master ─▶ removed
 *
 * A published ground keeps its public version in live_snapshot. Changing a review field (FR-04: name,
 * address, pin, indoor, photos, courts) puts the working copy in edit_status `draft`; the owner sends
 * the edit for review and the public keeps the snapshot until it is approved (FR-03). Other fields
 * (description, rules, facilities, cutoff) apply to the snapshot at once; hours and pricing never need
 * review. Nothing is deleted: courts retire, photos are removed by status.
 */
const { Op, QueryTypes } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, Ground, Court, CourtHours, GroundPhoto, PricingRule, Sport, Surface, Facility, Area } = require('../../models');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const settings = require('../settings/settings.service');
const moderation = require('../moderation/moderation.service');
const authz = require('../auth/authz.service');
const directory = require('../users/directory.service');
const rules = require('./grounds.rules');
const pr = require('./pricing.rules');
const c = require('./grounds.common');
const pricing = require('./pricing.service');
const occupancy = require('./occupancy.port');

const { fail } = c;
const SPORT_GROUNDS = 1; // sports.vertical_flags bit

const inReview = (g) => g.status === 'pending_review' || g.editStatus === 'pending_review';

function assertEditable(g) {
  if (inReview(g)) throw fail('GROUND_IN_REVIEW');
  if (!rules.isEditable(g.status, g.editStatus)) throw fail('GROUND_STATE');
}

/** A published ground with a review field changed: the working copy becomes an unsent edit. */
function markEdited(g) {
  if (rules.isPublished(g.status) && (!g.editStatus || g.editStatus === 'rejected')) g.editStatus = 'draft';
}

async function uniqueSlug(name, areaKey, transaction) {
  const base = rules.slugify(name, areaKey);
  for (let i = 1; ; i += 1) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!(await Ground.findOne({ where: { slug }, attributes: ['id'], transaction }))) return slug;
  }
}

async function view(groundId, { transaction } = {}) {
  const w = await c.loadWorking(groundId, { transaction });
  return c.ownerView(w, await c.pricingOf(groundId, { transaction }));
}

// ---------------------------------------------------------------- owner: grounds

/** POST /me/grounds (FR-01; gate list_ground in the route): a draft with a first pricing draft. */
async function create(principal, body, req) {
  const errors = pr.validate({ ...c.defaultRules(body.basePricePoisha) }, c.limits());
  const baseError = errors?.find((e) => e.field === 'basePricePoisha');
  if (baseError) throw E.validation([baseError]);
  return sequelize.transaction(async (transaction) => {
    const area = await c.groundArea(body.areaId, { transaction });
    const facilityIds = await c.activeIds(Facility, body.facilityIds ?? [], 'facilityIds', { transaction });
    const g = await Ground.create(
      {
        ownerId: principal.id,
        name: body.name,
        slug: await uniqueSlug(body.name, area.nameEn, transaction),
        areaId: area.id,
        addressLine: body.addressLine,
        lat: body.lat,
        lng: body.lng,
        isIndoor: body.isIndoor ?? false,
        description: body.description ?? null,
        rulesText: body.rulesText ?? null,
        facilityIds,
        bookingCutoffMin: body.bookingCutoffMin ?? 0,
        requiresOfficial: body.requiresOfficial ?? [],
        status: 'draft',
        statusChangedAt: new Date(),
        createdBy: principal.id,
        updatedBy: principal.id,
      },
      { transaction }
    );
    await PricingRule.create({ groundId: g.id, version: 1, status: 'draft', ...c.defaultRules(body.basePricePoisha), createdBy: principal.id, updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'ground.created', actor: principal, entityType: 'ground', entityId: g.id, after: { name: g.name, areaId: g.areaId, status: g.status }, req }, { transaction });
    return view(g.id, { transaction });
  });
}

/** GET /me/grounds: my grounds (not removed), newest change first, with cover and base price. */
async function listMine(principal) {
  const grounds = await Ground.findAll({ where: { ownerId: principal.id, status: { [Op.ne]: 'removed' } }, order: [['updatedAt', 'DESC']] });
  const ids = grounds.map((g) => g.id);
  const [photos, courts, prices] = ids.length
    ? await Promise.all([
        GroundPhoto.findAll({ where: { groundId: ids, status: 'active' }, order: [['sort', 'ASC']] }),
        Court.findAll({ where: { groundId: ids, ...c.ACTIVE_COURTS }, attributes: ['groundId'] }),
        PricingRule.findAll({ where: { groundId: ids, status: ['published', 'draft'] } }),
      ])
    : [[], [], []];
  return {
    items: grounds.map((g) => {
      const cover = photos.find((p) => p.groundId === g.id);
      const price = prices.find((p) => p.groundId === g.id && p.status === 'published') ?? prices.find((p) => p.groundId === g.id);
      return {
        id: g.id,
        slug: g.slug,
        name: g.name,
        areaId: g.areaId,
        status: g.status,
        editStatus: g.editStatus ?? null,
        coverUrl: cover ? c.photoView(cover).url : null,
        courtsCount: courts.filter((x) => x.groundId === g.id).length,
        basePricePoisha: price?.basePricePoisha ?? null,
        reviewReason: g.reviewReasonCode ? { code: g.reviewReasonCode, text: g.reviewReasonText ?? null } : null,
        updatedAt: g.updatedAt,
      };
    }),
  };
}

async function getMine(principal, groundId) {
  const g = await c.owned(principal, groundId);
  return view(g.id);
}

/** PATCH /me/grounds/:id (FR-04): review fields mark an edit; the others reach the live version now. */
async function update(principal, groundId, patch, req) {
  return sequelize.transaction(async (transaction) => {
    const g = await c.owned(principal, groundId, { transaction, lock: true });
    assertEditable(g);
    if (patch.areaId) await c.groundArea(patch.areaId, { transaction });
    if (patch.facilityIds) patch.facilityIds = await c.activeIds(Facility, patch.facilityIds, 'facilityIds', { transaction });
    const reviewChanged = rules.groundReviewChanges(g, patch);
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, g[k] ?? null]));
    for (const [k, v] of Object.entries(patch)) g[k] = v;
    if (rules.isPublished(g.status)) {
      const live = Object.fromEntries(rules.GROUND_LIVE_FIELDS.filter((k) => k in patch).map((k) => [k, patch[k]]));
      if (Object.keys(live).length) g.liveSnapshot = { ...g.liveSnapshot, ...live };
      if (reviewChanged.length) markEdited(g);
    }
    g.updatedBy = principal.id;
    await g.save({ transaction });
    await audit.record({ action: 'ground.updated', actor: principal, entityType: 'ground', entityId: g.id, before, after: patch, meta: { needsReview: reviewChanged }, req }, { transaction });
    return view(g.id, { transaction });
  });
}

// ---------------------------------------------------------------- owner: courts and hours

async function courtOf(principal, courtId, { transaction, lock = false } = {}) {
  const court = await Court.findByPk(courtId, { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!court || court.status === 'retired') throw E.notFound('Court');
  const g = await c.owned(principal, court.groundId, { transaction, lock });
  return { court, g };
}

async function validCourt(body, transaction) {
  if (body.sportIds) await c.activeIds(Sport, body.sportIds, 'sportIds', { transaction, flag: SPORT_GROUNDS });
  if (body.surfaceId) await c.activeIds(Surface, [body.surfaceId], 'surfaceId', { transaction });
}

function checkHours(rows) {
  const errors = rules.hoursBlock(rows, c.grid());
  if (errors) throw E.validation(errors);
}

/** Every weekday open for the whole bookable day: a starting point the owner edits. */
const fullWeek = () => {
  const { open, close } = c.grid();
  return Array.from({ length: 7 }, (_, dow) => ({ dow, isClosed: false, openTime: open, closeTime: close }));
};

async function writeHours(courtId, rows, transaction) {
  const existing = await CourtHours.findAll({ where: { courtId }, transaction, lock: transaction.LOCK.UPDATE });
  for (const r of rows) {
    const values = { isClosed: Boolean(r.isClosed), openTime: r.isClosed ? null : r.openTime, closeTime: r.isClosed ? null : r.closeTime };
    const row = existing.find((h) => h.dow === r.dow);
    if (row) await row.update(values, { transaction });
    else await CourtHours.create({ courtId, dow: r.dow, ...values }, { transaction });
  }
}

/** POST /me/grounds/:id/courts: a pending court (bookable once the ground or the edit is approved). */
async function addCourt(principal, groundId, body, req) {
  return sequelize.transaction(async (transaction) => {
    const g = await c.owned(principal, groundId, { transaction, lock: true });
    assertEditable(g);
    await validCourt(body, transaction);
    const hours = body.hours ?? fullWeek();
    checkHours(hours);
    const sort = body.sort ?? (await Court.count({ where: { groundId: g.id }, transaction }));
    let court;
    try {
      court = await Court.create(
        {
          groundId: g.id,
          name: body.name,
          sportIds: [...new Set(body.sportIds)],
          surfaceId: body.surfaceId,
          sizeText: body.sizeText ?? null,
          capacityText: body.capacityText ?? null,
          combinableGroup: body.combinableGroup ?? null,
          sort,
          status: 'pending',
          createdBy: principal.id,
          updatedBy: principal.id,
        },
        { transaction }
      );
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') throw E.conflict('COURT_NAME_TAKEN', 'This ground already has a court with that name');
      throw err;
    }
    await writeHours(court.id, hours, transaction);
    markEdited(g);
    await g.save({ transaction });
    await audit.record({ action: 'ground_court.added', actor: principal, entityType: 'court', entityId: court.id, after: { name: court.name, groundId: g.id }, req }, { transaction });
    return view(g.id, { transaction });
  });
}

/** PATCH /me/courts/:id: sports, surface, size or name of an active court need review (FR-04). */
async function updateCourt(principal, courtId, patch, req) {
  return sequelize.transaction(async (transaction) => {
    const { court, g } = await courtOf(principal, courtId, { transaction, lock: true });
    assertEditable(g);
    await validCourt(patch, transaction);
    const changed = rules.courtReviewChanges(court, patch);
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, court[k] ?? null]));
    try {
      await court.update({ ...patch, ...(patch.sportIds ? { sportIds: [...new Set(patch.sportIds)] } : {}), updatedBy: principal.id }, { transaction });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') throw E.conflict('COURT_NAME_TAKEN', 'This ground already has a court with that name');
      throw err;
    }
    if (court.status === 'active' && changed.length) {
      markEdited(g);
      await g.save({ transaction });
    }
    await audit.record({ action: 'ground_court.updated', actor: principal, entityType: 'court', entityId: court.id, before, after: patch, meta: { needsReview: changed }, req }, { transaction });
    return view(g.id, { transaction });
  });
}

/** POST /me/courts/:id/retire (FR-06): only without upcoming bookings; a live ground keeps one court. */
async function retireCourt(principal, courtId, req) {
  return sequelize.transaction(async (transaction) => {
    const { court, g } = await courtOf(principal, courtId, { transaction, lock: true });
    if (inReview(g)) throw fail('GROUND_IN_REVIEW');
    if ((await occupancy.countUpcoming({ courtIds: [court.id] }, { transaction })) > 0) throw fail('COURT_HAS_BOOKINGS');
    if (rules.isPublished(g.status) && court.status === 'active') {
      const left = g.liveSnapshot.courts.filter((x) => x.id !== court.id);
      if (!left.length) throw fail('LAST_COURT');
      // Retiring is not a review change: the public version drops the court at once.
      g.liveSnapshot = { ...g.liveSnapshot, courts: left };
      await g.save({ transaction });
    }
    await court.update({ status: 'retired', retiredAt: new Date(), updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'ground_court.retired', actor: principal, entityType: 'court', entityId: court.id, meta: { groundId: g.id }, req }, { transaction });
    return view(g.id, { transaction });
  });
}

/** PUT /me/courts/:id/hours (FR-07, FR-08): never reviewed; refused if bookings fall outside. */
async function setHours(principal, courtId, rows, req) {
  checkHours(rows);
  return sequelize.transaction(async (transaction) => {
    const { court, g } = await courtOf(principal, courtId, { transaction, lock: true });
    if (['rejected', 'suspended'].includes(g.status)) throw fail('GROUND_STATE');
    const conflicts = await occupancy.findConflicts({ courtIds: [court.id], outsideHours: rows }, { transaction });
    if (conflicts.length) throw fail('HOURS_CONFLICT', { meta: { conflicts } });
    await writeHours(court.id, rows, transaction);
    await audit.record({ action: 'ground_court.hours_set', actor: principal, entityType: 'court', entityId: court.id, after: { hours: rows }, meta: { groundId: g.id }, req }, { transaction });
    return view(g.id, { transaction });
  });
}

// ---------------------------------------------------------------- owner: review, pause, withdraw

/** What a ground must have before review (shown to the owner; the reviewer sees the checks). */
async function completeness(w, transaction) {
  const problems = [];
  const minPhotos = settings.get('ground.min_photos');
  if (w.photos.length < minPhotos) problems.push({ field: 'photos', message: `Add at least ${minPhotos} photos` });
  if (!w.courts.length) problems.push({ field: 'courts', message: 'Add at least one court' });
  for (const court of w.courts) {
    if (!rules.hasOpenDay(c.hoursOf(w.hours, court.id))) problems.push({ field: `courts.${court.id}`, message: `${court.name} needs opening hours on at least one day` });
  }
  const { published, draft } = await c.pricingOf(w.ground.id, { transaction });
  if (!published && !draft) problems.push({ field: 'pricing', message: 'Set a base price' });
  return problems;
}

/** POST /me/grounds/:id/submit (FR-02, FR-03): a first review, or an edit of a published ground. */
async function submit(principal, groundId, req) {
  return sequelize.transaction(async (transaction) => {
    const g = await c.owned(principal, groundId, { transaction, lock: true });
    const w = await c.loadWorking(g.id, { transaction });
    const problems = await completeness(w, transaction);
    if (problems.length) throw fail('GROUND_INCOMPLETE', { errors: problems });
    const published = rules.isPublished(g.status);
    let diff;
    if (published) {
      if (!['draft', 'changes_requested', 'rejected'].includes(g.editStatus)) throw fail('NOTHING_TO_REVIEW');
      diff = rules.reviewDiff(g.liveSnapshot, c.workingShape(w));
      if (rules.diffIsEmpty(diff)) throw fail('NOTHING_TO_REVIEW');
    } else {
      if (!rules.next('submit', g.status)) throw inReview(g) ? fail('GROUND_IN_REVIEW') : fail('GROUND_STATE');
      diff = rules.reviewDiff(null, c.workingShape(w));
    }
    const version = g.liveVersion + 1;
    const { published: price, draft } = await c.pricingOf(g.id, { transaction });
    const sub = await moderation.submit(
      {
        kind: 'ground',
        subjectId: g.id,
        payload: { groundId: g.id, version, isEdit: published, diff, basePricePoisha: (price ?? draft).basePricePoisha, courts: w.courts.length, photos: w.photos.length },
        title: `${g.name} · v${version}${published ? ' (edit)' : ''}`,
        submittedBy: principal.id,
        isEdit: published,
      },
      { transaction }
    );
    if (published) g.editStatus = 'pending_review';
    else {
      g.status = 'pending_review';
      g.statusChangedAt = new Date();
    }
    await g.update({ editStatus: g.editStatus, status: g.status, statusChangedAt: g.statusChangedAt, currentSubmissionId: sub.id, reviewReasonCode: null, reviewReasonText: null, updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'ground.submitted', actor: principal, entityType: 'ground', entityId: g.id, after: { status: g.status, editStatus: g.editStatus ?? null }, meta: { submissionId: sub.id, version, isEdit: published }, req }, { transaction });
    await events.publish(transaction, { name: 'ground.submitted', aggregateType: 'ground', aggregateId: g.id, payload: { groundId: g.id, ownerId: g.ownerId, version, isEdit: published } });
    return view(g.id, { transaction });
  });
}

/** POST /me/grounds/:id/withdraw: take a ground (or an edit) out of review. */
async function withdraw(principal, groundId, req) {
  return sequelize.transaction(async (transaction) => {
    const g = await c.owned(principal, groundId, { transaction, lock: true });
    if (!inReview(g)) throw fail('GROUND_STATE');
    const isEdit = g.editStatus === 'pending_review';
    await g.update({ ...(isEdit ? { editStatus: 'draft' } : { status: 'withdrawn', statusChangedAt: new Date() }), currentSubmissionId: null, updatedBy: principal.id }, { transaction });
    await moderation.withdrawSubject('ground', g.id, { transaction });
    await audit.record({ action: 'ground.withdrawn', actor: principal, entityType: 'ground', entityId: g.id, meta: { isEdit }, req }, { transaction });
    if (!isEdit) await events.publish(transaction, { name: 'ground.withdrawn', aggregateType: 'ground', aggregateId: g.id, payload: { groundId: g.id, ownerId: g.ownerId } });
    return view(g.id, { transaction });
  });
}

async function move(actor, groundId, action, { transaction, req, reason = null, eventName, extra = {} }) {
  const g = await Ground.findByPk(groundId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!g || g.status === 'removed') throw E.notFound('Ground');
  const to = rules.next(action, g.status);
  if (!to) throw fail('GROUND_STATE');
  const from = g.status;
  await g.update({ status: to, statusChangedAt: new Date(), updatedBy: actor?.id ?? null }, { transaction });
  await audit.record({ action: `ground.${eventName}`, actor, entityType: 'ground', entityId: g.id, before: { status: from }, after: { status: to }, reason, req }, { transaction });
  await events.publish(transaction, { name: `ground.${eventName}`, aggregateType: 'ground', aggregateId: g.id, payload: { groundId: g.id, ownerId: g.ownerId, ...extra } });
  return g;
}

/** POST /me/grounds/:id/pause and /resume (FR-05): hidden, no new holds; bookings stay. */
async function setPaused(principal, groundId, paused, req) {
  return sequelize.transaction(async (transaction) => {
    await c.owned(principal, groundId, { transaction });
    await move(principal, groundId, paused ? 'pause' : 'resume', { transaction, req, eventName: paused ? 'paused' : 'resumed', extra: paused ? { reason: 'owner' } : {} });
    return view(groundId, { transaction });
  });
}

// ---------------------------------------------------------------- staff (manage_users) and masters

/** GET /admin/grounds: every ground (not removed unless asked), newest change first; name or slug search. */
async function staffList({ status, q, limit = 50 } = {}) {
  const where = { ...(status ? { status } : { status: { [Op.ne]: 'removed' } }) };
  if (q) where[Op.or] = [{ name: { [Op.iLike]: `%${q}%` } }, { slug: { [Op.iLike]: `%${q}%` } }];
  const grounds = await Ground.findAll({ where, order: [['updatedAt', 'DESC']], limit });
  const ids = grounds.map((g) => g.id);
  const covers = ids.length ? await GroundPhoto.findAll({ where: { groundId: ids, status: 'active' }, order: [['sort', 'ASC']] }) : [];
  const owners = await directory.publicNames(grounds.map((g) => g.ownerId));
  return {
    items: grounds.map((g) => {
      const cover = covers.find((p) => p.groundId === g.id);
      return {
        id: g.id,
        slug: g.slug,
        name: g.name,
        areaId: g.areaId,
        status: g.status,
        editStatus: g.editStatus ?? null,
        liveVersion: g.liveVersion,
        owner: { id: g.ownerId, displayName: owners.get(g.ownerId)?.displayName ?? null },
        coverUrl: cover ? c.photoView(cover).url : null,
        updatedAt: g.updatedAt,
      };
    }),
  };
}

/** GET /admin/grounds/:id: the working copy, the public version and pricing, for reviewers and ops. */
async function staffGet(groundId) {
  const w = await c.loadWorking(groundId);
  if (!w) throw E.notFound('Ground');
  const { published, draft } = await c.pricingOf(groundId);
  const owner = (await directory.publicNames([w.ground.ownerId])).get(w.ground.ownerId);
  return {
    ...c.ownerView(w, { published, draft }),
    owner: { id: w.ground.ownerId, displayName: owner?.displayName ?? null },
    publicVersion: w.ground.liveSnapshot ? { version: w.ground.liveSnapshot.version, name: w.ground.liveSnapshot.name, courts: w.ground.liveSnapshot.courts.length, photos: w.ground.liveSnapshot.photos.length } : null,
    rules: pricing.serializeRules(draft ?? published),
  };
}

async function staffAction(actor, groundId, action, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const names = { suspend: 'suspended', restore: 'restored', remove: 'removed' };
    const g = await move(actor, groundId, action, { transaction, req, reason, eventName: names[action], extra: action === 'restore' ? {} : { reason } });
    if (action !== 'restore') await moderation.withdrawSubject('ground', g.id, { transaction });
    return { id: g.id, status: g.status };
  });
}

// ---------------------------------------------------------------- M05 decisions (consumer, idempotent)

const DECIDED_EVENT = { changes_requested: 'ground.changes_requested', rejected: 'ground.rejected' };

/** Apply an M05 decision on a ground submission (inside the inbox transaction). */
async function applyDecision(submissionId, status, { transaction }) {
  const sub = await moderation.getById(submissionId, { transaction });
  if (!sub) return null;
  const ack = () =>
    events.publish(transaction, { name: 'submission.applied', aggregateType: 'submission', aggregateId: sub.id, payload: { submissionId: sub.id, kind: sub.kind, subjectId: sub.subjectId, version: sub.version, submittedBy: sub.submittedBy } });
  const g = await Ground.findByPk(sub.payload.groundId, { transaction, lock: transaction.LOCK.UPDATE });
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
    await g.update(
      { ...(isEdit ? { editStatus: status } : { status, statusChangedAt: now }), currentSubmissionId: null, reviewReasonCode: sub.reasonCode ?? null, reviewReasonText: sub.reasonText ?? null },
      { transaction }
    );
    await audit.record({ action: DECIDED_EVENT[status], actor: null, entityType: 'ground', entityId: g.id, after: { status: g.status, editStatus: g.editStatus ?? null, reasonCode: sub.reasonCode ?? null }, meta: { submissionId: sub.id, decidedBy: sub.decidedBy } }, { transaction });
    await events.publish(transaction, { name: DECIDED_EVENT[status], aggregateType: 'ground', aggregateId: g.id, payload: { groundId: g.id, ownerId: g.ownerId, isEdit, reasonCode: sub.reasonCode ?? null } });
    return status;
  }
  // Approved: pending courts become bookable and the working copy becomes the public version.
  await Court.update({ status: 'active' }, { where: { groundId: g.id, status: 'pending' }, transaction });
  const w = await c.loadWorking(g.id, { transaction });
  const first = !rules.isPublished(g.status);
  const version = g.liveVersion + 1;
  await g.update(
    {
      status: first ? 'live' : g.status,
      editStatus: null,
      liveVersion: version,
      liveSnapshot: c.snapshotOf(w, version),
      currentSubmissionId: null,
      reviewReasonCode: null,
      reviewReasonText: null,
      ...(first ? { firstLiveAt: now, statusChangedAt: now } : {}),
    },
    { transaction }
  );
  const { published, draft } = await c.pricingOf(g.id, { transaction });
  if (!published && draft) await pricing.publishDraft(g, draft, { actor: null, transaction });
  await audit.record({ action: 'ground.published', actor: null, entityType: 'ground', entityId: g.id, after: { status: g.status, version }, meta: { submissionId: sub.id, decidedBy: sub.decidedBy, first } }, { transaction });
  await events.publish(transaction, { name: 'ground.published', aggregateType: 'ground', aggregateId: g.id, payload: { groundId: g.id, ownerId: g.ownerId, version, first } });
  await ack();
  return 'approved';
}

/** user_role.suspended / .withdrawn (ground_owner), user.suspended / .banned: pause every live ground. */
async function pauseAllOf(userId, reason, { transaction }) {
  const live = await Ground.findAll({ where: { ownerId: userId, status: 'live' }, transaction, lock: transaction.LOCK.UPDATE });
  for (const g of live) await move(null, g.id, 'pause', { transaction, reason, eventName: 'paused', extra: { reason } });
  return live.length;
}

// ---------------------------------------------------------------- M05 automatic checks (FR-02, M05 §6.1)

/** The checks shown to the reviewer, re-run on every claim. */
async function checksFor(groundId, { transaction }) {
  const w = await c.loadWorking(groundId, { transaction });
  if (!w) return [];
  const g = w.ground;
  const ok = (key, pass, severity, detail = null) => ({ key, severity, result: pass ? 'pass' : 'fail', detail: pass ? null : detail });
  const owner = await authz.loadPrincipal(g.ownerId);
  const minPhotos = settings.get('ground.min_photos');
  const { published, draft } = await c.pricingOf(g.id, { transaction });
  const price = draft ?? published;
  const priceErrors = price ? pr.validate(c.rulesOf(price), c.limits()) : [{ field: 'pricing', message: 'No price' }];
  const courtsOk = w.courts.length > 0 && w.courts.every((x) => x.sportIds.length > 0 && rules.hasOpenDay(c.hoursOf(w.hours, x.id)));
  const radius = settings.get('ground.duplicate_radius_m');
  const similar = await sequelize.query(
    "SELECT id, name, lat, lng FROM grounds WHERE id <> :id AND status NOT IN ('removed', 'rejected', 'withdrawn', 'draft') AND similarity(lower(name), lower(:name)) > 0.5",
    { replacements: { id: g.id, name: g.name }, type: QueryTypes.SELECT, transaction }
  );
  const near = similar.filter((s) => rules.distanceM({ lat: Number(s.lat), lng: Number(s.lng) }, g) <= radius);
  return [
    ok('owner_kyc_approved', owner?.roles?.ground_owner === 'active', 'hard', 'The owner documents are not approved'),
    ok('photos_min', w.photos.length >= minPhotos, 'hard', `${w.photos.length} of ${minPhotos} photos`),
    ok('hours_and_rules_valid', courtsOk && !priceErrors, 'hard', priceErrors ? priceErrors.map((e) => e.message).join('; ') : 'A court has no sport or no opening hours'),
    ok('price_in_range', Boolean(price) && !priceErrors?.some((e) => e.field === 'basePricePoisha'), 'soft', 'The base price is outside the allowed range'),
    ok('name_unique_in_area', near.length === 0, 'soft', near.length ? `Similar name within ${radius} m: ${near.map((s) => s.name).join(', ')}` : null),
  ];
}

/** Display facts for notifications (M08 reads them here). */
async function facts(groundId) {
  const g = await Ground.findByPk(groundId, { attributes: ['id', 'name', 'slug', 'areaId', 'reviewReasonCode', 'reviewReasonText'] });
  if (!g) throw E.notFound('Ground');
  const area = await Area.findByPk(g.areaId, { attributes: ['nameEn', 'nameBn'] });
  return { name: g.name, slug: g.slug, areaEn: area?.nameEn ?? null, areaBn: area?.nameBn ?? null, reasonCode: g.reviewReasonCode ?? null, reasonText: g.reviewReasonText ?? null };
}

module.exports = {
  create,
  listMine,
  getMine,
  update,
  addCourt,
  updateCourt,
  retireCourt,
  setHours,
  submit,
  withdraw,
  setPaused,
  staffAction,
  staffList,
  staffGet,
  applyDecision,
  pauseAllOf,
  checksFor,
  facts,
  view,
};
