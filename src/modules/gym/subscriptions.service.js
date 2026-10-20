'use strict';

/**
 * M20 trainer monthly plans and subscriptions (v3; user decisions 18 Oct 2026).
 *  - A fitness trainer (an M11 hire profile in role fitness_trainer, live or paused) offers monthly
 *    plans on the pro desk: title, sessions a month (or as agreed), price within
 *    gym.trainer_plan_min/max_poisha, where (a listed gym, the member's area, or online).
 *  - Subscribe (gate subscribe_trainer, Idempotency-Key): a start date within
 *    gym.subscription_start_days; the first month is one M06 payment and one escrow hold (purpose
 *    trainer_subscription, payee the trainer).
 *  - Renewal is a manual payment (bKash auto-debit later): gym.subscription_renew_notice_days before
 *    the month ends the next month's row appears (the member is told); it can be paid until the end of
 *    gym.subscription_grace_days after the month. Paid → the months run back to back; not paid → the
 *    subscription lapses.
 *  - Cancel: in the first gym.subscription_cancel_days of a paid month, a full refund and the end;
 *    later, renewal stops and the subscription ends with the month.
 *  - Each month is released to the trainer minus fees.gym_pct disputes.window_trainer_hours after it
 *    ends, unless the member opened an M17 case (service_problem), which freezes it.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { nextCode } = require('../../common/sequences');
const { randomToken } = require('../../common/crypto');
const { sequelize, Gym, TrainerPlan, TrainerSubscription, TrainerSubscriptionPeriod } = require('../../models');
const { Area } = require('../catalog').reference;
const audit = require('../audit').audit;
const payments = require('../payments').intents;
const purposes = require('../payments').purposes;
const settings = require('../settings').settings;
const directory = require('../users').directory;
const hireReads = require('../hire').reads;
const { payUrl } = require('../payments').intents;
const rules = require('./gym.rules');
const c = require('./gym.common');

const { fail } = c;
const TRAINER_ROLE = 'fitness_trainer';
const PLAN_FIELDS = ['title', 'description', 'sessionsPerMonth', 'whereKind', 'gymId', 'areaId'];

// ---------------------------------------------------------------- plans (pro desk)

const planView = (p) => ({
  id: p.id,
  profileId: p.profileId,
  title: p.title,
  description: p.description ?? null,
  sessionsPerMonth: p.sessionsPerMonth ?? null,
  price: p.pricePoisha,
  where: p.whereKind,
  gymId: p.gymId ?? null,
  areaId: p.areaId ?? null,
  status: p.status,
});

async function trainerProfile(principal, profileId) {
  const p = await hireReads.profileRef(profileId);
  if (!p || p.userId !== principal.id || p.roleKey !== TRAINER_ROLE || !['live', 'paused'].includes(p.status)) throw fail('NOT_A_FITNESS_TRAINER');
  return p;
}

async function checkPlan(body, transaction) {
  const cfg = c.config();
  const errors = rules.planErrors({ price: body.price, where: body.whereKind, gymId: body.gymId, areaId: body.areaId }, { min: cfg.planMin, max: cfg.planMax });
  if (errors.length) throw E.validation(errors);
  if (body.whereKind === 'gym') {
    const g = await Gym.findByPk(body.gymId, { attributes: ['status'], transaction });
    if (!g || !['live', 'paused'].includes(g.status)) throw E.validation([{ field: 'gymId', message: 'Choose a listed gym' }]);
  }
  if (body.whereKind === 'home' && !(await Area.findByPk(body.areaId, { attributes: ['id'], transaction }))) throw E.validation([{ field: 'areaId', message: 'Choose an area' }]);
}

/** GET /pro/trainer-plans: my plans (all my fitness trainer profiles). */
async function listPlans(principal) {
  const profiles = await hireReads.profilesOf(principal.id, TRAINER_ROLE);
  const rows = await TrainerPlan.findAll({ where: { trainerId: principal.id }, order: [['createdAt', 'ASC']] });
  return { profiles: profiles.map((p) => ({ id: p.id, slug: p.slug, headline: p.headline, status: p.status })), items: rows.map(planView) };
}

/** POST /pro/trainer-plans. */
async function createPlan(principal, body, req) {
  await trainerProfile(principal, body.profileId);
  return sequelize.transaction(async (transaction) => {
    await checkPlan(body, transaction);
    const plan = await TrainerPlan.create(
      { profileId: body.profileId, trainerId: principal.id, pricePoisha: body.price, ...Object.fromEntries(PLAN_FIELDS.map((k) => [k, body[k] ?? null])), createdBy: principal.id, updatedBy: principal.id },
      { transaction }
    );
    await audit.record({ action: 'trainer_plan.created', actor: principal, entityType: 'trainer_plan', entityId: plan.id, after: { price: plan.pricePoisha, where: plan.whereKind }, req }, { transaction });
    return planView(plan);
  });
}

/** PATCH /pro/trainer-plans/:id: a new price applies to new subscriptions only. */
async function updatePlan(principal, id, patch, req) {
  return sequelize.transaction(async (transaction) => {
    const plan = await TrainerPlan.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!plan || plan.trainerId !== principal.id) throw E.notFound('Plan');
    if (plan.status !== 'active') throw fail('PLAN_NOT_AVAILABLE');
    const next = { price: patch.price ?? plan.pricePoisha, whereKind: patch.whereKind ?? plan.whereKind, gymId: patch.gymId ?? plan.gymId, areaId: patch.areaId ?? plan.areaId };
    await checkPlan(next, transaction);
    await plan.update({ ...Object.fromEntries(PLAN_FIELDS.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]])), pricePoisha: next.price, updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'trainer_plan.updated', actor: principal, entityType: 'trainer_plan', entityId: plan.id, after: { price: plan.pricePoisha }, req }, { transaction });
    return planView(plan);
  });
}

/** POST /pro/trainer-plans/:id/retire: no new members or renewals; paid months run out. */
async function retirePlan(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const plan = await TrainerPlan.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!plan || plan.trainerId !== principal.id) throw E.notFound('Plan');
    if (plan.status !== 'retired') {
      await plan.update({ status: 'retired', updatedBy: principal.id }, { transaction });
      await TrainerSubscription.update({ renew: false }, { where: { planId: plan.id, status: 'active' }, transaction });
      await audit.record({ action: 'trainer_plan.retired', actor: principal, entityType: 'trainer_plan', entityId: plan.id, req }, { transaction });
    }
    return planView(plan);
  });
}

/** Active plans of a profile (public, for /hiring/[slug] and the gym hub). */
async function plansOf(profileId) {
  const rows = await TrainerPlan.findAll({ where: { profileId, status: 'active' }, order: [['pricePoisha', 'ASC']] });
  const cfg = c.config();
  return { items: rows.map(planView), today: c.today(), startDays: cfg.startDays, cancelDays: cfg.cancelDays };
}

// ---------------------------------------------------------------- subscriptions

/** The month a subscription is in (paid or not), and the next one if it already exists. */
async function periodsOf(subId, { transaction } = {}) {
  return TrainerSubscriptionPeriod.findAll({ where: { subscriptionId: subId }, order: [['seq', 'ASC']], transaction });
}

function periodView(p) {
  return {
    id: p.id,
    seq: p.seq,
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    status: p.status,
    price: p.pricePoisha,
    payBy: c.iso(p.payBy),
    releaseAt: c.iso(p.releaseAt),
    released: p.releasedPoisha,
    refunded: p.refundedPoisha,
    disputeId: p.disputeId ?? null,
  };
}

async function subView(s, viewer, { transaction } = {}) {
  const periods = await periodsOf(s.id, { transaction });
  const cfg = c.config();
  const today = c.today();
  const paid = periods.filter((p) => ['paid', 'released', 'disputed'].includes(p.status));
  const current = paid.at(-1) ?? null;
  const next = periods.find((p) => p.status === 'pending_payment' && (!current || p.seq > current.seq)) ?? null;
  const other = viewer === s.memberId ? s.trainerId : s.memberId;
  const names = await directory.publicNames([other]);
  const phase = s.status === 'active' && current ? rules.renewalPhase({ today, periodEnd: current.periodEnd, noticeDays: cfg.noticeDays, graceDays: cfg.graceDays }) : s.status;
  return {
    id: s.id,
    code: s.code,
    status: s.status,
    phase,
    role: viewer === s.memberId ? 'member' : 'trainer',
    title: s.title,
    sessionsPerMonth: s.sessionsPerMonth ?? null,
    price: s.pricePoisha,
    other: { name: names.get(other)?.displayName ?? null },
    startedOn: s.startedOn,
    paidThrough: s.paidThrough ?? null,
    renew: s.renew,
    current: current ? periodView(current) : null,
    next: next ? periodView(next) : null,
    payment: viewer === s.memberId && next?.paymentId ? { id: next.paymentId, payUrl: payUrl(next.paymentId) } : null,
    can: {
      pay: viewer === s.memberId && Boolean(next) && s.status !== 'void',
      cancel: viewer === s.memberId && ['pending_payment', 'active'].includes(s.status),
      refundOnCancel: viewer === s.memberId && Boolean(current && current.status === 'paid' && rules.inCancelWindow({ today, periodStart: current.periodStart, cancelDays: cfg.cancelDays })),
      problem: viewer === s.memberId && Boolean(current && current.status === 'paid' && today >= current.periodStart && new Date() < current.releaseAt),
    },
    endedAt: c.iso(s.endedAt),
    endReason: s.endReason ?? null,
  };
}

async function own(principal, idOrCode, { transaction, lock = false } = {}) {
  const where = /^[0-9a-f-]{36}$/i.test(idOrCode) ? { id: idOrCode } : { code: idOrCode };
  const s = await TrainerSubscription.findOne({ where, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!s || (s.memberId !== principal.id && s.trainerId !== principal.id)) throw E.notFound('Subscription');
  return s;
}

/** A month's payment intent (payee the trainer); the fee is M06's snapshot. */
async function intentFor(s, period, { transaction }) {
  const payBy = new Date(Date.now() + c.config().payMinutes * 60000);
  const p = await payments.createIntent(
    {
      purpose: 'trainer_subscription',
      purposeId: period.id,
      payerId: s.memberId,
      payeeId: s.trainerId,
      amount: period.pricePoisha,
      title: `${s.title} · ${period.periodStart} to ${period.periodEnd}`,
      expiresAt: period.payBy && period.payBy < payBy ? period.payBy : payBy,
      // A renewal may need a new intent after an earlier one expired, so each attempt has its own key.
      idempotencyKey: `trainer_period:${period.id}:${randomToken(6)}`,
    },
    { transaction }
  );
  const m = rules.money(period.pricePoisha, p.escrow.fee.feeBps);
  await period.update({ paymentId: p.id, feeBps: p.escrow.fee.feeBps, feePoisha: m.fee, netPoisha: m.net }, { transaction });
  return p;
}

/** POST /gym/subscriptions { planId, startDate } [Idempotency-Key]. */
async function subscribe(principal, { planId, startDate }, idempotencyKey, req) {
  const again = () => TrainerSubscription.findOne({ where: { memberId: principal.id, idempotencyKey } });
  const prior = await again();
  if (prior) return subView(prior, principal.id);
  const cfg = c.config();
  const today = c.today();
  try {
    const s = await sequelize.transaction(async (transaction) => {
      const plan = await TrainerPlan.findByPk(planId, { transaction, lock: transaction.LOCK.SHARE });
      if (!plan || plan.status !== 'active') throw fail('PLAN_NOT_AVAILABLE');
      const profile = await hireReads.profileRef(plan.profileId, { transaction });
      if (!profile || profile.status !== 'live') throw fail('PLAN_NOT_AVAILABLE');
      if (plan.trainerId === principal.id) throw fail('OWN_PLAN');
      const block = rules.startBlock({ start: startDate, today, startDays: cfg.startDays });
      if (block) throw fail(block);
      if (await TrainerSubscription.findOne({ where: { planId, memberId: principal.id, status: ['pending_payment', 'active'] }, transaction })) throw fail('ALREADY_SUBSCRIBED');
      const sub = await TrainerSubscription.create(
        { code: await nextCode('TS', transaction), planId, profileId: plan.profileId, memberId: principal.id, trainerId: plan.trainerId, title: plan.title, sessionsPerMonth: plan.sessionsPerMonth ?? null, pricePoisha: plan.pricePoisha, startedOn: startDate, idempotencyKey },
        { transaction }
      );
      const { periodStart, periodEnd } = rules.periodOf(startDate, cfg.subscriptionDays);
      const period = await TrainerSubscriptionPeriod.create(
        { subscriptionId: sub.id, seq: 1, periodStart, periodEnd, pricePoisha: sub.pricePoisha, feeBps: 0, feePoisha: 0, netPoisha: sub.pricePoisha, payBy: new Date(Date.now() + cfg.payMinutes * 60000) },
        { transaction }
      );
      await intentFor(sub, period, { transaction });
      await audit.record({ action: 'trainer_subscription.created', actor: principal, entityType: 'trainer_subscription', entityId: sub.id, entityCode: sub.code, after: { price: sub.pricePoisha, startedOn: startDate }, req }, { transaction });
      return sub;
    });
    return subView(s, principal.id);
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const row = await again();
      if (row) return subView(row, principal.id);
      throw fail('ALREADY_SUBSCRIBED');
    }
    throw err;
  }
}

/** M06 purpose hook (inside the capture transaction): the month is paid; a first month starts the subscription. */
async function onCaptured({ payment, transaction }) {
  const period = await TrainerSubscriptionPeriod.findOne({ where: { paymentId: payment.id }, transaction, lock: transaction.LOCK.UPDATE });
  if (!period) return 'reject';
  if (['paid', 'released', 'disputed'].includes(period.status)) return 'accept';
  if (period.status !== 'pending_payment') return 'reject';
  const s = await c.lockSub(period.subscriptionId, transaction);
  if (!['pending_payment', 'active'].includes(s.status)) return 'reject';
  await period.update({ status: 'paid', paidAt: new Date(), payBy: null, releaseAt: rules.releaseAtOf(period.periodEnd, c.config().windowHours) }, { transaction });
  const first = s.status === 'pending_payment';
  await s.update({ status: 'active', paidThrough: period.periodEnd }, { transaction });
  await c.publishSub(transaction, first ? 'trainer_subscription.started' : 'trainer_subscription.renewed', s, { seq: period.seq, periodStart: period.periodStart, periodEnd: period.periodEnd, paymentId: payment.id });
  return 'accept';
}
purposes.register('trainer_subscription', { onCaptured });

/** payment.failed / payment.expired: a first month voids the subscription; a renewal can be paid again until the grace ends. */
async function onPaymentClosed(paymentId, { transaction }) {
  const period = await TrainerSubscriptionPeriod.findOne({ where: { paymentId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!period || period.status !== 'pending_payment') return null;
  if (period.seq > 1) {
    await period.update({ paymentId: null }, { transaction });
    return 'retry';
  }
  const s = await c.lockSub(period.subscriptionId, transaction);
  await period.update({ status: 'void', payBy: null }, { transaction });
  if (s.status === 'pending_payment') await s.update({ status: 'void', endedAt: new Date(), endReason: 'not_paid' }, { transaction });
  return 'void';
}

/** POST /me/subscriptions/:id/renew: the pay link of the next month (opens near the end of the month). */
async function renew(principal, id) {
  const s = await sequelize.transaction(async (transaction) => {
    const row = await own(principal, id, { transaction, lock: true });
    if (row.memberId !== principal.id) throw E.notFound('Subscription');
    const periods = await periodsOf(row.id, { transaction });
    const next = periods.find((p) => p.status === 'pending_payment');
    if (!next) throw fail(row.status === 'pending_payment' ? 'SUBSCRIPTION_STATE' : 'RENEWAL_NOT_OPEN');
    if (!next.paymentId) await intentFor(row, next, { transaction });
    return row;
  });
  return subView(s, principal.id);
}

/** POST /me/subscriptions/:id/cancel: unpaid → void; first days of a paid month → full refund; later → no renewal. */
async function cancel(principal, id, req) {
  const s = await sequelize.transaction(async (transaction) => {
    const row = await own(principal, id, { transaction, lock: true });
    if (row.memberId !== principal.id) throw E.notFound('Subscription');
    const periods = await periodsOf(row.id, { transaction });
    const closeOpen = async () => {
      for (const p of periods.filter((x) => x.status === 'pending_payment')) {
        if (p.paymentId) {
          try {
            await payments.cancelIntent(p.paymentId, { transaction });
          } catch {
            // A capture that lands later is rejected by onCaptured and refunded in full by M06.
          }
        }
        await p.update({ status: 'void', payBy: null }, { transaction });
      }
    };
    if (row.status === 'pending_payment') {
      await closeOpen();
      await row.update({ status: 'void', endedAt: new Date(), endReason: 'member_cancelled' }, { transaction });
      return row;
    }
    if (row.status !== 'active') throw fail('SUBSCRIPTION_STATE');
    const current = periods.filter((p) => p.status === 'paid').at(-1);
    await closeOpen();
    if (current && rules.inCancelWindow({ today: c.today(), periodStart: current.periodStart, cancelDays: c.config().cancelDays })) {
      const period = await c.lockPeriod(current.id, transaction);
      const refunded = await c.refund(period, c.heldOf(period), { reasonCode: 'subscription_cancelled', key: `trainer_period:${period.id}:cancel`, actor: principal, transaction });
      await period.update({ status: 'refunded' }, { transaction });
      await row.update({ status: 'cancelled', renew: false, endedAt: new Date(), endReason: 'member_cancelled' }, { transaction });
      await c.publishSub(transaction, 'trainer_subscription.cancelled', row, { refund: refunded, seq: period.seq }, principal);
    } else {
      await row.update({ renew: false }, { transaction });
      await c.publishSub(transaction, 'trainer_subscription.cancelled', row, { refund: 0, endsOn: row.paidThrough }, principal);
    }
    await audit.record({ action: 'trainer_subscription.cancelled', actor: principal, entityType: 'trainer_subscription', entityId: row.id, entityCode: row.code, after: { status: row.status, renew: row.renew }, req }, { transaction });
    return row;
  });
  return subView(s, principal.id);
}

/** POST /me/subscriptions/:id/problem { statement } [Idempotency-Key]: an M17 case on the current month. */
async function problem(principal, id, { statement }, idempotencyKey, req) {
  const s = await own(principal, id);
  if (s.memberId !== principal.id) throw E.notFound('Subscription');
  const current = (await periodsOf(s.id)).filter((p) => p.status === 'paid').at(-1);
  if (!current) throw fail('SUBSCRIPTION_STATE');
  return require('../trust').disputes.open(principal, { sourceType: 'trainer_subscription', sourceId: current.id, category: 'service_problem', statement }, idempotencyKey, req);
}

/** GET /me/subscriptions (member) and GET /pro/subscriptions (trainer). */
async function listFor(principal, side) {
  const rows = await TrainerSubscription.findAll({ where: { [side === 'member' ? 'memberId' : 'trainerId']: principal.id, status: { [Op.ne]: 'void' } }, order: [['createdAt', 'DESC']], limit: 100 });
  return { items: await Promise.all(rows.map((s) => subView(s, principal.id))) };
}

const getOne = async (principal, id) => subView(await own(principal, id), principal.id);

/** Tick: renewal rows and notices, unpaid months, lapses and ends, and the monthly release. */
async function sweep(now = new Date()) {
  const cfg = c.config();
  const today = c.today(now);
  const grace = settings.get('payments.unknown_grace_minutes') * 60000;
  const out = { renewalsDue: 0, unpaidMonths: 0, lapsed: 0, ended: 0, released: 0 };

  // First months not paid in time: the subscription never starts.
  const unpaid = await TrainerSubscriptionPeriod.findAll({ where: { seq: 1, status: 'pending_payment', payBy: { [Op.lt]: new Date(now.getTime() - grace) } }, attributes: ['id', 'paymentId'] });
  for (const { id, paymentId } of unpaid) {
    await sequelize.transaction(async (transaction) => {
      const period = await c.lockPeriod(id, transaction);
      if (period.status !== 'pending_payment') return;
      if (paymentId) {
        try {
          await payments.cancelIntent(paymentId, { transaction });
        } catch {
          // A late capture is rejected by onCaptured and refunded by M06.
        }
      }
      await period.update({ status: 'void', payBy: null }, { transaction });
      const s = await c.lockSub(period.subscriptionId, transaction);
      if (s.status === 'pending_payment') await s.update({ status: 'void', endedAt: now, endReason: 'not_paid' }, { transaction });
      out.unpaidMonths += 1;
    });
  }

  const active = await TrainerSubscription.findAll({ where: { status: 'active' }, attributes: ['id'] });
  for (const { id } of active) {
    await sequelize.transaction(async (transaction) => {
      const s = await c.lockSub(id, transaction);
      if (s.status !== 'active' || !s.paidThrough) return;
      const periods = await periodsOf(s.id, { transaction });
      const pending = periods.find((p) => p.status === 'pending_payment');
      const phase = rules.renewalPhase({ today, periodEnd: s.paidThrough, noticeDays: cfg.noticeDays, graceDays: cfg.graceDays });
      if (!s.renew && today > s.paidThrough) {
        await s.update({ status: 'ended', endedAt: now, endReason: 'not_renewed' }, { transaction });
        await c.publishSub(transaction, 'trainer_subscription.ended', s);
        out.ended += 1;
        return;
      }
      if (phase === 'lapsed') {
        if (pending) {
          if (pending.paymentId) {
            try {
              await payments.cancelIntent(pending.paymentId, { transaction });
            } catch {
              // refunded by M06 if it lands
            }
          }
          await pending.update({ status: 'void', payBy: null }, { transaction });
        }
        await s.update({ status: 'lapsed', endedAt: now, endReason: 'not_paid' }, { transaction });
        await c.publishSub(transaction, 'trainer_subscription.lapsed', s);
        out.lapsed += 1;
        return;
      }
      if (s.renew && !pending && ['renewal_due', 'grace'].includes(phase)) {
        const start = rules.addDays(s.paidThrough, 1);
        const { periodStart, periodEnd } = rules.periodOf(start, cfg.subscriptionDays);
        const seq = periods.at(-1).seq + 1;
        await TrainerSubscriptionPeriod.create(
          { subscriptionId: s.id, seq, periodStart, periodEnd, pricePoisha: s.pricePoisha, feeBps: 0, feePoisha: 0, netPoisha: s.pricePoisha, payBy: rules.graceUntil(s.paidThrough, cfg.graceDays) },
          { transaction }
        );
        await c.publishSub(transaction, 'trainer_subscription.renewal_opened', s, { seq, periodStart, payBy: c.iso(rules.graceUntil(s.paidThrough, cfg.graceDays)) });
        out.renewalsDue += 1;
      }
    });
  }

  const due = await TrainerSubscriptionPeriod.findAll({ where: { status: 'paid', releaseAt: { [Op.lte]: now } }, attributes: ['id'] });
  for (const { id } of due) {
    await sequelize.transaction(async (transaction) => {
      const period = await c.lockPeriod(id, transaction);
      if (period.status !== 'paid' || !period.releaseAt || period.releaseAt > now) return;
      const moved = await c.release(period, { transaction, kind: 'escrow.release_trainer' });
      await period.update({ status: 'released' }, { transaction });
      const s = await TrainerSubscription.findByPk(period.subscriptionId, { transaction });
      await c.publishSub(transaction, 'trainer_subscription.released', s, { seq: period.seq, gross: moved.gross, fee: moved.fee, net: moved.net });
      out.released += 1;
    });
  }
  return out;
}

module.exports = { listPlans, createPlan, updatePlan, retirePlan, plansOf, subscribe, onCaptured, onPaymentClosed, renew, cancel, problem, listFor, getOne, sweep, subView, periodsOf, planView };
