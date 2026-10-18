'use strict';

/**
 * M22 routes (§9) and the M14 lite organisation routes, step 1.
 *   meOrgs        /me/organisations          my organisations; apply (draft, edit, submit to M05)
 *   orgRouter     /org/:orgId                the organiser console, scoped by membership (404 otherwise):
 *                                            esports dashboard and tournaments (drafts, prize fund,
 *                                            submit, rooms, results, finalise with a phone code),
 *                                            billing (invoices, pay), branding, members
 *   publicRouter  /esports/organisers        a verified organisation's branded page (by subdomain)
 *   adminRouter   /admin/organisers          organisations (review list, suspend, restore), their
 *                                            contracts (create, document, activate, suspend, end) and
 *                                            invoices (void)
 * Organisation reviews are M05's (/admin/submissions, kind `organisation`).
 */
const express = require('express');
const { Router } = express;
const { validate } = require('../../common/validate');
const { requireIdempotencyKey } = require('../../common/idempotency');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, requireStaff, requireAnyPermission, requireMaster, requireStepUp } = require('../../middlewares/auth');
require('../organisations/organisations.moderation'); // the M05 adapter loads with the routes
require('./saas.hooks'); // the M21 organiser hooks
const organisations = require('../organisations/organisations.service');
const os = require('../organisations/organisations.schemas');
const { requireOrgRole } = require('../organisations/organisations.guard');
const es = require('../esports/esports.schemas');
const consoleSvc = require('./console.service');
const contracts = require('./contracts.service');
const invoices = require('./invoices.service');
const funds = require('./prize-funds.service');
const branding = require('./branding.service');
const s = require('./saas.schemas');

const raw = express.raw({ type: () => true, limit: '12mb' });
const noStore = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

// ---------------- the applicant (M14 lite)
const meOrgs = Router();
meOrgs.use(authenticate);
meOrgs.get('/', async (req, res) => res.json(await organisations.listMine(req.user)));
meOrgs.post('/', validate(os.createBody), async (req, res) => res.status(201).json(await organisations.create(req.user, req.body, req)));
meOrgs.get('/:id', validate(os.idParam, 'params'), async (req, res) => res.json(await organisations.getMine(req.user, req.params.id)));
meOrgs.patch('/:id', validate(os.idParam, 'params'), validate(os.updateBody), async (req, res) => res.json(await organisations.update(req.user, req.params.id, req.body, req)));
meOrgs.post('/:id/submit', validate(os.idParam, 'params'), async (req, res) => res.json(await organisations.submit(req.user, req.params.id, req)));

// ---------------- the organiser console (/org/:orgId)
const orgRouter = Router({ mergeParams: true });
orgRouter.use(authenticate);
const staff = requireOrgRole('staff');
const admin = requireOrgRole('admin');
const tid = validate(s.orgIdParam, 'params');
const mid = validate(s.orgMatchParam, 'params');

orgRouter.get('/esports/dashboard', staff, async (req, res) => res.json(await consoleSvc.dashboard(req.org)));
orgRouter.get('/esports/tournaments', staff, validate(s.tournamentsQuery, 'query'), async (req, res) => res.json(await consoleSvc.list(req.org, req.validQuery)));
orgRouter.post('/esports/tournaments', staff, validate(es.tournamentBody), async (req, res) => res.status(201).json(await consoleSvc.create(req.user, req.org, req.body, req)));
orgRouter.get('/esports/tournaments/:id', staff, tid, async (req, res) => res.json(await consoleSvc.detail(req.org, req.params.id)));
orgRouter.patch('/esports/tournaments/:id', staff, tid, validate(es.tournamentPatch), async (req, res) => res.json(await consoleSvc.update(req.user, req.org, req.params.id, req.body, req)));
orgRouter.post('/esports/tournaments/:id/prize-fund', admin, tid, requireIdempotencyKey('saas.prize_fund'), async (req, res) => res.status(201).json(await funds.deposit(req.user, req.org, req.params.id, req.idempotencyKey)));
orgRouter.post('/esports/tournaments/:id/submit', admin, tid, async (req, res) => res.json(await consoleSvc.submit(req.user, req.org, req.params.id, req)));
orgRouter.post('/esports/tournaments/:id/cancel', admin, tid, validate(es.cancelBody), async (req, res) => res.json(await consoleSvc.cancel(req.user, req.org, req.params.id, req.body, req)));
orgRouter.get('/esports/tournaments/:id/checkins', staff, tid, async (req, res) => res.json(await consoleSvc.checkins(req.org, req.params.id)));
orgRouter.get('/esports/tournaments/:id/finalise-preview', admin, tid, async (req, res) => res.json(await consoleSvc.finalisePreview(req.org, req.params.id)));
orgRouter.post('/esports/tournaments/:id/finalise/code', admin, tid, async (req, res) => res.json(await consoleSvc.sendFinaliseCode(req.user, req.org, req.params.id, req)));
orgRouter.post('/esports/tournaments/:id/finalise', admin, tid, validate(s.finaliseBody), async (req, res) => res.json(await consoleSvc.finalise(req.user, req.org, req.params.id, req.body, req)));
orgRouter.get('/esports/matches/:matchId', staff, mid, async (req, res) => res.json(await consoleSvc.match(req.org, req.params.matchId)));
orgRouter.get('/esports/matches/:matchId/room', staff, mid, noStore, async (req, res) => res.json(await consoleSvc.roomPanel(req.org, req.params.matchId)));
orgRouter.put('/esports/matches/:matchId/room', staff, mid, validate(es.roomBody), async (req, res) => res.json(await consoleSvc.setRoom(req.user, req.org, req.params.matchId, req.body, req)));
orgRouter.post('/esports/matches/:matchId/room/rotate', staff, mid, validate(es.rotateBody), async (req, res) => res.json(await consoleSvc.rotateRoom(req.user, req.org, req.params.matchId, req.body, req)));
orgRouter.put('/esports/matches/:matchId/results', staff, mid, validate(es.resultsBody), async (req, res) => res.json(await consoleSvc.enterResults(req.user, req.org, req.params.matchId, req.body, req)));
orgRouter.post('/esports/matches/:matchId/results/post', staff, mid, async (req, res) => res.json(await consoleSvc.postResults(req.user, req.org, req.params.matchId, req)));
orgRouter.get('/billing/contracts', admin, async (req, res) => res.json(await contracts.listFor(req.org.id)));
orgRouter.get('/billing/invoices', admin, async (req, res) => res.json(await invoices.list({ organisationId: req.org.id })));
orgRouter.post('/billing/invoices/:id/pay', admin, tid, requireIdempotencyKey('saas.invoice'), async (req, res) => res.status(201).json(await invoices.pay(req.user, req.org, req.params.id, req.idempotencyKey)));
orgRouter.get('/branding', staff, async (req, res) => res.json(await branding.get(req.org)));
orgRouter.put('/branding', admin, validate(s.brandingBody), async (req, res) => res.json(await branding.update(req.user, req.org, req.body, req)));
orgRouter.put('/branding/subdomain', admin, validate(s.subdomainBody), async (req, res) => res.json(await branding.claimSubdomain(req.user, req.org, req.body, req)));
orgRouter.post('/branding/logo', admin, raw, async (req, res) => res.status(201).json(await branding.uploadLogo(req.user, req.org, { contentType: req.get('content-type'), body: req.body }, req)));
orgRouter.get('/members', staff, async (req, res) => res.json(await organisations.members(req.org.id)));
orgRouter.post('/members', admin, validate(os.memberBody), async (req, res) => res.status(201).json(await organisations.addMember(req.user, req.org, req.body, req)));
orgRouter.post('/members/:memberId/remove', admin, validate(os.memberParams, 'params'), async (req, res) => res.json(await organisations.removeMember(req.user, req.org, req.params.memberId, req)));

// ---------------- public
const publicRouter = Router();
publicRouter.get('/:subdomain', validate(s.subdomainParam, 'params'), async (req, res) => res.json(await branding.bySubdomain(req.params.subdomain)));

// ---------------- staff
const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff);
const canSee = requireAnyPermission(PERMISSIONS.MANAGE_ORGANISERS, PERMISSIONS.APPROVE_LISTINGS, PERMISSIONS.MANAGE_ESPORTS);
const manage = requireAnyPermission(PERMISSIONS.MANAGE_ORGANISERS);
const money = requireStepUp('esports.money');
const id = validate(s.idParam, 'params');

adminRouter.get('/invoices', canSee, validate(s.invoicesQuery, 'query'), async (req, res) => res.json(await invoices.list(req.validQuery)));
adminRouter.post('/invoices/:id/void', manage, id, validate(s.reasonBody), money, async (req, res) => res.json(await invoices.voidInvoice(req.user, req.params.id, req.body, req)));
adminRouter.patch('/contracts/:id', manage, id, validate(s.contractPatch), async (req, res) => res.json(await contracts.update(req.user, req.params.id, req.body, req)));
adminRouter.post('/contracts/:id/document', manage, id, raw, async (req, res) => res.json(await contracts.attachDocument(req.user, req.params.id, { contentType: req.get('content-type'), body: req.body }, req)));
adminRouter.post('/contracts/:id/activate', manage, id, money, async (req, res) => res.json(await contracts.activate(req.user, req.params.id, req)));
adminRouter.post('/contracts/:id/suspend', manage, id, validate(s.reasonBody), money, async (req, res) => res.json(await contracts.stop(req.user, req.params.id, 'suspended', req.body, req)));
adminRouter.post('/contracts/:id/end', manage, id, validate(s.reasonBody), money, async (req, res) => res.json(await contracts.stop(req.user, req.params.id, 'ended', req.body, req)));
adminRouter.get('/', canSee, validate(os.adminQuery, 'query'), async (req, res) => res.json(await organisations.staffList(req.validQuery)));
adminRouter.get('/:id', canSee, id, async (req, res) => res.json(await organisations.staffGet(req.params.id)));
adminRouter.post('/:id/suspend', manage, id, validate(os.reasonBody), async (req, res) => res.json(await organisations.staffAction(req.user, req.params.id, 'suspend', req.body, req)));
adminRouter.post('/:id/restore', requireMaster, id, validate(os.reasonBody), async (req, res) => res.json(await organisations.staffAction(req.user, req.params.id, 'restore', req.body, req)));
adminRouter.get('/:id/contracts', canSee, id, async (req, res) => res.json(await contracts.listFor(req.params.id)));
adminRouter.post('/:id/contracts', manage, id, validate(s.contractBody), async (req, res) => res.status(201).json(await contracts.create(req.user, req.params.id, req.body, req)));

module.exports = { meOrgs, orgRouter, publicRouter, adminRouter };
