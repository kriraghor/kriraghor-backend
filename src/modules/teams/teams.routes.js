'use strict';

/**
 * M16 routes, step 1.
 *   teamsRouter    /teams                 create; members only: view, edit, logo, archive, leave,
 *                                         hand over, members, invites (captain or vice-captain)
 *   meRouter       /me                    /teams, /team-invites (accept, decline), /player-profile,
 *                                         /eligibility
 *   publicRouter   /                      /players/:handle, /team-invites/:token
 *   adminRouter    /admin/teams           staff (manage_users): search, view, archive
 */
const express = require('express');
const { Router } = express;
const { validate } = require('../../common/validate');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, requireStaff, requirePermission } = require('../../middlewares/auth');
const limits = require('../../middlewares/rateLimit');
require('./teams.consumers');
const teams = require('./teams.service');
const invites = require('./invites.service');
const players = require('./players.service');
const s = require('./teams.schemas');

const raw = express.raw({ type: () => true, limit: '4mb' });
const id = validate(s.idParam, 'params');

const teamsRouter = Router();
teamsRouter.use(authenticate);
teamsRouter.post('/', validate(s.createBody), async (req, res) => res.status(201).json(await teams.create(req.user, req.body, req)));
teamsRouter.get('/:id', id, async (req, res) => res.json(await teams.get(req.user, req.params.id)));
teamsRouter.patch('/:id', id, validate(s.updateBody), async (req, res) => res.json(await teams.update(req.user, req.params.id, req.body, req)));
teamsRouter.post('/:id/logo', id, raw, async (req, res) => res.json(await teams.uploadLogo(req.user, req.params.id, { contentType: req.get('content-type'), body: req.body }, req)));
teamsRouter.post('/:id/archive', id, async (req, res) => res.json(await teams.archive(req.user, req.params.id, req)));
teamsRouter.post('/:id/leave', id, async (req, res) => res.json(await teams.leave(req.user, req.params.id, req)));
teamsRouter.post('/:id/captain', id, validate(s.captainBody), async (req, res) => res.json(await teams.handOver(req.user, req.params.id, req.body, req)));
teamsRouter.post('/:id/members/:userId/remove', validate(s.memberParam, 'params'), async (req, res) => res.json(await teams.removeMember(req.user, req.params.id, req.params.userId, req)));
teamsRouter.put('/:id/members/:userId', validate(s.memberParam, 'params'), validate(s.memberBody), async (req, res) => res.json(await teams.setMember(req.user, req.params.id, req.params.userId, req.body, req)));
teamsRouter.post('/:id/invites', id, limits.teamInvite, validate(s.inviteBody), async (req, res) => res.status(201).json(await invites.invite(req.user, req.params.id, req.body, req)));
teamsRouter.post('/:id/invites/:inviteId/cancel', validate(s.inviteParam, 'params'), async (req, res) => res.json(await invites.cancel(req.user, req.params.id, req.params.inviteId, req)));
teamsRouter.post('/:id/invites/:inviteId/resend', validate(s.inviteParam, 'params'), async (req, res) => res.json(await invites.resend(req.user, req.params.id, req.params.inviteId, req)));

// Mounted at /me next to M01's /me router, so each route authenticates itself (no double auth).
const meRouter = Router();
const me = authenticate;
meRouter.get('/teams', me, async (req, res) => res.json(await teams.mine(req.user)));
meRouter.get('/team-invites', me, async (req, res) => res.json(await invites.mine(req.user)));
meRouter.post('/team-invites/:id/accept', me, id, async (req, res) => res.json(await invites.accept(req.user, req.params.id, req)));
meRouter.post('/team-invites/:id/decline', me, id, async (req, res) => res.json(await invites.decline(req.user, req.params.id, req)));
meRouter.get('/player-profile', me, async (req, res) => res.json(await players.getMine(req.user)));
meRouter.put('/player-profile', me, validate(s.profileBody), async (req, res) => res.json(await players.putMine(req.user, req.body, req)));
meRouter.get('/eligibility', me, validate(s.eligibilityQuery, 'query'), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await players.mine(req.user, req.validQuery ?? req.query));
});

const publicRouter = Router();
publicRouter.get('/players/:handle', validate(s.handleParam, 'params'), async (req, res) => res.json(await players.publicPage(req.params.handle)));
publicRouter.get('/team-invites/:token', validate(s.tokenParam, 'params'), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await invites.byToken(req.params.token));
});

const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff, requirePermission(PERMISSIONS.MANAGE_USERS));
adminRouter.get('/', validate(s.adminQuery, 'query'), async (req, res) => res.json(await teams.adminList(req.validQuery ?? req.query)));
adminRouter.get('/:id', id, async (req, res) => res.json(await teams.adminGet(req.params.id)));
adminRouter.post('/:id/archive', id, validate(s.reasonBody), async (req, res) => res.json(await teams.adminArchive(req.user, req.params.id, req.body, req)));

module.exports = { teamsRouter, meRouter, publicRouter, adminRouter };
