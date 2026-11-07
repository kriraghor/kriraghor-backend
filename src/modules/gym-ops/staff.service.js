'use strict';

/**
 * M27 staff attendance (M27-FR-72..75; plan feature `staff_attendance`, Standard): weekly shifts per staff
 * member, clocking in and out (the staff member's phone scans the gym's entrance QR, or the owner or
 * shifts.manage clock someone at the desk), open clock-ins closed by a job, the day's board and the month's
 * report (hours, late and missed shifts). gym_staff_times is append-only: corrections are new rows.
 * Staff identity is the business_members row (it outlives a change of permissions and keeps history after
 * someone leaves).
 */
const { Op } = require('sequelize');
const { sequelize, GymStaffShift, GymStaffTime } = require('../../models');
const directory = require('../users').directory;
const staffFacade = require('../business-members');
const gymFacade = require('../gym').gyms;
const rules = require('./gym-ops.rules');
const c = require('./gym-ops.common');

const FEATURE = 'staff_attendance';
const MANAGE = ['shifts.manage'];
const READ = ['shifts.manage', 'reports.view'];

const lockStaff = (transaction, businessMemberId) => sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `gym_staff_clock:${businessMemberId}` }, transaction });

/** The gym's staff (active first, then those who left) with display names → [{ id, userId, name, status, permissions }]. */
async function staffOf(gymId) {
  const rows = await staffFacade.members.staffOf('gym', gymId);
  const names = await directory.displayNames([...new Set(rows.map((r) => r.memberId))]);
  return rows.map((r) => ({ id: r.businessMemberId, userId: r.memberId, name: names.get(r.memberId) ?? null, status: r.status === 'active' ? 'active' : 'left', permissions: r.permissions }));
}

async function staffMember(gymId, businessMemberId) {
  const s = (await staffOf(gymId)).find((x) => x.id === businessMemberId);
  if (!s) throw c.fail('GYM_STAFF_UNKNOWN');
  return s;
}

const shiftView = (x) => ({ id: x.id, dow: x.dow, startTime: x.startTime, endTime: x.endTime });
const timeView = (x, names = new Map()) => ({ id: x.id, kind: x.kind, at: c.iso(x.at), localDate: x.localDate, method: x.method, by: x.byUser ? { id: x.byUser, displayName: names.get(x.byUser) ?? null } : null, note: x.note ?? null });

// ---------------------------------------------------------------- shifts

/** GET …/staff-shifts (shifts.manage or reports.view): the weekly shifts of every active staff member (M27-FR-72). */
async function shifts(principal, gymId) {
  await c.access(principal, gymId, null, { feature: FEATURE, anyOf: READ });
  const staff = (await staffOf(gymId)).filter((s) => s.status === 'active');
  const rows = await GymStaffShift.findAll({ where: { gymId, status: 'active' }, order: [['dow', 'ASC'], ['startTime', 'ASC']] });
  return { items: staff.map((s) => ({ staff: { id: s.id, userId: s.userId, name: s.name }, shifts: rows.filter((r) => r.businessMemberId === s.id).map(shiftView) })) };
}

/** PUT …/staff/:staffId/shifts (shifts.manage): replace a staff member's weekly shifts (M27-FR-72). */
async function setShifts(principal, gymId, staffId, { shifts: wanted }, req) {
  const a = await c.access(principal, gymId, MANAGE[0], { feature: FEATURE, restricted: true });
  const s = await staffMember(gymId, staffId);
  if (s.status !== 'active') throw c.fail('GYM_STAFF_UNKNOWN');
  const cfg = c.cfg();
  if (wanted.length > cfg.shiftsPerStaffMax) throw c.fail('GYM_SHIFT_LIMIT', { max: cfg.shiftsPerStaffMax });
  for (const x of wanted) if (rules.shiftBlock(x)) throw c.fail('GYM_SHIFT_TIMES');
  const key = (x) => `${x.dow}-${x.startTime}`;
  if (new Set(wanted.map(key)).size !== wanted.length) throw c.fail('GYM_SHIFT_TIMES');
  await sequelize.transaction(async (transaction) => {
    await GymStaffShift.update({ status: 'retired' }, { where: { gymId, businessMemberId: staffId, status: 'active' }, transaction });
    for (const x of wanted) await GymStaffShift.create({ gymId, businessMemberId: staffId, dow: x.dow, startTime: x.startTime, endTime: x.endTime, createdBy: principal.id }, { transaction });
    await c.record({ action: 'gym_staff.shifts_set', actor: a.actor, entityType: 'business_member', entityId: staffId, after: { shifts: wanted.length }, meta: { gymId }, req }, transaction);
  });
  const rows = await GymStaffShift.findAll({ where: { gymId, businessMemberId: staffId, status: 'active' }, order: [['dow', 'ASC'], ['startTime', 'ASC']] });
  return { staff: { id: s.id, userId: s.userId, name: s.name }, shifts: rows.map(shiftView) };
}

// ---------------------------------------------------------------- clocking

async function lastClock(businessMemberId, transaction) {
  return GymStaffTime.findOne({ where: { businessMemberId }, order: [['at', 'DESC'], ['createdAt', 'DESC']], transaction });
}

/** Records the next clock of a staff member (in after out, out after in) under a per-person lock. */
async function clockIn(transaction, { gymId, staff, method, by, actor, note = null, expect = null, req = null }) {
  await lockStaff(transaction, staff.id);
  const last = await lastClock(staff.id, transaction);
  const kind = rules.nextClockKind(last);
  if (expect && expect !== kind) throw c.fail(expect === 'in' ? 'GYM_STAFF_ALREADY_IN' : 'GYM_STAFF_NOT_IN');
  const now = new Date();
  const row = await GymStaffTime.create({ gymId, businessMemberId: staff.id, userId: staff.userId, kind, at: now, localDate: c.today(now), method, byUser: by, note }, { transaction });
  await c.publish(transaction, 'gym_staff_time.recorded', 'gym_staff_time', row.id, { gymId, staffId: staff.id, kind, method }, actor);
  await c.record({ action: `gym_staff.clocked_${kind}`, actor, entityType: 'business_member', entityId: staff.id, after: { method }, meta: { gymId }, req }, transaction);
  const minutes = kind === 'out' && last ? Math.max(0, Math.floor((now - new Date(last.at)) / 60000)) : null;
  return { kind, at: c.iso(now), method, minutes };
}

/**
 * POST /me/gym-staff-clock { token } (M27-FR-73): a staff member with clock.in scans the gym's entrance
 * QR on their phone; it clocks them in, or out when they are in. The owner is not staff.
 */
async function clockByScan(principal, { token }, req) {
  const parsed = c.ops.parseEntranceToken(token);
  const gym = parsed ? await gymFacade.get(parsed.gymId) : null;
  if (!gym) throw c.fail('GYM_CLOCK_TOKEN_INVALID');
  const workplace = staffFacade.access.workplaceAt(principal, 'gym', gym.id);
  if (!workplace) throw c.fail('GYM_NOT_STAFF');
  const a = await c.access(principal, gym.id, 'clock.in', { feature: FEATURE });
  if (a.owner) throw c.fail('GYM_NOT_STAFF');
  const staff = await staffMember(gym.id, workplace.id);
  const done = await sequelize.transaction((transaction) => clockIn(transaction, { gymId: gym.id, staff, method: 'entrance_qr', by: principal.id, actor: a.actor, req }));
  return { ...done, gym: { id: gym.id, name: gym.name } };
}

/** POST …/staff-times { staffId, kind, note } (shifts.manage): clock someone in or out at the desk (M27-FR-73). */
async function clockAtDesk(principal, gymId, { staffId, kind, note }, req) {
  const a = await c.access(principal, gymId, MANAGE[0], { feature: FEATURE, restricted: true });
  const staff = await staffMember(gymId, staffId);
  if (staff.status !== 'active') throw c.fail('GYM_STAFF_UNKNOWN');
  return sequelize.transaction((transaction) => clockIn(transaction, { gymId, staff, method: 'desk', by: principal.id, actor: a.actor, note: note ?? null, expect: kind, req }));
}

/** GET …/staff-clock/me (clock.in): my state at this gym today, for the clock page. */
async function myClock(principal, gymId) {
  const a = await c.access(principal, gymId, 'clock.in', { feature: FEATURE });
  if (a.owner) throw c.fail('GYM_NOT_STAFF');
  const workplace = staffFacade.access.workplaceAt(principal, 'gym', gymId);
  if (!workplace) throw c.fail('GYM_NOT_STAFF');
  const today = c.today();
  const [last, rows, mine] = await Promise.all([
    lastClock(workplace.id),
    GymStaffTime.findAll({ where: { businessMemberId: workplace.id, localDate: { [Op.gte]: rules.periodRange(today.slice(0, 7)).from } }, order: [['at', 'ASC']] }),
    GymStaffShift.findAll({ where: { businessMemberId: workplace.id, status: 'active', dow: rules.dowOf(today) }, order: [['startTime', 'ASC']] }),
  ]);
  return {
    gym: { id: a.gym.id, name: a.gym.name },
    clockedIn: last?.kind === 'in',
    since: last?.kind === 'in' ? c.iso(last.at) : null,
    todayShifts: mine.map(shiftView),
    monthMinutes: rules.workedMinutes(rules.clockIntervals(rows)),
    today: rows.filter((r) => r.localDate === today).map((r) => timeView(r)),
  };
}

// ---------------------------------------------------------------- the board and the report

/** GET …/staff-attendance?date= (shifts.manage or reports.view): who is in, each one's shifts and clocks of the day (M27-FR-75). */
async function board(principal, gymId, { date } = {}) {
  await c.access(principal, gymId, null, { feature: FEATURE, anyOf: READ });
  const day = date ?? c.today();
  const staff = (await staffOf(gymId)).filter((s) => s.status === 'active');
  const ids = staff.map((s) => s.id);
  const [rows, shiftRows, lasts] = await Promise.all([
    GymStaffTime.findAll({ where: { gymId, localDate: day }, order: [['at', 'ASC']] }),
    GymStaffShift.findAll({ where: { gymId, status: 'active', dow: rules.dowOf(day) }, order: [['startTime', 'ASC']] }),
    Promise.all(ids.map((id) => lastClock(id))),
  ]);
  const names = await directory.displayNames([...new Set(rows.map((r) => r.byUser).filter(Boolean))]);
  const cfg = c.cfg();
  const items = staff.map((s, i) => {
    const mine = rows.filter((r) => r.businessMemberId === s.id);
    const shiftsOf = shiftRows.filter((r) => r.businessMemberId === s.id);
    const marks = rules.shiftMarks({ shifts: shiftsOf, times: mine, from: day, to: day, today: addDayAfter(day), graceMinutes: cfg.staffLateGraceMinutes });
    return {
      staff: { id: s.id, userId: s.userId, name: s.name },
      clockedIn: lasts[i]?.kind === 'in',
      since: lasts[i]?.kind === 'in' ? c.iso(lasts[i].at) : null,
      shifts: shiftsOf.map(shiftView),
      times: mine.map((r) => timeView(r, names)),
      minutes: rules.workedMinutes(rules.clockIntervals(mine)),
      late: marks.late > 0,
    };
  });
  return { date: day, inNow: items.filter((x) => x.clockedIn).length, items };
}
const addDayAfter = (day) => rules.addDays(day, 1);

/** Per staff member over a month: worked minutes, days with a clock-in, late and missed shifts. */
async function monthFacts(gymId, period, { today = c.today() } = {}) {
  const { from, to } = rules.periodRange(period);
  const [rows, shiftRows] = await Promise.all([
    GymStaffTime.findAll({ where: { gymId, localDate: { [Op.between]: [from, to] } }, order: [['at', 'ASC']] }),
    GymStaffShift.findAll({ where: { gymId, status: 'active' } }),
  ]);
  const grace = c.cfg().staffLateGraceMinutes;
  const by = new Map();
  for (const id of new Set([...rows.map((r) => r.businessMemberId), ...shiftRows.map((r) => r.businessMemberId)])) {
    const mine = rows.filter((r) => r.businessMemberId === id);
    const marks = rules.shiftMarks({ shifts: shiftRows.filter((r) => r.businessMemberId === id), times: mine, from, to, today, graceMinutes: grace });
    by.set(id, { workedMinutes: rules.workedMinutes(rules.clockIntervals(mine)), days: new Set(mine.filter((r) => r.kind === 'in').map((r) => r.localDate)).size, late: marks.late, missed: marks.missed });
  }
  return by;
}

/** GET …/staff-report?period=YYYY-MM (shifts.manage or reports.view): the month per staff member (M27-FR-75). */
async function report(principal, gymId, { period }) {
  await c.access(principal, gymId, null, { feature: FEATURE, anyOf: READ });
  const today = c.today();
  const p = period ?? today.slice(0, 7);
  if (rules.periodBlock(p, today)) throw c.fail('GYM_PAYROLL_PERIOD');
  const [staff, facts] = await Promise.all([staffOf(gymId), monthFacts(gymId, p, { today })]);
  const empty = { workedMinutes: 0, days: 0, late: 0, missed: 0 };
  const items = staff.filter((s) => s.status === 'active' || facts.has(s.id)).map((s) => ({ staff: { id: s.id, userId: s.userId, name: s.name, status: s.status }, ...(facts.get(s.id) ?? empty) }));
  return { period: p, items };
}

/** GET …/staff-times?staffId&from&to (shifts.manage or reports.view): one person's clock rows. */
async function times(principal, gymId, { staffId, from, to }) {
  await c.access(principal, gymId, null, { feature: FEATURE, anyOf: READ });
  await staffMember(gymId, staffId);
  const rows = await GymStaffTime.findAll({ where: { gymId, businessMemberId: staffId, localDate: { [Op.between]: [from, to] } }, order: [['at', 'ASC']], limit: 500 });
  const names = await directory.displayNames([...new Set(rows.map((r) => r.byUser).filter(Boolean))]);
  return { items: rows.map((r) => timeView(r, names)) };
}

/** The gym-ops.staff-clockout job (M27-FR-73): clock-ins open longer than the window are closed, method auto. */
async function autoClockOut(now = new Date()) {
  const hours = c.cfg().staffAutoClockoutHours;
  const cutoff = new Date(now.getTime() - hours * 3600000);
  const [open] = await sequelize.query(
    `SELECT DISTINCT ON (business_member_id) id, gym_id AS "gymId", business_member_id AS "staffId", user_id AS "userId", kind, at
       FROM gym_staff_times ORDER BY business_member_id, at DESC, created_at DESC`
  );
  let closed = 0;
  for (const r of open) {
    if (r.kind !== 'in' || new Date(r.at) > cutoff) continue;
    await sequelize.transaction(async (transaction) => {
      await lockStaff(transaction, r.staffId);
      const last = await lastClock(r.staffId, transaction);
      if (last?.kind !== 'in' || last.id !== r.id) return;
      await GymStaffTime.create({ gymId: r.gymId, businessMemberId: r.staffId, userId: r.userId, kind: 'out', at: now, localDate: c.today(now), method: 'auto', byUser: null, note: null }, { transaction });
      await c.publish(transaction, 'gym_staff_time.recorded', 'gym_staff_time', r.staffId, { gymId: r.gymId, staffId: r.staffId, kind: 'out', method: 'auto' });
      closed += 1;
    });
  }
  return { closed };
}

module.exports = { staffOf, staffMember, shifts, setShifts, clockByScan, clockAtDesk, myClock, board, report, times, monthFacts, autoClockOut };
