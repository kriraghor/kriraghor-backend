'use strict';

/**
 * M13 shop fulfilment (FR-08 to FR-12): the shop owner's sub-orders on vendor.kriraghor.com.
 *   accept     within market.shop_accept_hours of placing; the buyer's phone and address show (FR-10)
 *   reject     with a reason: the split is refunded 100% and the stock released (a whole sub-order, Q82)
 *   ship       courier and tracking number; the held stock is committed (on hand goes down)
 *   delivered  optional photo proof; auto-completes after market.auto_complete_days
 * The money is released to the shop when the buyer confirms (or auto-complete): see orders.settle.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { uuid7 } = require('../../common/uuid7');
const { sniffMime } = require('../../common/filetype');
const storage = require('../../common/storage');
const { sequelize, SubOrder, Order, OrderItem, Area } = require('../../models');
const audit = require('../audit/audit.service');
const inventory = require('../market/inventory.service');
const { fileBlock } = require('../grounds/photos.service');
const checkout = require('./checkout.service');
const settle = require('./orders.settle');
const rules = require('./orders.rules');
const c = require('./orders.common');

const { fail } = c;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** The desk's tabs (§4): To accept, To ship, Shipped, Done, Cancelled. */
const TABS = {
  to_accept: ['placed'],
  to_ship: ['accepted'],
  shipped: ['shipped', 'delivered', 'disputed'],
  done: ['completed'],
  cancelled: ['rejected', 'expired', 'cancelled', 'refunded'],
};

async function view(s, { transaction } = {}) {
  const [items, order] = await Promise.all([c.itemsOf([s.id], { transaction }), Order.findByPk(s.orderId, { transaction })]);
  const a = await Area.findByPk(order.shipAreaId, { transaction });
  return c.shopSubView(s, items, order, a ? { id: a.id, nameEn: a.nameEn, nameBn: a.nameBn, isDhakaMetro: a.isDhakaMetro } : null);
}

async function own(principal, id, transaction) {
  const s = transaction ? await c.lockSub(id, transaction) : await SubOrder.findByPk(id);
  if (!s || s.status === 'pending_payment') throw E.notFound('Order');
  if (s.sellerId !== principal.id) throw fail('NOT_YOUR_SHOP');
  return s;
}

const move = (action, s) => {
  const to = rules.next(action, s.status, 'shop');
  if (!to) throw fail('ORDER_STATE', { status: s.status });
  return to;
};

/** GET /shop/sub-orders?tab&cursor&limit: newest first, with counts per tab. */
async function list(principal, { tab = 'to_accept', cursor, limit = 20 } = {}) {
  const where = { sellerId: principal.id, status: TABS[tab], ...(cursor ? { createdAt: { [Op.lt]: new Date(cursor) } } : {}) };
  const rows = await SubOrder.findAll({ where, order: [['createdAt', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const counts = {};
  for (const [k, statuses] of Object.entries(TABS)) counts[k] = await SubOrder.count({ where: { sellerId: principal.id, status: statuses } });
  return { items: await Promise.all(page.map((s) => view(s))), counts, nextCursor: rows.length > limit ? c.iso(page[page.length - 1].createdAt) : null };
}

async function get(principal, id) {
  return view(await own(principal, id));
}

async function accept(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const s = await own(principal, id, transaction);
    await s.update({ status: move('accept', s), acceptedAt: new Date() }, { transaction });
    await c.publishSub(transaction, 'sub_order.accepted', s, { shipBy: c.iso(s.shipBy) }, principal);
    await audit.record({ action: 'sub_order.accepted', actor: principal, entityType: 'sub_order', entityId: s.id, entityCode: s.code, after: { status: s.status }, req }, { transaction });
    return view(s, { transaction });
  });
}

/** Reject (Q82: the whole sub-order): 100% back to the buyer, the stock released. */
async function reject(principal, id, { reason, note = null }, req) {
  return sequelize.transaction(async (transaction) => {
    const s = await own(principal, id, transaction);
    const to = move('reject', s);
    await checkout.releaseStock(s, { transaction });
    const refunded = await settle.refundAll(s, { reasonCode: 'shop_rejected', key: `sub_order:${s.id}:reject`, actor: principal, transaction });
    await s.update({ status: to, cancelledAt: new Date(), cancelledBy: 'shop', cancelReason: reason, cancelNote: note }, { transaction });
    await c.publishSub(transaction, 'sub_order.rejected', s, { reason, refund: refunded }, principal);
    await c.syncOrder(s.orderId, { transaction });
    await audit.record({ action: 'sub_order.rejected', actor: principal, entityType: 'sub_order', entityId: s.id, entityCode: s.code, after: { status: s.status, reason, refund: refunded }, req }, { transaction });
    return view(s, { transaction });
  });
}

/** Ship: courier and tracking; the held stock leaves the shelf (commit). */
async function ship(principal, id, { courierName, trackingNo }, req) {
  if (!rules.trackingValid(trackingNo)) throw fail('TRACKING_INVALID');
  return sequelize.transaction(async (transaction) => {
    const s = await own(principal, id, transaction);
    const to = move('ship', s);
    const items = await OrderItem.findAll({ where: { subOrderId: s.id }, order: [['productId', 'ASC'], ['variantId', 'ASC']], transaction });
    for (const i of items) await inventory.commit(i.variantId, i.qty, i.id, { transaction });
    await s.update({ status: to, shippedAt: new Date(), courierName, trackingNo }, { transaction });
    await c.publishSub(transaction, 'sub_order.shipped', s, { courier: courierName, tracking: trackingNo }, principal);
    await audit.record({ action: 'sub_order.shipped', actor: principal, entityType: 'sub_order', entityId: s.id, entityCode: s.code, after: { status: s.status, courierName, trackingNo }, req }, { transaction });
    return view(s, { transaction });
  });
}

/** Mark delivered (optional photo proof, raw body): the auto-complete clock starts. */
async function delivered(principal, id, { contentType, body }, req) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  let proofKey = null;
  if (buf.length) {
    const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
    const block = fileBlock({ declared, sniffed: sniffMime(buf), size: buf.length, max: c.config().proofMaxBytes });
    if (block) throw fail(block);
    const s0 = await own(principal, id);
    proofKey = `orders/${s0.id}/delivered-${uuid7()}.${EXT[declared]}`;
    await storage.putPrivate(proofKey, buf, declared);
  }
  return sequelize.transaction(async (transaction) => {
    const s = await own(principal, id, transaction);
    const to = move('deliver', s);
    const now = new Date();
    await s.update({ status: to, deliveredAt: now, deliveredProofKey: proofKey, completeBy: rules.completeBy({ deliveredAt: now, days: c.config().autoCompleteDays }) }, { transaction });
    await c.publishSub(transaction, 'sub_order.delivered', s, { completeBy: c.iso(s.completeBy), proof: Boolean(proofKey) }, principal);
    await audit.record({ action: 'sub_order.delivered', actor: principal, entityType: 'sub_order', entityId: s.id, entityCode: s.code, after: { status: s.status, proof: Boolean(proofKey) }, req }, { transaction });
    return view(s, { transaction });
  });
}

/**
 * GET /shop/settlement: what the shop's orders are worth. released = paid into the shop's payable
 * (M07 pays it out on payouts.shop_weekday); inEscrow = net of open sub-orders; refunded = back to buyers.
 */
async function settlement(principal) {
  const rows = await SubOrder.findAll({ where: { sellerId: principal.id, status: { [Op.ne]: 'pending_payment' } }, attributes: ['status', 'totalPoisha', 'netPoisha', 'commissionPoisha', 'releasedPoisha', 'refundedPoisha'] });
  const open = rows.filter((s) => !rules.TERMINAL.has(s.status));
  const done = rows.filter((s) => s.status === 'completed');
  const sum = (list, k) => list.reduce((n, s) => n + s[k], 0);
  return {
    completed: { count: done.length, gross: sum(done, 'releasedPoisha'), commission: sum(done, 'commissionPoisha'), net: sum(done, 'netPoisha') },
    inEscrow: { count: open.length, net: sum(open, 'netPoisha') },
    refunded: sum(rows, 'refundedPoisha'),
    payoutsHref: '/vendor/payouts',
  };
}

module.exports = { TABS, list, get, accept, reject, ship, delivered, settlement, view };
