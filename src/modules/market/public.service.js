'use strict';

/**
 * M12 read side (§5.4, FR-30 to FR-32). Only visible items, always from their public versions
 * (live_snapshot), never an owner's unreviewed working copy: shop products with status live,
 * visibility visible and a live shop. Used listings join in step 2.
 *
 *   GET /market/items              filters (category, item types, price band, area, q), facet counts
 *                                  (each facet counted with the other filters), sorts newest / price
 *                                  / -price; cursor = offset
 *   GET /market/products/:slug     gallery, variant picker (prices from the public version, stock now),
 *                                  stock notes, specs with labels, supplement details, the seller
 *   GET /market/shops/:slug        a live shop and its products
 *   GET /market/categories         the M03 item catalogue (filters and the product form)
 */
const { QueryTypes } = require('sequelize');
const { AppError, E } = require('../../common/errors');
const storage = require('../../common/storage');
const { sequelize, Shop, Product, ProductVariant } = require('../../models');
const { ItemType, ItemCategory } = require('../catalog').reference;
const catalog = require('../catalog').catalog;
const rules = require('./market.rules');
const c = require('./market.common');

/** M17: the average shows once there are reviews.min_count_display published reviews (FR-35). */
const shownRating = (x) => (x.ratingCount >= require('../settings').settings.get('reviews.min_count_display') ? (x.ratingAvg ?? null) : null);

/** The WHERE parts of a browse query, by filter, so a facet can drop its own filter. */
function filterParts(q, typeIds) {
  const parts = {
    base: "p.status = 'live' AND p.visibility = 'visible' AND s.status = 'live'",
    types: typeIds ? 'p.public_item_type_id IN (:typeIds)' : null,
    priceMin: q.priceMin !== undefined ? 'p.public_price_from_poisha >= :priceMin' : null,
    priceMax: q.priceMax !== undefined ? 'p.public_price_from_poisha <= :priceMax' : null,
    area: q.areaId ? "s.live_snapshot->>'areaId' = :areaId" : null,
    q: q.q ? "(p.public_title ILIKE :like OR p.public_title % :q OR (s.live_snapshot->>'name') ILIKE :like OR (p.live_snapshot->>'brand') ILIKE :like)" : null,
    mto: q.mto !== undefined ? 'p.is_mto = :mto' : null,
  };
  return parts;
}
const whereOf = (parts, except = []) => Object.entries(parts).filter(([k, v]) => v && !except.includes(k)).map(([, v]) => v).join(' AND ');

/** Item type ids of the category and type filters (null = no filter). */
async function typeFilter(q) {
  let ids = null;
  if (q.category) {
    const cat = await ItemCategory.findOne({ where: { key: q.category } });
    ids = cat ? (await ItemType.findAll({ where: { categoryId: cat.id }, attributes: ['id'] })).map((t) => t.id) : [];
  }
  if (q.types?.length) {
    const picked = (await ItemType.findAll({ where: { key: q.types }, attributes: ['id'] })).map((t) => t.id);
    ids = ids ? ids.filter((id) => picked.includes(id)) : picked;
  }
  return ids;
}

/** GET /market/items */
async function list(q) {
  const typeIds = await typeFilter(q);
  const categoryIds = q.category ? await typeFilter({ category: q.category }) : null;
  const replacements = { typeIds: typeIds?.length ? typeIds : ['00000000-0000-0000-0000-000000000000'], priceMin: q.priceMin ?? null, priceMax: q.priceMax ?? null, areaId: q.areaId ?? null, q: q.q ?? null, like: q.q ? `%${q.q}%` : null, mto: q.mto ?? null };
  const parts = filterParts(q, typeIds);
  const from = 'FROM products p JOIN shops s ON s.id = p.shop_id';
  const order = { newest: 'p.first_live_at DESC, p.id DESC', price: 'p.public_price_from_poisha ASC, p.id ASC', '-price': 'p.public_price_from_poisha DESC, p.id ASC' }[q.sort ?? 'newest'];
  const offset = Number(q.cursor ?? 0);
  const [rows, [{ total }]] = await Promise.all([
    sequelize.query(`SELECT p.id ${from} WHERE ${whereOf(parts)} ORDER BY ${order} LIMIT :limit OFFSET :offset`, { replacements: { ...replacements, limit: q.limit, offset }, type: QueryTypes.SELECT }),
    sequelize.query(`SELECT COUNT(*)::int AS total ${from} WHERE ${whereOf(parts)}`, { replacements, type: QueryTypes.SELECT }),
  ]);
  // Facets (FR-31): item types counted within the category filter, categories without either.
  const facetParts = filterParts(q, categoryIds);
  const typeCounts = await sequelize.query(`SELECT p.public_item_type_id AS "typeId", COUNT(*)::int AS n ${from} WHERE ${whereOf(facetParts)} GROUP BY 1`, {
    replacements: { ...replacements, typeIds: categoryIds?.length ? categoryIds : replacements.typeIds },
    type: QueryTypes.SELECT,
  });
  const allTypeCounts = q.category ? await sequelize.query(`SELECT p.public_item_type_id AS "typeId", COUNT(*)::int AS n ${from} WHERE ${whereOf(filterParts(q, null))} GROUP BY 1`, { replacements, type: QueryTypes.SELECT }) : typeCounts;
  const names = await c.typeNames([...typeCounts, ...allTypeCounts].map((r) => r.typeId));
  const categories = new Map();
  for (const r of allTypeCounts) {
    const cat = names.get(r.typeId)?.category;
    if (cat) categories.set(cat.key, { ...cat, count: (categories.get(cat.key)?.count ?? 0) + r.n });
  }
  const products = rows.length ? await Product.findAll({ where: { id: rows.map((r) => r.id) } }) : [];
  const cards = await cardsFor(rows.map((r) => products.find((p) => p.id === r.id)));
  return {
    items: cards,
    total,
    nextCursor: offset + q.limit < total ? String(offset + q.limit) : null,
    facets: {
      categories: [...categories.values()].map(({ id, key, nameEn, nameBn, count }) => ({ id, key, nameEn, nameBn, count })),
      itemTypes: typeCounts.map((r) => ({ ...names.get(r.typeId), count: r.n })).filter((t) => t.key).map(({ id, key, nameEn, nameBn, count }) => ({ id, key, nameEn, nameBn, count })),
    },
    sort: q.sort ?? 'newest',
  };
}

/** Cards for products (in order): cover, title, "from ৳X" (FR-32), item type, shop and area. */
async function cardsFor(products) {
  if (!products.length) return [];
  const shops = await Shop.findAll({ where: { id: [...new Set(products.map((p) => p.shopId))] } });
  const types = await c.typeNames(products.map((p) => p.publicItemTypeId));
  const areas = await c.areaNames(shops.map((s) => s.liveSnapshot?.areaId));
  return products.map((p) => {
    const s = p.liveSnapshot;
    const shop = shops.find((x) => x.id === p.shopId);
    return {
      kind: 'shop',
      id: p.id,
      slug: p.slug,
      title: s.title,
      brand: s.brand ?? null,
      coverUrl: s.photos[0] ? storage.publicUrl(s.photos[0].key) : null,
      priceFromPoisha: p.publicPriceFromPoisha,
      priceToPoisha: p.publicPriceToPoisha,
      pricesVary: p.publicPriceFromPoisha !== p.publicPriceToPoisha,
      isMto: s.isMto,
      itemType: types.get(p.publicItemTypeId) ?? null,
      shop: { name: shop.liveSnapshot.name, slug: shop.slug, shopType: shop.shopType, area: areas.get(shop.liveSnapshot.areaId) ?? null },
    };
  });
}

/** GET /market/products/:slug: a visible product; a removed or suspended one is gone (410). */
async function product(slug) {
  const p = await Product.findOne({ where: { slug } });
  if (!p || !p.liveSnapshot || ['draft', 'pending_review', 'changes_requested', 'rejected', 'withdrawn'].includes(p.status)) throw E.notFound('Product');
  const shop = await Shop.findByPk(p.shopId);
  if (['removed', 'suspended'].includes(p.status)) throw new AppError(410, 'PRODUCT_GONE', c.ERRORS.PRODUCT_GONE[1]);
  const s = p.liveSnapshot;
  const available = p.status === 'live' && shop.status === 'live';
  const t = await c.itemTypeWithFields(s.itemTypeId).catch(() => ({ fields: [], type: null, category: null }));
  const rows = await ProductVariant.findAll({ where: { id: s.variants.map((v) => v.id) } });
  const areas = await c.areaNames([shop.liveSnapshot.areaId]);
  const specs = t.fields
    .filter((f) => !f.isVariantAxis && s.specs[f.key] !== undefined)
    .map((f) => {
      const raw = s.specs[f.key];
      const o = f.kind === 'select' ? f.options.find((x) => x.value === raw) : null;
      return { key: f.key, labelEn: f.labelEn, labelBn: f.labelBn, valueEn: o ? o.labelEn : `${raw}${f.unit ? ` ${f.unit}` : ''}`, valueBn: o ? o.labelBn : `${raw}${f.unit ? ` ${f.unit}` : ''}` };
    });
  const variants = s.variants.map((sv) => {
    const v = rows.find((x) => x.id === sv.id);
    const stock = rules.variantStatus({ isMto: s.isMto, mtoDays: s.mtoDays, available: v.onHand - v.held, lowThreshold: shop.lowStockThreshold, autoHide: shop.autoHideOutOfStock, saleBlocked: v.saleBlocked });
    return {
      id: sv.id,
      attributes: sv.attributes,
      labelEn: rules.variantLabel(t.fields, sv.attributes, 'en'),
      labelBn: rules.variantLabel(t.fields, sv.attributes, 'bn'),
      pricePoisha: sv.pricePoisha,
      // The exact count shows only when it is low; otherwise in stock / out / ships in N days.
      stock: { code: stock.code, available: stock.code === 'low' ? stock.available : null, days: stock.days ?? null },
      purchasable: available && rules.saleable({ status: v.status, saleBlocked: v.saleBlocked, available: v.onHand - v.held }, s.isMto),
      expiryDate: sv.expiryDate ?? null,
    };
  });
  const axes = t.fields.filter((f) => f.isVariantAxis).map(c.fieldView);
  return {
    id: p.id,
    slug: p.slug,
    title: s.title,
    brand: s.brand,
    description: s.description,
    photos: s.photos.map((x) => ({ id: x.id, url: storage.publicUrl(x.key) })),
    priceFromPoisha: p.publicPriceFromPoisha,
    priceToPoisha: p.publicPriceToPoisha,
    isMto: s.isMto,
    mtoDays: s.mtoDays,
    maxQtyPerOrder: s.maxQtyPerOrder,
    itemType: t.type ? { id: t.type.id, key: t.type.key, nameEn: t.type.nameEn, nameBn: t.type.nameBn } : null,
    category: t.category ? { id: t.category.id, key: t.category.key, nameEn: t.category.nameEn, nameBn: t.category.nameBn, isSupplement: t.category.isSupplement } : null,
    axes,
    variants,
    specs,
    supplement: t.category?.isSupplement ? { importer: s.importer, bstiRegNo: s.bstiRegNo } : null,
    shop: { name: shop.liveSnapshot.name, slug: shop.slug, shopType: shop.shopType, area: areas.get(shop.liveSnapshot.areaId) ?? null, verifiedSince: c.iso(shop.firstLiveAt), ratingAvg: shownRating(shop), ratingCount: shop.ratingCount },
    available,
    // M13: the cart and checkout are open while the product and its shop are live.
    checkoutOpen: available,
    version: p.liveVersion,
  };
}

/** GET /market/shops/:slug: a live shop and its visible products, newest first. */
async function shop(slug, { cursor, limit = 24 } = {}) {
  const s = await Shop.findOne({ where: { slug, status: 'live' } });
  if (!s?.liveSnapshot) throw E.notFound('Shop');
  const offset = Number(cursor ?? 0);
  const { rows, count } = await Product.findAndCountAll({ where: { shopId: s.id, status: 'live', visibility: 'visible' }, order: [['firstLiveAt', 'DESC'], ['id', 'DESC']], limit, offset });
  const areas = await c.areaNames([s.liveSnapshot.areaId]);
  return {
    id: s.id,
    name: s.liveSnapshot.name,
    slug: s.slug,
    shopType: s.shopType,
    about: s.liveSnapshot.about,
    area: areas.get(s.liveSnapshot.areaId) ?? null,
    addressLine: s.liveSnapshot.addressLine,
    verifiedSince: c.iso(s.firstLiveAt),
    ratingAvg: shownRating(s),
    ratingCount: s.ratingCount,
    items: await cardsFor(rows),
    total: count,
    nextCursor: offset + limit < count ? String(offset + limit) : null,
  };
}

const categories = () => catalog.publicItems();

module.exports = { list, product, shop, categories, cardsFor };
