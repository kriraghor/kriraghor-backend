'use strict';

/**
 * M12 pure rules (step 1): the shop and product state machine (§8), which edits need review (FR-02),
 * spec and variant validation against the M03 item fields (FR-04, FR-05), stock arithmetic and the
 * movement ledger (FR-10 to FR-15, §6.1), the variant status (§6.3), supplement shelf life (v3),
 * public prices ("from ৳X", FR-32) and slugs. No I/O; 100% branch coverage (jest.config).
 */

// ---------------------------------------------------------------- state machine (§8; the M09 shape)

/** Owner and staff actions on a shop or product, by the statuses they may start from. */
const TRANSITIONS = {
  submit: { from: ['draft', 'changes_requested', 'withdrawn'], to: 'pending_review' },
  approve: { from: ['pending_review'], to: 'live' },
  request_changes: { from: ['pending_review'], to: 'changes_requested' },
  reject: { from: ['pending_review'], to: 'rejected' },
  withdraw: { from: ['pending_review'], to: 'withdrawn' },
  pause: { from: ['live'], to: 'paused' },
  resume: { from: ['paused'], to: 'live' },
  suspend: { from: ['live', 'paused'], to: 'suspended' },
  restore: { from: ['suspended'], to: 'live' },
  remove: { from: ['live', 'paused', 'suspended', 'rejected', 'withdrawn', 'draft', 'changes_requested'], to: 'removed' },
};
const next = (action, from) => (TRANSITIONS[action].from.includes(from) ? TRANSITIONS[action].to : null);

/** Approved at least once: edits run beside the public version (live_snapshot). */
const isPublished = (status) => ['live', 'paused', 'suspended'].includes(status);
/** The owner may change the working copy (not while staff review it, not once it is closed). */
const isEditable = (status, editStatus) => !['pending_review', 'rejected', 'removed', 'suspended'].includes(status) && editStatus !== 'pending_review';
/** A published row with a review change: the working copy becomes an unsent edit. */
const editStatusAfterChange = (status, editStatus) => (isPublished(status) && (!editStatus || editStatus === 'rejected') ? 'draft' : editStatus ?? null);

// FR-02: these product changes go to review; the others reach the public version at once.
const PRODUCT_REVIEW_FIELDS = ['title', 'itemTypeId', 'brand', 'specs', 'importer', 'bstiRegNo'];
const PRODUCT_LIVE_FIELDS = ['description', 'isMto', 'mtoDays', 'maxQtyPerOrder'];
const SHOP_REVIEW_FIELDS = ['name', 'areaId', 'addressLine'];
const SHOP_LIVE_FIELDS = ['about', 'lat', 'lng'];

const same = (a, b) => JSON.stringify(sortKeys(a ?? null)) === JSON.stringify(sortKeys(b ?? null));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/** Which of `fields` a patch changes. */
const changedFields = (current, patch, fields) => fields.filter((k) => k in patch && !same(current[k], patch[k]));

/**
 * FR-02 [PROPOSED 20%]: a price change needs review when it moves the public price by more than
 * `pct` percent (either way). A first price (no public one yet) never does.
 */
function repriceNeedsReview(publicPrice, newPrice, pct) {
  if (!publicPrice) return false;
  return (Math.abs(newPrice - publicPrice) * 100) / publicPrice > pct;
}

/** What changed between the public version and the working copy, for the reviewer. */
function productDiff(snapshot, working) {
  if (!snapshot) return { first: true, fields: [], prices: [], photos: { added: working.photos.length, removed: 0 } };
  const fields = PRODUCT_REVIEW_FIELDS.filter((k) => !same(snapshot[k], working[k])).map((k) => ({ field: k, from: snapshot[k] ?? null, to: working[k] ?? null }));
  const before = new Map(snapshot.variants.map((v) => [v.id, v.pricePoisha]));
  const prices = working.variants.filter((v) => before.has(v.id) && before.get(v.id) !== v.pricePoisha).map((v) => ({ variantId: v.id, from: before.get(v.id), to: v.pricePoisha }));
  const oldPhotos = new Set(snapshot.photos.map((p) => p.id));
  const newPhotos = new Set(working.photos.map((p) => p.id));
  return {
    first: false,
    fields,
    prices,
    photos: { added: [...newPhotos].filter((id) => !oldPhotos.has(id)).length, removed: [...oldPhotos].filter((id) => !newPhotos.has(id)).length },
  };
}

/** The shop's diff for the reviewer. */
function shopDiff(snapshot, working) {
  if (!snapshot) return { first: true, fields: [] };
  return { first: false, fields: SHOP_REVIEW_FIELDS.filter((k) => !same(snapshot[k], working[k])).map((k) => ({ field: k, from: snapshot[k] ?? null, to: working[k] ?? null })) };
}

/** Nothing for the reviewer (only non-review fields changed). */
const diffIsEmpty = (d) => !d.first && !d.fields.length && !(d.prices?.length) && !(d.photos?.added) && !(d.photos?.removed);

// ---------------------------------------------------------------- specs and variant attributes (FR-04, FR-05)

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => typeof s === 'string' && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** One value against one field; returns a message or null. */
function valueError(f, v) {
  if (f.kind === 'select') return f.options.some((o) => o.value === v) ? null : `One of ${f.options.map((o) => o.value).join(', ')}`;
  if (f.kind === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 'A number';
    if (f.minValue !== null && f.minValue !== undefined && v < f.minValue) return `At least ${f.minValue}`;
    if (f.maxValue !== null && f.maxValue !== undefined && v > f.maxValue) return `At most ${f.maxValue}`;
    return null;
  }
  if (f.kind === 'date') return validDate(v) ? null : 'A date as YYYY-MM-DD';
  return typeof v === 'string' && v.trim().length > 0 && v.length <= 200 ? null : 'Text up to 200 characters';
}

/**
 * Product specs against the item type's fields (FR-05). Specs hold the non-axis fields; axis fields
 * (size, flavour) belong on each variant. Unknown keys are refused. Returns errors or null.
 */
function specsBlock(fields, specs = {}) {
  const errors = [];
  const active = fields.filter((f) => f.isActive !== false);
  const byKey = new Map(active.map((f) => [f.key, f]));
  for (const k of Object.keys(specs)) {
    const f = byKey.get(k);
    if (!f) errors.push({ field: `specs.${k}`, message: 'Not a field of this item type' });
    else if (f.isVariantAxis) errors.push({ field: `specs.${k}`, message: 'Set this on each variant' });
  }
  for (const f of active.filter((x) => !x.isVariantAxis)) {
    const v = specs[f.key];
    if (v === undefined || v === null || v === '') {
      if (f.required) errors.push({ field: `specs.${f.key}`, message: 'Required' });
      continue;
    }
    const msg = valueError(f, v);
    if (msg) errors.push({ field: `specs.${f.key}`, message: msg });
  }
  return errors.length ? errors : null;
}

/**
 * A variant's attributes against the axis fields (FR-04): only axis keys, valid options, required
 * axes present. A type without axis fields has one "Standard" variant with {}. Returns errors or null.
 */
function attributesBlock(fields, attributes = {}) {
  const errors = [];
  const axes = fields.filter((f) => f.isActive !== false && f.isVariantAxis);
  const byKey = new Map(axes.map((f) => [f.key, f]));
  for (const [k, v] of Object.entries(attributes)) {
    const f = byKey.get(k);
    if (!f) errors.push({ field: `attributes.${k}`, message: 'Not a size or option of this item type' });
    else {
      const msg = valueError(f, v);
      if (msg) errors.push({ field: `attributes.${k}`, message: msg });
    }
  }
  for (const f of axes) if (f.required && (attributes[f.key] === undefined || attributes[f.key] === null)) errors.push({ field: `attributes.${f.key}`, message: 'Required' });
  return errors.length ? errors : null;
}

/** Every variant of a product uses the same axes (all sizes, or all sizes and colours). */
const sameAxes = (a, b) => same(Object.keys(a ?? {}).sort(), Object.keys(b ?? {}).sort());

/** "EU 43 · Black" from the attribute values and the field options. */
function variantLabel(fields, attributes, locale = 'en') {
  const parts = fields
    .filter((f) => f.isVariantAxis && attributes[f.key] !== undefined)
    .sort((a, b) => a.sort - b.sort)
    .map((f) => {
      const o = f.options.find((x) => x.value === attributes[f.key]);
      return o ? (locale === 'bn' ? o.labelBn : o.labelEn) : String(attributes[f.key]);
    });
  return parts.length ? parts.join(' · ') : locale === 'bn' ? 'স্ট্যান্ডার্ড' : 'Standard';
}

// ---------------------------------------------------------------- prices (FR-03, FR-32)

const variantPrice = (basePricePoisha, overridePoisha) => overridePoisha ?? basePricePoisha;

/** Lowest and highest price over the variants (or the base price when there are none). */
function priceRange(prices, basePricePoisha) {
  if (!prices.length) return { from: basePricePoisha, to: basePricePoisha };
  return { from: Math.min(...prices), to: Math.max(...prices) };
}

/** FR-03: a price inside the item type's range. */
const priceInRange = (price, { floor, ceiling }) => price >= floor && price <= ceiling;

// ---------------------------------------------------------------- stock (FR-10 to FR-15, §6.1)

/**
 * The next on_hand and held after a movement, or an error code:
 *   receive / return_restock  on_hand + qty
 *   hold                      held + qty, needs available ≥ qty (INSUFFICIENT_STOCK)
 *   release                   held − qty (STOCK_STATE when more than held)
 *   commit                    on_hand − qty and held − qty (shipped; STOCK_STATE when more than held)
 *   adjust                    on_hand + delta, never below held (BELOW_HELD) or 0 (FR-13)
 */
function applyMovement({ onHand, held }, type, qty) {
  const out = (o, h) => ({ onHand: o, held: h, deltaOnHand: o - onHand, deltaHeld: h - held });
  switch (type) {
    case 'receive':
    case 'return_restock':
      return out(onHand + qty, held);
    case 'hold':
      return onHand - held >= qty ? out(onHand, held + qty) : { error: 'INSUFFICIENT_STOCK' };
    case 'release':
      return held >= qty ? out(onHand, held - qty) : { error: 'STOCK_STATE' };
    case 'commit':
      return held >= qty ? out(onHand - qty, held - qty) : { error: 'STOCK_STATE' };
    case 'adjust': {
      // held ≥ 0 (CHECK), so staying at or above held also keeps on_hand ≥ 0.
      const to = onHand + qty;
      return to < held ? { error: 'BELOW_HELD' } : out(to, held);
    }
    default:
      return { error: 'STOCK_STATE' };
  }
}

/** FR-14: low stock fires once per crossing to ≤ threshold, and re-arms when available goes above it. */
function lowStockStep({ available, threshold, alerted }) {
  if (available <= threshold && available > 0 && !alerted) return 'reached';
  if (available > threshold && alerted) return 'rearmed';
  return null;
}

/** Out of stock and back (for M08, saved-item alerts, M13 cart warnings). */
function stockStep(beforeAvailable, afterAvailable) {
  if (beforeAvailable > 0 && afterAvailable <= 0) return 'depleted';
  if (beforeAvailable <= 0 && afterAvailable > 0) return 'restocked';
  return null;
}

/** A variant that can be sold now: active, not blocked by expiry, and in stock (made-to-order always). */
const saleable = (v, isMto) => v.status === 'active' && !v.saleBlocked && (isMto || v.available > 0);

/**
 * FR-15: a product is hidden from Market when auto-hide is on and no active variant can be sold
 * (blocked supplement variants count as out). Made-to-order products never hide for stock.
 */
function shouldHide({ isMto, autoHide, variants }) {
  if (isMto || !autoHide) return false;
  return !variants.some((v) => saleable(v, false));
}

/** §6.3 status of a variant row (Inventory desk and the product page), with v3 expiry blocks. */
function variantStatus({ isMto, mtoDays, available, lowThreshold, autoHide, saleBlocked }) {
  if (saleBlocked) return { code: 'blocked' };
  if (isMto) return { code: 'mto', days: mtoDays };
  if (available <= 0) return { code: autoHide ? 'out_hidden' : 'out' };
  if (available <= lowThreshold) return { code: 'low', available };
  return { code: 'in_stock', available };
}

// ---------------------------------------------------------------- supplements (v3)

const DAY_MS = 24 * 60 * 60 * 1000;
/** The calendar date in Asia/Dhaka (UTC+6, no daylight saving) as YYYY-MM-DD. */
const dhakaDate = (now) => new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
const daysUntil = (today, date) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);

/**
 * v3: a supplement variant cannot be sold once its expiry date is closer than the minimum shelf
 * life (market.supplement_min_shelf_days, 30): 29 days left is blocked, 30 is fine.
 */
const shelfBlocked = ({ expiryDate, today, minShelfDays }) => Boolean(expiryDate) && daysUntil(today, expiryDate) < minShelfDays;

// ---------------------------------------------------------------- slugs

/** URL slug: "Adidas Predator Turf Boots" → "adidas-predator-turf-boots". */
function slugify(text, fallback) {
  const base = String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || fallback;
}

module.exports = {
  TRANSITIONS,
  next,
  isPublished,
  isEditable,
  editStatusAfterChange,
  PRODUCT_REVIEW_FIELDS,
  PRODUCT_LIVE_FIELDS,
  SHOP_REVIEW_FIELDS,
  SHOP_LIVE_FIELDS,
  same,
  changedFields,
  repriceNeedsReview,
  productDiff,
  shopDiff,
  diffIsEmpty,
  validDate,
  specsBlock,
  attributesBlock,
  sameAxes,
  variantLabel,
  variantPrice,
  priceRange,
  priceInRange,
  applyMovement,
  lowStockStep,
  stockStep,
  saleable,
  shouldHide,
  variantStatus,
  dhakaDate,
  daysUntil,
  shelfBlocked,
  slugify,
};
