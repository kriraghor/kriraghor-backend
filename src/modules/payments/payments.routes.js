'use strict';

/**
 * M06 routes (§9).
 *   payerRouter    /payments            payer: status, attempts (Idempotency-Key), verify; gateway return (no auth)
 *   meRouter       /me/payments         payer: my payments and refunds
 *   webhookRouter  /webhooks            provider IPN (signature checked, then re-validated with the provider)
 *   admin routers  /admin/payments, /admin/refunds, /admin/ledger, /admin/escrow, /admin/reconciliation
 */
const express = require('express');
const { Router } = express;
const config = require('../../config');
const { validate } = require('../../common/validate');
const { requireIdempotencyKey } = require('../../common/idempotency');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, requireStaff, requireMaster, requireStepUp, requireAnyPermission } = require('../../middlewares/auth');
const settings = require('../settings').settings;
const payments = require('./payments.service');
const refunds = require('./refunds.service');
const escrow = require('./escrow.service');
const ledger = require('./ledger.service');
const invariants = require('./invariants.service');
const reconciliation = require('./reconciliation.service');
const s = require('./payments.schemas');

const form = express.urlencoded({ extended: false, limit: '20kb' });
const idParam = validate(s.idParam, 'params');

// ---------------------------------------------------------------- payer
const payerRouter = Router();

// The gateway sends the browser back here (SSLCommerz POSTs a form; the simulator redirects with GET).
const returnHandler = async (req, res) => {
  const input = { ...req.query, ...(req.body ?? {}) };
  const parsed = s.returnInput.safeParse(input);
  const v = parsed.success ? parsed.data : {};
  res.redirect(303, await payments.handleReturn({ pid: v.pid, tranId: v.tran_id, valId: v.val_id }));
};
payerRouter.post('/return/sslcommerz', form, returnHandler);
payerRouter.get('/return/sslcommerz', returnHandler);

payerRouter.get('/:id', authenticate, idParam, async (req, res) => res.json(await payments.getForPayer(req.user, req.params.id)));
payerRouter.post('/:id/attempts', authenticate, idParam, validate(s.attemptBody), requireIdempotencyKey('payments.attempt'), async (req, res) =>
  res.status(201).json(await payments.startAttempt(req.user, req.params.id, req.body))
);
payerRouter.post('/:id/verify', authenticate, idParam, async (req, res) => res.json(await payments.verifyForPayer(req.user, req.params.id)));

const meRouter = Router();
meRouter.get('/', authenticate, validate(s.meListQuery, 'query'), async (req, res) => res.json(await payments.listForPayer(req.user.id, req.validQuery)));

// ---------------------------------------------------------------- provider IPN
const webhookRouter = Router();
webhookRouter.post('/sslcommerz', form, async (req, res) => res.json(await payments.handleIpn(req.body ?? {})));

// ---------------------------------------------------------------- admin (finance desk)
const staff = [authenticateAdmin, requireStaff];
const canView = requireAnyPermission(PERMISSIONS.VIEW_PAYOUTS);

const adminPayments = Router();
adminPayments.use(...staff);
adminPayments.get('/', canView, validate(s.adminPaymentsQuery, 'query'), async (req, res) => res.json(await payments.adminList(req.validQuery)));
adminPayments.post('/test-charges', requireMaster, validate(s.testChargeBody), requireIdempotencyKey('payments.test_charge'), async (req, res) =>
  res.status(201).json(await payments.createTestCharge(req.user, req.body, req.idempotencyKey, req))
);
adminPayments.get('/config', canView, async (_req, res) =>
  res.json({ testCharges: config.payments.testCharges, simulator: config.payments.simulator, provider: config.payments.provider, testChargeMax: settings.get('payments.test_charge_max_poisha') })
);
adminPayments.get('/:id', canView, idParam, async (req, res) => res.json(await payments.adminGet(req.params.id)));

// FR-09: a master refunding more than the staff limit confirms with step-up refund.large.
function stepUpAboveLimit(req, res, next) {
  if (req.user.isMaster && req.body.amount > settings.get('refunds.staff_limit_poisha')) return requireStepUp('refund.large')(req, res, next);
  return next();
}

const adminRefunds = Router();
adminRefunds.use(...staff);
adminRefunds.get('/', canView, validate(s.refundsQuery, 'query'), async (req, res) => res.json(await refunds.list(req.validQuery)));
adminRefunds.post('/', requireAnyPermission(PERMISSIONS.REFUND_SMALL), validate(s.refundCreate), requireIdempotencyKey('refunds.create'), stepUpAboveLimit, async (req, res) => {
  const refund = await refunds.create(req.user, req.body, req.idempotencyKey, req);
  res.status(refund.status === 'pending_master' ? 202 : 201).json(refund);
});
adminRefunds.post('/:id/approve', requireMaster, idParam, validate(s.approveBody), requireStepUp('refund.large'), async (req, res) =>
  res.json(await refunds.approve(req.user, req.params.id, req.body, req))
);
adminRefunds.post('/:id/reject', requireMaster, idParam, validate(s.rejectBody), requireStepUp('refund.large'), async (req, res) =>
  res.json(await refunds.reject(req.user, req.params.id, req.body, req))
);

const adminLedger = Router();
adminLedger.use(...staff, canView);
adminLedger.get('/accounts', validate(s.accountsQuery, 'query'), async (req, res) => res.json({ items: await ledger.listAccounts(req.validQuery) }));
adminLedger.get('/accounts/:id/entries', idParam, validate(s.entriesQuery, 'query'), async (req, res) => res.json(await ledger.accountEntries(req.params.id, req.validQuery)));
adminLedger.get('/transactions/:id', idParam, async (req, res) => res.json(await ledger.getTransaction(req.params.id)));
adminLedger.get('/trial-balance', async (_req, res) => res.json(await ledger.trialBalance()));
adminLedger.get('/invariants', async (_req, res) => res.json(await invariants.check({ publish: false })));

const adminEscrow = Router();
adminEscrow.use(...staff);
adminEscrow.get('/', canView, validate(s.escrowQuery, 'query'), async (req, res) => res.json(await escrow.list(req.validQuery)));
adminEscrow.get('/:id', canView, idParam, async (req, res) => res.json(await escrow.getOne(req.params.id)));
adminEscrow.post('/:id/release', requireMaster, idParam, validate(s.releaseBody), requireStepUp('escrow.manage'), async (req, res) =>
  res.json(await escrow.releaseManually(req.user, req.params.id, req.body, req))
);
adminEscrow.post('/:id/freeze', requireMaster, idParam, validate(s.freezeBody), requireStepUp('escrow.manage'), async (req, res) =>
  res.json(await escrow.freeze(req.user, req.params.id, req.body, req))
);
adminEscrow.post('/:id/unfreeze', requireMaster, idParam, validate(s.freezeBody), requireStepUp('escrow.manage'), async (req, res) =>
  res.json(await escrow.unfreeze(req.user, req.params.id, req.body, req))
);

const adminRecon = Router();
adminRecon.use(...staff);
adminRecon.get('/runs', canView, async (_req, res) => res.json(await reconciliation.listRuns()));
adminRecon.post('/runs', requireMaster, validate(s.runBody), async (req, res) =>
  res.status(201).json(await reconciliation.run({ businessDate: req.body.businessDate, actor: req.user, req }))
);
adminRecon.get('/runs/:id/items', canView, idParam, validate(s.itemsQuery, 'query'), async (req, res) => res.json(await reconciliation.listItems(req.params.id, req.validQuery)));
adminRecon.post('/items/:id/resolve', requireMaster, idParam, validate(s.resolveBody), async (req, res) =>
  res.json(await reconciliation.resolveItem(req.user, req.params.id, req.body, req))
);

module.exports = { payerRouter, meRouter, webhookRouter, adminPayments, adminRefunds, adminLedger, adminEscrow, adminRecon };
