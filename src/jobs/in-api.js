'use strict';

/**
 * One-process mode (ADR-003 amendment, 25 Oct 2026): with JOBS_IN_API=true the API also runs what
 * src/worker.js runs, for hosts with no background worker service (Render's free plan). The event
 * consumers are already registered by createApp(); this adds the job schedules and one BullMQ worker
 * per queue. Closing a worker waits for its running job; the queues close after the workers (lifecycle
 * closers run in reverse order). Kubernetes and paid hosts keep the separate worker.
 */
const logger = require('../common/logger');
const lifecycle = require('../common/lifecycle');
const { closeQueues } = require('./queues');
const { registerSchedules, startWorkers } = require('./runtime');

async function startJobsInApi() {
  lifecycle.onShutdown('queues', closeQueues);
  const schedules = await registerSchedules();
  const workers = startWorkers();
  lifecycle.onShutdown('workers', () => Promise.all(workers.map((w) => w.close())));
  logger.info({ schedules, queues: workers.length }, 'JOBS_IN_API: background jobs run inside the API (no separate worker)');
  return { schedules, workers };
}

module.exports = { startJobsInApi };
