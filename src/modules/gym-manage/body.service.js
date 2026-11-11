'use strict';

/**
 * M24 §20 (FR-128 to FR-133; product owner, 11 Nov 2026): body progress. A member's measurements over time
 * (weight, body fat, chest, waist, hips, arm, thigh), recorded by the member in the app or by the owner and
 * the plan writers at the gym, shown as numbers and a chart. No photos.
 *  - One live entry per member and date: a second one for the same date replaces the first, which is
 *    voided, never deleted. An entry is measured today or up to `gym_manage.body_backdate_days` back.
 *  - The newest weight also updates the member's profile weight, so the BMI there stays current.
 *  - Privacy: seen only by the member, the owner and staff with plans.manage (a trainer-only caller sees
 *    their own members). Audit rows carry the field names, never the values. Not in exports or notices.
 *  - Plan feature `progress` (Standard and up): below it the member's read answers `on: false`.
 */
const { Op } = require('sequelize');
const { sequelize, GymMember, GymBodyEntry } = require('../../models');
const { E } = require('../../common/errors');
const gymFacade = require('../gym').gyms;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');

const { fail } = c;
const FEATURE = 'progress';
const FIELDS = Object.keys(rules.BODY_FIELDS);
const WRITERS = ['plans.manage'];

const entryView = (e) => ({ id: e.id, measuredOn: e.measuredOn, ...Object.fromEntries(FIELDS.map((k) => [k, e[k] ?? null])), byRole: e.byRole, createdAt: c.iso(e.createdAt) });
const limits = () => ({ backdateDays: c.cfg().bodyBackdateDays, fields: Object.fromEntries(FIELDS.map((k) => [k, { min: rules.BODY_FIELDS[k][0], max: rules.BODY_FIELDS[k][1] }])) });

/** Does the gym's plan include body progress (and is its panel not read-only)? */
async function featureOn(gym) {
  const sub = await c.subscriptionOf(gym.ownerId);
  return sub.status !== 'restricted' && rules.hasFeature(sub.chosenTier, FEATURE, c.tierCfg().featureMinTiers);
}

/** A member's progress: the live entries oldest first with BMI, and the change per measurement. */
async function progressFor(m, { on = true } = {}) {
  const rows = on ? await GymBodyEntry.findAll({ where: { memberId: m.id, voidedAt: null }, order: [['measuredOn', 'ASC']] }) : [];
  const p = rules.progressOf(rows.map(entryView), m.heightCm ?? null);
  return { memberId: m.id, on, heightCm: m.heightCm ?? null, entries: p.series, change: p.change, limits: limits() };
}

/**
 * Save an entry on a locked member (FR-128, FR-129): checked by the rule, the day's earlier entry voided,
 * the profile weight moved on when this is the newest weight.
 */
async function addIn(transaction, { member, input, by, role, actor, req }) {
  const today = c.today();
  const measuredOn = input.measuredOn ?? today;
  const values = Object.fromEntries(FIELDS.map((k) => [k, input[k] ?? null]));
  const block = rules.bodyEntryBlock({ values, measuredOn, today, backdateDays: c.cfg().bodyBackdateDays });
  if (block) throw fail(block.code, block.meta);
  const [replaced] = await GymBodyEntry.update({ voidedAt: new Date(), voidedBy: by }, { where: { memberId: member.id, measuredOn, voidedAt: null }, transaction });
  const entry = await GymBodyEntry.create({ gymId: member.gymId, memberId: member.id, measuredOn, ...values, byUser: by, byRole: role }, { transaction });
  if (values.weightKg !== null) {
    const later = await GymBodyEntry.count({ where: { memberId: member.id, voidedAt: null, measuredOn: { [Op.gt]: measuredOn }, weightKg: { [Op.ne]: null } }, transaction });
    if (!later) await member.update({ weightKg: values.weightKg, version: member.version + 1 }, { transaction });
  }
  await c.record(
    { action: 'gym_body.entry_added', actor, entityType: 'gym_member', entityId: member.id, entityCode: member.memberCode, after: { fields: rules.bodyGiven(values), measuredOn, replaced: replaced > 0, by: role }, meta: { gymId: member.gymId, entryId: entry.id }, req },
    transaction
  );
  return entry;
}

/** Void a live entry of the member (never deleted). `ownOnly`: a member removes only what they recorded. */
async function voidIn(transaction, { member, entryId, by, role, actor, req, ownOnly = false }) {
  const e = await GymBodyEntry.findOne({ where: { id: entryId, memberId: member.id }, transaction, lock: transaction.LOCK.UPDATE });
  if (!e) throw E.notFound('Entry');
  if (e.voidedAt) throw fail('GYM_BODY_ENTRY_STATE', { reason: 'removed' });
  if (ownOnly && e.byRole !== 'member') throw fail('GYM_BODY_ENTRY_STATE', { reason: 'recorded_by_gym' });
  await e.update({ voidedAt: new Date(), voidedBy: by }, { transaction });
  await c.record({ action: 'gym_body.entry_voided', actor, entityType: 'gym_member', entityId: member.id, entityCode: member.memberCode, after: { measuredOn: e.measuredOn, by: role }, meta: { gymId: member.gymId, entryId: e.id }, req }, transaction);
}

// ---------------------------------------------------------------- the member

/** My linked member row and its gym, or 404. */
async function mineWithGym(principal, memberId) {
  const m = await GymMember.findOne({ where: { id: memberId, userId: principal.id, status: { [Op.ne]: 'removed' } } });
  const gym = m ? await gymFacade.get(m.gymId) : null;
  if (!m || !gym) throw E.notFound('Membership');
  return { m, gym };
}

/** The same row locked, inside a transaction (the lock serialises two saves for one date). */
async function lockMine(principal, memberId, transaction) {
  const member = await GymMember.findOne({ where: { id: memberId, userId: principal.id, status: { [Op.ne]: 'removed' } }, transaction, lock: transaction.LOCK.UPDATE });
  if (!member) throw E.notFound('Membership');
  return member;
}

async function requireOn(gym) {
  if (!(await featureOn(gym))) throw fail('GYM_TIER_REQUIRED', { feature: FEATURE, minTier: rules.minTierOf(c.tierCfg().featureMinTiers, FEATURE) });
}

/** GET /me/gym-memberships/:memberId/body (linked): my progress, or `on: false` when the gym's plan lacks it. */
async function mine(principal, memberId) {
  const { m, gym } = await mineWithGym(principal, memberId);
  return progressFor(m, { on: await featureOn(gym) });
}

/** POST /me/gym-memberships/:memberId/body [Idempotency-Key] (linked): record my measurements for a date. */
async function addMine(principal, memberId, input, req) {
  const { gym } = await mineWithGym(principal, memberId);
  await requireOn(gym);
  const m = await sequelize.transaction(async (transaction) => {
    const member = await lockMine(principal, memberId, transaction);
    await addIn(transaction, { member, input, by: principal.id, role: 'member', actor: principal, req });
    return member;
  });
  return progressFor(m);
}

/** POST /me/gym-memberships/:memberId/body/:entryId/void (linked): remove an entry I recorded. */
async function voidMine(principal, memberId, entryId, req) {
  const { gym } = await mineWithGym(principal, memberId);
  await requireOn(gym);
  const m = await sequelize.transaction(async (transaction) => {
    const member = await lockMine(principal, memberId, transaction);
    await voidIn(transaction, { member, entryId, by: principal.id, role: 'member', actor: principal, req, ownOnly: true });
    return member;
  });
  return progressFor(m);
}

// ---------------------------------------------------------------- the gym (owner and plans.manage)

const visible = (a, memberId, opts) => require('./members.service').visibleMember(a, memberId, opts);

/** GET /manage/gyms/:gymId/members/:memberId/body (owner, plans.manage; feature progress). */
async function forMember(principal, gymId, memberId) {
  const a = await c.gymAccess(principal, gymId, null, { anyOf: WRITERS, feature: FEATURE });
  return progressFor(await visible(a, memberId));
}

/** The member a writer may record for, locked: visible to them, and neither left nor removed. */
async function lockVisible(a, memberId, transaction) {
  const seen = await visible(a, memberId, { transaction });
  const member = await GymMember.findByPk(seen.id, { transaction, lock: transaction.LOCK.UPDATE });
  if (['left', 'removed'].includes(member.status)) throw fail('GYM_MEMBER_STATE', { reason: member.status });
  return member;
}

/** POST /manage/gyms/:gymId/members/:memberId/body [Idempotency-Key] (owner, plans.manage; not while restricted). */
async function addFor(principal, gymId, memberId, input, req) {
  const a = await c.gymAccess(principal, gymId, null, { anyOf: WRITERS, feature: FEATURE, restricted: true });
  const m = await sequelize.transaction(async (transaction) => {
    const member = await lockVisible(a, memberId, transaction);
    await addIn(transaction, { member, input, by: principal.id, role: 'staff', actor: a.actor, req });
    return member;
  });
  return progressFor(m);
}

/** POST /manage/gyms/:gymId/members/:memberId/body/:entryId/void (owner, plans.manage; not while restricted). */
async function voidFor(principal, gymId, memberId, entryId, req) {
  const a = await c.gymAccess(principal, gymId, null, { anyOf: WRITERS, feature: FEATURE, restricted: true });
  const m = await sequelize.transaction(async (transaction) => {
    const member = await lockVisible(a, memberId, transaction);
    await voidIn(transaction, { member, entryId, by: principal.id, role: 'staff', actor: a.actor, req });
    return member;
  });
  return progressFor(m);
}

module.exports = { mine, addMine, voidMine, forMember, addFor, voidFor };
