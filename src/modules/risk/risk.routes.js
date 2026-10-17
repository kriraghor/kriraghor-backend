'use strict';

/**
 * M18 routes (§9), step 1.
 *   adminRouter  /admin/risk   staff with manage_users and masters (Q100): overview, flags, an account,
 *                              actions (freeze and ban: masters with step-up risk.manage / user.ban), undo,
 *                              threshold change requests (masters, step-up settings.write)
 *   meTrust      /me/trust     my reliability scores
 *   publicTrust  /trust/:userId  shown scores only
 */
const { Router } = require('express');
const { validate } = require('../../common/validate');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, requireStaff, requireAnyPermission, requireMaster, requireStepUp } = require('../../middlewares/auth');
const risk = require('./risk.service');
const flags = require('./flags.service');
const actions = require('./actions.service');
const trust = require('./trust.service');
const rules = require('./risk.rules');
const s = require('./risk.schemas');

/** The step-up a master confirms depends on the action (freeze: risk.manage, ban: user.ban). */
function stepUpForAction(req, res, next) {
  const scope = rules.stepUpFor(req.body.action);
  return scope ? requireStepUp(scope)(req, res, next) : next();
}

/** Undo of a freeze or a ban needs the same step-up as the action itself (the route reads the row). */
async function stepUpForUndo(req, res, next) {
  try {
    const row = await require('../../models').RiskAction.findByPk(req.params.id, { attributes: ['action'] });
    const scope = row ? rules.stepUpFor(row.action) : null;
    return scope ? requireStepUp(scope)(req, res, next) : next();
  } catch (err) {
    return next(err);
  }
}

const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff, requireAnyPermission(PERMISSIONS.MANAGE_USERS));
adminRouter.get('/overview', async (_req, res) => res.json(await risk.overview()));
adminRouter.get('/flags', validate(s.flagsQuery, 'query'), async (req, res) => res.json(await flags.list(req.validQuery)));
adminRouter.get('/accounts/:userId', validate(s.userParam, 'params'), async (req, res) => res.json(await risk.account(req.params.userId)));
adminRouter.post('/accounts/:userId/actions', validate(s.userParam, 'params'), validate(s.actionBody), stepUpForAction, async (req, res) =>
  res.status(201).json(await actions.take(req.user, req.params.userId, req.body, req))
);
adminRouter.post('/actions/:id/undo', validate(s.idParam, 'params'), validate(s.undoBody), stepUpForUndo, async (req, res) => res.status(201).json(await actions.undo(req.user, req.params.id, req.body, req)));
adminRouter.post('/thresholds', requireMaster, validate(s.thresholdsBody), requireStepUp('settings.write'), async (req, res) => res.status(201).json(await risk.proposeThresholds(req.user, req.body, req)));

const meTrust = Router();
meTrust.get('/', authenticate, async (req, res) => res.json(await trust.mine(req.user)));

const publicTrust = Router();
publicTrust.get('/:userId', validate(s.userParam, 'params'), async (req, res) => res.json(await trust.publicFor(req.params.userId)));

module.exports = { adminRouter, meTrust, publicTrust };
