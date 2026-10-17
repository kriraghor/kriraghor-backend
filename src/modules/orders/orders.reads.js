'use strict';

/**
 * M13 reads for other modules: M19 "Needs your action" (shops: orders to accept or ship; buyers:
 * parcels to confirm) and M08 notification facts. Codes, names and amounts only (no phone or address).
 */
const { SubOrder, Order } = require('../../models');
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

module.exports = { pendingActions, facts };
