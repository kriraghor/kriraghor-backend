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
const guests = require('./guests.service');

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
// Prompt 3b, the SMS add-on (M24-FR-96 to FR-99): switch on or off, buy bundles, the entries.
manageRouter.put('/billing/sms-addon', run, validate(s.smsAddonBody), async (req, res) => res.json(await require('./sms.service').setAddon(req.user, req.body, req)));
manageRouter.post('/billing/sms-bundles', run, validate(s.smsBundlesBody), ik('sms_bundle'), async (req, res) => res.status(201).json(await require('./sms.service').buyBundles(req.user, req.body, req.idempotencyKey)));
manageRouter.get('/billing/sms-entries', run, query(s.smsEntriesQuery), async (req, res) => res.json(await require('./sms.service').entries(req.user, req.validQuery)));
manageRouter.get('/billing/invoices/:invoiceId', run, params(s.invoiceParam), async (req, res) => res.json(await invoices.mineOne(req.user, req.params.invoiceId)));
manageRouter.post('/billing/invoices/:invoiceId/pay', run, params(s.invoiceParam), ik('invoice_pay'), async (req, res) => res.status(201).json(await invoices.pay(req.user, req.params.invoiceId, req.idempotencyKey)));
manageRouter.get('/reports', run, query(s.reportQuery), async (req, res) => res.json(await reports.allGyms(req.user, req.validQuery)));

manageRouter.get('/gyms', work, async (req, res) => res.json(await gyms.listMine(req.user)));

// M24 §21 desk mode (ADR-010): this device's desk. The auth guard lets these through on a desk device as the
// sign-in that opened it (req.desk); unlock, lock, touch and close need an open desk on this device.
const desk = require('./desk.service');
const fresh = (_req, res, next) => (res.set('Cache-Control', 'no-store'), next());
const onDesk = (req, _res, next) => next(req.desk ? undefined : require('./gym-manage.common').fail('GYM_DESK_STATE', { reason: 'not_open' }));
manageRouter.get('/desk-mode', work, fresh, async (req, res) => res.json(await desk.state(req.user, req.auth)));
manageRouter.post('/desk-mode/unlock', work, fresh, onDesk, validate(s.deskTryBody), async (req, res) => res.json(await desk.unlock(req, req.body)));
manageRouter.post('/desk-mode/lock', work, fresh, onDesk, async (req, res) => res.json(await desk.lock(req)));
manageRouter.post('/desk-mode/touch', work, fresh, onDesk, async (req, res) => res.json(await desk.touch(req)));
manageRouter.post('/desk-mode/close', work, fresh, onDesk, validate(s.deskTryBody), async (req, res) => res.json(await desk.close(req, req.body)));
const g = Router({ mergeParams: true });
manageRouter.use('/gyms/:gymId', work, params(s.gymParam), (req, res, next) => require('./gym-manage.common').frozenWrites(req, res, next), g);
const P = (req) => req.params.gymId;

g.get('/overview', async (req, res) => res.json(await gyms.overview(req.user, P(req))));
g.get('/packages', async (req, res) => res.json(await gyms.packages(req.user, P(req))));
g.get('/settings', async (req, res) => res.json(await gyms.getSettings(req.user, P(req))));
g.patch('/settings', validate(s.settingsPatch), async (req, res) => res.json(await gyms.patchSettings(req.user, P(req), req.body, req)));

// Desk mode (M24 §21): switch it on for this device; the owner's view of PINs and desks, clearing a PIN and
// ending desk mode elsewhere (owner only, so never from a desk device).
g.post('/desk-mode/open', fresh, async (req, res) => res.status(201).json(await desk.open(req.user, req.auth, P(req), req)));
g.get('/desk', fresh, async (req, res) => res.json(await desk.overview(req.user, P(req))));
g.post('/desk-pins/:userId/reset', validate(s.deskPersonParam, 'params'), async (req, res) => res.json(await desk.resetPin(req.user, P(req), req.params.userId, req)));
g.post('/desk-mode/end', async (req, res) => res.json(await desk.endByOwner(req.user, P(req), req)));

// Desk and check-ins (attendance.mark; check-ins need the attendance feature, M24-FR-07).
g.get('/desk/search', query(s.deskSearchQuery), async (req, res) => res.json(await checkins.search(req.user, P(req), req.validQuery)));
// M24 §22 the desk through a lost connection: the desk copy, items taken offline, the owner's list.
const offline = require('./offline.service');
g.get('/desk/snapshot', fresh, async (req, res) => res.json(await offline.snapshot(req.user, P(req))));
g.post('/desk/offline-items', validate(s.offlineItemBody), ik('offline_item'), async (req, res) => {
  const r = await offline.send(req.user, P(req), req.body, req);
  res.status(r.status).json(r.body);
});
g.get('/desk/offline-items', query(s.offlineItemsQuery), async (req, res) => res.json(await offline.list(req.user, P(req), req.validQuery)));
g.post('/desk/offline-items/:itemId/resolve', params(s.offlineItemParam), validate(s.offlineResolveBody), async (req, res) => res.json(await offline.resolve(req.user, P(req), req.params.itemId, req.body, req)));
// M27-FR-40: the desk checks a member out.
g.post('/checkins/:attendanceId/out', validate(s.attendanceParam, 'params'), async (req, res) => res.json(await require('./visits.service').checkOut(req.user, P(req), req.params.attendanceId, req)));
// Trial visits (product owner, 9 Nov 2026): today's guests, check in, cancel, the phone, make a member.
const vp = params(s.visitParam);
g.get('/visits', query(s.visitsQuery), async (req, res) => res.json(await guests.list(req.user, P(req), req.validQuery)));
g.post('/visits/:visitId/check-in', vp, async (req, res) => res.json(await guests.checkIn(req.user, P(req), req.params.visitId, req)));
g.post('/visits/:visitId/cancel', vp, validate(s.visitCancelBody), async (req, res) => res.json(await guests.cancelByGym(req.user, P(req), req.params.visitId, req.body, req)));
g.post('/visits/:visitId/reveal-phone', vp, async (req, res) => {
  noStore(res);
  res.json(await guests.revealPhone(req.user, P(req), req.params.visitId, req));
});
g.post('/visits/:visitId/convert', vp, async (req, res) => res.status(201).json(await guests.convert(req.user, P(req), req.params.visitId, req)));
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
// M24 §20: a member's body progress (owner and plans.manage; feature progress).
g.get('/members/:memberId/body', mp, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await require('./body.service').forMember(req.user, P(req), M(req)));
});
g.post('/members/:memberId/body', mp, validate(s.bodyEntryBody), ik('body_entry_staff'), async (req, res) => res.status(201).json(await require('./body.service').addFor(req.user, P(req), M(req), req.body, req)));
g.post('/members/:memberId/body/:entryId/void', params(s.bodyEntryParam), async (req, res) => res.json(await require('./body.service').voidFor(req.user, P(req), M(req), req.params.entryId, req)));
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
g.get('/reports/absent', query(s.absentQuery), async (req, res) => res.json(await reports.absent(req.user, P(req), req.validQuery)));
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

// Trial visits: book a free visit (gate join_gym), my visits with the QR, cancel.
// M24 §21: my own desk PIN at each gym I work at (FR-134). Never on a desk device (the guard refuses /me here).
const meDeskPins = Router();
meDeskPins.use(authenticate, requireGate('work_gym'));
meDeskPins.get('/', fresh, async (req, res) => res.json(await desk.myPins(req.user)));
meDeskPins.put('/', fresh, validate(s.deskPinBody), async (req, res) => res.json(await desk.setPin(req.user, req.body, req)));

const meVisits = Router();
meVisits.use(authenticate);
meVisits.get('/', async (req, res) => {
  noStore(res);
  res.json(await guests.mine(req.user));
});
meVisits.post('/', requireGate('join_gym'), validate(s.visitBody), ik('visit_book'), async (req, res) => res.status(201).json(await guests.book(req.user, req.body, req)));
meVisits.post('/:visitId/cancel', params(s.meVisitParam), async (req, res) => res.json(await guests.cancelMine(req.user, req.params.visitId, req)));

// Trial visits on the gym page (no sign-in): the days ahead with their hours and places left.
const publicVisits = Router();
publicVisits.get('/gyms/:slug/visit-slots', params(s.visitSlugParam), async (req, res) => res.set('Cache-Control', 'public, max-age=60').json(await guests.slots(req.params.slug)));

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
// M27-FR-30: blood group, height, weight, conditions (the member's own; encrypted conditions).
meMemberships.put('/:memberId/health', mm, validate(s.healthBody), async (req, res) => res.json(await me.setHealth(req.user, req.params.memberId, req.body, req)));
// M24 §19: renew my own membership (pay online or at the counter), and take a renewal back.
meMemberships.get('/:memberId/renewal', mm, async (req, res) => res.json(await require('./renewals.service').options(req.user, req.params.memberId)));
meMemberships.post('/:memberId/renew', requireGate('join_gym'), mm, validate(s.renewMineBody), ik('self_renew'), async (req, res) =>
  res.status(201).json(await require('./renewals.service').renew(req.user, req.params.memberId, req.body, req.idempotencyKey, req))
);
meMemberships.post('/:memberId/renewal/cancel', mm, async (req, res) => res.json(await require('./renewals.service').cancel(req.user, req.params.memberId, req)));
// M24 §20: my body progress.
meMemberships.get('/:memberId/body', mm, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await require('./body.service').mine(req.user, req.params.memberId));
});
meMemberships.post('/:memberId/body', mm, validate(s.bodyEntryBody), ik('body_entry'), async (req, res) => res.status(201).json(await require('./body.service').addMine(req.user, req.params.memberId, req.body, req)));
meMemberships.post('/:memberId/body/:entryId/void', params(s.meBodyEntryParam), async (req, res) => res.json(await require('./body.service').voidMine(req.user, req.params.memberId, req.params.entryId, req)));
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
adminRouter.post('/owners/:ownerId/sms-adjust', requireMaster, params(s.ownerParam), validate(s.smsAdjustBody), requireStepUp('settings.write'), async (req, res) =>
  res.json(await require('./sms.service').adjust(req.user, req.params.ownerId, req.body, req))
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

module.exports = { manageRouter, pricingRouter, receiptRouter, payRouter, meDues, meRequests, meJoins, meVisits, meDeskPins, publicVisits, mePlans, meCheckins, meMemberships, meReceipts, adminRouter };
