'use strict';

/**
 * M13 reads for other modules: M19 "Needs your action" (shops: orders to accept or ship; buyers:
 * parcels to confirm), M08 notification facts and M19 shop facts (subOrderKpiFact and the reconcile's
 * exportSubOrderKpiFacts). Codes, names and amounts only (no phone or address).
 */
const { Op } = require('sequelize');
const { SubOrder, Order, OrderItem, Product } = require('../../models');
const { ItemType } = require('../catalog').reference;
const c = require('./orders.common');

const earliest = (rows, key) => rows.reduce((m, r) => (r[key] && (!m || r[key] < m) ? r[key] : m), null);

async function pendingActions(principal, role) {
  const items = [];
  if (role === 'shop_owner') {
    const toAccept = await SubOrder.findAll({ where: { sellerId: principal.id, status: 'placed' }, attributes: ['acceptBy'] });
    const toShip = await SubOrder.findAll({ where: { sellerId: principal.id, status: 'accepted' }, attributes: ['shipBy'] });
    if (toAccept.length) items.push({ key: 'orders_to_accept', count: toAccept.length, severity: 'high', dueAt: c.iso(earliest(toAccept, 'acceptBy')), href: '/vendor/orders?tab=to_accept' });
    if (toShip.length) items.push({ key: 'orders_to_ship', count: toShip.length, severity: 'high', dueAt: c.iso(earliest(toShip, 'shipBy')), href: '/vendor/orders?tab=to_ship' });
  } else {
    const delivered = await SubOrder.findAll({ where: { buyerId: principal.id, status: 'delivered' }, attributes: ['completeBy'] });
    if (delivered.length) items.push({ key: 'orders_to_confirm', count: delivered.length, severity: 'normal', dueAt: c.iso(earliest(delivered, 'completeBy')), href: '/me/orders' });
  }
  return items;
}

/** What a notification needs about a sub-order. */
async function facts(subOrderId) {
  const s = await SubOrder.findByPk(subOrderId);
  if (!s) return null;
  const [o, shops] = await Promise.all([Order.findByPk(s.orderId, { attributes: ['code'] }), c.shopsOf([s])]);
  return {
    code: s.code,
    orderCode: o.code,
    shopName: shops.get(s.shopId)?.name ?? '',
    total: s.totalPoisha,
    net: s.netPoisha,
    refunded: s.refundedPoisha,
    courier: s.courierName ?? '',
    trackingNo: s.trackingNo ?? '',
    acceptBy: s.acceptBy,
    shipBy: s.shipBy,
  };
}

// ---------------------------------------------------------------- M19 facts (Round B2)

/** The item category of each product (product → item type → category), for sales by category. */
async function categoriesOf(productIds) {
  const ids = [...new Set(productIds)];
  if (!ids.length) return new Map();
  const products = await Product.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id', 'itemTypeId'] });
  const types = await ItemType.findAll({ where: { id: { [Op.in]: [...new Set(products.map((p) => p.itemTypeId))] } }, attributes: ['id', 'categoryId'] });
  const catOfType = new Map(types.map((t) => [t.id, t.categoryId]));
  return new Map(products.map((p) => [p.id, catOfType.get(p.itemTypeId) ?? null]));
}

const kpiFact = (s, items, cats) => ({
  subOrderId: s.id,
  sourceVersion: s.updatedAt.getTime(),
  code: s.code,
  orderId: s.orderId,
  shopId: s.shopId,
  sellerId: s.sellerId,
  buyerId: s.buyerId,
  status: s.status,
  units: items.reduce((n, i) => n + i.qty, 0),
  items: s.itemsPoisha,
  delivery: s.deliveryPoisha,
  commission: s.commissionPoisha,
  refunded: s.refundedPoisha,
  placedAt: s.placedAt,
  completedAt: s.completedAt,
  cancelledAt: s.cancelledAt,
  lines: items.map((i) => ({ itemId: i.id, productId: i.productId, categoryId: cats.get(i.productId) ?? null, title: i.title, qty: i.qty, amount: i.lineTotalPoisha })),
});

/**
 * M19 shop facts (§6.3, FR-08): a sub-order with its lines, amounts in poisha. The buyer id is kept
 * for repeat buyers only; no name, phone or address leaves M13.
 */
async function subOrderKpiFact(subOrderId) {
  const s = await SubOrder.findByPk(subOrderId);
  if (!s) return null;
  const items = await OrderItem.findAll({ where: { subOrderId: s.id }, order: [['id', 'ASC']] });
  return kpiFact(s, items, await categoriesOf(items.map((i) => i.productId)));
}

/** FactsExporter (M19-FR-09): sub-orders changed in [since, until] (since null: all of them, the backfill). */
async function exportSubOrderKpiFacts({ since = null, until = new Date() } = {}) {
  const rows = await SubOrder.findAll({ where: { updatedAt: since ? { [Op.gte]: since, [Op.lte]: until } : { [Op.lte]: until } }, order: [['updatedAt', 'ASC']] });
  if (!rows.length) return [];
  const items = await OrderItem.findAll({ where: { subOrderId: { [Op.in]: rows.map((s) => s.id) } }, order: [['id', 'ASC']] });
  const cats = await categoriesOf(items.map((i) => i.productId));
  return rows.map((s) => kpiFact(s, items.filter((i) => i.subOrderId === s.id), cats));
}

module.exports = { pendingActions, facts, subOrderKpiFact, exportSubOrderKpiFacts };
