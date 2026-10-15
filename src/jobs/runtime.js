'use strict';

const { Worker } = require('bullmq');
const logger = require('../common/logger');
const { createRedis } = require('../common/redis');
const { jobsTotal } = require('../common/metrics');
const { getQueue, prefix } = require('./queues');
const { JOBS, byName } = require('./definitions');
const settings = require('../modules/settings/settings.service');
const { backoffMs } = require('../modules/events/events.backoff');

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
  const scheduled = JOBS.filter((j) => j.every || j.pattern);
  for (const job of scheduled) {
    const repeat = job.pattern ? { pattern: job.pattern, tz: job.tz } : { every: job.every };
    await getQueue(job.queue).upsertJobScheduler(job.name, repeat, { name: job.name, opts: { removeOnComplete: 100, removeOnFail: 500 } });
  }
  return scheduled.map((j) => j.name);
}

/** One BullMQ Worker per queue that has jobs. */
function startWorkers({ concurrency = 4 } = {}) {
  const queueNames = [...new Set(JOBS.map((j) => j.queue))];
  return queueNames.map((name) => {
    const worker = new Worker(name, processJob, {
      connection: createRedis(`worker:${name}`, { bullmq: true }),
      prefix,
      concurrency,
      // M04-FR-16 retry delay for jobs added with backoff { type: 'capped' }: 2^n s, capped.
      settings: { backoffStrategy: (attemptsMade) => backoffMs(attemptsMade, settings.get('events.backoff_cap_sec')) },
    });
    worker.on('failed', (job, err) => logger.error({ err, job: job?.name, jobId: job?.id }, 'job failed'));
    worker.on('error', (err) => logger.error({ err }, 'worker error'));
    return worker;
  });
}

module.exports = { processJob, registerSchedules, startWorkers };
