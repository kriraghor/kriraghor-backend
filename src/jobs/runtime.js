'use strict';

const { Worker } = require('bullmq');
const logger = require('../common/logger');
const { createRedis } = require('../common/redis');
const { jobsTotal } = require('../common/metrics');
const { getQueue, prefix } = require('./queues');
const { JOBS, byName } = require('./definitions');

/** Run one job by name. Exported so tests can call processors without a worker. */
async function processJob(job) {
  const def = byName.get(job.name);
  if (!def) throw new Error(`No processor for job ${job.name}`);
  try {
    const result = await def.run(job.data ?? {}, job);
    jobsTotal.inc({ queue: def.queue, name: def.name, result: 'ok' });
    return result;
  } catch (err) {
    jobsTotal.inc({ queue: def.queue, name: def.name, result: 'error' });
    throw err;
  }
}

/** Create or update every job scheduler. Idempotent, so every worker pod may call it at boot. */
async function registerSchedules() {
  const scheduled = JOBS.filter((j) => j.every);
  for (const job of scheduled) {
    await getQueue(job.queue).upsertJobScheduler(job.name, { every: job.every }, { name: job.name, opts: { removeOnComplete: 100, removeOnFail: 500 } });
  }
  return scheduled.map((j) => j.name);
}

/** One BullMQ Worker per queue that has jobs. */
function startWorkers({ concurrency = 4 } = {}) {
  const queueNames = [...new Set(JOBS.map((j) => j.queue))];
  return queueNames.map((name) => {
    const worker = new Worker(name, processJob, { connection: createRedis(`worker:${name}`, { bullmq: true }), prefix, concurrency });
    worker.on('failed', (job, err) => logger.error({ err, job: job?.name, jobId: job?.id }, 'job failed'));
    worker.on('error', (err) => logger.error({ err }, 'worker error'));
    return worker;
  });
}

module.exports = { processJob, registerSchedules, startWorkers };
