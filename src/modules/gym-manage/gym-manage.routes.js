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
 */
const express = require('express');
const { Router } = express;
const { validate } = require('../../common/validate');
const { requireIdempotencyKey } = require('../../common/idempotency');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, requireStaff, requireAnyPermission, requireGate } = require('../../middlewares/auth');
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

const params = (schema) => validate(schema, 'params');
const query = (schema) => validate(schema, 'query');
const ik = (action) => requireIdempotencyKey(`gym_manage.${action}`);
// The hard ceilings are the top of the settings' bounds (photos: ground.photo_max_bytes; imports:
// gym_manage.import_max_bytes, 20 MB); the settings themselves are checked per upload.
const raw = express.raw({ type: () => true, limit: '20mb' });
const noStore = (res) => res.set('Cache-Control', 'no-store');

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

manageRouter.get('/gyms', work, async (req, res) => res.json(await gyms.listMine(req.user)));
const g = Router({ mergeParams: true });
manageRouter.use('/gyms/:gymId', work, params(s.gymParam), g);
const P = (req) => req.params.gymId;

g.get('/overview', async (req, res) => res.json(await gyms.overview(req.user, P(req))));
g.get('/settings', async (req, res) => res.json(await gyms.getSettings(req.user, P(req))));
g.patch('/settings', validate(s.settingsPatch), async (req, res) => res.json(await gyms.patchSettings(req.user, P(req), req.body, req)));

// Desk and check-ins (attendance.mark; check-ins need the attendance feature, M24-FR-07).
g.get('/desk/search', query(s.deskSearchQuery), async (req, res) => res.json(await checkins.search(req.user, P(req), req.validQuery)));
g.post('/checkins', validate(s.checkinBody), async (req, res) => {
  const r = await checkins.checkIn(req.user, P(req), req.body, req);
  res.status(r.status).json(r.body);
});
g.get('/checkins', query(s.dayQuery), async (req, res) => res.json(await checkins.day(req.user, P(req), req.validQuery)));

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

// Requests (gym invites; join requests in prompt 3).
g.get('/requests', query(s.requestsQuery), async (req, res) => res.json(await links.listForGym(req.user, P(req), req.validQuery)));
g.post('/requests/:requestId/cancel', params(s.requestParam), async (req, res) => res.json(await links.cancel(req.user, P(req), req.params.requestId, req)));

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
pricingRouter.get('/pricing', (req, res) => res.json(billing.pricing()));

const receiptRouter = Router();
receiptRouter.get('/:token', params(s.tokenParam), async (req, res) => {
  res.set('X-Robots-Tag', 'noindex');
  res.json(await dues.publicReceipt(req.params.token));
});

// ---------------- member
const meRequests = Router();
meRequests.use(authenticate);
meRequests.get('/', query(s.meRequestsQuery), async (req, res) => res.json(await links.mine(req.user, req.validQuery)));
meRequests.post('/:requestId/accept', requireGate('join_gym'), params(s.meRequestParam), async (req, res) => res.json(await links.accept(req.user, req.params.requestId, req)));
meRequests.post('/:requestId/decline', params(s.meRequestParam), async (req, res) => res.json(await links.decline(req.user, req.params.requestId, req)));

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

module.exports = { manageRouter, pricingRouter, receiptRouter, meRequests, meMemberships, meReceipts, adminRouter };
