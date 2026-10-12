'use strict';

const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../../common/validate');
const { authenticate } = require('../../middlewares/auth');
const { SELF_SERVICE_ROLES, ROLE_LIST, LOCALES } = require('../../common/enums');
const authz = require('../auth/authz.service');
const service = require('./users.service');
const identity = require('./identity.service');
const { usernameSchema, normalizeEmail } = require('../../common/identifiers');
const limits = require('../../middlewares/rateLimit');
const { serializePrincipal } = require('./users.serializer');

const r = Router();
r.use(authenticate);

const reloadMe = async (req) => serializePrincipal(await authz.loadPrincipal(req.user.id));

r.get('/', (req, res) => res.json(serializePrincipal(req.user)));

r.patch(
  '/',
  validate(
    z
      .object({
        displayName: z.string().trim().min(2).max(80).optional(),
        locale: z.enum(LOCALES).optional(),
        lastPanelRole: z.enum(ROLE_LIST).optional(),
      })
      .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
  ),
  async (req, res) => {
    await service.updateProfile(req.user, req.body, req);
    res.json(await reloadMe(req));
  }
);

r.get('/gate', validate(z.object({ action: z.string().min(2).max(40) }), 'query'), (req, res) => {
  res.json(service.gatePreview(req.user, req.validQuery.action));
});

r.post(
  '/roles',
  validate(z.object({ role: z.enum(SELF_SERVICE_ROLES), meta: z.record(z.string(), z.unknown()).optional() })),
  async (req, res) => {
    res.status(201).json(await service.applyForRole(req.user, req.body, req));
  }
);

r.post('/roles/:role/withdraw', async (req, res) => {
  res.json(await service.withdrawRole(req.user, req.params.role, req));
});

r.post(
  '/password',
  validate(z.object({ currentPassword: z.string().max(128).optional(), newPassword: z.string().min(8).max(128) })),
  async (req, res) => {
    await service.changePassword(req.user, req.body, req);
    res.status(204).end();
  }
);

r.get('/sessions', async (req, res) => {
  res.json({ data: await service.listSessions(req.user, req.auth.familyId) });
});

r.delete('/sessions/:id', validate(z.object({ id: z.uuid() }), 'params'), async (req, res) => {
  await service.revokeSession(req.user, req.params.id, req);
  res.status(204).end();
});

// ---------------- Sign-in methods ----------------
const emailSchema = z
  .string()
  .trim()
  .max(191)
  .transform((v, ctx) => {
    const e = normalizeEmail(v);
    if (!e) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid email address' });
      return z.NEVER;
    }
    return e;
  });

r.put('/username', validate(z.object({ username: usernameSchema })), async (req, res) => {
  res.json(await identity.setUsername(req.user, req.body.username, req));
});

r.post('/email', limits.otpSend, validate(z.object({ email: emailSchema })), async (req, res) => {
  res.status(202).json(await identity.startEmailChange(req.user, req.body.email, req));
});

r.post('/email/verify', limits.credential, validate(z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') })), async (req, res) => {
  res.json(await identity.confirmEmailChange(req.user, req.body, req));
});

r.post('/identities/google', validate(z.object({ idToken: z.string().min(100).max(4096) })), async (req, res) => {
  res.status(201).json(await identity.linkGoogle(req.user, req.body.idToken, req));
});

r.delete('/identities/google', async (req, res) => {
  await identity.unlinkGoogle(req.user, req);
  res.status(204).end();
});

module.exports = r;
