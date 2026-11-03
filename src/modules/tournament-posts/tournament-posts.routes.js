'use strict';

/**
 * M26 routes.
 *   publicRouter    /tournament-posts        the feed, a post, its comments; comment and open a thread (gate post_tournament)
 *   mePosts         /me/tournament-posts     my posts: create, edit, close, photos (gate post_tournament)
 *   meThreads       /me/tournament-threads   my conversations and their messages
 *   adminRouter     /admin/tournament-posts  every post; remove and restore (approve_listings)
 */
const express = require('express');
const { Router } = express;
const { validate } = require('../../common/validate');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, optionalAuth, requireStaff, requireAnyPermission, requireGate } = require('../../middlewares/auth');
const limits = require('../../middlewares/rateLimit');
const posts = require('./posts.service');
const comments = require('./comments.service');
const threads = require('./threads.service');
const s = require('./tournament-posts.schemas');

const id = validate(s.idParam, 'params');
const gate = requireGate('post_tournament');
// The hard ceiling is the top of tournament_posts.photo_max_bytes (20 MB); the setting is checked per photo.
const raw = express.raw({ type: () => true, limit: '20mb' });

// ---------------- public
const publicRouter = Router();
publicRouter.get('/', validate(s.listQuery, 'query'), async (req, res) => res.json(await posts.list(req.validQuery)));
publicRouter.get('/:slug', optionalAuth, validate(s.slugParam, 'params'), async (req, res) => res.json(await posts.page(req.params.slug, req.user?.id ?? null)));
publicRouter.get('/:id/comments', optionalAuth, id, validate(s.pageQuery, 'query'), async (req, res) => res.json(await comments.list(req.params.id, req.validQuery, req.user?.id ?? null)));
publicRouter.post('/:id/comments', authenticate, gate, limits.tournamentComment, id, validate(s.commentBody), async (req, res) => res.status(201).json(await comments.add(req.user, req.params.id, req.body, req)));
publicRouter.post('/:id/comments/:commentId/remove', authenticate, validate(s.commentParam, 'params'), async (req, res) => res.json(await comments.remove(req.user, req.params.id, req.params.commentId, req)));
publicRouter.post('/:id/threads', authenticate, gate, id, async (req, res) => res.status(201).json(await threads.open(req.user, req.params.id, req)));

// ---------------- my posts
const mePosts = Router();
mePosts.use(authenticate);
mePosts.get('/', validate(s.pageQuery, 'query'), async (req, res) => res.json(await posts.mine(req.user, req.validQuery)));
mePosts.post('/', gate, validate(s.postBody), async (req, res) => res.status(201).json(await posts.create(req.user, req.body, req)));
mePosts.patch('/:id', gate, id, validate(s.postBody), async (req, res) => res.json(await posts.update(req.user, req.params.id, req.body, req)));
mePosts.post('/:id/close', id, async (req, res) => res.json(await posts.close(req.user, req.params.id, req)));
mePosts.post('/:id/photos', gate, id, limits.tournamentPhoto, raw, async (req, res) => res.status(201).json(await posts.addPhoto(req.user, req.params.id, { contentType: req.get('content-type'), body: req.body }, req)));
mePosts.post('/:id/photos/:photoId/remove', validate(s.photoParam, 'params'), async (req, res) => res.json(await posts.removePhoto(req.user, req.params.id, req.params.photoId, req)));

// ---------------- my conversations
const meThreads = Router();
meThreads.use(authenticate);
meThreads.get('/', validate(s.pageQuery, 'query'), async (req, res) => res.json(await threads.mine(req.user, req.validQuery)));
meThreads.get('/:id/messages', id, validate(s.messagesQuery, 'query'), async (req, res) => res.json(await threads.messages(req.user, req.params.id, req.validQuery)));
meThreads.post('/:id/messages', gate, limits.tournamentMessage, id, validate(s.messageBody), async (req, res) => res.status(201).json(await threads.send(req.user, req.params.id, req.body)));
meThreads.post('/:id/read', id, async (req, res) => res.json(await threads.markRead(req.user, req.params.id)));

// ---------------- staff
const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff, requireAnyPermission(PERMISSIONS.APPROVE_LISTINGS));
adminRouter.get('/', validate(s.adminListQuery, 'query'), async (req, res) => res.json(await posts.staffList(req.validQuery)));
adminRouter.get('/:id', id, async (req, res) => res.json(await posts.staffGet(req.params.id)));
adminRouter.post('/:id/remove', id, validate(s.reasonBody), async (req, res) => res.json(await posts.staffRemove(req.user, req.params.id, req.body, req)));
adminRouter.post('/:id/restore', id, validate(s.reasonBody), async (req, res) => res.json(await posts.staffRestore(req.user, req.params.id, req.body, req)));

module.exports = { publicRouter, mePosts, meThreads, adminRouter };
