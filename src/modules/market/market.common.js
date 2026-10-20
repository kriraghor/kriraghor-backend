'use strict';

/**
 * Shared bits of M12: the error catalogue (§9 codes), owner lookups, the M03 item catalogue (read
 * through the catalogue tables, never written), the working copy of a product and its public
 * version (live_snapshot), and serializers.
 */
const { AppError, E } = require('../../common/errors');
const storage = require('../../common/storage');
const { Shop, Product, ProductVariant, ProductPhoto } = require('../../models');
const { ItemType, ItemTypeField, ItemCategory, Area } = require('../catalog').reference;
const settings = require('../settings').settings;
const rules = require('./market.rules');

const ERRORS = {
  NOT_OWNER: [403, 'This belongs to another shop'],
  SHOP_EXISTS: [409, 'You already have a shop'],
  SHOP_REQUIRED: [409, 'Open your shop first'],
  SHOP_STATE: [409, 'The shop cannot do that in its current state'],
  SHOP_IN_REVIEW: [409, 'Staff are reviewing your shop. Wait for the decision, or withdraw it'],
  SHOP_NOT_LIVE: [409, 'Your shop must be approved before its products can be reviewed'],
  SHOP_TYPE_UNKNOWN: [422, 'Choose a shop type from the list'],
  AREA_UNKNOWN: [422, 'Choose an area from the list'],
  PRODUCT_STATE: [409, 'The product cannot do that in its current state'],
  PRODUCT_IN_REVIEW: [409, 'Staff are reviewing this product. Wait for the decision, or withdraw it'],
  PRODUCT_INCOMPLETE: [422, 'Finish the product before sending it for review'],
  NOTHING_TO_REVIEW: [409, 'There are no changes that need review'],
  ITEM_TYPE_UNKNOWN: [422, 'Choose an item type from the list'],
  CATEGORY_NOT_FOR_SHOP: [422, 'Your shop type cannot sell in this category'],
  SPECS_INVALID: [422, 'Some details do not match the item type'],
  ATTRIBUTES_INVALID: [422, 'The size or option does not match the item type'],
  AXES_MISMATCH: [422, 'Every variant of a product uses the same options (for example size and colour)'],
  VARIANT_DUPLICATE: [409, 'This product already has that variant'],
  SKU_TAKEN: [409, 'Another product of your shop uses this SKU'],
  VARIANT_HAS_HELD: [409, 'Units of this variant are held for orders. Wait until they ship or are released'],
  LAST_VARIANT: [409, 'A product needs at least one variant'],
  VARIANT_STATE: [409, 'This variant is retired'],
  PRICE_OUT_OF_RANGE: [422, 'The price is outside the range for this item type'],
  SUPPLEMENT_DETAILS_REQUIRED: [422, 'Supplements need the importer or the BSTI registration number'],
  EXPIRY_REQUIRED: [422, 'Supplements need an expiry date and batch number on each variant'],
  MTO_DAYS_INVALID: [422, 'Choose a made-to-order time the platform allows'],
  QTY_LIMIT_INVALID: [422, 'Choose a per-order limit the platform allows'],
  MTO_NO_STOCK: [409, 'Made-to-order products have no stock to count'],
  PHOTO_LIMIT: [409, 'This product has the most photos allowed'],
  PHOTOS_MISMATCH: [422, 'Send every photo of the product, in the new order'],
  FILE_EMPTY: [422, 'The file is empty'],
  FILE_TOO_LARGE: [413, 'The photo is too large'],
  FILE_TYPE_NOT_ALLOWED: [415, 'Upload a JPEG, PNG or WebP photo'],
  FILE_TYPE_MISMATCH: [415, 'The file is not the type it says it is'],
  INSUFFICIENT_STOCK: [409, 'Not enough stock'],
  STOCK_STATE: [409, 'The stock cannot do that'],
  BELOW_HELD: [409, 'Stock cannot go below the units held for orders'],
  PRODUCT_GONE: [410, 'This product is no longer listed'],
  SAVED_LIMIT: [409, 'You have saved the most items allowed. Remove some first'],
  OWN_ITEM: [409, 'This is your own item'],
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta);

/** Limits read from settings (M03), never literals. */
function limits() {
  return {
    minPhotos: settings.get('market.product_min_photos'),
    maxPhotos: settings.get('market.product_max_photos'),
    repricePct: settings.get('market.product_reprice_moderation_pct'),
    mtoDaysMax: settings.get('market.mto_days_max'),
    qtyMax: settings.get('market.max_qty_per_order_max'),
    minShelfDays: settings.get('market.supplement_min_shelf_days'),
  };
}

// ---------------------------------------------------------------- M03 item catalogue (read-only)

/** An active item type with its category and active fields; ITEM_TYPE_UNKNOWN otherwise. */
async function itemTypeWithFields(itemTypeId, { transaction } = {}) {
  const t = await ItemType.findByPk(itemTypeId, { include: [{ model: ItemCategory, as: 'category' }], transaction });
  if (!t || !t.isActive || !t.category?.isActive) throw fail('ITEM_TYPE_UNKNOWN');
  const fields = await ItemTypeField.findAll({ where: { itemTypeId: t.id, isActive: true }, order: [['sort', 'ASC'], ['key', 'ASC']], transaction });
  return { type: t, category: t.category, fields };
}

/** The type must belong to a category this shop type may sell in (supplements only in supplement houses). */
function assertTypeForShop(shop, category) {
  if (!category.shopTypes.includes(shop.shopType)) throw fail('CATEGORY_NOT_FOR_SHOP');
}

const fieldView = (f) => ({
  key: f.key,
  labelEn: f.labelEn,
  labelBn: f.labelBn,
  kind: f.kind,
  options: f.options,
  unit: f.unit ?? null,
  min: f.minValue ?? null,
  max: f.maxValue ?? null,
  required: f.required,
  isVariantAxis: f.isVariantAxis,
});

/** Display names of item types (and their categories), keyed by type id. */
async function typeNames(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await ItemType.findAll({ where: { id: unique }, include: [{ model: ItemCategory, as: 'category' }] });
  return new Map(rows.map((t) => [t.id, { id: t.id, key: t.key, nameEn: t.nameEn, nameBn: t.nameBn, category: { id: t.category.id, key: t.category.key, nameEn: t.category.nameEn, nameBn: t.category.nameBn, isSupplement: t.category.isSupplement } }]));
}

/** Area names keyed by id. */
async function areaNames(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await Area.findAll({ where: { id: unique } });
  return new Map(rows.map((a) => [a.id, { id: a.id, key: a.key, nameEn: a.nameEn, nameBn: a.nameBn }]));
}

// ---------------------------------------------------------------- owner lookups

/** The principal's shop (any status but removed), or null. */
const shopOf = (userId, { transaction, lock = false } = {}) =>
  Shop.findOne({ where: { ownerId: userId }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });

/** The principal's shop; SHOP_REQUIRED when there is none. */
async function myShop(principal, { transaction, lock = false } = {}) {
  const s = await shopOf(principal.id, { transaction, lock });
  if (!s || s.status === 'removed') throw fail('SHOP_REQUIRED');
  return s;
}

/** The principal's product (removed products are gone; another shop's is NOT_OWNER). */
async function ownedProduct(principal, productId, { transaction, lock = false } = {}) {
  const p = await Product.findByPk(productId, { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!p || p.status === 'removed') throw E.notFound('Product');
  const shop = await Shop.findByPk(p.shopId, { transaction });
  if (shop.ownerId !== principal.id) throw fail('NOT_OWNER');
  return { product: p, shop };
}

/** A variant of the principal's product, with the product locked first (lock order: product → variants). */
async function ownedVariant(principal, variantId, { transaction }) {
  const v0 = await ProductVariant.findByPk(variantId, { transaction });
  if (!v0) throw E.notFound('Variant');
  const { product, shop } = await ownedProduct(principal, v0.productId, { transaction, lock: true });
  const variant = await ProductVariant.findByPk(variantId, { transaction, lock: transaction.LOCK.UPDATE });
  return { product, shop, variant };
}

// ---------------------------------------------------------------- working copy and public version

const ACTIVE = { status: 'active' };
const photoView = (p) => ({ id: p.id, url: storage.publicUrl(p.storageKey), sort: p.sort });

/** The working copy: product, active photos, active variants (sorted). */
async function loadWorking(productId, { transaction } = {}) {
  const product = await Product.findByPk(productId, { transaction });
  if (!product) return null;
  const [photos, variants] = await Promise.all([
    ProductPhoto.findAll({ where: { ownerType: 'product', ownerId: productId, status: 'active' }, order: [['sort', 'ASC'], ['createdAt', 'ASC']], transaction }),
    ProductVariant.findAll({ where: { productId, ...ACTIVE }, order: [['sort', 'ASC'], ['createdAt', 'ASC']], transaction }),
  ]);
  return { product, photos, variants };
}

const variantShape = (p, v) => ({ id: v.id, attributes: v.attributes, sku: v.sku ?? null, pricePoisha: rules.variantPrice(p.basePricePoisha, v.priceOverridePoisha), expiryDate: v.expiryDate ?? null, batchNo: v.batchNo ?? null, sort: v.sort });

/** The public version built from the working copy (at approval, and for the reviewer's diff). */
function snapshotOf({ product: p, photos, variants }, version) {
  return {
    version,
    title: p.title,
    itemTypeId: p.itemTypeId,
    brand: p.brand ?? null,
    description: p.description ?? null,
    specs: p.specs,
    isMto: p.isMto,
    mtoDays: p.mtoDays ?? null,
    maxQtyPerOrder: p.maxQtyPerOrder,
    importer: p.importer ?? null,
    bstiRegNo: p.bstiRegNo ?? null,
    basePricePoisha: p.basePricePoisha,
    photos: photos.map((x) => ({ id: x.id, key: x.storageKey })),
    variants: variants.map((v) => variantShape(p, v)),
  };
}

/** The search columns follow the public version (browse never reads the working copy). */
function publicColumns(snapshot) {
  const { from, to } = rules.priceRange(snapshot.variants.map((v) => v.pricePoisha), snapshot.basePricePoisha);
  return { publicTitle: snapshot.title, publicItemTypeId: snapshot.itemTypeId, publicPriceFromPoisha: from, publicPriceToPoisha: to };
}

/** The working copy in the shape productDiff compares. */
const workingShape = (w) => ({ ...snapshotOf(w, null), photos: w.photos.map((x) => ({ id: x.id })) });

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** The owner's view of a variant (stock and status). */
function variantView(p, v, shop) {
  return {
    id: v.id,
    attributes: v.attributes,
    sku: v.sku ?? null,
    priceOverridePoisha: v.priceOverridePoisha ?? null,
    pricePoisha: rules.variantPrice(p.basePricePoisha, v.priceOverridePoisha),
    onHand: v.onHand,
    held: v.held,
    available: v.onHand - v.held,
    expiryDate: v.expiryDate ?? null,
    batchNo: v.batchNo ?? null,
    saleBlocked: v.saleBlocked,
    status: v.status,
    stock: rules.variantStatus({ isMto: p.isMto, mtoDays: p.mtoDays, available: v.onHand - v.held, lowThreshold: shop.lowStockThreshold, autoHide: shop.autoHideOutOfStock, saleBlocked: v.saleBlocked }),
    sort: v.sort,
  };
}

/** The owner's view of their product. */
function ownerView(w, shop) {
  const p = w.product;
  return {
    id: p.id,
    slug: p.slug,
    shopId: p.shopId,
    itemTypeId: p.itemTypeId,
    title: p.title,
    brand: p.brand ?? null,
    description: p.description ?? null,
    specs: p.specs,
    basePricePoisha: p.basePricePoisha,
    isMto: p.isMto,
    mtoDays: p.mtoDays ?? null,
    maxQtyPerOrder: p.maxQtyPerOrder,
    importer: p.importer ?? null,
    bstiRegNo: p.bstiRegNo ?? null,
    status: p.status,
    editStatus: p.editStatus ?? null,
    visibility: p.visibility,
    liveVersion: p.liveVersion,
    reviewReason: p.reviewReasonCode ? { code: p.reviewReasonCode, text: p.reviewReasonText ?? null } : null,
    publicPricePoisha: p.publicPriceFromPoisha ?? null,
    firstLiveAt: iso(p.firstLiveAt),
    photos: w.photos.map(photoView),
    variants: w.variants.map((v) => variantView(p, v, shop)),
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}

/** The owner's view of their shop. */
function shopView(s) {
  return {
    id: s.id,
    slug: s.slug,
    shopType: s.shopType,
    name: s.name,
    areaId: s.areaId,
    addressLine: s.addressLine,
    lat: s.lat ?? null,
    lng: s.lng ?? null,
    about: s.about ?? null,
    status: s.status,
    editStatus: s.editStatus ?? null,
    liveVersion: s.liveVersion,
    reviewReason: s.reviewReasonCode ? { code: s.reviewReasonCode, text: s.reviewReasonText ?? null } : null,
    firstLiveAt: iso(s.firstLiveAt),
    stockRules: { lowStockThreshold: s.lowStockThreshold, autoHideOutOfStock: s.autoHideOutOfStock, mtoDaysDefault: s.mtoDaysDefault },
    createdAt: iso(s.createdAt),
    updatedAt: iso(s.updatedAt),
  };
}

module.exports = {
  ERRORS,
  fail,
  limits,
  itemTypeWithFields,
  assertTypeForShop,
  fieldView,
  typeNames,
  areaNames,
  shopOf,
  myShop,
  ownedProduct,
  ownedVariant,
  loadWorking,
  variantShape,
  snapshotOf,
  publicColumns,
  workingShape,
  photoView,
  variantView,
  ownerView,
  shopView,
  iso,
};
