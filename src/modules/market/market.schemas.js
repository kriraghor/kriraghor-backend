'use strict';

/**
 * M12 request and response schemas (zod → validation and OpenAPI). Money in poisha; dates YYYY-MM-DD;
 * specs and variant attributes are keyed by the M03 item field keys (GET /market/categories).
 */
const { z } = require('zod');

const dateTime = z.iso.datetime({ offset: true });
const id = z.uuid();
const idParam = z.object({ id });
const photoParams = z.object({ id, photoId: id });
const slugParam = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,140}$/) });
const csv = (item) => z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(item).max(20));
const bool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
const poisha = z.number().int().positive();
const key = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
const STATUSES = ['draft', 'pending_review', 'changes_requested', 'live', 'paused', 'rejected', 'withdrawn', 'suspended', 'removed'];
const EDIT_STATUSES = ['draft', 'pending_review', 'changes_requested', 'rejected'];
const SHOP_TYPES = ['sports_gear', 'supplements', 'gym_gear'];

const specValue = z.union([z.string().trim().min(1).max(200), z.number()]);
const specs = z.record(z.string(), specValue).meta({ description: 'By item field key (non-axis fields), e.g. { "stud_type": "tf" }' });
const attributes = z.record(z.string(), z.string().min(1).max(40)).meta({ description: 'By axis field key, e.g. { "eu_size": "43" }; {} for a Standard variant' });

// ---------------- owner: shop
const shopFields = {
  shopType: z.enum(SHOP_TYPES).meta({ description: 'market.shop_types; fixed once the shop is approved' }),
  name: z.string().trim().min(3).max(80),
  areaId: id,
  addressLine: z.string().trim().min(5).max(200),
  lat: z.number().min(20).max(27).nullable().optional(),
  lng: z.number().min(88).max(93).nullable().optional(),
  about: z.string().trim().max(1000).nullable().optional(),
};
const createShop = z.object(shopFields);
const updateShop = z.object(shopFields).partial().refine((b) => Object.keys(b).length > 0, 'Nothing to change');
const stockRules = z
  .object({ lowStockThreshold: z.number().int().min(0).max(1000).optional(), autoHideOutOfStock: z.boolean().optional(), mtoDaysDefault: z.number().int().min(1).max(30).optional() })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

// ---------------- owner: products and variants
const dateOnly = z.iso.date();
const variantFields = {
  sku: z.string().trim().min(1).max(40).nullable().optional(),
  priceOverridePoisha: poisha.nullable().optional().meta({ description: 'This variant’s price; null follows the base price' }),
  expiryDate: dateOnly.nullable().optional().meta({ description: 'Supplements: required' }),
  batchNo: z.string().trim().min(1).max(40).nullable().optional().meta({ description: 'Supplements: required' }),
  sort: z.number().int().min(0).max(1000).optional(),
};
const createVariant = z.object({ attributes: attributes.optional(), ...variantFields, openingStock: z.number().int().min(0).max(100000).optional() });
const updateVariant = z.object(variantFields).refine((b) => Object.keys(b).length > 0, 'Nothing to change');
const productFields = {
  itemTypeId: id,
  title: z.string().trim().min(3).max(120),
  brand: z.string().trim().max(60).nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  specs: specs.optional(),
  basePricePoisha: poisha,
  isMto: z.boolean().optional(),
  mtoDays: z.number().int().min(1).max(30).nullable().optional(),
  maxQtyPerOrder: z.number().int().min(1).max(100).optional(),
  importer: z.string().trim().min(2).max(120).nullable().optional().meta({ description: 'Supplements: the importer, or the BSTI number' }),
  bstiRegNo: z.string().trim().min(2).max(60).nullable().optional(),
};
const createProduct = z.object({ ...productFields, variants: z.array(createVariant).max(60).optional() });
const updateProduct = z.object(productFields).partial().refine((b) => Object.keys(b).length > 0, 'Nothing to change');
const photoOrder = z.object({ ids: z.array(id).min(1).max(30) });
const adjustBody = z
  .object({
    delta: z.number().int().min(-100000).max(100000).optional(),
    setTo: z.number().int().min(0).max(100000).optional(),
    reasonCode: z.enum(['received', 'count_correction', 'damaged', 'lost', 'other']),
    reasonText: z.string().trim().min(3).max(200).optional(),
  })
  .refine((b) => (b.delta === undefined) !== (b.setTo === undefined), 'Send delta or setTo')
  .refine((b) => b.reasonCode !== 'other' || b.reasonText, { message: 'Explain the reason', path: ['reasonText'] });
const ownerListQuery = z.object({ status: z.enum(STATUSES).optional() });
const inventoryQuery = z.object({
  status: z.enum(['low', 'out', 'mto', 'blocked']).optional(),
  shopId: z.uuid().optional().meta({ description: 'Round B3: the shop (staff working at several shops name one; the owner may leave it out)' }),
});
const cursorQuery = z.object({ cursor: z.iso.datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

// ---------------- staff
const reasonBody = z.object({ reason: z.string().trim().min(5).max(300) });
const staffShopsQuery = z.object({ status: z.enum(STATUSES).optional(), q: z.string().trim().min(1).max(60).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
const staffProductsQuery = staffShopsQuery.extend({ shopId: id.optional() });

// ---------------- public and member
const listQuery = z.object({
  kind: z.enum(['shop']).optional().meta({ description: 'Used listings join in step 2' }),
  category: key.optional(),
  types: csv(key).optional(),
  priceMin: z.coerce.number().int().min(0).optional(),
  priceMax: z.coerce.number().int().min(0).optional(),
  areaId: id.optional(),
  mto: bool.optional(),
  q: z.string().trim().min(2).max(60).optional(),
  sort: z.enum(['newest', 'price', '-price']).optional(),
  cursor: z.string().regex(/^\d{1,6}$/).optional(),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});
const shopPageQuery = z.object({ cursor: z.string().regex(/^\d{1,6}$/).optional(), limit: z.coerce.number().int().min(1).max(48).default(24) });
const savedParams = z.object({ itemType: z.enum(['product']), id });

// ---------------- responses
const Named = z.object({ id, key: z.string(), nameEn: z.string(), nameBn: z.string() });
const Photo = z.object({ id, url: z.string(), sort: z.number().int() }).meta({ id: 'ProductPhoto' });
const Stock = z.object({ code: z.enum(['in_stock', 'low', 'out', 'out_hidden', 'mto', 'blocked']), available: z.number().int().optional(), days: z.number().int().nullable().optional() });
const ShopOwner = z
  .object({
    id,
    slug: z.string(),
    shopType: z.enum(SHOP_TYPES),
    name: z.string(),
    areaId: id,
    addressLine: z.string(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    about: z.string().nullable(),
    status: z.enum(STATUSES),
    editStatus: z.enum(EDIT_STATUSES).nullable(),
    liveVersion: z.number().int(),
    reviewReason: z.object({ code: z.string(), text: z.string().nullable() }).nullable(),
    firstLiveAt: dateTime.nullable(),
    stockRules: z.object({ lowStockThreshold: z.number().int(), autoHideOutOfStock: z.boolean(), mtoDaysDefault: z.number().int() }),
    createdAt: dateTime.nullable(),
    updatedAt: dateTime.nullable(),
  })
  .meta({ id: 'ShopOwnerView' });
const VariantOwner = z
  .object({
    id,
    attributes: z.record(z.string(), z.string()),
    sku: z.string().nullable(),
    priceOverridePoisha: z.number().int().nullable(),
    pricePoisha: z.number().int(),
    onHand: z.number().int(),
    held: z.number().int(),
    available: z.number().int(),
    expiryDate: z.string().nullable(),
    batchNo: z.string().nullable(),
    saleBlocked: z.boolean(),
    status: z.enum(['active', 'retired']),
    stock: Stock,
    sort: z.number().int(),
  })
  .meta({ id: 'ProductVariantOwnerView' });
const ProductOwner = z
  .object({
    id,
    slug: z.string(),
    shopId: id,
    itemTypeId: id,
    title: z.string(),
    brand: z.string().nullable(),
    description: z.string().nullable(),
    specs: z.record(z.string(), z.unknown()),
    basePricePoisha: z.number().int(),
    isMto: z.boolean(),
    mtoDays: z.number().int().nullable(),
    maxQtyPerOrder: z.number().int(),
    importer: z.string().nullable(),
    bstiRegNo: z.string().nullable(),
    status: z.enum(STATUSES),
    editStatus: z.enum(EDIT_STATUSES).nullable(),
    visibility: z.enum(['visible', 'hidden_oos']),
    liveVersion: z.number().int(),
    reviewReason: z.object({ code: z.string(), text: z.string().nullable() }).nullable(),
    publicPricePoisha: z.number().int().nullable(),
    firstLiveAt: dateTime.nullable(),
    photos: z.array(Photo),
    variants: z.array(VariantOwner),
    createdAt: dateTime.nullable(),
    updatedAt: dateTime.nullable(),
  })
  .meta({ id: 'ProductOwnerView' });
const ProductOwnerList = z
  .object({
    items: z.array(
      z.object({
        id,
        slug: z.string(),
        title: z.string(),
        itemType: z.object({}).loose().nullable(),
        status: z.enum(STATUSES),
        editStatus: z.enum(EDIT_STATUSES).nullable(),
        visibility: z.enum(['visible', 'hidden_oos']),
        coverUrl: z.string().nullable(),
        basePricePoisha: z.number().int(),
        isMto: z.boolean(),
        variants: z.number().int(),
        onHand: z.number().int(),
        available: z.number().int(),
        reviewReason: z.object({ code: z.string(), text: z.string().nullable() }).nullable(),
        updatedAt: dateTime.nullable(),
      })
    ),
  })
  .meta({ id: 'ProductOwnerList' });
const StockResult = z.object({ variantId: id, onHand: z.number().int(), held: z.number().int(), available: z.number().int(), movementId: id.nullable(), replay: z.boolean(), unchanged: z.boolean().optional() }).meta({ id: 'StockResult' });
const Movement = z.object({ id, type: z.string(), deltaOnHand: z.number().int(), deltaHeld: z.number().int(), onHandAfter: z.number().int(), heldAfter: z.number().int(), reasonCode: z.string().nullable(), reasonText: z.string().nullable(), refType: z.string(), refId: id.nullable(), actorId: id.nullable(), createdAt: dateTime });
const MovementList = z.object({ items: z.array(Movement), nextCursor: z.string().nullable() }).meta({ id: 'InventoryMovementList' });
const InventoryOverview = z
  .object({
    kpis: z.object({ stockValuePoisha: z.number().int(), outOfStock: z.number().int(), runningLow: z.number().int(), heldForOrders: z.number().int(), blocked: z.number().int() }),
    items: z.array(VariantOwner.extend({ product: z.object({ id, title: z.string(), status: z.string(), visibility: z.string(), isMto: z.boolean() }), label: z.string() })),
    stockRules: z.object({ lowStockThreshold: z.number().int(), autoHideOutOfStock: z.boolean(), mtoDaysDefault: z.number().int() }),
  })
  .meta({ id: 'InventoryOverview' });
const Card = z
  .object({
    kind: z.enum(['shop']),
    id,
    slug: z.string(),
    title: z.string(),
    brand: z.string().nullable(),
    coverUrl: z.string().nullable(),
    priceFromPoisha: z.number().int(),
    priceToPoisha: z.number().int(),
    pricesVary: z.boolean(),
    isMto: z.boolean(),
    itemType: z.object({}).loose().nullable(),
    shop: z.object({ name: z.string(), slug: z.string(), shopType: z.string(), area: Named.nullable() }),
  })
  .meta({ id: 'MarketCard' });
const ItemList = z
  .object({
    items: z.array(Card),
    total: z.number().int(),
    nextCursor: z.string().nullable(),
    facets: z.object({ categories: z.array(Named.extend({ count: z.number().int() })), itemTypes: z.array(Named.extend({ count: z.number().int() })) }),
    sort: z.string(),
  })
  .meta({ id: 'MarketItemList' });
const Field = z.object({ key: z.string(), labelEn: z.string(), labelBn: z.string(), kind: z.enum(['select', 'number', 'text', 'date']), options: z.array(z.object({ value: z.string(), labelEn: z.string(), labelBn: z.string() })), unit: z.string().nullable(), min: z.number().nullable(), max: z.number().nullable(), required: z.boolean(), isVariantAxis: z.boolean() }).meta({ id: 'ItemField' });
const ProductPage = z
  .object({
    id,
    slug: z.string(),
    title: z.string(),
    brand: z.string().nullable(),
    description: z.string().nullable(),
    photos: z.array(z.object({ id, url: z.string() })),
    priceFromPoisha: z.number().int(),
    priceToPoisha: z.number().int(),
    isMto: z.boolean(),
    mtoDays: z.number().int().nullable(),
    maxQtyPerOrder: z.number().int(),
    itemType: Named.nullable(),
    category: Named.extend({ isSupplement: z.boolean() }).nullable(),
    axes: z.array(Field),
    variants: z.array(z.object({ id, attributes: z.record(z.string(), z.string()), labelEn: z.string(), labelBn: z.string(), pricePoisha: z.number().int(), stock: z.object({ code: z.string(), available: z.number().int().nullable(), days: z.number().int().nullable() }), purchasable: z.boolean(), expiryDate: z.string().nullable() })),
    specs: z.array(z.object({ key: z.string(), labelEn: z.string(), labelBn: z.string(), valueEn: z.string(), valueBn: z.string() })),
    supplement: z.object({ importer: z.string().nullable(), bstiRegNo: z.string().nullable() }).nullable(),
    shop: z.object({ name: z.string(), slug: z.string(), shopType: z.string(), area: Named.nullable(), verifiedSince: dateTime.nullable(), ratingAvg: z.number().nullable(), ratingCount: z.number().int() }),
    available: z.boolean(),
    checkoutOpen: z.boolean(),
    version: z.number().int(),
  })
  .meta({ id: 'MarketProductPage' });
const ShopPage = z
  .object({ id, name: z.string(), slug: z.string(), shopType: z.string(), about: z.string().nullable(), area: Named.nullable(), addressLine: z.string(), verifiedSince: dateTime.nullable(), ratingAvg: z.number().nullable(), ratingCount: z.number().int(), items: z.array(Card), total: z.number().int(), nextCursor: z.string().nullable() })
  .meta({ id: 'MarketShopPage' });
const Categories = z
  .object({
    items: z.array(
      Named.extend({
        sportKey: z.string().nullable(),
        shopTypes: z.array(z.string()),
        isSupplement: z.boolean(),
        icon: z.string().nullable(),
        types: z.array(Named.extend({ priceFloorPoisha: z.number().int(), priceCeilingPoisha: z.number().int(), placeholderEn: z.string().nullable(), placeholderBn: z.string().nullable(), fields: z.array(Field) })),
      })
    ),
  })
  .meta({ id: 'MarketCategories' });
const SavedResult = z.object({ saved: z.boolean(), itemType: z.string(), itemId: id, savedAt: dateTime.nullable().optional(), removed: z.boolean().optional() }).meta({ id: 'SavedResult' });
const SavedList = z
  .object({ items: z.array(z.object({ itemType: z.string(), itemId: id, savedAt: dateTime.nullable(), priceAtSavePoisha: z.number().int(), item: Card.nullable(), badges: z.array(z.enum(['unavailable', 'out_of_stock', 'price_dropped'])) })), max: z.number().int() })
  .meta({ id: 'SavedList' });
const StaffShopList = z.object({ items: z.array(ShopOwner.extend({ owner: z.object({ id, displayName: z.string().nullable() }) })) }).meta({ id: 'StaffShopList' });
const StaffProductList = z.object({ items: z.array(z.object({}).loose()) }).meta({ id: 'StaffProductList' });
const StatusResult = z.object({ id, status: z.string() }).meta({ id: 'MarketStatusResult' });

module.exports = {
  idParam,
  photoParams,
  slugParam,
  createShop,
  updateShop,
  stockRules,
  createProduct,
  updateProduct,
  createVariant,
  updateVariant,
  photoOrder,
  adjustBody,
  ownerListQuery,
  inventoryQuery,
  cursorQuery,
  reasonBody,
  staffShopsQuery,
  staffProductsQuery,
  listQuery,
  shopPageQuery,
  savedParams,
  ShopOwner,
  ProductOwner,
  ProductOwnerList,
  Photo,
  StockResult,
  MovementList,
  InventoryOverview,
  ItemList,
  ProductPage,
  ShopPage,
  Categories,
  SavedResult,
  SavedList,
  StaffShopList,
  StaffProductList,
  StatusResult,
};
