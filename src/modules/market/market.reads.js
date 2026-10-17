'use strict';

/**
 * M12 reads for other modules (M17 reports; later M13 and M19). Ids, names and statuses only.
 */
const { Op } = require('sequelize');
const { Shop, Product, ProductVariant } = require('../../models');

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

module.exports = { shop, product, pendingActions };
