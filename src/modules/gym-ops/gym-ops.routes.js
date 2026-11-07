'use strict';

/**
 * M27 routes, round 1. Every /manage/gyms/:gymId/** route passes authenticate and the gate work_gym; the
 * service resolves access through gym-manage (404 for anyone unrelated, 403 PERMISSION_REQUIRED for staff
 * without the permission, 403 GYM_TIER_REQUIRED below the plan). Idempotency-Key on every POST that records
 * money, a sale or stock (IK).
 *   manageRouter  /manage/gyms/:gymId   expense categories and expenses, the cash drawer, profit and loss,
 *                                       products and stock, counter sales and receipts, lockers and rentals
 */
const { Router } = require('express');
const { validate } = require('../../common/validate');
const { requireIdempotencyKey } = require('../../common/idempotency');
const { authenticate, requireGate } = require('../../middlewares/auth');
const s = require('./gym-ops.schemas');
const expenses = require('./expenses.service');
const cash = require('./cash.service');
const pnl = require('./pnl.service');
const shop = require('./shop.service');
const lockers = require('./lockers.service');

const params = (schema) => validate(schema, 'params');
const query = (schema) => validate(schema, 'query');
const ik = (action) => requireIdempotencyKey(`gym_ops.${action}`);
const P = (req) => req.params.gymId;

const manageRouter = Router();
manageRouter.use(authenticate);
const g = Router({ mergeParams: true });
manageRouter.use('/gyms/:gymId', requireGate('work_gym'), params(s.gymParam), g);

// Expenses (M27-FR-01..05).
g.get('/expense-categories', async (req, res) => res.json(await expenses.categories(req.user, P(req))));
g.put('/expense-categories', validate(s.categoriesBody), async (req, res) => res.json(await expenses.saveCategories(req.user, P(req), req.body, req)));
g.get('/expenses', query(s.expenseQuery), async (req, res) => res.json(await expenses.list(req.user, P(req), req.validQuery)));
g.post('/expenses', validate(s.expenseBody), ik('expense'), async (req, res) => res.status(201).json(await expenses.create(req.user, P(req), req.body, req)));
g.post('/expenses/:expenseId/void', params(s.expenseParam), validate(s.reasonBody), async (req, res) => res.json(await expenses.voidOne(req.user, P(req), req.params.expenseId, req.body, req)));

// The cash drawer (M27-FR-06..09) and profit and loss (M27-FR-27).
g.get('/cash-drawer', query(s.dayQuery), async (req, res) => res.json(await cash.get(req.user, P(req), req.validQuery)));
g.post('/cash-drawer/open', validate(s.openBody), async (req, res) => res.status(201).json(await cash.open(req.user, P(req), req.body, req)));
g.post('/cash-drawer/close', validate(s.closeBody), async (req, res) => res.json(await cash.close(req.user, P(req), req.body, req)));
g.get('/pnl', query(s.periodQuery), async (req, res) => res.json(await pnl.get(req.user, P(req), req.validQuery)));

// The counter shop (M27-FR-10..21).
g.get('/products', query(s.productQuery), async (req, res) => res.json(await shop.products(req.user, P(req), req.validQuery)));
g.post('/products', validate(s.productBody), async (req, res) => res.status(201).json(await shop.createProduct(req.user, P(req), req.body, req)));
g.patch('/products/:productId', params(s.productParam), validate(s.productPatch), async (req, res) => res.json(await shop.updateProduct(req.user, P(req), req.params.productId, req.body, req)));
g.post('/products/:productId/stock', params(s.productParam), validate(s.stockBody), ik('stock'), async (req, res) => res.status(201).json(await shop.stock(req.user, P(req), req.params.productId, req.body, req)));
g.get('/sales', query(s.saleQuery), async (req, res) => res.json(await shop.sales(req.user, P(req), req.validQuery)));
g.post('/sales', validate(s.saleBody), ik('sale'), async (req, res) => res.status(201).json(await shop.sell(req.user, P(req), req.body, req)));
g.get('/sales/:saleId/receipt', params(s.saleParam), async (req, res) => res.json(await shop.receipt(req.user, P(req), req.params.saleId)));
g.post('/sales/:saleId/reverse', params(s.saleParam), validate(s.reasonBody), async (req, res) => res.json(await shop.reverse(req.user, P(req), req.params.saleId, req.body, req)));

// Lockers (M27-FR-22..26).
g.get('/lockers', async (req, res) => res.json(await lockers.grid(req.user, P(req))));
g.post('/lockers', validate(s.lockerBody), async (req, res) => res.status(201).json(await lockers.add(req.user, P(req), req.body, req)));
g.patch('/lockers/:lockerId', params(s.lockerParam), validate(s.lockerPatch), async (req, res) => res.json(await lockers.update(req.user, P(req), req.params.lockerId, req.body, req)));
g.post('/lockers/:lockerId/rent', params(s.lockerParam), validate(s.rentBody), ik('locker_rent'), async (req, res) => res.status(201).json(await lockers.rent(req.user, P(req), req.params.lockerId, req.body, req)));
g.get('/locker-rentals', query(s.rentalQuery), async (req, res) => res.json(await lockers.rentals(req.user, P(req), req.validQuery)));
g.post('/locker-rentals/:rentalId/collect', params(s.rentalParam), validate(s.collectBody), ik('locker_fee'), async (req, res) => res.status(201).json(await lockers.collect(req.user, P(req), req.params.rentalId, req.body, req)));
g.post('/locker-rentals/:rentalId/end', params(s.rentalParam), validate(s.reasonBody), async (req, res) => res.json(await lockers.end(req.user, P(req), req.params.rentalId, req.body, req)));

module.exports = { manageRouter };
