'use strict';

/**
 * M05 routes (§9), lite.
 *   meSubmissions  /me/submissions       the submitter's submissions and reasons; withdraw
 *   adminRouter    /admin/submissions    the Moderation desk: queue, stats, detail, claim, heartbeat,
 *                                        ticks, release, decide, reopen
 * Staff need a kind's permission (approve_documents, approve_listings); masters see every kind.
 * Overriding a failing hard check and reopening need a master with step-up moderation.override.
 */
const { Router } = require('express');
const { validate } = require('../../common/validate');
const { requireIdempotencyKey } = require('../../common/idempotency');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, requireStaff, requireMaster, requireStepUp, requireAnyPermission } = require('../../middlewares/auth');
const moderation = require('./moderation.service');
const s = require('./moderation.schemas');

const idParam = validate(s.idParam, 'params');

const meSubmissions = Router();
meSubmissions.use(authenticate);
meSubmissions.get('/', validate(s.mineQuery, 'query'), async (req, res) => res.json(await moderation.listMine(req.user.id, req.validQuery)));
meSubmissions.post('/:id/withdraw', idParam, async (req, res) => res.json(await moderation.withdrawByOwner(req.user, req.params.id)));

/** The override needs step-up; other decisions do not. */
function stepUpForOverride(req, res, next) {
  if (req.body.override) return requireStepUp('moderation.override')(req, res, next);
  return next();
}

const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff, requireAnyPermission(PERMISSIONS.APPROVE_DOCUMENTS, PERMISSIONS.APPROVE_LISTINGS));
adminRouter.get('/', validate(s.listQuery, 'query'), async (req, res) => res.json(await moderation.list(req.user, req.validQuery)));
adminRouter.get('/stats', async (req, res) => res.json(await moderation.stats(req.user)));
adminRouter.get('/:id', idParam, async (req, res) => res.json(await moderation.detail(req.user, req.params.id)));
adminRouter.post('/:id/claim', idParam, async (req, res) => res.json(await moderation.claim(req.user, req.params.id, req)));
adminRouter.post('/:id/heartbeat', idParam, async (req, res) => res.json(await moderation.heartbeat(req.user, req.params.id)));
adminRouter.put('/:id/ticks', idParam, validate(s.ticksBody), async (req, res) => res.json(await moderation.setTicks(req.user, req.params.id, req.body.ticks)));
adminRouter.post('/:id/release', idParam, validate(s.releaseBody), async (req, res) => res.json(await moderation.release(req.user, req.params.id, req.body, req)));
adminRouter.post('/:id/decide', idParam, validate(s.decideBody), requireIdempotencyKey('moderation.decide'), stepUpForOverride, async (req, res) =>
  res.json(await moderation.decide(req.user, req.params.id, req.body, req))
);
adminRouter.post('/:id/reopen', requireMaster, idParam, validate(s.reopenBody), requireStepUp('moderation.override'), async (req, res) =>
  res.json(await moderation.reopen(req.user, req.params.id, req.body, req))
);

module.exports = { meSubmissions, adminRouter };
