'use strict';

/**
 * M18 metrics (§6.1): each rule's metric is computed through the owning module's read service, never
 * from its tables (M02 nidAttempts, M07 sharedWith and addedSince, M06 payeeRefundStats, M17 statsFor
 * and upheldAgainst, M21 riskFacts, the VelocityGuard breaches). The latest value is kept in
 * risk_metrics for the desk. Windows and minimum samples are settings.
 */
const { RiskMetric } = require('../../models');
const settings = require('../settings/settings.service');
const velocity = require('../../common/velocity');
const rules = require('./risk.rules');

const DAY = 24 * 3600 * 1000;
// Refunds the payee caused besides lost disputes (M10 owner cancels; the reason code M10 gives M06).
const PAYEE_FAULT_REFUNDS = ['booking_cancelled_by_owner'];

const since = (now) => new Date(now.getTime() - settings.get('risk.window_days') * DAY);
const kyc = () => require('../kyc/kyc.service');
const payoutAccounts = () => require('../payouts/payout-accounts.service');
const payments = () => require('../payments').intents;
const disputes = () => require('../trust/disputes.service');
const reports = () => require('../trust/reports.service');
const esports = () => require('../esports/esports.facts');

/** metric → (userId, ctx) → { value, sample, detail } */
const METRICS = {
  nid_attempts: async (u) => ({ value: await kyc().nidAttempts(u), sample: 1 }),
  shared_wallets: async (u) => ({ value: await payoutAccounts().sharedWith(u), sample: 1 }),
  esports_bans: async (u, ctx) => ({ value: (await ctx.esports()).banned, sample: 1 }),
  esports_dqs: async (u, ctx) => ({ value: (await ctx.esports()).disqualifications, sample: 1 }),
  payee_refund_pct: async (u, ctx) => {
    const s = await payments().payeeRefundStats(u, ctx.since, { reasonCodes: PAYEE_FAULT_REFUNDS });
    return { value: rules.rate({ part: s.refunded, whole: s.payments, minSample: settings.get('risk.refund_rate_min_sample') }) ?? 0, sample: s.payments, detail: s };
  },
  dispute_loss_pct: async (u, ctx) => {
    const s = await disputes().statsFor(u, ctx.since);
    return { value: rules.rate({ part: s.lost, whole: s.decided, minSample: settings.get('risk.dispute_min_sample') }) ?? 0, sample: s.decided, detail: s };
  },
  reports_upheld: async (u, ctx) => ({ value: await reports().upheldAgainst(u, ctx.since), sample: 1 }),
  velocity_breaches: async (u) => ({ value: await velocity.breaches(u), sample: 1 }),
  payout_account_added: async (u, ctx) => ({ value: await payoutAccounts().addedSince(u, new Date(ctx.now.getTime() - settings.get('risk.payout_change_hold_hours') * 3600000)), sample: 1 }),
};

/** Compute the metrics behind `ruleRows` for a user and store them. Returns metric → { value, sample }. */
async function compute(userId, ruleRows, now = new Date()) {
  let es = null;
  const ctx = { now, since: since(now), esports: () => (es ??= esports().riskFacts(userId, since(now))) };
  const out = {};
  for (const metric of new Set(ruleRows.map((r) => r.metric))) {
    const m = await METRICS[metric](userId, ctx);
    out[metric] = m;
    await RiskMetric.upsert({ userId, metric, value: m.value, sample: m.sample, detail: m.detail ?? null, computedAt: now });
  }
  return out;
}

/** The threshold a rule uses now: its setting, or 1 for presence rules (any occurrence counts). */
const thresholdOf = (rule) => (rule.settingKey ? Number(settings.get(rule.settingKey)) : 1);

module.exports = { METRICS, compute, thresholdOf, PAYEE_FAULT_REFUNDS };
