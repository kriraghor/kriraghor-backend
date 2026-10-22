'use strict';

/**
 * M11 pro insights (Round B1: §4 Manage › Overview and Earnings, §9 GET /pro/earnings, M19 §4.2 and
 * §6.3 "Pro"): GET /pro/insights?period=7w|qtr|yr for the signed-in person.
 *  - earned: what the ledger put on the pro's payable from released holds (purposes hire and
 *    trainer_subscription), net of the fee, per Dhaka week (7w, qtr) or month (yr); the total so far
 *    and the change against the same number of days one period earlier (payments ledger.earningsBy);
 *  - releasingSoon: jobs marked complete waiting for the manager or the auto-release (net, count, next);
 *  - jobs: done (released, starting in the period) and upcoming (active, starting from now);
 *  - acceptanceRate and medianReplyMinutes over hire.acceptance_window_days (all the person's profiles);
 *  - rating: the M17 averages on the profiles (count-weighted), filled by the review consumer;
 *  - whoHiresYou: the managers' teams (a team they captain or vice-captain, else "individual") for jobs
 *    in the same trailing window, top 5 by jobs.
 */
const { Op } = require('sequelize');
const { HireProfile, HireRequest, HireJob } = require('../../models');
const settings = require('../settings').settings;
const ledger = require('../payments').ledger;
const teams = require('../teams').teams;
const rules = require('./hire.rules');
const c = require('./hire.common');

const DAY = 86400000;
/** Ledger purposes that are a person's earnings as a pro (hire jobs, trainer months). */
const EARNING_PURPOSES = ['hire', 'trainer_subscription'];
const WHO_HIRES_TOP = 5;
const TEAM_MANAGERS = ['captain', 'vice_captain'];

/** Each manager's team label: a team they run, else individual. */
async function hirerLabels(hirerIds) {
  const out = new Map();
  for (const id of new Set(hirerIds)) {
    const run = (await teams.teamsOf(id)).find((t) => TEAM_MANAGERS.includes(t.role));
    out.set(id, run ? { key: `team:${run.id}`, label: run.name } : { key: 'individual', label: 'Individual' });
  }
  return out;
}

/** GET /pro/insights?period. */
async function insights(principal, { period = '7w' } = {}) {
  const cfg = c.config();
  const now = new Date();
  const today = rules.dhakaDay(now);
  const p = rules.periodBuckets(period, today, settings.get('analytics.week_start'));
  const since = new Date(now.getTime() - cfg.acceptanceWindowDays * DAY);
  const [earnings, marked, done, upcoming, requests, profiles, recentJobs] = await Promise.all([
    ledger.earningsBy(principal.id, { purposes: EARNING_PURPOSES, from: rules.dhakaMidnight(p.previous.from), to: rules.dhakaMidnight(p.to) }),
    HireJob.findAll({ where: { proUserId: principal.id, status: 'completed_marked' }, attributes: ['netPoisha', 'releaseAt'] }),
    HireJob.count({ where: { proUserId: principal.id, status: 'released', startAt: { [Op.gte]: rules.dhakaMidnight(p.current.from), [Op.lt]: rules.dhakaMidnight(p.current.to) } } }),
    HireJob.count({ where: { proUserId: principal.id, status: rules.ACTIVE_JOB.filter((s) => s !== 'completed_marked'), startAt: { [Op.gte]: now } } }),
    HireRequest.findAll({ where: { proUserId: principal.id, createdAt: { [Op.gte]: since } }, attributes: ['status', 'createdAt', 'decidedAt'] }),
    HireProfile.findAll({ where: { userId: principal.id, status: { [Op.ne]: 'removed' } }, attributes: ['ratingAvg', 'ratingCount'] }),
    HireJob.findAll({ where: { proUserId: principal.id, status: [...rules.ACTIVE_JOB, 'released'], startAt: { [Op.gte]: since } }, attributes: ['hirerId'] }),
  ]);
  const days = earnings.map((e) => ({ day: e.day, amount: e.net }));
  const total = rules.sumDays(days, p.current);
  const previous = rules.sumDays(days, p.previous);
  const stats = rules.requestStats(requests, { now, windowDays: cfg.acceptanceWindowDays });
  const labels = await hirerLabels(recentJobs.map((j) => j.hirerId));
  const soon = rules.releasingSoon(marked.map((j) => ({ net: j.netPoisha, releaseAt: j.releaseAt })));
  return {
    period,
    asOf: now.toISOString(),
    from: p.current.from,
    buckets: rules.bucketize(days, p.buckets),
    earned: { total, previous, delta: rules.delta(total, previous) },
    releasingSoon: { net: soon.net, count: soon.count, nextAt: c.iso(soon.nextAt) },
    jobs: { done, upcoming },
    acceptanceRate: stats.acceptanceRate,
    medianReplyMinutes: stats.medianReplyMinutes,
    rating: rules.ratingOf(profiles),
    whoHiresYou: rules.rankHirers(
      recentJobs.map((j) => labels.get(j.hirerId)),
      WHO_HIRES_TOP
    ),
  };
}

module.exports = { insights, EARNING_PURPOSES };
