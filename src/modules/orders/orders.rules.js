'use strict';

/**
 * M13 pure rules (step 1, shop orders): the quote (a sub-order per shop, delivery by area, the
 * commission on the items only, M13-FR-01 to FR-04), the sub-order state machine and who may move
 * it (§8), the deadlines (accept, ship, overdue cancel, auto-complete, the not-received window), the
 * order status derived from its sub-orders, cart quantities and price changes. No I/O; 100% branch
 * coverage (jest.config).
 */
const { feeOf } = require('../../common/money');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ms = (d) => new Date(d).getTime();

// ---------------------------------------------------------------- quote (FR-01 to FR-04)

/** Delivery for one sub-order: ৳80 inside Dhaka metro, ৳150 outside (M03 market.delivery_fee_*; Q79). */
const deliveryFee = ({ isDhakaMetro, dhakaFee, outsideFee }) => (isDhakaMetro ? dhakaFee : outsideFee);

/**
 * The basket, priced: lines grouped by shop in first-seen order (one sub-order each). The commission
 * is on the items subtotal only (v3: 5% on every sale); the delivery fee goes to the shop whole.
 *   lines: [{ variantId, shopId, sellerId, unitPrice, qty, ... }]  (other fields are carried along)
 * Returns { subOrders: [{ shopId, sellerId, lines, items, delivery, total, commission, net }], items,
 * delivery, total }.
 */
function quote({ lines, isDhakaMetro, dhakaFee, outsideFee, commissionBps }) {
  const byShop = new Map();
  for (const l of lines) {
    if (!byShop.has(l.shopId)) byShop.set(l.shopId, { shopId: l.shopId, sellerId: l.sellerId, lines: [] });
    byShop.get(l.shopId).lines.push({ ...l, lineTotal: l.unitPrice * l.qty });
  }
  const delivery = deliveryFee({ isDhakaMetro, dhakaFee, outsideFee });
  const subOrders = [...byShop.values()].map((s) => {
    const items = s.lines.reduce((n, l) => n + l.lineTotal, 0);
    const commission = feeOf(items, commissionBps);
    return { ...s, items, delivery, total: items + delivery, commission, net: items + delivery - commission };
  });
  const sum = (k) => subOrders.reduce((n, s) => n + s[k], 0);
  return { subOrders, items: sum('items'), delivery: sum('delivery'), total: sum('total') };
}

/** The most a member may put in the cart: the stock left (unless made to order) and the per-order cap. */
const maxQty = ({ available, maxPerOrder, isMto }) => (isMto ? maxPerOrder : Math.max(0, Math.min(available, maxPerOrder)));

/** Why a cart line cannot be checked out now (null when it can). */
function lineBlock({ purchasable, qty, available, maxPerOrder, isMto }) {
  if (!purchasable) return 'ITEM_UNAVAILABLE';
  if (qty > maxPerOrder) return 'QTY_LIMIT';
  if (!isMto && qty > available) return 'INSUFFICIENT_STOCK';
  return null;
}

/**
 * FR-03: the prices the member saw (when added to the cart, or the quote they confirm) against the
 * live prices. Returns the changed lines; checkout refuses with PRICE_CHANGED while any are left.
 */
const priceChanges = (lines) => lines.filter((l) => l.seenPrice !== null && l.seenPrice !== undefined && l.seenPrice !== l.unitPrice).map((l) => ({ variantId: l.variantId, was: l.seenPrice, now: l.unitPrice }));

/** A cart line older than market.cart_line_days drops out. */
const lineStale = ({ addedAt, now, days }) => ms(now) - ms(addedAt) > days * DAY;

// ---------------------------------------------------------------- the sub-order state machine (§8)

/**
 * Who may do what, from which statuses. Actors: buyer, shop, system (jobs and payments), staff
 * (the orders desk), dispute (an M17 decision).
 */
const TRANSITIONS = {
  pay: { from: ['pending_payment'], to: 'placed', by: ['system'] },
  payment_closed: { from: ['pending_payment'], to: 'cancelled', by: ['system'] },
  accept: { from: ['placed'], to: 'accepted', by: ['shop'] },
  reject: { from: ['placed'], to: 'rejected', by: ['shop'] },
  expire: { from: ['placed'], to: 'expired', by: ['system'] },
  buyer_cancel: { from: ['placed', 'accepted'], to: 'cancelled', by: ['buyer'] },
  auto_cancel: { from: ['accepted'], to: 'cancelled', by: ['system'] },
  platform_cancel: { from: ['placed', 'accepted'], to: 'cancelled', by: ['staff'] },
  ship: { from: ['accepted'], to: 'shipped', by: ['shop'] },
  deliver: { from: ['shipped'], to: 'delivered', by: ['shop'] },
  receive: { from: ['shipped', 'delivered'], to: 'completed', by: ['buyer'] },
  auto_complete: { from: ['delivered'], to: 'completed', by: ['system'] },
  dispute: { from: ['shipped', 'delivered'], to: 'disputed', by: ['buyer'] },
  dispute_release: { from: ['disputed'], to: 'completed', by: ['dispute'] },
  dispute_refund: { from: ['disputed'], to: 'refunded', by: ['dispute'] },
};

/** The status after `action` by `actor`, or null when it is not allowed. */
function next(action, from, actor) {
  const t = TRANSITIONS[action];
  if (!t || !t.by.includes(actor) || !t.from.includes(from)) return null;
  return t.to;
}

/** Ends of the line: no money is held any more. */
const TERMINAL = new Set(['completed', 'rejected', 'expired', 'cancelled', 'refunded']);
const UNDONE = new Set(['rejected', 'expired', 'cancelled', 'refunded']);
/** Before shipping the stock is only held; cancelling releases it. */
const holdsStock = (status) => ['pending_payment', 'placed', 'accepted'].includes(status);
/** The address and phone show to the shop once it accepts (FR-10), until the sub-order closes. */
const revealsAddress = (status) => ['accepted', 'shipped', 'delivered', 'disputed', 'completed'].includes(status);

/** The order's status from its sub-orders. */
function orderStatus(statuses) {
  if (statuses.some((s) => s === 'pending_payment')) return 'pending_payment';
  if (statuses.every((s) => UNDONE.has(s))) return 'cancelled';
  if (statuses.every((s) => TERMINAL.has(s))) return 'completed';
  return 'placed';
}

// ---------------------------------------------------------------- deadlines (FR-08 to FR-14)

/**
 * Set when the sub-order is placed: accept by placed + market.shop_accept_hours; ship by placed +
 * market.shop_ship_hours, or the longest made-to-order time when that is later (FR-06).
 */
function placedDeadlines({ placedAt, acceptHours, shipHours, mtoDays = [] }) {
  const t = ms(placedAt);
  const ship = Math.max(t + shipHours * HOUR, ...mtoDays.map((d) => t + d * DAY));
  return { acceptBy: new Date(t + acceptHours * HOUR), shipBy: new Date(ship) };
}

/** Shipping late: the buyer may cancel from shipBy + buyerCancelHours; the job cancels at shipBy + autoCancelHours. */
const overdue = ({ shipBy, buyerCancelHours, autoCancelHours }) => ({
  buyerCancelFrom: new Date(ms(shipBy) + buyerCancelHours * HOUR),
  autoCancelAt: new Date(ms(shipBy) + autoCancelHours * HOUR),
});

/** Why the buyer cannot cancel now (null when they can): any time before the shop accepts, then only when shipping is late. */
function buyerCancelBlock({ status, now, buyerCancelFrom }) {
  if (status === 'placed') return null;
  if (status !== 'accepted') return 'ORDER_STATE';
  return ms(now) >= ms(buyerCancelFrom) ? null : 'CANCEL_NOT_YET';
}

/** Marked delivered: completes by itself after market.auto_complete_days. */
const completeBy = ({ deliveredAt, days }) => new Date(ms(deliveredAt) + days * DAY);

/**
 * "Not received" (M17 category not_received): while shipped (the shop never marked it delivered),
 * or within disputes.window_order_hours of being marked delivered.
 */
function notReceivedBlock({ status, deliveredAt, now, windowHours }) {
  if (status === 'shipped') return null;
  if (status !== 'delivered') return 'DISPUTE_NOT_ELIGIBLE';
  return ms(now) < ms(deliveredAt) + windowHours * HOUR ? null : 'DISPUTE_WINDOW_CLOSED';
}

/** The not-received window's end (null while shipped and not yet marked delivered). */
const notReceivedClosesAt = ({ status, deliveredAt, windowHours }) => (status === 'delivered' ? new Date(ms(deliveredAt) + windowHours * HOUR) : null);

/** Courier tracking: 4 to 40 letters, digits, dashes or slashes. */
const trackingValid = (t) => typeof t === 'string' && /^[A-Za-z0-9/-]{4,40}$/.test(t);

module.exports = {
  deliveryFee,
  quote,
  maxQty,
  lineBlock,
  priceChanges,
  lineStale,
  TRANSITIONS,
  next,
  TERMINAL,
  holdsStock,
  revealsAddress,
  orderStatus,
  placedDeadlines,
  overdue,
  buyerCancelBlock,
  completeBy,
  notReceivedBlock,
  notReceivedClosesAt,
  trackingValid,
};
