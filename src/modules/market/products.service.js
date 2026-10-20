'use strict';

/**
 * M12 products and variants (§5.1, FR-02 to FR-06; v3 supplements). A shop owner drafts a product of
 * an M03 item type: specs checked against the type's fields (FR-05), at least one variant whose
 * attributes are the type's axis fields (FR-04; "Standard" {} when the type has none), photos, a
 * base price inside the type's range and optional per-variant prices. Products are pre-moderated
 * (M05 kind `product`), only once the shop is approved:
 *
 *   draft ─submit─▶ pending_review ─approved─▶ live ⇄ paused      (visibility visible ⇄ hidden_oos)
 *                                  ─changes──▶ changes_requested ─submit─▶ pending_review
 *                                  ─rejected─▶ rejected
 *   live/paused ─staff─▶ suspended ─master─▶ live;  owner or master ─▶ removed
 *
 * The public version (live_snapshot, with its prices) stays visible while an edit is reviewed
 * (FR-02). Title, item type, brand, specs, photos and supplement details need review; so does a price
 * change larger than market.product_reprice_moderation_pct. Smaller price changes, the description,
 * made-to-order and the per-order limit apply at once; so do new and retired variants. Stock never
 * needs review (inventory.service).
 *
 * Supplements (v3): the product needs the importer or a BSTI registration number, and every variant an
 * expiry date and batch number; a variant too close to expiry is blocked from sale.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, Shop, Product, ProductVariant, ProductPhoto } = require('../../models');
const audit = require('../audit').audit;
const events = require('../events').events;
const settings = require('../settings').settings;
const moderation = require('../moderation').moderation;
const authz = require('../auth').authz;
const directory = require('../users').directory;
const rules = require('./market.rules');
const c = require('./market.common');
const inventory = require('./inventory.service');

const { fail } = c;
const inReview = (p) => p.status === 'pending_review' || p.editStatus === 'pending_review';

function assertEditable(p) {
  if (inReview(p)) throw fail('PRODUCT_IN_REVIEW');
  if (!rules.isEditable(p.status, p.editStatus)) throw fail('PRODUCT_STATE');
}

const markEdited = (p) => {
  p.editStatus = rules.editStatusAfterChange(p.status, p.editStatus);
};

function checkPrice(price, type, field = 'basePricePoisha') {
  const range = { floor: type.priceFloorPoisha, ceiling: type.priceCeilingPoisha };
  if (!rules.priceInRange(price, range)) throw fail('PRICE_OUT_OF_RANGE', { errors: [{ field, message: `Between ${range.floor} and ${range.ceiling} poisha` }], meta: range });
}

function checkMto(isMto, mtoDays) {
  if (isMto && !(Number.isInteger(mtoDays) && mtoDays >= 1 && mtoDays <= c.limits().mtoDaysMax)) throw fail('MTO_DAYS_INVALID');
}

function checkQty(q) {
  if (!(Number.isInteger(q) && q >= 1 && q <= c.limits().qtyMax)) throw fail('QTY_LIMIT_INVALID');
}

/** The item type (with category and fields) for this shop, and the specs checked against it. */
async function contentFor(shop, itemTypeId, specs, { transaction }) {
  const t = await c.itemTypeWithFields(itemTypeId, { transaction });
  c.assertTypeForShop(shop, t.category);
  const errors = rules.specsBlock(t.fields, specs ?? {});
  if (errors) throw fail('SPECS_INVALID', { errors });
  return t;
}

async function uniqueSlug(title, transaction) {
  const base = rules.slugify(title, 'item');
  for (let i = 1; ; i += 1) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!(await Product.findOne({ where: { slug }, attributes: ['id'], transaction }))) return slug;
  }
}

const productPayload = (p, shop, extra = {}) => ({ productId: p.id, shopId: shop.id, ownerId: shop.ownerId, ...extra });
const publish = (transaction, name, p, shop, extra) => events.publish(transaction, { name, aggregateType: 'product', aggregateId: p.id, payload: productPayload(p, shop, extra) });

async function view(productId, shop, { transaction } = {}) {
  return c.ownerView(await c.loadWorking(productId, { transaction }), shop);
}

/** The public version and its search columns, with a price-drop event for savers (FR-33). */
async function setPublic(p, shop, snapshot, { transaction }) {
  const oldFrom = p.publicPriceFromPoisha;
  p.liveSnapshot = snapshot;
  Object.assign(p, c.publicColumns(snapshot));
  if (oldFrom !== null && oldFrom !== undefined && p.publicPriceFromPoisha < oldFrom) await publish(transaction, 'product.price_lowered', p, shop, { fromPoisha: oldFrom, toPoisha: p.publicPriceFromPoisha });
}

/**
 * Prices of a published product after a change: within the review threshold they reach the public
 * version now; a larger move marks an edit and the public keeps the old prices until it is approved.
 */
async function applyPrices(p, shop, { transaction }) {
  if (!rules.isPublished(p.status)) return 'draft';
  const snap = p.liveSnapshot;
  const variants = await ProductVariant.findAll({ where: { productId: p.id, status: 'active' }, transaction });
  const working = new Map(variants.map((v) => [v.id, rules.variantPrice(p.basePricePoisha, v.priceOverridePoisha)]));
  const pct = c.limits().repricePct;
  const review = snap.variants.some((sv) => working.has(sv.id) && rules.repriceNeedsReview(sv.pricePoisha, working.get(sv.id), pct)) || rules.repriceNeedsReview(snap.basePricePoisha, p.basePricePoisha, pct);
  if (review) {
    markEdited(p);
    return 'review';
  }
  await setPublic(p, shop, { ...snap, basePricePoisha: p.basePricePoisha, variants: snap.variants.map((sv) => (working.has(sv.id) ? { ...sv, pricePoisha: working.get(sv.id) } : sv)) }, { transaction });
  return 'live';
}

// ---------------------------------------------------------------- variants (FR-04)

function uniqueVariantError(err) {
  if (err.name !== 'SequelizeUniqueConstraintError') return err;
  return String(err.parent?.constraint ?? '').includes('sku') ? fail('SKU_TAKEN') : fail('VARIANT_DUPLICATE');
}

/** Add one variant to a locked product, with its opening stock; on a published product it is public at once. */
async function addVariantInTx({ product: p, shop, t }, body, actor, { transaction }) {
  const attributes = body.attributes ?? {};
  const errors = rules.attributesBlock(t.fields, attributes);
  if (errors) throw fail('ATTRIBUTES_INVALID', { errors });
  const siblings = await ProductVariant.findAll({ where: { productId: p.id, status: 'active' }, transaction });
  if (siblings.length && !rules.sameAxes(siblings[0].attributes, attributes)) throw fail('AXES_MISMATCH');
  if (body.priceOverridePoisha !== undefined && body.priceOverridePoisha !== null) checkPrice(body.priceOverridePoisha, t.type, 'priceOverridePoisha');
  const supplement = t.category.isSupplement;
  if (supplement && (!body.expiryDate || !body.batchNo)) throw fail('EXPIRY_REQUIRED');
  if (p.isMto && body.openingStock) throw fail('MTO_NO_STOCK');
  const today = rules.dhakaDate(new Date());
  let v;
  try {
    v = await ProductVariant.create(
      {
        productId: p.id,
        shopId: shop.id,
        sku: body.sku ?? null,
        attributes,
        priceOverridePoisha: body.priceOverridePoisha ?? null,
        expiryDate: supplement ? body.expiryDate : null,
        batchNo: supplement ? body.batchNo : null,
        saleBlocked: supplement ? rules.shelfBlocked({ expiryDate: body.expiryDate, today, minShelfDays: c.limits().minShelfDays }) : false,
        sort: body.sort ?? siblings.length,
        createdBy: actor?.id ?? null,
        updatedBy: actor?.id ?? null,
      },
      { transaction }
    );
  } catch (err) {
    throw uniqueVariantError(err);
  }
  await inventory.openingStock({ product: p, shop, variant: v }, body.openingStock ?? 0, actor, { transaction });
  if (rules.isPublished(p.status)) {
    await setPublic(p, shop, { ...p.liveSnapshot, variants: [...p.liveSnapshot.variants, c.variantShape(p, v)] }, { transaction });
    await p.save({ transaction });
    await inventory.refreshVisibility(p, shop, { transaction });
  }
  return v;
}

/** POST /shop/products/:id/variants */
async function addVariant(principal, productId, body, req) {
  return sequelize.transaction(async (transaction) => {
    const { product: p, shop } = await c.ownedProduct(principal, productId, { transaction, lock: true });
    assertEditable(p);
    const t = await c.itemTypeWithFields(p.itemTypeId, { transaction });
    const v = await addVariantInTx({ product: p, shop, t }, body, principal, { transaction });
    await audit.record({ action: 'product_variant.added', actor: principal, entityType: 'product', entityId: p.id, after: { variantId: v.id, attributes: v.attributes, openingStock: body.openingStock ?? 0 }, req }, { transaction });
    return view(p.id, shop, { transaction });
  });
}

/** PATCH /shop/variants/:id: SKU, price, expiry and batch (attributes are fixed: a new size is a new variant). */
async function updateVariant(principal, variantId, patch, req) {
  return sequelize.transaction(async (transaction) => {
    const { product: p, shop, variant: v } = await c.ownedVariant(principal, variantId, { transaction });
    if (v.status !== 'active') throw fail('VARIANT_STATE');
    assertEditable(p);
    const t = await c.itemTypeWithFields(p.itemTypeId, { transaction });
    if (patch.priceOverridePoisha !== undefined && patch.priceOverridePoisha !== null) checkPrice(patch.priceOverridePoisha, t.type, 'priceOverridePoisha');
    const supplement = t.category.isSupplement;
    if (supplement && (patch.expiryDate === null || patch.batchNo === null)) throw fail('EXPIRY_REQUIRED');
    const changes = { ...patch };
    if (!supplement) {
      delete changes.expiryDate;
      delete changes.batchNo;
    }
    const before = Object.fromEntries(Object.keys(changes).map((k) => [k, v[k] ?? null]));
    try {
      await v.update({ ...changes, updatedBy: principal.id }, { transaction });
    } catch (err) {
      throw uniqueVariantError(err);
    }
    if ('expiryDate' in changes) await inventory.applyShelfLife(p, shop, v, { today: rules.dhakaDate(new Date()), minShelfDays: c.limits().minShelfDays, transaction });
    if (rules.isPublished(p.status)) {
      const meta = { sku: v.sku ?? null, expiryDate: v.expiryDate ?? null, batchNo: v.batchNo ?? null, sort: v.sort };
      p.liveSnapshot = { ...p.liveSnapshot, variants: p.liveSnapshot.variants.map((sv) => (sv.id === v.id ? { ...sv, ...meta } : sv)) };
      if ('priceOverridePoisha' in changes) await applyPrices(p, shop, { transaction });
      await p.save({ transaction });
      await inventory.refreshVisibility(p, shop, { transaction });
    }
    await audit.record({ action: 'product_variant.updated', actor: principal, entityType: 'product', entityId: p.id, before, after: changes, meta: { variantId: v.id }, req }, { transaction });
    return view(p.id, shop, { transaction });
  });
}

/** POST /shop/variants/:id/retire: blocked while units are held for orders; a product keeps one variant. */
async function retireVariant(principal, variantId, req) {
  return sequelize.transaction(async (transaction) => {
    const { product: p, shop, variant: v } = await c.ownedVariant(principal, variantId, { transaction });
    if (v.status !== 'active') throw fail('VARIANT_STATE');
    assertEditable(p);
    if (v.held > 0) throw fail('VARIANT_HAS_HELD');
    if ((await ProductVariant.count({ where: { productId: p.id, status: 'active' }, transaction })) <= 1) throw fail('LAST_VARIANT');
    await v.update({ status: 'retired', retiredAt: new Date(), updatedBy: principal.id }, { transaction });
    if (rules.isPublished(p.status)) {
      await setPublic(p, shop, { ...p.liveSnapshot, variants: p.liveSnapshot.variants.filter((sv) => sv.id !== v.id) }, { transaction });
      await p.save({ transaction });
      await inventory.refreshVisibility(p, shop, { transaction });
    }
    await audit.record({ action: 'product_variant.retired', actor: principal, entityType: 'product', entityId: p.id, meta: { variantId: v.id, onHand: v.onHand }, req }, { transaction });
    return view(p.id, shop, { transaction });
  });
}

// ---------------------------------------------------------------- products (FR-01 to FR-06)

/** POST /shop/products: a draft with its variants (or one "Standard" variant when the type has no required axis). */
async function create(principal, body, req) {
  return sequelize.transaction(async (transaction) => {
    const shop = await c.myShop(principal, { transaction });
    if (['suspended', 'rejected'].includes(shop.status)) throw fail('SHOP_STATE');
    const t = await contentFor(shop, body.itemTypeId, body.specs, { transaction });
    checkPrice(body.basePricePoisha, t.type);
    const isMto = body.isMto ?? false;
    const mtoDays = isMto ? body.mtoDays ?? shop.mtoDaysDefault : null;
    checkMto(isMto, mtoDays);
    const maxQtyPerOrder = body.maxQtyPerOrder ?? settings.get('market.max_qty_per_order_default');
    checkQty(maxQtyPerOrder);
    const supplement = t.category.isSupplement;
    const p = await Product.create(
      {
        shopId: shop.id,
        itemTypeId: t.type.id,
        title: body.title,
        slug: await uniqueSlug(body.title, transaction),
        brand: body.brand ?? null,
        description: body.description ?? null,
        specs: body.specs ?? {},
        basePricePoisha: body.basePricePoisha,
        isMto,
        mtoDays,
        maxQtyPerOrder,
        importer: supplement ? body.importer ?? null : null,
        bstiRegNo: supplement ? body.bstiRegNo ?? null : null,
        status: 'draft',
        statusChangedAt: new Date(),
        createdBy: principal.id,
        updatedBy: principal.id,
      },
      { transaction }
    );
    const requiredAxis = t.fields.some((f) => f.isVariantAxis && f.required);
    const variants = body.variants?.length ? body.variants : requiredAxis || supplement ? [] : [{ attributes: {} }];
    for (const v of variants) await addVariantInTx({ product: p, shop, t }, v, principal, { transaction });
    await audit.record({ action: 'product.created', actor: principal, entityType: 'product', entityId: p.id, after: { title: p.title, itemTypeId: p.itemTypeId, variants: variants.length }, req }, { transaction });
    return view(p.id, shop, { transaction });
  });
}

/** GET /shop/products?status= */
async function listMine(principal, { status } = {}) {
  const shop = await c.myShop(principal);
  const products = await Product.findAll({ where: { shopId: shop.id, status: status ?? { [Op.ne]: 'removed' } }, order: [['updatedAt', 'DESC']] });
  const ids = products.map((p) => p.id);
  const [photos, variants] = ids.length
    ? await Promise.all([ProductPhoto.findAll({ where: { ownerType: 'product', ownerId: ids, status: 'active' }, order: [['sort', 'ASC']] }), ProductVariant.findAll({ where: { productId: ids, status: 'active' } })])
    : [[], []];
  const names = await c.typeNames(products.map((p) => p.itemTypeId));
  return {
    items: products.map((p) => {
      const cover = photos.find((x) => x.ownerId === p.id);
      const mine = variants.filter((v) => v.productId === p.id);
      return {
        id: p.id,
        slug: p.slug,
        title: p.title,
        itemType: names.get(p.itemTypeId) ?? null,
        status: p.status,
        editStatus: p.editStatus ?? null,
        visibility: p.visibility,
        coverUrl: cover ? c.photoView(cover).url : null,
        basePricePoisha: p.basePricePoisha,
        isMto: p.isMto,
        variants: mine.length,
        onHand: mine.reduce((n, v) => n + v.onHand, 0),
        available: mine.reduce((n, v) => n + v.onHand - v.held, 0),
        reviewReason: p.reviewReasonCode ? { code: p.reviewReasonCode, text: p.reviewReasonText ?? null } : null,
        updatedAt: c.iso(p.updatedAt),
      };
    }),
  };
}

async function getMine(principal, productId) {
  const { product, shop } = await c.ownedProduct(principal, productId);
  return view(product.id, shop);
}

/** PATCH /shop/products/:id (FR-02): review fields start an edit of a live product; the rest apply at once. */
async function update(principal, productId, patch, req) {
  return sequelize.transaction(async (transaction) => {
    const { product: p, shop } = await c.ownedProduct(principal, productId, { transaction, lock: true });
    assertEditable(p);
    const typeChanged = patch.itemTypeId !== undefined && patch.itemTypeId !== p.itemTypeId;
    const t = await contentFor(shop, patch.itemTypeId ?? p.itemTypeId, 'specs' in patch ? patch.specs : p.specs, { transaction });
    const variants = await ProductVariant.findAll({ where: { productId: p.id, status: 'active' }, transaction });
    if (typeChanged) {
      const bad = variants.map((v) => rules.attributesBlock(t.fields, v.attributes)).find(Boolean);
      if (bad) throw fail('ATTRIBUTES_INVALID', { errors: bad });
    }
    if (patch.basePricePoisha !== undefined) checkPrice(patch.basePricePoisha, t.type);
    const isMto = patch.isMto ?? p.isMto;
    const mtoDays = isMto ? patch.mtoDays ?? p.mtoDays ?? shop.mtoDaysDefault : null;
    checkMto(isMto, mtoDays);
    if (isMto !== p.isMto && variants.some((v) => v.held > 0)) throw fail('VARIANT_HAS_HELD');
    if (patch.maxQtyPerOrder !== undefined) checkQty(patch.maxQtyPerOrder);
    const changes = { ...patch, isMto, mtoDays };
    if (!t.category.isSupplement) Object.assign(changes, { importer: null, bstiRegNo: null });
    const reviewChanged = rules.changedFields(p, changes, rules.PRODUCT_REVIEW_FIELDS);
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, p[k] ?? null]));
    for (const [k, v] of Object.entries(changes)) p[k] = v;
    if (rules.isPublished(p.status)) {
      const live = Object.fromEntries(rules.PRODUCT_LIVE_FIELDS.map((k) => [k, p[k] ?? null]));
      p.liveSnapshot = { ...p.liveSnapshot, ...live };
      if (reviewChanged.length) markEdited(p);
      if (patch.basePricePoisha !== undefined) await applyPrices(p, shop, { transaction });
    }
    p.updatedBy = principal.id;
    await p.save({ transaction });
    await inventory.refreshVisibility(p, shop, { transaction });
    await audit.record({ action: 'product.updated', actor: principal, entityType: 'product', entityId: p.id, before, after: patch, meta: { needsReview: reviewChanged }, req }, { transaction });
    return view(p.id, shop, { transaction });
  });
}

/** What a product must have before review (the owner sees these; the reviewer sees the checks). */
function completeness(w, t, shop) {
  const problems = [];
  const { minPhotos, mtoDaysMax } = c.limits();
  const p = w.product;
  if (w.photos.length < minPhotos) problems.push({ field: 'photos', message: `Add at least ${minPhotos} photos` });
  if (!w.variants.length) problems.push({ field: 'variants', message: 'Add at least one variant' });
  const specErrors = rules.specsBlock(t.fields, p.specs);
  if (specErrors) problems.push(...specErrors);
  for (const v of w.variants) {
    const errs = rules.attributesBlock(t.fields, v.attributes);
    if (errs) problems.push(...errs.map((e) => ({ field: `variants.${v.id}.${e.field}`, message: e.message })));
    const price = rules.variantPrice(p.basePricePoisha, v.priceOverridePoisha);
    if (!rules.priceInRange(price, { floor: t.type.priceFloorPoisha, ceiling: t.type.priceCeilingPoisha })) problems.push({ field: `variants.${v.id}.price`, message: 'The price is outside the range for this item type' });
    if (t.category.isSupplement && (!v.expiryDate || !v.batchNo)) problems.push({ field: `variants.${v.id}.expiryDate`, message: 'Add the expiry date and batch number' });
  }
  if (!rules.priceInRange(p.basePricePoisha, { floor: t.type.priceFloorPoisha, ceiling: t.type.priceCeilingPoisha })) problems.push({ field: 'basePricePoisha', message: 'The price is outside the range for this item type' });
  if (t.category.isSupplement && !p.importer && !p.bstiRegNo) problems.push({ field: 'importer', message: 'Add the importer or the BSTI registration number' });
  if (p.isMto && !(p.mtoDays >= 1 && p.mtoDays <= mtoDaysMax)) problems.push({ field: 'mtoDays', message: `Between 1 and ${mtoDaysMax} days` });
  c.assertTypeForShop(shop, t.category);
  return problems;
}

/** POST /shop/products/:id/submit (FR-02, FR-03): a first review, or an edit of a published product. */
async function submit(principal, productId, req) {
  return sequelize.transaction(async (transaction) => {
    const { product: p, shop } = await c.ownedProduct(principal, productId, { transaction, lock: true });
    if (!['live', 'paused'].includes(shop.status)) throw fail('SHOP_NOT_LIVE');
    const w = await c.loadWorking(p.id, { transaction });
    const t = await c.itemTypeWithFields(p.itemTypeId, { transaction });
    const problems = completeness(w, t, shop);
    if (problems.length) throw fail('PRODUCT_INCOMPLETE', { errors: problems });
    const published = rules.isPublished(p.status);
    let diff;
    if (published) {
      if (!['draft', 'changes_requested', 'rejected'].includes(p.editStatus)) throw fail('NOTHING_TO_REVIEW');
      diff = rules.productDiff(p.liveSnapshot, c.workingShape(w));
      if (rules.diffIsEmpty(diff)) throw fail('NOTHING_TO_REVIEW');
    } else {
      if (!rules.next('submit', p.status)) throw inReview(p) ? fail('PRODUCT_IN_REVIEW') : fail('PRODUCT_STATE');
      diff = rules.productDiff(null, c.workingShape(w));
    }
    const version = p.liveVersion + 1;
    const sub = await moderation.submit(
      {
        kind: 'product',
        subjectId: p.id,
        payload: { productId: p.id, shopId: shop.id, version, isEdit: published, diff, itemTypeId: p.itemTypeId, basePricePoisha: p.basePricePoisha, variants: w.variants.length, photos: w.photos.length, supplement: t.category.isSupplement },
        title: `${p.title} · v${version}${published ? ' (edit)' : ''}`,
        submittedBy: principal.id,
        isEdit: published,
      },
      { transaction }
    );
    await p.update(
      { ...(published ? { editStatus: 'pending_review' } : { status: 'pending_review', statusChangedAt: new Date() }), currentSubmissionId: sub.id, reviewReasonCode: null, reviewReasonText: null, updatedBy: principal.id },
      { transaction }
    );
    await audit.record({ action: 'product.submitted', actor: principal, entityType: 'product', entityId: p.id, after: { status: p.status, editStatus: p.editStatus ?? null }, meta: { submissionId: sub.id, version, isEdit: published }, req }, { transaction });
    await publish(transaction, 'product.submitted', p, shop, { version, isEdit: published });
    return view(p.id, shop, { transaction });
  });
}

/** POST /shop/products/:id/withdraw */
async function withdraw(principal, productId, req) {
  return sequelize.transaction(async (transaction) => {
    const { product: p, shop } = await c.ownedProduct(principal, productId, { transaction, lock: true });
    if (!inReview(p)) throw fail('PRODUCT_STATE');
    const isEdit = p.editStatus === 'pending_review';
    await p.update({ ...(isEdit ? { editStatus: 'draft' } : { status: 'withdrawn', statusChangedAt: new Date() }), currentSubmissionId: null, updatedBy: principal.id }, { transaction });
    await moderation.withdrawSubject('product', p.id, { transaction });
    await audit.record({ action: 'product.withdrawn', actor: principal, entityType: 'product', entityId: p.id, meta: { isEdit }, req }, { transaction });
    if (!isEdit) await publish(transaction, 'product.withdrawn', p, shop);
    return view(p.id, shop, { transaction });
  });
}

async function move(actor, productId, action, { transaction, req, reason = null, eventName, extra = {} }) {
  const p = await Product.findByPk(productId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!p || p.status === 'removed') throw E.notFound('Product');
  const to = rules.next(action, p.status);
  if (!to) throw fail('PRODUCT_STATE');
  if (action === 'remove' && (await ProductVariant.count({ where: { productId: p.id, held: { [Op.gt]: 0 } }, transaction })) > 0) throw fail('VARIANT_HAS_HELD');
  const shop = await Shop.findByPk(p.shopId, { transaction });
  const from = p.status;
  await p.update({ status: to, statusChangedAt: new Date(), updatedBy: actor?.id ?? null }, { transaction });
  await audit.record({ action: eventName, actor, entityType: 'product', entityId: p.id, before: { status: from }, after: { status: to }, reason, req }, { transaction });
  await publish(transaction, eventName, p, shop, extra);
  return { p, shop };
}

/** POST /shop/products/:id/pause, /resume and /remove (the owner; removal needs no units held for orders). */
async function ownerMove(principal, productId, action, req) {
  const names = { pause: 'product.paused', resume: 'product.resumed', remove: 'product.removed' };
  return sequelize.transaction(async (transaction) => {
    await c.ownedProduct(principal, productId, { transaction });
    const { p, shop } = await move(principal, productId, action, { transaction, req, eventName: names[action], extra: action === 'resume' ? {} : { reason: 'owner' } });
    if (action === 'remove') await moderation.withdrawSubject('product', p.id, { transaction });
    return action === 'remove' ? { id: p.id, status: p.status } : view(p.id, shop, { transaction });
  });
}

// ---------------------------------------------------------------- staff and masters

/** GET /admin/market/products */
async function staffList({ status, q, shopId, limit = 50 } = {}) {
  const where = { ...(status ? { status } : { status: { [Op.ne]: 'removed' } }), ...(shopId ? { shopId } : {}) };
  if (q) where[Op.or] = [{ title: { [Op.iLike]: `%${q}%` } }, { slug: { [Op.iLike]: `%${q}%` } }];
  const products = await Product.findAll({ where, order: [['updatedAt', 'DESC']], limit });
  const shops = products.length ? await Shop.findAll({ where: { id: [...new Set(products.map((p) => p.shopId))] } }) : [];
  const names = await c.typeNames(products.map((p) => p.itemTypeId));
  return {
    items: products.map((p) => {
      const s = shops.find((x) => x.id === p.shopId);
      return { id: p.id, slug: p.slug, title: p.title, status: p.status, editStatus: p.editStatus ?? null, visibility: p.visibility, itemType: names.get(p.itemTypeId) ?? null, basePricePoisha: p.basePricePoisha, liveVersion: p.liveVersion, shop: { id: s.id, name: s.name, slug: s.slug, status: s.status }, updatedAt: c.iso(p.updatedAt) };
    }),
  };
}

/** GET /admin/market/products/:id: the working copy and the public version, for reviewers and ops. */
async function staffGet(productId) {
  const w = await c.loadWorking(productId);
  if (!w) throw E.notFound('Product');
  const shop = await Shop.findByPk(w.product.shopId);
  const owner = (await directory.publicNames([shop.ownerId])).get(shop.ownerId);
  return { ...c.ownerView(w, shop), shop: { id: shop.id, name: shop.name, slug: shop.slug, status: shop.status, owner: { id: shop.ownerId, displayName: owner?.displayName ?? null } }, publicVersion: w.product.liveSnapshot ?? null };
}

/** Suspend, restore or remove a product inside the caller's transaction (also M17 report actions). */
async function staffActionInTx(actor, productId, action, { reason, transaction, req = null }) {
  const names = { suspend: 'product.suspended', restore: 'product.restored', remove: 'product.removed' };
  const { p } = await move(actor, productId, action, { transaction, req, reason, eventName: names[action], extra: action === 'restore' ? {} : { reason } });
  if (action !== 'restore') await moderation.withdrawSubject('product', p.id, { transaction });
  return { id: p.id, status: p.status };
}

const staffAction = (actor, productId, action, { reason }, req) => sequelize.transaction((transaction) => staffActionInTx(actor, productId, action, { reason, transaction, req }));

// ---------------------------------------------------------------- M05 decisions (consumer, idempotent)

const DECIDED_EVENT = { changes_requested: 'product.changes_requested', rejected: 'product.rejected' };

async function applyDecision(submissionId, status, { transaction }) {
  const sub = await moderation.getById(submissionId, { transaction });
  if (!sub) return null;
  const ack = () =>
    events.publish(transaction, { name: 'submission.applied', aggregateType: 'submission', aggregateId: sub.id, payload: { submissionId: sub.id, kind: sub.kind, subjectId: sub.subjectId, version: sub.version, submittedBy: sub.submittedBy } });
  const p = await Product.findByPk(sub.payload.productId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!p || p.currentSubmissionId !== sub.id) {
    if (status === 'approved') await ack();
    return null;
  }
  const shop = await Shop.findByPk(p.shopId, { transaction });
  const isEdit = Boolean(sub.payload.isEdit);
  const now = new Date();
  if (status === 'withdrawn') {
    await p.update({ ...(isEdit ? { editStatus: 'draft' } : { status: 'withdrawn', statusChangedAt: now }), currentSubmissionId: null }, { transaction });
    return 'withdrawn';
  }
  if (status !== 'approved') {
    await p.update(
      { ...(isEdit ? { editStatus: status } : { status, statusChangedAt: now }), currentSubmissionId: null, reviewReasonCode: sub.reasonCode ?? null, reviewReasonText: sub.reasonText ?? null },
      { transaction }
    );
    await audit.record({ action: DECIDED_EVENT[status], actor: null, entityType: 'product', entityId: p.id, after: { status: p.status, editStatus: p.editStatus ?? null, reasonCode: sub.reasonCode ?? null }, meta: { submissionId: sub.id, decidedBy: sub.decidedBy } }, { transaction });
    await publish(transaction, DECIDED_EVENT[status], p, shop, { isEdit, reasonCode: sub.reasonCode ?? null });
    return status;
  }
  // Approved: the working copy becomes the public version (with its prices).
  const w = await c.loadWorking(p.id, { transaction });
  const first = !rules.isPublished(p.status);
  const version = p.liveVersion + 1;
  if (first) {
    p.status = 'live';
    p.firstLiveAt = now;
    p.statusChangedAt = now;
  }
  Object.assign(p, { editStatus: null, liveVersion: version, currentSubmissionId: null, reviewReasonCode: null, reviewReasonText: null });
  await setPublic(p, shop, c.snapshotOf(w, version), { transaction });
  await p.save({ transaction });
  await inventory.refreshVisibility(p, shop, { transaction });
  await audit.record({ action: 'product.published', actor: null, entityType: 'product', entityId: p.id, after: { status: p.status, version }, meta: { submissionId: sub.id, decidedBy: sub.decidedBy, first } }, { transaction });
  await publish(transaction, 'product.published', p, shop, { version, first });
  await ack();
  return 'approved';
}

// ---------------------------------------------------------------- M05 automatic checks (FR-03)

async function checksFor(productId, { transaction }) {
  const w = await c.loadWorking(productId, { transaction });
  if (!w) return [];
  const p = w.product;
  const shop = await Shop.findByPk(p.shopId, { transaction });
  const ok = (key, pass, severity, detail = null) => ({ key, severity, result: pass ? 'pass' : 'fail', detail: pass ? null : detail });
  const owner = await authz.loadPrincipal(shop.ownerId);
  const t = await c.itemTypeWithFields(p.itemTypeId, { transaction }).catch(() => null);
  const minPhotos = c.limits().minPhotos;
  const range = t ? { floor: t.type.priceFloorPoisha, ceiling: t.type.priceCeilingPoisha } : null;
  const prices = w.variants.map((v) => rules.variantPrice(p.basePricePoisha, v.priceOverridePoisha));
  const specErrors = t ? rules.specsBlock(t.fields, p.specs) : [{ message: 'The item type is no longer active' }];
  const variantErrors = t ? w.variants.map((v) => rules.attributesBlock(t.fields, v.attributes)).filter(Boolean) : [];
  const supplement = Boolean(t?.category.isSupplement);
  const supplementOk = !supplement || ((p.importer || p.bstiRegNo) && w.variants.every((v) => v.expiryDate && v.batchNo && !v.saleBlocked));
  return [
    ok('owner_kyc_approved', owner?.roles?.shop_owner === 'active', 'hard', 'The shop owner documents are not approved'),
    ok('shop_live', ['live', 'paused'].includes(shop.status), 'hard', 'The shop is not approved'),
    ok('new_stock', true, 'hard'),
    ok('photos_min', w.photos.length >= minPhotos, 'hard', `${w.photos.length} of ${minPhotos} photos`),
    ok('specs_valid', !specErrors && !variantErrors.length && w.variants.length > 0, 'hard', [...(specErrors ?? []), ...variantErrors.flat()].map((e) => e.message).join('; ') || 'No variants'),
    ok('supplement_details', supplementOk, 'hard', 'Importer or BSTI number, and an expiry date and batch on every variant with enough shelf life'),
    ok('price_in_range', Boolean(range) && rules.priceInRange(p.basePricePoisha, range) && prices.every((x) => rules.priceInRange(x, range)), 'soft', range ? `Outside ${range.floor}–${range.ceiling} poisha` : 'No item type'),
  ];
}

/** Display facts for notifications (M08 reads them here). */
async function facts(productId) {
  const p = await Product.findByPk(productId, { attributes: ['id', 'title', 'slug', 'shopId', 'reviewReasonCode', 'reviewReasonText'] });
  if (!p) throw E.notFound('Product');
  return { title: p.title, slug: p.slug, shopId: p.shopId, reasonCode: p.reviewReasonCode ?? null, reasonText: p.reviewReasonText ?? null };
}

/** Display facts of a variant for notifications: product title, variant label, expiry. */
async function variantFacts(variantId) {
  const v = await ProductVariant.findByPk(variantId, { attributes: ['id', 'productId', 'attributes', 'expiryDate'] });
  if (!v) throw E.notFound('Variant');
  const p = await Product.findByPk(v.productId, { attributes: ['id', 'title', 'itemTypeId'] });
  const t = await c.itemTypeWithFields(p.itemTypeId).catch(() => ({ fields: [] }));
  return { title: p.title, productId: p.id, labelEn: rules.variantLabel(t.fields, v.attributes, 'en'), labelBn: rules.variantLabel(t.fields, v.attributes, 'bn'), expiryDate: v.expiryDate ?? null };
}

module.exports = {
  variantFacts,
  create,
  listMine,
  getMine,
  update,
  addVariant,
  updateVariant,
  retireVariant,
  submit,
  withdraw,
  ownerMove,
  staffList,
  staffGet,
  staffAction,
  staffActionInTx,
  applyDecision,
  checksFor,
  facts,
  completeness,
};
