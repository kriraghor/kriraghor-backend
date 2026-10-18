'use strict';

const { Router } = require('express');
const { validate } = require('../../common/validate');
const { authenticate } = require('../../middlewares/auth');
const authz = require('../auth/authz.service');
const service = require('./users.service');
const identity = require('./identity.service');
const limits = require('../../middlewares/rateLimit');
const { serializePrincipal } = require('./users.serializer');
const s = require('./users.schemas');

const r = Router();
r.use(authenticate);

const reloadMe = async (req) => serializePrincipal(await authz.loadPrincipal(req.user.id));

r.get('/', (req, res) => res.json(serializePrincipal(req.user)));

r.patch('/', validate(s.updateProfile), async (req, res) => {
  await service.updateProfile(req.user, req.body, req);
  res.json(await reloadMe(req));
});

r.get('/gate', validate(s.gateQuery, 'query'), (req, res) => {
  res.json(service.gatePreview(req.user, req.validQuery.action));
});

r.post('/roles', validate(s.applyRole), async (req, res) => {
  res.status(201).json(await service.applyForRole(req.user, req.body, req));
});

r.post('/roles/:role/withdraw', async (req, res) => {
  res.json(await service.withdrawRole(req.user, req.params.role, req));
});

r.post('/password', validate(s.changePassword), async (req, res) => {
  await service.changePassword(req.user, req.body, req);
  res.status(204).end();
});

r.get('/sessions', async (req, res) => {
  res.json({ data: await service.listSessions(req.user, req.auth.familyId) });
});

r.delete('/sessions/:id', validate(s.sessionParam, 'params'), async (req, res) => {
  await service.revokeSession(req.user, req.params.id, req);
  res.status(204).end();
});

// ---------------- Sign-in methods ----------------
r.put('/username', validate(s.setUsername), async (req, res) => {
  res.json(await identity.setUsername(req.user, req.body.username, req));
});

r.post('/email', limits.otpSend, validate(s.startEmail), async (req, res) => {
  res.status(202).json(await identity.startEmailChange(req.user, req.body.email, req));
});

r.post('/email/verify', limits.credential, validate(s.verifyEmail), async (req, res) => {
  res.json(await identity.confirmEmailChange(req.user, req.body, req));
});

r.post('/phone', limits.otpSend, validate(s.startPhone), async (req, res) => {
  res.status(202).json(await identity.startPhoneAdd(req.user, req.body.phone, req));
});

r.post('/phone/verify', limits.credential, validate(s.verifyPhone), async (req, res) => {
  res.json(await identity.confirmPhoneAdd(req.user, req.body, req));
});

r.put('/gender', validate(s.setGender), async (req, res) => {
  res.json(await identity.setGender(req.user, req.body.gender, req));
});

r.post('/identities/google', validate(s.linkGoogle), async (req, res) => {
  res.status(201).json(await identity.linkGoogle(req.user, req.body.idToken, req));
});

r.delete('/identities/google', async (req, res) => {
  await identity.unlinkGoogle(req.user, req);
  res.status(204).end();
});

module.exports = r;
