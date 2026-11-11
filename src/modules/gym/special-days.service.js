'use strict';

/**
 * M20 holidays and special hours (M20-FR-16 to FR-22; product owner, 11 Nov 2026). The owner marks a range
 * of dates as closed (Eid, a repair) or gives it its own opening windows (Ramadan timings).
 *  - The weekly hours stay reviewed with the listing (live_snapshot.hours); a special day applies at once,
 *    like a venue's closure, and is never deleted (active → removed).
 *  - Everything that asks "is the gym open then" goes through rules.windowsFor: the public card and page
 *    (open now), gyms.liveWindowsOn (trial-visit slots and bookings in gym-manage) and the list other
 *    modules read (`activeFor`: class sessions and staff shifts in gym-ops).
 *  - Saving one publishes gym_special_day.created: gym-manage cancels the booked trial visits it leaves
 *    without an open hour, gym-ops cancels the class sessions; removing one (gym_special_day.removed) brings
 *    those sessions back empty. Memberships are not extended (a freeze is the tool for that).
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, GymSpecialDay } = require('../../models');
const audit = require('../audit').audit;
const settings = require('../settings').settings;
const rules = require('./gym.rules');
const c = require('./gym.common');

const { fail } = c;

/** Every number from M03 (read per call). */
const cfg = () => ({
  maxDays: settings.get('gym.special_day_max_days'),
  aheadDays: settings.get('gym.special_days_ahead_days'),
  maxActive: settings.get('gym.special_days_max_active'),
  publicDays: settings.get('gym.special_days_public_days'),
});

const windowsView = (windows) => (windows ?? []).map((w) => ({ openTime: w.openTime, closeTime: w.closeTime, womenOnly: Boolean(w.womenOnly) })).sort((a, b) => a.openTime.localeCompare(b.openTime));
/** What other modules and the public read: no ids of people, no status. */
const ref = (d) => ({ id: d.id, fromOn: d.fromOn, toOn: d.toOn, kind: d.kind, windows: windowsView(d.windows), title: d.title });
const view = (d, today) => ({ ...ref(d), gymId: d.gymId, status: d.status, phase: rules.specialPhase(d, today), createdAt: c.iso(d.createdAt), removedAt: c.iso(d.removedAt) });

/** The active special days of a gym that touch a range of Dhaka dates, earliest first (also the facade other modules use). */
async function activeFor(gymId, { from, to }, { transaction } = {}) {
  const rows = await GymSpecialDay.findAll({ where: { gymId, status: 'active', fromOn: { [Op.lte]: to }, toOn: { [Op.gte]: from } }, order: [['fromOn', 'ASC']], transaction });
  return rows.map(ref);
}

/** The special days covering one date for many gyms (the public list's "open now"): Map gymId → [ref]. */
async function onDateFor(gymIds, date) {
  const out = new Map();
  if (!gymIds.length) return out;
  const rows = await GymSpecialDay.findAll({ where: { gymId: gymIds, status: 'active', fromOn: { [Op.lte]: date }, toOn: { [Op.gte]: date } } });
  for (const r of rows) out.set(r.gymId, [...(out.get(r.gymId) ?? []), ref(r)]);
  return out;
}

/** What the gym page shows under the hours: the special days from today to gym.special_days_public_days ahead. */
const publicFor = (gymId, today) => activeFor(gymId, { from: today, to: rules.addDays(today, cfg().publicDays) });

/** GET /me/gyms/:id/special-days?scope=upcoming|past: mine, the coming ones first; past and removed ones newest first. */
async function list(principal, gymId, { scope = 'upcoming' } = {}) {
  const gyms = require('./gyms.service');
  await gyms.owned(principal, gymId);
  const today = c.today();
  const where = scope === 'past' ? { gymId, [Op.or]: [{ status: 'removed' }, { toOn: { [Op.lt]: today } }] } : { gymId, status: 'active', toOn: { [Op.gte]: today } };
  const rows = await GymSpecialDay.findAll({ where, order: scope === 'past' ? [['fromOn', 'DESC']] : [['fromOn', 'ASC']], limit: 100 });
  return { today, limits: cfg(), items: rows.map((r) => view(r, today)) };
}

/** Throws the first problem of a new special day (rules.specialDayBlock) against the gym's other active ones. */
async function check(gymId, input, today, transaction) {
  const others = await GymSpecialDay.findAll({ where: { gymId, status: 'active', toOn: { [Op.gte]: today } }, transaction });
  const conf = cfg();
  const block = rules.specialDayBlock({ ...input, windows: input.windows ?? [], today, others, maxDays: conf.maxDays, aheadDays: conf.aheadDays, maxActive: conf.maxActive });
  if (block) throw fail(block.code, block.meta);
}

const dayOf = (input) => ({ fromOn: input.fromOn, toOn: input.toOn, kind: input.kind, windows: input.kind === 'hours' ? windowsView(input.windows) : [] });

/** What saving it would cancel: class sessions (gym-ops) and booked trial visits (gym-manage). */
async function effectOf(gymId, day) {
  const [classSessions, visits] = await Promise.all([require('../gym-ops').specialDays.sessionsHit(gymId, day), require('../gym-manage').visits.specialDayHits(gymId, day)]);
  return { classSessions, visits };
}

/** POST /me/gyms/:id/special-days/preview: the same checks as saving, and what it would cancel. Writes nothing. */
async function preview(principal, gymId, input) {
  const gyms = require('./gyms.service');
  await gyms.owned(principal, gymId);
  const today = c.today();
  await check(gymId, input, today);
  return { ok: true, affected: await effectOf(gymId, dayOf(input)) };
}

/** POST /me/gyms/:id/special-days { fromOn, toOn, kind, windows?, title }: applies at once. */
async function create(principal, gymId, input, req) {
  const gyms = require('./gyms.service');
  const today = c.today();
  const day = dayOf(input);
  const row = await sequelize.transaction(async (transaction) => {
    const g = await gyms.owned(principal, gymId, { transaction, lock: true });
    await check(g.id, input, today, transaction);
    const d = await GymSpecialDay.create({ gymId: g.id, ...day, title: input.title, createdBy: principal.id }, { transaction });
    await c.publish(transaction, 'gym_special_day.created', 'gym_special_day', d.id, { specialDayId: d.id, gymId: g.id, ownerId: g.ownerId, ...day, title: d.title }, principal);
    await audit.record({ action: 'gym.special_day_added', actor: principal, entityType: 'gym', entityId: g.id, after: { fromOn: d.fromOn, toOn: d.toOn, kind: d.kind, title: d.title }, req }, { transaction });
    return d;
  });
  return view(row, today);
}

/** POST /me/gyms/:id/special-days/:specialDayId/remove: an upcoming or running one; a past one stays as history. */
async function remove(principal, gymId, specialDayId, req) {
  const gyms = require('./gyms.service');
  const today = c.today();
  const row = await sequelize.transaction(async (transaction) => {
    const d = await GymSpecialDay.findByPk(specialDayId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!d || d.gymId !== gymId) throw E.notFound('Special day');
    const g = await gyms.owned(principal, gymId, { transaction });
    if (d.status !== 'active' || rules.specialPhase(d, today) === 'past') throw fail('GYM_SPECIAL_DAY_STATE');
    await d.update({ status: 'removed', removedAt: new Date(), removedBy: principal.id }, { transaction });
    await c.publish(transaction, 'gym_special_day.removed', 'gym_special_day', d.id, { specialDayId: d.id, gymId: g.id, ownerId: g.ownerId, fromOn: d.fromOn, toOn: d.toOn }, principal);
    await audit.record({ action: 'gym.special_day_removed', actor: principal, entityType: 'gym', entityId: g.id, before: { fromOn: d.fromOn, toOn: d.toOn, kind: d.kind, title: d.title }, req }, { transaction });
    return d;
  });
  return view(row, today);
}

module.exports = { activeFor, onDateFor, publicFor, list, preview, create, remove };
