'use strict';

/**
 * M18 flags (§5.1, §8.1, FR-01 to FR-05, FR-08). evaluateUser computes every enabled rule's metric
 * and moves the user's flags: a breach raises an open flag (one per user and rule); an open or
 * actioned flag is refreshed with the latest value (it stays until a person acts, or lapses after
 * risk.flag_lapse_days once the metric no longer breaches); a cleared flag reopens after its snooze,
 * or sooner when the metric got clearly worse. The system never acts on its own (Q101): it raises
 * flags and alerts. Each flag records the rule version and threshold it was raised under.
 */
const { Op } = require('sequelize');
const { sequelize, RiskRule, RiskFlag, RiskAction } = require('../../models');
const settings = require('../settings').settings;
const events = require('../events').events;
const metrics = require('./metrics.service');
const rules = require('./risk.rules');

const iso = (d) => (d ? new Date(d).toISOString() : null);
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

const payload = (f, extra = {}) => ({ flagId: f.id, userId: f.userId, ruleKey: f.ruleKey, severity: f.severity, ...extra });
const publish = (transaction, name, f, extra) => events.publish(transaction, { name, aggregateType: 'risk_flag', aggregateId: f.id, payload: payload(f, extra) });

const reasonFor = (rule, value, threshold) => `${rule.description} (${fmt(value)}; threshold ${fmt(threshold)})`.slice(0, 300);

/** The latest flag of a user and rule (an active one first), locked. */
async function latestFlag(userId, ruleKey, transaction) {
  return RiskFlag.findOne({ where: { userId, ruleKey }, order: [[sequelize.literal("CASE WHEN status IN ('open', 'actioned') THEN 0 ELSE 1 END"), 'ASC'], ['createdAt', 'DESC']], transaction, lock: transaction.LOCK.UPDATE });
}

/** Evaluate every enabled rule for one user (FR-04). Returns what changed. */
async function evaluateUser(userId, now = new Date()) {
  const ruleRows = await RiskRule.findAll({ where: { enabled: true }, order: [['key', 'ASC']] });
  const values = await metrics.compute(userId, ruleRows, now);
  const out = { raised: [], reopened: [], refreshed: 0, lapsed: [] };
  for (const rule of ruleRows) {
    const { value } = values[rule.metric];
    const threshold = metrics.thresholdOf(rule);
    await sequelize.transaction(async (transaction) => {
      const flag = await latestFlag(userId, rule.key, transaction);
      const step = rules.flagStep({ flag, comparator: rule.comparator, value, threshold, now });
      if (step === 'raise') {
        const f = await RiskFlag.create(
          { userId, ruleKey: rule.key, ruleVersion: rule.version, metricValue: value, threshold, severity: rule.severity, reasonText: reasonFor(rule, value, threshold), firstSeenAt: now, lastSeenAt: now },
          { transaction }
        );
        await publish(transaction, 'risk.flag_raised', f, { reopened: false });
        out.raised.push(rule.key);
      } else if (step === 'reopen') {
        await flag.update(
          { status: 'open', ruleVersion: rule.version, metricValue: value, threshold, severity: rule.severity, reasonText: reasonFor(rule, value, threshold), snoozeUntil: null, clearedValue: null, closedAt: null, escalated: false, firstSeenAt: now, lastSeenAt: now },
          { transaction }
        );
        await publish(transaction, 'risk.flag_raised', flag, { reopened: true });
        out.reopened.push(rule.key);
      } else if (step === 'refresh') {
        const stillBreached = rules.breached({ comparator: rule.comparator, value, threshold });
        if (!stillBreached && rules.lapseDue({ status: flag.status, lastActivityAt: flag.firstSeenAt, now, days: settings.get('risk.flag_lapse_days') })) {
          await flag.update({ status: 'lapsed', metricValue: value, lastSeenAt: now, closedAt: now }, { transaction });
          await publish(transaction, 'risk.flag_cleared', flag, { lapsed: true });
          out.lapsed.push(rule.key);
        } else if (flag.metricValue !== value || flag.threshold !== threshold) {
          await flag.update({ metricValue: value, threshold, lastSeenAt: now, reasonText: reasonFor(rule, value, threshold) }, { transaction });
          await publish(transaction, 'risk.flag_updated', flag, { value });
          out.refreshed += 1;
        }
      }
    });
  }
  return out;
}

/** M02 document_request.overdue_marked (FR-07): the flag the request was made for goes up one level, once. */
async function escalateForOverdue(flagId, { transaction }) {
  const f = await RiskFlag.findByPk(flagId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!f || f.escalated || !['open', 'actioned'].includes(f.status)) return null;
  await f.update({ severity: rules.raised(f.severity), escalated: true }, { transaction });
  await publish(transaction, 'risk.flag_updated', f, { escalated: true });
  return f;
}

/** Users the nightly run re-evaluates: anyone with an active flag or a metric in the window. */
async function activeUserIds({ since }) {
  const rows = await sequelize.query(
    `SELECT DISTINCT user_id AS "userId" FROM risk_flags WHERE status IN ('open', 'actioned', 'cleared')
     UNION SELECT DISTINCT user_id FROM risk_metrics WHERE computed_at >= :since`,
    { replacements: { since }, type: sequelize.QueryTypes.SELECT }
  );
  return rows.map((r) => r.userId);
}

const view = (f) => ({
  id: f.id,
  userId: f.userId,
  ruleKey: f.ruleKey,
  ruleVersion: f.ruleVersion,
  severity: f.severity,
  status: f.status,
  metricValue: f.metricValue,
  threshold: f.threshold,
  reasonText: f.reasonText,
  escalated: f.escalated,
  snoozeUntil: iso(f.snoozeUntil),
  firstSeenAt: iso(f.firstSeenAt),
  lastSeenAt: iso(f.lastSeenAt),
  closedAt: iso(f.closedAt),
});

/** GET /admin/risk/flags?status&severity&rule */
async function list({ status = 'active', severity, rule, cursor, limit = 50 } = {}) {
  const where = {};
  where.status = status === 'active' ? ['open', 'actioned'] : status;
  if (severity) where.severity = severity;
  if (rule) where.ruleKey = rule;
  if (cursor) where.lastSeenAt = { [Op.lt]: new Date(cursor) };
  const rows = await RiskFlag.findAll({
    where,
    order: [[sequelize.literal("CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END"), 'ASC'], ['lastSeenAt', 'DESC']],
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  const names = await require('../users').directory.publicNames(page.map((f) => f.userId));
  return { items: page.map((f) => ({ ...view(f), user: { id: f.userId, displayName: names.get(f.userId)?.displayName ?? null } })), nextCursor: rows.length > limit ? iso(page[page.length - 1].lastSeenAt) : null };
}

/** Open flags by severity (the desk header and the M19 action provider). */
async function counts() {
  const rows = await RiskFlag.findAll({ where: { status: ['open', 'actioned'] }, attributes: ['severity', [sequelize.fn('COUNT', sequelize.col('id')), 'n']], group: ['severity'], raw: true });
  return Object.fromEntries(rules.SEVERITIES.map((s) => [s, Number(rows.find((r) => r.severity === s)?.n ?? 0)]));
}

/** Was any action on this flag left in force (not reversed)? */
async function activeActionsOn(flagId, { transaction, except = null } = {}) {
  const rows = await RiskAction.findAll({ where: { flagId, action: ['freeze_payouts', 'request_documents', 'suspend', 'ban'] }, transaction });
  const reversed = new Set((await RiskAction.findAll({ where: { reversesActionId: rows.map((r) => r.id) }, attributes: ['reversesActionId'], transaction })).map((r) => r.reversesActionId));
  return rows.filter((r) => !reversed.has(r.id) && r.id !== except).length;
}

module.exports = { evaluateUser, escalateForOverdue, activeUserIds, list, counts, view, latestFlag, activeActionsOn, publish };
