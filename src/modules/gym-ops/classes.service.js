'use strict';

/**
 * M27 round 2: classes (feature `classes`, Standard plan).
 *  - A class has a name, a trainer (the owner or staff of the gym), a capacity, a length and weekly time slots
 *    (M27-FR-45, FR-46). Sessions are made `gym_ops.class_weeks_ahead` weeks ahead from the slots, when the
 *    timetable changes and by the daily job (FR-47).
 *  - Bookings (FR-48 to FR-51): a member of the gym with a running membership books in the app, or the desk
 *    books for them; past the capacity they go on the waitlist (gym_ops.waitlist_max); a cancelled place is
 *    given to the first on the waitlist (promoted, notified). Capacity is counted under a lock on the session
 *    row, so two last-place bookings cannot both win. Members cancel up to gym_ops.class_cancel_cutoff_minutes
 *    before the start; the desk until the start.
 *  - Cancelling a session tells everyone booked or waiting (FR-52); a reminder goes before the class (FR-53).
 *  - After the class the trainer or desk marks who came (attended or no-show; FR-54).
 * Bookkeeping only: no money. Never writes gym-manage tables; members are read through gym-manage `ops`.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, GymClass, GymClassSchedule, GymClassSession, GymClassBooking } = require('../../models');
const directory = require('../users').directory;
const staffFacade = require('../business-members').members;
const gymFacade = require('../gym').gyms;
const specialDaysOf = require('../gym').specialDays;
const rules = require('./gym-ops.rules');
const c = require('./gym-ops.common');

const FEATURE = 'classes';
const DESK = ['classes.manage', 'attendance.mark'];
const LIVE = ['booked', 'waitlisted', 'attended', 'no_show'];

// ---------------------------------------------------------------- views

async function trainerNames(ids) {
  return directory.displayNames([...new Set(ids.filter(Boolean))]);
}

function classView(k, slots, names) {
  return {
    id: k.id,
    name: k.name,
    description: k.description ?? null,
    trainer: k.trainerUserId ? { id: k.trainerUserId, displayName: names.get(k.trainerUserId) ?? null } : null,
    capacity: k.capacity,
    minutes: k.minutes,
    room: k.room ?? null,
    status: k.status,
    slots: slots.filter((x) => x.classId === k.id && x.status === 'active').map((x) => ({ id: x.id, dow: x.dow, startTime: x.startTime })),
  };
}

async function countsOf(sessionIds, { transaction } = {}) {
  if (!sessionIds.length) return new Map();
  const rows = await GymClassBooking.findAll({
    attributes: ['sessionId', 'status', [sequelize.fn('COUNT', sequelize.col('id')), 'n']],
    where: { sessionId: sessionIds, status: { [Op.ne]: 'cancelled' } },
    group: ['sessionId', 'status'],
    raw: true,
    transaction,
  });
  const out = new Map();
  for (const r of rows) {
    const cur = out.get(r.sessionId) ?? { booked: 0, waitlisted: 0, attended: 0, noShow: 0 };
    if (r.status === 'booked') cur.booked += Number(r.n);
    if (r.status === 'waitlisted') cur.waitlisted += Number(r.n);
    if (r.status === 'attended') cur.attended += Number(r.n);
    if (r.status === 'no_show') cur.noShow += Number(r.n);
    out.set(r.sessionId, cur);
  }
  return out;
}

function sessionView(s, k, counts, names) {
  const n = counts.get(s.id) ?? { booked: 0, waitlisted: 0, attended: 0, noShow: 0 };
  const taken = n.booked + n.attended + n.noShow;
  return {
    id: s.id,
    classId: s.classId,
    name: k?.name ?? '',
    room: k?.room ?? null,
    trainer: s.trainerUserId ? { id: s.trainerUserId, displayName: names.get(s.trainerUserId) ?? null } : null,
    localDate: s.localDate,
    startsAt: c.iso(s.startsAt),
    endsAt: c.iso(s.endsAt),
    capacity: s.capacity,
    booked: taken,
    waitlisted: n.waitlisted,
    spaces: Math.max(0, s.capacity - taken),
    status: s.status,
    cancelReason: s.cancelReason ?? null,
  };
}

// ---------------------------------------------------------------- the timetable

/** Make the sessions of these slots from today for the weeks ahead (idempotent: one per slot and date). */
async function sessionsAheadIn(transaction, { klass, slots, today }) {
  let made = 0;
  // M20-FR-20: no session on a date and time a holiday or special hours leave shut.
  const special = await specialDaysOf.activeFor(klass.gymId, { from: today, to: rules.addDays(today, c.cfg().classWeeksAhead * 7) }, { transaction });
  for (const slot of slots) {
    if (slot.status !== 'active') continue;
    for (const d of rules.datesAhead(today, c.cfg().classWeeksAhead, slot.dow)) {
      const { startsAt, endsAt } = rules.sessionWindow(d, slot.startTime, klass.minutes);
      if (startsAt <= new Date()) continue;
      if (rules.shutBy(special, d, rules.minutesOf(slot.startTime))) continue;
      const [, created] = await GymClassSession.findOrCreate({
        where: { scheduleId: slot.id, localDate: d },
        defaults: { gymId: klass.gymId, classId: klass.id, scheduleId: slot.id, localDate: d, startsAt, endsAt, capacity: klass.capacity, trainerUserId: klass.trainerUserId ?? null },
        transaction,
      });
      if (created) made += 1;
    }
  }
  return made;
}

async function checkTrainer(gymId, ownerId, trainerUserId) {
  if (!trainerUserId || trainerUserId === ownerId) return;
  const staff = await staffFacade.staffWith('gym', gymId, TRAINER_PERMS);
  if (!staff.some((x) => x.memberId === trainerUserId)) throw c.fail('GYM_CLASS_TRAINER');
}

function checkSlots(slots) {
  if (slots.length > c.cfg().classSlotsMax) throw E.validation([{ field: 'slots', message: `At most ${c.cfg().classSlotsMax} time slots` }]);
  const seen = new Set();
  for (const x of slots) {
    const k = `${x.dow}-${x.startTime}`;
    if (seen.has(k)) throw E.validation([{ field: 'slots', message: 'The same day and time twice' }]);
    seen.add(k);
  }
}

const TRAINER_PERMS = ['classes.manage', 'plans.manage', 'members.trainer', 'attendance.mark'];

/** GET …/class-trainers (classes.manage): who can lead a class: the owner and staff with a desk or trainer permission. */
async function trainers(principal, gymId) {
  const a = await c.access(principal, gymId, 'classes.manage', { feature: FEATURE });
  const staff = await staffFacade.staffWith('gym', gymId, TRAINER_PERMS);
  const ids = [a.gym.ownerId, ...staff.map((x) => x.memberId)];
  const names = await trainerNames(ids);
  return { items: [...new Set(ids)].map((userId) => ({ userId, displayName: names.get(userId) ?? null, owner: userId === a.gym.ownerId })) };
}

/** GET …/classes (classes.manage or attendance.mark): the classes with their weekly slots. */
async function list(principal, gymId, { status } = {}) {
  await c.access(principal, gymId, null, { feature: FEATURE, anyOf: DESK });
  const rows = await GymClass.findAll({ where: { gymId, ...(status ? { status } : { status: 'active' }) }, order: [['name', 'ASC']] });
  const slots = rows.length ? await GymClassSchedule.findAll({ where: { classId: rows.map((k) => k.id) }, order: [['dow', 'ASC'], ['startTime', 'ASC']] }) : [];
  const names = await trainerNames(rows.map((k) => k.trainerUserId));
  return { items: rows.map((k) => classView(k, slots, names)) };
}

/** POST …/classes (classes.manage): a class and its weekly slots; sessions are made ahead (M27-FR-45..47). */
async function create(principal, gymId, input, req) {
  const a = await c.access(principal, gymId, 'classes.manage', { feature: FEATURE, restricted: true });
  checkSlots(input.slots);
  await checkTrainer(gymId, a.gym.ownerId, input.trainerUserId ?? null);
  const id = await sequelize.transaction(async (transaction) => {
    if ((await GymClass.count({ where: { gymId, status: 'active' }, transaction })) >= c.cfg().classesMax) throw c.fail('GYM_CLASS_LIMIT');
    const k = await GymClass.create(
      { gymId, name: input.name, description: input.description ?? null, trainerUserId: input.trainerUserId ?? null, capacity: input.capacity, minutes: input.minutes, room: input.room ?? null, createdBy: principal.id },
      { transaction }
    );
    const slots = [];
    for (const x of input.slots) slots.push(await GymClassSchedule.create({ gymId, classId: k.id, dow: x.dow, startTime: x.startTime }, { transaction }));
    await sessionsAheadIn(transaction, { klass: k, slots, today: c.today() });
    await c.record({ action: 'gym_class.created', actor: a.actor, entityType: 'gym_class', entityId: k.id, after: { name: k.name, capacity: k.capacity, slots: slots.length }, meta: { gymId }, req }, transaction);
    return k.id;
  });
  return one(gymId, id);
}

async function one(gymId, classId) {
  const k = await GymClass.findOne({ where: { id: classId, gymId } });
  if (!k) throw c.fail('GYM_CLASS_UNKNOWN');
  const slots = await GymClassSchedule.findAll({ where: { classId: k.id }, order: [['dow', 'ASC'], ['startTime', 'ASC']] });
  return classView(k, slots, await trainerNames([k.trainerUserId]));
}

/** Cancel the future scheduled sessions given (bookings cancelled, everyone told; FR-52). */
async function cancelSessionsIn(transaction, { sessions, reason, by, actor }) {
  for (const s of sessions) {
    await s.update({ status: 'cancelled', cancelReason: reason, cancelledBy: by, cancelledAt: new Date() }, { transaction });
    const live = await GymClassBooking.findAll({ where: { sessionId: s.id, status: ['booked', 'waitlisted'] }, transaction });
    for (const b of live) await b.update({ status: 'cancelled', cancelledAt: new Date() }, { transaction });
    if (live.length) {
      await c.publish(transaction, 'gym_class.session_cancelled', 'gym_class_session', s.id, { sessionId: s.id, gymId: s.gymId, classId: s.classId, startsAt: c.iso(s.startsAt), memberIds: live.map((b) => b.memberId) }, actor);
    }
  }
}

/**
 * PATCH …/classes/:classId (classes.manage): name, description, trainer, capacity, length, room, or retire.
 * Capacity and trainer apply to sessions not yet started; a shorter capacity never removes a place already
 * given. Retiring cancels the future sessions (everyone booked is told).
 */
async function update(principal, gymId, classId, input, req) {
  const a = await c.access(principal, gymId, 'classes.manage', { feature: FEATURE, restricted: true });
  if (input.trainerUserId !== undefined) await checkTrainer(gymId, a.gym.ownerId, input.trainerUserId);
  await sequelize.transaction(async (transaction) => {
    const k = await GymClass.findOne({ where: { id: classId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!k) throw c.fail('GYM_CLASS_UNKNOWN');
    const fields = ['name', 'description', 'trainerUserId', 'capacity', 'minutes', 'room', 'status'].filter((f) => input[f] !== undefined);
    const before = Object.fromEntries(fields.map((f) => [f, k[f] ?? null]));
    await k.update(Object.fromEntries(fields.map((f) => [f, input[f]])), { transaction });
    const future = await GymClassSession.findAll({ where: { classId: k.id, status: 'scheduled', startsAt: { [Op.gt]: new Date() } }, transaction, lock: transaction.LOCK.UPDATE });
    if (input.status === 'retired') {
      await cancelSessionsIn(transaction, { sessions: future, reason: 'The class has ended', by: principal.id, actor: a.actor });
      await GymClassSchedule.update({ status: 'retired' }, { where: { classId: k.id, status: 'active' }, transaction });
    } else if (input.capacity !== undefined || input.trainerUserId !== undefined || input.minutes !== undefined) {
      for (const s of future) {
        const patch = {};
        if (input.capacity !== undefined) patch.capacity = input.capacity;
        if (input.trainerUserId !== undefined) patch.trainerUserId = input.trainerUserId;
        if (input.minutes !== undefined) patch.endsAt = new Date(s.startsAt.getTime() + input.minutes * 60000);
        await s.update(patch, { transaction });
        if (input.capacity !== undefined) await promoteIn(transaction, s, a.actor);
      }
    }
    await c.record({ action: 'gym_class.updated', actor: a.actor, entityType: 'gym_class', entityId: k.id, before, after: Object.fromEntries(fields.map((f) => [f, input[f]])), meta: { gymId }, req }, transaction);
  });
  return one(gymId, classId);
}

/**
 * PUT …/classes/:classId/slots (classes.manage): the weekly slots. A slot taken away is retired and its future
 * sessions cancelled (everyone booked is told); a new slot gets its sessions ahead.
 */
async function setSlots(principal, gymId, classId, { slots: wanted }, req) {
  const a = await c.access(principal, gymId, 'classes.manage', { feature: FEATURE, restricted: true });
  checkSlots(wanted);
  await sequelize.transaction(async (transaction) => {
    const k = await GymClass.findOne({ where: { id: classId, gymId, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!k) throw c.fail('GYM_CLASS_UNKNOWN');
    const current = await GymClassSchedule.findAll({ where: { classId: k.id, status: 'active' }, transaction });
    const key = (x) => `${x.dow}-${x.startTime}`;
    const want = new Set(wanted.map(key));
    const have = new Set(current.map(key));
    const gone = current.filter((x) => !want.has(key(x)));
    for (const x of gone) {
      await x.update({ status: 'retired' }, { transaction });
      const future = await GymClassSession.findAll({ where: { scheduleId: x.id, status: 'scheduled', startsAt: { [Op.gt]: new Date() } }, transaction, lock: transaction.LOCK.UPDATE });
      await cancelSessionsIn(transaction, { sessions: future, reason: 'The class time changed', by: principal.id, actor: a.actor });
    }
    const added = [];
    for (const x of wanted.filter((w) => !have.has(key(w)))) added.push(await GymClassSchedule.create({ gymId, classId: k.id, dow: x.dow, startTime: x.startTime }, { transaction }));
    await sessionsAheadIn(transaction, { klass: k, slots: added, today: c.today() });
    await c.record({ action: 'gym_class.slots_set', actor: a.actor, entityType: 'gym_class', entityId: k.id, after: { slots: wanted.length, added: added.length, removed: gone.length }, meta: { gymId }, req }, transaction);
  });
  return one(gymId, classId);
}

// ---------------------------------------------------------------- sessions

/** GET …/class-sessions?from&to&classId (classes.manage or attendance.mark): sessions with their counts. */
async function sessions(principal, gymId, { from, to, classId } = {}) {
  await c.access(principal, gymId, null, { feature: FEATURE, anyOf: DESK });
  const start = from ?? c.today();
  const end = to ?? rules.addDays(start, 6);
  const rows = await GymClassSession.findAll({ where: { gymId, localDate: { [Op.between]: [start, end] }, ...(classId ? { classId } : {}) }, order: [['startsAt', 'ASC']], limit: 500 });
  return { from: start, to: end, items: await sessionItems(rows) };
}

async function sessionItems(rows) {
  const classes = new Map((await GymClass.findAll({ where: { id: [...new Set(rows.map((s) => s.classId))] } })).map((k) => [k.id, k]));
  const counts = await countsOf(rows.map((s) => s.id));
  const names = await trainerNames(rows.map((s) => s.trainerUserId));
  return rows.map((s) => sessionView(s, classes.get(s.classId), counts, names));
}

/** GET …/class-sessions/:sessionId: the session and its bookings (members by code and name), waitlist in order. */
async function session(principal, gymId, sessionId) {
  await c.access(principal, gymId, null, { feature: FEATURE, anyOf: DESK });
  const s = await GymClassSession.findOne({ where: { id: sessionId, gymId } });
  if (!s) throw E.notFound('Class session');
  const [item] = await sessionItems([s]);
  const bookings = await GymClassBooking.findAll({ where: { sessionId: s.id }, order: [['createdAt', 'ASC']] });
  const members = new Map();
  for (const b of bookings) if (!members.has(b.memberId)) members.set(b.memberId, await c.ops.member(gymId, b.memberId));
  return {
    ...item,
    bookings: bookings.map((b) => ({
      id: b.id,
      member: members.get(b.memberId) ? { id: b.memberId, memberCode: members.get(b.memberId).memberCode, displayName: members.get(b.memberId).displayName } : { id: b.memberId, memberCode: '', displayName: '' },
      status: b.status,
      source: b.source,
      createdAt: c.iso(b.createdAt),
    })),
  };
}

/** POST …/class-sessions/:sessionId/cancel { reason } (classes.manage): cancel one session; everyone booked or waiting is told. */
async function cancelSession(principal, gymId, sessionId, { reason }, req) {
  const a = await c.access(principal, gymId, 'classes.manage', { feature: FEATURE, restricted: true });
  await sequelize.transaction(async (transaction) => {
    const s = await GymClassSession.findOne({ where: { id: sessionId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!s) throw E.notFound('Class session');
    if (s.status !== 'scheduled' || s.startsAt <= new Date()) throw c.fail('GYM_CLASS_SESSION_STATE');
    await cancelSessionsIn(transaction, { sessions: [s], reason, by: principal.id, actor: a.actor });
    await c.record({ action: 'gym_class.session_cancelled', actor: a.actor, entityType: 'gym_class_session', entityId: s.id, reason, meta: { gymId }, req }, transaction);
  });
  return session(principal, gymId, sessionId);
}

// ---------------------------------------------------------------- bookings

/** The first on the waitlist takes a free place (FR-49), as many as there are places. */
async function promoteIn(transaction, s, actor = null) {
  const counts = (await countsOf([s.id], { transaction })).get(s.id) ?? { booked: 0, waitlisted: 0, attended: 0, noShow: 0 };
  let free = s.capacity - (counts.booked + counts.attended + counts.noShow);
  if (free <= 0 || !counts.waitlisted) return 0;
  const waiting = await GymClassBooking.findAll({ where: { sessionId: s.id, status: 'waitlisted' }, order: [['createdAt', 'ASC']], limit: free, transaction, lock: transaction.LOCK.UPDATE });
  for (const b of waiting) {
    await b.update({ status: 'booked', promotedAt: new Date() }, { transaction });
    await c.publish(transaction, 'gym_booking.promoted', 'gym_class_booking', b.id, { bookingId: b.id, sessionId: s.id, gymId: s.gymId, memberId: b.memberId, startsAt: c.iso(s.startsAt) }, actor);
    free -= 1;
  }
  return waiting.length;
}

/**
 * Book a place (or a waitlist place) for a member, under a lock on the session row (FR-48, FR-49): the member
 * needs a running membership; one live booking per member and session.
 */
async function bookIn(transaction, { gymId, sessionId, memberId, by, source, actor }) {
  const s = await GymClassSession.findOne({ where: { id: sessionId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!s) throw E.notFound('Class session');
  const block = rules.sessionBookBlock({ status: s.status, startsAt: s.startsAt, now: new Date() });
  if (block) throw c.fail(block);
  const m = await c.ops.member(gymId, memberId, { transaction });
  if (!m || ['left', 'removed'].includes(m.status)) throw c.fail('GYM_MEMBER_UNKNOWN');
  if (!(await c.ops.hasRunningMembership(memberId, { transaction }))) throw c.fail('GYM_MEMBERSHIP_NEEDED');
  if (await GymClassBooking.findOne({ where: { sessionId, memberId, status: { [Op.ne]: 'cancelled' } }, transaction })) throw c.fail('GYM_CLASS_BOOKED');
  const counts = (await countsOf([s.id], { transaction })).get(s.id) ?? { booked: 0, waitlisted: 0, attended: 0, noShow: 0 };
  const outcome = rules.bookingOutcome({ booked: counts.booked + counts.attended + counts.noShow, waitlisted: counts.waitlisted, capacity: s.capacity, waitlistMax: c.cfg().waitlistMax });
  if (!outcome) throw c.fail('GYM_CLASS_FULL');
  const b = await GymClassBooking.create({ gymId, sessionId, memberId, status: outcome, bookedBy: by, source }, { transaction });
  await c.publish(transaction, 'gym_booking.made', 'gym_class_booking', b.id, { bookingId: b.id, sessionId, gymId, memberId, status: outcome, source }, actor);
  return { booking: b, session: s, member: m };
}

/** Cancel a live booking; a freed place goes to the waitlist (FR-50). */
async function cancelIn(transaction, { booking, source, actor }) {
  if (!['booked', 'waitlisted'].includes(booking.status)) throw c.fail('GYM_CLASS_BOOKING_STATE');
  const s = await GymClassSession.findByPk(booking.sessionId, { transaction, lock: transaction.LOCK.UPDATE });
  const block = rules.cancelBlock({ source, now: new Date(), startsAt: s.startsAt, cutoffMinutes: c.cfg().classCancelCutoffMinutes });
  if (block) throw c.fail(block);
  const was = booking.status;
  await booking.update({ status: 'cancelled', cancelledAt: new Date() }, { transaction });
  await c.publish(transaction, 'gym_booking.cancelled', 'gym_class_booking', booking.id, { bookingId: booking.id, sessionId: s.id, gymId: s.gymId, memberId: booking.memberId, source }, actor);
  if (was === 'booked') await promoteIn(transaction, s, actor);
}

const bookingView = (b, s) => ({ id: b.id, sessionId: b.sessionId, memberId: b.memberId, status: b.status, source: b.source, startsAt: s ? c.iso(s.startsAt) : null, promoted: Boolean(b.promotedAt) });

/** POST …/class-sessions/:sessionId/bookings { memberId } (desk: classes.manage or attendance.mark; Idempotency-Key). */
async function deskBook(principal, gymId, sessionId, { memberId }, req) {
  const a = await c.access(principal, gymId, null, { feature: FEATURE, anyOf: DESK });
  const out = await sequelize.transaction(async (transaction) => {
    const r = await bookIn(transaction, { gymId, sessionId, memberId, by: principal.id, source: 'desk', actor: a.actor });
    await c.record({ action: 'gym_booking.made', actor: a.actor, entityType: 'gym_class_booking', entityId: r.booking.id, after: { sessionId, status: r.booking.status, source: 'desk' }, meta: { gymId }, req }, transaction);
    return bookingView(r.booking, r.session);
  });
  return out;
}

/** POST …/class-bookings/:bookingId/cancel (desk): cancel until the start. */
async function deskCancel(principal, gymId, bookingId, req) {
  const a = await c.access(principal, gymId, null, { feature: FEATURE, anyOf: DESK });
  return sequelize.transaction(async (transaction) => {
    const b = await GymClassBooking.findOne({ where: { id: bookingId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!b) throw E.notFound('Booking');
    await cancelIn(transaction, { booking: b, source: 'desk', actor: a.actor });
    await c.record({ action: 'gym_booking.cancelled', actor: a.actor, entityType: 'gym_class_booking', entityId: b.id, after: { source: 'desk' }, meta: { gymId }, req }, transaction);
    return bookingView(b, null);
  });
}

/**
 * POST …/class-sessions/:sessionId/attendance { attended: [memberId] } (classes.manage or attendance.mark): after
 * the start, the booked members listed come, the others booked are no-shows (FR-54). The session is done.
 */
async function markAttendance(principal, gymId, sessionId, { attended }, req) {
  const a = await c.access(principal, gymId, null, { feature: FEATURE, anyOf: DESK });
  await sequelize.transaction(async (transaction) => {
    const s = await GymClassSession.findOne({ where: { id: sessionId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!s) throw E.notFound('Class session');
    if (s.status === 'cancelled' || s.startsAt > new Date()) throw c.fail('GYM_CLASS_SESSION_STATE');
    const came = new Set(attended);
    const rows = await GymClassBooking.findAll({ where: { sessionId, status: ['booked', 'attended', 'no_show'] }, transaction });
    for (const b of rows) await b.update({ status: came.has(b.memberId) ? 'attended' : 'no_show', markedAt: new Date() }, { transaction });
    await s.update({ status: 'done' }, { transaction });
    await c.record({ action: 'gym_class.attendance_marked', actor: a.actor, entityType: 'gym_class_session', entityId: s.id, after: { attended: rows.filter((b) => came.has(b.memberId)).length, of: rows.length }, meta: { gymId }, req }, transaction);
  });
  return session(principal, gymId, sessionId);
}

// ---------------------------------------------------------------- the member (linked account)

async function myMember(principal, memberId) {
  const m = await c.ops.memberOfUser(memberId, principal.id);
  if (!m) throw E.notFound('Membership');
  return m;
}

/** GET /me/gym-classes?memberId&from: my gym's sessions ahead with my booking on each (M27-FR-48). */
async function myTimetable(principal, { memberId, from }) {
  const m = await myMember(principal, memberId);
  const start = from ?? c.today();
  const rows = await GymClassSession.findAll({ where: { gymId: m.gymId, localDate: { [Op.between]: [start, rules.addDays(start, 13)] }, status: { [Op.ne]: 'done' } }, order: [['startsAt', 'ASC']], limit: 300 });
  const items = await sessionItems(rows);
  const mine = new Map((await GymClassBooking.findAll({ where: { memberId: m.id, sessionId: rows.map((s) => s.id), status: { [Op.ne]: 'cancelled' } } })).map((b) => [b.sessionId, b]));
  return { memberId: m.id, gymId: m.gymId, items: items.map((x) => ({ ...x, myBooking: mine.get(x.id) ? { id: mine.get(x.id).id, status: mine.get(x.id).status } : null })) };
}

/** POST /me/gym-classes/:sessionId/book { memberId } (Idempotency-Key): book my place, or the waitlist. */
async function myBook(principal, sessionId, { memberId }, req) {
  const m = await myMember(principal, memberId);
  await c.ops.refuseSuspendedId(m.gymId);
  return sequelize.transaction(async (transaction) => {
    const r = await bookIn(transaction, { gymId: m.gymId, sessionId, memberId: m.id, by: principal.id, source: 'member', actor: principal });
    await c.record({ action: 'gym_booking.made', actor: principal, entityType: 'gym_class_booking', entityId: r.booking.id, after: { sessionId, status: r.booking.status, source: 'member' }, meta: { gymId: m.gymId }, req }, transaction);
    return bookingView(r.booking, r.session);
  });
}

/** POST /me/gym-bookings/:bookingId/cancel: cancel my booking up to the cutoff. */
async function myCancel(principal, bookingId, req) {
  return sequelize.transaction(async (transaction) => {
    const b = await GymClassBooking.findByPk(bookingId, { transaction, lock: transaction.LOCK.UPDATE });
    const m = b ? await c.ops.memberOfUser(b.memberId, principal.id) : null;
    if (!b || !m) throw E.notFound('Booking');
    await cancelIn(transaction, { booking: b, source: 'member', actor: principal });
    await c.record({ action: 'gym_booking.cancelled', actor: principal, entityType: 'gym_class_booking', entityId: b.id, after: { source: 'member' }, meta: { gymId: b.gymId }, req }, transaction);
    return bookingView(b, null);
  });
}

/** GET /me/gym-bookings?memberId: my bookings from today, soonest first. */
async function myBookings(principal, { memberId }) {
  const m = await myMember(principal, memberId);
  const rows = await GymClassBooking.findAll({ where: { memberId: m.id, status: { [Op.ne]: 'cancelled' } }, order: [['createdAt', 'DESC']], limit: 100 });
  const sessionsById = new Map((await GymClassSession.findAll({ where: { id: rows.map((b) => b.sessionId), startsAt: { [Op.gte]: new Date(Date.now() - 86400000) } } })).map((s) => [s.id, s]));
  const items = await sessionItems([...sessionsById.values()]);
  const byId = new Map(items.map((x) => [x.id, x]));
  return {
    items: rows
      .filter((b) => sessionsById.has(b.sessionId))
      .map((b) => ({ ...bookingView(b, sessionsById.get(b.sessionId)), session: byId.get(b.sessionId) }))
      .sort((x, y) => x.startsAt.localeCompare(y.startsAt)),
  };
}

// ---------------------------------------------------------------- public (the gym page)

/** GET /gym/gyms/:slug/timetable: the week's sessions of a live gym (no member data; M27-FR-67), and whether it takes enquiries (FR-66). */
async function publicTimetable(slug) {
  const gym = await gymFacade.publicBySlug(slug);
  if (!gym) throw E.notFound('Gym');
  const today = c.today();
  const rows = await GymClassSession.findAll({ where: { gymId: gym.id, localDate: { [Op.between]: [today, rules.addDays(today, 6)] }, status: 'scheduled' }, order: [['startsAt', 'ASC']], limit: 200 });
  const items = await sessionItems(rows);
  return {
    gymId: gym.id,
    enquiries: await c.ops.featureOn(gym.id, 'leads'),
    items: items.map(({ id, name, room, trainer, localDate, startsAt, endsAt, capacity, spaces }) => ({ id, name, room, trainer, localDate, startsAt, endsAt, capacity, spaces })),
  };
}

// ---------------------------------------------------------------- jobs

/** Job: sessions ahead for every active class (daily; FR-47). */
async function sessionsAhead() {
  const classes = await GymClass.findAll({ where: { status: 'active' } });
  let made = 0;
  for (const k of classes) {
    const slots = await GymClassSchedule.findAll({ where: { classId: k.id, status: 'active' } });
    made += await sequelize.transaction((transaction) => sessionsAheadIn(transaction, { klass: k, slots, today: c.today() }));
  }
  return { made };
}

/** Job: the class reminder to everyone booked, once per session (every 15 minutes; FR-53). */
async function reminders(now = new Date()) {
  const minutes = c.cfg().classReminderMinutes;
  const rows = await GymClassSession.findAll({ where: { status: 'scheduled', remindedAt: null, startsAt: { [Op.gt]: now, [Op.lte]: new Date(now.getTime() + minutes * 60000) } }, limit: 500 });
  let sent = 0;
  for (const s of rows) {
    if (!rules.classReminderDue({ startsAt: s.startsAt, now, minutes, remindedAt: s.remindedAt })) continue;
    await sequelize.transaction(async (transaction) => {
      const locked = await GymClassSession.findByPk(s.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (locked.remindedAt) return;
      await locked.update({ remindedAt: now }, { transaction });
      const booked = await GymClassBooking.findAll({ where: { sessionId: s.id, status: 'booked' }, transaction });
      if (booked.length) {
        await c.publish(transaction, 'gym_class.reminded', 'gym_class_session', s.id, { sessionId: s.id, gymId: s.gymId, classId: s.classId, startsAt: c.iso(s.startsAt), memberIds: booked.map((b) => b.memberId) });
        sent += 1;
      }
    });
  }
  return { sent };
}

/** The members booked (or waiting) on a class's sessions from today (notices to a class, FR-62). */
async function memberIdsOfClass(gymId, classId) {
  const sessionIds = (await GymClassSession.findAll({ attributes: ['id'], where: { classId, gymId, startsAt: { [Op.gte]: new Date(Date.now() - 30 * 86400000) } } })).map((x) => x.id);
  if (!sessionIds.length) return [];
  const live = await GymClassBooking.findAll({ attributes: ['memberId'], where: { sessionId: sessionIds, status: LIVE } });
  return [...new Set(live.map((b) => b.memberId))];
}

/** Class facts for notifications (name, start). */
async function sessionFacts(sessionId) {
  const s = await GymClassSession.findByPk(sessionId);
  if (!s) return null;
  const k = await GymClass.findByPk(s.classId);
  return { name: k?.name ?? '', startsAt: s.startsAt, gymId: s.gymId, localDate: s.localDate };
}

// ---------------------------------------------------------------- holidays and special hours (M20-FR-20, FR-21)

/** The scheduled sessions ahead that a special day ({ fromOn, toOn, kind, windows }) leaves shut. */
async function sessionsHitBy(gymId, day, { transaction, lock = false } = {}) {
  const rows = await GymClassSession.findAll({ where: { gymId, status: 'scheduled', localDate: { [Op.between]: [day.fromOn, day.toOn] }, startsAt: { [Op.gt]: new Date() } }, order: [['startsAt', 'ASC']], transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  return rows.filter((s) => rules.outsideSpecialDay(day, rules.dhakaMinutes(s.startsAt)));
}

/** For the owner's preview (M20-FR-17): how many class sessions a special day would cancel. */
const sessionsHit = async (gymId, day) => (await sessionsHitBy(gymId, day)).length;

/** Consumer of gym_special_day.created: cancel those sessions (everyone booked or waiting is told) and remember why. */
async function onSpecialDay(p, { transaction }) {
  const sessions = await sessionsHitBy(p.gymId, p, { transaction, lock: true });
  if (!sessions.length) return;
  await cancelSessionsIn(transaction, { sessions, reason: rules.specialDayReason(p), by: null, actor: null });
  await GymClassSession.update({ specialDayId: p.specialDayId }, { where: { id: sessions.map((s) => s.id) }, transaction });
}

/**
 * Consumer of gym_special_day.removed: the sessions it cancelled that have not started come back, empty (bookings
 * are not restored), when their class and weekly time are still active.
 */
async function onSpecialDayRemoved(p, { transaction }) {
  const rows = await GymClassSession.findAll({ where: { gymId: p.gymId, specialDayId: p.specialDayId, status: 'cancelled', startsAt: { [Op.gt]: new Date() } }, transaction, lock: transaction.LOCK.UPDATE });
  if (!rows.length) return;
  const classes = new Set((await GymClass.findAll({ where: { id: [...new Set(rows.map((s) => s.classId))], status: 'active' }, attributes: ['id'], transaction })).map((k) => k.id));
  const slots = new Set((await GymClassSchedule.findAll({ where: { id: [...new Set(rows.map((s) => s.scheduleId))], status: 'active' }, attributes: ['id'], transaction })).map((x) => x.id));
  const back = rows.filter((s) => classes.has(s.classId) && slots.has(s.scheduleId)).map((s) => s.id);
  if (back.length) await GymClassSession.update({ status: 'scheduled', cancelReason: null, cancelledBy: null, cancelledAt: null, specialDayId: null }, { where: { id: back }, transaction });
}

module.exports = {
  sessionsHit,
  onSpecialDay,
  onSpecialDayRemoved,
  trainers,
  list,
  create,
  update,
  setSlots,
  sessions,
  session,
  cancelSession,
  deskBook,
  deskCancel,
  markAttendance,
  myTimetable,
  myBook,
  myCancel,
  myBookings,
  publicTimetable,
  sessionsAhead,
  reminders,
  memberIdsOfClass,
  sessionFacts,
};
