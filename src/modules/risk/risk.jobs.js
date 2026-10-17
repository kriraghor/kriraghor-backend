'use strict';

/**
 * M18 job dispatch (§10). risk.evaluate-user is debounced: one delayed job per user (stable jobId,
 * removed on completion), so a burst of events evaluates the account once, about 30 seconds later
 * (FR-04: within a minute). In tests the jobs are collected (takeTestJobs) and run by the test.
 */
const config = require('../../config');
const logger = require('../../common/logger');

const JOBS = { EVALUATE_USER: 'risk.evaluate-user', REEVALUATE_ALL: 'risk.reevaluate-all' };
const DEBOUNCE_MS = 30 * 1000;

const testJobs = [];

function dispatch(name, data, { jobId, delay = 0 } = {}) {
  if (config.isTest) {
    if (!testJobs.some((j) => j.jobId && j.jobId === jobId)) testJobs.push({ name, data, delay, jobId });
    return;
  }
  const { getQueue, QUEUES } = require('../../jobs/queues');
  getQueue(QUEUES.RISK)
    .add(name, data, { jobId, delay, removeOnComplete: true, removeOnFail: 100 })
    .catch((err) => logger.warn({ err: err.message, job: name }, 'could not queue a risk job; the nightly run will pick it up'));
}

/** Evaluate an account's rules and reliability soon (debounced per user). */
const scheduleEvaluation = (userId) => userId && dispatch(JOBS.EVALUATE_USER, { userId }, { jobId: `risk-eval-${userId}`, delay: DEBOUNCE_MS });

/** A risk threshold changed: re-evaluate every account with flags or metrics (FR-03). */
const scheduleReevaluation = (key) => dispatch(JOBS.REEVALUATE_ALL, { key }, { jobId: `risk-reeval-${Date.now()}` });

module.exports = { JOBS, dispatch, scheduleEvaluation, scheduleReevaluation, takeTestJobs: () => testJobs.splice(0, testJobs.length) };
