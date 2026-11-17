'use strict';

/**
 * M27 round 2: visits (check-in to check-out), on top of M24's append-only check-ins.
 *  - A visit is a gym_attendance row; its check-out is a gym_attendance_exits row (append-only, one per visit).
 *  - Open visits: rows of the last gym_manage.visit_auto_close_hours with no exit (M27-FR-40).
 *  - A second entrance scan at least gym_manage.min_visit_minutes after the open visit checks out
 *    (method entrance_qr); a scan before that is the usual repeat (M27-FR-41).
 *  - The desk checks a member out (attendance.mark; M27-FR-40); the job closes visits left open longer than
 *    the window (method auto, no length; M27-FR-42).
 *  - "In the gym now": members with an open visit (M27-FR-43).
 *  - The live desk feed (M27-FR-44): each check-in and check-out goes, after commit, to the Socket.IO rooms
 *    user:{id} of the gym's owner and of staff with attendance.mark (best effort; screens re-read on connect).
 */
const { Op, QueryTypes } = require('sequelize');
const { E } = require('../../common/errors');
const realtime = require('../../common/realtime');
const settings = require('../settings').settings;
const { sequelize, GymMember, GymAttendance, GymAttendanceExit } = require('../../models');
const gymFacade = require('../gym').gyms;
const staffFacade = require('../business-members').members;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');
const view = require('./gym-manage.serializer');

const cfg = () => ({ minVisitMinutes: settings.get('gym_manage.min_visit_minutes'), autoCloseHours: settings.get('gym_manage.visit_auto_close_hours') });
const HOUR = 3600000;

/** Open visits of a member at a gym (newest first), within the auto-close window. */
async function openVisits(gymId, memberId, now, { transaction } = {}) {
  const since = new Date(now.getTime() - cfg().autoCloseHours * HOUR);
  const rows = await GymAttendance.findAll({ where: { gymId, memberId, checkedInAt: { [Op.gte]: since } }, order: [['checkedInAt', 'DESC']], transaction });
  if (!rows.length) return [];
  const closed = new Set((await GymAttendanceExit.findAll({ where: { attendanceId: rows.map((r) => r.id) }, attributes: ['attendanceId'], transaction })).map((x) => x.attendanceId));
  return rows.filter((r) => !closed.has(r.id));
}

/** Members with an open visit right now (M27-FR-43). */
async function inGymNow(gymId, now = new Date(), { transaction } = {}) {
  const [row] = await sequelize.query(
    `SELECT COUNT(DISTINCT a.member_id)::int AS n FROM gym_attendance a
      WHERE a.gym_id = :gymId AND a.checked_in_at >= :since
        AND NOT EXISTS (SELECT 1 FROM gym_attendance_exits x WHERE x.attendance_id = a.id)`,
    { replacements: { gymId, since: new Date(now.getTime() - cfg().autoCloseHours * HOUR) }, type: QueryTypes.SELECT, transaction }
  );
  return row.n;
}

/** Close these open visits (M27-FR-40, FR-41): one exit per visit; the newest visit's length is returned and published. */
async function exitIn(transaction, { gymId, member, visits, method, now, byUser = null, actor = null }) {
  let latest = null;
  for (const v of visits) {
    const minutes = method === 'auto' ? null : rules.visitMinutes(v.checkedInAt, now);
    const x = await GymAttendanceExit.create({ gymId, memberId: member.id, attendanceId: v.id, checkedOutAt: now, method, visitMinutes: minutes, byUser }, { transaction });
    if (!latest) latest = { exit: x, visit: v };
  }
  if (latest) {
    await c.publish(
      transaction,
      'gym_attendance.exited',
      'gym_attendance',
      latest.visit.id,
      { attendanceId: latest.visit.id, gymId, memberId: member.id, method, visitMinutes: latest.exit.visitMinutes ?? null, localDate: latest.visit.localDate },
      actor
    );
  }
  return latest ? { attendanceId: latest.visit.id, checkedOutAt: c.iso(now), visitMinutes: latest.exit.visitMinutes ?? null, method } : null;
}

/**
 * The live desk feed (M27-FR-44): after commit, to the owner and staff with attendance.mark. Never throws.
 * `kind` in | out | guest; the member as the desk list shows it (code, name, photo), or for a trial-visit guest
 * `guest` { visitId, name } (member null, sent as `gym.desk_guest`); the decision and the count now.
 */
function feedAfterCommit(transaction, { gymId, kind, member = null, guest = null, attendanceId = null, at, decision = null, reasons = [], counted = null, visitMinutes = null }) {
  const send = async () => {
    try {
      const gym = await gymFacade.get(gymId);
      if (!gym) return;
      const to = new Set([gym.ownerId, ...(await staffFacade.staffRecipients('gym', gymId, 'attendance.mark'))]);
      const data = { gymId, kind, attendanceId, at, member: member ? view.memberSummary(member) : null, guest, decision, reasons, counted, visitMinutes, inGymNow: await inGymNow(gymId) };
      // A guest goes on its own event, so desks built before trial visits (which expect a member) never see one.
      const event = kind === 'guest' ? 'gym.desk_guest' : 'gym.desk_feed';
      for (const userId of to) realtime.toUser(userId, event, data);
      // Devices in desk mode at this gym (M24 §21) are in the gym's desk room, not in a person's room.
      realtime.toRoom(`gym_desk:${gymId}`, event, data);
    } catch {
      /* best effort: the desk re-reads the day's list */
    }
  };
  if (transaction) transaction.afterCommit(() => void send());
  else void send();
}

/**
 * POST /manage/gyms/:gymId/checkins/:attendanceId/out (attendance.mark, feature attendance; works while
 * restricted): the desk checks the member out of that visit (and any other open visit of theirs). 409
 * GYM_VISIT_CLOSED when it already has an exit or is older than the auto-close window.
 */
async function checkOut(principal, gymId, attendanceId, req) {
  const a = await c.gymAccess(principal, gymId, 'attendance.mark', { feature: 'attendance' });
  const now = new Date();
  return sequelize.transaction(async (transaction) => {
    const row = await GymAttendance.findOne({ where: { id: attendanceId, gymId }, transaction });
    if (!row) throw E.notFound('Check-in');
    const m = await GymMember.findByPk(row.memberId, { transaction, lock: transaction.LOCK.UPDATE });
    const open = await openVisits(gymId, m.id, now, { transaction });
    if (!open.some((v) => v.id === row.id)) throw c.fail('GYM_VISIT_CLOSED');
    const out = await exitIn(transaction, { gymId, member: m, visits: open, method: 'desk', now, byUser: principal.id, actor: a.actor });
    await c.record({ action: 'gym_attendance.checked_out', actor: a.actor, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, after: out, meta: { gymId }, req }, transaction);
    feedAfterCommit(transaction, { gymId, kind: 'out', member: m, attendanceId: out.attendanceId, at: out.checkedOutAt, visitMinutes: out.visitMinutes });
    return { ...out, member: view.memberSummary(m) };
  });
}

/**
 * The entrance scan of a member with an open visit (M27-FR-41), inside memberCheckIn's transaction:
 * at least min_visit_minutes after the open visit → check-out (returns the body); sooner → null (a repeat).
 */
async function scanOut(transaction, { gym, m, now, principal, req }) {
  const open = await openVisits(gym.id, m.id, now, { transaction });
  if (!open.length || rules.visitMinutes(open[0].checkedInAt, now) < cfg().minVisitMinutes) return null;
  const out = await exitIn(transaction, { gymId: gym.id, member: m, visits: open, method: 'entrance_qr', now, byUser: principal.id, actor: principal });
  await c.record({ action: 'gym_attendance.checked_out', actor: principal, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, after: out, meta: { gymId: gym.id }, req }, transaction);
  feedAfterCommit(transaction, { gymId: gym.id, kind: 'out', member: m, attendanceId: out.attendanceId, at: out.checkedOutAt, visitMinutes: out.visitMinutes });
  return {
    checkedOut: true,
    attendanceId: out.attendanceId,
    checkedOutAt: out.checkedOutAt,
    visitMinutes: out.visitMinutes,
    gym: { id: gym.id, name: gym.name, slug: gym.slug },
    member: { id: m.id, memberCode: m.memberCode },
  };
}

/** Job gym-manage.visits-close (every 30 min, M27-FR-42): visits open longer than the window close (method auto). */
async function closeStale(now = new Date()) {
  const before = new Date(now.getTime() - cfg().autoCloseHours * HOUR);
  const rows = await sequelize.query(
    `SELECT a.id, a.gym_id AS "gymId", a.member_id AS "memberId" FROM gym_attendance a
      WHERE a.checked_in_at < :before AND a.checked_in_at >= :floor
        AND NOT EXISTS (SELECT 1 FROM gym_attendance_exits x WHERE x.attendance_id = a.id)
      ORDER BY a.checked_in_at LIMIT 2000`,
    { replacements: { before, floor: new Date(before.getTime() - 48 * HOUR) }, type: QueryTypes.SELECT }
  );
  let closed = 0;
  for (const r of rows) {
    await sequelize.transaction(async (transaction) => {
      const x = await GymAttendanceExit.findOne({ where: { attendanceId: r.id }, transaction });
      if (x) return;
      await GymAttendanceExit.create({ gymId: r.gymId, memberId: r.memberId, attendanceId: r.id, checkedOutAt: now, method: 'auto', visitMinutes: null }, { transaction });
      closed += 1;
    });
  }
  return { closed };
}

/** Exits of these visits, for the day list and history: Map attendanceId → { checkedOutAt, visitMinutes, method }. */
async function exitsOf(attendanceIds) {
  if (!attendanceIds.length) return new Map();
  const rows = await GymAttendanceExit.findAll({ where: { attendanceId: attendanceIds } });
  return new Map(rows.map((x) => [x.attendanceId, { checkedOutAt: c.iso(x.checkedOutAt), visitMinutes: x.visitMinutes ?? null, method: x.method }]));
}

module.exports = { openVisits, inGymNow, exitIn, feedAfterCommit, checkOut, scanOut, closeStale, exitsOf };
