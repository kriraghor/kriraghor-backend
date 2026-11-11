'use strict';

/**
 * M24 memberships (§5.3, §6.1, §8.3): assign, renew, freeze and unfreeze, change package, cancel.
 *  - A membership snapshots its package (title, kind, days, price, admission fee, visit limit), so a
 *    later price change never touches it (FR-25). Only active packages sold at the desk (`desk`, `both`).
 *  - At most one running (active or frozen) and one upcoming membership per member (partial unique
 *    indexes); an overlap answers 409 GYM_MEMBERSHIP_OVERLAP.
 *  - Each membership creates its due (FR-32) in the same transaction; a first payment may ride along
 *    (fees.collect).
 *  - The member's status follows (§8.1); every change locks the member row first, then memberships,
 *    then dues, then the settings row (one lock order for every path, so no deadlocks).
 */
const { UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, GymMember, GymMembership, GymFreeze, GymDue } = require('../../models');
const packagesFacade = require('../gym').packages;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');
const view = require('./gym-manage.serializer');
const dues = require('./dues.service');

const { fail } = c;
const RUNNING = ['active', 'frozen'];
const OPEN = ['active', 'frozen', 'upcoming'];

const lockMember = (gymId, memberId, transaction) => GymMember.findOne({ where: { id: memberId, gymId }, transaction, lock: transaction.LOCK.UPDATE });

async function lockedMember(gymId, memberId, transaction) {
  const m = await lockMember(gymId, memberId, transaction);
  if (!m) throw E.notFound('Member');
  return m;
}

/** A membership of the gym, with its member locked first (the lock order). */
async function lockedMembership(gymId, membershipId, transaction) {
  const plain = await GymMembership.findOne({ where: { id: membershipId, gymId }, attributes: ['id', 'memberId'], transaction });
  if (!plain) throw E.notFound('Membership');
  const member = await lockedMember(gymId, plain.memberId, transaction);
  const ms = await GymMembership.findByPk(membershipId, { transaction, lock: transaction.LOCK.UPDATE });
  return { member, ms };
}

/**
 * An active package of this gym sold at the desk (FR-25), else 422 GYM_PACKAGE_UNAVAILABLE. `anyChannel`:
 * also one sold only online, which is what a join request asks for and what such a member renews (FR-91).
 */
async function deskPackage(gymId, packageId, { transaction, anyChannel = false } = {}) {
  const pkg = await packagesFacade.get(packageId, { transaction });
  if (!pkg || pkg.gymId !== gymId || pkg.status !== 'active' || (pkg.channel === 'online' && !anyChannel)) throw fail('GYM_PACKAGE_UNAVAILABLE');
  return pkg;
}

const memberUsable = (member) => {
  if (['left', 'removed'].includes(member.status)) throw fail('GYM_MEMBER_STATE', { reason: member.status });
};

/** The member's status from their running membership (§8.1); returns the new status. */
async function syncMemberStatus(member, { transaction }) {
  const current = await GymMembership.findOne({ where: { memberId: member.id, status: RUNNING }, transaction });
  const status = rules.memberStatus({ current, status: member.status });
  if (status !== member.status) await member.update({ status }, { transaction });
  return status;
}

const startedEvent = { new: 'gym_membership.started', rejoin: 'gym_membership.started', import: 'gym_membership.started', renewal: 'gym_membership.renewed', change: 'gym_membership.changed' };

/**
 * Create a membership and its due on a locked member. `endsOn` and `status` are given by imports only;
 * `amount` overrides the due (a package change). Publishes the membership event and gym_due.created.
 */
async function createIn(transaction, { gym, member, pkg, startsOn, endsOn = null, status = null, admissionFee = 0, discount = 0, discountReason = null, origin, previousId = null, amount = null, actor, today, createdVia = 'desk' }) {
  const end = endsOn ?? rules.endsOn({ startsOn, days: pkg.days });
  const days = endsOn ? rules.daysBetween(startsOn, endsOn) + 1 : pkg.days;
  const state = status ?? rules.statusByDate({ startsOn, endsOn: end, today });
  const open = await GymMembership.findAll({ where: { memberId: member.id, status: OPEN }, transaction });
  const clash = open.find((o) => rules.overlaps({ startsOn, endsOn: end }, o) || (RUNNING.includes(state) && RUNNING.includes(o.status)) || (state === 'upcoming' && o.status === 'upcoming'));
  if (clash) throw fail('GYM_MEMBERSHIP_OVERLAP', { membershipId: clash.id });
  let ms;
  try {
    ms = await sequelize.transaction({ transaction }, (t) =>
      GymMembership.create(
        {
          memberId: member.id,
          gymId: gym.id,
          packageId: pkg.id,
          packageKind: pkg.kind,
          title: pkg.title,
          days,
          pricePoisha: pkg.pricePoisha,
          admissionFeePoisha: admissionFee,
          discountPoisha: discount,
          discountReason: discount ? discountReason : null,
          visitLimit: pkg.visitLimit ?? null,
          origin,
          createdVia,
          previousId,
          startsOn,
          endsOn: end,
          status: state,
          createdBy: actor?.id ?? null,
          updatedBy: actor?.id ?? null,
        },
        { transaction: t }
      )
    );
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw fail('GYM_MEMBERSHIP_OVERLAP');
    throw err;
  }
  const dueAmount = amount ?? rules.dueAmount({ price: pkg.pricePoisha, admissionFee, discount });
  const st = rules.dueState({ amount: dueAmount, paid: 0, waived: 0 });
  const due = await GymDue.create({ membershipId: ms.id, memberId: member.id, gymId: gym.id, amountPoisha: dueAmount, dueOn: rules.addDays(startsOn, c.cfg().dueDaysAfterStart), status: st.status }, { transaction });
  await c.publish(
    transaction,
    startedEvent[origin],
    'gym_membership',
    ms.id,
    { membershipId: ms.id, memberId: member.id, gymId: gym.id, packageKind: pkg.kind, startsOn, endsOn: end, userId: member.userId ?? null, ...(origin === 'change' ? { previousId } : {}) },
    actor
  );
  await c.publish(transaction, 'gym_due.created', 'gym_due', due.id, { dueId: due.id, membershipId: ms.id, memberId: member.id, gymId: gym.id, amount: dueAmount, dueOn: due.dueOn }, actor);
  await syncMemberStatus(member, { transaction });
  return { membership: ms, due };
}

/**
 * The admission fee of a new membership (FR-26): charged on the member's first membership and after a
 * re-join (a `new` member with earlier memberships); leaving it out needs fees.adjust.
 */
async function admissionFor(a, member, pkg, wanted, transaction) {
  const earlier = await GymMembership.count({ where: { memberId: member.id }, transaction });
  const rejoin = earlier > 0 && member.status === 'new';
  const eligible = earlier === 0 || rejoin;
  if (eligible && wanted === false) c.needs(a, 'fees.adjust');
  return { origin: rejoin ? 'rejoin' : 'new', fee: eligible && wanted !== false ? pkg.admissionFeePoisha : 0 };
}

/** A discount (FR-26) needs fees.adjust and a reason, and is at most the price. */
function checkDiscount(a, pkg, discount, reason) {
  if (!discount) return 0;
  c.needs(a, 'fees.adjust');
  if (!reason) throw E.validation([{ field: 'discountReason', message: 'Say why the discount is given' }]);
  if (discount > pkg.pricePoisha) throw E.validation([{ field: 'discountPoisha', message: 'A discount is at most the price' }]);
  return discount;
}

/** The first payment that may ride along with a new membership (fees.collect). */
async function firstPayment(transaction, a, { member, due, payment, now, today }) {
  if (!payment) return null;
  const paidOn = dues.paidOnFor(a, payment.paidOn, today);
  const r = await dues.recordIn(transaction, { gym: a.gym, member, due, amount: payment.amountPoisha, method: payment.method, paidOn, note: payment.note ?? null, receivedBy: a.actor.id, actor: a.actor, now });
  await c.record({ action: 'gym_fee.recorded', actor: a.actor, entityType: 'gym_fee_payment', entityId: r.payment.id, entityCode: r.payment.receiptNo, after: { amount: r.payment.amountPoisha, method: r.payment.method, paidOn, receiptNo: r.payment.receiptNo, dueId: due.id }, meta: { gymId: a.gym.id } }, transaction);
  return r.payment;
}

const paymentRef = (p) => (p ? { id: p.id, receiptNo: p.receiptNo, amountPoisha: p.amountPoisha, receiptUrl: c.receiptUrlOf(p.id) } : null);

/** A due with amounts for fees.collect (and the owner); status and dates only for everyone else (§3.3). */
const dueFor = async (a, due, today) => (a.can('fees.collect') ? dues.dueBody(due, { today }) : view.dueView(due, { today, money: false }));

async function body(a, { membership, due, payment = null, today, extra = {} }) {
  return c.shown(a, {
    membership: view.membershipView(membership, { today, dueId: due?.id ?? null }),
    due: due ? await dueFor(a, await GymDue.findByPk(due.id), today) : null,
    payment: paymentRef(payment),
    ...extra,
  });
}

/**
 * Assign inside a transaction (used by POST …/members/:id/memberships and by adding a member): the
 * caller holds the member row lock and has checked members.edit. Returns { membership, due, payment }.
 */
async function assignIn(transaction, a, member, input, { now = new Date(), anyChannel = false } = {}) {
  const today = c.today(now);
  const cfg = c.cfg();
  if (!rules.inWindow({ date: input.startsOn, today, back: cfg.backdateDays, ahead: rules.ASSIGN_AHEAD_DAYS })) {
    throw fail('GYM_DATE_OUT_OF_RANGE', { from: rules.addDays(today, -cfg.backdateDays), to: rules.addDays(today, rules.ASSIGN_AHEAD_DAYS) });
  }
  if (input.payment) c.needs(a, 'fees.collect');
  memberUsable(member);
  const pkg = await deskPackage(a.gym.id, input.packageId, { transaction, anyChannel });
  const discount = checkDiscount(a, pkg, input.discountPoisha ?? 0, input.discountReason ?? null);
  const admission = await admissionFor(a, member, pkg, input.admissionFee, transaction);
  const made = await createIn(transaction, { gym: a.gym, member, pkg, startsOn: input.startsOn, admissionFee: admission.fee, discount, discountReason: input.discountReason ?? null, origin: admission.origin, actor: a.actor, today });
  await c.record(
    { action: 'gym_membership.started', actor: a.actor, entityType: 'gym_membership', entityId: made.membership.id, entityCode: member.memberCode, after: { title: pkg.title, startsOn: made.membership.startsOn, endsOn: made.membership.endsOn, due: made.due.amountPoisha, discount }, meta: { gymId: a.gym.id, memberId: member.id } },
    transaction
  );
  const payment = await firstPayment(transaction, a, { member, due: made.due, payment: input.payment, now, today });
  return { ...made, payment };
}

/** POST /manage/gyms/:gymId/members/:memberId/memberships [Idempotency-Key] (members.edit; refused while restricted). */
async function assign(principal, gymId, memberId, input, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit', { restricted: true });
  await c.requireSetup(gymId);
  const now = new Date();
  const made = await sequelize.transaction(async (transaction) => {
    const member = await lockedMember(gymId, memberId, transaction);
    return assignIn(transaction, a, member, input, { now, req });
  });
  return body(a, { ...made, today: c.today(now) });
}

/** POST /manage/gyms/:gymId/memberships/:membershipId/renew [Idempotency-Key] (FR-27). */
async function renew(principal, gymId, membershipId, input, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit', { restricted: true });
  await c.requireSetup(gymId);
  if (input.payment) c.needs(a, 'fees.collect');
  const now = new Date();
  const today = c.today(now);
  const cfg = c.cfg();
  const made = await sequelize.transaction(async (transaction) => {
    const { member, ms: old } = await lockedMembership(gymId, membershipId, transaction);
    memberUsable(member);
    if (!['active', 'frozen', 'expired'].includes(old.status)) throw fail('GYM_MEMBERSHIP_STATE', { reason: old.status });
    const later = await GymMembership.findOne({ where: { memberId: member.id, status: ['upcoming', 'active', 'frozen', 'expired'] }, order: [['startsOn', 'DESC']], transaction });
    if (later && later.id !== old.id && later.startsOn > old.startsOn) throw fail('GYM_MEMBERSHIP_STATE', { reason: 'not_latest', membershipId: later.id });
    const pkg = await deskPackage(gymId, input.packageId ?? old.packageId, { transaction, anyChannel: !input.packageId });
    const start = rules.renewStart({ today, oldEndsOn: old.endsOn, graceDays: cfg.renewGraceDays, chosen: input.startsOn ?? null });
    if (start.block || start.startsOn > rules.addDays(today, rules.ASSIGN_AHEAD_DAYS)) throw fail('GYM_DATE_OUT_OF_RANGE', { from: today, to: rules.addDays(today, rules.ASSIGN_AHEAD_DAYS) });
    const m = await createIn(transaction, { gym: a.gym, member, pkg, startsOn: start.startsOn, origin: 'renewal', previousId: old.id, actor: a.actor, today });
    await c.record(
      { action: 'gym_membership.renewed', actor: a.actor, entityType: 'gym_membership', entityId: m.membership.id, entityCode: member.memberCode, after: { title: pkg.title, startsOn: m.membership.startsOn, endsOn: m.membership.endsOn, continuous: start.continuous }, meta: { gymId, previousId: old.id }, req },
      transaction
    );
    const payment = await firstPayment(transaction, a, { member, due: m.due, payment: input.payment, now, today });
    return { ...m, payment };
  });
  return body(a, { ...made, today });
}

/** Move an upcoming membership of the member by `days` (a freeze of the current one moves it too, §12.7). */
async function shiftUpcoming(memberId, days, transaction) {
  const up = await GymMembership.findOne({ where: { memberId, status: 'upcoming' }, transaction, lock: transaction.LOCK.UPDATE });
  if (up && days) await up.update({ startsOn: rules.addDays(up.startsOn, days), endsOn: rules.addDays(up.endsOn, days) }, { transaction });
}

const freezePayload = (ms, f) => ({ membershipId: ms.id, memberId: ms.memberId, gymId: ms.gymId, fromOn: f.fromOn, toOn: f.toOn, endsOn: ms.endsOn });

/** Start a freeze today (job or same-day freeze): the membership and the member become frozen. */
async function startFreeze(transaction, { ms, freeze, member, actor = null }) {
  await freeze.update({ status: 'active' }, { transaction });
  await ms.update({ status: 'frozen' }, { transaction });
  await c.publish(transaction, 'gym_membership.frozen', 'gym_membership', ms.id, freezePayload(ms, freeze), actor);
  await syncMemberStatus(member, { transaction });
}

/** POST /manage/gyms/:gymId/memberships/:membershipId/freeze { fromOn, toOn, reason } (FR-28). */
async function freeze(principal, gymId, membershipId, { fromOn, toOn, reason }, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit', { restricted: true });
  const today = c.today();
  const cfg = c.cfg();
  await sequelize.transaction(async (transaction) => {
    const { member, ms } = await lockedMembership(gymId, membershipId, transaction);
    const freezes = await GymFreeze.findAll({ where: { membershipId: ms.id }, transaction });
    const plan = rules.freezePlan({ membership: ms, fromOn, toOn, today, freezes, maxDays: cfg.maxFreezeDays, maxCount: cfg.maxFreezes });
    if (plan.block) throw fail(plan.block, plan.meta);
    await ms.update({ endsOn: plan.endsOn, frozenDays: ms.frozenDays + plan.days, freezesCount: ms.freezesCount + 1, updatedBy: principal.id }, { transaction });
    const f = await GymFreeze.create({ membershipId: ms.id, fromOn, toOn, reason, status: 'scheduled', createdBy: principal.id }, { transaction });
    await shiftUpcoming(member.id, plan.days, transaction);
    if (plan.startsNow) await startFreeze(transaction, { ms, freeze: f, member, actor: a.actor });
    await c.record({ action: 'gym_membership.frozen', actor: a.actor, entityType: 'gym_membership', entityId: ms.id, entityCode: member.memberCode, after: { fromOn, toOn, endsOn: plan.endsOn, days: plan.days }, reason, meta: { gymId }, req }, transaction);
  });
  return membershipBody(a, membershipId, today);
}

/** End a running freeze or cancel a scheduled one, giving back the unused days (job: at to_on; staff: today). */
async function endFreezeIn(transaction, { ms, freeze: f, member, plan, actor = null, by = null }) {
  if (plan.cancel) await f.update({ status: 'cancelled' }, { transaction });
  else await f.update({ status: 'done', ...(plan.endedEarlyOn && plan.giveBack > 0 ? { endedEarlyOn: plan.endedEarlyOn } : {}) }, { transaction });
  const wasFrozen = ms.status === 'frozen' && !plan.cancel;
  await ms.update(
    { endsOn: rules.addDays(ms.endsOn, -plan.giveBack), frozenDays: ms.frozenDays - plan.giveBack, freezesCount: plan.cancel ? ms.freezesCount - 1 : ms.freezesCount, ...(wasFrozen ? { status: 'active' } : {}), ...(by ? { updatedBy: by } : {}) },
    { transaction }
  );
  await shiftUpcoming(member.id, -plan.giveBack, transaction);
  if (wasFrozen) await c.publish(transaction, 'gym_membership.unfrozen', 'gym_membership', ms.id, freezePayload(ms, f), actor);
  await syncMemberStatus(member, { transaction });
}

/** POST /manage/gyms/:gymId/memberships/:membershipId/unfreeze: end the freeze today (FR-28; works while restricted). */
async function unfreeze(principal, gymId, membershipId, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit');
  const today = c.today();
  await sequelize.transaction(async (transaction) => {
    const { member, ms } = await lockedMembership(gymId, membershipId, transaction);
    const f =
      (await GymFreeze.findOne({ where: { membershipId: ms.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE })) ??
      (await GymFreeze.findOne({ where: { membershipId: ms.id, status: 'scheduled' }, order: [['fromOn', 'ASC']], transaction, lock: transaction.LOCK.UPDATE }));
    if (!f) throw fail('GYM_MEMBERSHIP_STATE', { reason: 'no_freeze' });
    const plan = rules.unfreezePlan({ freeze: f, today });
    if (plan.block) throw fail(plan.block, { reason: 'freeze_over' });
    await endFreezeIn(transaction, { ms, freeze: f, member, plan, actor: a.actor, by: principal.id });
    await c.record({ action: 'gym_membership.unfrozen', actor: a.actor, entityType: 'gym_membership', entityId: ms.id, entityCode: member.memberCode, after: { endsOn: ms.endsOn, gaveBack: plan.giveBack, cancelled: Boolean(plan.cancel) }, meta: { gymId }, req }, transaction);
  });
  return membershipBody(a, membershipId, today);
}

/** POST /manage/gyms/:gymId/memberships/:membershipId/change { packageId, onDate, dueAmountPoisha } [Idempotency-Key] (FR-29). */
async function change(principal, gymId, membershipId, input, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit', { restricted: true });
  await c.requireSetup(gymId);
  if (input.dueAmountPoisha !== undefined && input.dueAmountPoisha !== null) c.needs(a, 'fees.adjust');
  const today = c.today();
  const cfg = c.cfg();
  const made = await sequelize.transaction(async (transaction) => {
    const { member, ms: old } = await lockedMembership(gymId, membershipId, transaction);
    memberUsable(member);
    if (old.status !== 'active') throw fail('GYM_MEMBERSHIP_STATE', { reason: old.status });
    if (await GymMembership.findOne({ where: { memberId: member.id, status: 'upcoming' }, attributes: ['id'], transaction })) throw fail('GYM_MEMBERSHIP_STATE', { reason: 'upcoming_exists' });
    const onDate = input.onDate ?? today;
    const earliest = [old.startsOn, rules.addDays(today, -cfg.backdateDays)].sort().at(-1);
    if (onDate < earliest || onDate > today) throw fail('GYM_DATE_OUT_OF_RANGE', { from: earliest, to: today });
    const pkg = await deskPackage(gymId, input.packageId, { transaction });
    const oldDue = await GymDue.findOne({ where: { membershipId: old.id }, transaction, lock: transaction.LOCK.UPDATE });
    const credit = rules.changeCredit({ days: old.days, frozenDays: old.frozenDays, endsOn: old.endsOn, paid: oldDue?.paidPoisha ?? 0, changeOn: onDate });
    const amount = input.dueAmountPoisha ?? rules.changeDue({ price: pkg.pricePoisha, credit: credit.credit });
    await GymFreeze.update({ status: 'cancelled' }, { where: { membershipId: old.id, status: 'scheduled' }, transaction });
    await old.update({ endsOn: rules.addDays(onDate, -1), status: 'changed', updatedBy: principal.id }, { transaction });
    const m = await createIn(transaction, { gym: a.gym, member, pkg, startsOn: onDate, origin: 'change', previousId: old.id, amount, actor: a.actor, today });
    await c.record(
      { action: 'gym_membership.changed', actor: a.actor, entityType: 'gym_membership', entityId: m.membership.id, entityCode: member.memberCode, before: { membershipId: old.id, title: old.title }, after: { title: pkg.title, startsOn: onDate, due: amount, credit: credit.credit }, meta: { gymId }, req },
      transaction
    );
    return { ...m, old, credit };
  });
  const out = await body(a, { ...made, today, extra: { previous: view.membershipView(await GymMembership.findByPk(made.old.id), { today }), credit: { remainingDays: made.credit.remaining, totalDays: made.credit.total, creditPoisha: made.credit.credit } } });
  return out;
}

/**
 * Cancel inside a transaction (cancel route, leave, remove, import undo) on a locked member: before it
 * starts → cancelled and its due void when nothing was paid; after → it ends today (FR-30).
 */
async function cancelIn(transaction, { ms, member, reason, today, actor = null, endOn = null, by = null }) {
  if (!OPEN.includes(ms.status)) throw fail('GYM_MEMBERSHIP_STATE', { reason: ms.status });
  const due = await GymDue.findOne({ where: { membershipId: ms.id }, transaction, lock: transaction.LOCK.UPDATE });
  const end = endOn ?? today;
  if (ms.status === 'upcoming' || ms.startsOn > end) {
    if (due && due.paidPoisha === 0 && due.status !== 'void') {
      await due.update({ status: 'void', voidedAt: new Date(), voidReason: 'membership_cancelled' }, { transaction });
      await dues.cancelLinksIn(transaction, { dueId: due.id });
    }
  } else {
    const running = await GymFreeze.findOne({ where: { membershipId: ms.id, status: 'active' }, transaction });
    if (running) await running.update({ status: 'done', ...(end >= running.fromOn && end < running.toOn ? { endedEarlyOn: end } : {}) }, { transaction });
  }
  await GymFreeze.update({ status: 'cancelled' }, { where: { membershipId: ms.id, status: 'scheduled' }, transaction });
  const endsOn = ms.status === 'upcoming' || ms.startsOn > end ? ms.endsOn : end < ms.endsOn ? end : ms.endsOn;
  await ms.update({ status: 'cancelled', endsOn, cancelledAt: new Date(), cancelReason: reason ?? null, ...(by ? { updatedBy: by } : {}) }, { transaction });
  await c.publish(transaction, 'gym_membership.cancelled', 'gym_membership', ms.id, { membershipId: ms.id, memberId: member.id, gymId: ms.gymId, endsOn, reason: reason ? String(reason).slice(0, 40) : null }, actor);
  await syncMemberStatus(member, { transaction });
}

/** POST /manage/gyms/:gymId/memberships/:membershipId/cancel { reason } (FR-30). */
async function cancel(principal, gymId, membershipId, { reason }, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit', { restricted: true });
  const today = c.today();
  await sequelize.transaction(async (transaction) => {
    const { member, ms } = await lockedMembership(gymId, membershipId, transaction);
    await cancelIn(transaction, { ms, member, reason, today, actor: a.actor, by: principal.id });
    await c.record({ action: 'gym_membership.cancelled', actor: a.actor, entityType: 'gym_membership', entityId: ms.id, entityCode: member.memberCode, after: { status: 'cancelled', endsOn: ms.endsOn }, reason, meta: { gymId }, req }, transaction);
  });
  return membershipBody(a, membershipId, today);
}

async function membershipBody(a, membershipId, today) {
  const ms = await GymMembership.findByPk(membershipId);
  const [freezes, due] = await Promise.all([GymFreeze.findAll({ where: { membershipId }, order: [['fromOn', 'ASC']] }), GymDue.findOne({ where: { membershipId } })]);
  return c.shown(a, {
    membership: view.membershipView(ms, { today, freezes, dueId: due?.id ?? null }),
    due: due ? await dueFor(a, due, today) : null,
  });
}

module.exports = { dueFor, RUNNING, OPEN, lockMember, lockedMember, deskPackage, syncMemberStatus, createIn, assignIn, assign, renew, freeze, startFreeze, endFreezeIn, unfreeze, change, cancelIn, cancel, membershipBody };
