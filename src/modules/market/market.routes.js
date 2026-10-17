'use strict';

/**
 * M12 routes (§9), step 1.
 *   publicRouter  /market         browse, product page, shop page, categories (no sign-in)
 *   shopRouter    /shop           the owner's shop, products, variants, photos and stock; gate list_product
 *   meSaved       /me/saved       saved items (signed-in members)
 *   adminRouter   /admin/market   shops and products for staff: suspend (manage_users), restore and remove (masters)
 * Decisions on shops and products are M05's (/admin/submissions, kinds `shop` and `product`).
 */
const crypto = require('crypto');
const express = require('express');
const { Router } = express;
const { validate } = require('../../common/validate');
const { sendCached } = require('../../common/http-cache');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, requireStaff, requireAnyPermission, requireMaster, requireGate } = require('../../middlewares/auth');
const limits = require('../../middlewares/rateLimit');
require('./market.moderation'); // the M05 adapters load with the routes
const shops = require('./shops.service');
const products = require('./products.service');
const photos = require('./photos.service');
const inventory = require('./inventory.service');
const pub = require('./public.service');
const saved = require('./saved.service');
const s = require('./market.schemas');

const id = validate(s.idParam, 'params');
// The hard ceiling is the top of market.photo_max_bytes (20 MB); the setting is checked per photo.
const raw = express.raw({ type: () => true, limit: '20mb' });
const cached = (req, res, body) => sendCached(req, res, body, crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex'));

// ---------------- public
const publicRouter = Router();
publicRouter.get('/items', validate(s.listQuery, 'query'), async (req, res) => res.json(await pub.list(req.validQuery)));
publicRouter.get('/categories', async (req, res) => cached(req, res, await pub.categories()));
// The product page carries live stock, so it is not cached like the catalogue.
publicRouter.get('/products/:slug', validate(s.slugParam, 'params'), async (req, res) => res.json(await pub.product(req.params.slug)));
publicRouter.get('/shops/:slug', validate(s.slugParam, 'params'), validate(s.shopPageQuery, 'query'), async (req, res) => res.json(await pub.shop(req.params.slug, req.validQuery)));

// ---------------- owner (an active shop_owner role, M01/M02)
const shopRouter = Router();
shopRouter.use(authenticate, requireGate('list_product'));
shopRouter.get('/profile', async (req, res) => res.json(await shops.getMine(req.user)));
shopRouter.post('/profile', validate(s.createShop), async (req, res) => res.status(201).json(await shops.create(req.user, req.body, req)));
shopRouter.patch('/profile', validate(s.updateShop), async (req, res) => res.json(await shops.update(req.user, req.body, req)));
shopRouter.post('/profile/submit', async (req, res) => res.json(await shops.submit(req.user, req)));
shopRouter.post('/profile/withdraw', async (req, res) => res.json(await shops.withdraw(req.user, req)));
shopRouter.post('/profile/pause', async (req, res) => res.json(await shops.setPaused(req.user, true, req)));
shopRouter.post('/profile/resume', async (req, res) => res.json(await shops.setPaused(req.user, false, req)));
shopRouter.put('/stock-rules', validate(s.stockRules), async (req, res) => res.json(await shops.setStockRules(req.user, req.body, req)));

shopRouter.get('/products', validate(s.ownerListQuery, 'query'), async (req, res) => res.json(await products.listMine(req.user, req.validQuery)));
shopRouter.post('/products', validate(s.createProduct), async (req, res) => res.status(201).json(await products.create(req.user, req.body, req)));
shopRouter.get('/products/:id', id, async (req, res) => res.json(await products.getMine(req.user, req.params.id)));
shopRouter.patch('/products/:id', id, validate(s.updateProduct), async (req, res) => res.json(await products.update(req.user, req.params.id, req.body, req)));
shopRouter.post('/products/:id/submit', id, async (req, res) => res.json(await products.submit(req.user, req.params.id, req)));
shopRouter.post('/products/:id/withdraw', id, async (req, res) => res.json(await products.withdraw(req.user, req.params.id, req)));
for (const action of ['pause', 'resume', 'remove']) {
  shopRouter.post(`/products/:id/${action}`, id, async (req, res) => res.json(await products.ownerMove(req.user, req.params.id, action, req)));
}
shopRouter.post('/products/:id/variants', id, validate(s.createVariant), async (req, res) => res.status(201).json(await products.addVariant(req.user, req.params.id, req.body, req)));
shopRouter.patch('/variants/:id', id, validate(s.updateVariant), async (req, res) => res.json(await products.updateVariant(req.user, req.params.id, req.body, req)));
shopRouter.post('/variants/:id/retire', id, async (req, res) => res.json(await products.retireVariant(req.user, req.params.id, req)));

shopRouter.post('/products/:id/photos', id, limits.productPhoto, raw, async (req, res) =>
  res.status(201).json(await photos.upload(req.user, req.params.id, { contentType: req.get('content-type'), body: req.body }, req))
);
shopRouter.put('/products/:id/photos/order', id, validate(s.photoOrder), async (req, res) => res.json(await photos.reorder(req.user, req.params.id, req.body.ids, req)));
shopRouter.post('/products/:id/photos/:photoId/remove', validate(s.photoParams, 'params'), async (req, res) => res.json(await photos.remove(req.user, req.params.id, req.params.photoId, req)));

shopRouter.post('/variants/:id/adjust', id, validate(s.adjustBody), async (req, res) => res.json(await inventory.adjust(req.user, req.params.id, req.body, req)));
shopRouter.get('/variants/:id/movements', id, validate(s.cursorQuery, 'query'), async (req, res) => res.json(await inventory.movements(req.user, req.params.id, req.validQuery)));
shopRouter.get('/inventory', validate(s.inventoryQuery, 'query'), async (req, res) => res.json(await inventory.overview(req.user, req.validQuery)));

// ---------------- member: saved items (FR-33)
const meSaved = Router();
meSaved.use(authenticate);
meSaved.get('/', async (req, res) => res.json(await saved.list(req.user)));
meSaved.put('/:itemType/:id', validate(s.savedParams, 'params'), async (req, res) => res.json(await saved.save(req.user, req.params.itemType, req.params.id)));
meSaved.delete('/:itemType/:id', validate(s.savedParams, 'params'), async (req, res) => res.json(await saved.unsave(req.user, req.params.itemType, req.params.id)));

// ---------------- staff
const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff);
const canSee = requireAnyPermission(PERMISSIONS.APPROVE_LISTINGS, PERMISSIONS.MANAGE_USERS);
const suspender = requireAnyPermission(PERMISSIONS.MANAGE_USERS);
adminRouter.get('/shops', canSee, validate(s.staffShopsQuery, 'query'), async (req, res) => res.json(await shops.staffList(req.validQuery)));
adminRouter.get('/shops/:id', canSee, id, async (req, res) => res.json(await shops.staffGet(req.params.id)));
adminRouter.get('/products', canSee, validate(s.staffProductsQuery, 'query'), async (req, res) => res.json(await products.staffList(req.validQuery)));
adminRouter.get('/products/:id', canSee, id, async (req, res) => res.json(await products.staffGet(req.params.id)));
for (const [path, svc] of [['shops', shops], ['products', products]]) {
  adminRouter.post(`/${path}/:id/suspend`, suspender, id, validate(s.reasonBody), async (req, res) => res.json(await svc.staffAction(req.user, req.params.id, 'suspend', req.body, req)));
  adminRouter.post(`/${path}/:id/restore`, requireMaster, id, validate(s.reasonBody), async (req, res) => res.json(await svc.staffAction(req.user, req.params.id, 'restore', req.body, req)));
  adminRouter.post(`/${path}/:id/remove`, requireMaster, id, validate(s.reasonBody), async (req, res) => res.json(await svc.staffAction(req.user, req.params.id, 'remove', req.body, req)));
}

module.exports = { publicRouter, shopRouter, meSaved, adminRouter };
