'use strict';

/**
 * M09 closures, step 2 (FR-15 to FR-18, §4.2, §7.6). A closure takes some or all courts of a
 * ground out of play for a half-hour aligned period, up to ground.closure_max_days_ahead (Q63).
 * Its time is written as M10 booking_slots through the occupancy port, in the same transaction, so a
 * closure and a booking can never overlap. Nothing partial is written: any clash (a booking, a hold,
 * a series week or another closure) returns 409 CLOSURE_CLASHES with the list, and the owner moves
 * or cancels those bookings first (M10 owner tools). Reopen (upcoming) and end now (in progress)
 * are statuses; past closures are read-only.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, Closure, Court } = require('../../models');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const settings = require('../settings/settings.service');
const rules = require('./grounds.rules');
const c = require('./grounds.common');
const occupancy = require('./occupancy.port');

const { fail } = c;
const HALF = 30 * 60 * 1000;
const iso = (d) => new Date(d).toISOString();

const view = (x) => ({
  id: x.id,
  groundId: x.groundId,
  courtIds: x.courtIds,
  start: iso(x.startsAt),
  end: iso(x.endsAt),
  reason: x.reason,
  note: x.note ?? null,
  status: x.status,
  phase: rules.closurePhase({ start: x.startsAt, end: x.endsAt, now: new Date() }),
  reopenedAt: x.reopenedAt ? iso(x.reopenedAt) : null,
});

const publish = (transaction, name, x, actor) =>
  events.publish(transaction, { name, aggregateType: 'closure', aggregateId: x.id, payload: { closureId: x.id, groundId: x.groundId, start: iso(x.startsAt), end: iso(x.endsAt), reason: x.reason }, actor });

async function shape(principal, groundId, { courtIds = null, start, end, reason }, { transaction } = {}) {
  const g = await c.owned(principal, groundId, { transaction });
  if (!['live', 'paused'].includes(g.status)) throw fail('GROUND_STATE');
  if (reason === 'platform' && !principal.isMaster) throw fail('REASON_NOT_ALLOWED');
  const block = rules.closureBlock({ start, end, now: new Date(), maxDaysAhead: settings.get('ground.closure_max_days_ahead') });
  if (block) throw fail(block);
  const active = await Court.findAll({ where: { groundId: g.id, status: 'active' }, transaction });
  const ids = courtIds ? [...new Set(courtIds)] : active.map((k) => k.id);
  if (!ids.length || !ids.every((id) => active.some((k) => k.id === id))) throw fail('COURT_UNKNOWN');
  return { g, ids };
}

/** POST /me/grounds/:id/closures/preview: what the closure would clash with (FR-16). */
async function preview(principal, groundId, body) {
  const { ids } = await shape(principal, groundId, body);
  const conflicts = await occupancy.findConflicts({ courtIds: ids, from: new Date(body.start), to: new Date(body.end) });
  return { courtIds: ids, conflicts };
}

/** POST /me/grounds/:id/closures (FR-15, FR-16). */
async function create(principal, groundId, body, req) {
  return sequelize.transaction(async (transaction) => {
    const { g, ids } = await shape(principal, groundId, body, { transaction });
    const conflicts = await occupancy.findConflicts({ courtIds: ids, from: new Date(body.start), to: new Date(body.end) }, { transaction });
    if (conflicts.length) throw fail('CLOSURE_CLASHES', { meta: { conflicts } });
    const x = await Closure.create({ groundId: g.id, courtIds: ids, startsAt: body.start, endsAt: body.end, reason: body.reason, note: body.note ?? null, createdBy: principal.id }, { transaction });
    try {
      await occupancy.reserveClosure(x, { transaction });
    } catch (err) {
      // Someone booked between the check and the write: the exclusion constraint refused it.
      if (err.code === 'SLOT_UNAVAILABLE') throw fail('CLOSURE_CLASHES', { meta: { conflicts: await occupancy.findConflicts({ courtIds: ids, from: x.startsAt, to: x.endsAt }) } });
      throw err;
    }
    await audit.record({ action: 'closure.created', actor: principal, entityType: 'closure', entityId: x.id, after: view(x), meta: { groundId: g.id }, req }, { transaction });
    await publish(transaction, 'closure.created', x, principal);
    return view(x);
  });
}

/** GET /me/grounds/:id/closures?scope=upcoming|past */
async function list(principal, groundId, { scope = 'upcoming' }) {
  const g = await c.owned(principal, groundId);
  const now = new Date();
  const where = { groundId: g.id, ...(scope === 'upcoming' ? { endsAt: { [Op.gt]: now }, status: 'active' } : { [Op.or]: [{ endsAt: { [Op.lte]: now } }, { status: { [Op.ne]: 'active' } }] }) };
  const rows = await Closure.findAll({ where, order: [['startsAt', scope === 'upcoming' ? 'ASC' : 'DESC']], limit: 100 });
  return { items: rows.map(view) };
}

async function ownedClosure(principal, id, transaction) {
  const x = await Closure.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!x) throw E.notFound('Closure');
  await c.owned(principal, x.groundId, { transaction });
  if (x.status !== 'active') throw fail('CLOSURE_STATE');
  return x;
}

/** POST /me/closures/:id/reopen (FR-17): an upcoming closure frees its courts. */
async function reopen(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const x = await ownedClosure(principal, id, transaction);
    if (rules.closurePhase({ start: x.startsAt, end: x.endsAt, now: new Date() }) !== 'upcoming') throw fail('CLOSURE_STATE');
    await occupancy.releaseClosure(x, { transaction });
    await x.update({ status: 'reopened', reopenedAt: new Date(), reopenedBy: principal.id, updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'closure.reopened', actor: principal, entityType: 'closure', entityId: x.id, after: { status: x.status }, meta: { groundId: x.groundId }, req }, { transaction });
    await publish(transaction, 'closure.reopened', x, principal);
    return view(x);
  });
}

/** POST /me/closures/:id/end-now (FR-17): an in-progress closure ends at the next half-hour. */
async function endNow(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const x = await ownedClosure(principal, id, transaction);
    const now = new Date();
    if (rules.closurePhase({ start: x.startsAt, end: x.endsAt, now }) !== 'in_progress') throw fail('CLOSURE_STATE');
    const end = new Date(Math.max(Math.ceil(now.getTime() / HALF) * HALF, x.startsAt.getTime() + HALF));
    if (end < x.endsAt) {
      await occupancy.shortenClosure(x, end, { transaction });
      await x.update({ endsAt: end, status: 'ended_early', endedEarlyAt: now, updatedBy: principal.id }, { transaction });
    }
    await audit.record({ action: 'closure.ended_early', actor: principal, entityType: 'closure', entityId: x.id, after: { end: iso(x.endsAt) }, meta: { groundId: x.groundId }, req }, { transaction });
    await publish(transaction, 'closure.shortened', x, principal);
    return view(x);
  });
}

module.exports = { preview, create, list, reopen, endNow, view };
