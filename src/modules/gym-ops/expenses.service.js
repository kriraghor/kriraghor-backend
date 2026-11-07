'use strict';

/**
 * M27 expenses (M27-FR-01..05): what a gym spends, by category, with the method and whether the cash came
 * out of today's drawer. Expenses are voided with a reason, never deleted. Permission expenses.manage
 * (lists also for reports.view); plan feature `expenses`. Bookkeeping only.
 */
const { Op, QueryTypes } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, GymExpense, GymExpenseCategory, GymCashSession } = require('../../models');
const directory = require('../users').directory;
const rules = require('./gym-ops.rules');
const c = require('./gym-ops.common');

const FEATURE = 'expenses';

/** The gym's categories; the defaults are created the first time (M27-FR-01). */
async function categoriesOf(gymId, { transaction } = {}) {
  const rows = await GymExpenseCategory.findAll({ where: { gymId }, order: [['sort', 'ASC'], ['name', 'ASC']], transaction });
  if (rows.length) return rows;
  await GymExpenseCategory.bulkCreate(rules.DEFAULT_CATEGORIES.map((d, i) => ({ gymId, key: d.key, name: d.name, sort: i + 1 })), { transaction, ignoreDuplicates: true });
  return GymExpenseCategory.findAll({ where: { gymId }, order: [['sort', 'ASC'], ['name', 'ASC']], transaction });
}

const categoryView = (x) => ({ id: x.id, key: x.key ?? null, name: x.name, sort: x.sort, status: x.status });

/** GET …/expense-categories (expenses.manage or reports.view). */
async function categories(principal, gymId) {
  await c.access(principal, gymId, null, { anyOf: ['expenses.manage', 'reports.view'], feature: FEATURE });
  return { items: (await categoriesOf(gymId)).map(categoryView) };
}

/** PUT …/expense-categories (owner): rename, add or retire categories; keyed ones keep their key. */
async function saveCategories(principal, gymId, { categories: list }, req) {
  const a = await c.access(principal, gymId, 'owner.only', { feature: FEATURE, restricted: true });
  await sequelize.transaction(async (transaction) => {
    const existing = new Map((await categoriesOf(gymId, { transaction })).map((x) => [x.id, x]));
    let sort = 0;
    for (const item of list) {
      sort += 1;
      if (item.id) {
        const row = existing.get(item.id);
        if (!row) throw c.fail('GYM_EXPENSE_CATEGORY_UNKNOWN');
        await row.update({ name: item.name, status: item.status, sort }, { transaction });
      } else {
        await GymExpenseCategory.create({ gymId, name: item.name, status: item.status, sort }, { transaction });
      }
    }
    await c.record({ action: 'gym_expense.categories_saved', actor: a.actor, entityType: 'gym', entityId: gymId, after: { count: list.length }, meta: { gymId }, req }, transaction);
  });
  return categories(principal, gymId);
}

async function expenseView(x, { categories: cats, names }) {
  const cat = cats.get(x.categoryId);
  return {
    id: x.id,
    category: { id: x.categoryId, name: cat?.name ?? '', key: cat?.key ?? null },
    amountPoisha: x.amountPoisha,
    spentOn: x.spentOn,
    method: x.method,
    fromDrawer: x.fromDrawer,
    payee: x.payee ?? null,
    note: x.note ?? null,
    source: x.source,
    status: x.status,
    voidReason: x.voidReason ?? null,
    createdBy: names.get(x.createdBy) ?? null,
    createdAt: c.iso(x.createdAt),
  };
}

/** GET …/expenses (expenses.manage or reports.view): newest first, filtered by dates, category and status. */
async function list(principal, gymId, { from, to, categoryId, status, cursor, limit = 25 } = {}) {
  await c.access(principal, gymId, null, { anyOf: ['expenses.manage', 'reports.view'], feature: FEATURE });
  const where = { gymId, ...(categoryId ? { categoryId } : {}), ...(status ? { status } : {}) };
  if (from || to) where.spentOn = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lte]: to } : {}) };
  const offset = cursor ? Number(cursor) || 0 : 0;
  const rows = await GymExpense.findAll({ where, order: [['spentOn', 'DESC'], ['createdAt', 'DESC']], offset, limit: limit + 1 });
  const page = rows.slice(0, limit);
  const [cats, names, total] = await Promise.all([
    categoriesOf(gymId).then((xs) => new Map(xs.map((x) => [x.id, x]))),
    directory.displayNames([...new Set(page.map((x) => x.createdBy))]),
    GymExpense.sum('amountPoisha', { where: { ...where, status: 'recorded' } }),
  ]);
  return { items: await Promise.all(page.map((x) => expenseView(x, { categories: cats, names }))), totalPoisha: Number(total ?? 0), nextCursor: rows.length > limit ? String(offset + limit) : null };
}

/** A drawer for that day that is already closed refuses cash entries from the drawer (M27-FR-09). */
async function refuseClosedDrawer(gymId, day, transaction) {
  const s = await GymCashSession.findOne({ where: { gymId, businessDate: day }, transaction });
  if (s?.status === 'closed') throw c.fail('GYM_DRAWER_CLOSED');
}

/** POST …/expenses (expenses.manage, Idempotency-Key): record one (M27-FR-02, FR-03). */
async function create(principal, gymId, input, req) {
  const a = await c.access(principal, gymId, 'expenses.manage', { feature: FEATURE, restricted: true });
  const cfg = c.cfg();
  const today = c.today();
  const spentOn = input.spentOn ?? today;
  const block = rules.amountBlock(input.amountPoisha, { max: cfg.expenseMax }) ?? rules.pastDateBlock(spentOn, { today, backdateDays: cfg.backdateDays });
  if (block) throw c.fail(block, { max: cfg.expenseMax });
  if (input.fromDrawer && input.method !== 'cash') throw E.validation([{ field: 'fromDrawer', message: 'Only cash can come from the drawer' }]);
  const expense = await sequelize.transaction(async (transaction) => {
    const cat = await GymExpenseCategory.findOne({ where: { id: input.categoryId, gymId, status: 'active' }, transaction });
    if (!cat) throw c.fail('GYM_EXPENSE_CATEGORY_UNKNOWN');
    if (input.fromDrawer) await refuseClosedDrawer(gymId, spentOn, transaction);
    const x = await GymExpense.create(
      { gymId, categoryId: cat.id, amountPoisha: input.amountPoisha, spentOn, method: input.method, fromDrawer: Boolean(input.fromDrawer), payee: input.payee ?? null, note: input.note ?? null, createdBy: principal.id },
      { transaction }
    );
    await c.publish(transaction, 'gym_expense.recorded', 'gym_expense', x.id, { expenseId: x.id, gymId, amount: x.amountPoisha, categoryKey: cat.key ?? null, method: x.method, fromDrawer: x.fromDrawer, spentOn }, a.actor);
    await c.record({ action: 'gym_expense.recorded', actor: a.actor, entityType: 'gym_expense', entityId: x.id, after: { amount: x.amountPoisha, category: cat.name, method: x.method }, meta: { gymId }, req }, transaction);
    return x;
  });
  return one(gymId, expense.id);
}

/**
 * M27-FR-80, FR-84: an expense another part of gym-ops records inside its own transaction (a paid payroll
 * line, a service or repair cost) in the category with this key (made with the defaults if needed). Not
 * checked against the expense limit: the caller checks its own. Returns the row.
 */
async function systemExpenseIn(transaction, { gymId, categoryKey, amountPoisha, spentOn, method, fromDrawer = false, payee = null, note = null, source, sourceId, by, actor = null, req = null }) {
  const cats = await categoriesOf(gymId, { transaction });
  const cat = cats.find((x) => x.key === categoryKey) ?? cats.find((x) => x.key === 'other');
  if (fromDrawer) await refuseClosedDrawer(gymId, spentOn, transaction);
  const x = await GymExpense.create({ gymId, categoryId: cat.id, amountPoisha, spentOn, method, fromDrawer, payee, note, source, sourceId, createdBy: by }, { transaction });
  await c.publish(transaction, 'gym_expense.recorded', 'gym_expense', x.id, { expenseId: x.id, gymId, amount: amountPoisha, categoryKey: cat.key ?? null, method, fromDrawer, spentOn, source }, actor);
  await c.record({ action: 'gym_expense.recorded', actor, entityType: 'gym_expense', entityId: x.id, after: { amount: amountPoisha, category: cat.name, method, source }, meta: { gymId }, req }, transaction);
  return x;
}

/** POST …/expenses/:expenseId/void (expenses.manage): a reason, never a delete (M27-FR-04). */
async function voidOne(principal, gymId, expenseId, { reason }, req) {
  const a = await c.access(principal, gymId, 'expenses.manage', { feature: FEATURE, restricted: true });
  await sequelize.transaction(async (transaction) => {
    const x = await GymExpense.findOne({ where: { id: expenseId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!x) throw E.notFound('Expense');
    if (x.status === 'void') throw c.fail('GYM_EXPENSE_STATE');
    if (x.fromDrawer) await refuseClosedDrawer(gymId, x.spentOn, transaction);
    await x.update({ status: 'void', voidReason: reason, voidedBy: principal.id, voidedAt: new Date() }, { transaction });
    await c.publish(transaction, 'gym_expense.voided', 'gym_expense', x.id, { expenseId: x.id, gymId, amount: x.amountPoisha }, a.actor);
    await c.record({ action: 'gym_expense.voided', actor: a.actor, entityType: 'gym_expense', entityId: x.id, reason, after: { amount: x.amountPoisha }, meta: { gymId }, req }, transaction);
  });
  return one(gymId, expenseId);
}

async function one(gymId, expenseId) {
  const x = await GymExpense.findOne({ where: { id: expenseId, gymId } });
  const cats = new Map((await categoriesOf(gymId)).map((y) => [y.id, y]));
  return expenseView(x, { categories: cats, names: await directory.displayNames([x.createdBy]) });
}

/** For the drawer and profit and loss: recorded expenses of a period, total by category; cash from the drawer of one day. */
async function totals(gymId, from, to) {
  const rows = await sequelize.query(
    `SELECT x.category_id AS "categoryId", c.name, COALESCE(SUM(x.amount_poisha), 0)::bigint AS amount
       FROM gym_expenses x JOIN gym_expense_categories c ON c.id = x.category_id
      WHERE x.gym_id = :gymId AND x.status = 'recorded' AND x.spent_on BETWEEN :from AND :to
      GROUP BY x.category_id, c.name ORDER BY amount DESC`,
    { replacements: { gymId, from, to }, type: QueryTypes.SELECT }
  );
  return rows.map((r) => ({ categoryId: r.categoryId, name: r.name, amount: Number(r.amount) }));
}

async function drawerCash(gymId, day, { transaction } = {}) {
  const sum = await GymExpense.sum('amountPoisha', { where: { gymId, spentOn: day, fromDrawer: true, status: 'recorded' }, transaction });
  return Number(sum ?? 0);
}

module.exports = { categories, saveCategories, list, create, voidOne, totals, drawerCash, refuseClosedDrawer, systemExpenseIn };
