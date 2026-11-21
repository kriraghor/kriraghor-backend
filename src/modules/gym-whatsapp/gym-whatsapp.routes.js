'use strict';

/**
 * M24 §25 WhatsApp routes. Every /manage/gyms/:gymId/** route passes authenticate and the gate work_gym and
 * the suspended-gym guard; the service resolves access through gym-manage (404 for anyone unrelated, 403
 * PERMISSION_REQUIRED for staff without the permission).
 *   manageRouter  /manage/whatsapp                         the owner's number and every branch (gate run_gym)
 *                 /manage/gyms/:gymId/whatsapp             one branch's number and button (owner)
 *                 /manage/gyms/:gymId/members/:memberId/whatsapp  a member's number and consents (desk)
 *   meRouter      /me/gym-whatsapp/:memberId              my number and consents at one gym
 * Step 2 (built off: gym_whatsapp.api_enabled):
 *   manageRouter  /manage/whatsapp/senders                 connect (IK) and disconnect a WhatsApp Business number (owner)
 *                 /manage/gyms/:gymId/whatsapp/estimate|sends|messages   bulk and single sends, history (whatsapp.send)
 *                 /manage/gyms/:gymId/fee-payments/:id/whatsapp          send or resend a receipt (whatsapp.send)
 *   webhookRouter /webhooks/whatsapp                       Meta's check and events (raw body, signature)
 */
const express = require('express');
const { Router } = express;
const { validate } = require('../../common/validate');
const { requireIdempotencyKey } = require('../../common/idempotency');
const { authenticate, requireGate } = require('../../middlewares/auth');
const s = require('./gym-whatsapp.schemas');
const contacts = require('./contacts.service');
const consents = require('./consents.service');
const senders = require('./senders.service');
const messages = require('./messages.service');
const webhook = require('./webhook.service');

const params = (schema) => validate(schema, 'params');
const query = (schema) => validate(schema, 'query');
const ik = (action) => requireIdempotencyKey(`gym_whatsapp.${action}`);
const noStore = (res) => res.set('Cache-Control', 'no-store');
const P = (req) => req.params.gymId;
const M = (req) => req.params.memberId;

const manageRouter = Router();
manageRouter.use(authenticate);
const run = requireGate('run_gym');
manageRouter.get('/whatsapp', run, async (req, res) => res.json(await contacts.ownerView(req.user)));
manageRouter.put('/whatsapp/number', run, validate(s.ownerNumberBody), async (req, res) => res.json(await contacts.setOwnerNumber(req.user, req.body, req)));
manageRouter.post('/whatsapp/senders', run, validate(s.connectBody), ik('connect'), async (req, res) => res.status(201).json(await senders.connect(req.user, req.body, req)));
manageRouter.post('/whatsapp/senders/:senderId/disconnect', run, params(s.senderParam), async (req, res) => res.json(await senders.disconnect(req.user, req.params.senderId, req)));

const g = Router({ mergeParams: true });
manageRouter.use('/gyms/:gymId', requireGate('work_gym'), params(s.gymParam), (req, res, next) => require('../gym-manage').ops.frozenWrites(req, res, next), g);
g.get('/whatsapp', async (req, res) => res.json(await contacts.gymWhatsapp(req.user, P(req))));
g.patch('/whatsapp', validate(s.gymPatch), async (req, res) => res.json(await contacts.patchGym(req.user, P(req), req.body, req)));
g.get('/members/:memberId/whatsapp', params(s.memberParam), async (req, res) => {
  noStore(res);
  res.json(await consents.forMember(req.user, P(req), M(req)));
});
g.put('/members/:memberId/whatsapp', params(s.memberParam), validate(s.consentBody), async (req, res) => res.json(await consents.setForMember(req.user, P(req), M(req), req.body, req)));
g.post('/whatsapp/estimate', validate(s.estimateBody), async (req, res) => res.json(await messages.estimate(req.user, P(req), req.body)));
g.post('/whatsapp/sends', validate(s.sendBody), ik('send'), async (req, res) => res.status(201).json(await messages.send(req.user, P(req), req.body, req)));
g.get('/whatsapp/sends', query(s.sendsQuery), async (req, res) => res.json(await messages.sends(req.user, P(req), req.validQuery)));
g.get('/whatsapp/messages', query(s.messagesQuery), async (req, res) => {
  noStore(res);
  res.json(await messages.messages(req.user, P(req), req.validQuery));
});
g.post('/fee-payments/:feePaymentId/whatsapp', params(s.feePaymentParam), async (req, res) => res.status(201).json(await messages.sendReceipt(req.user, P(req), req.params.feePaymentId, req)));

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

// Meta's webhook: the raw body is kept for the signature (mounted before the global JSON parser).
const webhookRouter = Router();
webhookRouter.get('/', (req, res) => {
  const challenge = webhook.verify(req.query);
  if (challenge === null) return res.status(403).type('text/plain').send('Forbidden');
  return res.status(200).type('text/plain').send(challenge);
});
webhookRouter.post('/', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
  const handled = await webhook.receive(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.get('x-hub-signature-256'));
  res.json({ ok: true, handled });
});

module.exports = { manageRouter, meRouter, webhookRouter };
