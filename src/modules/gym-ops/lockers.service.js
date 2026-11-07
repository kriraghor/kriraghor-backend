'use strict';

/**
 * M27 lockers (M27-FR-22..26): the gym's lockers on a grid (free, taken, fee unpaid, overdue, out of
 * service), rented to a member for dates with a fee taken now or later as a counter sale with a receipt.
 * Rentals end by hand or by the daily job the day after their end date; the member is reminded before.
 * Permission lockers.manage; plan feature `lockers`. Taking a fee works while the owner's account is
 * restricted; changing lockers does not.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, GymLocker, GymLockerRental } = require('../../models');
const rules = require('./gym-ops.rules');
const c = require('./gym-ops.common');
const shop = require('./shop.service');

const FEATURE = 'lockers';

async function membersOf(gymId, ids) {
  const out = new Map();
  for (const id of new Set(ids)) out.set(id, await c.ops.member(gymId, id));
  return out;
}

function rentalView(r, { locker, member }) {
  return {
    id: r.id,
    lockerId: r.lockerId,
    lockerNumber: locker?.number ?? '',
    member: { id: r.memberId, memberCode: member?.memberCode ?? '', displayName: member?.displayName ?? '' },
    startsOn: r.startsOn,
    endsOn: r.endsOn,
    feePoisha: r.feePoisha,
    paid: Boolean(r.paidSaleId),
    paidSaleId: r.paidSaleId ?? null,
    status: r.status,
    endReason: r.endReason ?? null,
  };
}

/** GET …/lockers (lockers.manage): the grid with each locker's state and active rental (M27-FR-22). */
async function grid(principal, gymId) {
  await c.access(principal, gymId, 'lockers.manage', { feature: FEATURE });
  const today = c.today();
  const lockers = await GymLocker.findAll({ where: { gymId, status: { [Op.ne]: 'retired' } } });
  lockers.sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true }));
  const rentals = await GymLockerRental.findAll({ where: { gymId, status: 'active' } });
  const byLocker = new Map(rentals.map((r) => [r.lockerId, r]));
  const members = await membersOf(gymId, rentals.map((r) => r.memberId));
  const counts = { free: 0, taken: 0, unpaid: 0, overdue: 0, outOfService: 0 };
  const items = lockers.map((l) => {
    const r = byLocker.get(l.id) ?? null;
    const state = rules.lockerState(l, r, today);
    counts[state === 'out_of_service' ? 'outOfService' : state] += 1;
    return {
      id: l.id,
      number: l.number,
      zone: l.zone ?? null,
      size: l.size,
      monthlyFeePoisha: l.monthlyFeePoisha,
      status: l.status,
      state,
      note: l.note ?? null,
      rental: r ? rentalView(r, { locker: l, member: members.get(r.memberId) }) : null,
    };
  });
  return { items, counts };
}

/** POST …/lockers (lockers.manage): add one or many lockers (M27-FR-22). */
async function add(principal, gymId, { numbers, zone = null, size = 'medium', monthlyFeePoisha }, req) {
  const a = await c.access(principal, gymId, 'lockers.manage', { feature: FEATURE, restricted: true });
  const cfg = c.cfg();
  const block = rules.amountBlock(monthlyFeePoisha, { min: 0, max: cfg.lockerFeeMax });
  if (block) throw c.fail(block, { max: cfg.lockerFeeMax });
  await sequelize.transaction(async (transaction) => {
    const existing = await GymLocker.findAll({ where: { gymId, status: { [Op.ne]: 'retired' } }, transaction, lock: transaction.LOCK.UPDATE });
    if (existing.length + numbers.length > cfg.lockersMax) throw c.fail('GYM_LOCKER_LIMIT', { max: cfg.lockersMax });
    const taken = new Set(existing.map((l) => l.number.toUpperCase()));
    const fresh = [...new Set(numbers.map((n) => n.trim()))];
    const clash = fresh.find((n) => taken.has(n.toUpperCase()));
    if (clash) throw c.fail('GYM_LOCKER_NUMBER_TAKEN', { number: clash });
    await GymLocker.bulkCreate(fresh.map((number) => ({ gymId, number, zone, size, monthlyFeePoisha })), { transaction });
    await c.record({ action: 'gym_locker.added', actor: a.actor, entityType: 'gym', entityId: gymId, after: { count: fresh.length, monthlyFee: monthlyFeePoisha }, meta: { gymId }, req }, transaction);
  });
  return grid(principal, gymId);
}

/** PATCH …/lockers/:lockerId (lockers.manage): zone, size, fee, out of service, retire (not while rented). */
async function update(principal, gymId, lockerId, input, req) {
  const a = await c.access(principal, gymId, 'lockers.manage', { feature: FEATURE, restricted: true });
  if (input.monthlyFeePoisha !== undefined) {
    const block = rules.amountBlock(input.monthlyFeePoisha, { min: 0, max: c.cfg().lockerFeeMax });
    if (block) throw c.fail(block, { max: c.cfg().lockerFeeMax });
  }
  await sequelize.transaction(async (transaction) => {
    const l = await GymLocker.findOne({ where: { id: lockerId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!l || l.status === 'retired') throw E.notFound('Locker');
    if (input.status && input.status !== 'available') {
      const rented = await GymLockerRental.findOne({ where: { lockerId, status: 'active' }, transaction });
      if (rented) throw c.fail('GYM_LOCKER_UNAVAILABLE');
    }
    const before = { status: l.status, fee: l.monthlyFeePoisha };
    await l.update(input, { transaction });
    await c.record({ action: 'gym_locker.updated', actor: a.actor, entityType: 'gym_locker', entityId: l.id, before, after: { status: l.status, fee: l.monthlyFeePoisha }, meta: { gymId }, req }, transaction);
  });
  return grid(principal, gymId);
}

/** The locker fee as a counter sale with a receipt, in the caller's transaction. */
async function chargeIn(transaction, { gymId, rental, locker, method, by, actor }) {
  const sale = await shop.saleIn(transaction, {
    gymId,
    kind: 'locker',
    method,
    memberId: rental.memberId,
    by,
    actor,
    lines: [{ description: `Locker ${locker.number}, ${rental.startsOn} to ${rental.endsOn}`, qty: 1, unitPrice: rental.feePoisha, unitCost: null, lockerRentalId: rental.id }],
  });
  await rental.update({ paidSaleId: sale.id }, { transaction });
  return sale;
}

/** POST …/lockers/:lockerId/rent (lockers.manage, Idempotency-Key): rent to a member, the fee now or later (M27-FR-23). */
async function rent(principal, gymId, lockerId, input, req) {
  const a = await c.access(principal, gymId, 'lockers.manage', { feature: FEATURE });
  const cfg = c.cfg();
  const today = c.today();
  const startsOn = input.startsOn ?? today;
  const block = rules.rentalBlock({ startsOn, endsOn: input.endsOn, today, backdateDays: cfg.backdateDays, maxDays: cfg.rentalMaxDays });
  if (block) throw c.fail(block);
  const rentalId = await sequelize.transaction(async (transaction) => {
    const l = await GymLocker.findOne({ where: { id: lockerId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!l || l.status === 'retired') throw E.notFound('Locker');
    if (l.status !== 'available') throw c.fail('GYM_LOCKER_UNAVAILABLE');
    if (await GymLockerRental.findOne({ where: { lockerId, status: 'active' }, transaction })) throw c.fail('GYM_LOCKER_UNAVAILABLE');
    const member = await c.ops.member(gymId, input.memberId, { transaction });
    if (!member || member.status === 'left') throw c.fail('GYM_MEMBER_UNKNOWN');
    const fee = input.feePoisha ?? rules.rentalFee({ monthlyFee: l.monthlyFeePoisha, startsOn, endsOn: input.endsOn });
    const feeBlock = rules.amountBlock(fee, { min: 0, max: cfg.lockerFeeMax * 24 });
    if (feeBlock) throw c.fail(feeBlock);
    const r = await GymLockerRental.create({ gymId, lockerId, memberId: member.id, startsOn, endsOn: input.endsOn, feePoisha: fee, createdBy: principal.id }, { transaction });
    if (input.collect && fee > 0) await chargeIn(transaction, { gymId, rental: r, locker: l, method: input.collect.method, by: principal.id, actor: a.actor });
    await c.publish(transaction, 'gym_locker.rented', 'gym_locker_rental', r.id, { rentalId: r.id, gymId, lockerId, memberId: member.id, startsOn, endsOn: input.endsOn, fee }, a.actor);
    await c.record({ action: 'gym_locker.rented', actor: a.actor, entityType: 'gym_locker_rental', entityId: r.id, after: { locker: l.number, memberCode: member.memberCode, endsOn: input.endsOn, fee, paid: Boolean(input.collect && fee > 0) }, meta: { gymId }, req }, transaction);
    return r.id;
  });
  return rentalOf(gymId, rentalId);
}

/** POST …/locker-rentals/:rentalId/collect (lockers.manage, Idempotency-Key): take an unpaid fee now (M27-FR-24). */
async function collect(principal, gymId, rentalId, { method }, req) {
  const a = await c.access(principal, gymId, 'lockers.manage', { feature: FEATURE });
  await sequelize.transaction(async (transaction) => {
    const r = await GymLockerRental.findOne({ where: { id: rentalId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!r) throw E.notFound('Rental');
    if (r.paidSaleId || r.feePoisha === 0) throw c.fail('GYM_LOCKER_FEE_PAID');
    if (r.status === 'cancelled') throw c.fail('GYM_LOCKER_RENTAL_STATE');
    const l = await GymLocker.findByPk(r.lockerId, { transaction });
    const sale = await chargeIn(transaction, { gymId, rental: r, locker: l, method, by: principal.id, actor: a.actor });
    await c.record({ action: 'gym_locker.fee_collected', actor: a.actor, entityType: 'gym_locker_rental', entityId: r.id, after: { amount: r.feePoisha, method, receiptNo: sale.receiptNo }, meta: { gymId }, req }, transaction);
  });
  return rentalOf(gymId, rentalId);
}

/** POST …/locker-rentals/:rentalId/end (lockers.manage): free the locker now, with a reason (M27-FR-25). */
async function end(principal, gymId, rentalId, { reason }, req) {
  const a = await c.access(principal, gymId, 'lockers.manage', { feature: FEATURE });
  await sequelize.transaction(async (transaction) => {
    const r = await GymLockerRental.findOne({ where: { id: rentalId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!r) throw E.notFound('Rental');
    if (r.status !== 'active') throw c.fail('GYM_LOCKER_RENTAL_STATE');
    await r.update({ status: 'ended', endReason: reason, endedAt: new Date(), endedBy: principal.id }, { transaction });
    await c.publish(transaction, 'gym_locker.ended', 'gym_locker_rental', r.id, { rentalId: r.id, gymId, lockerId: r.lockerId, memberId: r.memberId, by: 'staff' }, a.actor);
    await c.record({ action: 'gym_locker.ended', actor: a.actor, entityType: 'gym_locker_rental', entityId: r.id, reason, meta: { gymId }, req }, transaction);
  });
  return rentalOf(gymId, rentalId);
}

/** A reversed locker-fee sale makes its rental unpaid again (shop.reverse, same transaction). */
async function unpayIn(transaction, saleId) {
  await GymLockerRental.update({ paidSaleId: null }, { where: { paidSaleId: saleId }, transaction });
}

async function rentalOf(gymId, rentalId) {
  const r = await GymLockerRental.findOne({ where: { id: rentalId, gymId } });
  if (!r) throw E.notFound('Rental');
  const [l, m] = await Promise.all([GymLocker.findByPk(r.lockerId), c.ops.member(gymId, r.memberId)]);
  return rentalView(r, { locker: l, member: m });
}

/** GET …/locker-rentals?memberId&status (lockers.manage). */
async function rentals(principal, gymId, { memberId, status } = {}) {
  await c.access(principal, gymId, 'lockers.manage', { feature: FEATURE });
  const rows = await GymLockerRental.findAll({ where: { gymId, ...(memberId ? { memberId } : {}), ...(status ? { status } : {}) }, order: [['createdAt', 'DESC']], limit: 200 });
  const lockers = new Map((await GymLocker.findAll({ where: { id: [...new Set(rows.map((r) => r.lockerId))] } })).map((l) => [l.id, l]));
  const members = await membersOf(gymId, rows.map((r) => r.memberId));
  return { items: rows.map((r) => rentalView(r, { locker: lockers.get(r.lockerId), member: members.get(r.memberId) })) };
}

/**
 * Daily job (M27-FR-25): remind members gym_ops.locker_remind_days before a rental ends (once), and end the
 * rentals whose end date has passed, freeing their lockers.
 */
async function daily(now = new Date()) {
  const today = c.today(now);
  const remindDays = c.cfg().lockerRemindDays;
  const out = { reminded: 0, ended: 0 };
  if (remindDays > 0) {
    const due = await GymLockerRental.findAll({ where: { status: 'active', endsOn: rules.addDays(today, remindDays), remindedOn: null } });
    for (const r of due) {
      await sequelize.transaction(async (transaction) => {
        await r.update({ remindedOn: today }, { transaction });
        await c.publish(transaction, 'gym_locker.end_reminded', 'gym_locker_rental', r.id, { rentalId: r.id, gymId: r.gymId, lockerId: r.lockerId, memberId: r.memberId, endsOn: r.endsOn });
      });
      out.reminded += 1;
    }
  }
  const over = await GymLockerRental.findAll({ where: { status: 'active', endsOn: { [Op.lt]: today } } });
  for (const r of over) {
    await sequelize.transaction(async (transaction) => {
      await r.update({ status: 'ended', endReason: 'ended', endedAt: new Date() }, { transaction });
      await c.publish(transaction, 'gym_locker.ended', 'gym_locker_rental', r.id, { rentalId: r.id, gymId: r.gymId, lockerId: r.lockerId, memberId: r.memberId, by: 'job' });
    });
    out.ended += 1;
  }
  return out;
}

module.exports = { grid, add, update, rent, collect, end, unpayIn, rentals, daily };
