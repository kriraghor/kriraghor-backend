'use strict';

/**
 * Shared bits of M13: the error catalogue (§9 codes), settings read per call (M03, no magic numbers),
 * the shipping details (phone and address encrypted at rest, FR-10), row locks, events and the
 * serializers for the buyer, the shop and staff.
 */
const { AppError } = require('../../common/errors');
const { encrypt, decrypt } = require('../../common/crypto');
const storage = require('../../common/storage');
const { Order, SubOrder, OrderItem } = require('../../models');
const settings = require('../settings/settings.service');
const events = require('../events/events.service');
const rules = require('./orders.rules');

const ERRORS = {
  OWN_ITEM: [422, 'You cannot buy from your own shop'],
  ITEM_UNAVAILABLE: [409, 'This item cannot be bought right now'],
  QTY_LIMIT: [422, 'That is more than one order may have'],
  INSUFFICIENT_STOCK: [409, 'Not enough stock'],
  CART_EMPTY: [422, 'Your cart is empty'],
  CART_LINE_UNKNOWN: [422, 'That item is not in your cart'],
  PRICE_CHANGED: [409, 'Some prices changed. Check the new total and confirm again'],
  AREA_UNKNOWN: [422, 'Choose a delivery area from the list'],
  ORDER_STATE: [409, 'The order cannot do that in its current state'],
  CANCEL_NOT_YET: [409, 'You can cancel once the shop is late to ship'],
  NOT_YOUR_SHOP: [403, 'This order is for another shop'],
  TRACKING_INVALID: [422, 'Enter the courier tracking number'],
  FILE_EMPTY: [422, 'The photo is empty'],
  FILE_TOO_LARGE: [413, 'The photo is too large'],
  FILE_TYPE_NOT_ALLOWED: [415, 'Upload a JPEG, PNG or WebP photo'],
  FILE_TYPE_MISMATCH: [415, 'The file is not the image type it claims to be'],
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : undefined);

/** Every number from M03 (read per call, so a change applies at once). */
const config = () => ({
  holdMinutes: settings.get('market.checkout_hold_minutes'),
  cartLineDays: settings.get('market.cart_line_days'),
  acceptHours: settings.get('market.shop_accept_hours'),
  shipHours: settings.get('market.shop_ship_hours'),
  buyerCancelHours: settings.get('market.ship_overdue_buyer_cancel_hours'),
  autoCancelHours: settings.get('market.ship_overdue_auto_cancel_hours'),
  autoCompleteDays: settings.get('market.auto_complete_days'),
  dhakaFee: settings.get('market.delivery_fee_dhaka_poisha'),
  outsideFee: settings.get('market.delivery_fee_outside_poisha'),
  disputeHours: settings.get('disputes.window_order_hours'),
  proofMaxBytes: settings.get('market.photo_max_bytes'),
});

// ---------------------------------------------------------------- shipping details (encrypted)

const shipFields = ({ name, phone, areaId, line, note = null }, isDhakaMetro) => ({
  shipName: name,
  shipPhoneEnc: encrypt(phone),
  shipPhoneLast4: phone.slice(-4),
  shipAreaId: areaId,
  shipAddressEnc: encrypt(JSON.stringify({ line, note: note ?? null })),
  shipDhakaMetro: isDhakaMetro,
});
const addressOf = (o) => JSON.parse(decrypt(o.shipAddressEnc));
const phoneOf = (o) => decrypt(o.shipPhoneEnc);

// ---------------------------------------------------------------- locks and events

const lockSub = (id, transaction) => SubOrder.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
const lockOrder = (id, transaction) => Order.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });

const subPayload = (s, extra = {}) => ({ subOrderId: s.id, code: s.code, orderId: s.orderId, shopId: s.shopId, sellerId: s.sellerId, buyerId: s.buyerId, total: s.totalPoisha, ...extra });
const publishSub = (transaction, name, s, extra, actor = null) => events.publish(transaction, { name, aggregateType: 'sub_order', aggregateId: s.id, payload: subPayload(s, extra), actor });
const publishOrder = (transaction, name, o, extra = {}, actor = null) =>
  events.publish(transaction, { name, aggregateType: 'order', aggregateId: o.id, payload: { orderId: o.id, code: o.code, buyerId: o.buyerId, total: o.totalPoisha, ...extra }, actor });

/** After a sub-order moves: the order's status follows its sub-orders (and its closing event). */
async function syncOrder(orderId, { transaction }) {
  const o = await lockOrder(orderId, transaction);
  const subs = await SubOrder.findAll({ where: { orderId }, attributes: ['status'], transaction });
  const to = rules.orderStatus(subs.map((s) => s.status));
  if (to === o.status) return o;
  const now = new Date();
  await o.update({ status: to, ...(to === 'cancelled' ? { cancelledAt: now } : {}), ...(to === 'completed' ? { completedAt: now } : {}) }, { transaction });
  if (to === 'cancelled') await publishOrder(transaction, 'order.cancelled', o);
  if (to === 'completed') await publishOrder(transaction, 'order.completed', o);
  return o;
}

// ---------------------------------------------------------------- views

const iso = (d) => (d ? new Date(d).toISOString() : null);

const itemView = (i) => ({
  id: i.id,
  variantId: i.variantId,
  productId: i.productId,
  title: i.title,
  variantLabelEn: i.variantLabelEn,
  variantLabelBn: i.variantLabelBn,
  sku: i.sku ?? null,
  photoUrl: i.photoKey ? storage.publicUrl(i.photoKey) : null,
  unitPrice: i.unitPricePoisha,
  qty: i.qty,
  lineTotal: i.lineTotalPoisha,
  isMto: i.isMto,
  mtoDays: i.mtoDays ?? null,
});

const moneyView = (s) => ({ items: s.itemsPoisha, delivery: s.deliveryPoisha, total: s.totalPoisha, refunded: s.refundedPoisha });

const timeline = (s) => ({
  placedAt: iso(s.placedAt),
  acceptBy: iso(s.acceptBy),
  acceptedAt: iso(s.acceptedAt),
  shipBy: iso(s.shipBy),
  buyerCancelFrom: iso(s.buyerCancelFrom),
  shippedAt: iso(s.shippedAt),
  deliveredAt: iso(s.deliveredAt),
  completeBy: iso(s.completeBy),
  completedAt: iso(s.completedAt),
  cancelledAt: iso(s.cancelledAt),
});

/** The buyer's sub-order: status, items, money, tracking and what they can do now. */
function buyerSubView(s, items, shop, now = new Date()) {
  const c = config();
  return {
    id: s.id,
    code: s.code,
    status: s.status,
    shop,
    items: items.map(itemView),
    money: moneyView(s),
    courier: s.courierName ? { name: s.courierName, trackingNo: s.trackingNo } : null,
    ...timeline(s),
    cancelReason: s.cancelReason ?? null,
    disputeId: s.disputeId ?? null,
    can: {
      cancel: Boolean(rules.next('buyer_cancel', s.status, 'buyer')) && !rules.buyerCancelBlock({ status: s.status, now, buyerCancelFrom: s.buyerCancelFrom }),
      received: Boolean(rules.next('receive', s.status, 'buyer')),
      notReceived: !s.disputeId && !rules.notReceivedBlock({ status: s.status, deliveredAt: s.deliveredAt, now, windowHours: c.disputeHours }),
    },
    notReceivedClosesAt: iso(rules.notReceivedClosesAt({ status: s.status, deliveredAt: s.deliveredAt, windowHours: c.disputeHours })),
  };
}

function buyerOrderView(o, subs) {
  return {
    id: o.id,
    code: o.code,
    status: o.status,
    paymentMethod: o.paymentMethod,
    paymentId: o.paymentId ?? null,
    payBy: iso(o.payBy),
    placedAt: iso(o.placedAt),
    createdAt: iso(o.createdAt),
    money: { items: o.itemsPoisha, delivery: o.deliveryPoisha, total: o.totalPoisha },
    shipTo: { name: o.shipName, phoneLast4: o.shipPhoneLast4, areaId: o.shipAreaId, ...addressOf(o) },
    subOrders: subs,
  };
}

/** A sub-order without the buyer's details (the shop's view adds them once accepted; staff never see them). */
function subFields(s, items, orderCode, area) {
  return {
    id: s.id,
    code: s.code,
    orderCode,
    status: s.status,
    items: items.map(itemView),
    money: { ...moneyView(s), commissionBps: s.commissionBps, commission: s.commissionPoisha, net: s.netPoisha, released: s.releasedPoisha },
    courier: s.courierName ? { name: s.courierName, trackingNo: s.trackingNo } : null,
    ...timeline(s),
    autoCancelAt: iso(s.autoCancelAt),
    cancelReason: s.cancelReason ?? null,
    cancelledBy: s.cancelledBy ?? null,
    completedBy: s.completedBy ?? null,
    disputeId: s.disputeId ?? null,
    area,
  };
}

/**
 * The shop's sub-order. The buyer's phone and address show only once the shop accepts (FR-10);
 * before that, the area alone (so the shop knows where it ships).
 */
function shopSubView(s, items, order, area) {
  const reveal = rules.revealsAddress(s.status);
  return { ...subFields(s, items, order.code, area), shipTo: reveal ? { name: order.shipName, phone: phoneOf(order), ...addressOf(order) } : null };
}

/** Shop names for the buyer's views (M12 read; ids, names and slugs only). */
async function shopsOf(subs) {
  const reads = require('../market/market.reads');
  const out = new Map();
  for (const id of new Set(subs.map((s) => s.shopId))) {
    const s = await reads.shop(id);
    out.set(id, s ? { id: s.id, name: s.name, slug: s.slug } : { id, name: '', slug: null });
  }
  return out;
}

const itemsOf = (subOrderIds, { transaction } = {}) => OrderItem.findAll({ where: { subOrderId: subOrderIds }, order: [['createdAt', 'ASC']], transaction });

module.exports = {
  ERRORS,
  fail,
  config,
  shipFields,
  addressOf,
  phoneOf,
  lockSub,
  lockOrder,
  publishSub,
  publishOrder,
  syncOrder,
  iso,
  itemView,
  buyerSubView,
  buyerOrderView,
  subFields,
  shopSubView,
  itemsOf,
  shopsOf,
};
