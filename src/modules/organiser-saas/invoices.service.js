'use strict';

/**
 * M22 invoices (FR-08, FR-09): a flat contract is invoiced for each calendar month or quarter (Dhaka),
 * at activation and then by the tick, once per period (key invoice:{contract}:{period}). Paid through
 * M06 (purpose fee_invoice, grouped by the invoice) and collected straight to fee_revenue:esports_saas.
 * Unpaid after saas.invoice_due_days it turns overdue; once due + saas.overdue_grace_days has passed,
 * the organisation cannot submit new tournaments (running ones are never interrupted). VAT stays 0
 * until saas.vat_enabled (Q136). Percentage contracts are not invoiced: their fee is taken at finalise.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { nextCode } = require('../../common/sequences');
const { sequelize, OrganiserContract, OrganiserInvoice, OrganiserInvoiceLine } = require('../../models');
const audit = require('../audit/audit.service');
const payments = require('../payments').intents;
const purposes = require('../payments').purposes;
const escrow = require('../payments').escrow;
const { payUrl } = require('../payments').intents;
const rules = require('./saas.rules');
const c = require('./saas.common');

const { fail } = c;

function view(i, lines = null) {
  return {
    id: i.id,
    number: i.number,
    organisationId: i.organisationId,
    contractId: i.contractId,
    periodStart: i.periodStart,
    periodEnd: i.periodEnd,
    subtotal: i.subtotalPoisha,
    vat: i.vatPoisha,
    total: i.totalPoisha,
    status: i.status,
    dueAt: c.iso(i.dueAt),
    issuedAt: c.iso(i.issuedAt),
    paidAt: c.iso(i.paidAt),
    voidedAt: c.iso(i.voidedAt),
    voidReason: i.voidReason ?? null,
    lines: lines ? lines.map((l) => ({ id: l.id, kind: l.kind, tournamentId: l.tournamentId ?? null, description: l.description, amount: l.amountPoisha, payable: l.payable })) : undefined,
  };
}

/** Issue the invoice a flat contract owes for today's period, if not issued yet. Inside the caller's transaction. */
async function issueDueInTx(contract, { actor = null, transaction, now = new Date() }) {
  const due = rules.invoiceDue(contract, c.today(now));
  if (!due) return null;
  const key = `invoice:${contract.id}:${due.periodStart}`;
  const existing = await OrganiserInvoice.findOne({ where: { idempotencyKey: key }, transaction });
  if (existing) return existing;
  const cfg = c.config();
  const amounts = rules.invoiceAmounts(due.subtotal, cfg);
  const inv = await OrganiserInvoice.create(
    {
      number: await nextCode('KG-INV', transaction, now),
      organisationId: contract.organisationId,
      contractId: contract.id,
      periodStart: due.periodStart,
      periodEnd: due.periodEnd,
      subtotalPoisha: amounts.subtotal,
      vatPoisha: amounts.vat,
      totalPoisha: amounts.total,
      status: 'issued',
      issuedAt: now,
      dueAt: new Date(now.getTime() + cfg.dueDays * 86400000),
      idempotencyKey: key,
      createdBy: actor?.id ?? null,
    },
    { transaction }
  );
  await OrganiserInvoiceLine.create({ invoiceId: inv.id, kind: 'flat_fee', description: `Esports contract ${due.periodStart} to ${due.periodEnd}`, amountPoisha: amounts.subtotal, payable: true }, { transaction });
  await c.publish(transaction, 'organiser_invoice.issued', 'organiser_invoice', inv.id, { invoiceId: inv.id, number: inv.number, organisationId: inv.organisationId, total: inv.totalPoisha }, actor);
  return inv;
}

/** GET /org/:orgId/billing/invoices and /admin/organiser-invoices?organisationId&status. */
async function list({ organisationId, status } = {}) {
  const rows = await OrganiserInvoice.findAll({ where: { ...(organisationId ? { organisationId } : {}), ...(status ? { status } : {}) }, order: [['issuedAt', 'DESC']], limit: 200 });
  const lines = await OrganiserInvoiceLine.findAll({ where: { invoiceId: rows.map((r) => r.id) } });
  return { items: rows.map((r) => view(r, lines.filter((l) => l.invoiceId === r.id))) };
}

/** Do the organisation's unpaid invoices block new tournaments now? */
async function publishBlocked(organisationId, { transaction, now = new Date() } = {}) {
  const open = await OrganiserInvoice.findAll({ where: { organisationId, status: ['issued', 'overdue'] }, attributes: ['status', 'dueAt'], transaction });
  return rules.publishBlocked(open, now, c.config().graceDays);
}

/** POST /org/:orgId/billing/invoices/:id/pay [Idempotency-Key] (org admin): an M06 payment. */
async function pay(principal, org, invoiceId, idempotencyKey) {
  return sequelize.transaction(async (transaction) => {
    const inv = await OrganiserInvoice.findOne({ where: { id: invoiceId, organisationId: org.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!inv) throw E.notFound('Invoice');
    if (!['issued', 'overdue'].includes(inv.status)) throw fail('INVOICE_STATE');
    const payment = await payments.createIntent(
      { purpose: 'fee_invoice', purposeId: inv.id, payerId: principal.id, amount: inv.totalPoisha, title: `Kriraghor invoice ${inv.number}`, groupRef: inv.id, idempotencyKey: `invoice:${inv.id}:${idempotencyKey}` },
      { transaction }
    );
    await inv.update({ paymentId: payment.id }, { transaction });
    return { invoice: view(inv), payment: { id: payment.id, payUrl: payUrl(payment.id) } };
  });
}

/** M06 hook: a captured invoice payment is paid and collected (a void or paid invoice refunds it). */
async function onCaptured({ payment, late, transaction }) {
  const inv = await OrganiserInvoice.findByPk(payment.purposeId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!inv || !['issued', 'overdue'].includes(inv.status) || inv.paymentId !== payment.id) return 'reject';
  void late;
  await inv.update({ status: 'paid', paidAt: new Date() }, { transaction });
  // The hold opened with the capture (before this hook): collect it to revenue now.
  const hold = await escrow.lockHoldForPayment(payment.id, transaction);
  if (hold) await escrow.collectToRevenueInTx(hold, { transaction });
  await c.publish(transaction, 'organiser_invoice.paid', 'organiser_invoice', inv.id, { invoiceId: inv.id, number: inv.number, organisationId: inv.organisationId, total: inv.totalPoisha });
  return 'accept';
}
purposes.register('fee_invoice', { onCaptured });

/** Safety net for the tick: collect any paid invoice's hold still open (normally collected at capture). */
async function collectPaid({ transaction: outer } = {}) {
  const run = (fn) => (outer ? fn(outer) : sequelize.transaction(fn));
  return run(async (transaction) => {
    const holds = await escrow.lockOpenHoldsForPurpose('fee_invoice', transaction);
    let n = 0;
    for (const h of holds) {
      const inv = await OrganiserInvoice.findByPk(h.groupRef, { attributes: ['status'], transaction });
      if (inv?.status !== 'paid') continue;
      await escrow.collectToRevenueInTx(h, { transaction });
      n += 1;
    }
    return n;
  });
}

/** POST /admin/organiser-invoices/:id/void (manage_organisers + step-up), with a reason. */
async function voidInvoice(actor, id, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const inv = await OrganiserInvoice.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!inv) throw E.notFound('Invoice');
    if (!['issued', 'overdue'].includes(inv.status)) throw fail('INVOICE_STATE');
    await inv.update({ status: 'voided', voidedAt: new Date(), voidReason: reason }, { transaction });
    await audit.record({ action: 'organiser_invoice.voided', actor, entityType: 'organiser_invoice', entityId: inv.id, entityCode: inv.number, reason, req }, { transaction });
    await c.publish(transaction, 'organiser_invoice.voided', 'organiser_invoice', inv.id, { invoiceId: inv.id, number: inv.number, organisationId: inv.organisationId, total: inv.totalPoisha }, actor);
    return view(inv);
  });
}

/** Tick: issue each active flat contract's invoice for the period; issued invoices past due turn overdue; collect paid ones. */
async function sweep(now = new Date()) {
  const out = { issued: 0, overdue: 0, collected: 0 };
  const flat = await OrganiserContract.findAll({ where: { status: 'active', model: 'flat' }, attributes: ['id'] });
  for (const { id } of flat) {
    await sequelize.transaction(async (transaction) => {
      const k = await OrganiserContract.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (k.status !== 'active') return;
      const before = await OrganiserInvoice.count({ where: { contractId: k.id }, transaction });
      await issueDueInTx(k, { transaction, now });
      if ((await OrganiserInvoice.count({ where: { contractId: k.id }, transaction })) > before) out.issued += 1;
    });
  }
  const late = await OrganiserInvoice.findAll({ where: { status: 'issued', dueAt: { [Op.lte]: now } }, attributes: ['id'] });
  for (const { id } of late) {
    await sequelize.transaction(async (transaction) => {
      const inv = await OrganiserInvoice.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!rules.overdue(inv, now)) return;
      await inv.update({ status: 'overdue', overdueAt: now }, { transaction });
      await c.publish(transaction, 'organiser_invoice.overdue_flagged', 'organiser_invoice', inv.id, { invoiceId: inv.id, number: inv.number, organisationId: inv.organisationId, total: inv.totalPoisha });
      out.overdue += 1;
    });
  }
  out.collected = await collectPaid();
  return out;
}

module.exports = { view, issueDueInTx, list, publishBlocked, pay, onCaptured, collectPaid, voidInvoice, sweep };
