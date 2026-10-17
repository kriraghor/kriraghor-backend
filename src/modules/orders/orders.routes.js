'use strict';

/**
 * M13 routes (§9), step 1 (shop orders, online payment).
 *   meCart         /me/cart              the cart (signed in)
 *   checkoutRouter /checkout             quote and place (gate buy: a verified phone; Idempotency-Key)
 *   meOrders       /me/orders            my orders and the payment link of an unpaid one
 *   meSubOrders    /me/sub-orders        cancel, received, not received (an M17 dispute)
 *   shopOrders     /shop                 the shop owner's sub-orders and settlement (gate list_product)
 *   adminRouter    /admin/orders         staff: search and the timeline (manage_users, refund_small or
 *                                        view_payouts); platform cancel (master + step-up escrow.manage)
 */
const express = require('express');
const { Router } = express;
const { validate } = require('../../common/validate');
const { requireIdempotencyKey } = require('../../common/idempotency');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, requireStaff, requireAnyPermission, requireMaster, requireStepUp, requireGate } = require('../../middlewares/auth');
const limits = require('../../middlewares/rateLimit');
const cart = require('./cart.service');
const checkout = require('./checkout.service');
const buyer = require('./buyer.service');
const fulfil = require('./fulfil.service');
const admin = require('./orders.admin');
const s = require('./orders.schemas');

const id = validate(s.idParam, 'params');
// The hard ceiling is the top of market.photo_max_bytes (20 MB); the setting is checked per photo.
const raw = express.raw({ type: () => true, limit: '20mb' });

// ---------------- member: cart
const meCart = Router();
meCart.use(authenticate);
meCart.get('/', async (req, res) => res.json(await cart.get(req.user)));
meCart.delete('/', async (req, res) => res.json(await cart.clear(req.user)));
meCart.put('/items/:variantId', validate(s.variantParam, 'params'), validate(s.cartQty), async (req, res) => res.json(await cart.setQty(req.user, req.params.variantId, req.body)));
meCart.delete('/items/:variantId', validate(s.variantParam, 'params'), async (req, res) => res.json(await cart.remove(req.user, req.params.variantId)));

// ---------------- member: checkout
const checkoutRouter = Router();
checkoutRouter.use(authenticate, requireGate('buy'));
checkoutRouter.post('/quote', validate(s.quoteBody), async (req, res) => res.json(await checkout.quote(req.user, req.body)));
checkoutRouter.post('/', validate(s.checkoutBody), requireIdempotencyKey('orders.checkout'), async (req, res) => res.status(201).json(await checkout.place(req.user, req.body, req.idempotencyKey, req)));

// ---------------- member: my orders
const meOrders = Router();
meOrders.use(authenticate);
meOrders.get('/', validate(s.myOrdersQuery, 'query'), async (req, res) => res.json(await buyer.list(req.user, req.validQuery)));
meOrders.get('/:code', validate(s.codeParam, 'params'), async (req, res) => res.json(await buyer.get(req.user, req.params.code)));
meOrders.post('/:code/pay', validate(s.codeParam, 'params'), async (req, res) => res.json(await checkout.payLink(req.user, req.params.code)));

const meSubOrders = Router();
meSubOrders.use(authenticate);
meSubOrders.post('/:id/cancel', id, validate(s.cancelBody), async (req, res) => res.json(await buyer.cancel(req.user, req.params.id, req.body, req)));
meSubOrders.post('/:id/received', id, async (req, res) => res.json(await buyer.received(req.user, req.params.id, req)));
meSubOrders.post('/:id/not-received', id, requireGate('file_dispute'), validate(s.notReceivedBody), requireIdempotencyKey('orders.not_received'), async (req, res) =>
  res.status(201).json(await buyer.notReceived(req.user, req.params.id, req.body, req.idempotencyKey, req))
);

// ---------------- shop owner
const shopOrders = Router();
shopOrders.use(authenticate, requireGate('list_product'));
shopOrders.get('/sub-orders', validate(s.shopListQuery, 'query'), async (req, res) => res.json(await fulfil.list(req.user, req.validQuery)));
shopOrders.get('/sub-orders/:id', id, async (req, res) => res.json(await fulfil.get(req.user, req.params.id)));
shopOrders.post('/sub-orders/:id/accept', id, async (req, res) => res.json(await fulfil.accept(req.user, req.params.id, req)));
shopOrders.post('/sub-orders/:id/reject', id, validate(s.rejectBody), async (req, res) => res.json(await fulfil.reject(req.user, req.params.id, req.body, req)));
shopOrders.post('/sub-orders/:id/ship', id, validate(s.shipBody), async (req, res) => res.json(await fulfil.ship(req.user, req.params.id, req.body, req)));
shopOrders.post('/sub-orders/:id/delivered', id, limits.productPhoto, raw, async (req, res) =>
  res.json(await fulfil.delivered(req.user, req.params.id, { contentType: req.get('content-type'), body: req.body }, req))
);
shopOrders.get('/settlement', async (req, res) => res.json(await fulfil.settlement(req.user)));

// ---------------- staff
const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff);
const canSee = requireAnyPermission(PERMISSIONS.MANAGE_USERS, PERMISSIONS.REFUND_SMALL, PERMISSIONS.VIEW_PAYOUTS);
adminRouter.get('/', canSee, validate(s.adminListQuery, 'query'), async (req, res) => res.json(await admin.list(req.validQuery)));
adminRouter.get('/:code', canSee, async (req, res) => res.json(await admin.get(req.params.code)));
adminRouter.post('/sub-orders/:id/cancel', requireMaster, requireStepUp('escrow.manage'), id, validate(s.reasonBody), async (req, res) => res.json(await admin.platformCancel(req.user, req.params.id, req.body, req)));

module.exports = { meCart, checkoutRouter, meOrders, meSubOrders, shopOrders, adminRouter };
