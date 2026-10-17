'use strict';

/**
 * M18 desk reads (§4): the overview (open flags by severity, the rules with their live thresholds)
 * and one account (flags, metrics, the actions timeline with what can be undone, reliability, payout
 * holds and document requests). Names come from M01's directory; no phone, NID or wallet numbers.
 * Threshold changes go through M03 change requests (FR-02: step-up, range check, history, audit).
 */
const { E } = require('../../common/errors');
const { RiskRule, RiskFlag, RiskMetric, DocumentRequest } = require('../../models');
const directory = require('../users/directory.service');
const flags = require('./flags.service');
const actions = require('./actions.service');
const trust = require('./trust.service');
const metrics = require('./metrics.service');
const rules = require('./risk.rules');

const iso = (d) => (d ? new Date(d).toISOString() : null);

async function overview() {
  const ruleRows = await RiskRule.findAll({ order: [['key', 'ASC']] });
  const open = await RiskFlag.findAll({ where: { status: ['open', 'actioned'] }, attributes: ['ruleKey'] });
  const perRule = open.reduce((m, f) => m.set(f.ruleKey, (m.get(f.ruleKey) ?? 0) + 1), new Map());
  return {
    counts: await flags.counts(),
    rules: ruleRows.map((r) => ({ key: r.key, metric: r.metric, comparator: r.comparator, settingKey: r.settingKey ?? null, threshold: metrics.thresholdOf(r), severity: r.severity, description: r.description, enabled: r.enabled, version: r.version, open: perRule.get(r.key) ?? 0 })),
  };
}

async function account(userId) {
  const acc = (await directory.accounts([userId])).get(userId);
  if (!acc) throw E.notFound('User');
  const kycStatus = (await directory.identities([userId])).get(userId)?.kycStatus ?? null;
  const flagRows = await RiskFlag.findAll({ where: { userId }, order: [['createdAt', 'DESC']], limit: 100 });
  const metricRows = await RiskMetric.findAll({ where: { userId } });
  const holds = await require('../payouts/holds.service').activeFor(userId);
  const docRequests = await DocumentRequest.findAll({ where: { userId }, order: [['createdAt', 'DESC']], limit: 20 });
  return {
    user: { id: userId, displayName: acc.displayName ?? null, status: acc.status, isStaff: acc.isStaff, kycStatus },
    riskLevel: rules.riskLevel(flagRows),
    flags: flagRows.map(flags.view),
    metrics: metricRows.map((m) => ({ metric: m.metric, value: m.value, sample: m.sample, computedAt: iso(m.computedAt) })),
    actions: await actions.forUser(userId),
    trust: await trust.forUser(userId),
    holds: holds.map((h) => ({ id: h.id, type: h.type, scope: h.scope, placedAt: iso(h.placedAt), until: iso(h.until) })),
    documentRequests: docRequests.map((r) => require('../kyc/requests.service').view(r)),
  };
}

/** The risk level of an account (other modules may show it; step 1 changes nothing automatically, Q103). */
async function levelOf(userId) {
  return rules.riskLevel(await RiskFlag.findAll({ where: { userId, status: ['open', 'actioned'] }, attributes: ['status', 'severity'] }));
}

/** POST /admin/risk/thresholds { changes: [{ key, value }], reason }: an M03 change request (FR-02). */
async function proposeThresholds(actor, { changes, reason }, req) {
  const allowed = new Set((await RiskRule.findAll({ attributes: ['settingKey'] })).map((r) => r.settingKey).filter(Boolean));
  const bad = changes.filter((c) => !allowed.has(c.key) && !c.key.startsWith('risk.') && !c.key.startsWith('trust.'));
  if (bad.length) throw E.validation(bad.map((c) => ({ field: 'changes', message: `${c.key} is not a risk or trust setting` })));
  return require('../settings/change-request.service').create(actor, { changes, reason, source: 'risk_desk' }, req);
}

module.exports = { overview, account, levelOf, proposeThresholds };
