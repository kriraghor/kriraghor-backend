'use strict';

/**
 * M12 inventory (§5.2, FR-10 to FR-15, §6.1). Per variant: on_hand, held, available = on_hand − held
 * (generated). Every change writes one inventory_movements row in the same transaction as the
 * variant update, under row locks taken in a fixed order (product, then the variant), so a stock
 * adjustment and an M13 hold on the same variant never deadlock or oversell.
 *
 * InventoryService for M13 (called inside its own transaction; idempotent on the reference):
 *   hold(variantId, qty, subOrderItemId)     INSUFFICIENT_STOCK when available < qty, or the variant
 *                                            is retired or blocked for expiry (v3)
 *   release(variantId, qty, subOrderItemId)  cancelled before shipping
 *   commit(variantId, qty, subOrderItemId)   shipped: on_hand −qty, held −qty
 *   restock(variantId, qty, returnId)        an unused return back on the shelf
 * Made-to-order products carry no stock: their holds and commits move nothing (FR-06).
 *
 * After each movement: low stock fires once per crossing (FR-14), out-of-stock and restock events
 * (M08, saved items), and the product hides or shows again when every variant is out (FR-15).
 */
const { Op, QueryTypes } = require('sequelize');
const { sequelize, Shop, Product, ProductVariant, InventoryMovement } = require('../../models');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const settings = require('../settings/settings.service');
const rules = require('./market.rules');
const c = require('./market.common');

const { fail } = c;
const availableOf = (v) => v.onHand - v.held;

const variantPayload = (v, product, shop, extra = {}) => ({ variantId: v.id, productId: product.id, shopId: shop.id, ownerId: shop.ownerId, ...extra });
const publishVariant = (transaction, name, v, product, shop, extra) => events.publish(transaction, { name, aggregateType: 'product_variant', aggregateId: v.id, payload: variantPayload(v, product, shop, extra) });

/**
 * FR-15: hide or show a published product from its variants' stock and the shop's auto-hide rule.
 * The caller holds the product row lock.
 */
async function refreshVisibility(product, shop, { transaction }) {
  if (!rules.isPublished(product.status)) return product.visibility;
  const variants = await ProductVariant.findAll({ where: { productId: product.id, status: 'active' }, transaction });
  const hide = rules.shouldHide({ isMto: product.isMto, autoHide: shop.autoHideOutOfStock, variants: variants.map((v) => ({ status: v.status, saleBlocked: v.saleBlocked, available: availableOf(v) })) });
  const to = hide ? 'hidden_oos' : 'visible';
  if (to === product.visibility) return to;
  await product.update({ visibility: to }, { transaction });
  await events.publish(transaction, { name: hide ? 'product.hidden' : 'product.unhidden', aggregateType: 'product', aggregateId: product.id, payload: { productId: product.id, shopId: shop.id, ownerId: shop.ownerId, reason: 'stock' } });
  return to;
}

/** A shop changed its auto-hide rule: every published product is re-checked (locks in id order). */
async function refreshShopVisibility(shop, { transaction }) {
  const products = await Product.findAll({ where: { shopId: shop.id, status: ['live', 'paused', 'suspended'] }, order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
  for (const p of products) await refreshVisibility(p, shop, { transaction });
  return products.length;
}

/**
 * Apply one movement to a locked variant: idempotent on (type, reference) for M13's references,
 * then the low-stock, stock and visibility follow-ups. Returns { variant, movement, replay }.
 */
async function moveInTx({ product, shop, variant }, { type, qty, refType = 'manual', refId = null, reasonCode = null, reasonText = null, actor = null }, { transaction }) {
  if (refType !== 'manual') {
    const done = await InventoryMovement.findOne({ where: { type, refType, refId, variantId: variant.id }, transaction });
    if (done) return { variant, movement: done, replay: true };
  }
  const next = rules.applyMovement({ onHand: variant.onHand, held: variant.held }, type, qty);
  if (next.error) throw fail(next.error, { meta: { available: availableOf(variant), held: variant.held } });
  const before = availableOf(variant);
  await variant.update({ onHand: next.onHand, held: next.held }, { transaction });
  const movement = await InventoryMovement.create(
    { variantId: variant.id, type, deltaOnHand: next.deltaOnHand, deltaHeld: next.deltaHeld, onHandAfter: next.onHand, heldAfter: next.held, reasonCode, reasonText, refType, refId, actorId: actor?.id ?? null },
    { transaction }
  );
  const after = availableOf(variant);
  if (rules.isPublished(product.status)) {
    const low = rules.lowStockStep({ available: after, threshold: shop.lowStockThreshold, alerted: Boolean(variant.lowAlertedAt) });
    if (low === 'reached') {
      await variant.update({ lowAlertedAt: new Date() }, { transaction });
      await publishVariant(transaction, 'variant.low_stock_reached', variant, product, shop, { available: after });
    } else if (low === 'rearmed') await variant.update({ lowAlertedAt: null }, { transaction });
    const step = rules.stockStep(before, after);
    if (step === 'depleted') await publishVariant(transaction, 'variant.stock_depleted', variant, product, shop);
    if (step === 'restocked') await publishVariant(transaction, 'variant.restocked', variant, product, shop, { available: after });
    await refreshVisibility(product, shop, { transaction });
  }
  return { variant, movement, replay: false };
}

/** Lock product then variant for M13's calls; refuses what cannot be sold. */
async function lockForSale(variantId, { transaction }) {
  const v0 = await ProductVariant.findByPk(variantId, { attributes: ['id', 'productId'], transaction });
  if (!v0) throw fail('INSUFFICIENT_STOCK');
  const product = await Product.findByPk(v0.productId, { transaction, lock: transaction.LOCK.UPDATE });
  const variant = await ProductVariant.findByPk(variantId, { transaction, lock: transaction.LOCK.UPDATE });
  const shop = await Shop.findByPk(product.shopId, { transaction });
  return { product, shop, variant };
}

const movementView = (m) => ({ id: m.id, type: m.type, deltaOnHand: m.deltaOnHand, deltaHeld: m.deltaHeld, onHandAfter: m.onHandAfter, heldAfter: m.heldAfter, reasonCode: m.reasonCode ?? null, reasonText: m.reasonText ?? null, refType: m.refType, refId: m.refId ?? null, actorId: m.actorId ?? null, createdAt: c.iso(m.createdAt) });
const result = ({ variant, movement, replay }) => ({ variantId: variant.id, onHand: variant.onHand, held: variant.held, available: availableOf(variant), movementId: movement?.id ?? null, replay: Boolean(replay) });

// ---------------------------------------------------------------- InventoryService for M13 (FR-12)

async function hold(variantId, qty, subOrderItemId, { transaction }) {
  const ctx = await lockForSale(variantId, { transaction });
  if (ctx.product.isMto) return { variantId, mto: true, replay: false };
  const { product, shop, variant } = ctx;
  // A new hold needs a sellable variant; a replay of an earlier hold is answered as it was.
  const replay = await InventoryMovement.findOne({ where: { type: 'hold', refType: 'sub_order_item', refId: subOrderItemId, variantId }, transaction });
  if (!replay && (variant.status !== 'active' || variant.saleBlocked || product.status !== 'live' || shop.status !== 'live')) throw fail('INSUFFICIENT_STOCK');
  return result(await moveInTx(ctx, { type: 'hold', qty, refType: 'sub_order_item', refId: subOrderItemId, reasonCode: 'order' }, { transaction }));
}

async function release(variantId, qty, subOrderItemId, { transaction }) {
  const ctx = await lockForSale(variantId, { transaction });
  if (ctx.product.isMto) return { variantId, mto: true, replay: false };
  return result(await moveInTx(ctx, { type: 'release', qty, refType: 'sub_order_item', refId: subOrderItemId, reasonCode: 'order' }, { transaction }));
}

async function commit(variantId, qty, subOrderItemId, { transaction }) {
  const ctx = await lockForSale(variantId, { transaction });
  if (ctx.product.isMto) return { variantId, mto: true, replay: false };
  return result(await moveInTx(ctx, { type: 'commit', qty, refType: 'sub_order_item', refId: subOrderItemId, reasonCode: 'order' }, { transaction }));
}

async function restock(variantId, qty, returnId, { transaction }) {
  const ctx = await lockForSale(variantId, { transaction });
  if (ctx.product.isMto) return { variantId, mto: true, replay: false };
  return result(await moveInTx(ctx, { type: 'return_restock', qty, refType: 'return', refId: returnId, reasonCode: 'return' }, { transaction }));
}

// ---------------------------------------------------------------- owner (FR-13)

/** Opening stock of a new variant (inside the product transaction). */
async function openingStock({ product, shop, variant }, qty, actor, { transaction }) {
  if (!qty) return null;
  return moveInTx({ product, shop, variant }, { type: 'receive', qty, reasonCode: 'opening', actor }, { transaction });
}

/**
 * POST /shop/variants/:id/adjust {delta | setTo, reasonCode, reasonText}: a reasoned change of the
 * count on the shelf. Received stock is a `receive`; corrections, damage and losses are `adjust`.
 */
async function adjust(principal, variantId, body, req) {
  return sequelize.transaction(async (transaction) => {
    const { product, shop, variant } = await c.ownedVariant(principal, variantId, { transaction });
    if (product.isMto) throw fail('MTO_NO_STOCK');
    if (variant.status !== 'active') throw fail('VARIANT_STATE');
    const delta = body.setTo !== undefined ? body.setTo - variant.onHand : body.delta;
    if (!delta) return { ...result({ variant, movement: null }), unchanged: true };
    const type = body.reasonCode === 'received' && delta > 0 ? 'receive' : 'adjust';
    const moved = await moveInTx({ product, shop, variant }, { type, qty: delta, reasonCode: body.reasonCode, reasonText: body.reasonText ?? null, actor: principal }, { transaction });
    await audit.record(
      { action: 'inventory.adjusted', actor: principal, entityType: 'product_variant', entityId: variant.id, before: { onHand: variant.onHand - delta }, after: { onHand: variant.onHand }, reason: body.reasonText ?? body.reasonCode, meta: { productId: product.id, delta, reasonCode: body.reasonCode }, req },
      { transaction }
    );
    await events.publish(transaction, { name: 'inventory.adjusted', aggregateType: 'product_variant', aggregateId: variant.id, payload: { variantId: variant.id, productId: product.id, shopId: shop.id, delta, reasonCode: body.reasonCode } });
    return result(moved);
  });
}

/** GET /shop/variants/:id/movements (the variant history): newest first, cursor = created_at. */
async function movements(principal, variantId, { cursor, limit = 50 } = {}) {
  const v0 = await ProductVariant.findByPk(variantId);
  if (!v0) throw fail('VARIANT_STATE');
  await c.ownedProduct(principal, v0.productId);
  const where = { variantId, ...(cursor ? { createdAt: { [Op.lt]: new Date(cursor) } } : {}) };
  const rows = await InventoryMovement.findAll({ where, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  return { items: page.map(movementView), nextCursor: rows.length > limit ? c.iso(page[page.length - 1].createdAt) : null };
}

/**
 * GET /shop/inventory?status=low|out|mto|blocked: every active variant of the shop's products with
 * the desk KPIs (stock value at selling price, out of stock, running low, held, blocked).
 */
async function overview(principal, { status } = {}) {
  const shop = await c.myShop(principal);
  const products = await Product.findAll({ where: { shopId: shop.id, status: { [Op.ne]: 'removed' } } });
  const variants = products.length ? await ProductVariant.findAll({ where: { productId: products.map((p) => p.id), status: 'active' }, order: [['productId', 'ASC'], ['sort', 'ASC']] }) : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const fieldsByType = new Map();
  for (const typeId of new Set(products.map((p) => p.itemTypeId))) {
    fieldsByType.set(typeId, (await c.itemTypeWithFields(typeId).catch(() => ({ fields: [] }))).fields);
  }
  const rows = variants.map((v) => {
    const p = byId.get(v.productId);
    const view = c.variantView(p, v, shop);
    return { ...view, product: { id: p.id, title: p.title, status: p.status, visibility: p.visibility, isMto: p.isMto }, label: rules.variantLabel(fieldsByType.get(p.itemTypeId) ?? [], v.attributes) };
  });
  const stockValue = rows.filter((r) => !r.product.isMto).reduce((n, r) => n + r.onHand * r.pricePoisha, 0);
  const kpis = {
    stockValuePoisha: stockValue,
    outOfStock: rows.filter((r) => ['out', 'out_hidden'].includes(r.stock.code)).length,
    runningLow: rows.filter((r) => r.stock.code === 'low').length,
    heldForOrders: rows.reduce((n, r) => n + r.held, 0),
    blocked: rows.filter((r) => r.stock.code === 'blocked').length,
  };
  const FILTER = { low: ['low'], out: ['out', 'out_hidden'], mto: ['mto'], blocked: ['blocked'] };
  return { kpis, items: status ? rows.filter((r) => FILTER[status].includes(r.stock.code)) : rows, stockRules: c.shopView(shop).stockRules };
}

// ---------------------------------------------------------------- jobs (§10)

/**
 * market.supplement-expiry (daily, v3): a supplement variant whose expiry date is past, or closer than
 * market.supplement_min_shelf_days, is blocked from sale (and shown again if its date was corrected);
 * the shop is told. Idempotent: only changes move anything.
 */
async function supplementSweep(now = new Date()) {
  const today = rules.dhakaDate(now);
  const minShelfDays = settings.get('market.supplement_min_shelf_days');
  const candidates = await ProductVariant.findAll({ where: { status: 'active', expiryDate: { [Op.ne]: null } }, attributes: ['id', 'productId', 'expiryDate', 'saleBlocked'] });
  const due = candidates.filter((v) => rules.shelfBlocked({ expiryDate: v.expiryDate, today, minShelfDays }) !== v.saleBlocked);
  let changed = 0;
  for (const productId of [...new Set(due.map((v) => v.productId))].sort()) {
    changed += await sequelize.transaction(async (transaction) => {
      const product = await Product.findByPk(productId, { transaction, lock: transaction.LOCK.UPDATE });
      const shop = await Shop.findByPk(product.shopId, { transaction });
      const ids = due.filter((v) => v.productId === productId).map((v) => v.id).sort();
      let n = 0;
      for (const id of ids) n += Number(await applyShelfLife(product, shop, await ProductVariant.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE }), { today, minShelfDays, transaction }));
      await refreshVisibility(product, shop, { transaction });
      return n;
    });
  }
  return { checked: candidates.length, changed };
}

/** Block or unblock one locked variant for its expiry date; true when it changed. */
async function applyShelfLife(product, shop, variant, { today, minShelfDays, transaction }) {
  const blocked = rules.shelfBlocked({ expiryDate: variant.expiryDate, today, minShelfDays });
  if (blocked === variant.saleBlocked) return false;
  await variant.update({ saleBlocked: blocked }, { transaction });
  await publishVariant(transaction, blocked ? 'variant.sale_blocked' : 'variant.sale_unblocked', variant, product, shop, { expiryDate: variant.expiryDate ?? null });
  return true;
}

/**
 * market.inventory-reconcile (nightly, FR-11): the variant columns must equal the sum of their
 * movements. A mismatch is audited as critical (every master is alerted); nothing is fixed
 * automatically. Read-only otherwise.
 */
async function reconcile() {
  const rows = await sequelize.query(
    `SELECT v.id AS "variantId", v.product_id AS "productId", v.on_hand AS "onHand", v.held,
            COALESCE(SUM(m.delta_on_hand), 0)::int AS "ledgerOnHand", COALESCE(SUM(m.delta_held), 0)::int AS "ledgerHeld"
       FROM product_variants v LEFT JOIN inventory_movements m ON m.variant_id = v.id
      GROUP BY v.id
     HAVING v.on_hand <> COALESCE(SUM(m.delta_on_hand), 0) OR v.held <> COALESCE(SUM(m.delta_held), 0)`,
    { type: QueryTypes.SELECT }
  );
  for (const r of rows) {
    await audit.record({ action: 'inventory.reconcile_mismatch', actor: null, entityType: 'product_variant', entityId: r.variantId, before: { onHand: r.ledgerOnHand, held: r.ledgerHeld }, after: { onHand: r.onHand, held: r.held }, meta: { productId: r.productId } });
  }
  return { mismatches: rows.length };
}

/** market.visibility-sweep (hourly safety net for FR-15): re-check every published product. */
async function visibilitySweep() {
  const ids = (await Product.findAll({ where: { status: ['live', 'paused'] }, attributes: ['id'], order: [['id', 'ASC']] })).map((p) => p.id);
  let changed = 0;
  for (const id of ids) {
    changed += await sequelize.transaction(async (transaction) => {
      const p = await Product.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      const before = p.visibility;
      const shop = await Shop.findByPk(p.shopId, { transaction });
      return Number((await refreshVisibility(p, shop, { transaction })) !== before);
    });
  }
  return { checked: ids.length, changed };
}

module.exports = { hold, release, commit, restock, openingStock, adjust, movements, overview, refreshVisibility, refreshShopVisibility, applyShelfLife, supplementSweep, reconcile, visibilitySweep, moveInTx };
