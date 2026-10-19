'use strict';

/**
 * M13 buyer side (FR-13, FR-14): my orders on kriraghor.com.
 *   cancel        while the shop has not accepted (100% back), or once shipping is late by
 *                 market.ship_overdue_buyer_cancel_hours
 *   received      shipped or delivered: completes the sub-order and releases the shop's money
 *   not received  opens an M17 dispute (category not_received) on the sub-order; its hold freezes
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, Order, SubOrder } = require('../../models');
const audit = require('../audit').audit;
const checkout = require('./checkout.service');
const settle = require('./orders.settle');
const rules = require('./orders.rules');
const c = require('./orders.common');

const { fail } = c;

/** GET /me/orders?status&cursor&limit: newest first, each with its sub-orders. */
async function list(principal, { status, cursor, limit = 20 } = {}) {
  const where = { buyerId: principal.id, ...(status ? { status } : {}), ...(cursor ? { createdAt: { [Op.lt]: new Date(cursor) } } : {}) };
  const rows = await Order.findAll({ where, order: [['createdAt', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  return { items: await Promise.all(page.map((o) => checkout.response(o).then((r) => r.order))), nextCursor: rows.length > limit ? c.iso(page[page.length - 1].createdAt) : null };
}

/** GET /me/orders/:code. */
async function get(principal, code) {
  const o = await Order.findOne({ where: { code, buyerId: principal.id } });
  if (!o) throw E.notFound('Order');
  return checkout.response(o);
}

async function mine(principal, id, transaction) {
  const s = await c.lockSub(id, transaction);
  if (!s || s.buyerId !== principal.id) throw E.notFound('Order');
  return s;
}

const result = async (s) => checkout.response(await Order.findByPk(s.orderId));

/** POST /me/sub-orders/:id/cancel { reason? }. */
async function cancel(principal, id, { reason = 'buyer_cancelled' } = {}, req) {
  const s = await sequelize.transaction(async (transaction) => {
    const sub = await mine(principal, id, transaction);
    const to = rules.next('buyer_cancel', sub.status, 'buyer');
    if (!to) throw fail('ORDER_STATE', { status: sub.status });
    const block = rules.buyerCancelBlock({ status: sub.status, now: new Date(), buyerCancelFrom: sub.buyerCancelFrom });
    if (block) throw fail(block, { from: c.iso(sub.buyerCancelFrom) });
    const late = sub.status === 'accepted';
    await checkout.releaseStock(sub, { transaction });
    const refunded = await settle.refundAll(sub, { reasonCode: late ? 'ship_overdue' : 'buyer_cancelled', key: `sub_order:${sub.id}:cancel`, actor: principal, transaction });
    await sub.update({ status: to, cancelledAt: new Date(), cancelledBy: 'buyer', cancelReason: late ? 'ship_overdue' : reason }, { transaction });
    await c.publishSub(transaction, 'sub_order.cancelled', sub, { reason: sub.cancelReason, refund: refunded, by: 'buyer' }, principal);
    await c.syncOrder(sub.orderId, { transaction });
    await audit.record({ action: 'sub_order.cancelled', actor: principal, entityType: 'sub_order', entityId: sub.id, entityCode: sub.code, after: { status: sub.status, reason: sub.cancelReason, refund: refunded }, req }, { transaction });
    return sub;
  });
  return result(s);
}

/** POST /me/sub-orders/:id/received: the buyer has the parcel; the shop is paid. */
async function received(principal, id, req) {
  const s = await sequelize.transaction(async (transaction) => {
    const sub = await mine(principal, id, transaction);
    if (!rules.next('receive', sub.status, 'buyer')) throw fail('ORDER_STATE', { status: sub.status });
    const moved = await settle.complete(sub, 'buyer', { actor: principal, transaction });
    await audit.record({ action: 'sub_order.completed', actor: principal, entityType: 'sub_order', entityId: sub.id, entityCode: sub.code, after: { status: sub.status, by: 'buyer', released: moved.gross, fee: moved.fee }, req }, { transaction });
    return sub;
  });
  return result(s);
}

/** POST /me/sub-orders/:id/not-received { statement } (Idempotency-Key): an M17 dispute. */
async function notReceived(principal, id, { statement }, idempotencyKey, req) {
  const s = await SubOrder.findByPk(id);
  if (!s || s.buyerId !== principal.id) throw E.notFound('Order');
  return require('../trust').disputes.open(principal, { sourceType: 'sub_order', sourceId: s.id, category: 'not_received', statement }, idempotencyKey, req);
}

module.exports = { list, get, cancel, received, notReceived };
