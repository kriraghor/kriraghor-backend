'use strict';

/**
 * M19 §6.4 staff review figures (M19-FR-33): GET /admin/analytics/reviews. Counted from analytics' own
 * kpi_fact_review (M19-FR-32) for the kinds the person may review (M05 reviewKinds), either the
 * person's own decisions ("me") or everyone's ("team", no reviewer is named), plus the live queue from
 * M05. Every window comes from analytics.review_window_days.
 */
const { sequelize } = require('../../models');
const settings = require('../settings').settings;
const rules = require('./reviews.rules');
const { definitionsFor } = require('./kpis');

const select = (sql, replacements) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
const moderation = () => require('../moderation');
const KEYS = ['review_waiting', 'reviewed_today', 'median_decision', 'approval_rate', 'decisions_per_day', 'why_no'];

async function reviewFigures(principal, { scope = 'me', locale = 'en' } = {}, now = new Date()) {
  const kinds = moderation().reads.reviewKinds(principal);
  const days = settings.get('analytics.review_window_days');
  const w = rules.windows(now, days);
  const mine = scope === 'me';
  // No kinds (a reviewer whose permissions were all taken away): an impossible kind keeps the SQL valid and empty.
  const base = { kinds: kinds.length ? kinds : ['-'], me: principal.id };
  const where = `kind IN (:kinds)${mine ? ' AND decided_by = :me' : ''} AND decided_at >= :from AND decided_at < :to`;
  const count = async (span) => (await select(`SELECT COUNT(*)::int AS n FROM kpi_fact_review WHERE ${where}`, { ...base, ...span }))[0].n;
  const median = async (span) => {
    const [r] = await select(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM decided_at - submitted_at)) AS s FROM kpi_fact_review WHERE ${where}`, { ...base, ...span });
    return r.s === null ? null : Math.round(Number(r.s) / 60);
  };
  const outcomes = async (span) =>
    Object.fromEntries((await select(`SELECT decision, COUNT(*)::int AS n FROM kpi_fact_review WHERE ${where} GROUP BY decision`, { ...base, ...span })).map((r) => [r.decision, r.n]));

  const [waiting, today, lastWeek, med, medBefore, out, outBefore, perDayRows, reasonRows, recentRows] = await Promise.all([
    moderation().moderation.stats(principal),
    count(w.today),
    count(w.lastWeek),
    median(w.window),
    median(w.before),
    outcomes(w.window),
    outcomes(w.before),
    select(
      `SELECT to_char((decided_at AT TIME ZONE 'Asia/Dhaka')::date, 'YYYY-MM-DD') AS day, decision, COUNT(*)::int AS n FROM kpi_fact_review WHERE ${where} GROUP BY 1, 2`,
      { ...base, ...w.window }
    ),
    select(`SELECT reason_code AS code, COUNT(*)::int AS count FROM kpi_fact_review WHERE ${where} AND decision <> 'approved' AND reason_code IS NOT NULL GROUP BY 1`, { ...base, ...w.window }),
    mine
      ? select(`SELECT submission_id, kind, decision, reason_code, decided_at FROM kpi_fact_review WHERE kind IN (:kinds) AND decided_by = :me ORDER BY decided_at DESC LIMIT :n`, {
          ...base,
          n: settings.get('analytics.recent_decisions'),
        })
      : [],
  ]);

  const byDay = new Map();
  for (const r of perDayRows) byDay.set(r.day, { ...(byDay.get(r.day) ?? { day: r.day }), [r.decision]: r.n });
  const labels = await moderation().reads.reasonLabels([...reasonRows.map((r) => r.code), ...recentRows.map((r) => r.reason_code)]);
  const label = (code) => (code ? rules.reasonsWithLabels([{ code, count: 0 }], labels, locale)[0].label : null);

  return {
    scope: mine ? 'me' : 'team',
    window: { days, from: w.window.firstDay, to: w.window.lastDay },
    tiles: rules.tiles({ waiting, today, lastWeek, median: med, medianBefore: medBefore, rate: rules.approvalRate(out), rateBefore: rules.approvalRate(outBefore) }),
    perDay: rules.fillDecisionDays([...byDay.values()], w.window.firstDay, w.window.lastDay),
    whyNo: rules.reasonsWithLabels(reasonRows, labels, locale),
    recent: recentRows.map((r) => ({ submissionId: r.submission_id, kind: r.kind, decision: r.decision, reasonCode: r.reason_code, reason: label(r.reason_code), decidedAt: new Date(r.decided_at).toISOString() })),
    asOf: now.toISOString(),
    definitions: definitionsFor(KEYS, locale),
  };
}

module.exports = { reviewFigures };
