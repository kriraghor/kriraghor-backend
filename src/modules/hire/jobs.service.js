'use strict';

/**
 * M11 jobs (FR-30 to FR-36, FR-50, FR-51, v3).
 *  - Pro, on match day: check in (from hire.checkin_open_before_min before the start; late after
 *    hire.late_before_start_min before), start (from hire.toss_open_before_min before), mark complete
 *    (a work note; the result for a match). Marking complete starts the auto-release clock.
 *  - Manager: confirm (the job's escrow hold is released to the pro's payable minus fees.hire_pct on
 *    the quote; M07 pays it out daily), cancel with a fee preview (§6.6: free over 72 h, 25% to 24 h,
 *    50% under; the fee goes to the pro minus the platform's share), report a no-show (from
 *    hire.no_show_after_min after the start without a check-in) or a problem with the work (once
 *    marked complete) as an M17 dispute: the hold freezes until staff decide.
 *  - Pro withdrawal: the manager gets 100% back (penalties and reliability come in step 2, Q72).
 *  - No action within hire.auto_release_hours of the completion mark and no dispute: released
 *    automatically by the tick.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, HireJob, HireRequest } = require('../../models');
const audit = require('../audit').audit;
const requests = require('./requests.service');
const rules = require('./hire.rules');
const c = require('./hire.common');

const { fail } = c;

async function mine(principal, id, side, transaction) {
  const j = transaction ? await c.lockJob(id, transaction) : await HireJob.findByPk(id);
  if (!j || (side === 'pro' ? j.proUserId : j.hirerId) !== principal.id) throw fail('NOT_A_PARTY');
  return j;
}

const move = (action, j, actor) => {
  const to = rules.nextJob(action, j.status, actor);
  if (!to) throw fail('JOB_STATE', { status: j.status });
  return to;
};

/** Release what the job still holds to the pro (fee on the quote), and mark it released. */
async function releaseJob(j, by, { actor = null, transaction }) {
  const moved = await c.release(j, c.heldOf(j), { feeBase: j.quotePoisha - j.refundedPoisha, actor, transaction });
  await j.update({ status: 'released', releasedAt: new Date(), releasedBy: by, releaseAt: null }, { transaction });
  await c.publishJob(transaction, 'hire_job.released', j, { by, gross: moved.gross, fee: moved.fee, net: moved.net }, actor);
  await requests.syncRequest(j.requestId, { transaction });
  return moved;
}

// ---------------------------------------------------------------- pro

/** GET /pro/jobs?from&to: my jobs (today and coming up by default), each with its request code and the actions open now. */
async function listForPro(principal, { from, to } = {}) {
  const start = from ? new Date(from) : new Date(Date.now() - 86400000);
  const rows = await HireJob.findAll({ where: { proUserId: principal.id, startAt: { [Op.gte]: start, ...(to ? { [Op.lt]: new Date(to) } : {}) }, status: { [Op.ne]: 'void' } }, order: [['startAt', 'ASC']], limit: 200 });
  const codes = new Map((await HireRequest.findAll({ where: { id: [...new Set(rows.map((j) => j.requestId))] }, attributes: ['id', 'code'] })).map((r) => [r.id, r.code]));
  return { items: rows.map((j) => ({ ...c.jobView(j), requestCode: codes.get(j.requestId), can: c.jobCan(j, 'pro') })) };
}

async function checkIn(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const j = await mine(principal, id, 'pro', transaction);
    const to = move('check_in', j, 'pro');
    const cfg = c.config();
    const w = rules.checkIn({ now: new Date(), start: j.startAt, end: j.endAt, openMin: cfg.checkinOpenMin, lateMin: cfg.lateMin });
    if (w.block) throw fail(w.block);
    await j.update({ status: to, checkedInAt: new Date(), late: w.late }, { transaction });
    await c.publishJob(transaction, 'hire_job.check_in_recorded', j, { late: w.late }, principal);
    await audit.record({ action: 'hire_job.check_in_recorded', actor: principal, entityType: 'hire_job', entityId: j.id, entityCode: j.code, after: { late: w.late }, req }, { transaction });
    return c.jobView(j);
  });
}

async function start(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const j = await mine(principal, id, 'pro', transaction);
    const to = move('start', j, 'pro');
    const block = rules.startBlock({ now: new Date(), start: j.startAt, openMin: c.config().startOpenMin });
    if (block) throw fail(block);
    await j.update({ status: to, startedAt: new Date() }, { transaction });
    await c.publishJob(transaction, 'hire_job.started', j, {}, principal);
    await audit.record({ action: 'hire_job.started', actor: principal, entityType: 'hire_job', entityId: j.id, entityCode: j.code, req }, { transaction });
    return c.jobView(j);
  });
}

/** POST /pro/jobs/:id/complete { note?, result? }: the work is done; the manager confirms (or 48 h). */
async function complete(principal, id, { note = null, result = null } = {}, req) {
  return sequelize.transaction(async (transaction) => {
    const j = await mine(principal, id, 'pro', transaction);
    const to = move('complete', j, 'pro');
    const now = new Date();
    const releaseAt = rules.releaseAt({ completedAt: now, autoHours: c.config().autoReleaseHours });
    await j.update({ status: to, completedAt: now, workNote: note, resultText: result, releaseAt }, { transaction });
    await c.publishJob(transaction, 'hire_job.completed_marked', j, { releaseAt: releaseAt.toISOString() }, principal);
    await audit.record({ action: 'hire_job.completed_marked', actor: principal, entityType: 'hire_job', entityId: j.id, entityCode: j.code, req }, { transaction });
    return c.jobView(j);
  });
}

/** POST /pro/jobs/:id/withdraw { reason }: the manager is refunded 100% (FR-51). */
async function withdraw(principal, id, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const j = await mine(principal, id, 'pro', transaction);
    const to = move('withdraw', j, 'pro');
    const refunded = await c.refund(j, c.heldOf(j), { reasonCode: 'pro_withdrew', key: `hire_job:${j.id}:withdraw`, actor: principal, transaction });
    await j.update({ status: to, cancelledAt: new Date(), cancelledBy: 'pro', cancelReason: reason }, { transaction });
    await c.publishJob(transaction, 'hire_job.withdrawn', j, { refund: refunded, reason }, principal);
    await requests.syncRequest(j.requestId, { transaction });
    await audit.record({ action: 'hire_job.withdrawn', actor: principal, entityType: 'hire_job', entityId: j.id, entityCode: j.code, after: { refund: refunded, reason }, req }, { transaction });
    return c.jobView(j);
  });
}

// ---------------------------------------------------------------- manager

/** POST /me/hire-jobs/:id/confirm: the work is done; the pro is paid. */
async function confirm(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const j = await mine(principal, id, 'hirer', transaction);
    move('confirm', j, 'hirer');
    const moved = await releaseJob(j, 'hirer', { actor: principal, transaction });
    await audit.record({ action: 'hire_job.released', actor: principal, entityType: 'hire_job', entityId: j.id, entityCode: j.code, after: { by: 'hirer', gross: moved.gross, fee: moved.fee }, req }, { transaction });
    return c.jobView(j);
  });
}

/** The cancellation plan now, at the fee rate the request snapshotted. */
async function planFor(j, { transaction } = {}) {
  const cfg = c.config();
  const { feeBps } = await HireRequest.findByPk(j.requestId, { attributes: ['feeBps'], transaction });
  return rules.cancelPlan({ now: new Date(), start: j.startAt, quote: c.heldOf(j), freeHours: cfg.cancelFreeHours, highHours: cfg.cancelHighHours, pctMid: cfg.cancelPctMid, pctHigh: cfg.cancelPctHigh, feeBps });
}

/** GET /me/hire-jobs/:id/cancel-preview. */
async function cancelPreview(principal, id) {
  const j = await mine(principal, id, 'hirer');
  if (!rules.nextJob('cancel', j.status, 'hirer')) throw fail('JOB_STATE', { status: j.status });
  return planFor(j);
}

/** POST /me/hire-jobs/:id/cancel: the fee tier applies; the rest is refunded (FR-50). */
async function cancel(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const j = await mine(principal, id, 'hirer', transaction);
    const to = move('cancel', j, 'hirer');
    const plan = await planFor(j, { transaction });
    const refunded = await c.refund(j, plan.refund, { reasonCode: 'hirer_cancelled', key: `hire_job:${j.id}:cancel`, actor: principal, transaction });
    const moved = plan.cancelFee > 0 ? await c.release(j, plan.cancelFee, { feeBase: plan.cancelFee, actor: principal, transaction }) : { gross: 0, fee: 0, net: 0 };
    await j.update({ status: to, cancelledAt: new Date(), cancelledBy: 'hirer', cancelReason: `cancel_${plan.tier}`, cancelFeePoisha: plan.cancelFee }, { transaction });
    await c.publishJob(transaction, 'hire_job.cancelled', j, { by: 'hirer', refund: refunded, fee: plan.cancelFee, proGets: moved.net }, principal);
    await requests.syncRequest(j.requestId, { transaction });
    await audit.record({ action: 'hire_job.cancelled', actor: principal, entityType: 'hire_job', entityId: j.id, entityCode: j.code, after: { tier: plan.tier, refund: refunded, fee: plan.cancelFee }, req }, { transaction });
    return { job: c.jobView(j), plan };
  });
}

/** POST /me/hire-jobs/:id/no-show | /problem { statement } (Idempotency-Key): an M17 dispute. */
async function dispute(principal, id, category, { statement }, idempotencyKey, req) {
  const j = await mine(principal, id, 'hirer');
  return require('../trust').disputes.open(principal, { sourceType: 'hire_job', sourceId: j.id, category, statement }, idempotencyKey, req);
}

// ---------------------------------------------------------------- staff

/** POST /admin/hire/jobs/:id/cancel { reason } (master, step-up): a full refund. */
async function platformCancel(actor, id, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const j = await c.lockJob(id, transaction);
    if (!j) throw E.notFound('Job');
    const to = move('platform_cancel', j, 'staff');
    const refunded = await c.refund(j, c.heldOf(j), { reasonCode: 'platform_cancelled', key: `hire_job:${j.id}:platform`, actor, transaction });
    await j.update({ status: to, cancelledAt: new Date(), cancelledBy: 'staff', cancelReason: 'platform' }, { transaction });
    await c.publishJob(transaction, 'hire_job.cancelled', j, { by: 'staff', refund: refunded, fee: 0, proGets: 0 }, actor);
    await requests.syncRequest(j.requestId, { transaction });
    await audit.record({ action: 'hire_job.platform_cancelled', actor, entityType: 'hire_job', entityId: j.id, entityCode: j.code, after: { refund: refunded }, reason, stepUp: true, req }, { transaction });
    return c.jobView(j);
  });
}

// ---------------------------------------------------------------- tick

/** Completion marks past release_at with no dispute: released automatically; check-in reminders. */
async function sweep(now = new Date()) {
  const out = { released: 0, reminded: 0 };
  const due = await HireJob.findAll({ where: { status: 'completed_marked', releaseAt: { [Op.lte]: now } }, attributes: ['id'], limit: 200 });
  for (const { id } of due) {
    await sequelize.transaction(async (transaction) => {
      const j = await c.lockJob(id, transaction);
      if (j.status !== 'completed_marked') return;
      move('auto_release', j, 'system');
      await releaseJob(j, 'auto', { transaction });
      out.released += 1;
    });
  }
  const openMin = c.config().checkinOpenMin;
  const soon = await HireJob.findAll({ where: { status: 'scheduled', remindedAt: null, startAt: { [Op.lte]: new Date(now.getTime() + openMin * 60000), [Op.gt]: now } }, attributes: ['id'], limit: 200 });
  for (const { id } of soon) {
    await sequelize.transaction(async (transaction) => {
      const j = await c.lockJob(id, transaction);
      if (j.status !== 'scheduled' || j.remindedAt) return;
      await j.update({ remindedAt: now }, { transaction });
      await c.publishJob(transaction, 'hire_job.checkin_opened', j, { start: c.iso(j.startAt) });
      out.reminded += 1;
    });
  }
  return out;
}

/** GET /me/hire-jobs/:id or /pro/jobs/:id: one job with what the viewer can do. */
async function getOne(principal, id) {
  const j = await HireJob.findByPk(id);
  if (!j || (j.hirerId !== principal.id && j.proUserId !== principal.id)) throw fail('NOT_A_PARTY');
  const r = await HireRequest.findByPk(j.requestId, { attributes: ['code'] });
  return { ...c.jobView(j), requestCode: r.code, can: c.jobCan(j, j.hirerId === principal.id ? 'hirer' : 'pro') };
}

module.exports = { listForPro, checkIn, start, complete, withdraw, confirm, cancelPreview, cancel, dispute, platformCancel, sweep, releaseJob, getOne };
