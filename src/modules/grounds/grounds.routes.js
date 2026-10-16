'use strict';

/**
 * M09 routes (§9), step 1.
 *   publicRouter  /grounds        browse, detail, quote (no sign-in)
 *   meGrounds     /me/grounds     the owner's grounds, courts, photos and pricing; gate list_ground
 *   meCourts      /me/courts      a court, its hours, retire (an active ground_owner role, M01/M02)
 *   adminRouter   /admin/grounds  suspend (manage_users), restore and remove (masters)
 * Decisions on listings are M05's (/admin/submissions, kind `ground`).
 */
const crypto = require('crypto');
const express = require('express');
const { Router } = express;
const { validate } = require('../../common/validate');
const { sendCached } = require('../../common/http-cache');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, requireStaff, requireAnyPermission, requireMaster, requireGate } = require('../../middlewares/auth');
const limits = require('../../middlewares/rateLimit');
require('./grounds.moderation'); // the M05 adapter loads with the routes
const grounds = require('./grounds.service');
const photos = require('./photos.service');
const pricing = require('./pricing.service');
const pub = require('./public.service');
const s = require('./grounds.schemas');

const id = validate(s.idParam, 'params');
// The hard ceiling is the top of ground.photo_max_bytes (20 MB); the setting is checked per photo.
const raw = express.raw({ type: () => true, limit: '20mb' });

// ---------------- public
const publicRouter = Router();
publicRouter.get('/', validate(s.listQuery, 'query'), async (req, res) => res.json(await pub.list(req.validQuery)));
publicRouter.get('/:slug', validate(s.slugParam, 'params'), async (req, res) => {
  const body = await pub.detail(req.params.slug);
  sendCached(req, res, body, crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex'));
});
publicRouter.post('/:id/quote', id, validate(s.publicQuote), async (req, res) => res.json(await pub.quote(req.params.id, req.body)));

// ---------------- owner
const meGrounds = Router();
meGrounds.use(authenticate, requireGate('list_ground'));
const meCourts = Router();
meCourts.use(authenticate, requireGate('list_ground'));
meGrounds.get('/', async (req, res) => res.json(await grounds.listMine(req.user)));
meGrounds.post('/', validate(s.createGround), async (req, res) => res.status(201).json(await grounds.create(req.user, req.body, req)));
meGrounds.get('/:id', id, async (req, res) => res.json(await grounds.getMine(req.user, req.params.id)));
meGrounds.patch('/:id', id, validate(s.updateGround), async (req, res) => res.json(await grounds.update(req.user, req.params.id, req.body, req)));
meGrounds.post('/:id/submit', id, async (req, res) => res.json(await grounds.submit(req.user, req.params.id, req)));
meGrounds.post('/:id/withdraw', id, async (req, res) => res.json(await grounds.withdraw(req.user, req.params.id, req)));
meGrounds.post('/:id/pause', id, async (req, res) => res.json(await grounds.setPaused(req.user, req.params.id, true, req)));
meGrounds.post('/:id/resume', id, async (req, res) => res.json(await grounds.setPaused(req.user, req.params.id, false, req)));

meGrounds.post('/:id/courts', id, validate(s.createCourt), async (req, res) => res.status(201).json(await grounds.addCourt(req.user, req.params.id, req.body, req)));
meCourts.patch('/:id', id, validate(s.updateCourt), async (req, res) => res.json(await grounds.updateCourt(req.user, req.params.id, req.body, req)));
meCourts.post('/:id/retire', id, async (req, res) => res.json(await grounds.retireCourt(req.user, req.params.id, req)));
meCourts.put('/:id/hours', id, validate(s.hoursBody), async (req, res) => res.json(await grounds.setHours(req.user, req.params.id, req.body.hours, req)));

meGrounds.post('/:id/photos', id, limits.groundPhoto, raw, async (req, res) =>
  res.status(201).json(await photos.upload(req.user, req.params.id, { contentType: req.get('content-type'), body: req.body }, req))
);
meGrounds.put('/:id/photos/order', id, validate(s.photoOrder), async (req, res) => res.json(await photos.reorder(req.user, req.params.id, req.body.ids, req)));
meGrounds.post('/:id/photos/:photoId/remove', validate(s.photoParams, 'params'), async (req, res) => res.json(await photos.remove(req.user, req.params.id, req.params.photoId, req)));

meGrounds.get('/:id/pricing', id, async (req, res) => res.json(await pricing.get(req.user, req.params.id)));
meGrounds.put('/:id/pricing/draft', id, validate(s.pricingDraft), async (req, res) => res.json(await pricing.saveDraft(req.user, req.params.id, req.body, req)));
meGrounds.post('/:id/pricing/draft/discard', id, async (req, res) => res.json(await pricing.discard(req.user, req.params.id, req)));
meGrounds.post('/:id/pricing/publish', id, validate(s.publishBody), async (req, res) => res.json(await pricing.publish(req.user, req.params.id, req.body, req)));
meGrounds.get('/:id/pricing/history', id, async (req, res) => res.json(await pricing.history(req.user, req.params.id)));
meGrounds.get('/:id/pricing/heatmap', id, validate(s.heatmapQuery, 'query'), async (req, res) => res.json(await pricing.heatmap(req.user, req.params.id, req.validQuery)));
meGrounds.post('/:id/pricing/quote', id, validate(s.ownerQuote), async (req, res) => res.json(await pricing.ownerQuote(req.user, req.params.id, req.body)));

// ---------------- staff
const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff);
const canSee = requireAnyPermission(PERMISSIONS.APPROVE_LISTINGS, PERMISSIONS.MANAGE_USERS);
adminRouter.get('/', canSee, validate(s.staffListQuery, 'query'), async (req, res) => res.json(await grounds.staffList(req.validQuery)));
adminRouter.get('/:id', canSee, id, async (req, res) => res.json(await grounds.staffGet(req.params.id)));
adminRouter.post('/:id/suspend', requireAnyPermission(PERMISSIONS.MANAGE_USERS), id, validate(s.reasonBody), async (req, res) => res.json(await grounds.staffAction(req.user, req.params.id, 'suspend', req.body, req)));
adminRouter.post('/:id/restore', requireMaster, id, validate(s.reasonBody), async (req, res) => res.json(await grounds.staffAction(req.user, req.params.id, 'restore', req.body, req)));
adminRouter.post('/:id/remove', requireMaster, id, validate(s.reasonBody), async (req, res) => res.json(await grounds.staffAction(req.user, req.params.id, 'remove', req.body, req)));

module.exports = { publicRouter, meGrounds, meCourts, adminRouter };
