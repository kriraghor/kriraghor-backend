'use strict';

/**
 * M24 reports (§5.9): a gym's members, money and attendance for a period (FR-71, feature `reports`,
 * reports.view), the not-seen list (members.view, FR-53), the owner's CSV exports (FR-73) and the
 * owner's all-gyms page (FR-74). Every number comes from gym-manage's own tables; the pass sales of the
 * M20 gyms are M19's gym dashboard (GET /me/dashboard?role=gym_owner), linked from the all-gyms page.
 *  - Exports (owner only): members (with the full phone: it is the gym's own record), payments and
 *    check-ins; UTF-8 with a BOM, taka with two decimals (common/csv); at most
 *    analytics.export_sync_max_rows rows and analytics.exports_per_hour per person (the M19 guard);
 *    audited gym_manage.exported. Health notes are never exported.
 */
const { QueryTypes } = require('sequelize');
const { csv, withBom, taka, dhakaTime } = require('../../common/csv');
const { sequelize } = require('../../models');
const directory = require('../users').directory;
const gymFacade = require('../gym').gyms;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');

const select = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

/** The numbers of one or several gyms for a period (FR-71). */
async function figures(gymIds, { from, to }, today, absentDays) {
  const r = { gymIds, from, to, today };
  const [members] = await select(
    `SELECT
       (SELECT COUNT(DISTINCT member_id) FROM gym_memberships WHERE gym_id IN (:gymIds) AND status NOT IN ('cancelled') AND starts_on <= :from AND ends_on >= :from)::int AS "activeAtStart",
       (SELECT COUNT(DISTINCT member_id) FROM gym_memberships WHERE gym_id IN (:gymIds) AND status NOT IN ('cancelled') AND starts_on <= :to AND ends_on >= :to)::int AS "activeAtEnd",
       (SELECT COUNT(*) FROM gym_members WHERE gym_id IN (:gymIds) AND status <> 'removed' AND joined_on BETWEEN :from AND :to)::int AS "new",
       (SELECT COUNT(*) FROM gym_memberships WHERE gym_id IN (:gymIds) AND origin = 'renewal' AND status <> 'cancelled' AND starts_on BETWEEN :from AND :to)::int AS renewals,
       (SELECT COUNT(*) FROM gym_members WHERE gym_id IN (:gymIds) AND status IN ('active', 'frozen'))::int AS "activeNow"`,
    r
  );
  const left = await select("SELECT left_reason AS reason, COUNT(*)::int AS n FROM gym_members WHERE gym_id IN (:gymIds) AND status = 'left' AND left_on BETWEEN :from AND :to GROUP BY left_reason", r);
  const leftTotal = left.reduce((s, x) => s + x.n, 0);
  const byMethod = await select("SELECT method, COALESCE(SUM(amount_poisha), 0)::bigint AS amount FROM gym_fee_payments WHERE gym_id IN (:gymIds) AND paid_on BETWEEN :from AND :to AND method <> 'opening' GROUP BY method", r);
  const [open] = await select(
    `SELECT COALESCE(SUM(GREATEST(amount_poisha - paid_poisha - waived_poisha, 0)), 0)::bigint AS outstanding,
            COALESCE(SUM(GREATEST(amount_poisha - paid_poisha - waived_poisha, 0)) FILTER (WHERE due_on < :today), 0)::bigint AS overdue
       FROM gym_dues WHERE gym_id IN (:gymIds) AND status IN ('unpaid', 'partial')`,
    r
  );
  const byPackage = await select(
    `SELECT ms.title, ms.package_kind AS kind, COALESCE(SUM(p.amount_poisha), 0)::bigint AS amount
       FROM gym_fee_payments p JOIN gym_dues d ON d.id = p.due_id JOIN gym_memberships ms ON ms.id = d.membership_id
      WHERE p.gym_id IN (:gymIds) AND p.paid_on BETWEEN :from AND :to AND p.method <> 'opening'
      GROUP BY ms.title, ms.package_kind ORDER BY 3 DESC`,
    r
  );
  const months = await select(
    `SELECT to_char(paid_on, 'YYYY-MM') AS month, COALESCE(SUM(amount_poisha), 0)::bigint AS amount FROM gym_fee_payments
      WHERE gym_id IN (:gymIds) AND paid_on >= :since AND paid_on <= :to AND method <> 'opening' GROUP BY 1 ORDER BY 1`,
    { ...r, since: rules.addMonths(to, -5) }
  );
  const daily = await select('SELECT local_date AS date, COUNT(*)::int AS visits FROM gym_attendance WHERE gym_id IN (:gymIds) AND counted AND local_date BETWEEN :from AND :to GROUP BY 1 ORDER BY 1', r);
  // Dashboards (M24-FR-155): collected per day, the average visit length and how members checked in.
  const paidDaily = await select("SELECT paid_on::text AS date, COALESCE(SUM(amount_poisha), 0)::bigint AS \"collectedPoisha\" FROM gym_fee_payments WHERE gym_id IN (:gymIds) AND paid_on BETWEEN :from AND :to AND method <> 'opening' GROUP BY 1", r);
  const [stay] = await select(
    `SELECT ROUND(AVG(x.visit_minutes))::int AS minutes FROM gym_attendance a JOIN gym_attendance_exits x ON x.attendance_id = a.id
      WHERE a.gym_id IN (:gymIds) AND a.counted AND a.local_date BETWEEN :from AND :to AND x.visit_minutes IS NOT NULL`,
    r
  );
  const checkinMethods = await select('SELECT method, COUNT(*)::int AS n FROM gym_attendance WHERE gym_id IN (:gymIds) AND counted AND local_date BETWEEN :from AND :to GROUP BY 1', r);
  const hours = await select(
    "SELECT EXTRACT(HOUR FROM checked_in_at AT TIME ZONE 'Asia/Dhaka')::int AS hour, COUNT(*)::int AS visits FROM gym_attendance WHERE gym_id IN (:gymIds) AND counted AND local_date BETWEEN :from AND :to GROUP BY 1 ORDER BY 2 DESC, 1 ASC",
    r
  );
  const [seen] = await select(
    `SELECT COUNT(*)::int AS n FROM gym_members m WHERE m.gym_id IN (:gymIds) AND m.status = 'active'
        AND EXISTS (SELECT 1 FROM gym_memberships cm WHERE cm.member_id = m.id AND cm.status = 'active' AND cm.starts_on <= :seenSince)
        AND NOT EXISTS (SELECT 1 FROM gym_attendance a WHERE a.member_id = m.id AND a.counted AND a.local_date > :seenSince)`,
    { ...r, seenSince: rules.addDays(today, -absentDays) }
  );
  const visits = daily.reduce((s, d) => s + d.visits, 0);
  const methods = Object.fromEntries(byMethod.map((m) => [m.method, Number(m.amount)]));
  const collected = byMethod.reduce((s, m) => s + Number(m.amount), 0);
  const series = [];
  for (let i = 5; i >= 0; i -= 1) {
    const m = rules.monthOf(rules.addMonths(to, -i));
    series.push({ month: m, collectedPoisha: Number(months.find((x) => x.month === m)?.amount ?? 0) });
  }
  return {
    members: {
      activeAtStart: members.activeAtStart,
      activeAtEnd: members.activeAtEnd,
      activeNow: members.activeNow,
      new: members.new,
      renewals: members.renewals,
      left: { total: leftTotal, byReason: Object.fromEntries(left.map((x) => [x.reason, x.n])) },
      churn: rules.churn({ left: leftTotal, activeAtStart: members.activeAtStart }),
    },
    money: {
      collectedPoisha: collected,
      onlinePoisha: methods.online ?? 0,
      counterPoisha: collected - (methods.online ?? 0),
      byMethod: methods,
      outstandingPoisha: Number(open.outstanding),
      overduePoisha: Number(open.overdue),
      byPackage: byPackage.map((p) => ({ title: p.title, packageKind: p.kind, collectedPoisha: Number(p.amount) })),
      monthOverMonth: series,
      daily: rules.fillDays(from, to < today ? to : today, paidDaily, ['collectedPoisha']),
    },
    attendance: {
      visits,
      daily: daily.map((d) => ({ date: d.date, visits: d.visits })),
      averageVisitMinutes: stay?.minutes ?? null,
      byMethod: Object.fromEntries(checkinMethods.map((m) => [m.method, m.n])),
      busiestHours: hours.slice(0, 24).map((h) => ({ hour: h.hour, visits: h.visits })),
      averagePerActive: members.activeAtEnd > 0 ? Math.round((visits * 100) / members.activeAtEnd) / 100 : null,
      notSeen: seen.n,
      notSeenDays: absentDays,
    },
  };
}

/**
 * The figures of the period before, for the change on each tile (M24-FR-154): only the ones that
 * belong to a period (counts and money in it); point-in-time figures (active now, outstanding, not
 * seen) have no previous value.
 */
async function previousOf(gymIds, period, today, absentDays) {
  const prev = rules.previousPeriod(period, today);
  const f = await figures(gymIds, prev, today, absentDays);
  return {
    period: prev,
    members: { activeAtEnd: f.members.activeAtEnd, new: f.members.new, renewals: f.members.renewals, left: f.members.left.total, churn: f.members.churn },
    money: { collectedPoisha: f.money.collectedPoisha, onlinePoisha: f.money.onlinePoisha, counterPoisha: f.money.counterPoisha },
    attendance: { visits: f.attendance.visits, averagePerActive: f.attendance.averagePerActive, averageVisitMinutes: f.attendance.averageVisitMinutes },
  };
}

const periodOf = (query, today) => rules.reportPeriod({ month: query.month ?? null, from: query.from ?? null, to: query.to ?? null, today });

/** GET /manage/gyms/:gymId/reports?month | from&to (reports.view, feature reports). */
async function gymReport(principal, gymId, query = {}) {
  const a = await c.gymAccess(principal, gymId, 'reports.view', { feature: 'reports' });
  const today = c.today();
  const period = periodOf(query, today);
  const s = await c.settingsOf(gymId);
  const absent = s?.absentAlertDays ?? c.cfg().absentAlertDays;
  const f = await figures([gymId], period, today, absent);
  const previous = await previousOf([gymId], period, today, absent);
  const overdue = await select(
    `SELECT m.id AS "memberId", m.member_code AS "memberCode", m.display_name AS "displayName", d.id AS "dueId", d.due_on AS "dueOn",
            GREATEST(d.amount_poisha - d.paid_poisha - d.waived_poisha, 0)::bigint AS outstanding
       FROM gym_dues d JOIN gym_members m ON m.id = d.member_id
      WHERE d.gym_id = :gymId AND d.status IN ('unpaid', 'partial') AND d.due_on < :today ORDER BY d.due_on ASC LIMIT 50`,
    { gymId, today }
  );
  return c.shown(a, { gymId, period, previous, ...f, money: { ...f.money, overdueList: overdue.map((o) => ({ memberId: o.memberId, memberCode: o.memberCode, displayName: o.displayName, dueId: o.dueId, dueOn: o.dueOn, outstandingPoisha: Number(o.outstanding) })) } });
}

/** GET /manage/gyms/:gymId/reports/absent (members.view): members not seen for the gym's absent days (FR-53). */
async function absent(principal, gymId, { days: asked } = {}) {
  const a = await c.gymAccess(principal, gymId, 'members.view');
  const today = c.today();
  const s = await c.settingsOf(gymId);
  // M27-FR-31: 7, 14, 30 or any number of days; the gym's setting when none is asked.
  const days = asked ?? s?.absentAlertDays ?? c.cfg().absentAlertDays;
  const since = rules.addDays(today, -days);
  const rows = await select(
    `SELECT m.id, m.member_code AS "memberCode", m.display_name AS "displayName", m.phone_last4 AS "phoneLast4", cm.ends_on AS "endsOn",
            (SELECT MAX(a.local_date) FROM gym_attendance a WHERE a.member_id = m.id AND a.counted) AS "lastCheckInOn"
       FROM gym_members m JOIN gym_memberships cm ON cm.member_id = m.id AND cm.status = 'active'
      WHERE m.gym_id = :gymId AND m.status = 'active' AND cm.starts_on <= :since
        AND NOT EXISTS (SELECT 1 FROM gym_attendance a WHERE a.member_id = m.id AND a.counted AND a.local_date > :since)
      ORDER BY "lastCheckInOn" ASC NULLS FIRST, m.display_name ASC LIMIT 500`,
    { gymId, since }
  );
  return c.shown(a, { gymId, days, items: rows.map((r) => ({ ...r, daysSince: r.lastCheckInOn ? rules.daysBetween(r.lastCheckInOn, today) : null })) });
}

// ---------------------------------------------------------------- exports (owner, FR-73)

const EXPORTS = {
  members: {
    head: ['Member code', 'Name', 'Phone', 'Gender', 'Status', 'Source', 'Joined on', 'Linked account', 'Package', 'Ends on', 'Outstanding (৳)'],
    rows: async (gymId) => {
      const rows = await select(
        `SELECT m.member_code, m.display_name, m.phone_enc, m.gender, m.status, m.source, m.joined_on, m.user_id IS NOT NULL AS linked, cur.title, cur.ends_on,
                COALESCE((SELECT SUM(GREATEST(d.amount_poisha - d.paid_poisha - d.waived_poisha, 0)) FROM gym_dues d WHERE d.member_id = m.id AND d.status IN ('unpaid', 'partial')), 0)::bigint AS outstanding
           FROM gym_members m LEFT JOIN LATERAL (SELECT ms.title, ms.ends_on FROM gym_memberships ms WHERE ms.member_id = m.id AND ms.status IN ('active', 'frozen') LIMIT 1) cur ON true
          WHERE m.gym_id = :gymId AND m.status <> 'removed' ORDER BY m.member_code`,
        { gymId }
      );
      return rows.map((r) => [r.member_code, r.display_name, c.dec(r.phone_enc), r.gender ?? '', r.status, r.source, r.joined_on, r.linked ? 'yes' : 'no', r.title ?? '', r.ends_on ?? '', taka(r.outstanding)]);
    },
  },
  payments: {
    head: ['Paid on', 'Receipt', 'Member code', 'Name', 'Amount (৳)', 'Method', 'Reverses receipt', 'Reason', 'Received by', 'Provider charge (৳)'],
    rows: async (gymId, { from, to }) => {
      const rows = await select(
        `SELECT p.paid_on, p.receipt_no, m.member_code, m.display_name, p.amount_poisha, p.method, o.receipt_no AS reverses, p.reason, p.received_by, p.provider_charge_poisha
           FROM gym_fee_payments p JOIN gym_members m ON m.id = p.member_id LEFT JOIN gym_fee_payments o ON o.id = p.reverses_id
          WHERE p.gym_id = :gymId AND p.paid_on BETWEEN :from AND :to ORDER BY p.paid_on, p.created_at`,
        { gymId, from, to }
      );
      const names = await directory.displayNames([...new Set(rows.map((r) => r.received_by).filter(Boolean))]);
      return rows.map((r) => [r.paid_on, r.receipt_no ?? '', r.member_code, r.display_name, taka(r.amount_poisha), r.method, r.reverses ?? '', r.reason ?? '', r.received_by ? names.get(r.received_by) ?? '' : '', r.provider_charge_poisha === null ? '' : taka(r.provider_charge_poisha)]);
    },
  },
  attendance: {
    head: ['Date', 'Time', 'Member code', 'Name', 'Method', 'Counted'],
    rows: async (gymId, { from, to }) => {
      const rows = await select(
        `SELECT a.local_date, a.checked_in_at, m.member_code, m.display_name, a.method, a.counted
           FROM gym_attendance a JOIN gym_members m ON m.id = a.member_id WHERE a.gym_id = :gymId AND a.local_date BETWEEN :from AND :to ORDER BY a.checked_in_at`,
        { gymId, from, to }
      );
      return rows.map((r) => [r.local_date, dhakaTime(r.checked_in_at), r.member_code, r.display_name, r.method, r.counted ? 'yes' : 'no']);
    },
  },
};

/** GET /manage/gyms/:gymId/reports/export?dataset&month|from&to (owner, feature reports) → { filename, body }. */
async function exportCsv(principal, gymId, query, req) {
  const a = await c.gymAccess(principal, gymId, 'owner.only', { feature: 'reports' });
  const period = periodOf(query, c.today());
  const def = EXPORTS[query.dataset];
  const rows = await def.rows(gymId, period);
  const guard = require('../analytics').exportsGuard;
  guard.checkSize(rows.length);
  await guard.take(principal.id);
  await c.record({ action: 'gym_manage.exported', actor: a.actor, entityType: 'gym', entityId: gymId, meta: { dataset: query.dataset, rows: rows.length, from: period.from, to: period.to }, req });
  const s = await c.settingsOf(gymId);
  return { filename: `${(s?.shortCode ?? 'gym').toLowerCase()}-${query.dataset}-${period.from}-${period.to}.csv`, body: withBom(csv([def.head, ...rows])) };
}

// ---------------------------------------------------------------- all gyms (owner, FR-74)

/** GET /manage/reports?month | from&to (gate run_gym, owner of a gym, feature reports; per-gym rows with multi_gym). */
async function allGyms(principal, query = {}) {
  const gyms = await gymFacade.ofOwner(principal.id);
  if (!gyms.length) throw c.fail('GYM_TIER_REQUIRED', { feature: 'reports', minTier: rules.minTierOf(c.tierCfg().featureMinTiers, 'reports') });
  const sub = await c.subscriptionOf(principal.id);
  c.requireFeature(sub, 'reports');
  const today = c.today();
  const period = periodOf(query, today);
  const absentDays = c.cfg().absentAlertDays;
  const totals = await figures(gyms.map((g) => g.id), period, today, absentDays);
  const previous = await previousOf(gyms.map((g) => g.id), period, today, absentDays);
  const multi = rules.hasFeature(sub.chosenTier, 'multi_gym', c.tierCfg().featureMinTiers);
  const perGym = multi ? await Promise.all(gyms.map(async (g) => ({ gym: { id: g.id, name: g.name, slug: g.slug }, ...(await figures([g.id], period, today, absentDays)) }))) : null;
  const roleActive = (await directory.roleStatus(principal.id, 'gym_owner')) === 'active';
  return { period, previous, gyms: gyms.map((g) => ({ id: g.id, name: g.name, slug: g.slug })), totals, multiGym: multi, perGym, passSales: { available: roleActive, dashboard: '/me/dashboard?role=gym_owner' } };
}

module.exports = { figures, gymReport, absent, EXPORTS, exportCsv, allGyms };
