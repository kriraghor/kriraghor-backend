'use strict';

/**
 * M24 §25 WhatsApp routes. Every /manage/gyms/:gymId/** route passes authenticate and the gate work_gym and
 * the suspended-gym guard; the service resolves access through gym-manage (404 for anyone unrelated, 403
 * PERMISSION_REQUIRED for staff without the permission).
 *   manageRouter  /manage/whatsapp                         the owner's number and every branch (gate run_gym)
 *                 /manage/gyms/:gymId/whatsapp             one branch's number and button (owner)
 *                 /manage/gyms/:gymId/members/:memberId/whatsapp  a member's number and consents (desk)
 *   meRouter      /me/gym-whatsapp/:memberId              my number and consents at one gym
 */
const { Router } = require('express');
const { validate } = require('../../common/validate');
const { authenticate, requireGate } = require('../../middlewares/auth');
const s = require('./gym-whatsapp.schemas');
const contacts = require('./contacts.service');
const consents = require('./consents.service');

const params = (schema) => validate(schema, 'params');
const noStore = (res) => res.set('Cache-Control', 'no-store');
const P = (req) => req.params.gymId;
const M = (req) => req.params.memberId;

const manageRouter = Router();
manageRouter.use(authenticate);
const run = requireGate('run_gym');
manageRouter.get('/whatsapp', run, async (req, res) => res.json(await contacts.ownerView(req.user)));
manageRouter.put('/whatsapp/number', run, validate(s.ownerNumberBody), async (req, res) => res.json(await contacts.setOwnerNumber(req.user, req.body, req)));

const g = Router({ mergeParams: true });
manageRouter.use('/gyms/:gymId', requireGate('work_gym'), params(s.gymParam), (req, res, next) => require('../gym-manage').ops.frozenWrites(req, res, next), g);
g.get('/whatsapp', async (req, res) => res.json(await contacts.gymWhatsapp(req.user, P(req))));
g.patch('/whatsapp', validate(s.gymPatch), async (req, res) => res.json(await contacts.patchGym(req.user, P(req), req.body, req)));
g.get('/members/:memberId/whatsapp', params(s.memberParam), async (req, res) => {
  noStore(res);
  res.json(await consents.forMember(req.user, P(req), M(req)));
});
g.put('/members/:memberId/whatsapp', params(s.memberParam), validate(s.consentBody), async (req, res) => res.json(await consents.setForMember(req.user, P(req), M(req), req.body, req)));

const meRouter = Router();
meRouter.use(authenticate);
meRouter.get('/:memberId', params(s.myMemberParam), async (req, res) => {
  noStore(res);
  res.json(await consents.mine(req.user, M(req)));
});
meRouter.put('/:memberId', params(s.myMemberParam), validate(s.consentBody), async (req, res) => {
  noStore(res);
  res.json(await consents.setMine(req.user, M(req), req.body, req));
});

module.exports = { manageRouter, meRouter };
