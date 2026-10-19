'use strict';

const { Router } = require('express');
const { validate } = require('../../common/validate');
const { authenticateAdmin, requireStaff, requirePermission, requireMaster, requireStepUp } = require('../../middlewares/auth');
const { serializePrincipal } = require('../users').serializer;
const { PERMISSIONS } = require('../../common/enums');
const users = require('./admin-users.service');
const staff = require('./admin-staff.service');
const s = require('./admin.schemas');

const r = Router();
// Admin-audience tokens only (ADR-004): customer tokens get TOKEN_AUDIENCE_INVALID here.
r.use(authenticateAdmin, requireStaff);

// The signed-in staff member, for the admin portal shell.
r.get('/me', (req, res) => res.json(serializePrincipal(req.user)));

const idParam = validate(s.idParam, 'params');

// ---------------- Users (perm: manage_users) ----------------
r.get('/users', requirePermission(PERMISSIONS.MANAGE_USERS), validate(s.userSearch, 'query'), async (req, res) =>
  res.json(await users.search(req.user, req.validQuery, req))
);

r.get('/users/:id', requirePermission(PERMISSIONS.MANAGE_USERS), idParam, async (req, res) => res.json(await users.getOne(req.params.id)));

// M16 (Q27): correct a member's self-declared gender.
r.put('/users/:id/gender', requirePermission(PERMISSIONS.MANAGE_USERS), idParam, validate(s.gender), async (req, res) => res.json(await users.correctGender(req.user, req.params.id, req.body, req)));

r.post('/users/:id/suspend', requirePermission(PERMISSIONS.MANAGE_USERS), idParam, validate(s.suspend), async (req, res) =>
  res.json(await users.suspend(req.user, req.params.id, req.body, req))
);

r.post('/users/:id/ban', requireMaster, requireStepUp('user.ban'), idParam, validate(s.ban), async (req, res) =>
  res.json(await users.ban(req.user, req.params.id, req.body, req))
);

r.post('/users/:id/restore', requirePermission(PERMISSIONS.MANAGE_USERS), idParam, validate(s.restore), async (req, res) =>
  res.json(await users.restore(req.user, req.params.id, req.body, req, { allowBan: false }))
);

r.post('/users/:id/unban', requireMaster, requireStepUp('user.ban'), idParam, validate(s.unban), async (req, res) =>
  res.json(await users.restore(req.user, req.params.id, req.body, req, { allowBan: true }))
);

r.post('/users/:id/sign-out', requirePermission(PERMISSIONS.MANAGE_USERS), idParam, async (req, res) =>
  res.json(await users.signOutEverywhere(req.user, req.params.id, req))
);

r.post(
  '/users/:id/roles/:role/status',
  requirePermission(PERMISSIONS.MANAGE_USERS),
  validate(s.roleStatusParams, 'params'),
  validate(s.roleStatus),
  async (req, res) => res.json(await users.setRoleStatus(req.user, req.params.id, req.params.role, req.body, req))
);

// ---------------- Staff (master only; writes need step-up) ----------------
r.get('/staff', requireMaster, async (_req, res) => res.json(await staff.list()));

r.post('/staff', requireMaster, requireStepUp('staff.write'), validate(s.staffInvite), async (req, res) =>
  res.status(201).json(await staff.invite(req.user, req.body, req))
);

r.put('/staff/permissions', requireMaster, requireStepUp('staff.write'), validate(s.staffPermissions), async (req, res) =>
  res.json(await staff.setPermissions(req.user, req.body, req))
);

r.post('/staff/:id/offboard', requireMaster, requireStepUp('staff.write'), idParam, validate(s.offboard), async (req, res) =>
  res.json(await staff.offboard(req.user, req.params.id, req.body, req))
);

r.post('/staff/:id/reset-2fa', requireMaster, requireStepUp('twofa.reset'), idParam, async (req, res) =>
  res.json(await staff.resetTwoFactor(req.user, req.params.id, req))
);

r.post('/staff/:id/promote-master', requireMaster, requireStepUp('staff.write'), idParam, async (req, res) =>
  res.json(await staff.promoteToMaster(req.user, req.params.id, req))
);

module.exports = r;
