'use strict';

/**
 * M24 dues, counter payments and receipts (§5.4, §6.2, §8.4). Counter money is bookkeeping only: no
 * M06 call, no ledger entry, no payout (M24-FR-34).
 *  - One due per membership (FR-32): price + admission fee − discount, due start + due_days_after_start.
 *  - A counter payment (FR-33, fees.collect, Idempotency-Key) from ৳1 to the outstanding, under the
 *    due row lock (parallel payments never exceed it); the receipt number comes from the settings row
 *    lock (continuous per gym and year). Works while the owner's subscription is restricted (FR-08).
 *  - A reversal (FR-35, fees.adjust) is a new negative row, once per payment (partial unique index);
 *    the original row never changes (append-only trigger). Online payments are refunded instead.
 *  - A waiver (FR-36, fees.adjust) of all or part of the outstanding, with a reason.
 *  - Receipts (FR-37) as JSON for staff, the linked member and anyone with the signed /r/ link.
 *  - Daily cash closing (FR-38): counter money by staff member and method for a Dhaka date.
 * Status is always recomputed with §6.2 inside the same transaction.
 */
const { Op, QueryTypes, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, GymDue, GymFeePayment, GymMember, GymMembership, GymPaymentLink } = require('../../models');
const directory = require('../users').directory;
const gymFacade = require('../gym').gyms;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');
const view = require('./gym-manage.serializer');
const notices = require('./notices.service');
const fees = require('./fees.service');

const { fail } = c;
/** M24-FR-33: a counter payment is at least ৳1 (a spec constant). Opening balances from an import may be smaller. */
const MIN_PAYMENT_POISHA = 100;

const lockDue = (gymId, dueId, transaction) => GymDue.findOne({ where: { id: dueId, gymId }, transaction, lock: transaction.LOCK.UPDATE });

/**
 * Cancel the open payment links of a due that no longer need them (M24 §8.5: the due was paid, waived or
 * voided another way, or its outstanding fell below the link's amount), except `keep`. In the caller's
 * transaction.
 */
async function cancelLinksIn(transaction, { dueId, outstanding = 0, keep = null }) {
  const open = await GymPaymentLink.findAll({ where: { dueId, status: 'open' }, transaction, lock: transaction.LOCK.UPDATE });
  for (const l of open) if (l.id !== keep && l.amountPoisha > outstanding) await l.update({ status: 'cancelled' }, { transaction });
}

/**
 * Record one positive payment on a due the caller has locked. Returns { payment, due, outstandingAfter }.
 * Publishes gym_fee.recorded (and gym_due.paid when the outstanding reaches 0).
 * Online payments (M24-FR-42, FR-43) carry the M06 payment, the link, the payer and the provider charge
 * snapshot (`online`), and have no receiver. A platform member's first payment charges the referral
 * fee (M24-FR-91). The receipt notice is logged once (M24-FR-55; never for import opening balances,
 * FR-78). Open links the due no longer needs are cancelled (§8.5).
 */
async function recordIn(transaction, { gym, member, due, amount, method, paidOn, note = null, receivedBy, actor, importId = null, now = new Date(), min = MIN_PAYMENT_POISHA, online = null }) {
  const state = rules.dueState({ amount: due.amountPoisha, paid: due.paidPoisha, waived: due.waivedPoisha, voided: due.status === 'void' });
  const block = rules.paymentBlock({ status: state.status, outstanding: state.outstanding, amount, min });
  if (block) throw fail(block, block === 'GYM_PAYMENT_EXCEEDS_DUE' ? { outstanding: state.outstanding } : { status: state.status });
  const receiptNo = await c.nextReceiptNo(gym.id, transaction, now);
  // M27-FR-28: the VAT rate at this moment is kept on the payment (a later change never edits a receipt).
  const vatBps = await c.vatBpsOf(gym.id, { transaction });
  const payment = await GymFeePayment.create(
    {
      dueId: due.id,
      memberId: member.id,
      gymId: gym.id,
      ownerId: gym.ownerId,
      amountPoisha: amount,
      method,
      paidOn,
      receiptNo,
      note,
      receivedBy,
      importId,
      vatBps,
      ...(online
        ? { payerUserId: online.payerUserId, linkId: online.linkId, paymentId: online.paymentId, providerChargeBps: online.providerChargeBps, providerChargePoisha: online.providerChargePoisha, providerSettingVersion: online.providerSettingVersion }
        : {}),
    },
    { transaction }
  );
  const paid = due.paidPoisha + amount;
  const next = rules.dueState({ amount: due.amountPoisha, paid, waived: due.waivedPoisha });
  await due.update({ paidPoisha: paid, status: next.status }, { transaction });
  await cancelLinksIn(transaction, { dueId: due.id, outstanding: next.outstanding, keep: online?.linkId ?? null });
  await fees.chargeReferralIn(transaction, { gym, member, payment, actor, now });
  // Prompt 3b: the receipt goes by SMS too when the gym chose it and units are left.
  const notice = method !== 'opening' ? await notices.logImmediate(transaction, { kind: 'receipt', member, gym, subjectType: 'fee_payment', subjectId: payment.id, sms: true }) : null;
  await c.publish(
    transaction,
    'gym_fee.recorded',
    'gym_fee_payment',
    payment.id,
    { feePaymentId: payment.id, dueId: due.id, memberId: member.id, gymId: gym.id, ownerId: gym.ownerId, amount, method, receiptNo, paidOn, outstandingAfter: next.outstanding, by: receivedBy ?? null, sms: notice?.sms ?? null },
    actor
  );
  if (next.status === 'paid') await c.publish(transaction, 'gym_due.paid', 'gym_due', due.id, { dueId: due.id, memberId: member.id, gymId: gym.id, amount: due.amountPoisha }, actor);
  return { payment, due, outstandingAfter: next.outstanding };
}

/**
 * The paid-on date of a counter payment (FR-33): today by default; earlier dates up to
 * gym_manage.backdate_days need fees.adjust; never in the future.
 */
function paidOnFor(a, paidOn, today) {
  const day = paidOn ?? today;
  if (!rules.inWindow({ date: day, today, back: c.cfg().backdateDays })) throw fail('GYM_DATE_OUT_OF_RANGE', { from: rules.addDays(today, -c.cfg().backdateDays), to: today });
  if (day < today) c.needs(a, 'fees.adjust');
  return day;
}

async function names(payments) {
  return directory.displayNames(payments.map((p) => p.receivedBy).filter(Boolean));
}

async function dueBody(due, { today }) {
  const payments = await GymFeePayment.findAll({ where: { dueId: due.id }, order: [['createdAt', 'ASC']] });
  return view.dueView(due, { today, payments, names: await names(payments) });
}

/** POST /manage/gyms/:gymId/dues/:dueId/payments [Idempotency-Key] (fees.collect; works while restricted). */
async function pay(principal, gymId, dueId, body, req) {
  const a = await c.gymAccess(principal, gymId, 'fees.collect');
  const now = new Date();
  const today = c.today(now);
  const paidOn = paidOnFor(a, body.paidOn, today);
  const result = await sequelize.transaction(async (transaction) => {
    const due = await lockDue(gymId, dueId, transaction);
    if (!due) throw E.notFound('Due');
    const member = await GymMember.findByPk(due.memberId, { transaction });
    const r = await recordIn(transaction, { gym: a.gym, member, due, amount: body.amountPoisha, method: body.method, paidOn, note: body.note ?? null, receivedBy: principal.id, actor: a.actor, now });
    await c.record({ action: 'gym_fee.recorded', actor: a.actor, entityType: 'gym_fee_payment', entityId: r.payment.id, entityCode: r.payment.receiptNo, after: { amount: r.payment.amountPoisha, method: r.payment.method, paidOn, receiptNo: r.payment.receiptNo, dueId: due.id }, meta: { gymId }, req }, transaction);
    return r;
  });
  const names_ = await names([result.payment]);
  return c.shown(a, {
    payment: view.paymentView(result.payment, { names: names_ }),
    due: await dueBody(await GymDue.findByPk(dueId), { today }),
    receipt: { receiptNo: result.payment.receiptNo, url: c.receiptUrlOf(result.payment.id) },
  });
}

/** POST /manage/gyms/:gymId/dues/:dueId/waive { amountPoisha, reason } (fees.adjust; refused while restricted). */
async function waive(principal, gymId, dueId, { amountPoisha, reason }, req) {
  const a = await c.gymAccess(principal, gymId, 'fees.adjust', { restricted: true });
  const today = c.today();
  await sequelize.transaction(async (transaction) => {
    const due = await lockDue(gymId, dueId, transaction);
    if (!due) throw E.notFound('Due');
    const state = rules.dueState({ amount: due.amountPoisha, paid: due.paidPoisha, waived: due.waivedPoisha, voided: due.status === 'void' });
    const block = rules.paymentBlock({ status: state.status, outstanding: state.outstanding, amount: amountPoisha, min: 1 });
    if (block) throw fail(block, block === 'GYM_PAYMENT_EXCEEDS_DUE' ? { outstanding: state.outstanding } : { status: state.status });
    const waived = due.waivedPoisha + amountPoisha;
    const next = rules.dueState({ amount: due.amountPoisha, paid: due.paidPoisha, waived });
    const before = { waived: due.waivedPoisha, status: due.status };
    await due.update({ waivedPoisha: waived, status: next.status, waiveReason: due.waiveReason ? `${due.waiveReason}; ${reason}`.slice(0, 300) : reason }, { transaction });
    await cancelLinksIn(transaction, { dueId: due.id, outstanding: next.outstanding });
    if (next.outstanding === 0) {
      const name = next.status === 'paid' ? 'gym_due.paid' : 'gym_due.waived';
      await c.publish(transaction, name, 'gym_due', due.id, { dueId: due.id, memberId: due.memberId, gymId, amount: due.amountPoisha }, a.actor);
    }
    await c.record({ action: 'gym_due.waived', actor: a.actor, entityType: 'gym_due', entityId: due.id, before, after: { waived, status: next.status }, reason, meta: { gymId, amount: amountPoisha }, req }, transaction);
  });
  return c.shown(a, { due: await dueBody(await GymDue.findByPk(dueId), { today }) });
}

/** POST /manage/gyms/:gymId/fee-payments/:feePaymentId/reverse { reason } [Idempotency-Key] (fees.adjust). */
async function reverse(principal, gymId, feePaymentId, { reason }, req) {
  const a = await c.gymAccess(principal, gymId, 'fees.adjust');
  const today = c.today();
  const original = await GymFeePayment.findOne({ where: { id: feePaymentId, gymId } });
  if (!original) throw E.notFound('Payment');
  let reversal;
  try {
    reversal = await sequelize.transaction(async (transaction) => {
      const due = await lockDue(gymId, original.dueId, transaction);
      const already = await GymFeePayment.findOne({ where: { reversesId: original.id }, attributes: ['id'], transaction });
      const block = rules.reversalBlock({ payment: original, alreadyReversed: Boolean(already) });
      if (block) throw fail(block);
      const r = await reverseIn(transaction, { gym: a.gym, due, original, reason, by: principal.id, actor: a.actor, today });
      await c.record({ action: 'gym_fee.reversed', actor: a.actor, entityType: 'gym_fee_payment', entityId: original.id, entityCode: original.receiptNo, before: { receiptNo: original.receiptNo, amount: original.amountPoisha }, after: { reversalId: r.id }, reason, meta: { gymId }, req }, transaction);
      return r;
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw fail('GYM_PAYMENT_NOT_REVERSIBLE');
    throw err;
  }
  return c.shown(a, { reversal: view.paymentView(reversal, { names: await names([reversal]) }), due: await dueBody(await GymDue.findByPk(original.dueId), { today }) });
}

/**
 * The negative row of a reversal on a locked due (staff reversal, import undo, an online refund: then
 * `amount` is what was refunded and `online` the refund's payment); publishes gym_fee.reversed. A
 * pending referral charged on the original payment is voided (M24-FR-91).
 */
async function reverseIn(transaction, { gym, due, original, reason, by, actor, today, importId = null, amount = original.amountPoisha, online = null }) {
  const row = await GymFeePayment.create(
    {
      dueId: due.id,
      memberId: original.memberId,
      gymId: gym.id,
      ownerId: gym.ownerId,
      amountPoisha: -amount,
      method: original.method,
      paidOn: today,
      reversesId: original.id,
      reason,
      receivedBy: by,
      importId,
      ...(online ? { paymentId: online.paymentId, linkId: original.linkId, payerUserId: original.payerUserId } : {}),
    },
    { transaction }
  );
  await fees.voidReferralForPaymentIn(transaction, { feePaymentId: original.id, actor });
  const paid = due.paidPoisha - amount;
  const next = rules.dueState({ amount: due.amountPoisha, paid, waived: due.waivedPoisha, voided: due.status === 'void' });
  await due.update({ paidPoisha: paid, ...(due.status === 'void' ? {} : { status: next.status }) }, { transaction });
  await c.publish(transaction, 'gym_fee.reversed', 'gym_fee_payment', row.id, { feePaymentId: row.id, reversesId: original.id, dueId: due.id, memberId: original.memberId, gymId: gym.id, amount, reason: String(reason).slice(0, 300) }, actor);
  return row;
}

/** GET /manage/gyms/:gymId/dues?status&overdue&dueOn&memberId&cursor&limit (fees.collect). */
async function list(principal, gymId, { status, overdue, dueOn, memberId, cursor, limit = 25 } = {}) {
  const a = await c.gymAccess(principal, gymId, 'fees.collect');
  const today = c.today();
  const after = c.parseCursor(cursor);
  const where = {
    gymId,
    status: status ? [status] : ['unpaid', 'partial'],
    ...(memberId ? { memberId } : {}),
    ...(dueOn ? { dueOn } : {}),
    ...(overdue ? { dueOn: { [Op.lt]: today }, status: ['unpaid', 'partial'] } : {}),
    ...(after ? { [Op.or]: [{ dueOn: { [Op.gt]: after[0] } }, { dueOn: after[0], id: { [Op.gt]: after[1] } }] } : {}),
  };
  const rows = await GymDue.findAll({ where, order: [['dueOn', 'ASC'], ['id', 'ASC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const members = new Map((await GymMember.findAll({ where: { id: page.map((d) => d.memberId) } })).map((m) => [m.id, m]));
  const memberships = new Map((await GymMembership.findAll({ where: { id: page.map((d) => d.membershipId) }, attributes: ['id', 'title', 'packageKind', 'startsOn', 'endsOn'] })).map((m) => [m.id, m]));
  return c.shown(a, {
    items: page.map((d) => {
      const ms = memberships.get(d.membershipId);
      return { ...view.dueView(d, { today }), member: view.memberSummary(members.get(d.memberId)), membership: ms ? { title: ms.title, packageKind: ms.packageKind, startsOn: ms.startsOn, endsOn: ms.endsOn } : null };
    }),
    nextCursor: rows.length > limit ? c.cursorOf([page.at(-1).dueOn, page.at(-1).id]) : null,
  });
}

// ---------------------------------------------------------------- receipts (M24-FR-37)

/** The receipt JSON of a positive payment row. */
async function receiptOf(payment) {
  const [due, member, gym, settings, reversal] = await Promise.all([
    GymDue.findByPk(payment.dueId),
    GymMember.findByPk(payment.memberId),
    gymFacade.get(payment.gymId),
    c.settingsOf(payment.gymId),
    GymFeePayment.findOne({ where: { reversesId: payment.id } }),
  ]);
  const membership = due ? await GymMembership.findByPk(due.membershipId) : null;
  // Outstanding after this payment: the due less every payment and reversal recorded on it up to this
  // row. Waivers carry no date of their own, so they are left out (a later waiver never changes an old receipt).
  const [{ upTo }] = await sequelize.query('SELECT COALESCE(SUM(amount_poisha), 0)::bigint AS "upTo" FROM gym_fee_payments WHERE due_id = :dueId AND created_at <= :at', {
    replacements: { dueId: payment.dueId, at: payment.createdAt },
    type: QueryTypes.SELECT,
  });
  const outstandingAfter = Math.max(0, due.amountPoisha - Number(upTo));
  const receivedByName = payment.receivedBy ? (await directory.displayNames([payment.receivedBy])).get(payment.receivedBy) : null;
  return view.receiptView({ payment, gym: gym ?? { id: payment.gymId, name: '', addressLine: null }, settings, member, membership, receivedByName, outstandingAfter, reversal });
}

async function positivePayment(where) {
  const p = await GymFeePayment.findOne({ where: { ...where, amountPoisha: { [Op.gt]: 0 } } });
  if (!p) throw E.notFound('Receipt');
  return p;
}

/** GET /manage/gyms/:gymId/fee-payments/:feePaymentId/receipt (fees.collect). */
async function receipt(principal, gymId, feePaymentId) {
  const a = await c.gymAccess(principal, gymId, 'fees.collect');
  return c.shown(a, await receiptOf(await positivePayment({ id: feePaymentId, gymId })));
}

/** GET /gym-receipts/:token: anyone with the signed link (a token for another receipt fails the HMAC: 404). */
async function publicReceipt(token) {
  const parsed = c.parseReceipt(token);
  if (!parsed) throw E.notFound('Receipt');
  return receiptOf(await positivePayment({ id: parsed.feePaymentId }));
}

// ---------------------------------------------------------------- cash closing (M24-FR-38)

/**
 * GET /manage/gyms/:gymId/cash-closing?date: counter money of a Dhaka date by staff member and method
 * (reversals included as negative rows). fees.collect sees their own; the owner and reports.view see
 * everyone. Online payments are shown apart (prompt 2); import opening balances are not counter money.
 */
async function cashClosing(principal, gymId, { date } = {}) {
  const a = await c.gymAccess(principal, gymId, 'fees.collect');
  const day = date ?? c.today();
  const all = a.owner || a.can('reports.view');
  const rows = await GymFeePayment.findAll({
    where: { gymId, paidOn: day, method: { [Op.notIn]: ['opening'] }, ...(all ? {} : { receivedBy: principal.id }) },
    order: [['createdAt', 'ASC']],
  });
  const counter = rows.filter((p) => p.method !== 'online');
  const byMethod = (list) => list.reduce((acc, p) => ({ ...acc, [p.method]: (acc[p.method] ?? 0) + p.amountPoisha }), {});
  const people = [...new Set(counter.map((p) => p.receivedBy).filter(Boolean))];
  const nameMap = await directory.displayNames(people);
  const byStaff = people.map((userId) => {
    const mine = counter.filter((p) => p.receivedBy === userId);
    return { userId, displayName: nameMap.get(userId) ?? null, count: mine.length, totalPoisha: mine.reduce((s, p) => s + p.amountPoisha, 0), byMethod: byMethod(mine) };
  });
  return c.shown(a, {
    date: day,
    scope: all ? 'all' : 'own',
    totals: {
      counterPoisha: counter.reduce((s, p) => s + p.amountPoisha, 0),
      receivedPoisha: counter.filter((p) => p.amountPoisha > 0).reduce((s, p) => s + p.amountPoisha, 0),
      reversedPoisha: counter.filter((p) => p.amountPoisha < 0).reduce((s, p) => s - p.amountPoisha, 0),
      onlinePoisha: rows.filter((p) => p.method === 'online').reduce((s, p) => s + p.amountPoisha, 0),
      byMethod: byMethod(counter),
    },
    byStaff,
    items: counter.map((p) => view.paymentView(p, { names: nameMap })),
  });
}

module.exports = { MIN_PAYMENT_POISHA, lockDue, cancelLinksIn, recordIn, reverseIn, paidOnFor, dueBody, pay, waive, reverse, list, receiptOf, receipt, publicReceipt, cashClosing };
