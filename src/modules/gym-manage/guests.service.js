'use strict';

/**
 * M24 trial visits (product owner, 9 Nov 2026; replaces the day pass removed on 2 Nov). A signed-in person
 * with a verified phone (gate join_gym) books a free visit to a gym before joining. The gym switches visits
 * on (gym_manage_settings.visits_open; plan feature `visits`, Basic and up) and sets a daily cap and how many
 * visits one person may book (default 1). A booking is confirmed at once within those rules and the gym's
 * opening hours. The owner and staff with attendance.mark are told when a visit is booked and each morning
 * (GYM_GUESTS_TODAY); the desk sees today's guests, checks them in by the guest's QR or 6-character code, and
 * can make the guest a member (source desk: no Kriraghor referral fee, by the product owner's decision).
 * Free: nothing moves through M06 or the gym's books. Rows are never deleted.
 */
const crypto = require('node:crypto');
const { Op, QueryTypes, UniqueConstraintError } = require('sequelize');
const { AppError, E } = require('../../common/errors');
const velocity = require('../../common/velocity');
const settings = require('../settings').settings;
const { sequelize, GymVisit, GymMember, GymMembership } = require('../../models');
const directory = require('../users').directory;
const staffAccess = require('../business-members').access;
const gymFacade = require('../gym').gyms;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');
const view = require('./gym-manage.serializer');
const members = require('./members.service');
const visits = require('./visits.service');

const FEATURE = 'visits';
const DESK = ['attendance.mark', 'members.view'];

const cfg = () => ({
  aheadDays: settings.get('gym_manage.visit_book_ahead_days'),
  capDefault: settings.get('gym_manage.visit_daily_cap_default'),
  capMax: settings.get('gym_manage.visit_daily_cap_max'),
  perPersonMax: settings.get('gym_manage.visit_per_person_max'),
  cancelCutoffMinutes: settings.get('gym_manage.visit_cancel_cutoff_minutes'),
  perUserDay: settings.get('gym_manage.visits_per_user_day'),
  morningTime: settings.get('gym_manage.morning_summary_time'),
});

const ERRORS = {
  GYM_VISITS_CLOSED: [409, 'This gym is not taking trial visits right now'],
  GYM_VISIT_OWN_GYM: [409, 'You run or work at this gym'],
  GYM_VISIT_MEMBER: [409, 'You are already a member of this gym'],
  GYM_VISIT_DATE: [422, 'Choose a day and time from now within the booking window'],
  GYM_VISIT_HOURS: [422, 'The gym is not open at that time'],
  GYM_VISIT_LIMIT: [409, 'You have used your trial visits at this gym'],
  GYM_VISIT_FULL: [409, 'No trial visit places are left that day'],
  GYM_VISIT_STATE: [409, 'This visit cannot change now'],
  GYM_VISIT_CANCEL_CLOSED: [409, 'It is too late to cancel this visit; the gym will mark it'],
  GYM_VISIT_NOT_TODAY: [409, 'This visit is for another day'],
};
const fail = (code, meta) => {
  const [status, title] = ERRORS[code];
  return new AppError(status, code, title, meta ? { meta } : {});
};

const lockDay = (transaction, gymId, date) => sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `gym_visit:${gymId}:${date}` }, transaction });
const tokenOf = (v) => rules.visitToken({ visitId: v.id, nonce: v.qrNonce }, c.sign);
const capOf = (s) => s?.visitDailyCap ?? cfg().capDefault;

/** Whether the gym takes visits now: switched on, set up, published, and its owner's plan has the feature. */
async function openFor(gym, s) {
  if (!gym || !['live', 'paused'].includes(gym.status) || !s?.visitsOpen) return false;
  const sub = await c.subscriptionOf(gym.ownerId);
  return sub.status !== 'restricted' && rules.hasFeature(sub.chosenTier, FEATURE, c.tierCfg().featureMinTiers);
}

/** Booked, attended and no-show visits count against a person's limit at a gym; cancelled ones do not. */
const usedBy = (gymId, userId, transaction) => GymVisit.count({ where: { gymId, userId, status: ['booked', 'attended', 'no_show'] }, transaction });
const bookedOn = (gymId, date, transaction) => GymVisit.count({ where: { gymId, visitDate: date, status: ['booked', 'attended'] }, transaction });

async function isMember(gymId, userId, transaction) {
  const m = await GymMember.findOne({ where: { gymId, userId, status: { [Op.notIn]: ['removed', 'left'] } }, attributes: ['id'], transaction });
  if (!m) return false;
  return Boolean(await GymMembership.count({ where: { memberId: m.id, status: ['active', 'frozen', 'upcoming'] }, transaction }));
}

const isOwnGym = (principal, gym) => gym.ownerId === principal.id || Boolean(staffAccess.workplaceAt(principal, 'gym', gym.id));

// ---------------------------------------------------------------- views

const gymRef = (g) => (g ? { id: g.id, name: g.name, slug: g.slug, addressLine: g.addressLine ?? null } : null);

function myView(v, gym, { today }) {
  const live = v.status === 'booked' && v.visitDate >= today;
  return {
    id: v.id,
    gym: gymRef(gym),
    date: v.visitDate,
    arriveAt: v.arriveAt,
    status: v.status,
    code: live ? v.code : null,
    token: live ? tokenOf(v) : null,
    cancelledBy: v.cancelBy ?? null,
    cancelReason: v.cancelBy === 'gym' ? v.cancelReason ?? null : null,
    attendedAt: c.iso(v.attendedAt),
    createdAt: c.iso(v.createdAt),
  };
}

function gymView(v, names, last4) {
  return {
    id: v.id,
    guest: { userId: v.userId, name: names.get(v.userId) ?? null, phoneLast4: last4.get(v.userId) ?? null },
    date: v.visitDate,
    arriveAt: v.arriveAt,
    status: v.status,
    cancelledBy: v.cancelBy ?? null,
    cancelReason: v.cancelReason ?? null,
    attendedAt: c.iso(v.attendedAt),
    memberId: v.memberId ?? null,
    createdAt: c.iso(v.createdAt),
  };
}

async function gymViews(rows) {
  const ids = [...new Set(rows.map((r) => r.userId))];
  const names = await directory.displayNames(ids);
  const last4 = new Map();
  for (const id of ids) {
    const phone = await directory.verifiedPhoneOf(id);
    if (phone) last4.set(id, phone.slice(-4));
  }
  return rows.map((r) => gymView(r, names, last4));
}

// ---------------------------------------------------------------- public: the gym page

/** GET /gym/gyms/:slug/visit-slots: whether the gym takes visits, its note, and each day ahead with its open windows and places left. */
async function slots(slug) {
  const gym = await gymFacade.publicBySlug(slug);
  if (!gym) throw E.notFound('Gym');
  const s = await c.settingsOf(gym.id);
  const today = c.today();
  if (!(await openFor(gym, s))) return { open: false, note: null, days: [] };
  const { aheadDays } = cfg();
  const cap = capOf(s);
  const rows = await sequelize.query(
    "SELECT visit_date AS date, COUNT(*)::int AS n FROM gym_visits WHERE gym_id = :gymId AND visit_date BETWEEN :from AND :to AND status IN ('booked', 'attended') GROUP BY visit_date",
    { replacements: { gymId: gym.id, from: today, to: rules.addDays(today, aheadDays) }, type: QueryTypes.SELECT }
  );
  const taken = new Map(rows.map((r) => [String(r.date).slice(0, 10), Number(r.n)]));
  const days = [];
  for (let i = 0; i <= aheadDays; i += 1) {
    const date = rules.addDays(today, i);
    const windows = await gymFacade.liveWindowsOn(gym.id, date);
    if (windows.length) days.push({ date, windows, placesLeft: Math.max(0, cap - (taken.get(date) ?? 0)) });
  }
  return { open: true, note: s.visitNote ?? null, perPerson: s.visitPerPerson, days };
}

// ---------------------------------------------------------------- the guest

/** POST /me/gym-visits { gymId, date, arriveAt } (gate join_gym, Idempotency-Key): book a free visit, confirmed at once. */
async function book(principal, { gymId, date, arriveAt }, req) {
  const gym = await gymFacade.get(gymId);
  if (!gym) throw E.notFound('Gym');
  const conf = cfg();
  const now = new Date();
  // gym_manage.visits_per_user_day: bookings made in the last 24 hours, at any gym (refused attempts do not count).
  const recent = await GymVisit.count({ where: { userId: principal.id, createdAt: { [Op.gt]: new Date(now.getTime() - 86400000) } } });
  if (recent >= conf.perUserDay) throw E.tooMany('RATE_LIMITED', 'Too many requests', 'You have booked many visits today. Try again tomorrow.', { retryAfter: 3600 });
  const today = c.today(now);
  const windows = rules.isDate(date) ? await gymFacade.liveWindowsOn(gymId, date) : [];
  const row = await sequelize.transaction(async (transaction) => {
    const s = await c.settingsOf(gymId, { transaction });
    const open = await openFor(gym, s);
    if (open) await lockDay(transaction, gymId, date);
    const block = rules.visitBlock({
      open,
      own: isOwnGym(principal, gym),
      member: open ? await isMember(gymId, principal.id, transaction) : false,
      date,
      arriveAt,
      today,
      nowMinute: rules.dhakaMinute(now),
      aheadDays: conf.aheadDays,
      windows,
      usedByPerson: open ? await usedBy(gymId, principal.id, transaction) : 0,
      perPerson: s?.visitPerPerson ?? 1,
      bookedThatDay: open && rules.isDate(date) ? await bookedOn(gymId, date, transaction) : 0,
      cap: capOf(s),
    });
    if (block) throw fail(block, block === 'GYM_VISIT_LIMIT' ? { perPerson: s.visitPerPerson } : undefined);
    let v = null;
    for (let attempt = 0; attempt < 5 && !v; attempt += 1) {
      try {
        v = await sequelize.transaction({ transaction }, (t) =>
          GymVisit.create({ gymId, userId: principal.id, visitDate: date, arriveAt, code: rules.visitCode(crypto.randomBytes(6)), qrNonce: crypto.randomBytes(12).toString('hex') }, { transaction: t })
        );
      } catch (err) {
        if (!(err instanceof UniqueConstraintError)) throw err;
        // Either the code was taken (try another) or this person already has a booking that day.
        if (await GymVisit.findOne({ where: { gymId, userId: principal.id, visitDate: date, status: 'booked' }, attributes: ['id'], transaction })) throw fail('GYM_VISIT_LIMIT', { perPerson: s.visitPerPerson });
      }
    }
    if (!v) throw new Error('Could not pick a visit code');
    await c.publish(transaction, 'gym_visit.booked', 'gym_visit', v.id, { visitId: v.id, gymId, ownerId: gym.ownerId, userId: principal.id, date, arriveAt }, principal);
    await c.record({ action: 'gym_visit.booked', actor: principal, entityType: 'gym_visit', entityId: v.id, after: { date, arriveAt }, meta: { gymId }, req }, transaction);
    return v;
  });
  return { visit: myView(row, gym, { today }) };
}

/** GET /me/gym-visits: my visits, newest first; the QR token and code while a visit is booked and not past. */
async function mine(principal) {
  const rows = await GymVisit.findAll({ where: { userId: principal.id }, order: [['visitDate', 'DESC'], ['createdAt', 'DESC']], limit: 50 });
  const gyms = new Map();
  for (const id of new Set(rows.map((r) => r.gymId))) gyms.set(id, await gymFacade.get(id));
  const today = c.today();
  return { items: rows.map((r) => myView(r, gyms.get(r.gymId), { today })) };
}

/** POST /me/gym-visits/:visitId/cancel: up to gym_manage.visit_cancel_cutoff_minutes before the time. */
async function cancelMine(principal, visitId, req) {
  const now = new Date();
  await sequelize.transaction(async (transaction) => {
    const v = await GymVisit.findOne({ where: { id: visitId, userId: principal.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!v) throw E.notFound('Visit');
    const block = rules.visitCancelBlock({ visit: v, by: 'guest', now, cutoffMinutes: cfg().cancelCutoffMinutes, today: c.today(now) });
    if (block) throw fail(block);
    await v.update({ status: 'cancelled', cancelBy: 'guest', cancelledAt: now }, { transaction });
    const gym = await gymFacade.get(v.gymId);
    await c.publish(transaction, 'gym_visit.cancelled', 'gym_visit', v.id, { visitId: v.id, gymId: v.gymId, ownerId: gym?.ownerId ?? null, userId: v.userId, by: 'guest', date: v.visitDate, arriveAt: v.arriveAt }, principal);
    await c.record({ action: 'gym_visit.cancelled', actor: principal, entityType: 'gym_visit', entityId: v.id, after: { by: 'guest' }, meta: { gymId: v.gymId }, req }, transaction);
  });
  return mine(principal);
}

// ---------------------------------------------------------------- the gym

/** GET …/visits?date=&status= (attendance.mark or members.view; Basic): the guests of a day (today by default) with counts. */
async function list(principal, gymId, { date, status } = {}) {
  await c.gymAccess(principal, gymId, null, { feature: FEATURE, anyOf: DESK });
  const day = date ?? c.today();
  const rows = await GymVisit.findAll({ where: { gymId, visitDate: day, ...(status ? { status } : {}) }, order: [['arriveAt', 'ASC'], ['createdAt', 'ASC']] });
  const all = status ? await GymVisit.findAll({ where: { gymId, visitDate: day }, attributes: ['status'] }) : rows;
  const counts = { booked: 0, attended: 0, cancelled: 0, no_show: 0 };
  for (const r of all) counts[r.status] += 1;
  const s = await c.settingsOf(gymId);
  return { date: day, open: Boolean(s?.visitsOpen), cap: capOf(s), counts, items: await gymViews(rows) };
}

async function lockedVisit(gymId, visitId, transaction) {
  const v = await GymVisit.findOne({ where: { id: visitId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!v) throw E.notFound('Visit');
  return v;
}

/** POST …/visits/:visitId/check-in (attendance.mark): the guest is here today; the desk feed shows them. */
async function checkIn(principal, gymId, visitId, req) {
  const a = await c.gymAccess(principal, gymId, 'attendance.mark', { feature: FEATURE });
  const now = new Date();
  const done = await sequelize.transaction(async (transaction) => {
    const v = await lockedVisit(gymId, visitId, transaction);
    const block = rules.visitCheckInBlock({ visit: v, today: c.today(now) });
    if (block) throw fail(block, { status: v.status, date: v.visitDate });
    await v.update({ status: 'attended', attendedAt: now, attendedBy: principal.id }, { transaction });
    await c.publish(transaction, 'gym_visit.attended', 'gym_visit', v.id, { visitId: v.id, gymId, userId: v.userId }, a.actor);
    await c.record({ action: 'gym_visit.attended', actor: a.actor, entityType: 'gym_visit', entityId: v.id, meta: { gymId }, req }, transaction);
    const names = await directory.displayNames([v.userId], { transaction });
    visits.feedAfterCommit(transaction, { gymId, kind: 'guest', guest: { visitId: v.id, name: names.get(v.userId) ?? null }, at: now.toISOString() });
    return v;
  });
  return { visit: (await gymViews([done]))[0] };
}

/** POST …/visits/:visitId/cancel { reason } (attendance.mark): the gym cancels a booked visit; the guest is told. */
async function cancelByGym(principal, gymId, visitId, { reason }, req) {
  const a = await c.gymAccess(principal, gymId, 'attendance.mark', { feature: FEATURE });
  const now = new Date();
  const done = await sequelize.transaction(async (transaction) => {
    const v = await lockedVisit(gymId, visitId, transaction);
    const block = rules.visitCancelBlock({ visit: v, by: 'gym', now, cutoffMinutes: 0, today: c.today(now) });
    if (block) throw fail(block);
    await v.update({ status: 'cancelled', cancelBy: 'gym', cancelReason: reason, cancelledAt: now }, { transaction });
    await c.publish(transaction, 'gym_visit.cancelled', 'gym_visit', v.id, { visitId: v.id, gymId, ownerId: a.gym.ownerId, userId: v.userId, by: 'gym', date: v.visitDate, arriveAt: v.arriveAt }, a.actor);
    await c.record({ action: 'gym_visit.cancelled', actor: a.actor, entityType: 'gym_visit', entityId: v.id, reason, after: { by: 'gym' }, meta: { gymId }, req }, transaction);
    return v;
  });
  return { visit: (await gymViews([done]))[0] };
}

/** POST …/visits/:visitId/reveal-phone (members.view): the guest's verified phone for a call back; audited, no-store, rate-limited (as M24-FR-12). */
async function revealPhone(principal, gymId, visitId, req) {
  const a = await c.gymAccess(principal, gymId, 'members.view', { feature: FEATURE });
  const v = await GymVisit.findOne({ where: { id: visitId, gymId } });
  if (!v) throw E.notFound('Visit');
  const hit = await velocity.hit({ name: 'gym_phone_reveal', scope: principal.id, limit: c.cfg().phoneRevealsPerHour, windowMs: 3600000 });
  if (!hit.allowed) throw E.tooMany('RATE_LIMITED', 'Too many requests', 'Slow down and try again shortly.', { retryAfter: hit.retryAfter });
  const phone = await directory.verifiedPhoneOf(v.userId);
  if (!phone) throw E.notFound('Phone');
  await c.record({ action: 'gym_visit.phone_revealed', actor: a.actor, entityType: 'gym_visit', entityId: v.id, meta: { gymId }, req }, null);
  return { visitId: v.id, phone };
}

/**
 * POST …/visits/:visitId/convert (members.edit; refused while restricted): the guest becomes a member. Their
 * account is linked (name and verified phone from the account), or an unlinked member with the same phone is
 * linked instead; a guest already linked here (a lapsed membership) keeps that member. Source desk: no Kriraghor referral fee (product owner, 9 Nov 2026).
 */
async function convert(principal, gymId, visitId, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit', { restricted: true });
  const today = c.today();
  const made = await sequelize.transaction(async (transaction) => {
    const v = await lockedVisit(gymId, visitId, transaction);
    if (v.memberId || v.status === 'cancelled') throw fail('GYM_VISIT_STATE');
    const settingsRow = await c.requireSetup(gymId, { transaction, lock: true });
    const account = (await directory.accounts([v.userId])).get(v.userId);
    const phone = await directory.verifiedPhoneOf(v.userId, { transaction });
    if (!account || account.status !== 'active' || !phone) throw fail('GYM_VISIT_STATE');
    // Already this gym's linked member (a lapsed membership): the visit points at that member.
    let member = await GymMember.findOne({ where: { gymId, userId: v.userId, status: { [Op.ne]: 'removed' } }, transaction });
    if (!member) member = await GymMember.findOne({ where: { gymId, phoneHash: c.phoneHash(phone), status: { [Op.ne]: 'removed' } }, transaction, lock: transaction.LOCK.UPDATE });
    if (member?.userId === v.userId) {
      // nothing to link
    } else if (member) {
      if (member.userId) throw c.fail('GYM_ALREADY_LINKED', { reason: 'member_linked', memberId: member.id });
      await member.update({ userId: v.userId, linkedAt: new Date(), unlinkedAt: null, version: member.version + 1, updatedBy: principal.id }, { transaction });
      await c.publish(transaction, 'gym_member.linked', 'gym_member', member.id, { memberId: member.id, gymId, ownerId: a.gym.ownerId, userId: v.userId, by: principal.id }, a.actor);
    } else {
      const displayName = String(account.displayName ?? '').trim().slice(0, 80) || 'Member';
      member = await members.createIn(transaction, { gym: a.gym, settings: settingsRow, input: { displayName, phone }, source: 'desk', actor: a.actor, today, userId: v.userId });
      await c.record({ action: 'gym_member.added', actor: a.actor, entityType: 'gym_member', entityId: member.id, entityCode: member.memberCode, after: { displayName: member.displayName, phone: 'set', source: 'desk', visitId: v.id }, meta: { gymId }, req }, transaction);
    }
    await v.update({ memberId: member.id, convertedAt: new Date() }, { transaction });
    await c.publish(transaction, 'gym_visit.converted', 'gym_visit', v.id, { visitId: v.id, gymId, userId: v.userId, memberId: member.id }, a.actor);
    await c.record({ action: 'gym_visit.converted', actor: a.actor, entityType: 'gym_visit', entityId: v.id, after: { memberId: member.id }, meta: { gymId }, req }, transaction);
    return member;
  });
  return c.shown(a, { member: view.memberSummary(await GymMember.findByPk(made.id)) });
}

/** The desk search (checkins.search): a visit by its QR token, or a booked visit by its code → the gym's view, else null. */
async function deskLookup(gymId, text) {
  const t = String(text ?? '').trim();
  let v = null;
  if (rules.looksLikeVisitToken(t)) {
    const parsed = rules.parseVisitToken(t, { sign: c.sign, equal: c.equal });
    v = parsed ? await GymVisit.findOne({ where: { id: parsed.visitId, gymId, qrNonce: parsed.nonce } }) : null;
  } else {
    const code = rules.normalizeVisitCode(t);
    v = code ? await GymVisit.findOne({ where: { gymId, code, status: 'booked' } }) : null;
  }
  return v ? (await gymViews([v]))[0] : null;
}

/** For the dashboard: today's booked and attended guests. */
async function todayCount(gymId) {
  return GymVisit.count({ where: { gymId, visitDate: c.today(), status: ['booked', 'attended'] } });
}

// ---------------------------------------------------------------- the job

/**
 * gym-manage.visits-daily (every 15 minutes): from gym_manage.morning_summary_time, each gym with guests today
 * gets GYM_GUESTS_TODAY once and each guest gets GYM_VISIT_REMINDER once (send-once log); visits of past days
 * still booked become no-shows.
 */
async function daily(now = new Date()) {
  const today = c.today(now);
  const out = { lists: 0, reminders: 0, noShows: 0 };
  const [noShows] = await sequelize.query("UPDATE gym_visits SET status = 'no_show', updated_at = NOW() WHERE status = 'booked' AND visit_date < :today RETURNING id", { replacements: { today } });
  out.noShows = noShows.length;
  if (now.getTime() < rules.visitStartAt(today, cfg().morningTime).getTime()) return out;
  const rows = await GymVisit.findAll({ where: { visitDate: today, status: 'booked' }, order: [['arriveAt', 'ASC']] });
  const byGym = new Map();
  for (const r of rows) byGym.set(r.gymId, [...(byGym.get(r.gymId) ?? []), r]);
  for (const [gymId, list] of byGym) {
    const gym = await gymFacade.get(gymId);
    if (!gym) continue;
    await sequelize.transaction(async (transaction) => {
      if (!(await c.claimReminder(transaction, { ownerId: gym.ownerId, gymId, kind: 'guests_today', subjectType: 'gym', subjectId: gymId, offsetKey: today }))) return;
      await c.publish(transaction, 'gym_visits.listed', 'gym', gymId, { gymId, ownerId: gym.ownerId, date: today, count: list.length, firstAt: list[0].arriveAt });
      out.lists += 1;
    });
    for (const v of list) {
      // A visit whose time has passed before the morning run gets no reminder.
      if (rules.visitStartAt(today, v.arriveAt).getTime() <= now.getTime()) continue;
      await sequelize.transaction(async (transaction) => {
        if (!(await c.claimReminder(transaction, { ownerId: gym.ownerId, gymId, kind: 'visit_reminder', subjectType: 'visit', subjectId: v.id, offsetKey: today }))) return;
        await c.publish(transaction, 'gym_visit.reminded', 'gym_visit', v.id, { visitId: v.id, gymId, userId: v.userId, date: today, arriveAt: v.arriveAt });
        out.reminders += 1;
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- holidays and special hours (M20-FR-20)

/** The booked visits a special day ({ fromOn, toOn, kind, windows }) leaves without an open hour. */
async function visitsHitBy(gymId, day, { transaction, lock = false } = {}) {
  const rows = await GymVisit.findAll({ where: { gymId, status: 'booked', visitDate: { [Op.between]: [day.fromOn, day.toOn] } }, order: [['visitDate', 'ASC'], ['arriveAt', 'ASC']], transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  return rows.filter((v) => rules.outsideSpecialDay(day, v.arriveAt));
}

/** For the owner's preview (M20-FR-17): how many booked visits a special day would cancel. */
const specialDayHits = async (gymId, day) => (await visitsHitBy(gymId, day)).length;

/** Consumer of gym_special_day.created: the gym cancels those visits; each guest is told with the day’s title. */
async function onSpecialDay(p, { transaction }) {
  const now = new Date();
  const reason = rules.specialDayReason(p);
  for (const v of await visitsHitBy(p.gymId, p, { transaction, lock: true })) {
    await v.update({ status: 'cancelled', cancelBy: 'gym', cancelReason: reason, cancelledAt: now }, { transaction });
    await c.publish(transaction, 'gym_visit.cancelled', 'gym_visit', v.id, { visitId: v.id, gymId: v.gymId, ownerId: p.ownerId ?? null, userId: v.userId, by: 'gym', date: v.visitDate, arriveAt: v.arriveAt }, null);
    await c.record({ action: 'gym_visit.cancelled', actor: null, entityType: 'gym_visit', entityId: v.id, reason, after: { by: 'gym' }, meta: { gymId: v.gymId, specialDayId: p.specialDayId } }, transaction);
  }
}

module.exports = { ERRORS, slots, book, mine, cancelMine, list, checkIn, cancelByGym, revealPhone, convert, deskLookup, todayCount, daily, openFor, specialDayHits, onSpecialDay };
