'use strict';

/**
 * M12 shops (§5.1 FR-01, v3 shop types). A user whose shop_owner role is active (M02 trade licence
 * and TIN approved, M01) opens one shop of a type from market.shop_types. The shop is reviewed on
 * the Moderation desk (M05 kind `shop`) like an M09 ground:
 *
 *   draft ─submit─▶ pending_review ─approved─▶ live ⇄ paused
 *                                  ─changes──▶ changes_requested ─submit─▶ pending_review
 *                                  ─rejected─▶ rejected
 *   live/paused ─staff─▶ suspended ─master─▶ live;  master ─▶ removed
 *
 * A published shop keeps its public version in live_snapshot. Changing the name, area or address
 * starts an edit (edit_status) that goes to review while the public keeps the snapshot; the about
 * text and the map pin apply at once. Stock rules are the shop's own settings (never reviewed).
 * Products show on Market only while their shop is live.
 */
const { Op, QueryTypes } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, Shop } = require('../../models');
const { Area } = require('../catalog').reference;
const audit = require('../audit').audit;
const events = require('../events').events;
const settings = require('../settings').settings;
const moderation = require('../moderation').moderation;
const authz = require('../auth').authz;
const directory = require('../users').directory;
const rules = require('./market.rules');
const c = require('./market.common');

const { fail } = c;
const inReview = (s) => s.status === 'pending_review' || s.editStatus === 'pending_review';

function assertEditable(s) {
  if (inReview(s)) throw fail('SHOP_IN_REVIEW');
  if (!rules.isEditable(s.status, s.editStatus)) throw fail('SHOP_STATE');
}

async function activeArea(areaId, { transaction } = {}) {
  const a = await Area.findByPk(areaId, { transaction });
  if (!a || !a.isActive) throw fail('AREA_UNKNOWN');
  return a;
}

async function uniqueSlug(name, transaction) {
  const base = rules.slugify(name, 'shop');
  for (let i = 1; ; i += 1) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!(await Shop.findOne({ where: { slug }, attributes: ['id'], transaction }))) return slug;
  }
}

/** The public version of a shop (live_snapshot), built at approval. */
const snapshotOf = (s, version) => ({ version, name: s.name, shopType: s.shopType, areaId: s.areaId, addressLine: s.addressLine, lat: s.lat ?? null, lng: s.lng ?? null, about: s.about ?? null });

const payload = (s, extra = {}) => ({ shopId: s.id, ownerId: s.ownerId, ...extra });
const publish = (transaction, name, s, extra) => events.publish(transaction, { name, aggregateType: 'shop', aggregateId: s.id, payload: payload(s, extra) });

// ---------------------------------------------------------------- owner

/** POST /shop/profile (FR-01; gate list_product): one draft shop per owner. */
async function create(principal, body, req) {
  if (!settings.get('market.shop_types').includes(body.shopType)) throw fail('SHOP_TYPE_UNKNOWN');
  return sequelize.transaction(async (transaction) => {
    if (await c.shopOf(principal.id, { transaction })) throw fail('SHOP_EXISTS');
    await activeArea(body.areaId, { transaction });
    let s;
    try {
      s = await Shop.create(
        {
          ownerId: principal.id,
          shopType: body.shopType,
          name: body.name,
          slug: await uniqueSlug(body.name, transaction),
          areaId: body.areaId,
          addressLine: body.addressLine,
          lat: body.lat ?? null,
          lng: body.lng ?? null,
          about: body.about ?? null,
          status: 'draft',
          statusChangedAt: new Date(),
          lowStockThreshold: settings.get('market.low_stock_default'),
          autoHideOutOfStock: true,
          mtoDaysDefault: settings.get('market.mto_days_default'),
          createdBy: principal.id,
          updatedBy: principal.id,
        },
        { transaction }
      );
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') throw fail('SHOP_EXISTS');
      throw err;
    }
    await audit.record({ action: 'shop.created', actor: principal, entityType: 'shop', entityId: s.id, after: { name: s.name, shopType: s.shopType, status: s.status }, req }, { transaction });
    return c.shopView(s);
  });
}

/** GET /shop/profile */
async function getMine(principal) {
  const s = await c.shopOf(principal.id);
  if (!s || s.status === 'removed') throw E.notFound('Shop');
  return c.shopView(s);
}

/** PATCH /shop/profile: name, area and address of a published shop start an edit; the rest apply at once. */
async function update(principal, patch, req) {
  return sequelize.transaction(async (transaction) => {
    const s = await c.myShop(principal, { transaction, lock: true });
    assertEditable(s);
    if (patch.shopType !== undefined && patch.shopType !== s.shopType) {
      // The type decides what the shop may sell; it is fixed once the shop has been approved.
      if (rules.isPublished(s.status)) throw fail('SHOP_STATE');
      if (!settings.get('market.shop_types').includes(patch.shopType)) throw fail('SHOP_TYPE_UNKNOWN');
    }
    if (patch.areaId) await activeArea(patch.areaId, { transaction });
    const reviewChanged = rules.changedFields(s, patch, rules.SHOP_REVIEW_FIELDS);
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, s[k] ?? null]));
    for (const [k, v] of Object.entries(patch)) s[k] = v;
    if (rules.isPublished(s.status)) {
      const live = Object.fromEntries(rules.SHOP_LIVE_FIELDS.filter((k) => k in patch).map((k) => [k, patch[k]]));
      if (Object.keys(live).length) s.liveSnapshot = { ...s.liveSnapshot, ...live };
      if (reviewChanged.length) s.editStatus = rules.editStatusAfterChange(s.status, s.editStatus);
    }
    s.updatedBy = principal.id;
    await s.save({ transaction });
    await audit.record({ action: 'shop.updated', actor: principal, entityType: 'shop', entityId: s.id, before, after: patch, meta: { needsReview: reviewChanged }, req }, { transaction });
    return c.shopView(s);
  });
}

/** POST /shop/profile/submit: a first review, or an edit of a published shop. */
async function submit(principal, req) {
  return sequelize.transaction(async (transaction) => {
    const s = await c.myShop(principal, { transaction, lock: true });
    const published = rules.isPublished(s.status);
    let diff;
    if (published) {
      if (!['draft', 'changes_requested', 'rejected'].includes(s.editStatus)) throw fail('NOTHING_TO_REVIEW');
      diff = rules.shopDiff(s.liveSnapshot, snapshotOf(s, null));
      if (rules.diffIsEmpty(diff)) throw fail('NOTHING_TO_REVIEW');
    } else {
      if (!rules.next('submit', s.status)) throw inReview(s) ? fail('SHOP_IN_REVIEW') : fail('SHOP_STATE');
      diff = rules.shopDiff(null, snapshotOf(s, null));
    }
    const version = s.liveVersion + 1;
    const sub = await moderation.submit(
      { kind: 'shop', subjectId: s.id, payload: { shopId: s.id, version, isEdit: published, diff, shopType: s.shopType }, title: `${s.name} · v${version}${published ? ' (edit)' : ''}`, submittedBy: principal.id, isEdit: published },
      { transaction }
    );
    const now = new Date();
    await s.update(
      { ...(published ? { editStatus: 'pending_review' } : { status: 'pending_review', statusChangedAt: now }), currentSubmissionId: sub.id, reviewReasonCode: null, reviewReasonText: null, updatedBy: principal.id },
      { transaction }
    );
    await audit.record({ action: 'shop.submitted', actor: principal, entityType: 'shop', entityId: s.id, after: { status: s.status, editStatus: s.editStatus ?? null }, meta: { submissionId: sub.id, version, isEdit: published }, req }, { transaction });
    await publish(transaction, 'shop.submitted', s, { version, isEdit: published });
    return c.shopView(s);
  });
}

/** POST /shop/profile/withdraw: take the shop (or its edit) out of review. */
async function withdraw(principal, req) {
  return sequelize.transaction(async (transaction) => {
    const s = await c.myShop(principal, { transaction, lock: true });
    if (!inReview(s)) throw fail('SHOP_STATE');
    const isEdit = s.editStatus === 'pending_review';
    await s.update({ ...(isEdit ? { editStatus: 'draft' } : { status: 'withdrawn', statusChangedAt: new Date() }), currentSubmissionId: null, updatedBy: principal.id }, { transaction });
    await moderation.withdrawSubject('shop', s.id, { transaction });
    await audit.record({ action: 'shop.withdrawn', actor: principal, entityType: 'shop', entityId: s.id, meta: { isEdit }, req }, { transaction });
    if (!isEdit) await publish(transaction, 'shop.withdrawn', s);
    return c.shopView(s);
  });
}

async function move(actor, shopId, action, { transaction, req, reason = null, eventName, extra = {} }) {
  const s = await Shop.findByPk(shopId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!s || s.status === 'removed') throw E.notFound('Shop');
  const to = rules.next(action, s.status);
  if (!to) throw fail('SHOP_STATE');
  const from = s.status;
  await s.update({ status: to, statusChangedAt: new Date(), updatedBy: actor?.id ?? null }, { transaction });
  await audit.record({ action: eventName, actor, entityType: 'shop', entityId: s.id, before: { status: from }, after: { status: to }, reason, req }, { transaction });
  await publish(transaction, eventName, s, extra);
  return s;
}

/** POST /shop/profile/pause and /resume: a paused shop and its products are hidden from Market. */
async function setPaused(principal, paused, req) {
  return sequelize.transaction(async (transaction) => {
    const s = await c.myShop(principal, { transaction });
    const moved = await move(principal, s.id, paused ? 'pause' : 'resume', { transaction, req, eventName: paused ? 'shop.paused' : 'shop.resumed', extra: paused ? { reason: 'owner' } : {} });
    return c.shopView(moved);
  });
}

/** PUT /shop/stock-rules (§4 Inventory desk; FR-06, FR-14, FR-15): explicit save, audited. */
async function setStockRules(principal, body, req) {
  if (body.mtoDaysDefault !== undefined && body.mtoDaysDefault > settings.get('market.mto_days_max')) throw fail('MTO_DAYS_INVALID');
  return sequelize.transaction(async (transaction) => {
    const s = await c.myShop(principal, { transaction, lock: true });
    const before = c.shopView(s).stockRules;
    await s.update({ ...body, updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'shop.stock_rules_set', actor: principal, entityType: 'shop', entityId: s.id, before, after: c.shopView(s).stockRules, req }, { transaction });
    if (before.autoHideOutOfStock !== s.autoHideOutOfStock) await require('./inventory.service').refreshShopVisibility(s, { transaction });
    return c.shopView(s);
  });
}

// ---------------------------------------------------------------- staff and masters

/** GET /admin/market/shops */
async function staffList({ status, q, limit = 50 } = {}) {
  const where = { ...(status ? { status } : { status: { [Op.ne]: 'removed' } }) };
  if (q) where[Op.or] = [{ name: { [Op.iLike]: `%${q}%` } }, { slug: { [Op.iLike]: `%${q}%` } }];
  const shops = await Shop.findAll({ where, order: [['updatedAt', 'DESC']], limit });
  const owners = await directory.publicNames(shops.map((s) => s.ownerId));
  return { items: shops.map((s) => ({ ...c.shopView(s), owner: { id: s.ownerId, displayName: owners.get(s.ownerId)?.displayName ?? null } })) };
}

/** GET /admin/market/shops/:id */
async function staffGet(shopId) {
  const s = await Shop.findByPk(shopId);
  if (!s) throw E.notFound('Shop');
  const owner = (await directory.publicNames([s.ownerId])).get(s.ownerId);
  return { ...c.shopView(s), owner: { id: s.ownerId, displayName: owner?.displayName ?? null }, publicVersion: s.liveSnapshot ?? null };
}

/** Suspend, restore or remove a shop inside the caller's transaction (also M17 report actions). */
async function staffActionInTx(actor, shopId, action, { reason, transaction, req = null }) {
  const names = { suspend: 'shop.suspended', restore: 'shop.restored', remove: 'shop.removed' };
  const s = await move(actor, shopId, action, { transaction, req, reason, eventName: names[action], extra: action === 'restore' ? {} : { reason } });
  if (action !== 'restore') await moderation.withdrawSubject('shop', s.id, { transaction });
  return { id: s.id, status: s.status };
}

const staffAction = (actor, shopId, action, { reason }, req) => sequelize.transaction((transaction) => staffActionInTx(actor, shopId, action, { reason, transaction, req }));

// ---------------------------------------------------------------- M05 decisions (consumer, idempotent)

const DECIDED_EVENT = { changes_requested: 'shop.changes_requested', rejected: 'shop.rejected' };

async function applyDecision(submissionId, status, { transaction }) {
  const sub = await moderation.getById(submissionId, { transaction });
  if (!sub) return null;
  const ack = () =>
    events.publish(transaction, { name: 'submission.applied', aggregateType: 'submission', aggregateId: sub.id, payload: { submissionId: sub.id, kind: sub.kind, subjectId: sub.subjectId, version: sub.version, submittedBy: sub.submittedBy } });
  const s = await Shop.findByPk(sub.payload.shopId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!s || s.currentSubmissionId !== sub.id) {
    if (status === 'approved') await ack();
    return null;
  }
  const isEdit = Boolean(sub.payload.isEdit);
  const now = new Date();
  if (status === 'withdrawn') {
    await s.update({ ...(isEdit ? { editStatus: 'draft' } : { status: 'withdrawn', statusChangedAt: now }), currentSubmissionId: null }, { transaction });
    return 'withdrawn';
  }
  if (status !== 'approved') {
    await s.update(
      { ...(isEdit ? { editStatus: status } : { status, statusChangedAt: now }), currentSubmissionId: null, reviewReasonCode: sub.reasonCode ?? null, reviewReasonText: sub.reasonText ?? null },
      { transaction }
    );
    await audit.record({ action: DECIDED_EVENT[status], actor: null, entityType: 'shop', entityId: s.id, after: { status: s.status, editStatus: s.editStatus ?? null, reasonCode: sub.reasonCode ?? null }, meta: { submissionId: sub.id, decidedBy: sub.decidedBy } }, { transaction });
    await publish(transaction, DECIDED_EVENT[status], s, { isEdit, reasonCode: sub.reasonCode ?? null });
    return status;
  }
  const first = !rules.isPublished(s.status);
  const version = s.liveVersion + 1;
  await s.update(
    {
      status: first ? 'live' : s.status,
      editStatus: null,
      liveVersion: version,
      liveSnapshot: snapshotOf(s, version),
      currentSubmissionId: null,
      reviewReasonCode: null,
      reviewReasonText: null,
      ...(first ? { firstLiveAt: now, statusChangedAt: now } : {}),
    },
    { transaction }
  );
  await audit.record({ action: 'shop.published', actor: null, entityType: 'shop', entityId: s.id, after: { status: s.status, version }, meta: { submissionId: sub.id, decidedBy: sub.decidedBy, first } }, { transaction });
  await publish(transaction, 'shop.published', s, { version, first });
  await ack();
  return 'approved';
}

/** user_role.suspended / .withdrawn (shop_owner), user.suspended / .banned: pause the live shop. */
async function pauseAllOf(userId, reason, { transaction }) {
  const live = await Shop.findAll({ where: { ownerId: userId, status: 'live' }, transaction, lock: transaction.LOCK.UPDATE });
  for (const s of live) await move(null, s.id, 'pause', { transaction, reason, eventName: 'shop.paused', extra: { reason } });
  return live.length;
}

// ---------------------------------------------------------------- M05 automatic checks

async function checksFor(shopId, { transaction }) {
  const s = await Shop.findByPk(shopId, { transaction });
  if (!s) return [];
  const ok = (key, pass, severity, detail = null) => ({ key, severity, result: pass ? 'pass' : 'fail', detail: pass ? null : detail });
  const owner = await authz.loadPrincipal(s.ownerId);
  const area = await Area.findByPk(s.areaId, { transaction });
  const similar = await sequelize.query(
    "SELECT name FROM shops WHERE id <> :id AND status NOT IN ('removed', 'rejected', 'withdrawn', 'draft') AND similarity(lower(name), lower(:name)) > 0.6",
    { replacements: { id: s.id, name: s.name }, type: QueryTypes.SELECT, transaction }
  );
  return [
    ok('owner_kyc_approved', owner?.roles?.shop_owner === 'active', 'hard', 'The owner documents are not approved'),
    ok('shop_type_allowed', settings.get('market.shop_types').includes(s.shopType), 'hard', 'The shop type is no longer offered'),
    ok('area_active', Boolean(area?.isActive), 'hard', 'The area is not active'),
    ok('name_unique', similar.length === 0, 'soft', `Similar shop names: ${similar.map((x) => x.name).join(', ')}`),
  ];
}

/** Display facts for notifications (M08 reads them here). */
async function facts(shopId) {
  const s = await Shop.findByPk(shopId, { attributes: ['id', 'name', 'slug', 'reviewReasonCode', 'reviewReasonText'] });
  if (!s) throw E.notFound('Shop');
  return { name: s.name, slug: s.slug, reasonCode: s.reviewReasonCode ?? null, reasonText: s.reviewReasonText ?? null };
}

module.exports = { create, getMine, update, submit, withdraw, setPaused, setStockRules, staffList, staffGet, staffAction, staffActionInTx, applyDecision, pauseAllOf, checksFor, facts, snapshotOf };
