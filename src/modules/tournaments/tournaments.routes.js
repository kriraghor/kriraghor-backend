'use strict';

/**
 * M14 routes (§9) with M15 lite results.
 *   consoleRouter /org/:orgId/sports     the organiser console for sports organisations (404 to anyone
 *                                        else): tournaments, rules, registrations, draw, fixtures,
 *                                        matches and results. Q88: organisation staff draft, run
 *                                        fixtures and enter results; admins submit, decide on teams,
 *                                        unlock rules, amend results, record lots, close and cancel.
 *   publicRouter  /tournaments           discover, the hub, register a team (captain, NID member)
 *   meRouter      /me/registrations      my teams' registrations: accept an offer, withdraw, squad
 *   adminRouter   /admin/tournaments     staff list and detail; masters cancel (step-up escrow.manage)
 * Reviews are M05's (/admin/submissions, kind `tournament`).
 */
const { Router } = require('express');
const { validate } = require('../../common/validate');
const { requireIdempotencyKey } = require('../../common/idempotency');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, requireStaff, requireAnyPermission, requireMaster, requireStepUp } = require('../../middlewares/auth');
const limits = require('../../middlewares/rateLimit');
const { requireOrgRole } = require('../organisations').guard;
require('./tournaments.moderation'); // the M05 adapter loads with the routes
const tournaments = require('./tournaments.service');
const registrations = require('./registrations.service');
const fixtures = require('./fixtures.service');
const results = require('../scoring').results;
const s = require('./tournaments.schemas');

// ---------------- the organiser console
const consoleRouter = Router({ mergeParams: true });
consoleRouter.use(authenticate);
const staff = requireOrgRole('staff', { kind: 'sports' });
const admin = requireOrgRole('admin', { kind: 'sports' });
const tid = validate(s.orgTournamentParam, 'params');
const mid = validate(s.orgMatchParam, 'params');
const rid = validate(s.orgRegParam, 'params');
const pace = limits.tournamentAction;

consoleRouter.get('/tournaments', staff, validate(s.listQuery, 'query'), async (req, res) => res.json(await tournaments.list(req.org, req.validQuery)));
consoleRouter.post('/tournaments', staff, pace, validate(s.createBody), async (req, res) => res.status(201).json(await tournaments.create(req.user, req.org, req.body, req)));
consoleRouter.get('/tournaments/:id', staff, tid, async (req, res) => res.json(await tournaments.detail(req.org, req.params.id)));
consoleRouter.patch('/tournaments/:id', staff, tid, pace, validate(s.updateBody), async (req, res) => res.json(await tournaments.update(req.user, req.org, req.params.id, req.body, req)));
consoleRouter.get('/tournaments/:id/overview', staff, tid, async (req, res) => res.json(await tournaments.overview(req.org, req.params.id)));
consoleRouter.post('/tournaments/:id/submit', admin, tid, async (req, res) => res.json(await tournaments.submit(req.user, req.org, req.params.id, req)));
consoleRouter.post('/tournaments/:id/cancel', admin, tid, validate(s.reasonBody), async (req, res) => res.json(await tournaments.cancel(req.user, req.org, req.params.id, req.body, req)));
consoleRouter.post('/tournaments/:id/registration/close', admin, tid, async (req, res) => res.json(await tournaments.closeRegistration(req.user, req.org, req.params.id, req)));
consoleRouter.post('/tournaments/:id/registration/extend', admin, tid, validate(s.extendBody), async (req, res) => res.json(await tournaments.extendRegistration(req.user, req.org, req.params.id, req.body, req)));
consoleRouter.post('/tournaments/:id/rules/unlock', admin, tid, validate(s.unlockBody), async (req, res) => res.json(await tournaments.unlockRules(req.user, req.org, req.params.id, req.body, req)));
consoleRouter.get('/tournaments/:id/registrations', staff, tid, validate(s.regQuery, 'query'), async (req, res) => res.json(await registrations.orgList(req.org, req.params.id, req.validQuery)));
// Round B2: the registrations as CSV, org admins only (names and NID yes/no, never phones or ids).
consoleRouter.get('/tournaments/:id/registrations.csv', admin, tid, validate(s.regCsvQuery, 'query'), async (req, res) => {
  const { filename, body } = await registrations.orgCsv(req.user, req.org, req.params.id, req.validQuery, req);
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${filename}"`).set('Cache-Control', 'no-store').send(body);
});
consoleRouter.post('/registrations/:regId/approve', admin, rid, async (req, res) => res.json(await registrations.approve(req.user, req.org, req.params.regId, req)));
consoleRouter.post('/registrations/:regId/reject', admin, rid, validate(s.reasonBody), async (req, res) => res.json(await registrations.reject(req.user, req.org, req.params.regId, req.body, req)));
consoleRouter.post('/registrations/:regId/remove', admin, rid, validate(s.reasonBody), async (req, res) => res.json(await registrations.remove(req.user, req.org, req.params.regId, req.body, req)));
consoleRouter.post('/registrations/:regId/waive', admin, rid, validate(s.reasonBody), async (req, res) => res.json(await registrations.waive(req.user, req.org, req.params.regId, req.body, req)));
consoleRouter.post('/tournaments/:id/draw', staff, tid, validate(s.drawBody), async (req, res) => res.json(await fixtures.drawPreview(req.org, req.params.id, req.body)));
consoleRouter.post('/tournaments/:id/draw/confirm', staff, tid, pace, validate(s.drawBody), async (req, res) => res.json(await fixtures.drawConfirm(req.user, req.org, req.params.id, req.body, req)));
consoleRouter.get('/tournaments/:id/fixtures', staff, tid, async (req, res) => res.json(await fixtures.consoleFixtures(req.org, req.params.id)));
consoleRouter.post('/tournaments/:id/fixtures/generate', staff, tid, pace, validate(s.generateBody), async (req, res) => res.json(await fixtures.generate(req.user, req.org, req.params.id, req.body, req)));
consoleRouter.post('/tournaments/:id/fixtures/publish', staff, tid, async (req, res) => res.json(await fixtures.publish(req.user, req.org, req.params.id, req)));
consoleRouter.post('/tournaments/:id/lots', admin, tid, validate(s.lotsBody), async (req, res) => res.json(await fixtures.recordLots(req.user, req.org, req.params.id, req.body, req)));
consoleRouter.patch('/matches/:matchId', staff, mid, pace, validate(s.moveBody), async (req, res) => res.json(await fixtures.moveMatch(req.user, req.org, req.params.matchId, req.body, req)));
consoleRouter.post('/matches/:matchId/postpone', staff, mid, validate(s.postponeBody), async (req, res) => res.json(await fixtures.postpone(req.user, req.org, req.params.matchId, req.body, req)));
consoleRouter.post('/matches/:matchId/walkover', admin, mid, validate(s.walkoverBody), async (req, res) => res.json(await fixtures.walkover(req.user, req.org, req.params.matchId, req.body, req)));
consoleRouter.post('/matches/:matchId/cancel', admin, mid, validate(s.reasonBody), async (req, res) => res.json(await fixtures.cancelMatch(req.user, req.org, req.params.matchId, req.body, req)));
consoleRouter.put('/matches/:matchId/result', staff, mid, pace, validate(s.resultBody), async (req, res) => res.json(await results.enter(req.user, req.org, req.params.matchId, req.body, req)));
consoleRouter.post('/matches/:matchId/result/amend', admin, mid, validate(s.amendBody), async (req, res) => res.json(await results.amend(req.user, req.org, req.params.matchId, req.body, req)));

// ---------------- public
const publicRouter = Router();
publicRouter.get('/', validate(s.publicQuery, 'query'), async (req, res) => res.json(await tournaments.publicList(req.validQuery)));
publicRouter.get('/:slug', validate(s.slugParam, 'params'), async (req, res) => res.json(await tournaments.publicDetail(req.params.slug)));
publicRouter.post('/:id/registrations', authenticate, validate(s.idParam, 'params'), requireIdempotencyKey('tournament.register'), validate(s.registerBody), async (req, res) =>
  res.status(201).json(await registrations.register(req.user, req.params.id, req.body, req.idempotencyKey, req))
);

// ---------------- my teams' registrations
const meRouter = Router();
meRouter.use(authenticate);
const reg = validate(s.idParam, 'params');
meRouter.get('/', async (req, res) => res.json(await registrations.mine(req.user)));
meRouter.post('/:id/accept-offer', reg, requireIdempotencyKey('tournament.accept_offer'), async (req, res) => res.json(await registrations.acceptOffer(req.user, req.params.id, req)));
meRouter.post('/:id/withdraw', reg, async (req, res) => res.json(await registrations.withdraw(req.user, req.params.id, req)));
meRouter.put('/:id/roster', reg, validate(s.rosterBody), async (req, res) => res.json(await registrations.setRoster(req.user, req.params.id, req.body, req)));

// ---------------- staff
const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff);
const canSee = requireAnyPermission(PERMISSIONS.APPROVE_LISTINGS, PERMISSIONS.MANAGE_ORGANISERS);
adminRouter.get('/', canSee, validate(s.adminQuery, 'query'), async (req, res) => res.json(await tournaments.adminList(req.validQuery)));
adminRouter.get('/:id', canSee, validate(s.idParam, 'params'), async (req, res) => res.json(await tournaments.adminGet(req.params.id)));
adminRouter.post('/:id/cancel', requireMaster, validate(s.idParam, 'params'), validate(s.reasonBody), requireStepUp('escrow.manage'), async (req, res) => res.json(await tournaments.adminCancel(req.user, req.params.id, req.body, req)));

module.exports = { consoleRouter, publicRouter, meRouter, adminRouter };
