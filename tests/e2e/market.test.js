'use strict';

// M12 Market catalogue step 1 end to end: shop-owner onboarding with documents kept per role (M02),
// the shop and product reviews through M05 (FR-01 to FR-03), specs and variants (FR-04, FR-05),
// live edits and the 20% reprice rule (FR-02), the stock ledger and InventoryService for M13
// (FR-10 to FR-15), supplements (v3), browse, the product page and saved items (FR-30 to FR-34),
// staff actions, sanctions, reports (M17) and the M03 item catalogue.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const f = require('../fixtures/market');
const inventory = require('../../src/modules/market/inventory.service');
const { randomUUID } = require('crypto');
const { subjectIdFor } = require('../../src/modules/kyc/kyc.moderation');

const { api, P, models } = h;

let master;
let reviewer;
let docsReviewer;

beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  reviewer = await f.staffWith(master, ['approve_listings']);
  docsReviewer = await f.staffWith(master, ['approve_documents']);
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const variantBy = (product, size) => product.variants.find((v) => v.attributes.eu_size === size);
const tx = (fn) => models.sequelize.transaction(fn);

describe('M03 item catalogue (Q77)', () => {
  it('serves categories with item types, price ranges and spec fields', async () => {
    const r = await api().get(`${P}/market/categories`).expect(200);
    expect(r.body.items.map((c) => c.key)).toEqual(['cricket', 'football', 'badminton', 'gym', 'kits', 'supplements']);
    const boots = r.body.items.find((c) => c.key === 'football').types.find((t) => t.key === 'football_boots');
    expect(boots).toMatchObject({ priceFloorPoisha: 80000, priceCeilingPoisha: 4000000 });
    expect(boots.fields.find((x) => x.key === 'eu_size')).toMatchObject({ kind: 'select', isVariantAxis: true, required: true });
    expect(r.body.items.find((c) => c.key === 'supplements')).toMatchObject({ isSupplement: true, shopTypes: ['supplements'] });
  });

  it('staff with manage_catalog add item fields; keys repeat across types but not within one', async () => {
    const t = await models.ItemType.findOne({ where: { key: 'jersey' } });
    const body = { itemTypeId: t.id, key: 'fit', labelEn: 'Fit', labelBn: 'ফিট', kind: 'select', options: [{ value: 'slim', labelEn: 'Slim', labelBn: 'স্লিম' }] };
    await api().post(`${P}/admin/catalog/item-type-fields`).set(h.bearer(master)).send(body).expect(201);
    expect((await api().post(`${P}/admin/catalog/item-type-fields`).set(h.bearer(master)).send(body).expect(409)).body.code).toBe('CATALOG_KEY_TAKEN');
    const ball = await models.ItemType.findOne({ where: { key: 'football' } });
    await api().post(`${P}/admin/catalog/item-type-fields`).set(h.bearer(master)).send({ ...body, itemTypeId: ball.id }).expect(201);
    expect((await api().post(`${P}/admin/catalog/item-type-fields`).set(h.bearer(master)).send({ ...body, key: 'notes', kind: 'text', isVariantAxis: true }).expect(422)).body.errors[0].field).toBe('isVariantAxis');
  });
});

describe('shop owners and their documents (M02 per role, FR-01)', () => {
  it('activates shop_owner on its own documents; a ground owner licence does not count', async () => {
    const m = await h.signupUser({ name: 'Both Roles' });
    await h.verifyMember(m.user.id);
    await f.refresh(m);
    await api().post(`${P}/me/roles`).set(h.bearer(m)).send({ role: 'ground_owner' }).expect(201);
    await f.refresh(m);
    await api().post(`${P}/me/roles`).set(h.bearer(m)).send({ role: 'shop_owner' }).expect(201);
    await f.refresh(m);
    // Two applied roles ask for a trade licence: the member must say which one it is for.
    expect((await f.sendDoc(m, 'trade_license', { number: 'TL-1', holderName: 'Both Roles', expiresOn: f.future(200) }, { status: 422 })).body.code).toBe('ROLE_AMBIGUOUS');
    await f.sendDoc(m, 'trade_license', { number: 'TL-1', holderName: 'Both Roles', expiresOn: f.future(200) }, { role: 'ground_owner' });
    await h.drainEvents();
    await f.review(docsReviewer, 'document', subjectIdFor(m.user.id, 'trade_license', 'ground_owner'));
    await f.refresh(m);
    const shopCheck = await api().get(`${P}/me/verification?role=shop_owner`).set(h.bearer(m)).expect(200);
    expect(shopCheck.body.items.find((i) => i.key === 'trade_license').status).toBe('missing');
    expect(shopCheck.body.items.find((i) => i.key === 'bin')).toMatchObject({ required: 'optional', status: 'missing' });
    expect(shopCheck.body.unlocks.length).toBeGreaterThan(0);
    await f.sendDoc(m, 'trade_license', { number: 'TL-2', holderName: 'Both Roles Shop', expiresOn: f.future(200) }, { role: 'shop_owner' });
    await f.sendDoc(m, 'tin', { number: '123456789012' }, { role: 'shop_owner' });
    await h.drainEvents();
    for (const t of ['trade_license', 'tin']) await f.review(docsReviewer, 'document', subjectIdFor(m.user.id, t, 'shop_owner'));
    await f.refresh(m);
    expect((await models.UserRole.findOne({ where: { userId: m.user.id, role: 'shop_owner' } })).status).toBe('active');
    expect((await models.UserRole.findOne({ where: { userId: m.user.id, role: 'ground_owner' } })).status).not.toBe('active');
    const bin = await f.sendDoc(m, 'bin', { number: '000123456789', holderName: 'Both Roles Shop' });
    expect(bin.body).toMatchObject({ docType: 'bin', status: 'in_review' });
  });

  it('gates the shop desk on an active shop_owner role; one shop per owner', async () => {
    const m = await h.signupUser({ name: 'Not Yet' });
    expect((await api().get(`${P}/shop/profile`).set(h.bearer(m)).expect(403)).body.code).toBe('KYC_REQUIRED');
    const owner = await f.shopOwner(docsReviewer);
    expect((await api().get(`${P}/shop/profile`).set(h.bearer(owner)).expect(404)).body.code).toBe('NOT_FOUND');
    const body = { shopType: 'sports_gear', name: 'Elephant Road Sports', areaId: await f.areaId(), addressLine: '12 Elephant Road, Dhaka' };
    expect((await api().post(`${P}/shop/profile`).set(h.bearer(owner)).send({ ...body, shopType: 'pharmacy' }).expect(422)).body.code).toBe('VALIDATION_FAILED');
    await api().post(`${P}/shop/profile`).set(h.bearer(owner)).send(body).expect(201);
    expect((await api().post(`${P}/shop/profile`).set(h.bearer(owner)).send(body).expect(409)).body.code).toBe('SHOP_EXISTS');
  });
});

describe('shop review and edits (FR-01, M05 kind shop)', () => {
  it('a shop goes live through review; a renamed shop keeps its public name until the edit is approved', async () => {
    const owner = await f.shopOwner(docsReviewer);
    const shop = await f.liveShop(owner, reviewer);
    expect(shop).toMatchObject({ status: 'live', liveVersion: 1 });
    const sub = await models.Submission.findOne({ where: { kind: 'shop', subjectId: shop.id } });
    expect((await models.SubmissionCheck.findAll({ where: { submissionId: sub.id } })).find((c) => c.key === 'owner_kyc_approved').result).toBe('pass');
    const edited = await api().patch(`${P}/shop/profile`).set(h.bearer(owner)).send({ name: 'Elephant Road Sports House', about: 'Boots and balls since 2001' }).expect(200);
    expect(edited.body).toMatchObject({ editStatus: 'draft' });
    expect((await models.Shop.findByPk(shop.id)).liveSnapshot).toMatchObject({ name: 'Elephant Road Sports', about: 'Boots and balls since 2001' });
    expect((await api().patch(`${P}/shop/profile`).set(h.bearer(owner)).send({ shopType: 'gym_gear' }).expect(409)).body.code).toBe('SHOP_STATE');
    await api().post(`${P}/shop/profile/submit`).set(h.bearer(owner)).expect(200);
    await f.review(reviewer, 'shop', shop.id);
    expect((await models.Shop.findByPk(shop.id)).liveSnapshot).toMatchObject({ name: 'Elephant Road Sports House', version: 2 });
    expect((await api().post(`${P}/shop/profile/submit`).set(h.bearer(owner)).expect(409)).body.code).toBe('NOTHING_TO_REVIEW');
  });

  it('a suspended shop_owner role or account pauses the shop', async () => {
    const owner = await f.shopOwner(docsReviewer);
    const shop = await f.liveShop(owner, reviewer);
    await api().post(`${P}/admin/users/${owner.user.id}/suspend`).set(h.bearer(master)).send({ reasonCode: 'abuse', note: 'Testing the shop pause', until: new Date(Date.now() + 3 * 864e5).toISOString() }).expect(200);
    await h.drainEvents();
    expect((await models.Shop.findByPk(shop.id)).status).toBe('paused');
  });
});

describe('products and variants (FR-02 to FR-06)', () => {
  it('checks specs, variants, price range and the shop type; supplements need their details', async () => {
    const owner = await f.shopOwner(docsReviewer);
    await f.liveShop(owner, reviewer);
    const base = { itemTypeId: await f.typeId('football_boots'), title: 'Boots', specs: { stud_type: 'tf' }, basePricePoisha: 650000 };
    const send = (body, status) => api().post(`${P}/shop/products`).set(h.bearer(owner)).send(body).expect(status);
    expect((await send({ ...base, specs: { stud_type: 'tf', eu_size: '42' } }, 422)).body).toMatchObject({ code: 'SPECS_INVALID' });
    expect((await send({ ...base, specs: {} }, 422)).body.errors[0]).toEqual({ field: 'specs.stud_type', message: 'Required' });
    expect((await send({ ...base, basePricePoisha: 5000 }, 422)).body.code).toBe('PRICE_OUT_OF_RANGE');
    expect((await send({ ...base, variants: [{ attributes: { eu_size: '50' } }] }, 422)).body.code).toBe('ATTRIBUTES_INVALID');
    expect((await send({ ...base, variants: [{ attributes: { eu_size: '42' } }, { attributes: { eu_size: '42' } }] }, 409)).body.code).toBe('VARIANT_DUPLICATE');
    expect((await send({ ...base, itemTypeId: await f.typeId('protein_powder'), specs: { protein_type: 'whey' } }, 422)).body.code).toBe('CATEGORY_NOT_FOR_SHOP');
    expect((await send({ ...base, isMto: true, mtoDays: 25 }, 422)).body.code).toBe('MTO_DAYS_INVALID');
    // A type with no required axis starts with one "Standard" variant.
    const ball = await send({ itemTypeId: await f.typeId('cricket_ball'), title: 'Leather ball', specs: { ball_type: 'leather' }, basePricePoisha: 120000 }, 201);
    expect(ball.body.variants).toHaveLength(1);
    expect(ball.body.variants[0]).toMatchObject({ attributes: {}, onHand: 0 });
  });

  it('pre-moderation: incomplete products cannot be sent; a sold-out size shows disabled on the product page', async () => {
    const owner = await f.shopOwner(docsReviewer);
    await f.liveShop(owner, reviewer);
    const draft = await api().post(`${P}/shop/products`).set(h.bearer(owner)).send({ itemTypeId: await f.typeId('football_boots'), title: 'Boots', specs: { stud_type: 'tf' }, basePricePoisha: 650000 }).expect(201);
    const inc = await api().post(`${P}/shop/products/${draft.body.id}/submit`).set(h.bearer(owner)).expect(422);
    expect(inc.body.code).toBe('PRODUCT_INCOMPLETE');
    expect(inc.body.errors.map((e) => e.field)).toEqual(expect.arrayContaining(['photos', 'variants']));

    const ready = await f.readyBoots(owner, { stock: 2 });
    await api().post(`${P}/shop/variants/${variantBy(ready, '45').id}/adjust`).set(h.bearer(owner)).send({ setTo: 0, reasonCode: 'count_correction' }).expect(200);
    expect((await api().get(`${P}/market/products/${ready.slug}`).expect(404)).body.code).toBe('NOT_FOUND');
    const live = await f.liveProduct(owner, reviewer, ready);
    expect(live).toMatchObject({ status: 'live', visibility: 'visible', publicPricePoisha: 650000 });
    const page = await api().get(`${P}/market/products/${live.slug}`).expect(200);
    expect(page.body.variants).toHaveLength(6);
    expect(page.body.variants.find((v) => v.attributes.eu_size === '45')).toMatchObject({ purchasable: false, stock: { code: 'out_hidden' } });
    expect(page.body.variants.find((v) => v.attributes.eu_size === '43')).toMatchObject({ purchasable: true, stock: { code: 'low', available: 2 }, labelEn: 'EU 43' });
    expect(page.body).toMatchObject({ checkoutOpen: true, shop: { name: 'Elephant Road Sports' }, specs: [expect.objectContaining({ key: 'stud_type', valueEn: 'Turf (TF)' })] });
  });

  it('edits: a small price change goes live at once; a big one or a new title waits for review', async () => {
    const owner = await f.shopOwner(docsReviewer);
    await f.liveShop(owner, reviewer);
    const live = await f.liveProduct(owner, reviewer, await f.readyBoots(owner));
    const small = await api().patch(`${P}/shop/products/${live.id}`).set(h.bearer(owner)).send({ basePricePoisha: 600000 }).expect(200);
    expect(small.body).toMatchObject({ editStatus: null, publicPricePoisha: 600000 });
    const big = await api().patch(`${P}/shop/products/${live.id}`).set(h.bearer(owner)).send({ basePricePoisha: 400000, title: 'Predator Turf (2026)' }).expect(200);
    expect(big.body).toMatchObject({ editStatus: 'draft', publicPricePoisha: 600000 });
    expect((await api().get(`${P}/market/products/${live.slug}`).expect(200)).body).toMatchObject({ title: 'Adidas Predator Turf Boots', priceFromPoisha: 600000 });
    await api().post(`${P}/shop/products/${live.id}/submit`).set(h.bearer(owner)).expect(200);
    const sub = await models.Submission.findOne({ where: { kind: 'product', subjectId: live.id, status: 'pending_review' } });
    expect(sub.payload.diff.fields.map((x) => x.field)).toEqual(['title']);
    expect(sub.payload.diff.prices.length).toBe(6);
    expect((await api().patch(`${P}/shop/products/${live.id}`).set(h.bearer(owner)).send({ description: 'x' }).expect(409)).body.code).toBe('PRODUCT_IN_REVIEW');
    await f.review(reviewer, 'product', live.id);
    expect((await api().get(`${P}/market/products/${live.slug}`).expect(200)).body).toMatchObject({ title: 'Predator Turf (2026)', priceFromPoisha: 400000, version: 2 });
  });

  it('variants: a new size is public at once; a held variant cannot retire; the last one stays', async () => {
    const owner = await f.shopOwner(docsReviewer);
    await f.liveShop(owner, reviewer);
    const live = await f.liveProduct(owner, reviewer, await f.readyBoots(owner, { sizes: ['42', '43'] }));
    const added = await api().post(`${P}/shop/products/${live.id}/variants`).set(h.bearer(owner)).send({ attributes: { eu_size: '44' }, priceOverridePoisha: 680000, openingStock: 3 }).expect(201);
    expect(added.body.variants).toHaveLength(3);
    expect((await api().get(`${P}/market/products/${live.slug}`).expect(200)).body).toMatchObject({ priceFromPoisha: 650000, priceToPoisha: 680000 });
    expect((await api().post(`${P}/shop/products/${live.id}/variants`).set(h.bearer(owner)).send({ attributes: {} }).expect(422)).body.code).toBe('ATTRIBUTES_INVALID');
    const v42 = variantBy(live, '42');
    await tx((transaction) => inventory.hold(v42.id, 1, randomUUID(), { transaction }));
    expect((await api().post(`${P}/shop/variants/${v42.id}/retire`).set(h.bearer(owner)).expect(409)).body.code).toBe('VARIANT_HAS_HELD');
    await api().post(`${P}/shop/variants/${variantBy(live, '43').id}/retire`).set(h.bearer(owner)).expect(200);
    const v44 = added.body.variants.find((v) => v.attributes.eu_size === '44');
    await api().post(`${P}/shop/variants/${v44.id}/retire`).set(h.bearer(owner)).expect(200);
    expect((await models.Product.findByPk(live.id)).liveSnapshot.variants.map((v) => v.id)).toEqual([v42.id]);
  });
});

describe('inventory (FR-10 to FR-15) and InventoryService for M13', () => {
  it('one of two concurrent holds on the last unit wins; replays change nothing', async () => {
    const owner = await f.shopOwner(docsReviewer);
    await f.liveShop(owner, reviewer);
    const live = await f.liveProduct(owner, reviewer, await f.readyBoots(owner, { sizes: ['42'], stock: 1 }));
    const v = live.variants[0];
    const a = randomUUID();
    const b = randomUUID();
    const results = await Promise.allSettled([tx((t) => inventory.hold(v.id, 1, a, { transaction: t })), tx((t) => inventory.hold(v.id, 1, b, { transaction: t }))]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find((r) => r.status === 'rejected').reason.code).toBe('INSUFFICIENT_STOCK');
    const winner = results[0].status === 'fulfilled' ? a : b;
    const replay = await tx((t) => inventory.hold(v.id, 1, winner, { transaction: t }));
    expect(replay).toMatchObject({ replay: true, held: 1, available: 0 });
    await h.drainEvents();
    expect((await models.Product.findByPk(live.id)).visibility).toBe('hidden_oos');
    await tx((t) => inventory.commit(v.id, 1, winner, { transaction: t }));
    expect(await tx((t) => inventory.commit(v.id, 1, winner, { transaction: t }))).toMatchObject({ replay: true, onHand: 0, held: 0 });
    const ret = randomUUID();
    await tx((t) => inventory.restock(v.id, 1, ret, { transaction: t }));
    await tx((t) => inventory.restock(v.id, 1, ret, { transaction: t }));
    const after = await models.ProductVariant.findByPk(v.id);
    expect([after.onHand, after.held]).toEqual([1, 0]);
    expect((await models.Product.findByPk(live.id)).visibility).toBe('visible');
    const movements = await api().get(`${P}/shop/variants/${v.id}/movements`).set(h.bearer(owner)).expect(200);
    expect(movements.body.items.map((m) => m.type)).toEqual(['return_restock', 'commit', 'hold', 'receive']);
    const names = h.events.recorded().map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['variant.stock_depleted', 'product.hidden', 'variant.restocked', 'product.unhidden']));
  });

  it('adjustments need a reason and never go below held; low stock fires once; the reconcile job finds tampering', async () => {
    const owner = await f.shopOwner(docsReviewer);
    await f.liveShop(owner, reviewer);
    const live = await f.liveProduct(owner, reviewer, await f.readyBoots(owner, { sizes: ['42'], stock: 10 }));
    const v = live.variants[0];
    await tx((t) => inventory.hold(v.id, 2, randomUUID(), { transaction: t }));
    expect((await api().post(`${P}/shop/variants/${v.id}/adjust`).set(h.bearer(owner)).send({ setTo: 1, reasonCode: 'lost' }).expect(409)).body.code).toBe('BELOW_HELD');
    expect((await api().post(`${P}/shop/variants/${v.id}/adjust`).set(h.bearer(owner)).send({ delta: -1, reasonCode: 'other' }).expect(422)).body.code).toBe('VALIDATION_FAILED');
    h.events.clearRecorded();
    await api().post(`${P}/shop/variants/${v.id}/adjust`).set(h.bearer(owner)).send({ delta: -6, reasonCode: 'damaged' }).expect(200);
    await api().post(`${P}/shop/variants/${v.id}/adjust`).set(h.bearer(owner)).send({ delta: -1, reasonCode: 'lost' }).expect(200);
    expect(h.events.recorded().filter((e) => e.name === 'variant.low_stock_reached')).toHaveLength(1);
    const received = await api().post(`${P}/shop/variants/${v.id}/adjust`).set(h.bearer(owner)).send({ delta: 10, reasonCode: 'received' }).expect(200);
    expect(received.body).toMatchObject({ onHand: 13, held: 2, available: 11 });
    const desk = await api().get(`${P}/shop/inventory`).set(h.bearer(owner)).expect(200);
    expect(desk.body.kpis).toMatchObject({ stockValuePoisha: 13 * 650000, heldForOrders: 2, outOfStock: 0 });
    expect((await inventory.reconcile()).mismatches).toBe(0);
    await models.ProductVariant.update({ onHand: 99 }, { where: { id: v.id } });
    expect((await inventory.reconcile()).mismatches).toBe(1);
    expect(await models.AuditLog.count({ where: { action: 'inventory.reconcile_mismatch' } })).toBe(1);
    await expect(models.InventoryMovement.update({ deltaOnHand: 0 }, { where: { variantId: v.id } })).rejects.toThrow();
  });

  it('made-to-order products carry no stock', async () => {
    const owner = await f.shopOwner(docsReviewer);
    await f.liveShop(owner, reviewer);
    const ready = await f.readyBoots(owner, { sizes: ['42'], stock: 0, over: { isMto: true } });
    expect(ready.mtoDays).toBe(5);
    const live = await f.liveProduct(owner, reviewer, ready);
    expect((await api().post(`${P}/shop/variants/${live.variants[0].id}/adjust`).set(h.bearer(owner)).send({ delta: 1, reasonCode: 'received' }).expect(409)).body.code).toBe('MTO_NO_STOCK');
    expect(await tx((t) => inventory.hold(live.variants[0].id, 3, randomUUID(), { transaction: t }))).toMatchObject({ mto: true });
    expect((await api().get(`${P}/market/products/${live.slug}`).expect(200)).body.variants[0]).toMatchObject({ purchasable: true, stock: { code: 'mto', days: 5 } });
  });
});

describe('supplements (v3)', () => {
  it('a variant too close to expiry is blocked from sale and the shop is told', async () => {
    const owner = await f.shopOwner(docsReviewer, 'Muscle House');
    await f.liveShop(owner, reviewer, { shopType: 'supplements', name: 'Muscle House BD' });
    const body = { itemTypeId: await f.typeId('protein_powder'), title: 'Gold Standard Whey', brand: 'ON', specs: { protein_type: 'whey' }, basePricePoisha: 950000 };
    const send = (b, status) => api().post(`${P}/shop/products`).set(h.bearer(owner)).send(b).expect(status);
    expect((await send({ ...body, variants: [{ attributes: { flavour: 'chocolate', pack_size: '5lb' }, openingStock: 4 }] }, 422)).body.code).toBe('EXPIRY_REQUIRED');
    const p = await send({ ...body, variants: [{ attributes: { flavour: 'chocolate', pack_size: '5lb' }, openingStock: 4, expiryDate: f.future(200), batchNo: 'B-2026-01' }, { attributes: { flavour: 'vanilla', pack_size: '5lb' }, openingStock: 4, expiryDate: f.future(200), batchNo: 'B-2026-02' }] }, 201);
    await f.addPhotos(owner, p.body.id);
    const inc = await api().post(`${P}/shop/products/${p.body.id}/submit`).set(h.bearer(owner)).expect(422);
    expect(inc.body.errors.map((e) => e.field)).toContain('importer');
    await api().patch(`${P}/shop/products/${p.body.id}`).set(h.bearer(owner)).send({ importer: 'Fitness Imports Ltd', bstiRegNo: 'BSTI-1234' }).expect(200);
    const live = await f.liveProduct(owner, reviewer, p.body);
    const choc = live.variants.find((v) => v.attributes.flavour === 'chocolate');
    await models.ProductVariant.update({ expiryDate: f.future(29) }, { where: { id: choc.id } });
    h.events.clearRecorded();
    expect((await inventory.supplementSweep()).changed).toBe(1);
    expect((await inventory.supplementSweep()).changed).toBe(0);
    expect(h.events.recorded().map((e) => e.name)).toContain('variant.sale_blocked');
    await expect(tx((t) => inventory.hold(choc.id, 1, randomUUID(), { transaction: t }))).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    const page = (await api().get(`${P}/market/products/${live.slug}`).expect(200)).body;
    expect(page.variants.find((v) => v.id === choc.id)).toMatchObject({ purchasable: false, stock: { code: 'blocked' } });
    expect(page.supplement).toEqual({ importer: 'Fitness Imports Ltd', bstiRegNo: 'BSTI-1234' });
    // Both flavours blocked: the product leaves Market.
    const vanilla = live.variants.find((v) => v.attributes.flavour === 'vanilla');
    await api().patch(`${P}/shop/variants/${vanilla.id}`).set(h.bearer(owner)).send({ expiryDate: f.future(10) }).expect(200);
    expect((await models.Product.findByPk(live.id)).visibility).toBe('hidden_oos');
    await h.drainEvents();
    expect(await models.Notification.count({ where: { userId: owner.user.id, code: 'SUPPLEMENT_EXPIRING' } })).toBeGreaterThanOrEqual(1);
  });
});

describe('browse, product page and saved items (FR-30 to FR-34)', () => {
  it('browses live products with filters, facets, sorts and search; hidden ones stay out', async () => {
    const owner = await f.shopOwner(docsReviewer);
    await f.liveShop(owner, reviewer);
    const boots = await f.liveProduct(owner, reviewer, await f.readyBoots(owner));
    const ball = await api().post(`${P}/shop/products`).set(h.bearer(owner)).send({ itemTypeId: await f.typeId('cricket_ball'), title: 'Kookaburra Turf Ball', specs: { ball_type: 'leather' }, basePricePoisha: 150000 }).expect(201);
    await api().post(`${P}/shop/variants/${ball.body.variants[0].id}/adjust`).set(h.bearer(owner)).send({ delta: 5, reasonCode: 'received' }).expect(200);
    await f.addPhotos(owner, ball.body.id);
    await f.liveProduct(owner, reviewer, ball.body);
    const all = await api().get(`${P}/market/items`).expect(200);
    expect(all.body.total).toBe(2);
    expect(all.body.facets.categories.map((c) => [c.key, c.count]).sort()).toEqual([['cricket', 1], ['football', 1]]);
    expect((await api().get(`${P}/market/items?category=football`).expect(200)).body.items.map((x) => x.id)).toEqual([boots.id]);
    expect((await api().get(`${P}/market/items?types=cricket_ball`).expect(200)).body.total).toBe(1);
    expect((await api().get(`${P}/market/items?priceMax=200000`).expect(200)).body.items[0].title).toBe('Kookaburra Turf Ball');
    expect((await api().get(`${P}/market/items?sort=-price`).expect(200)).body.items[0].id).toBe(boots.id);
    expect((await api().get(`${P}/market/items?q=predator`).expect(200)).body.total).toBe(1);
    expect((await api().get(`${P}/market/items?areaId=${await f.areaId('uttara')}`).expect(200)).body.total).toBe(0);
    await api().post(`${P}/shop/products/${boots.id}/pause`).set(h.bearer(owner)).expect(200);
    expect((await api().get(`${P}/market/items`).expect(200)).body.total).toBe(1);
    const shopPage = await api().get(`${P}/market/shops/${(await api().get(`${P}/shop/profile`).set(h.bearer(owner))).body.slug}`).expect(200);
    expect(shopPage.body.items).toHaveLength(1);
  });

  it('saves items (not your own), shows price drops and caps the list', async () => {
    const owner = await f.shopOwner(docsReviewer);
    await f.liveShop(owner, reviewer);
    const live = await f.liveProduct(owner, reviewer, await f.readyBoots(owner));
    const member = await h.signupUser({ name: 'Fahim' });
    expect((await api().put(`${P}/me/saved/product/${live.id}`).set(h.bearer(owner)).expect(409)).body.code).toBe('OWN_ITEM');
    await api().put(`${P}/me/saved/product/${live.id}`).set(h.bearer(member)).expect(200);
    await api().put(`${P}/me/saved/product/${live.id}`).set(h.bearer(member)).expect(200);
    await api().patch(`${P}/shop/products/${live.id}`).set(h.bearer(owner)).send({ basePricePoisha: 600000 }).expect(200);
    await h.drainEvents();
    const list = await api().get(`${P}/me/saved`).set(h.bearer(member)).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ priceAtSavePoisha: 650000, badges: ['price_dropped'], item: { priceFromPoisha: 600000 } });
    expect(await models.Notification.count({ where: { userId: member.user.id, code: 'SAVED_PRICE_DROP' } })).toBe(1);
    await api().delete(`${P}/me/saved/product/${live.id}`).set(h.bearer(member)).expect(200);
    expect((await api().get(`${P}/me/saved`).set(h.bearer(member)).expect(200)).body.items).toHaveLength(0);
    expect(await models.SavedItem.count({ where: { userId: member.user.id } })).toBe(1);
    await h.setSettingForTest('market.saved_max', 10);
    await models.SavedItem.bulkCreate(Array.from({ length: 10 }, () => ({ userId: member.user.id, itemType: 'product', itemId: randomUUID(), priceAtSavePoisha: 1 })));
    expect((await api().put(`${P}/me/saved/product/${live.id}`).set(h.bearer(member)).expect(409)).body.code).toBe('SAVED_LIMIT');
  });
});

describe('staff, reports and RBAC', () => {
  it('staff suspend a product (410 on the page); reports take a shop down; masters restore', async () => {
    const owner = await f.shopOwner(docsReviewer);
    const shop = await f.liveShop(owner, reviewer);
    const live = await f.liveProduct(owner, reviewer, await f.readyBoots(owner));
    const ops = await f.staffWith(master, ['manage_users']);
    await api().post(`${P}/admin/market/products/${live.id}/suspend`).set(h.bearer(reviewer)).send({ reason: 'Counterfeit photos' }).expect(403);
    await api().post(`${P}/admin/market/products/${live.id}/suspend`).set(h.bearer(ops)).send({ reason: 'Counterfeit photos' }).expect(200);
    expect((await api().get(`${P}/market/products/${live.slug}`).expect(410)).body.code).toBe('PRODUCT_GONE');
    await api().post(`${P}/admin/market/products/${live.id}/restore`).set(h.bearer(ops)).send({ reason: 'Owner proved it' }).expect(403);
    await api().post(`${P}/admin/market/products/${live.id}/restore`).set(h.bearer(master)).send({ reason: 'Owner proved it' }).expect(200);
    expect((await api().get(`${P}/admin/market/products?shopId=${shop.id}`).set(h.bearer(reviewer)).expect(200)).body.items).toHaveLength(1);

    const member = await h.signupUser({ name: 'Reporter' });
    await api().post(`${P}/reports`).set(h.bearer(member)).send({ subjectType: 'shop', subjectId: shop.id, reasonCode: 'fraud' }).expect(201);
    await api().post(`${P}/admin/reports/resolve`).set(h.bearer(master)).send({ subjectType: 'shop', subjectId: shop.id, action: 'content_removed', note: 'Fake shop confirmed' }).expect(200);
    expect((await models.Shop.findByPk(shop.id)).status).toBe('suspended');
    expect((await api().get(`${P}/market/items`).expect(200)).body.total).toBe(0);
  });

  it('another owner cannot touch my products; members cannot use the shop desk', async () => {
    const a = await f.shopOwner(docsReviewer, 'Shop A');
    await f.liveShop(a, reviewer);
    const ready = await f.readyBoots(a);
    const b = await f.shopOwner(docsReviewer, 'Shop B');
    await f.liveShop(b, reviewer, { name: 'Shop B Sports' });
    expect((await api().patch(`${P}/shop/products/${ready.id}`).set(h.bearer(b)).send({ description: 'mine' }).expect(403)).body.code).toBe('NOT_OWNER');
    expect((await api().post(`${P}/shop/variants/${ready.variants[0].id}/adjust`).set(h.bearer(b)).send({ delta: 1, reasonCode: 'received' }).expect(403)).body.code).toBe('NOT_OWNER');
    const member = await h.signupUser({ name: 'Just Member' });
    await api().get(`${P}/shop/products`).set(h.bearer(member)).expect(403);
    await api().get(`${P}/admin/market/shops`).set(h.bearer(member)).expect(401);
  });
});

describe('the owner desk', () => {
  it('photos, withdraw, changes requested, pause, stock rules, lists and the M19 actions', async () => {
    const owner = await f.shopOwner(docsReviewer);
    // The shop: withdraw from review, send again, changes requested, fixed, approved.
    await api().post(`${P}/shop/profile`).set(h.bearer(owner)).send({ shopType: 'sports_gear', name: 'Gulshan Kits', areaId: await f.areaId(), addressLine: 'Road 90, Gulshan 2' }).expect(201);
    await api().post(`${P}/shop/profile/submit`).set(h.bearer(owner)).expect(200);
    expect((await api().post(`${P}/shop/profile/submit`).set(h.bearer(owner)).expect(409)).body.code).toBe('SHOP_IN_REVIEW');
    expect((await api().post(`${P}/shop/profile/withdraw`).set(h.bearer(owner)).expect(200)).body.status).toBe('withdrawn');
    const resent = await api().post(`${P}/shop/profile/submit`).set(h.bearer(owner)).expect(200);
    await f.review(reviewer, 'shop', resent.body.id, 'request_changes', { reasonCode: 'shop_details' });
    expect((await api().get(`${P}/shop/profile`).set(h.bearer(owner)).expect(200)).body).toMatchObject({ status: 'changes_requested', reviewReason: { code: 'shop_details' } });
    expect((await api().get(`${P}/me/dashboard/actions?role=shop_owner`).set(h.bearer(owner)).expect(200)).body.items.map((i) => i.key)).toContain('shop_changes_requested');
    await api().patch(`${P}/shop/profile`).set(h.bearer(owner)).send({ addressLine: 'House 7, Road 90, Gulshan 2' }).expect(200);
    await api().post(`${P}/shop/profile/submit`).set(h.bearer(owner)).expect(200);
    await f.review(reviewer, 'shop', resent.body.id);
    // Photos: reorder (the public version follows), remove (an edit), limits from settings.
    const live = await f.liveProduct(owner, reviewer, await f.readyBoots(owner, { sizes: ['42', '43'], stock: 3 }));
    const ids = live.photos.map((x) => x.id).reverse();
    expect((await api().put(`${P}/shop/products/${live.id}/photos/order`).set(h.bearer(owner)).send({ ids: ids.slice(1) }).expect(422)).body.code).toBe('PHOTOS_MISMATCH');
    await api().put(`${P}/shop/products/${live.id}/photos/order`).set(h.bearer(owner)).send({ ids }).expect(200);
    expect((await models.Product.findByPk(live.id)).liveSnapshot.photos.map((x) => x.id)).toEqual(ids);
    await api().post(`${P}/shop/products/${live.id}/photos/${ids[0]}/remove`).set(h.bearer(owner)).expect(200);
    expect((await api().get(`${P}/shop/products/${live.id}`).set(h.bearer(owner)).expect(200)).body.editStatus).toBe('draft');
    expect((await api().post(`${P}/shop/products/${live.id}/photos`).set(h.bearer(owner)).set('Content-Type', 'image/gif').send(Buffer.from('GIF89a')).expect(415)).body.code).toBe('FILE_TYPE_NOT_ALLOWED');
    await h.setSettingForTest('market.product_max_photos', 3);
    await f.addPhotos(owner, live.id, 1);
    expect((await api().post(`${P}/shop/products/${live.id}/photos`).set(h.bearer(owner)).set('Content-Type', 'image/jpeg').send(Buffer.concat([f.JPEG, Buffer.from('more')])).expect(409)).body.code).toBe('PHOTO_LIMIT');
    // A product edit in review can be withdrawn; owner lists and the stock rules.
    await api().post(`${P}/shop/products/${live.id}/submit`).set(h.bearer(owner)).expect(200);
    expect((await api().post(`${P}/shop/products/${live.id}/withdraw`).set(h.bearer(owner)).expect(200)).body.editStatus).toBe('draft');
    const mine = await api().get(`${P}/shop/products`).set(h.bearer(owner)).expect(200);
    expect(mine.body.items[0]).toMatchObject({ id: live.id, variants: 2, onHand: 6, available: 6, editStatus: 'draft' });
    expect((await api().get(`${P}/shop/products?status=draft`).set(h.bearer(owner)).expect(200)).body.items).toHaveLength(0);
    await api().post(`${P}/shop/variants/${live.variants[0].id}/adjust`).set(h.bearer(owner)).send({ setTo: 0, reasonCode: 'count_correction' }).expect(200);
    await api().post(`${P}/shop/variants/${live.variants[1].id}/adjust`).set(h.bearer(owner)).send({ setTo: 0, reasonCode: 'count_correction' }).expect(200);
    expect((await models.Product.findByPk(live.id)).visibility).toBe('hidden_oos');
    expect((await api().put(`${P}/shop/stock-rules`).set(h.bearer(owner)).send({ mtoDaysDefault: 25 }).expect(422)).body.code).toBe('MTO_DAYS_INVALID');
    const rules = await api().put(`${P}/shop/stock-rules`).set(h.bearer(owner)).send({ autoHideOutOfStock: false, lowStockThreshold: 5 }).expect(200);
    expect(rules.body.stockRules).toMatchObject({ autoHideOutOfStock: false, lowStockThreshold: 5 });
    expect((await models.Product.findByPk(live.id)).visibility).toBe('visible');
    expect((await api().get(`${P}/shop/inventory?status=out`).set(h.bearer(owner)).expect(200)).body.items).toHaveLength(2);
    expect((await api().get(`${P}/me/dashboard/actions?role=shop_owner`).set(h.bearer(owner)).expect(200)).body.items.map((i) => i.key)).toContain('stock_out');
    expect((await inventory.visibilitySweep()).changed).toBe(0);
    // The shop pauses and resumes; a removed product is gone from the desk.
    await api().post(`${P}/shop/profile/pause`).set(h.bearer(owner)).expect(200);
    expect((await api().get(`${P}/market/products/${live.slug}`).expect(200)).body.available).toBe(false);
    await api().post(`${P}/shop/profile/resume`).set(h.bearer(owner)).expect(200);
    expect((await api().post(`${P}/shop/products/${live.id}/remove`).set(h.bearer(owner)).expect(200)).body.status).toBe('removed');
    await api().get(`${P}/shop/products/${live.id}`).set(h.bearer(owner)).expect(404);
    const staffShops = await api().get(`${P}/admin/market/shops?q=gulshan`).set(h.bearer(reviewer)).expect(200);
    expect(staffShops.body.items[0]).toMatchObject({ name: 'Gulshan Kits', owner: { id: owner.user.id } });
    expect((await api().get(`${P}/admin/market/shops/${resent.body.id}`).set(h.bearer(reviewer)).expect(200)).body.publicVersion.version).toBe(1);
  });
});
