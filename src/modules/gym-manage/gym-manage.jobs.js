'use strict';

/**
 * M24 jobs of prompt 1 (§10), on the existing `gym` BullMQ queue (Render's Redis connection limit; one
 * worker serves M20 and M24). Every step re-reads its row under lock and re-checks the status, so a
 * second run the same day changes nothing (M24-FR-31, FR-39):
 *   gym-manage.daily              00:05 Dhaka  freezes start and end; upcoming → active; active → expired
 *                                              (an upcoming renewal then starts); member statuses follow
 *   gym-manage.dues-overdue       00:15        unpaid or partial dues past due_on: overdue_at once and
 *                                              gym_due.overdue_marked
 *   gym-manage.requests-expire    every 15 min pending link requests past expires_at → expired
 *   gym-manage.import-housekeeping 03:00       raw import files past retention deleted; stale previews discarded
 * Prompt 2 (online money, reminders and billing):
 *   gym-manage.active-count       00:45        yesterday's active members per owner; the tier notice once a month
 *   gym-manage.invoice-cycle      1st, 02:00   the owner invoices of the month before (in arrears)
 *   gym-manage.reconcile          04:00        the M24 invariants (drift to the logs)
 *   gym-manage.monthly-report     1st, 08:00   the owner's report of the month before, per gym
 *   gym-manage.reminders          09:00        renewal due, ends today, expired, overdue (once each)
 *   gym-manage.invoice-dunning    10:00        invoice reminders, overdue, past_due, restricted
 *   gym-manage.morning-summary    every 15 min at or after gym_manage.morning_summary_time, once a day per gym
 *   gym-manage.overrides-end      every 15 min fee overrides past valid_to → ended
 *   gym-manage.links-expire       every 5 min  open payment links past expires_at → expired
 *   gym-manage.online-fee-release every 5 min  paid links past release_at → M06 release with the provider charge
 * (No absent-scan job: the dashboard and the morning summary count "not seen" live.)
 */
const { Op } = require('sequelize');
const { sequelize, GymMember, GymMembership, GymFreeze, GymDue } = require('../../models');
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');
const memberships = require('./memberships.service');
const links = require('./links.service');
const imports = require('./imports.service');

/** Run one step for a membership with its member locked first (the lock order), in its own transaction. */
async function withMembership(membershipId, fn) {
  return sequelize.transaction(async (transaction) => {
    const plain = await GymMembership.findByPk(membershipId, { attributes: ['memberId'], transaction });
    if (!plain) return false;
    const member = await GymMember.findByPk(plain.memberId, { transaction, lock: transaction.LOCK.UPDATE });
    const ms = await GymMembership.findByPk(membershipId, { transaction, lock: transaction.LOCK.UPDATE });
    return fn({ member, ms, transaction });
  });
}

const msPayload = (ms) => ({ membershipId: ms.id, memberId: ms.memberId, gymId: ms.gymId });

/** Start an upcoming membership whose day has come (or expire it when the job missed all of it). */
async function startUpcoming({ member, ms, transaction }, today) {
  if (ms.status !== 'upcoming' || ms.startsOn > today) return false;
  if (await GymMembership.findOne({ where: { memberId: ms.memberId, status: memberships.RUNNING }, attributes: ['id'], transaction })) return false;
  const status = rules.statusByDate({ startsOn: ms.startsOn, endsOn: ms.endsOn, today });
  await ms.update({ status }, { transaction });
  if (status === 'active') {
    await c.publish(transaction, 'gym_membership.started', 'gym_membership', ms.id, { ...msPayload(ms), packageKind: ms.packageKind, startsOn: ms.startsOn, endsOn: ms.endsOn, userId: member.userId ?? null });
  } else {
    await c.publish(transaction, 'gym_membership.expired', 'gym_membership', ms.id, { ...msPayload(ms), endsOn: ms.endsOn });
  }
  await memberships.syncMemberStatus(member, { transaction });
  return true;
}

/** gym-manage.daily: the day's membership transitions (FR-28, FR-31). */
async function daily(now = new Date()) {
  const today = c.today(now);
  const out = { freezesStarted: 0, freezesEnded: 0, expired: 0, started: 0 };

  // Freezes whose first day has come.
  for (const f of await GymFreeze.findAll({ where: { status: 'scheduled', fromOn: { [Op.lte]: today } }, attributes: ['id', 'membershipId'] })) {
    const done = await withMembership(f.membershipId, async ({ member, ms, transaction }) => {
      const freeze = await GymFreeze.findByPk(f.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (freeze.status !== 'scheduled' || freeze.fromOn > today) return false;
      if (freeze.toOn < today || !['active', 'frozen'].includes(ms.status)) {
        // The whole freeze passed while the job did not run (its days were already added to the end).
        await freeze.update({ status: 'done' }, { transaction });
        return false;
      }
      await memberships.startFreeze(transaction, { ms, freeze, member });
      return true;
    });
    if (done) out.freezesStarted += 1;
  }

  // Freezes whose last day has passed.
  for (const f of await GymFreeze.findAll({ where: { status: 'active', toOn: { [Op.lt]: today } }, attributes: ['id', 'membershipId'] })) {
    const done = await withMembership(f.membershipId, async ({ member, ms, transaction }) => {
      const freeze = await GymFreeze.findByPk(f.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (freeze.status !== 'active' || freeze.toOn >= today) return false;
      await memberships.endFreezeIn(transaction, { ms, freeze, member, plan: { giveBack: 0 } });
      return true;
    });
    if (done) out.freezesEnded += 1;
  }

  // Running memberships past their end; an upcoming renewal of the same member starts in the same step.
  for (const row of await GymMembership.findAll({ where: { status: 'active', endsOn: { [Op.lt]: today } }, attributes: ['id'] })) {
    const done = await withMembership(row.id, async ({ member, ms, transaction }) => {
      if (ms.status !== 'active' || ms.endsOn >= today) return false;
      await ms.update({ status: 'expired' }, { transaction });
      await c.publish(transaction, 'gym_membership.expired', 'gym_membership', ms.id, { ...msPayload(ms), endsOn: ms.endsOn });
      const up = await GymMembership.findOne({ where: { memberId: ms.memberId, status: 'upcoming' }, transaction, lock: transaction.LOCK.UPDATE });
      if (up && (await startUpcoming({ member, ms: up, transaction }, today))) out.started += 1;
      await memberships.syncMemberStatus(member, { transaction });
      return true;
    });
    if (done) out.expired += 1;
  }

  // Upcoming memberships whose first day has come.
  for (const row of await GymMembership.findAll({ where: { status: 'upcoming', startsOn: { [Op.lte]: today } }, attributes: ['id'] })) {
    if (await withMembership(row.id, (ctx) => startUpcoming(ctx, today))) out.started += 1;
  }
  return out;
}

/** gym-manage.dues-overdue: overdue_at set once per due, with gym_due.overdue_marked (FR-39). */
async function duesOverdue(now = new Date(), batch = 500) {
  const today = c.today(now);
  let marked = 0;
  for (;;) {
    const n = await sequelize.transaction(async (transaction) => {
      const rows = await GymDue.findAll({ where: { status: ['unpaid', 'partial'], dueOn: { [Op.lt]: today }, overdueAt: null }, limit: batch, transaction, lock: transaction.LOCK.UPDATE, skipLocked: true });
      for (const d of rows) {
        const st = rules.dueState({ amount: d.amountPoisha, paid: d.paidPoisha, waived: d.waivedPoisha });
        await d.update({ overdueAt: now }, { transaction });
        await c.publish(transaction, 'gym_due.overdue_marked', 'gym_due', d.id, { dueId: d.id, memberId: d.memberId, gymId: d.gymId, outstanding: st.outstanding, dueOn: d.dueOn });
      }
      return rows.length;
    });
    marked += n;
    if (n < batch) break;
  }
  return { marked };
}

const requestsExpire = async (now = new Date()) => ({ expired: await links.expireDue(now) });
const importHousekeeping = (now = new Date()) => imports.housekeeping(now);

// ---------------------------------------------------------------- prompt 2
const reminders = (now = new Date()) => require('./reminders.service').run(now);
const morningSummary = (now = new Date()) => require('./reminders.service').morningSummary(now);
const monthlyReport = (now = new Date()) => require('./reminders.service').monthlyReport(now);
const activeCount = (now = new Date()) => require('./invoices.service').activeCount(now);
const invoiceCycle = (now = new Date()) => require('./invoices.service').cycle(now);
const invoiceDunning = (now = new Date()) => require('./invoices.service').dunning(now);
const linksExpire = (now = new Date()) => require('./links-pay.service').expireLinks(now);
const onlineFeeRelease = (now = new Date()) => require('./links-pay.service').releaseDue(now);
const overridesEnd = (now = new Date()) => require('./fees.service').overridesEnd(now);
const reconcile = () => require('./invariants').reconcile();

module.exports = { daily, duesOverdue, requestsExpire, importHousekeeping, reminders, morningSummary, monthlyReport, activeCount, invoiceCycle, invoiceDunning, linksExpire, onlineFeeRelease, overridesEnd, reconcile };
