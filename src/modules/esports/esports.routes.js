'use strict';

/**
 * M21 routes (§9).
 *   publicRouter  /esports             catalogue, tournaments, standings, matches, leaderboards, players;
 *                                      registering (bearer, gate join_esports, Idempotency-Key)
 *   meRouter      /me/esports          uploads, game profiles, squads, my entries, check-in, room,
 *                                      evidence, disputes, winnings
 *   adminRouter   /admin/esports       tournaments, check-in board, rooms, results, disputes, fair play
 * Room credentials and screenshots are never cached (no-store).
 */
const express = require('express');
const { Router } = express;
const { validate } = require('../../common/validate');
const { requireIdempotencyKey } = require('../../common/idempotency');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, requireStaff, requireStepUp, requireAnyPermission } = require('../../middlewares/auth');
const limits = require('../../middlewares/rateLimit');
const catalog = require('../catalog/catalog.service');
require('./esports.moderation'); // adapters and the M06 purpose hook load with the routes
const profiles = require('./profiles.service');
const squads = require('./squads.service');
const tournaments = require('./tournaments.service');
const registrations = require('./registrations.service');
const rooms = require('./rooms.service');
const results = require('./results.service');
const prizes = require('./prizes.service');
const rankings = require('./rankings.service');
const s = require('./esports.schemas');

const id = validate(s.idParam, 'params');
const raw = express.raw({ type: () => true, limit: '20mb' });
const noStore = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

// ---------------------------------------------------------------- public (§9.1)
const publicRouter = Router();
publicRouter.get('/games', async (_req, res) => res.json(await catalog.publicGames()));
publicRouter.get('/tournaments', validate(s.listQuery, 'query'), async (req, res) => res.json(await tournaments.list(req.validQuery)));
publicRouter.get('/tournaments/:id', validate(s.slugParam, 'params'), async (req, res) => res.json(await tournaments.publicDetail(req.params.id)));
publicRouter.get('/tournaments/:id/standings', id, async (req, res) => res.json(await results.standings(req.params.id)));
publicRouter.post('/tournaments/:id/registrations', authenticate, id, validate(s.registerBody), requireIdempotencyKey('esports.register'), async (req, res) =>
  res.status(201).json(await registrations.register(req.user, req.params.id, req.body, req.get('idempotency-key'), req))
);
publicRouter.get('/matches/:id', id, async (req, res) => res.json(await results.publicMatch(req.params.id)));
publicRouter.get('/leaderboards', validate(s.leaderboardQuery, 'query'), async (req, res) => res.json(await rankings.leaderboard(req.validQuery)));
publicRouter.get('/top-players', async (_req, res) => res.json(await rankings.topPlayers()));
publicRouter.get('/players/:handle', validate(s.handleParam, 'params'), async (req, res) => res.json(await rankings.player(req.params.handle)));

// ---------------------------------------------------------------- the player (§9.2)
const meRouter = Router();
meRouter.use(authenticate);
meRouter.post('/uploads', limits.esportsUpload, raw, async (req, res) => res.status(201).json(await profiles.upload(req.user, { contentType: req.get('content-type'), body: req.body })));
meRouter.get('/profiles', async (req, res) => res.json(await profiles.listMine(req.user.id)));
meRouter.post('/profiles', validate(s.profileBody), async (req, res) => res.status(201).json(await profiles.add(req.user, req.body, req)));
meRouter.post('/profiles/:id/unlink', id, async (req, res) => res.json(await profiles.unlink(req.user, req.params.id, req)));
meRouter.get('/squads', async (req, res) => res.json(await squads.listMine(req.user.id)));
meRouter.post('/squads', validate(s.squadBody), async (req, res) => res.status(201).json(await squads.create(req.user, req.body, req)));
meRouter.post('/squads/join', validate(s.joinBody), async (req, res) => res.json(await squads.joinByCode(req.user, req.body)));
meRouter.post('/squads/:id/invites', id, validate(s.inviteBody), async (req, res) => res.json(await squads.invite(req.user, req.params.id, req.body)));
meRouter.post('/squads/:id/leave', id, async (req, res) => res.json(await squads.leave(req.user, req.params.id)));
meRouter.post('/squads/:id/captain', id, validate(s.captainBody), async (req, res) => res.json(await squads.transferCaptain(req.user, req.params.id, req.body)));
meRouter.delete('/squads/:id/members/:userId', validate(s.memberParams, 'params'), async (req, res) => res.json(await squads.remove(req.user, req.params.id, req.params.userId)));
meRouter.post('/squad-invites/:id/accept', id, async (req, res) => res.json(await squads.respond(req.user, req.params.id, true)));
meRouter.post('/squad-invites/:id/decline', id, async (req, res) => res.json(await squads.respond(req.user, req.params.id, false)));
meRouter.get('/registrations', async (req, res) => res.json(await registrations.mine(req.user.id)));
meRouter.post('/registrations/:id/accept-offer', id, requireIdempotencyKey('esports.accept_offer'), async (req, res) => res.json(await registrations.acceptOffer(req.user, req.params.id)));
meRouter.post('/registrations/:id/withdraw', id, async (req, res) => res.json(await registrations.withdraw(req.user, req.params.id, req)));
meRouter.put('/registrations/:id/prize-split', id, validate(s.splitBody), async (req, res) => res.json(await registrations.setSplit(req.user, req.params.id, req.body, req)));
meRouter.post('/registrations/:id/check-in', id, async (req, res) => res.json(await registrations.checkIn(req.user, req.params.id, req)));
meRouter.get('/matches/:id/room', id, limits.esportsRoom, noStore, async (req, res) => res.json(await rooms.playerRead(req.user, req.params.id, req)));
meRouter.post('/matches/:id/evidence', id, validate(s.evidenceBody), async (req, res) => res.status(201).json(await results.addEvidence(req.user, req.params.id, req.body)));
meRouter.post('/matches/:id/disputes', id, validate(s.disputeBody), async (req, res) => res.status(201).json(await results.dispute(req.user, req.params.id, req.body, req)));
meRouter.get('/winnings', async (req, res) => res.json(await prizes.winnings(req.user.id)));

// ---------------------------------------------------------------- staff (§9.3)
const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff);
const manage = requireAnyPermission(PERMISSIONS.MANAGE_ESPORTS);
const results_ = requireAnyPermission(PERMISSIONS.MANAGE_ESPORTS, PERMISSIONS.ENTER_RESULTS);
const money = requireStepUp('esports.money');

adminRouter.get('/tournaments', results_, validate(s.adminListQuery, 'query'), async (req, res) =>
  res.json(await tournaments.list({ ...req.validQuery, status: req.validQuery.status?.split(',').filter(Boolean), staff: true }))
);
adminRouter.post('/tournaments', manage, validate(s.tournamentBody), async (req, res) => res.status(201).json(await tournaments.createDraft(req.user, req.body, req)));
adminRouter.get('/tournaments/:id', results_, id, async (req, res) => res.json(await tournaments.adminDetail(req.params.id)));
adminRouter.patch('/tournaments/:id', manage, id, validate(s.tournamentPatch), async (req, res) => res.json(await tournaments.update(req.user, req.params.id, req.body, req)));
adminRouter.post('/tournaments/:id/submit', manage, id, async (req, res) => res.json(await tournaments.submit(req.user, req.params.id, req)));
adminRouter.post('/tournaments/:id/cancel', manage, id, validate(s.cancelBody), money, async (req, res) => res.json(await tournaments.cancel(req.user, req.params.id, req.body, req)));
adminRouter.put('/tournaments/:id/streams', manage, id, validate(s.streamsBody), async (req, res) => res.json(await tournaments.setStreams(req.user, req.params.id, req.body, req)));
adminRouter.get('/tournaments/:id/checkins', results_, id, async (req, res) => res.json(await registrations.board(req.params.id)));
adminRouter.get('/tournaments/:id/finalise-preview', manage, id, async (req, res) => res.json(await prizes.preview(req.params.id)));
adminRouter.post('/tournaments/:id/finalise', manage, id, money, async (req, res) => res.json(await prizes.finalise(req.user, req.params.id, req)));
adminRouter.post('/registrations/:id/check-in', manage, id, validate(s.staffCheckinBody), async (req, res) => res.json(await registrations.staffCheckIn(req.user, req.params.id, req.body, req)));
adminRouter.post('/registrations/:id/disqualify', manage, id, validate(s.dqBody), async (req, res) => res.json(await results.disqualify(req.user, req.params.id, req.body, req)));
adminRouter.get('/matches/:id', results_, id, async (req, res) => res.json(await results.adminMatch(req.params.id)));
adminRouter.get('/matches/:id/room', manage, id, async (req, res) => res.json(await rooms.panel(req.params.id)));
adminRouter.put('/matches/:id/room', manage, id, validate(s.roomBody), async (req, res) => res.json(await rooms.setRoom(req.user, req.params.id, req.body, req)));
adminRouter.post('/matches/:id/room/rotate', manage, id, validate(s.rotateBody), async (req, res) => res.json(await rooms.rotate(req.user, req.params.id, req.body, req)));
adminRouter.post('/matches/:id/room/reveal-now', manage, id, async (req, res) => res.json(await rooms.revealNow(req.user, req.params.id, req)));
adminRouter.post('/matches/:id/room/view', manage, id, noStore, async (req, res) => res.json(await rooms.staffRead(req.user, req.params.id, req)));
adminRouter.get('/matches/:id/room/views', manage, id, async (req, res) => res.json(await rooms.views(req.params.id)));
adminRouter.put('/matches/:id/results', results_, id, validate(s.resultsBody), async (req, res) => res.json(await results.enter(req.user, req.params.id, req.body, req)));
adminRouter.post('/matches/:id/results/post', results_, id, async (req, res) => res.json(await results.post(req.user, req.params.id, req)));
adminRouter.post('/matches/:id/cancel', manage, id, validate(s.cancelBody), async (req, res) => res.json(await results.cancelMatch(req.user, req.params.id, req.body, req)));
adminRouter.get('/disputes', results_, validate(s.disputesQuery, 'query'), async (req, res) => res.json(await results.listDisputes(req.validQuery)));
adminRouter.post('/disputes/:id/resolve', manage, id, validate(s.resolveBody), async (req, res) => res.json(await results.resolve(req.user, req.params.id, req.body, req)));
adminRouter.get('/uid-bans', manage, validate(s.bansQuery, 'query'), async (req, res) => res.json(await profiles.listBans(req.validQuery)));
adminRouter.post('/uid-bans', manage, validate(s.banBody), async (req, res) => res.status(201).json(await profiles.ban(req.user, req.body, req)));
adminRouter.post('/uid-bans/:id/lift', manage, id, validate(s.liftBody), async (req, res) => res.json(await profiles.lift(req.user, req.params.id, req.body, req)));
// The UID screenshot for the Moderation desk panel (approve_listings reviewers; audited view).
adminRouter.get('/profiles/:id/screenshot', requireAnyPermission(PERMISSIONS.APPROVE_LISTINGS, PERMISSIONS.MANAGE_ESPORTS), id, async (req, res) => {
  const f = await profiles.screenshot(req.user, req.params.id, req);
  res.set('Content-Type', f.mime).set('Content-Disposition', 'inline').set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff');
  if (Buffer.isBuffer(f.body)) return res.send(f.body);
  return f.body.pipe(res);
});

module.exports = { publicRouter, meRouter, adminRouter };
