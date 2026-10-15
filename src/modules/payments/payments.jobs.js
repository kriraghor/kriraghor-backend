'use strict';

/**
 * M06 job dispatch (§10). Jobs go to the `payments` queue with a stable jobId so a duplicate
 * dispatch is a no-op. In tests they are collected instead (takeTestJobs) and run by the test.
 */
const config = require('../../config');
const logger = require('../../common/logger');

const JOBS = {
  POLL_ATTEMPT: 'payments.poll-attempt',
  REFUND_PROCESS: 'refunds.process',
};

const testJobs = [];

function dispatch(name, data, { jobId, delay = 0 } = {}) {
  if (config.isTest) {
    testJobs.push({ name, data, delay, jobId });
    return;
  }
  const { getQueue, QUEUES } = require('../../jobs/queues');
  getQueue(QUEUES.PAYMENTS)
    .add(name, data, { jobId, delay, removeOnComplete: 1000, removeOnFail: 5000 })
    .catch((err) => logger.warn({ err: err.message, job: name, jobId }, 'could not queue a payments job; the sweeps will pick it up'));
}

module.exports = { JOBS, dispatch, takeTestJobs: () => testJobs.splice(0, testJobs.length) };
