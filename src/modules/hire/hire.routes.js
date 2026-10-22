'use strict';

/**
 * M11 routes (§9), step 1 (the core hire loop).
 *   publicRouter  /hire              taxonomy, directory, profile page, quote; POST /hire/requests (gate hire)
 *   meShortlist   /me/shortlist      the member's shortlist
 *   meRequests    /me/hire-requests  my requests as the manager (and the thread, for both parties)
 *   meJobs        /me/hire-jobs      a job as the manager: confirm, cancel, no-show and problem (M17)
 *   proRouter     /pro               my hire profiles and rate cards, requests to answer, match day;
 *                                    Round B1: insights (earnings, stats) and the availability calendar
 *   adminRouter   /admin/hire        requests and their escrow, profiles, platform cancel
 */
const { Router } = require('express');
const { validate } = require('../../common/validate');
const { requireIdempotencyKey } = require('../../common/idempotency');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, optionalAuth, requireStaff, requireAnyPermission, requireMaster, requireStepUp, requireGate } = require('../../middlewares/auth');
require('./hire.moderation'); // the M05 adapter loads with the routes
const directory = require('./directory.service');
const profiles = require('./profiles.service');
const requests = require('./requests.service');
const jobs = require('./jobs.service');
const messages = require('./messages.service');
const admin = require('./hire.admin');
const availability = require('./availability.service');
const insights = require('./insights.service');
const s = require('./hire.schemas');

const id = validate(s.idParam, 'params');

// ---------------- public
const publicRouter = Router();
publicRouter.get('/taxonomy', async (req, res) => res.json({ items: await directory.categories() }));
publicRouter.get('/profiles', optionalAuth, validate(s.listQuery, 'query'), async (req, res) => res.json(await directory.list(req.validQuery, req.user?.id ?? null)));
publicRouter.get('/profiles/:slug', optionalAuth, validate(s.slugParam, 'params'), async (req, res) => res.json(await directory.page(req.params.slug, req.user?.id ?? null)));
publicRouter.post('/profiles/:id/quote', id, validate(s.quoteBody), async (req, res) => res.json(await directory.quote(req.params.id, req.body)));
publicRouter.get('/profiles/:id/availability', id, validate(s.rangeQuery, 'query'), async (req, res) => res.json(await availability.publicBusy(req.params.id, req.validQuery)));
publicRouter.post('/requests', authenticate, requireGate('hire'), validate(s.requestBody), requireIdempotencyKey('hire.request'), async (req, res) =>
  res.status(201).json(await requests.create(req.user, req.body, req.idempotencyKey, req))
);

// ---------------- member
const meShortlist = Router();
meShortlist.use(authenticate);
meShortlist.get('/', async (req, res) => res.json(await directory.shortlist(req.user)));
meShortlist.put('/:profileId', validate(s.profileParam, 'params'), async (req, res) => res.json(await directory.setShortlisted(req.user, req.params.profileId, true)));
meShortlist.delete('/:profileId', validate(s.profileParam, 'params'), async (req, res) => res.json(await directory.setShortlisted(req.user, req.params.profileId, false)));

const meRequests = Router();
meRequests.use(authenticate);
meRequests.get('/', validate(s.statusQuery, 'query'), async (req, res) => res.json(await requests.listMine(req.user, req.validQuery)));
meRequests.get('/:id', async (req, res) => res.json(await requests.getOne(req.user, req.params.id)));
meRequests.post('/:id/withdraw', id, async (req, res) => res.json(await requests.withdraw(req.user, req.params.id, req)));
meRequests.post('/:id/pay', id, async (req, res) => res.json(await requests.payLink(req.user, req.params.id)));
meRequests.get('/:id/messages', id, async (req, res) => res.json(await messages.list(req.user, req.params.id, req.query)));
meRequests.post('/:id/messages', id, validate(s.messageBody), async (req, res) => res.status(201).json(await messages.post(req.user, req.params.id, req.body)));

const meJobs = Router();
meJobs.use(authenticate);
meJobs.get('/:id', id, async (req, res) => res.json(await jobs.getOne(req.user, req.params.id)));
meJobs.get('/:id/cancel-preview', id, async (req, res) => res.json(await jobs.cancelPreview(req.user, req.params.id)));
meJobs.post('/:id/cancel', id, async (req, res) => res.json(await jobs.cancel(req.user, req.params.id, req)));
meJobs.post('/:id/confirm', id, async (req, res) => res.json(await jobs.confirm(req.user, req.params.id, req)));
for (const [path, category] of [['no-show', 'no_show'], ['problem', 'job_problem']]) {
  meJobs.post(`/:id/${path}`, id, requireGate('file_dispute'), validate(s.disputeBody), requireIdempotencyKey(`hire.${category}`), async (req, res) =>
    res.status(201).json(await jobs.dispute(req.user, req.params.id, category, req.body, req.idempotencyKey, req))
  );
}

// ---------------- players and pros (the service checks the role and the profile owner)
const proRouter = Router();
proRouter.use(authenticate);
proRouter.get('/profiles', async (req, res) => res.json(await profiles.listMine(req.user)));
proRouter.post('/profiles', validate(s.profileBody), async (req, res) => res.status(201).json(await profiles.create(req.user, req.body, req)));
proRouter.get('/profiles/:id', id, async (req, res) => res.json(await profiles.getMine(req.user, req.params.id)));
proRouter.patch('/profiles/:id', id, validate(s.profilePatch), async (req, res) => res.json(await profiles.update(req.user, req.params.id, req.body, req)));
proRouter.put('/profiles/:id/rate-card', id, validate(s.rateCardBody), async (req, res) => res.json(await profiles.saveRateCard(req.user, req.params.id, req.body, req)));
proRouter.post('/profiles/:id/submit', id, async (req, res) => res.json(await profiles.submit(req.user, req.params.id, req)));
proRouter.post('/profiles/:id/pause', id, async (req, res) => res.json(await profiles.setPaused(req.user, req.params.id, true, req)));
proRouter.post('/profiles/:id/resume', id, async (req, res) => res.json(await profiles.setPaused(req.user, req.params.id, false, req)));
proRouter.get('/insights', validate(s.insightsQuery, 'query'), async (req, res) => res.json(await insights.insights(req.user, req.validQuery)));
proRouter.get('/availability', validate(s.rangeQuery, 'query'), async (req, res) => res.json(await availability.mine(req.user, req.validQuery)));
proRouter.put('/availability/blocks', validate(s.blocksBody), async (req, res) => res.json(await availability.save(req.user, req.body, req)));
proRouter.get('/requests', validate(s.statusQuery, 'query'), async (req, res) => res.json(await requests.listForPro(req.user, req.validQuery)));
proRouter.get('/requests/:id', id, async (req, res) => res.json(await requests.getOne(req.user, req.params.id)));
proRouter.post('/requests/:id/accept', id, async (req, res) => res.json(await requests.accept(req.user, req.params.id, req)));
proRouter.post('/requests/:id/decline', id, validate(s.declineBody), async (req, res) => res.json(await requests.decline(req.user, req.params.id, req.body, req)));
proRouter.get('/jobs', validate(s.jobsQuery, 'query'), async (req, res) => res.json(await jobs.listForPro(req.user, req.validQuery)));
proRouter.get('/jobs/:id', id, async (req, res) => res.json(await jobs.getOne(req.user, req.params.id)));
proRouter.post('/jobs/:id/check-in', id, async (req, res) => res.json(await jobs.checkIn(req.user, req.params.id, req)));
proRouter.post('/jobs/:id/start', id, async (req, res) => res.json(await jobs.start(req.user, req.params.id, req)));
proRouter.post('/jobs/:id/complete', id, validate(s.completeBody), async (req, res) => res.json(await jobs.complete(req.user, req.params.id, req.body, req)));
proRouter.post('/jobs/:id/withdraw', id, validate(s.withdrawBody), async (req, res) => res.json(await jobs.withdraw(req.user, req.params.id, req.body, req)));

// ---------------- staff
const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff);
const canSee = requireAnyPermission(PERMISSIONS.MANAGE_USERS, PERMISSIONS.APPROVE_LISTINGS, PERMISSIONS.REFUND_SMALL, PERMISSIONS.VIEW_PAYOUTS);
adminRouter.get('/requests', canSee, validate(s.adminListQuery, 'query'), async (req, res) => res.json(await admin.list(req.validQuery)));
adminRouter.get('/requests/:code', canSee, async (req, res) => res.json(await admin.get(req.params.code)));
adminRouter.get('/profiles', canSee, validate(s.adminProfilesQuery, 'query'), async (req, res) => res.json(await profiles.staffList(req.validQuery)));
adminRouter.get('/profiles/:id', canSee, id, async (req, res) => res.json(await profiles.staffGet(req.params.id)));
adminRouter.post('/profiles/:id/suspend', requireAnyPermission(PERMISSIONS.MANAGE_USERS), id, validate(s.reasonBody), async (req, res) => res.json(await profiles.staffAction(req.user, req.params.id, 'suspend', req.body, req)));
adminRouter.post('/profiles/:id/restore', requireMaster, id, validate(s.reasonBody), async (req, res) => res.json(await profiles.staffAction(req.user, req.params.id, 'restore', req.body, req)));
adminRouter.post('/jobs/:id/cancel', requireMaster, requireStepUp('escrow.manage'), id, validate(s.reasonBody), async (req, res) => res.json(await jobs.platformCancel(req.user, req.params.id, req.body, req)));

module.exports = { publicRouter, meShortlist, meRequests, meJobs, proRouter, adminRouter };
