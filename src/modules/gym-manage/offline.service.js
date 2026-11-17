'use strict';

/**
 * M24 §22 the desk through a lost connection (product owner, 11 Nov 2026; ADR-010 amendment). Replaces
 * M24-FR-54 ("no offline check-in"). Works with or without desk mode.
 *  - The desk copy (M24-FR-144): while online the desk keeps the gym's members (code, name, last 4 phone
 *    digits, the package end, today's flags and entry decision) and, with fees.collect, the open dues. It is
 *    stamped with the server time and signed; the device keeps it in memory, for that day only.
 *  - Sending (M24-FR-146 to FR-149): each item the desk took offline arrives once (client id unique per gym,
 *    Idempotency-Key). Its time is the stamp's server time plus the time that passed on the device. Nothing
 *    well-formed is refused: it is applied, applied and flagged (the server would have blocked the member;
 *    the time was adjusted or late; that day's cash drawer was closed; the PIN was only checked on the device;
 *    the person named could not be confirmed), or parked (the due was already settled or voided, or the
 *    member was removed). A cash fee gets its real receipt number when it arrives, keeps the day it was
 *    taken and names the temporary slip.
 *  - The owner's list (M24-FR-150): flagged and parked items wait for the owner or fees.adjust staff. Parked
 *    cash is applied to another due of the same member or recorded as returned; the rest are marked checked.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const crypto = require('../../common/crypto');
const { sequelize, GymMember, GymMembership, GymDue, GymAttendance, GymDeskUnlock, GymDeskOfflineItem, GymFeePayment } = require('../../models');
const directory = require('../users').directory;
const staffFacade = require('../business-members').members;
const drawer = require('../gym-ops').drawer;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');
const view = require('./gym-manage.serializer');
const dues = require('./dues.service');
const checkins = require('./checkins.service');

const { fail } = c;
const PERMISSION = Object.freeze({ checkin: 'attendance.mark', cash_fee: 'fees.collect' });

const sign = (text) => crypto.hmac(text);
const equal = (a, b) => crypto.timingSafeEqualHex(a, b);

// ---------------------------------------------------------------- the desk copy (M24-FR-144)

/**
 * GET /manage/gyms/:gymId/desk/snapshot (attendance.mark, feature attendance; no-store): the members the
 * desk can find without a connection, today's entry decision for each, and, with fees.collect, the open
 * dues. Removed and left members are not in it. Five queries whatever the gym's size, plus one per member
 * on a visit-limited package.
 */
async function snapshot(principal, gymId) {
  const a = await c.gymAccess(principal, gymId, 'attendance.mark', { feature: 'attendance' });
  const s = await c.requireSetup(gymId);
  const now = new Date();
  const today = c.today(now);
  const policy = s.entryPolicy ?? c.cfg().entryPolicyDefault;
  const members = await GymMember.findAll({ where: { gymId, status: { [Op.notIn]: ['removed', 'left'] } }, order: [['displayName', 'ASC'], ['memberCode', 'ASC']] });
  const running = await GymMembership.findAll({ where: { gymId, status: ['active', 'frozen'] } });
  const current = new Map(running.map((x) => [x.memberId, x]));
  // §6.8 "had a membership": anything but one cancelled before it started (as checkins.facts).
  const had = await GymMembership.findAll({
    where: { gymId, [Op.or]: [{ status: { [Op.notIn]: ['cancelled'] } }, { status: 'cancelled', startsOn: { [Op.lte]: today } }] },
    attributes: ['memberId'],
    group: ['memberId'],
    raw: true,
  });
  const hadSet = new Set(had.map((r) => r.memberId));
  const open = await GymDue.findAll({ where: { gymId, status: ['unpaid', 'partial'] }, order: [['dueOn', 'ASC']] });
  const overdue = new Set(open.filter((d) => rules.isOverdue({ status: d.status, dueOn: d.dueOn, today })).map((d) => d.memberId));
  const inToday = new Set((await GymAttendance.findAll({ where: { gymId, localDate: today, counted: true }, attributes: ['memberId'] })).map((r) => r.memberId));
  const visits = new Map();
  for (const m of running.filter((x) => x.visitLimit)) {
    visits.set(m.memberId, await GymAttendance.count({ where: { memberId: m.memberId, counted: true, localDate: { [Op.gte]: m.startsOn, [Op.lte]: today } } }));
  }
  const canCollect = a.can('fees.collect');
  let dueList = null;
  if (canCollect) {
    const titles = new Map((await GymMembership.findAll({ where: { id: [...new Set(open.map((d) => d.membershipId))] }, attributes: ['id', 'title'] })).map((x) => [x.id, x.title]));
    const ids = new Set(members.map((m) => m.id));
    dueList = open
      .filter((d) => ids.has(d.memberId))
      .map((d) => ({ id: d.id, memberId: d.memberId, title: titles.get(d.membershipId) ?? null, dueOn: d.dueOn, outstandingPoisha: rules.dueState({ amount: d.amountPoisha, paid: d.paidPoisha, waived: d.waivedPoisha }).outstanding }))
      .filter((d) => d.outstandingPoisha > 0);
  }
  const cfg = c.cfg();
  return c.shown(a, {
    gymId,
    date: today,
    serverTime: c.iso(now),
    stamp: rules.snapshotStamp({ gymId, ms: now.getTime() }, sign),
    refreshMinutes: cfg.deskSnapshotRefreshMinutes,
    maxHours: cfg.deskOfflineMaxHours,
    policy,
    members: members.map((member) =>
      rules.snapshotMember({ member, current: current.get(member.id) ?? null, hadMembership: hadSet.has(member.id), overdue: overdue.has(member.id), visits: visits.get(member.id) ?? 0, policy, today, inToday: inToday.has(member.id) })
    ),
    dues: dueList,
  });
}

// ---------------------------------------------------------------- sending (M24-FR-146 to FR-149)

const itemView = (x, { names = new Map(), members = new Map(), payments = new Map() } = {}) => {
  const who = (userId) => (userId ? { userId, displayName: names.get(userId) ?? null } : null);
  const m = members.get(x.memberId);
  const p = x.feePaymentId ? payments.get(x.feePaymentId) : null;
  const r = x.resolutionPaymentId ? payments.get(x.resolutionPaymentId) : null;
  return {
    id: x.id,
    clientId: x.clientId,
    kind: x.kind,
    member: m ? view.memberSummary(m) : { id: x.memberId },
    dueId: x.dueId ?? null,
    amountPoisha: x.amountPoisha ?? null,
    slipNo: x.slipNo ?? null,
    method: x.method,
    takenAt: c.iso(x.takenAt),
    takenOn: x.takenOn,
    takenBy: who(x.takenBy),
    recordedAs: who(x.recordedAs),
    sentBy: who(x.sentBy),
    sentAt: c.iso(x.sentAt),
    pinOnDevice: x.pinOnDevice,
    outcome: x.outcome,
    flags: x.flags ?? [],
    parkReason: x.parkReason ?? null,
    attendanceId: x.attendanceId ?? null,
    receipt: p ? { feePaymentId: p.id, receiptNo: p.receiptNo, url: c.receiptUrlOf(p.id) } : null,
    resolution: x.resolution ?? null,
    resolvedBy: who(x.resolvedBy),
    resolvedAt: c.iso(x.resolvedAt),
    resolutionNote: x.resolutionNote ?? null,
    resolutionReceipt: r ? { feePaymentId: r.id, receiptNo: r.receiptNo, url: c.receiptUrlOf(r.id) } : null,
  };
};

/** Views of items with the names, members and payments they show. */
async function viewsOf(items) {
  const users = [...new Set(items.flatMap((x) => [x.takenBy, x.recordedAs, x.sentBy, x.resolvedBy]).filter(Boolean))];
  const memberIds = [...new Set(items.map((x) => x.memberId))];
  const paymentIds = [...new Set(items.flatMap((x) => [x.feePaymentId, x.resolutionPaymentId]).filter(Boolean))];
  const [names, members, payments] = await Promise.all([
    directory.displayNames(users),
    memberIds.length ? GymMember.findAll({ where: { id: memberIds } }).then((rows) => new Map(rows.map((m) => [m.id, m]))) : new Map(),
    paymentIds.length ? GymFeePayment.findAll({ where: { id: paymentIds } }).then((rows) => new Map(rows.map((p) => [p.id, p]))) : new Map(),
  ]);
  return items.map((x) => itemView(x, { names, members, payments }));
}

/** Does the person the device names work at the gym with the permission this kind of item needs? */
async function eligible(gym, userId, permission) {
  if (userId === gym.ownerId) return true;
  return (await staffFacade.staffWith('gym', gym.id, [permission])).some((r) => r.memberId === userId);
}

/**
 * A check-in taken offline, applied in the caller's transaction on a locked member: counted when it is the
 * member's first that Dhaka day, at the time it was taken. When the server would block the member it is
 * recorded as a warning and flagged would_block (the member is already inside). No live feed: it is past.
 */
async function applyCheckIn(transaction, { a, m, item, takenAt, day }) {
  const policy = (await c.settingsOf(a.gym.id, { transaction }))?.entryPolicy ?? c.cfg().entryPolicyDefault;
  const f = await checkins.facts(m, day, { transaction });
  const first = await GymAttendance.findOne({ where: { memberId: m.id, localDate: day, counted: true }, transaction });
  const d = rules.entryDecision({ current: f.current, hadMembership: f.hadMembership, overdue: f.overdue, visits: f.visits, policy });
  const row = await GymAttendance.create(
    { gymId: a.gym.id, memberId: m.id, localDate: day, checkedInAt: takenAt, method: item.method, counted: !first, decision: d.decision === 'allow' ? 'allow' : 'warn', reasons: d.reasons, byUser: item.recordedAs },
    { transaction }
  );
  if (!first) await c.publish(transaction, 'gym_attendance.recorded', 'gym_attendance', row.id, { attendanceId: row.id, gymId: a.gym.id, memberId: m.id, method: row.method, localDate: day }, a.actor);
  return { attendanceId: row.id, flags: !first && d.decision === 'block' ? ['would_block'] : [] };
}

/**
 * POST /manage/gyms/:gymId/desk/offline-items [Idempotency-Key = clientId] (attendance.mark for a check-in,
 * fees.collect for a cash fee). 201 with the item as the server applied, flagged or parked it; 200 with the
 * same item when it already arrived. A stamp the server did not make for this gym, a member or due of
 * another gym, or a due of another member is malformed (422); everything else is accepted.
 */
async function send(principal, gymId, body, req) {
  const a = await c.gymAccess(principal, gymId, PERMISSION[body.kind]);
  if (req?.idempotencyKey && req.idempotencyKey !== body.clientId) throw E.validation([{ field: 'clientId', message: 'Must equal the Idempotency-Key' }]);
  const stamp = rules.parseSnapshotStamp(body.stamp, { sign, equal });
  if (!stamp || stamp.gymId !== gymId) throw fail('GYM_OFFLINE_STAMP_INVALID');
  const known = await GymDeskOfflineItem.findOne({ where: { gymId, clientId: body.clientId } });
  if (known) return { status: 200, body: c.shown(a, { item: (await viewsOf([known]))[0] }) };

  const now = new Date();
  const cfg = c.cfg();
  const time = rules.offlineTakenAt({ stampMs: stamp.ms, elapsedMs: body.elapsedMs, nowMs: now.getTime(), maxHours: cfg.deskOfflineMaxHours, skewSeconds: cfg.deskOfflineSkewSeconds });
  const day = c.today(time.at);
  const permission = PERMISSION[body.kind];
  const [isEligible, unlock] = await Promise.all([
    eligible(a.gym, body.takenBy, permission),
    body.unlockId ? GymDeskUnlock.findOne({ where: { id: body.unlockId, gymId, userId: body.takenBy }, attributes: ['id', 'deskSessionId'] }) : null,
  ]);
  const taker = rules.offlineTaker({ takenBy: body.takenBy, senderId: principal.id, eligible: isEligible, unlockMatches: Boolean(unlock), pinOnDevice: Boolean(body.pinOnDevice) });

  try {
    const item = await sequelize.transaction(async (transaction) => {
      const m = await GymMember.findOne({ where: { id: body.memberId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!m) throw fail('GYM_OFFLINE_ITEM_INVALID', { field: 'memberId' });
      const due = body.kind === 'cash_fee' ? await dues.lockDue(gymId, body.dueId, transaction) : null;
      if (body.kind === 'cash_fee' && (!due || due.memberId !== m.id)) throw fail('GYM_OFFLINE_ITEM_INVALID', { field: 'dueId' });
      const park = rules.offlinePark({ kind: body.kind, memberStatus: m.status, due, amount: body.amountPoisha ?? 0 });
      const flags = [...time.flags, ...taker.flags];
      const row = {
        gymId,
        clientId: body.clientId,
        kind: body.kind,
        memberId: m.id,
        dueId: due?.id ?? null,
        amountPoisha: body.kind === 'cash_fee' ? body.amountPoisha : null,
        slipNo: body.kind === 'cash_fee' ? body.slipNo : null,
        method: body.kind === 'checkin' ? (body.method ?? 'desk') : 'desk',
        takenAt: time.at,
        takenOn: day,
        takenBy: body.takenBy,
        recordedAs: taker.recordedAs,
        deskSessionId: principal.desk?.sessionId ?? unlock?.deskSessionId ?? null,
        unlockId: unlock?.id ?? null,
        pinOnDevice: Boolean(body.pinOnDevice),
        sentBy: principal.id,
        sentAt: now,
      };
      if (!park && body.kind === 'checkin') {
        const r = await applyCheckIn(transaction, { a, m, item: row, takenAt: time.at, day });
        row.attendanceId = r.attendanceId;
        flags.push(...r.flags);
      } else if (!park) {
        if (await drawer.closedOn(gymId, day, { transaction })) flags.push('drawer_closed');
        const r = await dues.recordIn(transaction, { gym: a.gym, member: m, due, amount: body.amountPoisha, method: 'cash', paidOn: day, note: `Offline slip ${body.slipNo}`, receivedBy: taker.recordedAs, actor: a.actor, now });
        row.feePaymentId = r.payment.id;
        await c.record(
          { action: 'gym_fee.recorded', actor: a.actor, entityType: 'gym_fee_payment', entityId: r.payment.id, entityCode: r.payment.receiptNo, after: { amount: body.amountPoisha, method: 'cash', paidOn: day, receiptNo: r.payment.receiptNo, dueId: due.id }, meta: { gymId, offline: { clientId: body.clientId, slipNo: body.slipNo } }, req },
          transaction
        );
      }
      row.flags = [...new Set(flags)];
      row.parkReason = park;
      row.outcome = rules.offlineOutcome({ park, flags: row.flags });
      const saved = await GymDeskOfflineItem.create(row, { transaction });
      await c.record(
        { action: 'gym_offline.received', actor: a.actor, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, after: { itemId: saved.id, kind: saved.kind, outcome: saved.outcome, flags: saved.flags, parkReason: park, takenAt: c.iso(time.at), takenBy: body.takenBy, slipNo: saved.slipNo }, meta: { gymId }, req },
        transaction
      );
      return saved;
    });
    return { status: 201, body: c.shown(a, { item: (await viewsOf([item]))[0] }) };
  } catch (err) {
    // The same item sent twice at once: the first one wins and the second reads it.
    if (err instanceof UniqueConstraintError) {
      const again = await GymDeskOfflineItem.findOne({ where: { gymId, clientId: body.clientId } });
      if (again) return { status: 200, body: c.shown(a, { item: (await viewsOf([again]))[0] }) };
    }
    throw err;
  }
}

// ---------------------------------------------------------------- the owner's list (M24-FR-150)

/**
 * GET /manage/gyms/:gymId/desk/offline-items?state&cursor (the owner and fees.adjust): `review` (default)
 * the flagged and parked items nobody has resolved, oldest first; `all` every item, newest first.
 */
async function list(principal, gymId, { state = 'review', cursor, limit = 50 } = {}) {
  const a = await c.gymAccess(principal, gymId, 'fees.adjust');
  const offset = cursor ? Number(cursor) : 0;
  const where = { gymId, ...(state === 'review' ? { outcome: { [Op.ne]: 'applied' }, resolution: null } : {}) };
  const [rows, toCheck] = await Promise.all([
    GymDeskOfflineItem.findAll({ where, order: [['sentAt', state === 'review' ? 'ASC' : 'DESC'], ['id', 'ASC']], offset, limit: limit + 1 }),
    GymDeskOfflineItem.count({ where: { gymId, outcome: { [Op.ne]: 'applied' }, resolution: null } }),
  ]);
  const page = rows.slice(0, limit);
  return c.shown(a, { toCheck, items: await viewsOf(page), nextCursor: rows.length > limit ? String(offset + limit) : null });
}

/**
 * POST /manage/gyms/:gymId/desk/offline-items/:itemId/resolve { action, dueId?, note? } (fees.adjust):
 * `checked` for a flagged item or a parked check-in; `apply` puts parked cash on another open due of the
 * same member (a receipt now, dated the day the cash was taken); `returned` records that the cash went back
 * (a note says how).
 */
async function resolve(principal, gymId, itemId, { action, dueId, note = null }, req) {
  const a = await c.gymAccess(principal, gymId, 'fees.adjust');
  const now = new Date();
  const saved = await sequelize.transaction(async (transaction) => {
    const item = await GymDeskOfflineItem.findOne({ where: { id: itemId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!item) throw E.notFound('Offline item');
    const block = rules.offlineResolveBlock({ item, action });
    if (block) throw fail(block, { outcome: item.outcome, resolution: item.resolution ?? null });
    if (action === 'returned' && !note) throw E.validation([{ field: 'note', message: 'Say how the cash went back' }]);
    const patch = { resolution: action === 'apply' ? 'applied_to_due' : action, resolvedBy: principal.id, resolvedAt: now, resolutionNote: note };
    if (action === 'apply') {
      if (!dueId) throw E.validation([{ field: 'dueId', message: 'Choose the due' }]);
      const due = await dues.lockDue(gymId, dueId, transaction);
      if (!due || due.memberId !== item.memberId) throw E.notFound('Due');
      const member = await GymMember.findByPk(item.memberId, { transaction });
      const r = await dues.recordIn(transaction, { gym: a.gym, member, due, amount: item.amountPoisha, method: 'cash', paidOn: item.takenOn, note: `Offline slip ${item.slipNo}`, receivedBy: item.recordedAs, actor: a.actor, now });
      patch.resolutionPaymentId = r.payment.id;
      await c.record(
        { action: 'gym_fee.recorded', actor: a.actor, entityType: 'gym_fee_payment', entityId: r.payment.id, entityCode: r.payment.receiptNo, after: { amount: item.amountPoisha, method: 'cash', paidOn: item.takenOn, receiptNo: r.payment.receiptNo, dueId: due.id }, meta: { gymId, offline: { itemId: item.id, slipNo: item.slipNo } }, req },
        transaction
      );
    }
    await item.update(patch, { transaction });
    await c.record({ action: 'gym_offline.resolved', actor: a.actor, entityType: 'gym_member', entityId: item.memberId, before: { outcome: item.outcome }, after: { itemId: item.id, resolution: patch.resolution, dueId: dueId ?? null }, reason: note, meta: { gymId }, req }, transaction);
    return item;
  });
  return c.shown(a, { item: (await viewsOf([saved]))[0] });
}

module.exports = { snapshot, send, list, resolve };
