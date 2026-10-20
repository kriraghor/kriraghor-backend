'use strict';

/**
 * Reconciliation (M06 FR-18, §10 reconciliation.daily). SSLCommerz publishes no settlement API, so the
 * daily run is query based: for every attempt started and every refund touched on the business day
 * (Asia/Dhaka), ask the provider and compare with our records.
 *
 *   matched           both sides agree
 *   missing_internal  the provider has a capture we never applied → auto-healed through the normal capture path
 *   missing_provider  we recorded a capture the provider does not confirm → exception
 *   amount_mismatch   amounts differ → exception (the capture path already refunded it)
 *   refund_mismatch   refund status differs; a refund the provider finished is settled automatically
 *
 * Exceptions stay open until finance resolves them with a note. Settlement and MDR import (platform_bank,
 * provider_fee_expense) come later with a settlement CSV (open question, M06 §16).
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { AppError, E } = require('../../common/errors');
const logger = require('../../common/logger');
const { sequelize, Payment, PaymentAttempt, Refund, ReconciliationRun, ReconciliationItem } = require('../../models');
const audit = require('../audit').audit;
const events = require('../events').events;
const providers = require('../../providers/payments');
const payments = require('./payments.service');
const refunds = require('./refunds.service');

const DHAKA_MS = 6 * 3600 * 1000;

/** UTC bounds of a Dhaka business day 'YYYY-MM-DD'. */
function dayBounds(date) {
  const start = new Date(new Date(`${date}T00:00:00.000Z`).getTime() - DHAKA_MS);
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000) };
}

/** Yesterday in Dhaka, as 'YYYY-MM-DD'. */
const previousBusinessDay = (now = new Date()) => new Date(now.getTime() + DHAKA_MS - 24 * 3600 * 1000).toISOString().slice(0, 10);

async function compareAttempt(attempt, payment, provider) {
  const result = await provider.query({ attemptId: attempt.id });
  const paidThere = result.status === 'paid';
  const paidHere = attempt.status === 'succeeded';
  if (!paidThere && !paidHere) return null; // nothing captured on either side
  const base = { paymentId: payment.id, providerRef: attempt.id, internalPoisha: paidHere ? payment.amountPoisha : null, providerPoisha: paidThere ? result.amount : null };
  if (paidThere && !paidHere) {
    await payments.applyResult(attempt.id, result, { source: 'reconciliation' });
    return { ...base, type: 'missing_internal', resolution: 'auto_healed', detail: 'Capture applied from the provider record' };
  }
  if (!paidThere) return { ...base, type: 'missing_provider', detail: `Provider says ${result.status}` };
  if (result.amount !== payment.amountPoisha) return { ...base, type: 'amount_mismatch', detail: 'Captured amount differs from the payment amount' };
  return { ...base, type: 'matched' };
}

async function compareRefund(refund, payment, provider) {
  if (!refund.providerRefundId) return null;
  const st = await provider.refundStatus({ providerRefundId: refund.providerRefundId });
  const base = { paymentId: payment.id, refundId: refund.id, providerRef: refund.providerRefundId, internalPoisha: refund.amountPoisha, providerPoisha: st.status === 'succeeded' ? refund.amountPoisha : null };
  if (st.status === 'succeeded' && refund.status === 'succeeded') return { ...base, type: 'matched' };
  if (st.status === 'succeeded') {
    await refunds.settle(refund.id);
    return { ...base, type: 'refund_mismatch', resolution: 'auto_healed', detail: 'Refund confirmed by the provider; settled' };
  }
  if (refund.status === 'succeeded') return { ...base, type: 'refund_mismatch', detail: `Provider says ${st.status}` };
  return null; // still processing on both sides
}

/** Run (or re-run a failed) reconciliation for one provider and Dhaka business day. */
async function run({ businessDate = previousBusinessDay(), provider: code = 'sslcommerz', actor = null, req = null } = {}) {
  let runRow = await ReconciliationRun.findOne({ where: { provider: code, businessDate } });
  if (runRow && runRow.status !== 'failed') {
    if (actor) throw new AppError(409, 'RECON_RUN_EXISTS', 'This day has already been reconciled', { meta: { runId: runRow.id } });
    return serializeRun(runRow);
  }
  try {
    if (runRow) await runRow.update({ status: 'running', error: null, startedAt: new Date(), startedBy: actor?.id ?? null });
    else runRow = await ReconciliationRun.create({ provider: code, businessDate, startedBy: actor?.id ?? null });
  } catch (err) {
    if (err instanceof UniqueConstraintError) return serializeRun(await ReconciliationRun.findOne({ where: { provider: code, businessDate } }));
    throw err;
  }
  if (actor) await audit.record({ action: 'reconciliation.run_started', actor, entityType: 'reconciliation_run', entityId: runRow.id, meta: { businessDate, provider: code }, req });

  const provider = providers.get(code);
  const { start, end } = dayBounds(businessDate);
  const totals = { matched: 0, exceptions: 0, autoHealed: 0, attempts: 0, refunds: 0 };
  try {
    const attempts = await PaymentAttempt.findAll({ where: { provider: code, startedAt: { [Op.gte]: start, [Op.lt]: end } }, order: [['startedAt', 'ASC']] });
    const refundRows = await Refund.findAll({
      where: { providerRefundId: { [Op.ne]: null }, [Op.or]: [{ createdAt: { [Op.gte]: start, [Op.lt]: end } }, { completedAt: { [Op.gte]: start, [Op.lt]: end } }] },
    });
    const paymentIds = [...new Set([...attempts.map((a) => a.paymentId), ...refundRows.map((r) => r.paymentId)])];
    const byId = new Map((await Payment.findAll({ where: { id: paymentIds } })).map((p) => [p.id, p]));

    const items = [];
    for (const a of attempts) {
      totals.attempts += 1;
      const item = await compareAttempt(a, byId.get(a.paymentId), provider);
      if (item) items.push(item);
    }
    for (const r of refundRows) {
      totals.refunds += 1;
      const item = await compareRefund(r, byId.get(r.paymentId), provider);
      if (item) items.push(item);
    }
    await sequelize.transaction(async (transaction) => {
      for (const it of items) {
        const row = await ReconciliationItem.create({ runId: runRow.id, ...it }, { transaction });
        if (it.type === 'matched') totals.matched += 1;
        else if (it.resolution === 'auto_healed') totals.autoHealed += 1;
        else {
          totals.exceptions += 1;
          await events.publish(transaction, {
            name: 'reconciliation.exception_raised',
            aggregateType: 'reconciliation_run',
            aggregateId: runRow.id,
            payload: { runId: runRow.id, itemId: row.id, type: it.type, amount: it.internalPoisha ?? it.providerPoisha ?? 0 },
          });
        }
      }
      await runRow.update({ status: 'completed', totals, finishedAt: new Date() }, { transaction });
      await events.publish(transaction, {
        name: 'reconciliation.run_completed',
        aggregateType: 'reconciliation_run',
        aggregateId: runRow.id,
        payload: { runId: runRow.id, provider: code, businessDate, matched: totals.matched, exceptions: totals.exceptions, autoHealed: totals.autoHealed },
      });
    });
  } catch (err) {
    logger.error({ err: err.message, runId: runRow.id }, 'reconciliation run failed');
    await runRow.update({ status: 'failed', error: err.message.slice(0, 300), finishedAt: new Date() });
    throw err;
  }
  return serializeRun(runRow);
}

/** POST /admin/reconciliation/items/:id/resolve (master). */
async function resolveItem(actor, id, { resolution, note }, req) {
  return sequelize.transaction(async (transaction) => {
    const item = await ReconciliationItem.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!item) throw E.notFound('Reconciliation item');
    if (item.type === 'matched' || item.resolution) throw new AppError(409, 'RECON_ITEM_CLOSED', 'This item needs no resolution');
    await item.update({ resolution, note, resolvedBy: actor.id, resolvedAt: new Date() }, { transaction });
    await audit.record({ action: 'reconciliation.item_resolved', actor, entityType: 'reconciliation_item', entityId: item.id, after: { resolution }, reason: note, req }, { transaction });
    return serializeItem(item);
  });
}

function serializeRun(r) {
  return { id: r.id, provider: r.provider, businessDate: r.businessDate, status: r.status, totals: r.totals, error: r.error, startedBy: r.startedBy, startedAt: r.startedAt, finishedAt: r.finishedAt };
}
function serializeItem(i) {
  return {
    id: i.id,
    runId: i.runId,
    type: i.type,
    paymentId: i.paymentId,
    refundId: i.refundId,
    providerRef: i.providerRef,
    internalAmount: i.internalPoisha,
    providerAmount: i.providerPoisha,
    detail: i.detail,
    resolution: i.resolution,
    resolvedBy: i.resolvedBy,
    resolvedAt: i.resolvedAt,
    note: i.note,
    createdAt: i.createdAt,
  };
}

async function listRuns({ cursor, limit = 30 } = {}) {
  const rows = await ReconciliationRun.findAll({ where: cursor ? { id: { [Op.lt]: cursor } } : {}, order: [['businessDate', 'DESC'], ['id', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  return { items: page.map(serializeRun), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
}

async function listItems(runId, { type, open } = {}) {
  const runRow = await ReconciliationRun.findByPk(runId);
  if (!runRow) throw E.notFound('Reconciliation run');
  const where = { runId, ...(type ? { type } : {}), ...(open ? { type: { [Op.ne]: 'matched' }, resolution: null } : {}) };
  const items = await ReconciliationItem.findAll({ where, order: [['createdAt', 'ASC'], ['id', 'ASC']] });
  return { run: serializeRun(runRow), items: items.map(serializeItem) };
}

module.exports = { run, resolveItem, listRuns, listItems, dayBounds, previousBusinessDay };
