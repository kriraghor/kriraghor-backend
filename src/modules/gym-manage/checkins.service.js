'use strict';

/**
 * M24 check-ins (§5.6, §6.8): the desk search, member check-ins at the desk (by member id from the
 * search or by the member's rotating QR token), the day's list, and M20 pass admissions of linked
 * members (consumer).
 *  - One counted check-in per member per Dhaka day (partial unique index; the member row lock settles
 *    two scans at once); repeats are kept with counted = false (FR-47, FR-48).
 *  - The entry policy (FR-49, G8): allow, warn or block for expired, frozen, never-joined, overdue or
 *    over-the-visit-limit members. `block` refuses staff with 409 GYM_ENTRY_BLOCKED; the owner may
 *    override with a reason (audited gym_attendance.override).
 *  - Check-ins need the `attendance` feature (Basic and up, §3.5). Amounts show only with fees.collect.
 *  - `local_date` comes from the server clock, never the client (§12.23).
 *  - Prompt 3, the entrance QR (M24-FR-51): the tablet at the door shows a token rotating every
 *    gym_manage.entrance_qr_seconds; a linked member scans it (POST /me/gym-checkins, gate join_gym) and is
 *    checked in with method entrance_qr under the same entry policy; `block` refuses with the gym's
 *    message and no override. The desk and the entrance share one core (checkInCore).
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { normalizePhone } = require('../../common/identifiers');
const { sequelize, GymMember, GymMembership, GymDue, GymAttendance } = require('../../models');
const directory = require('../users').directory;
const gymDesk = require('../gym').desk;
const gymFacade = require('../gym').gyms;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');
const view = require('./gym-manage.serializer');
const visits = require('./visits.service');

const { fail } = c;

/** What the desk card needs about a member: the running membership, history, overdue dues, visits. */
async function facts(m, today, { transaction } = {}) {
  // One after another: inside a transaction the queries share one connection.
  const current = await GymMembership.findOne({ where: { memberId: m.id, status: ['active', 'frozen'] }, transaction });
  const had = await GymMembership.count({ where: { memberId: m.id, [Op.or]: [{ status: { [Op.notIn]: ['cancelled'] } }, { status: 'cancelled', startsOn: { [Op.lte]: today } }] }, transaction });
  const dues = await GymDue.findAll({ where: { memberId: m.id, status: ['unpaid', 'partial'] }, transaction });
  const visits = current?.visitLimit ? await GymAttendance.count({ where: { memberId: m.id, counted: true, localDate: { [Op.gte]: current.startsOn, [Op.lte]: today } }, transaction }) : 0;
  const overdue = dues.some((d) => rules.isOverdue({ status: d.status, dueOn: d.dueOn, today }));
  const outstanding = dues.reduce((s, d) => s + rules.dueState({ amount: d.amountPoisha, paid: d.paidPoisha, waived: d.waivedPoisha }).outstanding, 0);
  return { current, hadMembership: had > 0, overdue, outstanding, visits };
}

/** The desk card (§9.3): member, membership, flags, the entry decision; amounts only with fees.collect. */
async function card(a, m, f, today, { policy, decision, extra = {} }) {
  const linkedPhoto = m.userId && !m.photoKey ? (await directory.publicNames([m.userId])).get(m.userId)?.avatarUrl ?? null : null;
  const d = decision ?? rules.entryDecision({ current: f.current, hadMembership: f.hadMembership, overdue: f.overdue, visits: f.visits, policy });
  return {
    ...extra,
    member: { ...view.memberSummary(m), avatarUrl: linkedPhoto },
    membership: f.current ? { id: f.current.id, title: f.current.title, packageKind: f.current.packageKind, startsOn: f.current.startsOn, endsOn: f.current.endsOn, daysLeft: rules.daysLeft({ startsOn: f.current.startsOn, endsOn: f.current.endsOn, today }), status: f.current.status, visitLimit: f.current.visitLimit ?? null, visits: f.visits } : null,
    flags: rules.deskFlags({ current: f.current, hadMembership: f.hadMembership, overdue: f.overdue, visits: f.visits, today }),
    reasons: d.reasons,
    decision: d.decision,
    canOverride: d.decision === 'block' && a.owner,
    ...(a.can('fees.collect') ? { outstandingPoisha: f.outstanding } : {}),
  };
}

async function policyOf(gymId) {
  const s = await c.settingsOf(gymId);
  return s?.entryPolicy ?? c.cfg().entryPolicyDefault;
}

/**
 * GET /manage/gyms/:gymId/desk/search?q (attendance.mark): members by name, phone (exact, on its hash),
 * member code or member QR token; the M20 pass a token or backup code names (with desk.admit); and a
 * trial-visit guest by their QR or code (plan feature visits).
 */
async function search(principal, gymId, { q }) {
  const a = await c.gymAccess(principal, gymId, 'attendance.mark');
  const today = c.today();
  const policy = await policyOf(gymId);
  const text = q.trim();
  let members = [];
  if (rules.looksLikeMemberToken(text)) {
    const parsed = c.parseMemberToken(text);
    const m = parsed ? await GymMember.findOne({ where: { id: parsed.memberId, gymId, status: { [Op.ne]: 'removed' } } }) : null;
    members = m ? [m] : [];
  } else {
    const phone = normalizePhone(text);
    const or = [{ memberCode: text.toUpperCase() }, { displayName: { [Op.iLike]: `%${text.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%` } }];
    if (phone) or.push({ phoneHash: c.phoneHash(phone) });
    members = await GymMember.findAll({ where: { gymId, status: { [Op.ne]: 'removed' }, [Op.or]: or }, order: [['displayName', 'ASC'], ['memberCode', 'ASC']], limit: 10 }); // the code breaks ties (same names)
  }
  const items = [];
  for (const m of members) items.push(await card(a, m, await facts(m, today), today, { policy }));
  const pass = a.can('desk.admit') && !rules.looksLikeMemberToken(text) && !rules.looksLikeVisitToken(text) ? await gymDesk.lookup(gymId, text) : null;
  // Trial visits (9 Nov 2026): a guest's QR or 6-character code (only where the plan has visits).
  const visit = !rules.looksLikeMemberToken(text) && (await require('./ops.service').featureOn(gymId, 'visits')) ? await require('./guests.service').deskLookup(gymId, text) : null;
  return c.shown(a, { items, pass, visit });
}

/** The member a check-in names: by id, or by the rotating QR token (current or previous window; FR-50). */
async function memberFor(gymId, { memberId, token }, transaction) {
  let id = memberId;
  let method = 'desk';
  if (token) {
    const parsed = c.parseMemberToken(token);
    if (!parsed) throw fail('GYM_CHECKIN_TOKEN_INVALID');
    id = parsed.memberId;
    method = 'member_qr';
  }
  const m = await GymMember.findOne({ where: { id, gymId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!m || m.status === 'removed') {
    if (token) throw fail('GYM_CHECKIN_TOKEN_INVALID');
    throw E.notFound('Member');
  }
  return { m, method };
}

const attendancePayload = (r) => ({ attendanceId: r.id, gymId: r.gymId, memberId: r.memberId, method: r.method, localDate: r.localDate });

/**
 * The shared check-in core (desk and entrance) on a locked member: the facts, the entry decision (a
 * repeat the same Dhaka day is recorded, never refused again), the attendance row and its event.
 * `block` throws 409 GYM_ENTRY_BLOCKED (built by `blocked`) unless `override` (the owner, with a
 * reason) lets the member in; the entrance has no override and words it as the gym's message.
 */
async function checkInCore(transaction, { gymId, m, method, now, today, policy, byUser, actor, override = null, blocked }) {
  if (m.status === 'left') throw fail('GYM_MEMBER_STATE', { reason: 'left' });
  const f = await facts(m, today, { transaction });
  const first = await GymAttendance.findOne({ where: { memberId: m.id, localDate: today, counted: true }, transaction });
  const d = rules.entryDecision({ current: f.current, hadMembership: f.hadMembership, overdue: f.overdue, visits: f.visits, policy });
  let decision = d.decision;
  let overrideReason = null;
  if (!first && decision === 'block') {
    if (!override) throw blocked(d);
    if (!override.reason) throw E.validation([{ field: 'reason', message: 'Say why you let this member in' }]);
    decision = 'override';
    overrideReason = override.reason;
  } else if (decision === 'block') decision = first.decision;
  const row = await GymAttendance.create({ gymId, memberId: m.id, localDate: today, checkedInAt: now, method, counted: !first, decision, reasons: d.reasons, overrideReason, byUser }, { transaction });
  if (!first) await c.publish(transaction, 'gym_attendance.recorded', 'gym_attendance', row.id, attendancePayload(row), actor);
  return { row, first, f, reasons: d.reasons, decision, overrideReason };
}

/**
 * POST /manage/gyms/:gymId/checkins { memberId | token, override?, reason? } (attendance.mark, feature
 * attendance; works while restricted). 201 with the desk card when counted; 200 with counted: false and
 * the first time for a repeat the same Dhaka day.
 */
async function checkIn(principal, gymId, input, req) {
  const a = await c.gymAccess(principal, gymId, 'attendance.mark', { feature: 'attendance' });
  const now = new Date();
  const today = c.today(now);
  const policy = await policyOf(gymId);
  return sequelize.transaction(async (transaction) => {
    const { m, method } = await memberFor(gymId, input, transaction);
    const { row, first, f, reasons, decision, overrideReason } = await checkInCore(transaction, {
      gymId,
      m,
      method,
      now,
      today,
      policy,
      byUser: principal.id,
      actor: a.actor,
      override: input.override && a.owner ? { reason: input.reason ?? null } : null,
      blocked: (d) => fail('GYM_ENTRY_BLOCKED', { reasons: d.reasons, canOverride: a.owner }, `Entry refused: ${d.reasons.join(', ')}`),
    });
    if (decision === 'override') {
      await c.record({ action: 'gym_attendance.override', actor: a.actor, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, after: { attendanceId: row.id, reasons }, reason: overrideReason, meta: { gymId }, req }, transaction);
    }
    visits.feedAfterCommit(transaction, { gymId, kind: 'in', member: m, attendanceId: row.id, at: c.iso(now), decision: decision === 'override' ? 'allow' : decision, reasons, counted: !first });
    const body = await card(a, m, f, today, {
      policy,
      decision: { reasons, decision: decision === 'override' ? 'allow' : decision },
      extra: { attendanceId: row.id, counted: !first, checkedInAt: c.iso(now), method, override: decision === 'override', firstCheckInToday: first ? c.iso(first.checkedInAt) : null },
    });
    return { status: first ? 200 : 201, body: c.shown(a, body) };
  });
}

// ---------------------------------------------------------------- the entrance QR (M24-FR-51)

/** GET /manage/gyms/:gymId/entrance-token (attendance.mark, feature attendance; no-store): the tablet's current token. */
async function entranceToken(principal, gymId) {
  const a = await c.gymAccess(principal, gymId, 'attendance.mark', { feature: 'attendance' });
  await c.requireSetup(gymId);
  return { gymId, gymName: a.gym.name, ...c.entranceTokenOf(gymId) };
}

/**
 * POST /me/gym-checkins { token } (gate join_gym): a linked member scans the entrance QR. An unreadable,
 * foreign or old code → 422 GYM_CHECKIN_TOKEN_INVALID; not a linked member of that gym → 403
 * GYM_NOT_A_MEMBER; the gym's plan without check-ins → 403 GYM_TIER_REQUIRED; `block` → 409
 * GYM_ENTRY_BLOCKED with the gym's message (no override). 201 counted, 200 a repeat the same day.
 */
async function memberCheckIn(principal, { token }, req) {
  const now = new Date();
  const parsed = c.parseEntranceToken(token, now);
  const gym = parsed ? await gymFacade.get(parsed.gymId) : null;
  if (!gym) throw fail('GYM_CHECKIN_TOKEN_INVALID');
  const linked = await GymMember.findOne({ where: { gymId: gym.id, userId: principal.id, status: { [Op.ne]: 'removed' } }, attributes: ['id'] });
  if (!linked) throw fail('GYM_NOT_A_MEMBER');
  c.requireFeature(await c.subscriptionOf(gym.ownerId), 'attendance');
  const today = c.today(now);
  const policy = await policyOf(gym.id);
  return sequelize.transaction(async (transaction) => {
    const m = await GymMember.findByPk(linked.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (m.userId !== principal.id || m.status === 'removed') throw fail('GYM_NOT_A_MEMBER');
    // M27-FR-41: a second scan after the minimum visit checks out.
    const out = await visits.scanOut(transaction, { gym, m, now, principal, req });
    if (out) return { status: 200, body: out };
    const { row, first, f, reasons, decision } = await checkInCore(transaction, {
      gymId: gym.id,
      m,
      method: 'entrance_qr',
      now,
      today,
      policy,
      byUser: principal.id,
      actor: principal,
      blocked: (d) => fail('GYM_ENTRY_BLOCKED', { reasons: d.reasons, canOverride: false, gym: { id: gym.id, name: gym.name } }, `${gym.name}: please see the front desk.`),
    });
    visits.feedAfterCommit(transaction, { gymId: gym.id, kind: 'in', member: m, attendanceId: row.id, at: c.iso(now), decision: decision === 'warn' ? 'warn' : 'allow', reasons, counted: !first });
    await c.record({ action: 'gym_attendance.entrance', actor: principal, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, after: { attendanceId: row.id, counted: !first, decision }, meta: { gymId: gym.id }, req }, transaction);
    const cur = f.current;
    return {
      status: first ? 200 : 201,
      body: {
        attendanceId: row.id,
        counted: !first,
        checkedOut: false,
        checkedInAt: c.iso(now),
        firstCheckInToday: first ? c.iso(first.checkedInAt) : null,
        method: 'entrance_qr',
        gym: { id: gym.id, name: gym.name, slug: gym.slug },
        member: { id: m.id, memberCode: m.memberCode },
        membership: cur ? { title: cur.title, endsOn: cur.endsOn, daysLeft: rules.daysLeft({ startsOn: cur.startsOn, endsOn: cur.endsOn, today }), status: cur.status } : null,
        decision: decision === 'warn' ? 'warn' : 'allow',
        reasons,
      },
    };
  });
}

/** GET /manage/gyms/:gymId/checkins?date (attendance.mark): the day's check-ins, newest first. */
async function day(principal, gymId, { date } = {}) {
  const a = await c.gymAccess(principal, gymId, 'attendance.mark');
  const d = date ?? c.today();
  const rows = await GymAttendance.findAll({ where: { gymId, localDate: d }, order: [['checkedInAt', 'DESC']], limit: 1000 });
  const members = new Map((await GymMember.findAll({ where: { id: [...new Set(rows.map((r) => r.memberId))] } })).map((m) => [m.id, m]));
  const names = await directory.displayNames(rows.map((r) => r.byUser).filter(Boolean));
  const exits = await visits.exitsOf(rows.map((r) => r.id));
  return c.shown(a, {
    date: d,
    counted: rows.filter((r) => r.counted).length,
    inGymNow: await visits.inGymNow(gymId),
    items: rows.map((r) => ({
      id: r.id,
      member: view.memberSummary(members.get(r.memberId)),
      checkedInAt: c.iso(r.checkedInAt),
      method: r.method,
      counted: r.counted,
      decision: r.decision,
      reasons: r.reasons,
      by: r.byUser ? { id: r.byUser, displayName: names.get(r.byUser) ?? null } : null,
      checkedOutAt: exits.get(r.id)?.checkedOutAt ?? null,
      visitMinutes: exits.get(r.id)?.visitMinutes ?? null,
    })),
  });
}

/**
 * gym_pass.redeemed (M24-FR-52): a linked, non-removed member of that gym admitted on an M20 pass gets a
 * check-in with method `pass` (counted when it is their first that Dhaka day). A visitor gets nothing.
 * Idempotent: one row per pass redemption (partial unique index).
 */
async function onPassRedeemed(payload, { transaction }) {
  if (!payload.redemptionId) return null;
  const m = await GymMember.findOne({ where: { gymId: payload.gymId, userId: payload.holderId, status: { [Op.ne]: 'removed' } }, transaction, lock: transaction.LOCK.UPDATE });
  if (!m) return null;
  if (await GymAttendance.findOne({ where: { passRedemptionId: payload.redemptionId }, attributes: ['id'], transaction })) return null;
  const now = new Date();
  const localDate = payload.redeemedOn ?? c.today(now);
  const first = await GymAttendance.findOne({ where: { memberId: m.id, localDate, counted: true }, attributes: ['id'], transaction });
  const row = await GymAttendance.create({ gymId: payload.gymId, memberId: m.id, localDate, checkedInAt: now, method: 'pass', counted: !first, decision: 'allow', reasons: [], passRedemptionId: payload.redemptionId }, { transaction });
  if (!first) await c.publish(transaction, 'gym_attendance.recorded', 'gym_attendance', row.id, attendancePayload(row));
  return row.id;
}

module.exports = { facts, card, search, checkInCore, checkIn, entranceToken, memberCheckIn, day, onPassRedeemed };
