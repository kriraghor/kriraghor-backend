'use strict';

/**
 * M13 cart (FR-01, FR-02). One cart per member; a line per variant with the price seen when it was
 * added. Reads join the live public price and stock from M12 (market.reads.purchasable); a line
 * older than market.cart_line_days drops out. Removing a line sets removed_at.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const storage = require('../../common/storage');
const { sequelize, Cart, CartItem } = require('../../models');
const reads = require('../market/market.reads');
const rules = require('./orders.rules');
const c = require('./orders.common');

const { fail } = c;

async function cartOf(userId, { transaction } = {}) {
  const found = await Cart.findOne({ where: { userId }, transaction });
  if (found) return found;
  try {
    return await Cart.create({ userId }, { transaction });
  } catch (err) {
    if (err instanceof UniqueConstraintError) return Cart.findOne({ where: { userId }, transaction });
    throw err;
  }
}

/** The live lines (stale ones are removed on the way). */
async function liveLines(cart, { transaction } = {}) {
  const now = new Date();
  const days = c.config().cartLineDays;
  const rows = await CartItem.findAll({ where: { cartId: cart.id, removedAt: null }, order: [['addedAt', 'ASC']], transaction });
  const stale = rows.filter((r) => rules.lineStale({ addedAt: r.addedAt, now, days }));
  if (stale.length) await CartItem.update({ removedAt: now }, { where: { id: stale.map((r) => r.id), removedAt: null }, transaction });
  return rows.filter((r) => !stale.includes(r));
}

function lineView(row, info) {
  if (!info) return { variantId: row.variantId, qty: row.qty, addedPrice: row.addedPricePoisha, unavailable: true, block: 'ITEM_UNAVAILABLE' };
  const block = rules.lineBlock({ purchasable: info.purchasable, qty: row.qty, available: info.available, maxPerOrder: info.maxPerOrder, isMto: info.isMto });
  return {
    variantId: row.variantId,
    productId: info.productId,
    productSlug: info.productSlug,
    title: info.title,
    variantLabelEn: info.labelEn,
    variantLabelBn: info.labelBn,
    photoUrl: info.photoKey ? storage.publicUrl(info.photoKey) : null,
    shop: { id: info.shopId, name: info.shopName, slug: info.shopSlug },
    qty: row.qty,
    maxQty: rules.maxQty({ available: info.available, maxPerOrder: info.maxPerOrder, isMto: info.isMto }),
    unitPrice: info.unitPrice,
    addedPrice: row.addedPricePoisha,
    priceChanged: info.unitPrice !== row.addedPricePoisha,
    lineTotal: info.unitPrice * row.qty,
    isMto: info.isMto,
    mtoDays: info.mtoDays,
    unavailable: Boolean(block),
    block,
  };
}

/** GET /me/cart: lines grouped by shop, with live prices, stock and the items subtotal. */
async function get(principal) {
  const cart = await cartOf(principal.id);
  const rows = await liveLines(cart);
  const info = await reads.purchasable(rows.map((r) => r.variantId));
  const lines = rows.map((r) => lineView(r, info.get(r.variantId)));
  const shops = [];
  for (const l of lines.filter((x) => x.shop)) {
    let g = shops.find((s) => s.shop.id === l.shop.id);
    if (!g) shops.push((g = { shop: l.shop, lines: [], items: 0 }));
    g.lines.push(l);
    if (!l.unavailable) g.items += l.lineTotal;
  }
  return {
    shops,
    unavailable: lines.filter((l) => !l.shop),
    count: lines.reduce((n, l) => n + l.qty, 0),
    items: shops.reduce((n, s) => n + s.items, 0),
    ready: lines.length > 0 && lines.every((l) => !l.unavailable),
  };
}

/** PUT /me/cart/items/:variantId { qty }: add or set the quantity (FR-01). */
async function setQty(principal, variantId, { qty }) {
  const info = (await reads.purchasable([variantId])).get(variantId);
  if (!info || !info.purchasable) throw fail('ITEM_UNAVAILABLE');
  if (info.sellerId === principal.id) throw fail('OWN_ITEM');
  if (qty > info.maxPerOrder) throw fail('QTY_LIMIT', { max: info.maxPerOrder });
  if (!info.isMto && qty > info.available) throw fail('INSUFFICIENT_STOCK', { available: info.available });
  await sequelize.transaction(async (transaction) => {
    const cart = await cartOf(principal.id, { transaction });
    const row = await CartItem.findOne({ where: { cartId: cart.id, variantId, removedAt: null }, transaction, lock: transaction.LOCK.UPDATE });
    // A new line, or one seen again after it went stale, takes today's price as the one seen.
    if (row && !rules.lineStale({ addedAt: row.addedAt, now: new Date(), days: c.config().cartLineDays })) await row.update({ qty }, { transaction });
    else {
      if (row) await row.update({ removedAt: new Date() }, { transaction });
      await CartItem.create({ cartId: cart.id, variantId, qty, addedPricePoisha: info.unitPrice }, { transaction });
    }
  });
  return get(principal);
}

/** DELETE /me/cart/items/:variantId. */
async function remove(principal, variantId) {
  const cart = await cartOf(principal.id);
  await CartItem.update({ removedAt: new Date() }, { where: { cartId: cart.id, variantId, removedAt: null } });
  return get(principal);
}

/** DELETE /me/cart: empty it. */
async function clear(principal) {
  const cart = await cartOf(principal.id);
  await CartItem.update({ removedAt: new Date() }, { where: { cartId: cart.id, removedAt: null } });
  return get(principal);
}

/** Checkout took these variants: their cart lines go (inside the capture transaction). */
async function clearBought(userId, variantIds, { transaction }) {
  const cart = await Cart.findOne({ where: { userId }, transaction });
  if (!cart || !variantIds.length) return 0;
  const [n] = await CartItem.update({ removedAt: new Date() }, { where: { cartId: cart.id, variantId: { [Op.in]: variantIds }, removedAt: null }, transaction });
  return n;
}

/** The lines checkout prices: { variantId, qty, seenPrice }. */
async function linesForCheckout(userId) {
  const cart = await cartOf(userId);
  const rows = await liveLines(cart);
  return rows.map((r) => ({ variantId: r.variantId, qty: r.qty, seenPrice: r.addedPricePoisha }));
}

module.exports = { get, setQty, remove, clear, clearBought, linesForCheckout };
