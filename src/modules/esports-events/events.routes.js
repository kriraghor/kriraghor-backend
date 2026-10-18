'use strict';

/**
 * M23 routes, step 1.
 *   publicRouter  /esports/events        the event list and the cacheable bundle, the feed; signed in:
 *                                        follow, unfollow, vote, my follow and votes
 *   meRouter      /me/esports/events     the events I follow
 *   adminRouter   /admin/esports/events  manage_esports: events, banner, stages, publish, cancel,
 *                                        qualifications (invite, revoke), streams, sponsors, polls,
 *                                        announcements
 */
const express = require('express');
const { Router } = express;
const { validate } = require('../../common/validate');
const { sendCached } = require('../../common/http-cache');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, requireStaff, requireAnyPermission } = require('../../middlewares/auth');
const limits = require('../../middlewares/rateLimit');
require('./events.consumers'); // the M21 entry-policy hooks load with the routes
const events = require('./events.service');
const audience = require('./audience.service');
const feed = require('./feed.service');
const qualifications = require('./qualifications.service');
const s = require('./events.schemas');

const raw = express.raw({ type: () => true, limit: '12mb' });
const id = validate(s.idParam, 'params');

// ---------------- public (and signed-in viewers)
const publicRouter = Router();
publicRouter.get('/', validate(s.listQuery, 'query'), async (req, res) => {
  const body = await events.list(req.query);
  return sendCached(req, res, body, JSON.stringify(body), { maxAge: 15 });
});
publicRouter.get('/:slug', validate(s.slugParam, 'params'), async (req, res) => {
  const body = await events.bundle(req.params.slug);
  return sendCached(req, res, body, JSON.stringify(body), { maxAge: 5 });
});
publicRouter.get('/:id/feed', id, validate(s.feedQuery, 'query'), async (req, res) => res.json(await feed.page(req.params.id, req.query)));
publicRouter.get('/:id/me', authenticate, id, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await audience.me(req.user, req.params.id));
});
publicRouter.post('/:id/follow', authenticate, limits.eventAction, id, async (req, res) => res.json(await audience.setFollow(req.user, req.params.id, true, req)));
publicRouter.post('/:id/unfollow', authenticate, limits.eventAction, id, async (req, res) => res.json(await audience.setFollow(req.user, req.params.id, false, req)));
publicRouter.post('/:id/polls/:pollId/vote', authenticate, limits.eventAction, validate(s.pollParam, 'params'), validate(s.voteBody), async (req, res) => res.json(await audience.vote(req.user, req.params.id, req.params.pollId, req.body, req)));

// ---------------- me
const meRouter = Router();
meRouter.use(authenticate);
meRouter.get('/', async (req, res) => res.json(await audience.mine(req.user)));

// ---------------- staff
const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff, requireAnyPermission(PERMISSIONS.MANAGE_ESPORTS));
adminRouter.get('/', validate(s.adminListQuery, 'query'), async (req, res) => res.json(await events.adminList(req.query)));
adminRouter.post('/', validate(s.eventBody), async (req, res) => res.status(201).json(await events.create(req.user, req.body, req)));
adminRouter.get('/:id', id, async (req, res) => res.json(await events.adminGet(req.params.id)));
adminRouter.patch('/:id', id, validate(s.eventPatch), async (req, res) => res.json(await events.update(req.user, req.params.id, req.body, req)));
adminRouter.post('/:id/banner', id, raw, async (req, res) => res.json(await events.uploadBanner(req.user, req.params.id, { contentType: req.get('content-type'), body: req.body }, req)));
adminRouter.put('/:id/stages', id, validate(s.stagesBody), async (req, res) => res.json(await events.setStages(req.user, req.params.id, req.body, req)));
adminRouter.post('/:id/publish', id, async (req, res) => res.json(await events.publish(req.user, req.params.id, req)));
adminRouter.post('/:id/cancel', id, validate(s.reasonBody), async (req, res) => res.json(await events.cancel(req.user, req.params.id, req.body, req)));
adminRouter.get('/:id/qualifications', id, async (req, res) => res.json(await qualifications.staffList(req.params.id)));
adminRouter.post('/:id/qualifications', id, validate(s.inviteBody), async (req, res) => res.status(201).json(await qualifications.invite(req.user, req.params.id, req.body, req)));
adminRouter.post('/:id/qualifications/:qualificationId/revoke', validate(s.qualParam, 'params'), validate(s.reasonBody), async (req, res) =>
  res.json(await qualifications.revoke(req.user, req.params.id, req.params.qualificationId, req.body, req))
);
adminRouter.put('/:id/streams', id, validate(s.streamsBody), async (req, res) => res.json(await events.setStreams(req.user, req.params.id, req.body, req)));
adminRouter.post('/:id/sponsors', id, validate(s.sponsorBody), async (req, res) => res.status(201).json(await events.addSponsor(req.user, req.params.id, req.body, req)));
adminRouter.patch('/:id/sponsors/:sponsorId', validate(s.sponsorParam, 'params'), validate(s.sponsorPatch), async (req, res) => res.json(await events.updateSponsor(req.user, req.params.id, req.params.sponsorId, req.body, req)));
adminRouter.post('/:id/sponsors/:sponsorId/remove', validate(s.sponsorParam, 'params'), async (req, res) => res.json(await events.removeSponsor(req.user, req.params.id, req.params.sponsorId, req)));
adminRouter.post('/:id/sponsors/:sponsorId/logo', validate(s.sponsorParam, 'params'), raw, async (req, res) =>
  res.json(await events.uploadSponsorLogo(req.user, req.params.id, req.params.sponsorId, { contentType: req.get('content-type'), body: req.body }, req))
);
adminRouter.post('/:id/polls', id, validate(s.pollBody), async (req, res) => res.status(201).json(await audience.createPoll(req.user, req.params.id, req.body, req)));
adminRouter.post('/:id/polls/:pollId/open', validate(s.pollParam, 'params'), async (req, res) => res.json(await audience.movePoll(req.user, req.params.id, req.params.pollId, 'open', req)));
adminRouter.post('/:id/polls/:pollId/close', validate(s.pollParam, 'params'), async (req, res) => res.json(await audience.movePoll(req.user, req.params.id, req.params.pollId, 'closed', req)));
adminRouter.post('/:id/feed', id, validate(s.announceBody), async (req, res) => res.status(201).json(await feed.announce(req.user, req.params.id, req.body, req)));

module.exports = { publicRouter, meRouter, adminRouter };
