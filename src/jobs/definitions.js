'use strict';

const { QUEUES } = require('./queues');
const { liftExpiredSuspensions } = require('../modules/admin/admin-users.service');
const settingsRequests = require('../modules/settings/change-request.service');
const settings = require('../modules/settings/settings.service');
const relay = require('../modules/events/events.relay');
const consumers = require('../modules/events/events.consumers');
const events = require('../modules/events/events.service');
const chain = require('../modules/audit/audit.chain');
const auditAdmin = require('../modules/audit/audit.admin.service');
const logger = require('../common/logger');

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
  {
    // M04-FR-13 outbox relay: every second, plus a nudge after each commit that publishes. SKIP LOCKED
    // claims make parallel runs safe; consumer jobs are deduplicated by jobId.
    name: 'outbox.relay',
    queue: QUEUES.OUTBOX,
    every: 1000,
    run: async () => relay.relayOnce(),
  },
  {
    // M04-FR-14/16: one delivery of one event to one consumer, under the inbox; dead-lettered after
    // events.consumer_max_attempts (BullMQ attempts with the capped exponential backoff).
    name: consumers.CONSUME_JOB,
    queue: QUEUES.EVENTS,
    run: async (data, job) => consumers.processConsume(data, { attemptsMade: job?.attemptsMade ?? 0 }),
  },
  {
    // M04-FR-05: append committed audit rows to the hash chain.
    name: 'audit.chain-seal',
    queue: QUEUES.AUDIT,
    every: 60 * 1000,
    run: async () => chain.seal({ batch: settings.get('audit.chain_seal_batch') }),
  },
  {
    // M04 §10: nightly chain verification at 02:00 Dhaka time. Read-only; a mismatch becomes an event.
    name: 'audit.chain-verify',
    queue: QUEUES.AUDIT,
    pattern: '0 2 * * *',
    tz: 'Asia/Dhaka',
    run: async () => {
      const result = await chain.verify();
      if (!result.ok) {
        logger.error(result, 'audit chain verification failed');
        await events.publish(null, { name: 'audit.chain_mismatch_detected', aggregateType: 'audit_chain', aggregateId: String(result.firstBad.seq), payload: result.firstBad });
      }
      return result;
    },
  },
  {
    // M04-FR-10: build an audit export CSV (on request).
    name: auditAdmin.EXPORT_JOB,
    queue: QUEUES.AUDIT,
    run: async (data) => auditAdmin.runExport(data),
  },
];

const byName = new Map(JOBS.map((j) => [j.name, j]));

module.exports = { JOBS, byName };
