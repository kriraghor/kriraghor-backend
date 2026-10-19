'use strict';

/**
 * M11's side of the M17 targets port (source 'hire_job'). The manager who paid can dispute:
 *   no_show      no check-in hire.no_show_after_min after the start, until hire.dispute_window_hours
 *                after the end (FR-35)
 *   job_problem  once the pro marks the job complete, before the money is released
 * Opening moves the job to disputed and freezes its escrow hold, so neither the manager's confirm nor
 * the auto-release can pay it out; withdrawing puts it back. The decision refunds from the job's split
 * and releases the rest to the pro, the fee capped at the job's quote (feeBaseMax).
 */
const { HireJob, HireProfile } = require('../../models');
const { fail } = require('../trust/trust.errors');
const escrow = require('../payments').escrow;
const taxonomy = require('../catalog/hire.reads');
const rules = require('./hire.rules');
const c = require('./hire.common');

const CATEGORIES = ['no_show', 'job_problem'];

function evaluate(j, category, now) {
  if (!CATEGORIES.includes(category)) return { block: 'DISPUTE_NOT_ELIGIBLE' };
  const cfg = c.config();
  if (category === 'no_show') {
    if (!rules.ACTIVE_JOB.includes(j.status)) return { block: 'DISPUTE_NOT_ELIGIBLE' };
    const block = rules.noShowBlock({ now, start: j.startAt, end: j.endAt, checkedIn: Boolean(j.checkedInAt), afterMin: cfg.noShowAfterMin, windowHours: cfg.disputeWindowHours });
    if (block) return { block: block === 'CHECKED_IN' || block === 'NO_SHOW_NOT_YET' ? 'DISPUTE_NOT_ELIGIBLE' : block };
    return { money: true, held: c.heldOf(j), closesAt: new Date(new Date(j.endAt).getTime() + cfg.disputeWindowHours * 3600000) };
  }
  const block = rules.problemBlock({ status: j.status });
  if (block) return { block };
  return { money: true, held: c.heldOf(j), closesAt: j.releaseAt };
}

async function snapshot({ sourceId, category, principal, transaction }) {
  const j = await c.lockJob(sourceId, transaction);
  if (!j) throw fail('DISPUTE_NOT_ELIGIBLE');
  if (j.hirerId !== principal.id) throw fail('NOT_YOUR_JOB');
  const e = evaluate(j, category, new Date());
  if (e.block) throw fail(e.block);
  return {
    ref: j.code,
    claimantId: j.hirerId,
    respondentId: j.proUserId,
    money: true,
    paid: j.quotePoisha,
    held: e.held,
    policyKey: `hire.${category}`,
    policy: { feeBps: j.quotePoisha ? Math.round((j.feePoisha * 10000) / j.quotePoisha) : 0, feeBaseMax: j.quotePoisha, quote: j.quotePoisha, start: c.iso(j.startAt), end: c.iso(j.endAt), status: j.status, checkedInAt: c.iso(j.checkedInAt), completedAt: c.iso(j.completedAt), closesAt: c.iso(e.closesAt) },
  };
}

/** GET /me/disputes/options: what the manager can open on this job now. */
async function options({ sourceId, principal }) {
  const j = await HireJob.findByPk(sourceId);
  if (!j || j.hirerId !== principal.id) return [];
  const now = new Date();
  return CATEGORIES.map((category) => ({ category, ...evaluate(j, category, now) }))
    .filter((o) => !o.block)
    .map((o) => ({ category: o.category, money: o.money, held: o.held, closesAt: c.iso(o.closesAt) }));
}

async function freeze({ sourceId, ref, actor, transaction }) {
  const j = await c.lockJob(sourceId, transaction);
  const to = rules.nextJob('dispute', j.status, 'hirer');
  if (!to) throw fail('DISPUTE_NOT_ELIGIBLE');
  const hold = await c.holdOf(j, transaction);
  if (hold && hold.status !== 'frozen') await escrow.freezeInTx(hold, { reason: 'dispute', ref, actor, transaction });
  await j.update({ status: to, disputeId: ref, releaseAt: null }, { transaction });
  await c.publishJob(transaction, 'hire_job.disputed', j, { disputeId: ref }, actor);
}

/** Back to where the job was (withdrawn case): the hold thaws; a completed job's clock restarts. */
async function unfreeze({ sourceId, actor, transaction }) {
  const j = await c.lockJob(sourceId, transaction);
  const hold = await c.holdOf(j, transaction);
  if (hold?.status === 'frozen') await escrow.unfreezeInTx(hold, { reason: 'dispute_closed', actor, transaction });
  if (j.status !== 'disputed') return;
  const back = j.completedAt ? 'completed_marked' : j.startedAt ? 'live' : j.checkedInAt ? 'checked_in' : 'scheduled';
  await j.update({ status: back, disputeId: null, ...(back === 'completed_marked' ? { releaseAt: rules.releaseAt({ completedAt: new Date(), autoHours: c.config().autoReleaseHours }) } : {}) }, { transaction });
}

/** The decision: refund part or all from the job's split, release the rest to the pro. */
async function applyOutcome({ sourceId, dispute, plan, actor, transaction }) {
  const j = await c.lockJob(sourceId, transaction);
  if (j.status !== 'disputed') throw fail('DISPUTE_SOURCE_CHANGED', { status: j.status });
  const hold = await c.holdOf(j, transaction);
  if (hold?.status === 'frozen') await escrow.unfreezeInTx(hold, { reason: 'dispute_closed', actor, transaction });
  const refunded = await c.refund(j, plan.refund, { reasonCode: `dispute_${dispute.category}`, key: `dispute:${dispute.id}`, kind: 'dispute', actor, transaction });
  let moved = { gross: 0, fee: 0, net: 0 };
  if (plan.release > 0) moved = await c.release(j, plan.release, { feeBase: plan.feeBase, actor, transaction });
  const to = rules.nextJob(plan.release > 0 ? 'dispute_release' : 'dispute_refund', j.status, 'dispute');
  await j.update({ status: to, ...(to === 'released' ? { releasedAt: new Date(), releasedBy: 'dispute' } : {}) }, { transaction });
  await c.publishJob(transaction, to === 'released' ? 'hire_job.released' : 'hire_job.refunded', j, { by: 'dispute', gross: moved.gross, fee: moved.fee, net: moved.net, refund: refunded }, actor);
  await require('./requests.service').syncRequest(j.requestId, { transaction });
  return { refunded, released: moved.gross, fee: moved.fee };
}

/** The job as the desk and the parties see it (no phone numbers). */
async function describe(sourceId) {
  const j = await HireJob.findByPk(sourceId);
  if (!j) return null;
  const p = await HireProfile.findByPk(j.profileId, { attributes: ['headline', 'roleId', 'slug'] });
  const role = await taxonomy.role(p.roleId);
  return {
    kind: 'hire_job',
    id: j.id,
    code: j.code,
    status: j.status,
    profileHeadline: p.headline,
    roleEn: role?.nameEn ?? '',
    roleBn: role?.nameBn ?? '',
    start: c.iso(j.startAt),
    end: c.iso(j.endAt),
    venue: j.venueText,
    checkedInAt: c.iso(j.checkedInAt),
    late: j.late,
    startedAt: c.iso(j.startedAt),
    completedAt: c.iso(j.completedAt),
    workNote: j.workNote ?? null,
    money: { quote: j.quotePoisha, refunded: j.refundedPoisha, released: j.releasedPoisha },
  };
}

function register() {
  require('../trust/targets.port').register('hire_job', { permission: 'resolve_reports', snapshot, options, freeze, unfreeze, applyOutcome, describe });
}

module.exports = { register, evaluate, snapshot, options, freeze, unfreeze, applyOutcome, describe };
