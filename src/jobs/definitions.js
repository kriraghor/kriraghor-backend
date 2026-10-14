'use strict';

const { QUEUES } = require('./queues');
const { liftExpiredSuspensions } = require('../modules/admin/admin-users.service');
const settingsRequests = require('../modules/settings/change-request.service');

/**
 * Job catalogue. Each job must be idempotent: BullMQ delivers at least once, and a
 * repeatable job can overlap with a slow previous run.
 *
 * `every` (ms) turns a job into a job scheduler, so it runs once per interval across
 * all worker pods. That replaces the old per-process setInterval in server.js.
 */
const JOBS = [
  {
    // M01 §10 identity.sanction-expire. Safe to repeat: the conditional update
    // (lifted_at IS NULL) lifts each suspension once.
    name: 'identity.sanction-expire',
    queue: QUEUES.IDENTITY,
    every: 60 * 1000,
    run: async () => ({ lifted: await liftExpiredSuspensions() }),
  },
  {
    // M03 §10 settings.apply-scheduled. One delayed job per request (data.requestId) plus this
    // minutely sweep as the backstop. Idempotent: only approved, due requests apply, under a row lock.
    name: settingsRequests.APPLY_JOB,
    queue: QUEUES.SETTINGS,
    every: 60 * 1000,
    run: async (data) => settingsRequests.applyDue({ requestId: data.requestId }),
  },
];

const byName = new Map(JOBS.map((j) => [j.name, j]));

module.exports = { JOBS, byName };
