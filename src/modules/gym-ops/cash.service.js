'use strict';

/**
 * M27 cash drawer (M27-FR-06..09): each day the drawer is opened with a float and closed with the cash
 * counted. Expected = float + cash fees + cash sales − cash expenses paid from the drawer; the difference is
 * kept and the owner is told when it is not zero. Permission cash.drawer (the owner always); plan feature
 * `expenses`. Works while the owner's account is restricted (counter work, M24-FR-08). One drawer per gym
 * per day (unique index).
 */
const { UniqueConstraintError } = require('sequelize');
const { sequelize, GymCashSession } = require('../../models');
const directory = require('../users').directory;
const rules = require('./gym-ops.rules');
const c = require('./gym-ops.common');
const expenses = require('./expenses.service');
const shop = require('./shop.service');

const FEATURE = 'expenses';

/** The cash that moved through the drawer on a day, live. */
async function cashOf(gymId, day, { transaction } = {}) {
  const [feesPoisha, salesPoisha, expensesPoisha] = await Promise.all([
    c.ops.cashCollected(gymId, day, { transaction }),
    shop.cashOfDay(gymId, day, { transaction }),
    expenses.drawerCash(gymId, day, { transaction }),
  ]);
  return { feesPoisha, salesPoisha, expensesPoisha };
}

async function view(gymId, day) {
  const s = await GymCashSession.findOne({ where: { gymId, businessDate: day } });
  const cash = await cashOf(gymId, day);
  const names = s ? await directory.displayNames([s.openedBy, s.closedBy].filter(Boolean)) : new Map();
  const expected = s ? (s.status === 'closed' ? s.expectedPoisha : rules.drawerExpected({ opening: s.openingPoisha, cashFees: cash.feesPoisha, cashSales: cash.salesPoisha, drawerExpenses: cash.expensesPoisha })) : null;
  return {
    date: day,
    status: s ? s.status : 'not_open',
    openingPoisha: s?.openingPoisha ?? null,
    openedBy: s ? (names.get(s.openedBy) ?? null) : null,
    openedAt: c.iso(s?.openedAt),
    cash: { ...cash, expectedPoisha: expected },
    countedPoisha: s?.countedPoisha ?? null,
    differencePoisha: s?.differencePoisha ?? null,
    closedBy: s?.closedBy ? (names.get(s.closedBy) ?? null) : null,
    closedAt: c.iso(s?.closedAt),
    closeNote: s?.closeNote ?? null,
  };
}

/** GET …/cash-drawer?date (cash.drawer): the day's drawer, live until it is closed. */
async function get(principal, gymId, { date } = {}) {
  await c.access(principal, gymId, null, { anyOf: ['cash.drawer', 'reports.view'], feature: FEATURE });
  return view(gymId, date ?? c.today());
}

/** POST …/cash-drawer/open (cash.drawer): open today's drawer with the float (M27-FR-06). */
async function open(principal, gymId, { openingPoisha }, req) {
  const a = await c.access(principal, gymId, 'cash.drawer', { feature: FEATURE });
  const block = rules.amountBlock(openingPoisha, { min: 0, max: c.cfg().floatMax });
  if (block) throw c.fail(block, { max: c.cfg().floatMax });
  const day = c.today();
  try {
    await sequelize.transaction(async (transaction) => {
      const s = await GymCashSession.create({ gymId, businessDate: day, openingPoisha, openedBy: principal.id, openedAt: new Date() }, { transaction });
      await c.publish(transaction, 'gym_cash.opened', 'gym_cash_session', s.id, { sessionId: s.id, gymId, date: day, opening: openingPoisha }, a.actor);
      await c.record({ action: 'gym_cash.opened', actor: a.actor, entityType: 'gym_cash_session', entityId: s.id, after: { date: day, opening: openingPoisha }, meta: { gymId }, req }, transaction);
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw c.fail('GYM_DRAWER_OPEN');
    throw err;
  }
  return view(gymId, day);
}

/** POST …/cash-drawer/close (cash.drawer): count the cash; expected and the difference are kept (M27-FR-08). */
async function close(principal, gymId, { countedPoisha, note = null }, req) {
  const a = await c.access(principal, gymId, 'cash.drawer', { feature: FEATURE });
  const day = c.today();
  await sequelize.transaction(async (transaction) => {
    const s = await GymCashSession.findOne({ where: { gymId, businessDate: day }, transaction, lock: transaction.LOCK.UPDATE });
    if (!s) throw c.fail('GYM_DRAWER_NOT_OPEN');
    if (s.status === 'closed') throw c.fail('GYM_DRAWER_CLOSED');
    const cash = await cashOf(gymId, day, { transaction });
    const expected = rules.drawerExpected({ opening: s.openingPoisha, cashFees: cash.feesPoisha, cashSales: cash.salesPoisha, drawerExpenses: cash.expensesPoisha });
    const result = rules.drawerClose({ expected, counted: countedPoisha });
    await s.update({ status: 'closed', countedPoisha, expectedPoisha: expected, differencePoisha: result.difference, closeNote: note, closedBy: principal.id, closedAt: new Date() }, { transaction });
    await c.publish(transaction, 'gym_cash.closed', 'gym_cash_session', s.id, { sessionId: s.id, gymId, date: day, expected, counted: countedPoisha, difference: result.difference }, a.actor);
    await c.record(
      { action: 'gym_cash.closed', actor: a.actor, entityType: 'gym_cash_session', entityId: s.id, reason: note, after: { date: day, expected, counted: countedPoisha, difference: result.difference }, meta: { gymId }, req },
      transaction
    );
  });
  return view(gymId, day);
}

/** Is the gym's cash drawer for a Dhaka day closed? (gym-manage's offline desk flags late cash, M24-FR-149.) */
async function closedOn(gymId, day, { transaction } = {}) {
  const s = await GymCashSession.findOne({ where: { gymId, businessDate: day }, attributes: ['status'], transaction });
  return s?.status === 'closed';
}

module.exports = { get, open, close, cashOf, closedOn };
