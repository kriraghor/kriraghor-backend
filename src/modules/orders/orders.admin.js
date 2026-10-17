'use strict';

/**
 * M13 staff desk (admin.kriraghor.com/admin/orders): search by code, each sub-order's timeline and
 * its escrow hold (held, released, refunded, fee), and a platform cancel of a sub-order not yet
 * shipped with a full refund (master + step-up escrow.manage, like an M10 platform cancel). Staff see
 * the area, never the buyer's phone or address.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, Order, SubOrder, Area } = require('../../models');
const audit = require('../audit/audit.service');
const escrow = require('../payments/escrow.service');
const checkout = require('./checkout.service');
const settle = require('./orders.settle');
const rules = require('./orders.rules');
const c = require('./orders.common');

const { fail } = c;

const staffSubView = (s, items, shop, orderCode) => ({ ...c.subFields(s, items, orderCode, null), shop, sellerId: s.sellerId, buyerId: s.buyerId });

async function orderView(o) {
  const subs = await SubOrder.findAll({ where: { orderId: o.id }, order: [['code', 'ASC']] });
  const [items, shops, area] = await Promise.all([c.itemsOf(subs.map((s) => s.id)), c.shopsOf(subs), Area.findByPk(o.shipAreaId)]);
  const holds = new Map();
  for (const s of subs) {
    const id = o.paymentId ? await escrow.holdIdForPayment(o.paymentId, { splitRef: s.id }) : null;
    holds.set(s.id, id ? await escrow.getOne(id) : null);
  }
  return {
    id: o.id,
    code: o.code,
    status: o.status,
    buyerId: o.buyerId,
    paymentId: o.paymentId ?? null,
    money: { items: o.itemsPoisha, delivery: o.deliveryPoisha, total: o.totalPoisha },
    area: area ? { id: area.id, nameEn: area.nameEn, nameBn: area.nameBn, isDhakaMetro: area.isDhakaMetro } : null,
    createdAt: c.iso(o.createdAt),
    placedAt: c.iso(o.placedAt),
    subOrders: subs.map((s) => ({ ...staffSubView(s, items.filter((i) => i.subOrderId === s.id), shops.get(s.shopId), o.code), escrow: holds.get(s.id) })),
  };
}

/** GET /admin/orders?code&status&cursor&limit (a code finds the order or one of its sub-orders). */
async function list({ code, status, cursor, limit = 50 } = {}) {
  const where = {};
  if (code) where.code = code.replace(/-[A-Z]$/, '');
  if (status) where.status = status;
  if (cursor) where.createdAt = { [Op.lt]: new Date(cursor) };
  const rows = await Order.findAll({ where, order: [['createdAt', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const counts = await SubOrder.findAll({ where: { orderId: page.map((o) => o.id) }, attributes: ['orderId', 'status'] });
  return {
    items: page.map((o) => ({
      id: o.id,
      code: o.code,
      status: o.status,
      total: o.totalPoisha,
      createdAt: c.iso(o.createdAt),
      subOrders: counts.filter((s) => s.orderId === o.id).map((s) => s.status),
    })),
    nextCursor: rows.length > limit ? c.iso(page[page.length - 1].createdAt) : null,
  };
}

async function get(code) {
  const o = await Order.findOne({ where: { code: code.replace(/-[A-Z]$/, '') } });
  if (!o) throw E.notFound('Order');
  return orderView(o);
}

/** POST /admin/orders/sub-orders/:id/cancel { reason } (master + step-up): a full refund, the stock back. */
async function platformCancel(actor, id, { reason }, req) {
  const orderId = await sequelize.transaction(async (transaction) => {
    const s = await c.lockSub(id, transaction);
    if (!s) throw E.notFound('Order');
    const to = rules.next('platform_cancel', s.status, 'staff');
    if (!to) throw fail('ORDER_STATE', { status: s.status });
    await checkout.releaseStock(s, { transaction });
    const refunded = await settle.refundAll(s, { reasonCode: 'platform_cancelled', key: `sub_order:${s.id}:platform`, actor, transaction });
    await s.update({ status: to, cancelledAt: new Date(), cancelledBy: 'staff', cancelReason: 'platform', cancelNote: reason }, { transaction });
    await c.publishSub(transaction, 'sub_order.cancelled', s, { reason: 'platform', refund: refunded, by: 'staff' }, actor);
    await c.syncOrder(s.orderId, { transaction });
    await audit.record({ action: 'sub_order.platform_cancelled', actor, entityType: 'sub_order', entityId: s.id, entityCode: s.code, after: { status: to, refund: refunded }, reason, stepUp: true, req }, { transaction });
    return s.orderId;
  });
  return orderView(await Order.findByPk(orderId));
}

module.exports = { list, get, platformCancel };
