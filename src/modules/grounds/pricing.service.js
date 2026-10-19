'use strict';

/**
 * M09 pricing rules (§5.3, FR-09 to FR-14): one published and at most one draft version per ground.
 *   save draft  → validated on the server (§6.2 + live settings + v3 advance ≥ fee)
 *   discard     → the draft is `discarded`
 *   publish     → the draft becomes the next published version; the old one is `superseded` with
 *                 effective_to; bookings already made keep their snapshot (M10), so nothing else changes
 *   apply to all my grounds → one published version per ground in one transaction (each keeps its own
 *                 base price and court prices)
 * The base price is locked while the ground is in review. Quote and heatmap price an inline draft
 * with the same calculator M10 uses (pricing.rules).
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, Ground, Court, CourtHours, PricingRule } = require('../../models');
const audit = require('../audit').audit;
const events = require('../events').events;
const settings = require('../settings').settings;
const directory = require('../users').directory;
const pr = require('./pricing.rules');
const rules = require('./grounds.rules');
const c = require('./grounds.common');
const occupancy = require('./occupancy.port');

const { fail } = c;

function serializeRules(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    ...c.rulesOf(row),
    effectiveFrom: row.effectiveFrom ?? null,
    effectiveTo: row.effectiveTo ?? null,
    summary: row.summary ?? null,
    changedKeys: row.changedKeys ?? [],
    updatedAt: row.updatedAt,
  };
}

/** The v3 payment and refund settings the editor and the public pages show. */
const policy = () => ({
  allowFullPayment: settings.get('booking.allow_full_payment'),
  advanceRefundable: settings.get('booking.advance_refundable'),
  refundAboveAdvanceOnCancel: settings.get('booking.refund_above_advance_on_cancel'),
  feePct: settings.get('fees.ground_booking_pct'),
});

function check(rulesIn) {
  const errors = pr.validate(rulesIn, c.limits());
  if (errors) throw E.validation(errors);
}

/** GET /me/grounds/:id/pricing: published and draft versions, limits, the footer count (FR-11). */
async function get(principal, groundId) {
  const g = await c.owned(principal, groundId);
  const { published, draft } = await c.pricingOf(g.id);
  return {
    groundId: g.id,
    published: serializeRules(published),
    draft: serializeRules(draft),
    upcomingBookings: await occupancy.countUpcoming({ groundId: g.id }),
    baseLocked: g.status === 'pending_review' || g.editStatus === 'pending_review',
    limits: c.limits(),
    policy: policy(),
  };
}

/** PUT /me/grounds/:id/pricing/draft: create or replace the draft (validated). */
async function saveDraft(principal, groundId, body, req) {
  return sequelize.transaction(async (transaction) => {
    const g = await c.owned(principal, groundId, { transaction, lock: true });
    const { published, draft } = await c.pricingOf(g.id, { transaction });
    const next = { ...c.rulesOf(draft ?? published ?? c.defaultRules(body.basePricePoisha)), ...body };
    const inReview = g.status === 'pending_review' || g.editStatus === 'pending_review';
    const lockedBase = (published ?? draft)?.basePricePoisha;
    if (inReview && lockedBase !== undefined && next.basePricePoisha !== lockedBase) throw fail('GROUND_IN_REVIEW');
    await validCourtOverrides(g.id, next.courtBaseOverrides, transaction);
    check(next);
    let row;
    if (draft) row = await draft.update({ ...next, updatedBy: principal.id }, { transaction });
    else {
      const top = await PricingRule.max('version', { where: { groundId: g.id }, transaction });
      row = await PricingRule.create({ groundId: g.id, version: Number(top ?? 0) + 1, status: 'draft', ...next, createdBy: principal.id, updatedBy: principal.id }, { transaction });
    }
    await audit.record({ action: 'ground_pricing.draft_saved', actor: principal, entityType: 'pricing_rule', entityId: row.id, after: c.rulesOf(row), meta: { groundId: g.id, version: row.version }, req }, { transaction });
    return serializeRules(row);
  });
}

/** Court price overrides must name this ground's courts. */
async function validCourtOverrides(groundId, overrides = {}, transaction) {
  const ids = Object.keys(overrides ?? {});
  if (!ids.length) return;
  const n = await Court.count({ where: { id: ids, groundId, status: { [Op.ne]: 'retired' } }, transaction });
  if (n !== ids.length) throw fail('COURT_UNKNOWN');
}

/** POST /me/grounds/:id/pricing/draft/discard (FR-10). */
async function discard(principal, groundId, req) {
  return sequelize.transaction(async (transaction) => {
    const g = await c.owned(principal, groundId, { transaction, lock: true });
    const { draft } = await c.pricingOf(g.id, { transaction });
    if (!draft) throw fail('PRICING_DRAFT_MISSING');
    await draft.update({ status: 'discarded', updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'ground_pricing.discarded', actor: principal, entityType: 'pricing_rule', entityId: draft.id, meta: { groundId: g.id, version: draft.version }, req }, { transaction });
    return { discarded: draft.version };
  });
}

/** Publish `draft` for ground `g` (inside a transaction). Used by publish and by the first approval. */
async function publishDraft(g, draft, { actor, req, transaction }) {
  const { published } = await c.pricingOf(g.id, { transaction });
  const now = new Date();
  const before = published ? c.rulesOf(published) : null;
  const after = c.rulesOf(draft);
  const changedKeys = pr.changedKeys(before, after);
  if (published) await published.update({ status: 'superseded', effectiveTo: now }, { transaction });
  await draft.update({ status: 'published', effectiveFrom: now, summary: pr.summary(before, after), changedKeys, publishedBy: actor?.id ?? null }, { transaction });
  await audit.record({ action: 'ground_pricing.published', actor, entityType: 'pricing_rule', entityId: draft.id, before, after, meta: { groundId: g.id, version: draft.version, summary: draft.summary }, req }, { transaction });
  await events.publish(transaction, {
    name: 'ground.pricing_published',
    aggregateType: 'ground',
    aggregateId: g.id,
    payload: { groundId: g.id, ownerId: g.ownerId, version: draft.version, changedKeys },
  });
  return draft;
}

/**
 * POST /me/grounds/:id/pricing/publish (FR-09, FR-12, FR-14). With applyToAll, the same rules
 * (not the base or court prices) are published on every other ground of the owner, in one transaction.
 */
async function publish(principal, groundId, { applyToAll = false } = {}, req) {
  return sequelize.transaction(async (transaction) => {
    const g = await c.owned(principal, groundId, { transaction, lock: true });
    const { published, draft } = await c.pricingOf(g.id, { transaction });
    if (!draft) throw fail('PRICING_DRAFT_MISSING');
    const inReview = g.status === 'pending_review' || g.editStatus === 'pending_review';
    if (inReview && published && draft.basePricePoisha !== published.basePricePoisha) throw fail('GROUND_IN_REVIEW');
    check(c.rulesOf(draft));
    await publishDraft(g, draft, { actor: principal, req, transaction });
    const others = [];
    if (applyToAll) {
      const mine = await Ground.findAll({ where: { ownerId: principal.id, id: { [Op.ne]: g.id }, status: { [Op.notIn]: ['removed', 'rejected'] } }, transaction, lock: transaction.LOCK.UPDATE });
      const shared = c.rulesOf(draft);
      delete shared.basePricePoisha;
      delete shared.courtBaseOverrides;
      for (const other of mine) {
        const cur = await c.pricingOf(other.id, { transaction });
        const own = cur.published ?? cur.draft;
        if (!own) continue;
        if (cur.draft) await cur.draft.update({ status: 'discarded' }, { transaction });
        const next = { ...c.rulesOf(own), ...shared };
        check(next);
        const top = await PricingRule.max('version', { where: { groundId: other.id }, transaction });
        const row = await PricingRule.create({ groundId: other.id, version: Number(top) + 1, status: 'draft', ...next, createdBy: principal.id, updatedBy: principal.id }, { transaction });
        await publishDraft(other, row, { actor: principal, req, transaction });
        others.push({ groundId: other.id, version: row.version });
      }
    }
    return { published: serializeRules(draft), alsoPublished: others };
  });
}

/** GET /me/grounds/:id/pricing/history: every published version, newest first (FR-14, full history). */
async function history(principal, groundId) {
  const g = await c.owned(principal, groundId);
  const rows = await PricingRule.findAll({ where: { groundId: g.id, status: ['published', 'superseded'] }, order: [['version', 'DESC']] });
  const names = await directory.publicNames(rows.map((r) => r.publishedBy).filter(Boolean));
  return {
    items: rows.map((r) => ({
      version: r.version,
      status: r.status,
      summary: r.summary,
      changedKeys: r.changedKeys,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo ?? null,
      publishedBy: r.publishedBy ? { id: r.publishedBy, name: names.get(r.publishedBy)?.displayName ?? null } : null,
    })),
  };
}

// ---------------------------------------------------------------- quote and heatmap (FR-13)

/** The rules to price with: an inline draft (owner tools), else the draft or published version. */
async function rulesFor(groundId, { inline, useDraft }, transaction) {
  const { published, draft } = await c.pricingOf(groundId, { transaction });
  const base = useDraft ? draft ?? published : published;
  if (!base && !inline) throw fail('PRICING_MISSING');
  const merged = { ...(base ? c.rulesOf(base) : c.defaultRules(inline.basePricePoisha)), ...(inline ?? {}) };
  if (inline) check(merged);
  return { rules: merged, version: base?.version ?? null };
}

/**
 * Price courts of a ground for a slot. Courts must be bookable (active, or any non-retired court for
 * the owner's calculator); two or more must share a combinable group (§6.5, priced as the sum, Q62).
 * The length is one of the allowed lengths at or above the minimum; every half-hour must be inside the
 * court's hours (§6.3).
 */
async function priceSlot(groundId, { courtIds, start, minutes, rules: r, ownerTool }) {
  const courts = await Court.findAll({ where: { id: courtIds, groundId, status: ownerTool ? { [Op.ne]: 'retired' } : 'active' } });
  if (courts.length !== new Set(courtIds).size) throw fail('COURT_UNKNOWN');
  if (courts.length > 1 && (!courts[0].combinableGroup || courts.some((x) => x.combinableGroup !== courts[0].combinableGroup))) throw fail('NOT_COMBINABLE');
  const lengths = [...new Set([...settings.get('booking.min_length_options_min'), 180])].filter((m) => m >= r.minBookingMin);
  if (!lengths.includes(minutes)) throw fail('LENGTH_INVALID', { meta: { allowed: lengths } });
  const hours = await CourtHours.findAll({ where: { courtId: courtIds } });
  const t0 = new Date(start).getTime();
  for (let i = 0; i < minutes; i += 30) {
    const { hour, minute, dow } = pr.dhakaParts(t0 + i * 60000);
    for (const id of courtIds) {
      if (!rules.isOpenAt(hours.find((h) => h.courtId === id && h.dow === dow), hour * 60 + minute)) throw fail('OUTSIDE_HOURS');
    }
  }
  return pr.quote({ rules: r, courtIds, start, minutes, feePct: settings.get('fees.ground_booking_pct'), allowFull: settings.get('booking.allow_full_payment') });
}

/** POST /me/grounds/:id/pricing/quote: the owner's calculator, with an optional unsaved draft. */
async function ownerQuote(principal, groundId, { courtIds, start, minutes, draft }) {
  const g = await c.owned(principal, groundId);
  const { rules: r, version } = await rulesFor(g.id, { inline: draft, useDraft: true });
  return { ...(await priceSlot(g.id, { courtIds, start, minutes, rules: r, ownerTool: true })), rulesVersion: version, minBookingMin: r.minBookingMin };
}

/** GET /me/grounds/:id/pricing/heatmap: 7 × 17 rates from today (Dhaka), draft or published. */
async function heatmap(principal, groundId, { days = 7, draft = false, courtId = null }) {
  const g = await c.owned(principal, groundId);
  const { rules: r } = await rulesFor(g.id, { useDraft: draft });
  return { basePricePoisha: courtId ? pr.courtBase(r, courtId) : r.basePricePoisha, rows: pr.heatmap(r, { fromDate: pr.dhakaParts(new Date()).date, days, courtId }) };
}

module.exports = { get, saveDraft, discard, publish, publishDraft, history, ownerQuote, heatmap, priceSlot, rulesFor, serializeRules, policy };
