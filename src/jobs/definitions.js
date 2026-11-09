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
const riskJobs = require('../modules/risk/risk.jobs');
const risk = require('../modules/risk/risk.nightly');
const inventory = require('../modules/market/inventory.service');
const orders = require('../modules/orders/orders.jobs');
const hire = require('../modules/hire/hire.jobs');
const gym = require('../modules/gym/gym.jobs');
const gymManage = require('../modules/gym-manage/gym-manage.jobs');
const gymOpsJobs = require('../modules/gym-ops/gym-ops.jobs');
const saas = require('../modules/organiser-saas/saas.jobs');
const esportsEvents = require('../modules/esports-events/events.jobs');
const teamsJobs = require('../modules/teams/teams.jobs');
const tournamentPostJobs = require('../modules/tournament-posts/tournament-posts.jobs');
const tournamentsJobs = require('../modules/tournaments/tournaments.jobs');
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
  {
    // M08 push: ask the provider how accepted pushes ended; dead tokens (app removed) are revoked.
    name: 'notify.push-receipts',
    queue: QUEUES.NOTIFY,
    every: 5 * 60 * 1000,
    run: async () => notify.checkPushReceipts(),
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
  // ---------------- M18 risk and trust (§10). Every step re-reads the facts, so a repeat is harmless.
  {
    // FR-04: one account's rules and reliability, about 30 s after its events (debounced per user).
    name: riskJobs.JOBS.EVALUATE_USER,
    queue: QUEUES.RISK,
    run: async ({ userId }) => risk.evaluate(userId),
  },
  {
    // FR-03: a risk.* or trust.* setting changed: re-evaluate every account with flags or metrics.
    name: riskJobs.JOBS.REEVALUATE_ALL,
    queue: QUEUES.RISK,
    run: async () => risk.everyone(),
  },
  {
    // FR-04, FR-07, FR-14: re-evaluate active accounts, lapse quiet flags, mark overdue document requests.
    name: 'risk.nightly',
    queue: QUEUES.RISK,
    pattern: '30 2 * * *',
    tz: 'Asia/Dhaka',
    run: async () => risk.nightly(),
  },
  // ---------------- M12 market (§10). Idempotent: each step changes only what is out of line, under row locks.
  {
    // v3: supplement variants past or near their expiry are blocked from sale; the shop is told.
    name: 'market.supplement-expiry',
    queue: QUEUES.MARKET,
    pattern: '0 1 * * *',
    tz: 'Asia/Dhaka',
    run: async () => inventory.supplementSweep(),
  },
  {
    // FR-11: the variant stock columns equal the sum of their movements; a mismatch is a critical audit row.
    name: 'market.inventory-reconcile',
    queue: QUEUES.MARKET,
    pattern: '30 3 * * *',
    tz: 'Asia/Dhaka',
    run: async () => inventory.reconcile(),
  },
  {
    // FR-15 safety net: hide and show products from their stock (every movement already does this).
    name: 'market.visibility-sweep',
    queue: QUEUES.MARKET,
    every: 60 * 60 * 1000,
    run: async () => inventory.visibilitySweep(),
  },
  // ---------------- M13 orders (§10). Idempotent: every step locks the sub-order and re-checks its status.
  {
    // Unpaid orders past market.checkout_hold_minutes; accept reminders and expiry (refund); shipping
    // late past market.ship_overdue_auto_cancel_hours (refund); delivered past market.auto_complete_days.
    name: 'orders.tick',
    queue: QUEUES.ORDERS,
    every: 60 * 1000,
    run: async () => orders.tick(),
  },
  // ---------------- M11 hire (§10). Idempotent: every step locks the row and re-checks its status.
  {
    // Requests past hire.reply_hours expire; unpaid ones past hire.payment_window_min lapse; check-in
    // reminders; jobs marked complete are released after hire.auto_release_hours with no dispute (v3).
    name: 'hire.tick',
    queue: QUEUES.HIRE,
    every: 60 * 1000,
    run: async () => hire.tick(),
  },
  {
    // FR-52 (Round B1): acceptance rate and reply time over the trailing hire.acceptance_window_days, so a
    // quiet profile's old requests age out. Events keep them fresh in between. Idempotent: a recompute.
    name: 'hire.stats-recompute',
    queue: QUEUES.HIRE,
    pattern: '15 3 * * *',
    tz: 'Asia/Dhaka',
    run: async () => hire.recomputeStats(),
  },
  // ---------------- M20 gym (§10). Idempotent: every step locks the row and re-checks its status.
  {
    // Unpaid passes void; passes past closing on their last day expire and pay the gym (Q110); trainer
    // months: renewal rows and notices, lapses after the grace days, release after the dispute window.
    name: 'gym.tick',
    queue: QUEUES.GYM,
    every: 60 * 1000,
    run: async () => gym.tick(),
  },
  // ---------------- M24 gym management (§10), on the gym queue (no new queue: Render's Redis connection limit).
  // Idempotent: every step locks its row and re-checks the status (a second run the same day changes nothing).
  {
    // Freezes start and end; upcoming → active; active → expired (an upcoming renewal starts); member statuses.
    name: 'gym-manage.daily',
    queue: QUEUES.GYM,
    pattern: '5 0 * * *',
    tz: 'Asia/Dhaka',
    run: async () => gymManage.daily(),
  },
  {
    // Dues unpaid or partial after due_on: overdue_at once, gym_due.overdue_marked (M24-FR-39).
    name: 'gym-manage.dues-overdue',
    queue: QUEUES.GYM,
    pattern: '15 0 * * *',
    tz: 'Asia/Dhaka',
    run: async () => gymManage.duesOverdue(),
  },
  {
    // Pending gym invites past expires_at → expired.
    name: 'gym-manage.requests-expire',
    queue: QUEUES.GYM,
    every: 15 * 60 * 1000,
    run: async () => gymManage.requestsExpire(),
  },
  {
    // Raw member list files past gym_manage.import_file_retention_days deleted; stale previews discarded (M24-FR-80).
    name: 'gym-manage.import-housekeeping',
    queue: QUEUES.GYM,
    pattern: '0 3 * * *',
    tz: 'Asia/Dhaka',
    run: async () => gymManage.importHousekeeping(),
  },
  // M24 prompt 2 (§10): online fees, reminders and billing, on the same gym queue.
  {
    // Yesterday's active members per owner (§6.6, M24-FR-83); the tier notice once a month.
    name: 'gym-manage.active-count',
    queue: QUEUES.GYM,
    pattern: '45 0 * * *',
    tz: 'Asia/Dhaka',
    run: async () => gymManage.activeCount(),
  },
  {
    // The owners' invoices for the month before, in arrears (M24-FR-84); one per subscription and period.
    name: 'gym-manage.invoice-cycle',
    queue: QUEUES.GYM,
    pattern: '0 2 1 * *',
    tz: 'Asia/Dhaka',
    run: async () => gymManage.invoiceCycle(),
  },
  {
    // The M24 invariants: dues against their payments, due statuses, released fees against M06 releases.
    name: 'gym-manage.reconcile',
    queue: QUEUES.GYM,
    pattern: '0 4 * * *',
    tz: 'Asia/Dhaka',
    run: async () => gymManage.reconcile(),
  },
  {
    // The owner's report of the month before, per gym (M24-FR-72); once per gym and month.
    name: 'gym-manage.monthly-report',
    queue: QUEUES.GYM,
    pattern: '0 8 1 * *',
    tz: 'Asia/Dhaka',
    run: async () => gymManage.monthlyReport(),
  },
  {
    // M27: locker rentals ending soon are reminded and ended ones free their lockers; products near
    // their expiry date alert the gym once; machines due for service are reminded once (M27-FR-85)
    // (09:00 Dhaka, after the morning's renewal reminders).
    name: 'gym-ops.daily',
    queue: QUEUES.GYM,
    pattern: '5 9 * * *',
    tz: 'Asia/Dhaka',
    run: async () => gymOpsJobs.daily(),
  },
  {
    // M27 round 2: class sessions made ahead from the weekly slots (FR-47) and points past their date expire (FR-60).
    name: 'gym-ops.classes-points-daily',
    queue: QUEUES.GYM,
    pattern: '20 3 * * *',
    tz: 'Asia/Dhaka',
    run: async () => gymOpsJobs.classesAndPoints(),
  },
  {
    // M27-FR-53: the reminder before each class, once.
    name: 'gym-ops.class-reminders',
    queue: QUEUES.GYM,
    pattern: '*/15 * * * *',
    tz: 'Asia/Dhaka',
    run: async () => gymOpsJobs.classReminders(),
  },
  {
    // M27-FR-73: staff clock-ins left open past gym_ops.staff_auto_clockout_hours close by themselves (no hours).
    name: 'gym-ops.staff-clockout',
    queue: QUEUES.GYM,
    pattern: '10 * * * *',
    tz: 'Asia/Dhaka',
    run: async () => gymOpsJobs.staffClockout(),
  },
  {
    // M27-FR-42: visits left open past gym_manage.visit_auto_close_hours close by themselves.
    name: 'gym-manage.visits-close',
    queue: QUEUES.GYM,
    pattern: '*/30 * * * *',
    tz: 'Asia/Dhaka',
    run: async () => require('../modules/gym-manage/visits.service').closeStale(),
  },
  {
    // Renewal due, ends today, expired and overdue reminders (§6.9); the once-key first (M24-FR-56).
    name: 'gym-manage.reminders',
    queue: QUEUES.GYM,
    pattern: '0 9 * * *',
    tz: 'Asia/Dhaka',
    run: async () => gymManage.reminders(),
  },
  {
    // Invoice reminders (3 days before, on the day), overdue, past_due and restricted (M24-FR-86).
    name: 'gym-manage.invoice-dunning',
    queue: QUEUES.GYM,
    pattern: '0 10 * * *',
    tz: 'Asia/Dhaka',
    run: async () => gymManage.invoiceDunning(),
  },
  {
    // The owner's morning summary at or after gym_manage.morning_summary_time, once a day per gym (M24-FR-60).
    name: 'gym-manage.morning-summary',
    queue: QUEUES.GYM,
    every: 15 * 60 * 1000,
    run: async () => gymManage.morningSummary(),
  },
  {
    // M24 trial visits: no-shows, then the gym's guests-today list and the guests' reminders at or after
    // gym_manage.morning_summary_time, once a day each (the send-once log, kinds guests_today and visit_reminder).
    name: 'gym-manage.visits-daily',
    queue: QUEUES.GYM,
    every: 15 * 60 * 1000,
    run: async () => gymManage.visitsDaily(),
  },
  {
    // Fee overrides past valid_to → ended (M24-FR-94).
    name: 'gym-manage.overrides-end',
    queue: QUEUES.GYM,
    every: 15 * 60 * 1000,
    run: async () => gymManage.overridesEnd(),
  },
  {
    // Open payment links past expires_at → expired (§8.5).
    name: 'gym-manage.links-expire',
    queue: QUEUES.GYM,
    every: 5 * 60 * 1000,
    run: async () => gymManage.linksExpire(),
  },
  {
    // Online fees past gym_manage.online_fee_release_hours → released to the owner with the provider charge (M24-FR-44).
    name: 'gym-manage.online-fee-release',
    queue: QUEUES.GYM,
    every: 5 * 60 * 1000,
    run: async () => gymManage.onlineFeeRelease(),
  },
  // ---------------- M22 organiser SaaS (§10). Idempotent: every step locks the row and re-checks its status.
  {
    // Flat-fee invoices per month or quarter (one per period), overdue invoices, contract expiry and
    // its reminder. Prize funds settle inside M21's finalise and cancel, not here.
    name: 'saas.tick',
    queue: QUEUES.SAAS,
    every: 60 * 1000,
    run: async () => saas.tick(),
  },
  {
    // M23: big events. Follow alerts when an event starts and before its final, the final's live feed
    // item, polls past closes_at, and qualified places nobody took once the final's registration closed.
    name: 'esports_events.tick',
    queue: QUEUES.ESPORTS_EVENTS,
    every: 60 * 1000,
    run: async () => esportsEvents.tick(),
  },
  {
    // M16: team invites past their expiry (accept re-checks the time anyway).
    name: 'teams.tick',
    queue: QUEUES.TEAMS,
    every: 5 * 60 * 1000,
    run: async () => teamsJobs.tick(),
  },
  {
    // M14: registration closes at its time, unpaid holds and lapsed offers end (places go to the
    // next reserve team), unlocked rules lock again.
    name: 'tournaments.tick',
    queue: QUEUES.TOURNAMENTS,
    every: 60 * 1000,
    run: async () => tournamentsJobs.tick(),
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
    // M26-FR-08: open posts past their last day plus tournament_posts.expire_days_after_end. Idempotent.
    name: 'tournament_posts.tick',
    queue: QUEUES.TOURNAMENT_POSTS,
    every: 60 * 60 * 1000,
    run: async () => tournamentPostJobs.tick(),
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
