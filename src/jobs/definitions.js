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
const notify = require('../modules/notifications/notify.service');
const payments = require('../modules/payments/payments.service');
const refunds = require('../modules/payments/refunds.service');
const escrow = require('../modules/payments/escrow.service');
const invariants = require('../modules/payments/invariants.service');
const reconciliation = require('../modules/payments/reconciliation.service');
const paymentJobs = require('../modules/payments/payments.jobs');
const payouts = require('../modules/payouts/payouts.service');
const payoutHolds = require('../modules/payouts/holds.service');
const kyc = require('../modules/kyc/kyc.service');
const moderation = require('../modules/moderation/moderation.service');
const esportsLifecycle = require('../modules/esports/esports.lifecycle');
const esportsRankings = require('../modules/esports/rankings.service');
const bookings = require('../modules/bookings/bookings.service');
const analytics = require('../modules/analytics/facts.service');
const disputes = require('../modules/trust/disputes.service');
const { purgeExpired: purgeIdempotencyKeys } = require('../common/idempotency');
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
  {
    // M08-FR-08/11/12/13: send one channel of one notification; BullMQ retries 30 s, 2 min, 10 min.
    name: notify.DELIVER_JOB,
    queue: QUEUES.NOTIFY,
    run: async (data, job) => notify.deliver(data, { attemptsMade: job?.attemptsMade ?? 0 }),
  },
  {
    // M08-FR-10: deliveries held for quiet hours go out once the window ends.
    name: 'notify.release-deferred',
    queue: QUEUES.NOTIFY,
    every: 5 * 60 * 1000,
    run: async () => notify.releaseDeferred(),
  },
  {
    // M08 §10: SMS accepted more than a day ago without a delivery receipt are failed.
    name: 'notify.dlr-timeout',
    queue: QUEUES.NOTIFY,
    every: 60 * 60 * 1000,
    run: async () => notify.dlrTimeout(),
  },

  // ---------------- M06 payments (§10). Each is idempotent: status guards and ledger idempotency keys.
  {
    // Intents past expiry: ask the provider first (a late capture is captured, then refunded), else expire.
    name: 'payments.expire-intents',
    queue: QUEUES.PAYMENTS,
    every: 60 * 1000,
    run: async () => payments.expireIntents(),
  },
  {
    // Attempts with no answer yet, at payments.poll_unknown_minutes after they started.
    name: paymentJobs.JOBS.POLL_ATTEMPT,
    queue: QUEUES.PAYMENTS,
    run: async (data) => payments.pollAttempt(data),
  },
  {
    // Provider refund call, then status polling; retries 1 min / 10 min / 1 h, then manual_required.
    name: paymentJobs.JOBS.REFUND_PROCESS,
    queue: QUEUES.PAYMENTS,
    run: async (data) => refunds.processRefund(data),
  },
  {
    name: 'escrow.release-due',
    queue: QUEUES.PAYMENTS,
    every: 5 * 60 * 1000,
    run: async () => escrow.releaseDue(),
  },
  {
    // FR-19: after the audit chain check (02:00).
    name: 'ledger.invariants',
    queue: QUEUES.PAYMENTS,
    pattern: '30 2 * * *',
    tz: 'Asia/Dhaka',
    run: async () => invariants.check(),
  },
  {
    // FR-18: the previous Dhaka business day, per provider (UNIQUE provider + date).
    name: 'reconciliation.daily',
    queue: QUEUES.PAYMENTS,
    pattern: '0 6 * * *',
    tz: 'Asia/Dhaka',
    run: async () => reconciliation.run(),
  },
  // ---------------- M07 payouts (§10). Idempotent: UNIQUE(schedule, window_end), each ledger entry used once.
  {
    // Hourly at :00 Dhaka: builds the schedules due now (payouts.run_hour, weekdays, daily_enabled).
    // A missed run is caught up by the next hour (same window).
    name: 'payouts.schedule',
    queue: QUEUES.PAYOUTS,
    pattern: '0 * * * *',
    tz: 'Asia/Dhaka',
    run: async () => payouts.runDue(),
  },
  {
    // account_change holds past their time are lifted; the payee's payouts return to scheduled.
    name: 'payouts.hold-expiry',
    queue: QUEUES.PAYOUTS,
    every: 15 * 60 * 1000,
    run: async () => payoutHolds.expireDue(),
  },
  // ---------------- M02 KYC (§10)
  {
    // FR-17: images of decided documents after kyc.raw_image_retention_days, unused uploads after
    // kyc.orphan_upload_hours. Idempotent: purged files are skipped.
    name: 'kyc.retention-purge',
    queue: QUEUES.KYC,
    pattern: '30 3 * * *',
    tz: 'Asia/Dhaka',
    run: async () => kyc.purgeDue(),
  },
  // ---------------- M05 moderation (§10). Idempotent: conditional updates, breach_notified_at, apply_attempts.
  {
    // Locks past their TTL (moderation.claim_ttl_min, extended by heartbeats) or hard cap are released.
    name: 'moderation.claim-expire',
    queue: QUEUES.MODERATION,
    every: 60 * 1000,
    run: async () => moderation.expireClaims(),
  },
  {
    // FR-18: one submission.sla_breached per overdue submission (reviewers of the kind and masters).
    name: 'moderation.sla-breach',
    queue: QUEUES.MODERATION,
    pattern: '5 * * * *',
    tz: 'Asia/Dhaka',
    run: async () => moderation.reportBreaches(),
  },
  {
    // FR-13: an approval not applied within moderation.apply_timeout_minutes is republished, up to
    // moderation.apply_max_attempts, then submission.apply_failed alerts the masters.
    name: 'moderation.apply-watchdog',
    queue: QUEUES.MODERATION,
    every: 60 * 1000,
    run: async () => moderation.watchApplies(),
  },
  // ---------------- M21 esports (§10). Idempotent: every step is guarded by status.
  {
    // Registration open/close (auto-cancel below the minimum), check-in open/close, hold and offer
    // expiry, room reveal, live, dispute windows. Per-entity delayed jobs come in step 2.
    name: 'esports.tick',
    queue: QUEUES.ESPORTS,
    every: 60 * 1000,
    run: async () => esportsLifecycle.tick(),
  },
  {
    // FR-28: rankings rebuilt nightly (finalising a tournament also rebuilds its game at once).
    name: 'esports.rankings-recompute',
    queue: QUEUES.ESPORTS,
    pattern: '0 3 * * *',
    tz: 'Asia/Dhaka',
    run: async () => esportsRankings.recomputeAll(),
  },
  // ---------------- M10 bookings (§10). Idempotent: every step locks the row and checks its status.
  {
    // Holds past their time; checked-in bookings at their end; never-checked-in bookings
    // booking.auto_complete_after_hours after the end (full release, Q68); start reminders; venue
    // balances not recorded after booking.balance_unrecorded_days.
    name: 'bookings.tick',
    queue: QUEUES.BOOKINGS,
    every: 60 * 1000,
    run: async () => bookings.tick(),
  },
  // ---------------- M17 disputes (§10). Idempotent: every step re-checks the state under a row lock.
  {
    // Respondent reminders (disputes.respondent_reminder_hours before) and timeouts; staff and master
    // SLA breaches (once per level); expired desk claims. No-show advances are released by bookings.tick.
    name: 'trust.tick',
    queue: QUEUES.TRUST,
    every: 60 * 1000,
    run: async () => disputes.tick(),
  },
  // ---------------- M19 analytics (§10). Idempotent: upserts and REFRESH … CONCURRENTLY under an advisory lock.
  {
    // FR-10: refresh the day-grained summaries (asOf). The interval is analytics.mview_refresh_minutes,
    // read when the schedulers are registered (a change applies at the next deploy).
    name: 'analytics.refresh-mviews',
    queue: QUEUES.ANALYTICS,
    every: () => settings.get('analytics.mview_refresh_minutes') * 60 * 1000,
    run: async () => analytics.refreshViews(),
  },
  {
    // FR-09: re-read the last analytics.reconcile_days through the owning services; repair, log, alert.
    name: 'analytics.reconcile',
    queue: QUEUES.ANALYTICS,
    pattern: '0 3 * * *',
    tz: 'Asia/Dhaka',
    run: async () => analytics.reconcile(),
  },
  {
    // Occupancy (open and booked half-hours) for the last 2 and next 14 days, so hours changes count.
    name: 'analytics.court-days',
    queue: QUEUES.ANALYTICS,
    pattern: '30 2 * * *',
    tz: 'Asia/Dhaka',
    run: async () => ({ rebuilt: await analytics.rebuildRecentCourtDays() }),
  },
  {
    name: 'idempotency.purge',
    queue: QUEUES.PAYMENTS,
    every: 60 * 60 * 1000,
    run: async () => ({ purged: await purgeIdempotencyKeys() }),
  },
];

const byName = new Map(JOBS.map((j) => [j.name, j]));

module.exports = { JOBS, byName };
