'use strict';

/**
 * M07 routes (§9).
 *   meAccounts     /me/payout-accounts      payee: list, send the confirmation code, add (OTP)
 *   mePayouts      /me/payouts              payee: summary, list, detail, CSV statement
 *   meWithdrawals  /me/withdrawals          esports winnings on demand (gate withdraw_winnings, M21-FR-26)
 *   adminPayouts   /admin/payouts           finance desk: list, detail, release, approve, reveal,
 *                                           mark paid / failed, retry, cancel, hold, lift hold
 *   adminBatches   /admin/payout-batches    runs and "run now" (master)
 *   adminAccounts  /admin/payout-accounts   payout-account review (until M02)
 * Money actions need release_payouts (masters hold every permission). Release, retry and reveal need
 * step-up payout.approve for everyone; above the threshold, two masters approve, each with step-up.
 */
const { Router } = require('express');
const { validate } = require('../../common/validate');
const { requireIdempotencyKey } = require('../../common/idempotency');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, requireStaff, requireMaster, requireStepUp, requireAnyPermission, requireGate } = require('../../middlewares/auth');
const accounts = require('./payout-accounts.service');
const payouts = require('./payouts.service');
const withdrawals = require('./withdrawals.service');
const s = require('./payouts.schemas');

const idParam = validate(s.idParam, 'params');

// ---------------------------------------------------------------- payee
const meAccounts = Router();
meAccounts.use(authenticate);
meAccounts.get('/', async (req, res) => res.json(await accounts.listMine(req.user.id)));
meAccounts.post('/otp', async (req, res) => res.status(202).json(await accounts.sendCode(req.user, req)));
meAccounts.post('/', validate(s.accountAdd), async (req, res) => res.status(201).json(await accounts.add(req.user, req.body, req)));

const meWithdrawals = Router();
meWithdrawals.use(authenticate);
meWithdrawals.get('/', async (req, res) => res.json(await withdrawals.list(req.user.id)));
meWithdrawals.get('/available', async (req, res) => res.json(await withdrawals.available(req.user.id)));
meWithdrawals.post('/', requireGate('withdraw_winnings'), requireIdempotencyKey('payouts.withdraw'), async (req, res) => res.status(201).json(await withdrawals.create(req.user, req)));

const mePayouts = Router();
mePayouts.use(authenticate);
mePayouts.get('/summary', async (req, res) => res.json(await payouts.summary(req.user.id)));
mePayouts.get('/', validate(s.meListQuery, 'query'), async (req, res) => res.json(await payouts.meList(req.user.id, req.validQuery)));
mePayouts.get('/:id', idParam, async (req, res) => res.json(await payouts.meGet(req.user.id, req.params.id)));
mePayouts.get('/:id/statement.csv', idParam, validate(s.statementQuery, 'query'), async (req, res) => {
  const { filename, body } = await payouts.statementCsv(req.user.id, req.params.id, req.validQuery.locale);
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${filename}"`).set('Cache-Control', 'no-store');
  // Spreadsheet apps read UTF-8 CSV (Bangla headings) correctly only with a byte-order mark.
  res.send(`${String.fromCharCode(0xfeff)}${body}`);
});

// ---------------------------------------------------------------- admin (finance desk)
const staff = [authenticateAdmin, requireStaff];
const canView = requireAnyPermission(PERMISSIONS.VIEW_PAYOUTS, PERMISSIONS.RELEASE_PAYOUTS);
const canRelease = requireAnyPermission(PERMISSIONS.RELEASE_PAYOUTS);
const stepUp = requireStepUp('payout.approve');

const adminPayouts = Router();
adminPayouts.use(...staff);
adminPayouts.get('/', canView, validate(s.adminListQuery, 'query'), async (req, res) => res.json(await payouts.adminList(req.validQuery)));
adminPayouts.get('/:id', canView, idParam, async (req, res) => res.json(await payouts.adminGet(req.params.id)));
adminPayouts.post('/:id/release', canRelease, idParam, requireIdempotencyKey('payouts.release'), stepUp, async (req, res) => res.json(await payouts.release(req.user, req.params.id, req)));
adminPayouts.post('/:id/approve', requireMaster, idParam, requireIdempotencyKey('payouts.approve'), stepUp, async (req, res) => res.json(await payouts.approve(req.user, req.params.id, req)));
// The wallet number: no idempotency replay (it would store the response) and never cached.
adminPayouts.post('/:id/reveal', canRelease, idParam, stepUp, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await payouts.reveal(req.user, req.params.id, req));
});
adminPayouts.post('/:id/mark-paid', canRelease, idParam, validate(s.markPaidBody), requireIdempotencyKey('payouts.mark_paid'), async (req, res) =>
  res.json(await payouts.markPaid(req.user, req.params.id, req.body, req))
);
adminPayouts.post('/:id/mark-failed', canRelease, idParam, validate(s.markFailedBody), async (req, res) => res.json(await payouts.markFailed(req.user, req.params.id, req.body, req)));
adminPayouts.post('/:id/retry', canRelease, idParam, stepUp, async (req, res) => res.json(await payouts.retry(req.user, req.params.id, req)));
adminPayouts.post('/:id/cancel', canRelease, idParam, validate(s.cancelBody), async (req, res) => res.json(await payouts.cancel(req.user, req.params.id, req.body, req)));
adminPayouts.post('/:id/hold', canRelease, idParam, validate(s.holdBody), async (req, res) => res.json(await payouts.placeManualHold(req.user, req.params.id, req.body, req)));
adminPayouts.post('/:id/lift-hold', canRelease, idParam, validate(s.liftBody), async (req, res) => res.json(await payouts.liftManualHold(req.user, req.params.id, req.body, req)));

const adminBatches = Router();
adminBatches.use(...staff);
adminBatches.get('/', canView, validate(s.batchesQuery, 'query'), async (req, res) => res.json(await payouts.listBatches(req.validQuery)));
adminBatches.post('/run', requireMaster, validate(s.runBody), async (req, res) => res.status(201).json(await payouts.runNow(req.user, req.body)));

const adminAccounts = Router();
adminAccounts.use(...staff);
adminAccounts.get('/', canView, validate(s.accountsQuery, 'query'), async (req, res) => res.json(await accounts.adminList(req.validQuery)));
adminAccounts.post('/:id/verify', canRelease, idParam, validate(s.verifyBody), async (req, res) => res.json(await accounts.verify(req.user, req.params.id, req.body, req)));
adminAccounts.post('/:id/reject', canRelease, idParam, validate(s.rejectBody), async (req, res) => res.json(await accounts.reject(req.user, req.params.id, req.body, req)));

module.exports = { meWithdrawals, meAccounts, mePayouts, adminPayouts, adminBatches, adminAccounts };
