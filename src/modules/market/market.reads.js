'use strict';

/**
 * M12 reads for other modules (M17 reports, M13 cart and checkout, M19). Ids, names, public prices
 * and stock only; M13 changes stock through InventoryService, never here.
 */
const { Op } = require('sequelize');
const { Shop, Product, ProductVariant } = require('../../models');
const rules = require('./market.rules');
const c = require('./market.common');

/** A shop for a report: its owner, public name and status (null when unknown or removed). */
async function shop(id) {
  const s = await Shop.findByPk(id, { attributes: ['id', 'ownerId', 'name', 'slug', 'status', 'liveSnapshot'] });
  if (!s || s.status === 'removed') return null;
  return { id: s.id, ownerId: s.ownerId, name: s.liveSnapshot?.name ?? s.name, slug: s.slug, status: s.status };
}

/** A shop product for a report: its shop owner, public title and status (null when unknown or removed). */
async function product(id) {
  const p = await Product.findByPk(id, { attributes: ['id', 'shopId', 'title', 'slug', 'status', 'liveSnapshot'] });
  if (!p || p.status === 'removed') return null;
  const s = await Shop.findByPk(p.shopId, { attributes: ['ownerId'] });
  return { id: p.id, ownerId: s.ownerId, shopId: p.shopId, title: p.liveSnapshot?.title ?? p.title, slug: p.slug, status: p.status };
}

/**
 * M19 "Needs your action" for a shop owner: the shop or products with changes requested, and
 * variants running low, out of stock or blocked for expiry (links to the vendor desk).
 */
async function pendingActions(principal) {
  const s = await Shop.findOne({ where: { ownerId: principal.id }, attributes: ['id', 'status', 'editStatus', 'lowStockThreshold'] });
  if (!s || s.status === 'removed') return [];
  const items = [];
  if (s.status === 'changes_requested' || s.editStatus === 'changes_requested') items.push({ key: 'shop_changes_requested', count: 1, severity: 'high', dueAt: null, href: '/vendor/shop' });
  const products = await Product.findAll({ where: { shopId: s.id, status: { [Op.ne]: 'removed' } }, attributes: ['id', 'status', 'editStatus', 'isMto'] });
  const changes = products.filter((p) => p.status === 'changes_requested' || p.editStatus === 'changes_requested').length;
  if (changes) items.push({ key: 'products_changes_requested', count: changes, severity: 'high', dueAt: null, href: '/vendor/products' });
  const stocked = products.filter((p) => ['live', 'paused'].includes(p.status) && !p.isMto).map((p) => p.id);
  const variants = stocked.length ? await ProductVariant.findAll({ where: { productId: stocked, status: 'active' }, attributes: ['onHand', 'held', 'saleBlocked'] }) : [];
  const out = variants.filter((v) => !v.saleBlocked && v.onHand - v.held <= 0).length;
  const low = variants.filter((v) => !v.saleBlocked && v.onHand - v.held > 0 && v.onHand - v.held <= s.lowStockThreshold).length;
  const blocked = variants.filter((v) => v.saleBlocked).length;
  if (out) items.push({ key: 'stock_out', count: out, severity: 'high', dueAt: null, href: '/vendor/inventory?status=out' });
  if (low) items.push({ key: 'stock_low', count: low, severity: 'normal', dueAt: null, href: '/vendor/inventory?status=low' });
  if (blocked) items.push({ key: 'stock_blocked', count: blocked, severity: 'normal', dueAt: null, href: '/vendor/inventory?status=blocked' });
  return items;
}

/**
 * M13 cart and checkout: what each variant sells for now, from the public version (live_snapshot),
 * never the owner's working copy. A variant is purchasable when its product and shop are live and
 * it is active, not blocked for expiry and in stock (or made to order). Unknown ids are left out.
 * Returns Map(variantId → { variantId, productId, productSlug, shopId, shopName, shopSlug, sellerId,
 * title, labelEn, labelBn, sku, photoKey, unitPrice, maxPerOrder, isMto, mtoDays, available,
 * purchasable }).
 */
async function purchasable(variantIds, { transaction } = {}) {
  const ids = [...new Set(variantIds)];
  const out = new Map();
  if (!ids.length) return out;
  const variants = await ProductVariant.findAll({ where: { id: ids }, transaction });
  const products = await Product.findAll({ where: { id: [...new Set(variants.map((v) => v.productId))] }, transaction });
  const shops = await Shop.findAll({ where: { id: [...new Set(products.map((x) => x.shopId))] }, transaction });
  const fieldsByType = new Map();
  for (const v of variants) {
    const p = products.find((x) => x.id === v.productId);
    const s = p.liveSnapshot;
    const sv = s?.variants?.find((x) => x.id === v.id);
    if (!sv) continue;
    const shop = shops.find((x) => x.id === p.shopId);
    if (!fieldsByType.has(s.itemTypeId)) fieldsByType.set(s.itemTypeId, await c.itemTypeWithFields(s.itemTypeId, { transaction }).then((t) => t.fields).catch(() => []));
    const fields = fieldsByType.get(s.itemTypeId);
    const available = v.onHand - v.held;
    out.set(v.id, {
      variantId: v.id,
      productId: p.id,
      productSlug: p.slug,
      shopId: shop.id,
      shopName: shop.liveSnapshot?.name ?? shop.name,
      shopSlug: shop.slug,
      sellerId: shop.ownerId,
      title: s.title,
      labelEn: rules.variantLabel(fields, sv.attributes, 'en'),
      labelBn: rules.variantLabel(fields, sv.attributes, 'bn'),
      sku: sv.sku ?? null,
      photoKey: s.photos?.[0]?.key ?? null,
      unitPrice: sv.pricePoisha,
      maxPerOrder: s.maxQtyPerOrder,
      isMto: s.isMto,
      mtoDays: s.isMto ? s.mtoDays : null,
      available,
      purchasable: p.status === 'live' && shop.status === 'live' && rules.saleable({ status: v.status, saleBlocked: v.saleBlocked, available }, s.isMto),
    });
  }
  return out;
}

module.exports = { shop, product, pendingActions, purchasable };
