'use strict';

/**
 * M13 checkout (FR-03 to FR-07), step 1: online payment only (COD comes with courier settlement, Q28).
 *
 * POST /checkout/quote re-prices the cart on the server (live public prices, delivery by area) and
 * lists price changes since the lines were added. POST /checkout (gate buy, Idempotency-Key) places
 * the order in one transaction: the order, one sub-order per shop, the item snapshots, an M12 stock
 * hold per line (lock order: product, then variant, sorted, so two checkouts never deadlock), and one
 * M06 payment split into one escrow hold per sub-order (payee: the shop owner). The buyer pays on
 * kriraghor.com/pay within market.checkout_hold_minutes. Only payment.succeeded places the order
 * (purpose hook onCaptured); a failed or expired payment, or the tick, cancels it and frees the stock.
 * A capture after the order was cancelled is refunded in full by M06, hold by hold (late_capture).
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { nextCode } = require('../../common/sequences');
const { E } = require('../../common/errors');
const { feeOf } = require('../../common/money');
const { sequelize, Order, SubOrder, OrderItem, Area } = require('../../models');
const settings = require('../settings').settings;
const audit = require('../audit').audit;
const payments = require('../payments').intents;
const purposes = require('../payments').purposes;
const fees = require('../payments').fees;
const inventory = require('../market').inventory;
const reads = require('../market').reads;
const { payUrl } = require('../payments').intents;
const cart = require('./cart.service');
const rules = require('./orders.rules');
const c = require('./orders.common');

const { fail } = c;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A delivery area of the M03 catalogue (service flag 2, Q79): Dhaka metro or outside. */
const DELIVERY = 2;
async function areaOf(areaId) {
  const a = areaId ? await Area.findByPk(areaId) : null;
  if (!a || a.isActive === false || !(a.serviceFlags & DELIVERY)) throw fail('AREA_UNKNOWN');
  return a;
}

/** The cart, checked and priced. Throws the first blocking line's code. */
async function price(principal, areaId) {
  const lines = await cart.linesForCheckout(principal.id);
  if (!lines.length) throw fail('CART_EMPTY');
  const info = await reads.purchasable(lines.map((l) => l.variantId));
  const priced = lines.map((l) => {
    const i = info.get(l.variantId);
    if (!i) throw fail('ITEM_UNAVAILABLE', { variantId: l.variantId });
    if (i.sellerId === principal.id) throw fail('OWN_ITEM', { variantId: l.variantId });
    const block = rules.lineBlock({ purchasable: i.purchasable, qty: l.qty, available: i.available, maxPerOrder: i.maxPerOrder, isMto: i.isMto });
    if (block) throw fail(block, { variantId: l.variantId, available: i.available, max: i.maxPerOrder });
    return { ...i, qty: l.qty, seenPrice: l.seenPrice };
  });
  const area = await areaOf(areaId);
  const cfg = c.config();
  const feeBps = fees.snapshot('market').feeBps;
  const q = rules.quote({ lines: priced, isDhakaMetro: area.isDhakaMetro, dhakaFee: cfg.dhakaFee, outsideFee: cfg.outsideFee, commissionBps: feeBps });
  return { q, area, feeBps, changes: rules.priceChanges(priced) };
}

const quoteView = ({ q, area, changes }) => ({
  area: { id: area.id, nameEn: area.nameEn, nameBn: area.nameBn, isDhakaMetro: area.isDhakaMetro },
  subOrders: q.subOrders.map((s) => ({
    shop: { id: s.shopId, name: s.lines[0].shopName, slug: s.lines[0].shopSlug },
    lines: s.lines.map((l) => ({ variantId: l.variantId, title: l.title, variantLabelEn: l.labelEn, variantLabelBn: l.labelBn, unitPrice: l.unitPrice, qty: l.qty, lineTotal: l.lineTotal, isMto: l.isMto, mtoDays: l.mtoDays })),
    items: s.items,
    delivery: s.delivery,
    total: s.total,
  })),
  items: q.items,
  delivery: q.delivery,
  total: q.total,
  changes,
});

/** POST /checkout/quote { areaId }. */
async function quote(principal, { areaId }) {
  return quoteView(await price(principal, areaId));
}

async function response(o) {
  const subs = await SubOrder.findAll({ where: { orderId: o.id }, order: [['code', 'ASC']] });
  const items = await c.itemsOf(subs.map((s) => s.id));
  const shops = await c.shopsOf(subs);
  return {
    order: c.buyerOrderView(
      o,
      subs.map((s) => c.buyerSubView(s, items.filter((i) => i.subOrderId === s.id), shops.get(s.shopId)))
    ),
    payment: o.status === 'pending_payment' && o.paymentId ? { id: o.paymentId, payUrl: payUrl(o.paymentId) } : null,
  };
}

/**
 * POST /checkout { ship: { name, phone, areaId, line, note? }, expectedTotal } (gate buy,
 * Idempotency-Key). expectedTotal is the quote the buyer confirmed: a different live total is
 * PRICE_CHANGED (FR-03) with the new quote, and nothing is held.
 */
async function place(principal, { ship, expectedTotal }, idempotencyKey, req) {
  const buyerId = principal.id;
  const again = () => Order.findOne({ where: { buyerId, idempotencyKey } });
  const existing = await again();
  if (existing) return response(existing);

  const priced = await price(principal, ship.areaId);
  const { q, area, feeBps } = priced;
  if (q.total !== expectedTotal) throw fail('PRICE_CHANGED', { quote: quoteView(priced) });
  const cfg = c.config();
  const now = new Date();
  const payBy = new Date(now.getTime() + cfg.holdMinutes * 60000);

  try {
    const o = await sequelize.transaction(async (transaction) => {
      const order = await Order.create(
        {
          code: await nextCode('KG', transaction),
          buyerId,
          ...c.shipFields(ship, area.isDhakaMetro),
          itemsPoisha: q.items,
          deliveryPoisha: q.delivery,
          totalPoisha: q.total,
          status: 'pending_payment',
          payBy,
          idempotencyKey,
        },
        { transaction }
      );
      const holds = [];
      const subs = [];
      for (const [n, s] of q.subOrders.entries()) {
        const sub = await SubOrder.create(
          {
            code: `${order.code}-${LETTERS[n] ?? n + 1}`,
            orderId: order.id,
            shopId: s.shopId,
            sellerId: s.sellerId,
            buyerId,
            status: 'pending_payment',
            itemsPoisha: s.items,
            deliveryPoisha: s.delivery,
            totalPoisha: s.total,
            commissionBps: feeBps,
            commissionPoisha: s.commission,
            netPoisha: s.net,
          },
          { transaction }
        );
        subs.push(sub);
        for (const l of s.lines) {
          const item = await OrderItem.create(
            {
              subOrderId: sub.id,
              variantId: l.variantId,
              productId: l.productId,
              title: l.title,
              variantLabelEn: l.labelEn,
              variantLabelBn: l.labelBn,
              sku: l.sku,
              photoKey: l.photoKey,
              unitPricePoisha: l.unitPrice,
              qty: l.qty,
              lineTotalPoisha: l.lineTotal,
              isMto: l.isMto,
              mtoDays: l.mtoDays,
            },
            { transaction }
          );
          holds.push({ productId: l.productId, variantId: l.variantId, qty: l.qty, itemId: item.id });
        }
      }
      // FR-05: hold the stock, product then variant in a fixed order (no deadlock with another checkout).
      holds.sort((a, b) => (a.productId === b.productId ? (a.variantId < b.variantId ? -1 : 1) : a.productId < b.productId ? -1 : 1));
      for (const h of holds) await inventory.hold(h.variantId, h.qty, h.itemId, { transaction });

      const p = await payments.createIntent(
        {
          purpose: 'market_order',
          purposeId: order.id,
          payerId: buyerId,
          amount: q.total,
          splits: subs.map((s) => ({ ref: s.id, payeeId: s.sellerId, amount: s.totalPoisha })),
          title: `Order ${order.code}`,
          expiresAt: payBy,
          idempotencyKey: `order:${order.id}`,
        },
        { transaction }
      );
      // The commission is the rate M06 snapshotted on the payment, so the release at completion matches.
      if (p.escrow.fee.feeBps !== feeBps) {
        for (const s of subs) {
          const commission = feeOf(s.itemsPoisha, p.escrow.fee.feeBps);
          await s.update({ commissionBps: p.escrow.fee.feeBps, commissionPoisha: commission, netPoisha: s.totalPoisha - commission }, { transaction });
        }
      }
      await order.update({ paymentId: p.id }, { transaction });
      await c.publishOrder(transaction, 'order.created', order, { subOrders: subs.length }, principal);
      await audit.record({ action: 'order.created', actor: principal, entityType: 'order', entityId: order.id, entityCode: order.code, after: { status: order.status, total: q.total, subOrders: subs.length }, req }, { transaction });
      return order;
    });
    return response(o);
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const row = await again();
      if (row) return response(row);
    }
    throw err;
  }
}

// ---------------------------------------------------------------- payment results (M06)

/** Release the stock of every line of a sub-order that still holds it (idempotent per line). */
async function releaseStock(sub, { transaction }) {
  const items = await OrderItem.findAll({ where: { subOrderId: sub.id }, order: [['productId', 'ASC'], ['variantId', 'ASC']], transaction });
  for (const i of items) await inventory.release(i.variantId, i.qty, i.id, { transaction });
}

/** A pending order whose payment did not complete: every sub-order is cancelled and its stock freed. */
async function cancelUnpaid(order, reason, { transaction }) {
  const subs = await SubOrder.findAll({ where: { orderId: order.id }, order: [['code', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
  const now = new Date();
  for (const s of subs) {
    if (!rules.next('payment_closed', s.status, 'system')) continue;
    await releaseStock(s, { transaction });
    await s.update({ status: 'cancelled', cancelledAt: now, cancelledBy: 'system', cancelReason: reason }, { transaction });
    await c.publishSub(transaction, 'sub_order.cancelled', s, { reason, refund: 0 });
  }
  await order.update({ payBy: null }, { transaction });
  await c.syncOrder(order.id, { transaction });
}

/** M06 purpose hook (inside the capture transaction). */
async function onCaptured({ payment, transaction }) {
  const order = await Order.findOne({ where: { paymentId: payment.id }, transaction, lock: transaction.LOCK.UPDATE });
  if (!order) return 'reject';
  if (['placed', 'completed'].includes(order.status)) return 'accept';
  if (order.status !== 'pending_payment') return 'reject'; // cancelled before the money came: refunded in full
  const cfg = c.config();
  const now = new Date();
  const subs = await SubOrder.findAll({ where: { orderId: order.id }, order: [['code', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
  const items = await c.itemsOf(subs.map((s) => s.id), { transaction });
  for (const s of subs) {
    const mine = items.filter((i) => i.subOrderId === s.id);
    const d = rules.placedDeadlines({ placedAt: now, acceptHours: cfg.acceptHours, shipHours: cfg.shipHours, mtoDays: mine.filter((i) => i.isMto).map((i) => i.mtoDays ?? 0) });
    const late = rules.overdue({ shipBy: d.shipBy, buyerCancelHours: cfg.buyerCancelHours, autoCancelHours: cfg.autoCancelHours });
    await s.update({ status: rules.next('pay', s.status, 'system'), placedAt: now, ...d, ...late }, { transaction });
    await c.publishSub(transaction, 'sub_order.placed', s, { acceptBy: d.acceptBy.toISOString(), items: mine.length });
  }
  await order.update({ status: 'placed', placedAt: now, payBy: null }, { transaction });
  await cart.clearBought(order.buyerId, [...new Set(items.map((i) => i.variantId))], { transaction });
  await c.publishOrder(transaction, 'order.placed', order, { subOrders: subs.length });
  return 'accept';
}

/** payment.failed / payment.expired (purpose market_order): the order ends, the stock is free. */
async function onPaymentClosed(paymentId, { transaction }) {
  const order = await Order.findOne({ where: { paymentId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!order || order.status !== 'pending_payment') return null;
  await cancelUnpaid(order, 'payment_not_completed', { transaction });
  return 'cancelled';
}

/** Tick: unpaid orders past pay_by (plus the M06 grace for an unknown result). */
async function expireUnpaid(now = new Date()) {
  const grace = settings.get('payments.unknown_grace_minutes') * 60000;
  const due = await Order.findAll({ where: { status: 'pending_payment', payBy: { [Op.lt]: new Date(now.getTime() - grace) } }, attributes: ['id'] });
  let n = 0;
  for (const { id } of due) {
    await sequelize.transaction(async (transaction) => {
      const o = await c.lockOrder(id, transaction);
      if (o.status !== 'pending_payment') return;
      if (o.paymentId) {
        try {
          await payments.cancelIntent(o.paymentId, { transaction });
        } catch {
          // A capture that lands later is rejected by onCaptured and refunded in full by M06.
        }
      }
      await cancelUnpaid(o, 'payment_timeout', { transaction });
      n += 1;
    });
  }
  return n;
}

/** POST /me/orders/:code/pay: the payment link of an unpaid order. */
async function payLink(principal, code) {
  const o = await Order.findOne({ where: { code, buyerId: principal.id } });
  if (!o) throw E.notFound('Order');
  if (o.status !== 'pending_payment') throw fail('ORDER_STATE');
  return response(o);
}

purposes.register('market_order', { onCaptured });

module.exports = { quote, place, onCaptured, onPaymentClosed, expireUnpaid, cancelUnpaid, releaseStock, payLink, response };
