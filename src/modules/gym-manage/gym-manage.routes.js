'use strict';

/**
 * M24 routes, prompt 1 (§9.2). Every /manage/gyms/:gymId/** route passes authenticate and the gate
 * work_gym, then the service resolves access with business-members actFor for that gym (label Gym:
 * 404 for anyone unrelated, 403 PERMISSION_REQUIRED for staff without the permission, owner.only for
 * owner routes). Idempotency-Key on every POST that creates money records or a membership (IK).
 *   manageRouter   /manage                   gyms, overview, settings, desk, check-ins, members, requests,
 *                                            memberships, dues, payments, receipts, cash closing, imports;
 *                                            /manage/billing (gate run_gym, owner of a gym)
 *   pricingRouter  /gym-manage               public pricing (tiers from settings)
 *   receiptRouter  /gym-receipts             the public receipt behind a signed token
 *   meRequests     /me/gym-requests          invites to me: accept (gate join_gym), decline
 *   meMemberships  /me/gym-memberships       my gyms, one membership, calendar, check-in QR, health note, unlink
 *   meReceipts     /me/gym-receipts          my receipts
 *   adminRouter    /admin/gym-manage         a member list upload for an owner (manage_gyms + the owner's consent)
 * Prompt 2 (online money, reminders and billing):
 *   manageRouter   payment links, online refunds, reminders page, reports, absent list, exports;
 *                  /manage/billing/invoices (list, detail, pay), /manage/reports (all gyms)
 *   payRouter      /gym-pay                  the public payment-link page and paying it (gate join_gym)
 *   meDues         /me/gym-dues              my outstanding dues and paying one (gate join_gym)
 *   adminRouter    owners, owner detail, invoices, void (step-up escrow.manage), founding partner and fee
 *                  overrides (master, step-up settings.write)
 * Prompt 3 (public site, member area, plans):
 *   manageRouter   join requests accept (IK) and decline; trainers and the member's trainer; plans and diet
 *                  charts (list, create, read, edit, retire, assign, end) and a member's plans; the
 *                  entrance tablet token (no-store)
 *   meJoins        /me/gym-join-requests     ask to join a live gym (gate join_gym)
 *   meRequests     … and cancel my pending join request
 *   mePlans        /me/gym-plans             today's workout and meals, the week, one plan, ticks
 *   meCheckins     /me/gym-checkins          scan the entrance QR (gate join_gym)
 */
const express = require('express');
const { Router } = express;
const { validate } = require('../../common/validate');
const { requireIdempotencyKey } = require('../../common/idempotency');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, optionalAuth, requireStaff, requireAnyPermission, requireMaster, requireStepUp, requireGate } = require('../../middlewares/auth');
const s = require('./gym-manage.schemas');
const gyms = require('./gyms.service');
const members = require('./members.service');
const links = require('./links.service');
const ms = require('./memberships.service');
const dues = require('./dues.service');
const checkins = require('./checkins.service');
const imports = require('./imports.service');
const billing = require('./billing.service');
const me = require('./me.service');
const linksPay = require('./links-pay.service');
const reminders = require('./reminders.service');
const reports = require('./reports.service');
const invoices = require('./invoices.service');
const fees = require('./fees.service');
const joins = require('./joins.service');
const trainers = require('./trainers.service');
const plans = require('./plans.service');

const params = (schema) => validate(schema, 'params');
const query = (schema) => validate(schema, 'query');
const ik = (action) => requireIdempotencyKey(`gym_manage.${action}`);
// The hard ceilings are the top of the settings' bounds (photos: ground.photo_max_bytes; imports:
// gym_manage.import_max_bytes, 20 MB); the settings themselves are checked per upload.
const raw = express.raw({ type: () => true, limit: '20mb' });
const noStore = (res) => res.set('Cache-Control', 'no-store');
const sendCsv = (res, { filename, body }) =>
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${filename}"`).set('Cache-Control', 'no-store').send(body);

/** Send a stored private file: inline, never cached, never sniffed. */
function sendFile(res, { body, mime }) {
  res.set('Content-Type', mime).set('Content-Disposition', 'inline').set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff');
  if (Buffer.isBuffer(body)) return res.send(body);
  return body.pipe(res);
}

// ---------------- owner and staff panel
const manageRouter = Router();
manageRouter.use(authenticate);
const work = requireGate('work_gym');
const run = requireGate('run_gym');

manageRouter.get('/billing', run, async (req, res) => res.json(await billing.get(req.user)));
manageRouter.put('/billing/tier', run, validate(s.tierBody), async (req, res) => res.json(await billing.setTier(req.user, req.body, req)));
// Prompt 2: the owner's invoices (M24-FR-84, FR-85) and the all-gyms reports (FR-74).
manageRouter.get('/billing/invoices', run, async (req, res) => res.json(await invoices.mine(req.user)));
manageRouter.get('/billing/invoices/:invoiceId', run, params(s.invoiceParam), async (req, res) => res.json(await invoices.mineOne(req.user, req.params.invoiceId)));
manageRouter.post('/billing/invoices/:invoiceId/pay', run, params(s.invoiceParam), ik('invoice_pay'), async (req, res) => res.status(201).json(await invoices.pay(req.user, req.params.invoiceId, req.idempotencyKey)));
manageRouter.get('/reports', run, query(s.reportQuery), async (req, res) => res.json(await reports.allGyms(req.user, req.validQuery)));

manageRouter.get('/gyms', work, async (req, res) => res.json(await gyms.listMine(req.user)));
const g = Router({ mergeParams: true });
manageRouter.use('/gyms/:gymId', work, params(s.gymParam), g);
const P = (req) => req.params.gymId;

g.get('/overview', async (req, res) => res.json(await gyms.overview(req.user, P(req))));
g.get('/packages', async (req, res) => res.json(await gyms.packages(req.user, P(req))));
g.get('/settings', async (req, res) => res.json(await gyms.getSettings(req.user, P(req))));
g.patch('/settings', validate(s.settingsPatch), async (req, res) => res.json(await gyms.patchSettings(req.user, P(req), req.body, req)));

// Desk and check-ins (attendance.mark; check-ins need the attendance feature, M24-FR-07).
g.get('/desk/search', query(s.deskSearchQuery), async (req, res) => res.json(await checkins.search(req.user, P(req), req.validQuery)));
g.post('/checkins', validate(s.checkinBody), async (req, res) => {
  const r = await checkins.checkIn(req.user, P(req), req.body, req);
  res.status(r.status).json(r.body);
});
g.get('/checkins', query(s.dayQuery), async (req, res) => res.json(await checkins.day(req.user, P(req), req.validQuery)));
// Prompt 3: the entrance tablet's rotating token (M24-FR-51).
g.get('/entrance-token', async (req, res) => {
  noStore(res);
  res.json(await checkins.entranceToken(req.user, P(req)));
});

// Members.
g.get('/members', query(s.membersQuery), async (req, res) => res.json(await members.list(req.user, P(req), req.validQuery)));
g.post('/members', validate(s.memberBody), ik('member_add'), async (req, res) => res.status(201).json(await members.add(req.user, P(req), req.body, req)));
const mp = params(s.memberParam);
const M = (req) => req.params.memberId;
g.get('/members/:memberId', mp, async (req, res) => res.json(await members.get(req.user, P(req), M(req))));
g.patch('/members/:memberId', mp, validate(s.memberPatch), async (req, res) => res.json(await members.update(req.user, P(req), M(req), req.body, req)));
g.post('/members/:memberId/reveal-phone', mp, async (req, res) => {
  noStore(res);
  res.json(await members.revealPhone(req.user, P(req), M(req), req));
});
g.post('/members/:memberId/invite', mp, validate(s.inviteBody), async (req, res) => res.status(201).json(await links.invite(req.user, P(req), M(req), req.body, req)));
g.post('/members/:memberId/unlink', mp, async (req, res) => res.json(await links.unlinkByGym(req.user, P(req), M(req), req)));
g.post('/members/:memberId/leave', mp, validate(s.leaveBody), async (req, res) => res.json(await members.leave(req.user, P(req), M(req), req.body, req)));
g.post('/members/:memberId/rejoin', mp, async (req, res) => res.json(await members.rejoin(req.user, P(req), M(req), req)));
g.post('/members/:memberId/remove', mp, validate(s.reasonBody), async (req, res) => res.json(await members.remove(req.user, P(req), M(req), req.body, req)));
g.get('/members/:memberId/notes', mp, async (req, res) => res.json(await members.notes(req.user, P(req), M(req))));
g.post('/members/:memberId/notes', mp, validate(s.noteBody), async (req, res) => res.status(201).json(await members.addNote(req.user, P(req), M(req), req.body, req)));
g.get('/members/:memberId/attendance', mp, query(s.monthQuery), async (req, res) => res.json(await members.attendance(req.user, P(req), M(req), req.validQuery)));
g.put('/members/:memberId/photo', mp, raw, async (req, res) => res.json(await members.setPhoto(req.user, P(req), M(req), { contentType: req.get('content-type'), body: req.body }, req)));
g.get('/members/:memberId/photo', mp, async (req, res) => sendFile(res, await members.getPhoto(req.user, P(req), M(req))));
g.post('/members/:memberId/memberships', mp, validate(s.assignBody), ik('membership_assign'), async (req, res) => res.status(201).json(await ms.assign(req.user, P(req), M(req), req.body, req)));
// Prompt 3: trainers (M24-FR-21) and a member's plans (FR-66).
g.get('/trainers', async (req, res) => res.json(await trainers.list(req.user, P(req))));
g.put('/members/:memberId/trainer', mp, validate(s.trainerBody), async (req, res) => res.json(await trainers.assign(req.user, P(req), M(req), req.body, req)));
g.get('/members/:memberId/plans', mp, async (req, res) => res.json(await plans.memberPlans(req.user, P(req), M(req))));

// Requests: join requests (prompt 3, M24-FR-16, FR-17) and gym invites.
const rp = params(s.requestParam);
g.get('/requests', query(s.requestsQuery), async (req, res) => res.json(await links.listForGym(req.user, P(req), req.validQuery)));
g.post('/requests/:requestId/accept', rp, validate(s.joinAcceptBody), ik('join_accept'), async (req, res) => res.json(await joins.accept(req.user, P(req), req.params.requestId, req.body, req)));
g.post('/requests/:requestId/decline', rp, validate(s.joinDeclineBody), async (req, res) => res.json(await joins.decline(req.user, P(req), req.params.requestId, req.body, req)));
g.post('/requests/:requestId/cancel', rp, async (req, res) => res.json(await links.cancel(req.user, P(req), req.params.requestId, req)));

// Prompt 3: workout plans and diet charts (M24-FR-62 to FR-64).
const pp = params(s.planParam);
const PL = (req) => req.params.planId;
g.get('/plans', query(s.plansQuery), async (req, res) => res.json(await plans.list(req.user, P(req), req.validQuery)));
g.post('/plans', validate(s.planBody), async (req, res) => res.status(201).json(await plans.create(req.user, P(req), req.body, req)));
g.get('/plans/:planId', pp, async (req, res) => res.json(await plans.get(req.user, P(req), PL(req))));
g.patch('/plans/:planId', pp, validate(s.planPatch), async (req, res) => res.json(await plans.update(req.user, P(req), PL(req), req.body, req)));
g.post('/plans/:planId/retire', pp, async (req, res) => res.json(await plans.retire(req.user, P(req), PL(req), req)));
g.post('/plans/:planId/assign', pp, validate(s.planAssignBody), async (req, res) => res.status(201).json(await plans.assign(req.user, P(req), PL(req), req.body, req)));
g.post('/plan-assignments/:assignmentId/end', params(s.assignmentParam), async (req, res) => res.json(await plans.end(req.user, P(req), req.params.assignmentId, req)));

// Memberships.
const msp = params(s.membershipParam);
const MS = (req) => req.params.membershipId;
g.post('/memberships/:membershipId/renew', msp, validate(s.renewBody), ik('membership_renew'), async (req, res) => res.status(201).json(await ms.renew(req.user, P(req), MS(req), req.body, req)));
g.post('/memberships/:membershipId/freeze', msp, validate(s.freezeBody), async (req, res) => res.json(await ms.freeze(req.user, P(req), MS(req), req.body, req)));
g.post('/memberships/:membershipId/unfreeze', msp, async (req, res) => res.json(await ms.unfreeze(req.user, P(req), MS(req), req)));
g.post('/memberships/:membershipId/change', msp, validate(s.changeBody), ik('membership_change'), async (req, res) => res.status(201).json(await ms.change(req.user, P(req), MS(req), req.body, req)));
g.post('/memberships/:membershipId/cancel', msp, validate(s.reasonBody), async (req, res) => res.json(await ms.cancel(req.user, P(req), MS(req), req.body, req)));

// Dues, counter payments and receipts.
g.get('/dues', query(s.duesQuery), async (req, res) => res.json(await dues.list(req.user, P(req), req.validQuery)));
const dp = params(s.dueParam);
g.post('/dues/:dueId/payments', dp, validate(s.paymentBody), ik('payment'), async (req, res) => res.status(201).json(await dues.pay(req.user, P(req), req.params.dueId, req.body, req)));
g.post('/dues/:dueId/waive', dp, validate(s.waiveBody), async (req, res) => res.json(await dues.waive(req.user, P(req), req.params.dueId, req.body, req)));
const fp = params(s.feePaymentParam);
g.post('/fee-payments/:feePaymentId/reverse', fp, validate(s.reasonBody), ik('reversal'), async (req, res) => res.status(201).json(await dues.reverse(req.user, P(req), req.params.feePaymentId, req.body, req)));
g.get('/fee-payments/:feePaymentId/receipt', fp, async (req, res) => res.json(await dues.receipt(req.user, P(req), req.params.feePaymentId)));
g.get('/cash-closing', query(s.dayQuery), async (req, res) => res.json(await dues.cashClosing(req.user, P(req), req.validQuery)));

// Prompt 2: payment links (M24-FR-40), online refunds from the hold (owner, FR-44).
g.get('/payment-links', query(s.linksQuery), async (req, res) => res.json(await linksPay.list(req.user, P(req), req.validQuery)));
g.post('/dues/:dueId/payment-links', dp, validate(s.linkBody), ik('payment_link'), async (req, res) => res.status(201).json(await linksPay.create(req.user, P(req), req.params.dueId, req.body, req)));
g.post('/payment-links/:linkId/cancel', params(s.linkParam), async (req, res) => res.json(await linksPay.cancel(req.user, P(req), req.params.linkId, req)));
g.post('/fee-payments/:feePaymentId/refund', fp, validate(s.refundBody), ik('fee_refund'), async (req, res) => res.status(201).json(await linksPay.refund(req.user, P(req), req.params.feePaymentId, req.body, req)));

// Prompt 2: reminders page (owner, FR-59, FR-61), reports (FR-71), not-seen list (FR-53), exports (owner, FR-73).
g.get('/reminders', async (req, res) => res.json(await reminders.page(req.user, P(req))));
g.get('/reports', query(s.reportQuery), async (req, res) => res.json(await reports.gymReport(req.user, P(req), req.validQuery)));
g.get('/reports/absent', async (req, res) => res.json(await reports.absent(req.user, P(req))));
g.get('/reports/export', query(s.exportQuery), async (req, res) => sendCsv(res, await reports.exportCsv(req.user, P(req), req.validQuery, req)));

// Imports (owner) and the owner's consent for Kriraghor uploads.
g.get('/imports', async (req, res) => res.json(await imports.list(req.user, P(req))));
g.post('/imports', query(s.importQuery), raw, async (req, res) => res.status(201).json(await imports.upload(req.user, P(req), { body: req.body, contentType: req.get('content-type'), fileName: req.validQuery.fileName }, req)));
const ip = params(s.importParam);
const I = (req) => req.params.importId;
g.get('/imports/:importId', ip, async (req, res) => res.json(await imports.get(req.user, P(req), I(req))));
g.post('/imports/:importId/apply', ip, ik('import_apply'), async (req, res) => res.json(await imports.apply(req.user, P(req), I(req), req)));
g.post('/imports/:importId/undo', ip, async (req, res) => res.json(await imports.undo(req.user, P(req), I(req), req)));
g.post('/imports/:importId/discard', ip, async (req, res) => res.json(await imports.discard(req.user, P(req), I(req), req)));
g.post('/imports/:importId/send-invites', ip, async (req, res) => res.json(await imports.sendInvites(req.user, P(req), I(req), req)));
g.put('/import-consent', validate(s.consentBody), async (req, res) => res.json(await imports.consent(req.user, P(req), req.body, req)));

// ---------------- public
const pricingRouter = Router();
pricingRouter.get('/pricing', async (req, res) => res.json(await billing.pricing()));

const receiptRouter = Router();
receiptRouter.get('/:token', params(s.tokenParam), async (req, res) => {
  res.set('X-Robots-Tag', 'noindex');
  res.json(await dues.publicReceipt(req.params.token));
});

// Prompt 2: the payment-link page (public, noindex) and paying it (gate join_gym, M24-FR-41).
const payRouter = Router();
payRouter.get('/:token', optionalAuth, params(s.tokenParam), async (req, res) => {
  res.set('X-Robots-Tag', 'noindex');
  noStore(res);
  res.json(await linksPay.summary(req.params.token, req.user));
});
payRouter.post('/:token/pay', authenticate, requireGate('join_gym'), params(s.tokenParam), validate(s.payLinkBody), ik('link_pay'), async (req, res) =>
  res.status(201).json(await linksPay.payLink(req.user, req.params.token, req.body, req.idempotencyKey))
);

// ---------------- member
const meDues = Router();
meDues.use(authenticate);
meDues.get('/', async (req, res) => res.json(await linksPay.myDues(req.user)));
meDues.post('/:dueId/pay', requireGate('join_gym'), params(s.meDueParam), ik('due_pay'), async (req, res) => res.status(201).json(await linksPay.payMyDue(req.user, req.params.dueId, req.idempotencyKey)));

const meRequests = Router();
meRequests.use(authenticate);
meRequests.get('/', query(s.meRequestsQuery), async (req, res) => res.json(await links.mine(req.user, req.validQuery)));
meRequests.post('/:requestId/accept', requireGate('join_gym'), params(s.meRequestParam), async (req, res) => res.json(await links.accept(req.user, req.params.requestId, req)));
meRequests.post('/:requestId/decline', params(s.meRequestParam), async (req, res) => res.json(await links.decline(req.user, req.params.requestId, req)));
meRequests.post('/:requestId/cancel', params(s.meRequestParam), async (req, res) => res.json(await joins.cancelMine(req.user, req.params.requestId, req)));

// Prompt 3: ask to join a gym (gate join_gym; M24-FR-16).
const meJoins = Router();
meJoins.use(authenticate);
meJoins.post('/', requireGate('join_gym'), validate(s.joinRequestBody), async (req, res) => res.status(201).json(await joins.create(req.user, req.body, req)));

// Prompt 3: my plans and diet charts (M24-FR-65 to FR-69).
const mePlans = Router();
mePlans.use(authenticate);
const mpl = params(s.mePlanParam);
mePlans.get('/', async (req, res) => res.json(await plans.myPlans(req.user)));
mePlans.get('/:assignmentId', mpl, async (req, res) => res.json(await plans.myPlan(req.user, req.params.assignmentId)));
mePlans.post('/:assignmentId/logs', mpl, validate(s.planLogBody), async (req, res) => res.status(201).json(await plans.addLog(req.user, req.params.assignmentId, req.body, req)));

// Prompt 3: scan the entrance QR (gate join_gym; M24-FR-51).
const meCheckins = Router();
meCheckins.use(authenticate);
meCheckins.post('/', requireGate('join_gym'), validate(s.meCheckinBody), async (req, res) => {
  const r = await checkins.memberCheckIn(req.user, req.body, req);
  res.status(r.status).json(r.body);
});

const meMemberships = Router();
meMemberships.use(authenticate);
const mm = params(s.meMemberParam);
meMemberships.get('/', async (req, res) => res.json(await me.list(req.user)));
meMemberships.get('/:memberId', mm, async (req, res) => res.json(await me.detail(req.user, req.params.memberId)));
meMemberships.get('/:memberId/attendance', mm, query(s.monthQuery), async (req, res) => res.json(await me.attendance(req.user, req.params.memberId, req.validQuery)));
meMemberships.get('/:memberId/checkin-token', mm, async (req, res) => {
  noStore(res);
  res.json(await me.checkinToken(req.user, req.params.memberId));
});
meMemberships.put('/:memberId/health-note', mm, validate(s.healthNoteBody), async (req, res) => res.json(await me.setHealthNote(req.user, req.params.memberId, req.body, req)));
meMemberships.post('/:memberId/unlink', mm, async (req, res) => res.json(await links.unlinkByMember(req.user, req.params.memberId, req)));

const meReceipts = Router();
meReceipts.use(authenticate);
meReceipts.get('/', async (req, res) => res.json(await me.receipts(req.user)));
meReceipts.get('/:feePaymentId', params(s.meReceiptParam), async (req, res) => res.json(await me.receipt(req.user, req.params.feePaymentId)));

// ---------------- Kriraghor staff
const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff);
adminRouter.post('/gyms/:gymId/imports', requireAnyPermission(PERMISSIONS.MANAGE_GYMS), params(s.gymParam), query(s.importQuery), raw, async (req, res) =>
  res.status(201).json(await imports.adminUpload(req.user, req.params.gymId, { body: req.body, contentType: req.get('content-type'), fileName: req.validQuery.fileName }, req))
);
// Prompt 2 (§4.4, §9.2): owners and invoices (manage_gyms or view_payouts read); masters write with step-up.
const reads = requireAnyPermission(PERMISSIONS.MANAGE_GYMS, PERMISSIONS.VIEW_PAYOUTS);
adminRouter.get('/owners', reads, query(s.adminOwnersQuery), async (req, res) => res.json(await invoices.owners(req.validQuery)));
adminRouter.get('/owners/:ownerId', reads, params(s.ownerParam), async (req, res) => res.json(await invoices.ownerDetail(req.params.ownerId)));
adminRouter.put('/owners/:ownerId/founding-partner', requireMaster, params(s.ownerParam), validate(s.foundingBody), requireStepUp('settings.write'), async (req, res) =>
  res.json(await invoices.setFounding(req.user, req.params.ownerId, req.body, req))
);
adminRouter.get('/invoices', reads, query(s.adminInvoicesQuery), async (req, res) => res.json(await invoices.adminInvoices(req.validQuery)));
adminRouter.post('/invoices/:invoiceId/void', requireMaster, params(s.invoiceParam), validate(s.reasonBody), requireStepUp('escrow.manage'), async (req, res) =>
  res.json(await invoices.voidInvoice(req.user, req.params.invoiceId, req.body, req))
);
adminRouter.get('/fee-overrides', requireAnyPermission(PERMISSIONS.MANAGE_GYMS), query(s.overridesQuery), async (req, res) => res.json(await fees.listOverrides(req.validQuery)));
adminRouter.post('/fee-overrides', requireMaster, validate(s.overrideBody), requireStepUp('settings.write'), async (req, res) => res.status(201).json(await fees.createOverride(req.user, req.body, req)));
adminRouter.post('/fee-overrides/:overrideId/end', requireMaster, params(s.overrideParam), validate(s.reasonBody), requireStepUp('settings.write'), async (req, res) =>
  res.json(await fees.endOverride(req.user, req.params.overrideId, req.body, req))
);

module.exports = { manageRouter, pricingRouter, receiptRouter, payRouter, meDues, meRequests, meJoins, mePlans, meCheckins, meMemberships, meReceipts, adminRouter };
