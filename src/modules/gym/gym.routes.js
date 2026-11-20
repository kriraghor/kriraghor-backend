'use strict';

/**
 * M20 routes (§9), step 1.
 *   publicRouter   /gym                 gyms, a gym page, fitness trainers and their plans; buy a pass
 *                                       (gate buy_gym_pass) and subscribe to a plan (gate subscribe_trainer)
 *   mePasses       /me/passes           my passes, one with its QR token and backup code, cancel
 *   meSubs         /me/subscriptions    my trainer subscriptions: renew, cancel, report a problem (M17)
 *   ownerRouter    /me/gyms             the owner's gyms, hours, packages, photos (gate run_gym, M24), review,
 *                                       pause and resume (gate list_gym);
 *                                       the front desk (redemptions) and passes sold (gate work_gym, Round B3:
 *                                       the owner or the gym's staff, by permission)
 *   proPlans       /pro/trainer-plans   a fitness trainer's monthly plans
 *   proSubs        /pro/subscriptions   the trainer's subscribers
 *   adminRouter    /admin/gym           gyms (suspend, restore), a pass or subscription with its escrow,
 *                                       a master's platform cancel of a pass
 * Decisions on listings are M05's (/admin/submissions, kind `gym`).
 */
const crypto = require('crypto');
const express = require('express');
const { Router } = express;
const { validate } = require('../../common/validate');
const { sendCached } = require('../../common/http-cache');
const { requireIdempotencyKey } = require('../../common/idempotency');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, optionalAuth, requireStaff, requireAnyPermission, requireMaster, requireStepUp, requireGate } = require('../../middlewares/auth');
const limits = require('../../middlewares/rateLimit');
require('./gym.moderation'); // the M05 adapter loads with the routes
const gyms = require('./gyms.service');
const pub = require('./public.service');
const specialDays = require('./special-days.service');
const passes = require('./passes.service');
const desk = require('./desk.service');
const subs = require('./subscriptions.service');
const admin = require('./gym.admin');
const s = require('./gym.schemas');

const id = validate(s.idParam, 'params');
// The hard ceiling is the top of ground.photo_max_bytes (20 MB); the setting is checked per photo.
const raw = express.raw({ type: () => true, limit: '20mb' });

// ---------------- public
const publicRouter = Router();
publicRouter.get('/gyms', validate(s.listQuery, 'query'), async (req, res) => res.json(await pub.list(req.validQuery)));
publicRouter.get('/gyms/:slug', validate(s.slugParam, 'params'), async (req, res) => {
  const body = await pub.detail(req.params.slug);
  sendCached(req, res, body, crypto.createHash('sha1').update(JSON.stringify({ ...body, openNow: undefined, specialToday: undefined })).digest('hex'));
});
publicRouter.get('/trainers', optionalAuth, validate(s.trainersQuery, 'query'), async (req, res) => res.json(await pub.trainers(req.validQuery, req.user?.id ?? null)));
publicRouter.get('/trainers/:id/plans', id, async (req, res) => res.json(await subs.plansOf(req.params.id)));
publicRouter.post('/passes', authenticate, requireGate('buy_gym_pass'), validate(s.buyBody), requireIdempotencyKey('gym.pass'), async (req, res) =>
  res.status(201).json(await passes.buy(req.user, req.body, req.idempotencyKey, req))
);
publicRouter.post('/subscriptions', authenticate, requireGate('subscribe_trainer'), validate(s.subscribeBody), requireIdempotencyKey('gym.subscription'), async (req, res) =>
  res.status(201).json(await subs.subscribe(req.user, req.body, req.idempotencyKey, req))
);

// ---------------- member
const mePasses = Router();
mePasses.use(authenticate);
mePasses.get('/', validate(s.passesQuery, 'query'), async (req, res) => res.json(await passes.listMine(req.user, req.validQuery)));
mePasses.get('/:code', validate(s.codeParam, 'params'), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await passes.getMine(req.user, req.params.code));
});
mePasses.post('/:id/cancel', id, async (req, res) => res.json(await passes.cancel(req.user, req.params.id, req)));

const meSubs = Router();
meSubs.use(authenticate);
meSubs.get('/', async (req, res) => res.json(await subs.listFor(req.user, 'member')));
meSubs.get('/:id', validate(s.idOrCodeParam, 'params'), async (req, res) => res.json(await subs.getOne(req.user, req.params.id)));
meSubs.post('/:id/renew', id, async (req, res) => res.json(await subs.renew(req.user, req.params.id)));
meSubs.post('/:id/cancel', id, async (req, res) => res.json(await subs.cancel(req.user, req.params.id, req)));
meSubs.post('/:id/problem', id, requireGate('file_dispute'), validate(s.problemBody), requireIdempotencyKey('gym.service_problem'), async (req, res) =>
  res.status(201).json(await subs.problem(req.user, req.params.id, req.body, req.idempotencyKey, req))
);

// ---------------- gym owner (vendor desk)
const ownerRouter = Router();
// Round B3: every desk route passes work_gym (the owner, or the gym's staff). M24-FR-01/02 (G1): the
// owner's own routes need run_gym (a verified phone, gym_owner not suspended: a private gym needs no
// documents); submitting for review, pausing and resuming keep list_gym (the gym_owner role active).
// Staff never reach these: they own no gym (NOT_OWNER), and list_gym needs the role.
ownerRouter.use(authenticate, requireGate('work_gym'));
const owner = requireGate('run_gym');
const listed = requireGate('list_gym');
ownerRouter.get('/', owner, async (req, res) => res.json(await gyms.listMine(req.user)));
ownerRouter.post('/', owner, validate(s.createGym), async (req, res) => res.status(201).json(await gyms.create(req.user, req.body, req)));
ownerRouter.get('/:id', owner, id, async (req, res) => res.json(await gyms.getMine(req.user, req.params.id)));
ownerRouter.patch('/:id', owner, id, validate(s.updateGym), async (req, res) => res.json(await gyms.update(req.user, req.params.id, req.body, req)));
ownerRouter.put('/:id/hours', owner, id, validate(s.hoursBody), async (req, res) => res.json(await gyms.setHours(req.user, req.params.id, req.body.hours, req)));
// M20-FR-16 to FR-22: holidays and special hours (applied at once, no review).
ownerRouter.get('/:id/special-days', owner, id, validate(s.specialDaysQuery, 'query'), async (req, res) => res.json(await specialDays.list(req.user, req.params.id, req.validQuery)));
ownerRouter.post('/:id/special-days/preview', owner, id, validate(s.specialDayBody), async (req, res) => res.json(await specialDays.preview(req.user, req.params.id, req.body)));
ownerRouter.post('/:id/special-days', owner, id, validate(s.specialDayBody), async (req, res) => res.status(201).json(await specialDays.create(req.user, req.params.id, req.body, req)));
ownerRouter.post('/:id/special-days/:specialDayId/remove', owner, validate(s.specialDayParams, 'params'), async (req, res) => res.json(await specialDays.remove(req.user, req.params.id, req.params.specialDayId, req)));
ownerRouter.put('/:id/packages', owner, id, validate(s.packagesBody), async (req, res) => res.json(await gyms.setPackages(req.user, req.params.id, req.body.packages, req)));
ownerRouter.post('/:id/photos', owner, id, limits.groundPhoto, raw, async (req, res) =>
  res.status(201).json(await gyms.addPhoto(req.user, req.params.id, { contentType: req.get('content-type'), body: req.body }, req))
);
ownerRouter.put('/:id/photos/order', owner, id, validate(s.photoOrder), async (req, res) => res.json(await gyms.reorderPhotos(req.user, req.params.id, req.body.ids, req)));
ownerRouter.post('/:id/photos/:photoId/remove', owner, validate(s.photoParams, 'params'), async (req, res) => res.json(await gyms.removePhoto(req.user, req.params.id, req.params.photoId, req)));
ownerRouter.post('/:id/submit', listed, id, async (req, res) => res.json(await gyms.submit(req.user, req.params.id, req)));
ownerRouter.post('/:id/remove', owner, id, validate(s.removeGym), async (req, res) => res.json(await gyms.remove(req.user, req.params.id, req.body, req)));
ownerRouter.post('/:id/pause', listed, id, async (req, res) => res.json(await gyms.setPaused(req.user, req.params.id, true, req)));
ownerRouter.post('/:id/resume', listed, id, async (req, res) => res.json(await gyms.setPaused(req.user, req.params.id, false, req)));
ownerRouter.post('/:id/redemptions', id, validate(s.redeemBody), async (req, res) => res.status(201).json(await desk.redeem(req.user, req.params.id, req.body, req)));
ownerRouter.get('/:id/redemptions', id, validate(s.admissionsQuery, 'query'), async (req, res) => res.json(await desk.admissions(req.user, req.params.id, req.validQuery)));
ownerRouter.get('/:id/passes', id, validate(s.soldQuery, 'query'), async (req, res) => res.json(await desk.sold(req.user, req.params.id, req.validQuery)));

// ---------------- fitness trainers (pro desk on kriraghor.com)
const proPlans = Router();
proPlans.use(authenticate);
proPlans.get('/', async (req, res) => res.json(await subs.listPlans(req.user)));
proPlans.post('/', validate(s.planBody), async (req, res) => res.status(201).json(await subs.createPlan(req.user, req.body, req)));
proPlans.patch('/:id', id, validate(s.planPatch), async (req, res) => res.json(await subs.updatePlan(req.user, req.params.id, req.body, req)));
proPlans.post('/:id/retire', id, async (req, res) => res.json(await subs.retirePlan(req.user, req.params.id, req)));
const proSubs = Router();
proSubs.use(authenticate);
proSubs.get('/', async (req, res) => res.json(await subs.listFor(req.user, 'trainer')));

// ---------------- staff
const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff);
const canSee = requireAnyPermission(PERMISSIONS.MANAGE_USERS, PERMISSIONS.APPROVE_LISTINGS, PERMISSIONS.REFUND_SMALL, PERMISSIONS.VIEW_PAYOUTS);
adminRouter.get('/gyms', canSee, validate(s.adminGymsQuery, 'query'), async (req, res) => res.json(await gyms.staffList(req.validQuery)));
adminRouter.get('/gyms/:id', canSee, id, async (req, res) => res.json(await gyms.staffGet(req.params.id)));
adminRouter.post('/gyms/:id/suspend', requireAnyPermission(PERMISSIONS.MANAGE_USERS), id, validate(s.reasonBody), async (req, res) => res.json(await gyms.staffAction(req.user, req.params.id, 'suspend', req.body, req)));
// Tester feedback (19 Nov 2026): a master removes any gym, suspended included; held money is refunded.
adminRouter.post('/gyms/:id/remove', requireMaster, requireStepUp('escrow.manage'), id, validate(s.reasonBody), async (req, res) => res.json(await gyms.staffRemove(req.user, req.params.id, req.body, req)));
adminRouter.post('/gyms/:id/restore', requireMaster, id, validate(s.reasonBody), async (req, res) => res.json(await gyms.staffAction(req.user, req.params.id, 'restore', req.body, req)));
adminRouter.get('/passes/:code', canSee, validate(s.codeParam, 'params'), async (req, res) => res.json(await admin.getPass(req.params.code)));
adminRouter.post('/passes/:code/cancel', requireMaster, requireStepUp('escrow.manage'), validate(s.codeParam, 'params'), validate(s.reasonBody), async (req, res) => res.json(await admin.cancelPass(req.user, req.params.code, req.body, req)));
adminRouter.get('/subscriptions/:code', canSee, validate(s.codeParam, 'params'), async (req, res) => res.json(await admin.getSubscription(req.params.code)));

module.exports = { publicRouter, mePasses, meSubs, ownerRouter, proPlans, proSubs, adminRouter };
