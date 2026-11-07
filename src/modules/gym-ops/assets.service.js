'use strict';

/**
 * M27 equipment register (M27-FR-82..86; plan feature `equipment`, Standard; permission assets.manage, reads
 * also reports.view): machines with a category, serial, purchase date and cost, a status and a service
 * interval; a log of services, repairs, status changes and notes (append-only), a cost optionally recorded
 * as an equipment-repair expense; a daily reminder when service is due. Machines are retired, never deleted.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, GymAsset, GymAssetLog } = require('../../models');
const directory = require('../users').directory;
const staffFacade = require('../business-members').members;
const rules = require('./gym-ops.rules');
const c = require('./gym-ops.common');
const expenses = require('./expenses.service');

const FEATURE = 'equipment';
const WRITE = 'assets.manage';
const READ = ['assets.manage', 'reports.view'];

function assetView(x, today) {
  return {
    id: x.id,
    name: x.name,
    category: x.category,
    brand: x.brand ?? null,
    serial: x.serial ?? null,
    location: x.location ?? null,
    boughtOn: x.boughtOn ?? null,
    costPoisha: x.costPoisha ?? null,
    status: x.status,
    serviceEveryDays: x.serviceEveryDays ?? null,
    lastServiceOn: x.lastServiceOn ?? null,
    nextServiceOn: x.nextServiceOn ?? null,
    serviceDue: Boolean(x.nextServiceOn && x.status !== 'retired' && x.nextServiceOn <= today),
    note: x.note ?? null,
  };
}

const logView = (x, names) => ({
  id: x.id,
  kind: x.kind,
  doneOn: x.doneOn,
  costPoisha: x.costPoisha ?? null,
  statusAfter: x.statusAfter ?? null,
  note: x.note ?? null,
  expenseId: x.expenseId ?? null,
  by: { id: x.byUser, displayName: names.get(x.byUser) ?? null },
  createdAt: c.iso(x.createdAt),
});

function costBlock(cost) {
  if (cost === null || cost === undefined) return null;
  return rules.amountBlock(cost, { min: 0, max: c.cfg().assetCostMax });
}

/** GET …/assets?status= (assets.manage or reports.view): the register with counts and what is due (M27-FR-82). */
async function list(principal, gymId, { status } = {}) {
  await c.access(principal, gymId, null, { feature: FEATURE, anyOf: READ });
  const today = c.today();
  const rows = await GymAsset.findAll({ where: { gymId, ...(status ? { status } : { status: { [Op.ne]: 'retired' } }) }, order: [['name', 'ASC']] });
  const all = await GymAsset.findAll({ where: { gymId }, attributes: ['status', 'nextServiceOn'] });
  const counts = Object.fromEntries(rules.ASSET_STATUSES.map((s) => [s, all.filter((x) => x.status === s).length]));
  const due = all.filter((x) => x.status !== 'retired' && x.nextServiceOn && x.nextServiceOn <= today).length;
  return { counts: { ...counts, serviceDue: due }, items: rows.map((x) => assetView(x, today)) };
}

/** POST …/assets (assets.manage): add a machine (M27-FR-82, FR-83). */
async function create(principal, gymId, input, req) {
  const a = await c.access(principal, gymId, WRITE, { feature: FEATURE, restricted: true });
  const cfg = c.cfg();
  const today = c.today();
  if (costBlock(input.costPoisha)) throw c.fail('GYM_AMOUNT_OUT_OF_RANGE', { max: cfg.assetCostMax });
  if ((input.boughtOn && input.boughtOn > today) || (input.lastServiceOn && input.lastServiceOn > today)) throw c.fail('GYM_DATE_OUT_OF_RANGE');
  const id = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `gym_assets:${gymId}` }, transaction });
    if ((await GymAsset.count({ where: { gymId, status: { [Op.ne]: 'retired' } }, transaction })) >= cfg.assetsMax) throw c.fail('GYM_ASSET_LIMIT', { max: cfg.assetsMax });
    const every = input.serviceEveryDays ?? null;
    const x = await GymAsset.create(
      {
        gymId,
        name: input.name,
        category: input.category,
        brand: input.brand ?? null,
        serial: input.serial ?? null,
        location: input.location ?? null,
        boughtOn: input.boughtOn ?? null,
        costPoisha: input.costPoisha ?? null,
        status: input.status ?? 'working',
        serviceEveryDays: every,
        lastServiceOn: input.lastServiceOn ?? null,
        nextServiceOn: rules.nextServiceOn({ every, lastServiceOn: input.lastServiceOn, boughtOn: input.boughtOn, today }),
        note: input.note ?? null,
        createdBy: principal.id,
      },
      { transaction }
    );
    await c.record({ action: 'gym_asset.added', actor: a.actor, entityType: 'gym_asset', entityId: x.id, after: { name: x.name, category: x.category }, meta: { gymId }, req }, transaction);
    return x.id;
  });
  return assetView(await GymAsset.findByPk(id), today);
}

/** PATCH …/assets/:assetId (assets.manage): details, the interval, a status change (logged), retiring (final). */
async function update(principal, gymId, assetId, input, req) {
  const a = await c.access(principal, gymId, WRITE, { feature: FEATURE, restricted: true });
  const today = c.today();
  if (costBlock(input.costPoisha)) throw c.fail('GYM_AMOUNT_OUT_OF_RANGE', { max: c.cfg().assetCostMax });
  if (input.boughtOn && input.boughtOn > today) throw c.fail('GYM_DATE_OUT_OF_RANGE');
  await sequelize.transaction(async (transaction) => {
    const x = await GymAsset.findOne({ where: { id: assetId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!x) throw E.notFound('Machine');
    if (x.status === 'retired') throw c.fail('GYM_ASSET_STATE');
    const next = {};
    for (const k of ['name', 'category', 'brand', 'serial', 'location', 'boughtOn', 'costPoisha', 'note']) if (input[k] !== undefined) next[k] = input[k];
    if (input.serviceEveryDays !== undefined) {
      next.serviceEveryDays = input.serviceEveryDays;
      next.nextServiceOn = rules.nextServiceOn({ every: input.serviceEveryDays, lastServiceOn: x.lastServiceOn, boughtOn: next.boughtOn ?? x.boughtOn, today });
      next.serviceAlertedOn = null;
    }
    if (input.status && input.status !== x.status) {
      next.status = input.status;
      await GymAssetLog.create({ assetId: x.id, gymId, kind: 'status', doneOn: today, statusAfter: input.status, note: input.statusNote ?? null, byUser: principal.id }, { transaction });
    }
    await x.update(next, { transaction });
    await c.record({ action: input.status === 'retired' ? 'gym_asset.retired' : 'gym_asset.changed', actor: a.actor, entityType: 'gym_asset', entityId: x.id, after: next, meta: { gymId }, req }, transaction);
  });
  return assetView(await GymAsset.findByPk(assetId), today);
}

/** GET …/assets/:assetId/logs (assets.manage or reports.view): the machine's history, newest first. */
async function logs(principal, gymId, assetId) {
  await c.access(principal, gymId, null, { feature: FEATURE, anyOf: READ });
  const x = await GymAsset.findOne({ where: { id: assetId, gymId } });
  if (!x) throw E.notFound('Machine');
  const rows = await GymAssetLog.findAll({ where: { assetId }, order: [['doneOn', 'DESC'], ['createdAt', 'DESC']], limit: 200 });
  const names = await directory.displayNames([...new Set(rows.map((r) => r.byUser))]);
  return { asset: assetView(x, c.today()), items: rows.map((r) => logView(r, names)) };
}

/**
 * POST …/assets/:assetId/logs { kind, doneOn, costPoisha, note, statusAfter, expense: { method, fromDrawer } }
 * (assets.manage, Idempotency-Key; M27-FR-84): a service moves the next service date on and sets the machine
 * working unless told otherwise; a repair may change the status; a cost can be recorded as an expense.
 */
async function addLog(principal, gymId, assetId, input, req) {
  const a = await c.access(principal, gymId, WRITE, { feature: FEATURE, restricted: true });
  const today = c.today();
  const doneOn = input.doneOn ?? today;
  if (rules.pastDateBlock(doneOn, { today, backdateDays: c.cfg().backdateDays })) throw c.fail('GYM_DATE_OUT_OF_RANGE');
  if (input.costPoisha !== undefined && input.costPoisha !== null && rules.amountBlock(input.costPoisha, { max: c.cfg().assetCostMax })) throw c.fail('GYM_AMOUNT_OUT_OF_RANGE', { max: c.cfg().assetCostMax });
  if (input.expense && !input.costPoisha) throw E.validation([{ field: 'expense', message: 'Enter the cost to record it as an expense' }]);
  if (input.expense?.fromDrawer && input.expense.method !== 'cash') throw E.validation([{ field: 'expense.fromDrawer', message: 'Only cash can come from the drawer' }]);
  await sequelize.transaction(async (transaction) => {
    const x = await GymAsset.findOne({ where: { id: assetId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!x) throw E.notFound('Machine');
    if (x.status === 'retired') throw c.fail('GYM_ASSET_STATE');
    const statusAfter = input.statusAfter ?? (input.kind === 'service' ? 'working' : null);
    let expenseId = null;
    if (input.expense) {
      const ex = await expenses.systemExpenseIn(transaction, {
        gymId,
        categoryKey: 'equipment_repair',
        amountPoisha: input.costPoisha,
        spentOn: doneOn,
        method: input.expense.method,
        fromDrawer: Boolean(input.expense.fromDrawer),
        note: `${input.kind === 'service' ? 'Service' : 'Repair'}: ${x.name}`.slice(0, 300),
        source: 'asset',
        sourceId: x.id,
        by: principal.id,
        actor: a.actor,
        req,
      });
      expenseId = ex.id;
    }
    await GymAssetLog.create({ assetId: x.id, gymId, kind: input.kind, doneOn, costPoisha: input.costPoisha ?? null, statusAfter, note: input.note ?? null, expenseId, byUser: principal.id }, { transaction });
    const next = {};
    if (statusAfter && statusAfter !== x.status) next.status = statusAfter;
    if (input.kind === 'service' && (!x.lastServiceOn || doneOn >= x.lastServiceOn)) {
      next.lastServiceOn = doneOn;
      next.nextServiceOn = rules.nextServiceOn({ every: x.serviceEveryDays, lastServiceOn: doneOn, today });
      next.serviceAlertedOn = null;
    }
    if (Object.keys(next).length) await x.update(next, { transaction });
    if (input.kind === 'service') await c.publish(transaction, 'gym_asset.serviced', 'gym_asset', x.id, { gymId, assetId: x.id, doneOn }, a.actor);
    await c.record({ action: `gym_asset.${input.kind}_logged`, actor: a.actor, entityType: 'gym_asset', entityId: x.id, after: { kind: input.kind, cost: input.costPoisha ?? null, statusAfter }, meta: { gymId }, req }, transaction);
  });
  return logs(principal, gymId, assetId);
}

/** The service reminders of gym-ops.daily (M27-FR-85): once per due date, alertDays ahead, to the owner and assets.manage staff. */
async function serviceReminders(today = c.today()) {
  const alertDays = c.cfg().assetServiceAlertDays;
  const rows = await GymAsset.findAll({ where: { status: { [Op.ne]: 'retired' }, nextServiceOn: { [Op.lte]: rules.addDays(today, alertDays) } } });
  let sent = 0;
  for (const r of rows) {
    if (!rules.serviceAlertDue(r, { today, alertDays })) continue;
    await sequelize.transaction(async (transaction) => {
      const x = await GymAsset.findByPk(r.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!rules.serviceAlertDue(x, { today, alertDays })) return;
      await x.update({ serviceAlertedOn: x.nextServiceOn }, { transaction });
      await c.publish(transaction, 'gym_asset.service_reminded', 'gym_asset', x.id, { gymId: x.gymId, assetId: x.id, item: x.name, dueOn: x.nextServiceOn });
      sent += 1;
    });
  }
  return { sent };
}

/** Recipients of the service reminder: the owner and staff with assets.manage (notification catalogue). */
const reminderStaff = (gymId) => staffFacade.staffRecipients('gym', gymId, WRITE);

module.exports = { list, create, update, logs, addLog, serviceReminders, reminderStaff };
