'use strict';

/**
 * M27 payroll (M27-FR-76..81; plan feature `payroll`, Pro; the owner only): each staff member's pay terms
 * (monthly base, a trainer's commission on the fees of the members assigned to them, a commission on their
 * counter sales), a month's payroll draft → approved → paid with bonuses and deductions, each paid line a
 * salary expense, and payslips (the owner, and each staff member for their own lines). The gym's own record:
 * Kriraghor never pays staff and nothing touches the ledger.
 */
const { QueryTypes } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, GymStaffPay, GymPayrollRun, GymPayrollLine } = require('../../models');
const directory = require('../users').directory;
const rules = require('./gym-ops.rules');
const c = require('./gym-ops.common');
const staffSvc = require('./staff.service');
const expenses = require('./expenses.service');

const FEATURE = 'payroll';
const OWNER = 'owner.only';

const termsView = (t) => ({ basePoisha: t?.basePoisha ?? 0, ptCommissionBps: t?.ptCommissionBps ?? 0, salesCommissionBps: t?.salesCommissionBps ?? 0, note: t?.note ?? null, set: Boolean(t) });

// ---------------------------------------------------------------- pay terms

/** GET …/staff-pay (owner): every active staff member with their pay terms (M27-FR-76). */
async function payTerms(principal, gymId) {
  await c.access(principal, gymId, OWNER, { feature: FEATURE });
  const [staff, rows] = await Promise.all([staffSvc.staffOf(gymId), GymStaffPay.findAll({ where: { gymId } })]);
  const by = new Map(rows.map((r) => [r.businessMemberId, r]));
  return {
    limits: { salaryMax: c.cfg().salaryMax, commissionMax: c.cfg().commissionMax },
    items: staff.filter((s) => s.status === 'active').map((s) => ({ staff: { id: s.id, userId: s.userId, name: s.name, trainer: s.permissions.includes('members.trainer') || s.permissions.includes('plans.manage'), seller: s.permissions.includes('pos.sell') }, terms: termsView(by.get(s.id)) })),
  };
}

/** PUT …/staff/:staffId/pay (owner): a staff member's pay terms; the next draft uses them (M27-FR-76). */
async function setPayTerms(principal, gymId, staffId, input, req) {
  const a = await c.access(principal, gymId, OWNER, { feature: FEATURE, restricted: true });
  const s = await staffSvc.staffMember(gymId, staffId);
  if (s.status !== 'active') throw c.fail('GYM_STAFF_UNKNOWN');
  const cfg = c.cfg();
  const block = rules.payTermsBlock(input, { salaryMax: cfg.salaryMax, commissionMax: cfg.commissionMax });
  if (block) throw c.fail(block, { salaryMax: cfg.salaryMax, commissionMax: cfg.commissionMax });
  await sequelize.transaction(async (transaction) => {
    const row = await GymStaffPay.findOne({ where: { businessMemberId: staffId }, transaction, lock: transaction.LOCK.UPDATE });
    const values = { basePoisha: input.basePoisha, ptCommissionBps: input.ptCommissionBps, salesCommissionBps: input.salesCommissionBps, note: input.note ?? null, updatedBy: principal.id };
    const before = row ? termsView(row) : null;
    if (row) await row.update(values, { transaction });
    else await GymStaffPay.create({ gymId, businessMemberId: staffId, ...values }, { transaction });
    await c.record({ action: 'gym_staff.pay_set', actor: a.actor, entityType: 'business_member', entityId: staffId, before, after: { base: values.basePoisha, ptBps: values.ptCommissionBps, salesBps: values.salesCommissionBps }, meta: { gymId }, req }, transaction);
  });
  return { staff: { id: s.id, userId: s.userId, name: s.name }, terms: termsView(await GymStaffPay.findOne({ where: { businessMemberId: staffId } })) };
}

// ---------------------------------------------------------------- the month's facts

/** Counter sales of a month by seller (user id), recorded and not reversed (M27-FR-78). */
async function salesBySeller(gymId, from, to, transaction) {
  const rows = await sequelize.query(
    "SELECT sold_by AS \"userId\", COALESCE(SUM(total_poisha), 0)::bigint AS total FROM gym_sales WHERE gym_id = :gymId AND kind = 'pos' AND status = 'recorded' AND sold_on BETWEEN :from AND :to GROUP BY sold_by",
    { replacements: { gymId, from, to }, type: QueryTypes.SELECT, transaction }
  );
  return new Map(rows.map((r) => [r.userId, Number(r.total)]));
}

/** The computed part of every line of a month: terms × facts, keeping the bonus, deduction and note given. */
async function computeLines(gymId, period, transaction, keep = new Map()) {
  const { from, to } = rules.periodRange(period);
  const [staff, terms, fees, sales, attendance] = await Promise.all([
    staffSvc.staffOf(gymId),
    GymStaffPay.findAll({ where: { gymId }, transaction }),
    c.ops.feesByTrainer(gymId, from, to),
    salesBySeller(gymId, from, to, transaction),
    staffSvc.monthFacts(gymId, period),
  ]);
  const people = new Map(staff.map((s) => [s.id, s]));
  return terms
    .filter((t) => people.get(t.businessMemberId)?.status === 'active' || keep.has(t.businessMemberId))
    .map((t) => {
      const s = people.get(t.businessMemberId);
      const kept = keep.get(t.businessMemberId) ?? {};
      const amounts = rules.payrollLine({
        basePoisha: t.basePoisha,
        ptCommissionBps: t.ptCommissionBps,
        salesCommissionBps: t.salesCommissionBps,
        ptBasePoisha: fees.get(t.businessMemberId) ?? 0,
        salesBasePoisha: sales.get(s.userId) ?? 0,
        bonusPoisha: kept.bonusPoisha ?? 0,
        deductionPoisha: kept.deductionPoisha ?? 0,
      });
      const f = attendance.get(t.businessMemberId) ?? { workedMinutes: 0, late: 0, missed: 0 };
      return { businessMemberId: t.businessMemberId, userId: s.userId, ...amounts, netPoisha: Math.max(0, amounts.netPoisha), deductionPoisha: amounts.netPoisha < 0 ? amounts.deductionPoisha + amounts.netPoisha : amounts.deductionPoisha, workedMinutes: f.workedMinutes, lateCount: f.late, missedCount: f.missed, note: kept.note ?? null };
    });
}

// ---------------------------------------------------------------- views

function lineView(l, names) {
  return {
    id: l.id,
    staff: { id: l.businessMemberId, userId: l.userId, name: names.get(l.userId) ?? null },
    basePoisha: l.basePoisha,
    ptBasePoisha: l.ptBasePoisha,
    ptCommissionBps: l.ptCommissionBps,
    ptCommissionPoisha: l.ptCommissionPoisha,
    salesBasePoisha: l.salesBasePoisha,
    salesCommissionBps: l.salesCommissionBps,
    salesCommissionPoisha: l.salesCommissionPoisha,
    bonusPoisha: l.bonusPoisha,
    deductionPoisha: l.deductionPoisha,
    netPoisha: l.netPoisha,
    workedMinutes: l.workedMinutes,
    lateCount: l.lateCount,
    missedCount: l.missedCount,
    note: l.note ?? null,
    status: l.status,
    paidMethod: l.paidMethod ?? null,
    paidOn: l.paidOn ?? null,
  };
}

function runSummary(r, lines) {
  return {
    id: r.id,
    period: r.period,
    status: r.status,
    staffCount: lines.length,
    totalNetPoisha: lines.reduce((n, l) => n + l.netPoisha, 0),
    paidPoisha: lines.filter((l) => l.status === 'paid').reduce((n, l) => n + l.netPoisha, 0),
    approvedAt: c.iso(r.approvedAt),
    paidAt: c.iso(r.paidAt),
    voidReason: r.voidReason ?? null,
    createdAt: c.iso(r.createdAt),
  };
}

async function runView(gymId, runId) {
  const r = await GymPayrollRun.findOne({ where: { id: runId, gymId } });
  if (!r) throw E.notFound('Payroll');
  const lines = await GymPayrollLine.findAll({ where: { runId: r.id }, order: [['createdAt', 'ASC']] });
  const names = await directory.displayNames([...new Set(lines.map((l) => l.userId))]);
  return { ...runSummary(r, lines), lines: lines.map((l) => lineView(l, names)) };
}

// ---------------------------------------------------------------- runs

/** GET …/payroll (owner): the runs, newest month first. */
async function runs(principal, gymId) {
  await c.access(principal, gymId, OWNER, { feature: FEATURE });
  const rows = await GymPayrollRun.findAll({ where: { gymId }, order: [['period', 'DESC'], ['createdAt', 'DESC']], limit: 36 });
  const lines = rows.length ? await GymPayrollLine.findAll({ where: { runId: rows.map((r) => r.id) } }) : [];
  return { items: rows.map((r) => runSummary(r, lines.filter((l) => l.runId === r.id))) };
}

/** GET …/payroll/:runId (owner). */
async function run(principal, gymId, runId) {
  await c.access(principal, gymId, OWNER, { feature: FEATURE });
  return runView(gymId, runId);
}

/** POST …/payroll { period } (owner): a draft for a month from the pay terms and the month's facts (M27-FR-77). */
async function create(principal, gymId, { period }, req) {
  const a = await c.access(principal, gymId, OWNER, { feature: FEATURE, restricted: true });
  if (rules.periodBlock(period, c.today())) throw c.fail('GYM_PAYROLL_PERIOD');
  const runId = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `gym_payroll:${gymId}:${period}` }, transaction });
    if (await GymPayrollRun.findOne({ where: { gymId, period, status: ['draft', 'approved', 'paid'] }, transaction })) throw c.fail('GYM_PAYROLL_EXISTS');
    const lines = await computeLines(gymId, period, transaction);
    if (!lines.length) throw c.fail('GYM_PAYROLL_EMPTY');
    const r = await GymPayrollRun.create({ gymId, period, createdBy: principal.id }, { transaction });
    for (const l of lines) await GymPayrollLine.create({ runId: r.id, gymId, ...l }, { transaction });
    await c.record({ action: 'gym_payroll.drafted', actor: a.actor, entityType: 'gym_payroll_run', entityId: r.id, after: { period, staff: lines.length }, meta: { gymId }, req }, transaction);
    return r.id;
  });
  return runView(gymId, runId);
}

async function lockedRun(transaction, gymId, runId) {
  const r = await GymPayrollRun.findOne({ where: { id: runId, gymId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!r) throw E.notFound('Payroll');
  return r;
}

/** POST …/payroll/:runId/recalculate (owner): a draft takes the latest fees, sales and clock times; bonuses and deductions stay. */
async function recalculate(principal, gymId, runId, req) {
  const a = await c.access(principal, gymId, OWNER, { feature: FEATURE, restricted: true });
  await sequelize.transaction(async (transaction) => {
    const r = await lockedRun(transaction, gymId, runId);
    if (r.status !== 'draft') throw c.fail('GYM_PAYROLL_STATE');
    const old = await GymPayrollLine.findAll({ where: { runId: r.id }, transaction });
    const keep = new Map(old.map((l) => [l.businessMemberId, { bonusPoisha: l.bonusPoisha, deductionPoisha: l.deductionPoisha, note: l.note }]));
    const fresh = await computeLines(gymId, r.period, transaction, keep);
    for (const l of fresh) {
      const row = old.find((o) => o.businessMemberId === l.businessMemberId);
      if (row) await row.update(l, { transaction });
      else await GymPayrollLine.create({ runId: r.id, gymId, ...l }, { transaction });
    }
    await r.update({ updatedAt: new Date() }, { transaction });
    await c.record({ action: 'gym_payroll.recalculated', actor: a.actor, entityType: 'gym_payroll_run', entityId: r.id, after: { staff: fresh.length }, meta: { gymId }, req }, transaction);
  });
  return runView(gymId, runId);
}

/** PATCH …/payroll/:runId/lines/:lineId { bonusPoisha, deductionPoisha, note } (owner, draft only; M27-FR-78). */
async function updateLine(principal, gymId, runId, lineId, input, req) {
  const a = await c.access(principal, gymId, OWNER, { feature: FEATURE, restricted: true });
  await sequelize.transaction(async (transaction) => {
    const r = await lockedRun(transaction, gymId, runId);
    if (r.status !== 'draft') throw c.fail('GYM_PAYROLL_STATE');
    const l = await GymPayrollLine.findOne({ where: { id: lineId, runId: r.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!l) throw E.notFound('Payroll line');
    const bonusPoisha = input.bonusPoisha ?? l.bonusPoisha;
    const deductionPoisha = input.deductionPoisha ?? l.deductionPoisha;
    const amounts = rules.payrollLine({ ...l.get(), bonusPoisha, deductionPoisha });
    const block = rules.lineBlock(amounts, { adjustMax: c.cfg().payrollAdjustMax });
    if (block) throw c.fail(block, { max: c.cfg().payrollAdjustMax });
    await l.update({ bonusPoisha, deductionPoisha, netPoisha: amounts.netPoisha, note: input.note === undefined ? l.note : input.note }, { transaction });
    await c.record({ action: 'gym_payroll.line_changed', actor: a.actor, entityType: 'gym_payroll_line', entityId: l.id, after: { bonus: bonusPoisha, deduction: deductionPoisha, net: amounts.netPoisha }, meta: { gymId }, req }, transaction);
  });
  return runView(gymId, runId);
}

/** POST …/payroll/:runId/approve (owner): the amounts are frozen (M27-FR-79). */
async function approve(principal, gymId, runId, req) {
  const a = await c.access(principal, gymId, OWNER, { feature: FEATURE, restricted: true });
  await sequelize.transaction(async (transaction) => {
    const r = await lockedRun(transaction, gymId, runId);
    if (r.status !== 'draft') throw c.fail('GYM_PAYROLL_STATE');
    const lines = await GymPayrollLine.findAll({ where: { runId: r.id }, transaction });
    const now = new Date();
    const allPaid = rules.runPaid(lines);
    await r.update({ status: allPaid ? 'paid' : 'approved', approvedBy: principal.id, approvedAt: now, ...(allPaid ? { paidAt: now } : {}) }, { transaction });
    await c.publish(transaction, 'gym_payroll.approved', 'gym_payroll_run', r.id, { gymId, runId: r.id, period: r.period, staff: lines.length }, a.actor);
    await c.record({ action: 'gym_payroll.approved', actor: a.actor, entityType: 'gym_payroll_run', entityId: r.id, after: { period: r.period, total: lines.reduce((n, l) => n + l.netPoisha, 0) }, meta: { gymId }, req }, transaction);
  });
  return runView(gymId, runId);
}

/** POST …/payroll/:runId/void { reason } (owner): a draft, or an approved run with nothing paid (M27-FR-79). */
async function voidRun(principal, gymId, runId, { reason }, req) {
  const a = await c.access(principal, gymId, OWNER, { feature: FEATURE, restricted: true });
  await sequelize.transaction(async (transaction) => {
    const r = await lockedRun(transaction, gymId, runId);
    const paid = await GymPayrollLine.count({ where: { runId: r.id, status: 'paid' }, transaction });
    if (!['draft', 'approved'].includes(r.status) || paid) throw c.fail('GYM_PAYROLL_STATE');
    await r.update({ status: 'void', voidedBy: principal.id, voidedAt: new Date(), voidReason: reason }, { transaction });
    await c.record({ action: 'gym_payroll.voided', actor: a.actor, entityType: 'gym_payroll_run', entityId: r.id, reason, meta: { gymId }, req }, transaction);
  });
  return runView(gymId, runId);
}

/**
 * POST …/payroll/:runId/lines/:lineId/pay { method, paidOn, fromDrawer } (owner, Idempotency-Key; M27-FR-80):
 * the line is paid and recorded as a salary expense; the run is paid once every line with money is.
 */
async function payLine(principal, gymId, runId, lineId, input, req) {
  const a = await c.access(principal, gymId, OWNER, { feature: FEATURE, restricted: true });
  const today = c.today();
  const paidOn = input.paidOn ?? today;
  if (rules.pastDateBlock(paidOn, { today, backdateDays: c.cfg().backdateDays })) throw c.fail('GYM_DATE_OUT_OF_RANGE');
  if (input.fromDrawer && input.method !== 'cash') throw E.validation([{ field: 'fromDrawer', message: 'Only cash can come from the drawer' }]);
  await sequelize.transaction(async (transaction) => {
    const r = await lockedRun(transaction, gymId, runId);
    if (r.status !== 'approved') throw c.fail('GYM_PAYROLL_STATE');
    const l = await GymPayrollLine.findOne({ where: { id: lineId, runId: r.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!l) throw E.notFound('Payroll line');
    if (l.status === 'paid' || l.netPoisha === 0) throw c.fail('GYM_PAYROLL_LINE_STATE');
    const names = await directory.displayNames([l.userId]);
    const x = await expenses.systemExpenseIn(transaction, {
      gymId,
      categoryKey: 'salaries',
      amountPoisha: l.netPoisha,
      spentOn: paidOn,
      method: input.method,
      fromDrawer: Boolean(input.fromDrawer),
      payee: (names.get(l.userId) ?? '').slice(0, 80) || null,
      note: `Payroll ${r.period}`,
      source: 'payroll',
      sourceId: l.id,
      by: principal.id,
      actor: a.actor,
      req,
    });
    await l.update({ status: 'paid', paidMethod: input.method, paidOn, expenseId: x.id, paidBy: principal.id }, { transaction });
    const lines = await GymPayrollLine.findAll({ where: { runId: r.id }, transaction });
    if (rules.runPaid(lines)) await r.update({ status: 'paid', paidAt: new Date() }, { transaction });
    await c.publish(transaction, 'gym_payroll_line.paid', 'gym_payroll_line', l.id, { gymId, runId: r.id, lineId: l.id, userId: l.userId, period: r.period }, a.actor);
    await c.record({ action: 'gym_payroll.line_paid', actor: a.actor, entityType: 'gym_payroll_line', entityId: l.id, after: { net: l.netPoisha, method: input.method, paidOn }, meta: { gymId }, req }, transaction);
  });
  return runView(gymId, runId);
}

// ---------------------------------------------------------------- payslips

async function slip(gym, l, r) {
  const names = await directory.displayNames([l.userId]);
  return { gym: { id: gym.id, name: gym.name, address: gym.addressLine ?? null }, period: r.period, runStatus: r.status, line: lineView(l, names) };
}

/** GET …/payroll/:runId/lines/:lineId/payslip (the owner, or the staff member it belongs to once approved; M27-FR-81). */
async function payslip(principal, gymId, runId, lineId) {
  // Any staff member may read their own payslip, whatever their permissions (null: the owner or any staff).
  const a = await c.access(principal, gymId, null, { feature: FEATURE });
  const r = await GymPayrollRun.findOne({ where: { id: runId, gymId } });
  const l = r ? await GymPayrollLine.findOne({ where: { id: lineId, runId: r.id } }) : null;
  if (!l || (!a.owner && (l.userId !== principal.id || !['approved', 'paid'].includes(r.status)))) throw E.notFound('Payslip');
  return slip(a.gym, l, r);
}

/** GET …/my-payslips (any staff member): my approved and paid lines at this gym, newest first (M27-FR-81). */
async function myPayslips(principal, gymId) {
  await c.access(principal, gymId, null, { feature: FEATURE });
  const rows = await sequelize.query(
    `SELECT l.id, r.id AS "runId", r.period, r.status AS "runStatus", l.net_poisha AS net, l.status, l.paid_on AS "paidOn"
       FROM gym_payroll_lines l JOIN gym_payroll_runs r ON r.id = l.run_id
      WHERE l.gym_id = :gymId AND l.user_id = :userId AND r.status IN ('approved', 'paid')
      ORDER BY r.period DESC LIMIT 24`,
    { replacements: { gymId, userId: principal.id }, type: QueryTypes.SELECT }
  );
  return { items: rows.map((x) => ({ lineId: x.id, runId: x.runId, period: x.period, netPoisha: Number(x.net), status: x.status, paidOn: x.paidOn ?? null })) };
}

module.exports = { payTerms, setPayTerms, runs, run, create, recalculate, updateLine, approve, voidRun, payLine, payslip, myPayslips, computeLines };
