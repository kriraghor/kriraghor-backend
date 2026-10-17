'use strict';

/**
 * M17 reports (§5.2, FR-15 to FR-19; Q99). Any signed-in member can report a ground, a booking they
 * are part of, a member, a review or an esports tournament (reports.per_day each). A report counts
 * toward auto-hide only when its reporter is NID-verified with an account at least
 * reports.reporter_min_account_days old. When eligible reporters of one subject reach
 * reports.autohide_threshold within reports.autohide_window_days, a review is hidden at once; every
 * other subject goes to the top of the staff queue (report.threshold_reached). Staff resolve a subject
 * with one action for all its open reports; suspensions use M01 and ground takedowns M09, in the same
 * transaction.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { nextCode } = require('../../common/sequences');
const { sequelize, Report } = require('../../models');
const settings = require('../settings/settings.service');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const authz = require('../auth/authz.service');
const directory = require('../users/directory.service');
const reviews = require('./reviews.service');
const { fail } = require('./trust.errors');
const rules = require('./trust.rules');

const DAY = 24 * 3600 * 1000;
const iso = (d) => (d ? new Date(d).toISOString() : null);
const OPEN = ['open', 'escalated'];

// ---------------------------------------------------------------- subjects

/**
 * What a report is about: { owners (who cannot report it), suspendable (the account a suspension hits),
 * summary } or null when it does not exist or the reporter may not see it.
 */
const SUBJECTS = {
  async ground(id) {
    const g = await require('../grounds/grounds.reads').ground(id);
    if (!g || g.status === 'removed') return null;
    const f = await require('../grounds/grounds.service').facts(id);
    return { owners: [g.ownerId], suspendable: g.ownerId, summary: { name: f.name, slug: f.slug, status: g.status } };
  },
  async booking(id, reporterId) {
    const b = await require('../bookings/bookings.reads').reviewSource(id);
    if (!b || (reporterId && ![b.bookerUserId, b.ownerId].includes(reporterId))) return null;
    return { owners: [], suspendable: null, summary: { code: b.code, status: b.status, start: iso(b.start), groundId: b.groundId } };
  },
  async user(id) {
    const a = (await directory.accounts([id])).get(id);
    if (!a || a.isStaff) return null;
    return { owners: [id], suspendable: id, summary: { displayName: a.displayName, status: a.status } };
  },
  async review(id) {
    const r = await reviews.get(id);
    if (!r) return null;
    return { owners: [r.authorId], suspendable: r.authorId, summary: { stars: r.stars, text: r.text, status: r.status, groundId: r.subjectId } };
  },
  async esports_tournament(id) {
    const t = await require('../esports/esports.facts').tournament(id).catch(() => null);
    if (!t) return null;
    return { owners: [], suspendable: null, summary: { slug: t.slug ?? null, title: t.titleEn ?? null, status: t.status ?? null } };
  },
};

async function subjectOf(type, id, reporterId) {
  const s = await SUBJECTS[type](id, reporterId);
  if (!s) throw fail('REPORT_SUBJECT_UNKNOWN');
  return s;
}

/** Eligible reporters of a subject inside the auto-hide window (open or escalated reports). */
const eligibleCount = (subjectType, subjectId, { transaction }) =>
  Report.count({
    where: { subjectType, subjectId, status: OPEN, eligible: true, createdAt: { [Op.gte]: new Date(Date.now() - settings.get('reports.autohide_window_days') * DAY) } },
    distinct: true,
    col: 'reporter_id',
    transaction,
  });

const publish = (transaction, name, payload, actor = null) => events.publish(transaction, { name, aggregateType: 'report_subject', aggregateId: payload.subjectId, payload, actor });

// ---------------------------------------------------------------- the reporter (FR-15, FR-16)

/** POST /reports { subjectType, subjectId, reasonCode, note? } */
async function file(principal, { subjectType, subjectId, reasonCode, note = null }, req) {
  const subject = await subjectOf(subjectType, subjectId, principal.id);
  if (subjectId === principal.id || subject.owners.includes(principal.id)) throw fail('REPORT_SELF');
  const eligible = rules.eligibleReporter({ memberActive: principal.roles?.member === 'active', accountCreatedAt: principal.user.createdAt, now: new Date(), minDays: settings.get('reports.reporter_min_account_days') });
  try {
    return await sequelize.transaction(async (transaction) => {
      const before = await eligibleCount(subjectType, subjectId, { transaction });
      const r = await Report.create({ code: await nextCode('RPT', transaction), subjectType, subjectId, subjectOwnerId: subject.suspendable ?? null, reporterId: principal.id, reasonCode, note, eligible }, { transaction });
      const after = before + (eligible ? 1 : 0);
      const threshold = settings.get('reports.autohide_threshold');
      await publish(transaction, 'report.filed', { reportId: r.id, code: r.code, subjectType, subjectId, reporterId: principal.id, reasonCode, eligible }, principal);
      if (rules.thresholdCrossed({ before, after, threshold })) {
        let hidden = false;
        if (subjectType === 'review') {
          const rv = await reviews.lockReview(subjectId, transaction);
          if (rv.status !== 'hidden') {
            await reviews.hideInTx(rv, { reason: 'reports', actor: null, transaction });
            hidden = true;
          }
        }
        await publish(transaction, 'report.threshold_reached', { subjectType, subjectId, reporters: after, hidden });
      }
      await audit.record({ action: 'report.filed', actor: principal, entityType: 'report', entityId: r.id, entityCode: r.code, after: { subjectType, reasonCode, eligible }, req }, { transaction });
      return { report: { code: r.code, status: r.status, subjectType, subjectId, createdAt: iso(r.createdAt) } };
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw fail('REPORT_DUPLICATE');
    throw err;
  }
}

/** GET /me/reports: what the member reported and how it ended (the outcome only, never who). */
async function listMine(principal) {
  const rows = await Report.findAll({ where: { reporterId: principal.id }, order: [['createdAt', 'DESC']], limit: 100 });
  return { items: rows.map((r) => ({ code: r.code, subjectType: r.subjectType, subjectId: r.subjectId, reasonCode: r.reasonCode, status: r.status, resolution: r.resolutionAction ?? null, createdAt: iso(r.createdAt), resolvedAt: iso(r.resolvedAt) })) };
}

// ---------------------------------------------------------------- the staff desk (FR-17 to FR-19)

/** GET /admin/reports?status=open|escalated: one row per subject, flagged subjects first, then the oldest. */
async function adminList(actor, { status = 'open', subjectType, limit = 50 } = {}) {
  const since = new Date(Date.now() - settings.get('reports.autohide_window_days') * DAY);
  const rows = await sequelize.query(
    `SELECT subject_type AS "subjectType", subject_id AS "subjectId", COUNT(*)::int AS "reports",
            COUNT(DISTINCT reporter_id) FILTER (WHERE eligible AND created_at >= :since)::int AS "eligible",
            MIN(created_at) AS "oldest", MAX(created_at) AS "latest", array_agg(DISTINCT reason_code) AS "reasons"
       FROM reports WHERE status = :status AND (CAST(:type AS varchar) IS NULL OR subject_type = :type)
      GROUP BY subject_type, subject_id`,
    { replacements: { status, type: subjectType ?? null, since }, type: sequelize.QueryTypes.SELECT }
  );
  const threshold = settings.get('reports.autohide_threshold');
  const slaMs = settings.get('reports.sla_hours') * 3600 * 1000;
  const sorted = rows.map((r) => ({ ...r, flagged: r.eligible >= threshold })).sort((a, b) => Number(b.flagged) - Number(a.flagged) || new Date(a.oldest) - new Date(b.oldest));
  const items = [];
  for (const r of sorted.slice(0, limit)) {
    const s = await SUBJECTS[r.subjectType](r.subjectId).catch(() => null);
    items.push({ ...r, oldest: iso(r.oldest), latest: iso(r.latest), dueAt: iso(new Date(new Date(r.oldest).getTime() + slaMs)), subject: s?.summary ?? null });
  }
  void actor;
  return { items, threshold };
}

/** GET /admin/reports/subjects/:type/:id: every report of a subject with its reporters. */
async function adminSubject(actor, subjectType, subjectId) {
  const rows = await Report.findAll({ where: { subjectType, subjectId }, order: [['createdAt', 'DESC']], limit: 200 });
  const names = await directory.publicNames(rows.map((r) => r.reporterId));
  const s = await SUBJECTS[subjectType](subjectId).catch(() => null);
  return {
    subjectType,
    subjectId,
    subject: s?.summary ?? null,
    actions: rules.RESOLUTIONS[subjectType].filter((a) => a !== 'user_suspended' || (s?.suspendable && authz.hasPermission(actor, 'manage_users'))),
    items: rows.map((r) => ({ code: r.code, reasonCode: r.reasonCode, note: r.note ?? null, eligible: r.eligible, status: r.status, resolution: r.resolutionAction ?? null, reporter: { id: r.reporterId, displayName: names.get(r.reporterId)?.displayName ?? null }, createdAt: iso(r.createdAt) })),
  };
}

async function lockOpen(subjectType, subjectId, transaction) {
  const rows = await Report.findAll({ where: { subjectType, subjectId, status: OPEN }, transaction, lock: transaction.LOCK.UPDATE });
  if (!rows.length) throw fail('NOTHING_OPEN');
  return rows;
}

/**
 * POST /admin/reports/resolve { subjectType, subjectId, action, note }: closes every open report of the
 * subject. content_removed hides a review or suspends a ground (M09; needs manage_users for grounds);
 * user_suspended suspends the account behind the subject (M01; needs manage_users).
 */
async function resolve(actor, { subjectType, subjectId, action, note }, req) {
  if (!rules.resolutionAllowed(subjectType, action)) throw fail('RESOLUTION_NOT_ALLOWED');
  const needsUsers = action === 'user_suspended' || (action === 'content_removed' && subjectType === 'ground');
  if (needsUsers && !authz.hasPermission(actor, 'manage_users')) throw E.forbidden('PERMISSION_REQUIRED', 'You do not have permission to do this', undefined, { missing: ['manage_users'] });
  return sequelize.transaction(async (transaction) => {
    const open = await lockOpen(subjectType, subjectId, transaction);
    const subject = await subjectOf(subjectType, subjectId);
    if (subjectType === 'review' && action === 'content_removed') await reviews.hideInTx(await reviews.lockReview(subjectId, transaction), { reason: 'reports', actor, transaction });
    if (subjectType === 'review' && action === 'no_violation') {
      const rv = await reviews.lockReview(subjectId, transaction);
      if (rv.status === 'hidden' && rv.hiddenReason === 'reports') await reviews.restoreInTx(rv, { actor, transaction });
    }
    if (subjectType === 'ground' && action === 'content_removed') await require('../grounds/grounds.service').staffActionInTx(actor, subjectId, 'suspend', { reason: note, transaction, req });
    if (action === 'user_suspended') await require('../admin/admin-users.service').suspendInTx(actor, subject.suspendable, { reasonCode: 'reported', note }, { transaction, req });
    const now = new Date();
    await Report.update({ status: 'resolved', resolutionAction: action, resolutionNote: note, resolvedBy: actor.id, resolvedAt: now }, { where: { id: open.map((r) => r.id) }, transaction });
    await publish(transaction, 'report.resolved', { subjectType, subjectId, subjectOwnerId: subject.suspendable ?? null, action, reports: open.length, reporterIds: [...new Set(open.map((r) => r.reporterId))] }, actor);
    await audit.record({ action: 'report.resolved', actor, entityType: 'report_subject', entityId: subjectId, after: { subjectType, action, reports: open.length }, reason: note, req }, { transaction });
    return { resolved: open.length, action };
  });
}

/** POST /admin/reports/escalate { subjectType, subjectId, note }: to the masters. */
async function escalate(actor, { subjectType, subjectId, note }, req) {
  return sequelize.transaction(async (transaction) => {
    const open = (await lockOpen(subjectType, subjectId, transaction)).filter((r) => r.status === 'open');
    if (!open.length) throw fail('NOTHING_OPEN');
    await Report.update({ status: 'escalated' }, { where: { id: open.map((r) => r.id) }, transaction });
    await publish(transaction, 'report.escalated', { subjectType, subjectId, reports: open.length }, actor);
    await audit.record({ action: 'report.escalated', actor, entityType: 'report_subject', entityId: subjectId, after: { subjectType, reports: open.length }, reason: note, req }, { transaction });
    return { escalated: open.length };
  });
}

/** POST /admin/reports/:code/dismiss { note }: one report (spam, a mistake), the others stay open. */
async function dismiss(actor, code, { note }, req) {
  return sequelize.transaction(async (transaction) => {
    const r = await Report.findOne({ where: { code }, transaction, lock: transaction.LOCK.UPDATE });
    if (!r) throw E.notFound('Report');
    if (!OPEN.includes(r.status)) throw fail('NOTHING_OPEN');
    await r.update({ status: 'dismissed', resolutionAction: 'dismissed', resolutionNote: note, resolvedBy: actor.id, resolvedAt: new Date() }, { transaction });
    await publish(transaction, 'report.dismissed', { reportId: r.id, code: r.code, subjectType: r.subjectType, subjectId: r.subjectId, reporterId: r.reporterId }, actor);
    await audit.record({ action: 'report.dismissed', actor, entityType: 'report', entityId: r.id, entityCode: r.code, reason: note, req }, { transaction });
    return { code: r.code, status: r.status };
  });
}

/** M18 reports_upheld: distinct subjects owned by this user whose reports were upheld since `since`. */
const UPHELD = ['content_removed', 'owner_warned', 'user_suspended'];
async function upheldAgainst(userId, since) {
  const rows = await Report.findAll({ where: { subjectOwnerId: userId, status: 'resolved', resolutionAction: UPHELD, resolvedAt: { [Op.gte]: since } }, attributes: ['subjectType', 'subjectId'] });
  return new Set(rows.map((r) => `${r.subjectType}:${r.subjectId}`)).size;
}

module.exports = { upheldAgainst, file, listMine, adminList, adminSubject, resolve, escalate, dismiss, SUBJECTS };
