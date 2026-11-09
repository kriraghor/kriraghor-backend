'use strict';

/**
 * M24 reminders and notices (§5.7, §6.9, §10): the scheduled member reminders, the owner's morning
 * summary and monthly report, and the owner's reminders page.
 *  - gym-manage.reminders (09:00 Dhaka): renewal_due (each of gym_manage.renewal_remind_days before the end, no
 *    upcoming membership), ends_today, expired (the day after the end, in-app only, not renewed) and
 *    overdue (each gym_manage.overdue_remind_days after due_on, still unpaid or partial), for gyms whose
 *    owner has the `reminders` feature, is not restricted and has the kind on (FR-55).
 *  - Once only (FR-56): the gym_reminders key (kind, subject, offset) is inserted first; only the
 *    insert that wins publishes. A member nobody can reach (no account, no email) is logged as skipped.
 *  - gym-manage.morning-summary (every 15 minutes): at or after gym_manage.morning_summary_time, once a
 *    day per gym; nothing is sent when all four numbers are 0 (FR-60).
 *  - gym-manage.monthly-report (the 1st, 08:00): the month before, per gym, for the `reports` feature (FR-72).
 *  - Prompt 3b: with the SMS add-on, the kinds the gym chose for SMS also go by SMS while units are left.
 *  - GET …/reminders (owner): the kinds and offsets, the SMS add-on and the kinds chosen for it, members
 *    reachable only by SMS, and the log of the
 *    last gym_manage.reminder_log_days (kind, date, channel, member code, status; no text, no phone) (FR-59, FR-61).
 */
const { Op, QueryTypes } = require('sequelize');
const { sequelize, GymManageSettings, GymMember, GymMembership, GymDue, GymReminder, GymPaymentLink } = require('../../models');
const gymFacade = require('../gym').gyms;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');
const notices = require('./notices.service');

const MEMBER_KINDS = ['renewal_due', 'ends_today', 'expired', 'overdue'];
/** The kinds a gym may send by SMS with the add-on (prompt 3b, M24-FR-97). */
const SMS_KINDS = ['renewal_due', 'ends_today', 'overdue', 'receipt', 'pay_link'];

/** The reminders page's SMS line: the add-on's state and balance (no prices; the billing page has them). */
async function smsCard(ownerId) {
  const v = await require('./sms.service').view(ownerId);
  return { available: v.available, active: v.status === 'active', balance: v.balance };
}
const KINDS = ['renewal_due', 'ends_today', 'overdue', 'expired', 'receipt', 'pay_link', 'morning', 'monthly'];

/**
 * The gyms whose owner may send `feature` notices now: the gym, its settings row, the owner's plan.
 * → Map gymId → { gym, settings, off: Set }.
 */
async function eligibleGyms(feature) {
  const rows = await GymManageSettings.findAll();
  const out = new Map();
  const plans = new Map();
  for (const s of rows) {
    const gym = await gymFacade.get(s.gymId);
    if (!gym) continue;
    if (!plans.has(gym.ownerId)) plans.set(gym.ownerId, await c.subscriptionOf(gym.ownerId));
    const sub = plans.get(gym.ownerId);
    if (sub.status === 'restricted' || !rules.hasFeature(sub.chosenTier, feature, c.tierCfg().featureMinTiers)) continue;
    out.set(s.gymId, { gym, settings: s, off: new Set(s.remindersOff ?? []) });
  }
  return out;
}

/** The open, payable link of a due (for the reminder's pay link), if any. */
async function payableLinkId(dueIds, now, transaction) {
  if (!dueIds.length) return null;
  const l = await GymPaymentLink.findOne({ where: { dueId: dueIds, status: 'open', expiresAt: { [Op.gt]: now } }, attributes: ['id'], order: [['createdAt', 'DESC']], transaction });
  return l?.id ?? null;
}

/**
 * Claim one reminder and publish its event when this run won the key; a member nobody can reach is
 * logged as skipped (no_contact). Prompt 3b: when the SMS add-on allows the kind, the units are held and
 * the event carries sms.billingRef, which also makes a phone-only member reachable. Returns true when
 * published.
 */
async function sendOnce({ kind, gym, member, subjectType, subjectId, offsetKey, event }) {
  return sequelize.transaction(async (transaction) => {
    const plan = await notices.smsPlan(transaction, { kind, gym });
    const reach = Boolean(member.userId || member.emailEnc || plan.ok);
    const reminderId = await c.claimReminderId(transaction, {
      ownerId: gym.ownerId,
      gymId: gym.id,
      kind,
      subjectType,
      subjectId,
      offsetKey,
      memberId: member.id,
      channels: reach ? notices.reachOf(member, plan.ok).filter((ch) => kind !== 'expired' || ch !== 'email') : [],
      status: reach ? 'published' : 'skipped',
      skipReason: reach ? null : 'no_contact',
    });
    if (!reminderId || !reach) return false;
    const payload = await event.payload(transaction);
    if ('sms' in payload) payload.sms = await notices.holdSms(transaction, { plan, gym, reminderId });
    await c.publish(transaction, event.name, event.aggregateType, subjectId, payload);
    return true;
  });
}

/** gym-manage.reminders: the 09:00 member reminders (§6.9). Run twice the same day → nothing new (FR-56). */
async function run(now = new Date()) {
  const today = c.today(now);
  const cfg = c.cfg();
  const gyms = await eligibleGyms('reminders');
  const out = { renewal_due: 0, ends_today: 0, expired: 0, overdue: 0 };
  if (!gyms.size) return out;
  const gymIds = [...gyms.keys()];

  // Memberships ending in one of renewal_remind_days, ending today, or ended yesterday.
  const mss = await GymMembership.findAll({
    where: {
      gymId: gymIds,
      [Op.or]: [
        { status: ['active', 'frozen'], endsOn: [...cfg.renewalRemindDays.map((d) => rules.addDays(today, d)), today] },
        { status: 'expired', endsOn: rules.addDays(today, -1) },
      ],
    },
  });
  for (const ms of mss) {
    const g = gyms.get(ms.gymId);
    const member = await GymMember.findByPk(ms.memberId);
    if (!member || ['left', 'removed'].includes(member.status)) continue;
    const kinds = ms.status === 'expired' ? ['expired'] : ['renewal_due', 'ends_today'];
    for (const kind of kinds) {
      if (g.off.has(kind)) continue;
      const offsetKey = rules.reminderKey(kind, { today, endsOn: ms.endsOn, renewalDays: cfg.renewalRemindDays });
      if (!offsetKey) continue;
      // Renewed already (an upcoming membership, or a running one after the expired one): nothing to remind.
      const renewed = await GymMembership.findOne({ where: { memberId: ms.memberId, id: { [Op.ne]: ms.id }, status: kind === 'expired' ? ['upcoming', 'active', 'frozen'] : ['upcoming'] }, attributes: ['id'] });
      if (renewed) continue;
      const name = { renewal_due: 'gym_membership.renewal_reminded', ends_today: 'gym_membership.end_reminded', expired: 'gym_membership.expiry_reminded' }[kind];
      const base = { membershipId: ms.id, memberId: ms.memberId, gymId: ms.gymId, endsOn: ms.endsOn };
      const sent = await sendOnce({
        kind,
        gym: g.gym,
        member,
        subjectType: 'membership',
        subjectId: ms.id,
        offsetKey,
        event: {
          name,
          aggregateType: 'gym_membership',
          payload: async (transaction) => {
            if (kind === 'expired') return base;
            if (kind === 'ends_today') return { ...base, sms: null };
            const open = await GymDue.findAll({ where: { memberId: ms.memberId, status: ['unpaid', 'partial'] }, transaction });
            const outstanding = open.reduce((s, d) => s + rules.dueState({ amount: d.amountPoisha, paid: d.paidPoisha, waived: d.waivedPoisha }).outstanding, 0);
            return { ...base, outstanding, linkId: await payableLinkId(open.map((d) => d.id), now, transaction), sms: null };
          },
        },
      });
      if (sent) out[kind] += 1;
    }
  }

  // Dues overdue by one of overdue_remind_days.
  const dueDates = cfg.overdueRemindDays.map((d) => rules.addDays(today, -d));
  const overdue = await GymDue.findAll({ where: { gymId: gymIds, status: ['unpaid', 'partial'], dueOn: dueDates } });
  for (const d of overdue) {
    const g = gyms.get(d.gymId);
    if (g.off.has('overdue')) continue;
    const member = await GymMember.findByPk(d.memberId);
    if (!member || member.status === 'removed') continue;
    const offsetKey = rules.reminderKey('overdue', { today, dueOn: d.dueOn, overdueDays: cfg.overdueRemindDays });
    if (!offsetKey) continue;
    const sent = await sendOnce({
      kind: 'overdue',
      gym: g.gym,
      member,
      subjectType: 'due',
      subjectId: d.id,
      offsetKey,
      event: {
        name: 'gym_due.overdue_reminded',
        aggregateType: 'gym_due',
        payload: async (transaction) => ({
          dueId: d.id,
          memberId: d.memberId,
          gymId: d.gymId,
          outstanding: rules.dueState({ amount: d.amountPoisha, paid: d.paidPoisha, waived: d.waivedPoisha }).outstanding,
          dueOn: d.dueOn,
          daysOverdue: rules.daysBetween(d.dueOn, today),
          linkId: await payableLinkId([d.id], now, transaction),
          sms: null,
        }),
      },
    });
    if (sent) out.overdue += 1;
  }
  return out;
}

// ---------------------------------------------------------------- owner notices

/** The four numbers of a gym's morning (FR-60), from the dashboard queries. */
async function morningCounts(gymId, today, absentDays) {
  const [row] = await sequelize.query(
    `SELECT
       (SELECT COUNT(*) FROM gym_memberships ms WHERE ms.gym_id = :gymId AND ms.status IN ('active', 'frozen') AND ms.ends_on = :today
           AND NOT EXISTS (SELECT 1 FROM gym_memberships up WHERE up.member_id = ms.member_id AND up.status = 'upcoming'))::int AS "expiringToday",
       (SELECT COUNT(*) FROM gym_dues WHERE gym_id = :gymId AND status IN ('unpaid', 'partial') AND due_on < :today)::int AS "overdue",
       (SELECT COUNT(*) FROM gym_members m WHERE m.gym_id = :gymId AND m.status = 'active'
           AND EXISTS (SELECT 1 FROM gym_memberships cm WHERE cm.member_id = m.id AND cm.status = 'active' AND cm.starts_on <= :seenSince)
           AND NOT EXISTS (SELECT 1 FROM gym_attendance a WHERE a.member_id = m.id AND a.counted AND a.local_date > :seenSince))::int AS "notSeen",
       (SELECT COUNT(*) FROM gym_link_requests WHERE gym_id = :gymId AND status = 'pending' AND direction = 'join_request')::int AS "requestsWaiting"`,
    { replacements: { gymId, today, seenSince: rules.addDays(today, -absentDays) }, type: QueryTypes.SELECT }
  );
  return row;
}

/** gym-manage.morning-summary (every 15 min): once a day per gym at or after the summary time (FR-60). */
async function morningSummary(now = new Date()) {
  const cfg = c.cfg();
  if (!rules.timeReached({ now, time: cfg.morningSummaryTime })) return { sent: 0, skipped: 0 };
  const today = c.today(now);
  const gyms = await eligibleGyms('reminders');
  const out = { sent: 0, skipped: 0 };
  for (const { gym, settings, off } of gyms.values()) {
    if (off.has('morning')) continue;
    const counts = await morningCounts(gym.id, today, settings.absentAlertDays ?? cfg.absentAlertDays);
    const nothing = !counts.expiringToday && !counts.overdue && !counts.notSeen && !counts.requestsWaiting;
    const sent = await sequelize.transaction(async (transaction) => {
      const won = await c.claimReminder(transaction, { ownerId: gym.ownerId, gymId: gym.id, kind: 'morning', subjectType: 'gym', subjectId: gym.id, offsetKey: today, channels: nothing ? [] : ['in_app', 'push'], status: nothing ? 'skipped' : 'published', skipReason: nothing ? 'nothing' : null });
      if (!won) return null;
      if (!nothing) await c.publish(transaction, 'gym_owner.summary_prepared', 'gym', gym.id, { gymId: gym.id, ownerId: gym.ownerId, localDate: today, ...counts });
      return !nothing;
    });
    if (sent === true) out.sent += 1;
    if (sent === false) out.skipped += 1;
  }
  return out;
}

/** The month's figures of a gym for the monthly report (FR-72). */
async function monthFigures(gymId, { start, end }) {
  const [row] = await sequelize.query(
    `SELECT
       (SELECT COALESCE(SUM(amount_poisha), 0) FROM gym_fee_payments WHERE gym_id = :gymId AND paid_on BETWEEN :start AND :end AND method <> 'opening')::bigint AS collected,
       (SELECT COALESCE(SUM(GREATEST(amount_poisha - paid_poisha - waived_poisha, 0)), 0) FROM gym_dues WHERE gym_id = :gymId AND status IN ('unpaid', 'partial'))::bigint AS outstanding,
       (SELECT COUNT(*) FROM gym_members WHERE gym_id = :gymId AND status <> 'removed' AND joined_on BETWEEN :start AND :end)::int AS "newMembers",
       (SELECT COUNT(*) FROM gym_members WHERE gym_id = :gymId AND status = 'left' AND left_on BETWEEN :start AND :end)::int AS "left"`,
    { replacements: { gymId, start, end }, type: QueryTypes.SELECT }
  );
  return { collected: Number(row.collected), outstanding: Number(row.outstanding), newMembers: row.newMembers, left: row.left };
}

/** gym-manage.monthly-report (the 1st, 08:00): the month before, once per gym (FR-72). */
async function monthlyReport(now = new Date()) {
  const period = rules.previousMonth(c.today(now));
  const gyms = await eligibleGyms('reports');
  let sent = 0;
  for (const { gym, off } of gyms.values()) {
    if (off.has('monthly')) continue;
    const figures = await monthFigures(gym.id, period);
    const won = await sequelize.transaction(async (transaction) => {
      if (!(await c.claimReminder(transaction, { ownerId: gym.ownerId, gymId: gym.id, kind: 'monthly', subjectType: 'gym', subjectId: gym.id, offsetKey: period.month, channels: ['in_app', 'email'] }))) return false;
      await c.publish(transaction, 'gym_owner.report_prepared', 'gym', gym.id, { gymId: gym.id, ownerId: gym.ownerId, month: period.month, ...figures });
      return true;
    });
    if (won) sent += 1;
  }
  return { sent, month: period.month };
}

// ---------------------------------------------------------------- the reminders page (owner, FR-59, FR-61)

/** GET /manage/gyms/:gymId/reminders (owner). */
async function page(principal, gymId) {
  const a = await c.gymAccess(principal, gymId, 'owner.only');
  const cfg = c.cfg();
  const sub = await c.subscriptionOf(a.gym.ownerId);
  const map = c.tierCfg().featureMinTiers;
  const s = await c.settingsOf(gymId);
  const since = new Date(Date.now() - cfg.reminderLogDays * 86400000);
  const [reach] = await sequelize.query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('active', 'frozen'))::int AS "activeMembers",
            COUNT(*) FILTER (WHERE status IN ('active', 'frozen') AND user_id IS NULL AND email_enc IS NULL)::int AS "smsOnly"
       FROM gym_members WHERE gym_id = :gymId`,
    { replacements: { gymId }, type: QueryTypes.SELECT }
  );
  const rows = await GymReminder.findAll({ where: { gymId, createdAt: { [Op.gte]: since } }, order: [['createdAt', 'DESC']], limit: 500 });
  const codes = new Map((await GymMember.findAll({ where: { id: [...new Set(rows.map((r) => r.memberId).filter(Boolean))] }, attributes: ['id', 'memberCode'] })).map((m) => [m.id, m.memberCode]));
  return {
    gymId,
    feature: { reminders: rules.hasFeature(sub.chosenTier, 'reminders', map), minTier: rules.minTierOf(map, 'reminders') },
    restricted: sub.status === 'restricted',
    kinds: KINDS.map((kind) => ({ kind, on: !(s?.remindersOff ?? []).includes(kind), member: MEMBER_KINDS.includes(kind) || ['receipt', 'pay_link'].includes(kind) })),
    offsets: { renewalRemindDays: cfg.renewalRemindDays, overdueRemindDays: cfg.overdueRemindDays, morningSummaryTime: cfg.morningSummaryTime },
    sms: { ...(await smsCard(a.gym.ownerId)), kinds: s?.smsKinds ?? [], choosable: SMS_KINDS },
    reachability: { activeMembers: reach.activeMembers, smsOnly: reach.smsOnly },
    log: {
      days: cfg.reminderLogDays,
      items: rows.map((r) => ({ id: r.id, kind: r.kind, date: rules.dhakaDate(r.createdAt), createdAt: c.iso(r.createdAt), offsetKey: r.offsetKey, channels: r.channels ?? [], memberCode: r.memberId ? codes.get(r.memberId) ?? null : null, status: r.status, skipReason: r.skipReason ?? null })),
    },
  };
}

module.exports = { KINDS, MEMBER_KINDS, SMS_KINDS, eligibleGyms, run, morningCounts, morningSummary, monthFigures, monthlyReport, page };
