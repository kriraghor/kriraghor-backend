'use strict';

const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../../common/validate');
const { authenticate, requireStaff, requirePermission, requireMaster, requireStepUp } = require('../../middlewares/auth');
const { PERMISSIONS, ROLE_LIST, ROLE_STATUS_LIST, PERMISSION_LIST } = require('../../common/enums');
const users = require('./admin-users.service');
const staff = require('./admin-staff.service');

const r = Router();
r.use(authenticate, requireStaff);

const idParam = validate(z.object({ id: z.uuid() }), 'params');
const REASONS = ['fraud', 'abuse', 'fake_documents', 'chargebacks', 'policy_breach', 'risk_flag', 'other'];
const sanctionBody = z.object({
  reasonCode: z.enum(REASONS),
  note: z.string().trim().min(5, 'Add a short note').max(2000),
  until: z.iso.datetime({ offset: true }).optional(),
});

// ---------------- Users (perm: manage_users) ----------------
r.get(
  '/users',
  requirePermission(PERMISSIONS.MANAGE_USERS),
  validate(
    z.object({
      q: z.string().trim().min(2).max(100).optional(),
      status: z.enum(['active', 'suspended', 'banned', 'closed']).optional(),
      role: z.enum(ROLE_LIST).optional(),
      roleStatus: z.enum(ROLE_STATUS_LIST.concat(['documents_pending', 'withdrawn'])).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      cursor: z.string().max(200).optional(),
    }),
    'query'
  ),
  async (req, res) => res.json(await users.search(req.user, req.validQuery, req))
);

r.get('/users/:id', requirePermission(PERMISSIONS.MANAGE_USERS), idParam, async (req, res) => res.json(await users.getOne(req.params.id)));

r.post('/users/:id/suspend', requirePermission(PERMISSIONS.MANAGE_USERS), idParam, validate(sanctionBody), async (req, res) =>
  res.json(await users.suspend(req.user, req.params.id, req.body, req))
);

r.post('/users/:id/ban', requireMaster, requireStepUp('user.ban'), idParam, validate(sanctionBody.omit({ until: true })), async (req, res) =>
  res.json(await users.ban(req.user, req.params.id, req.body, req))
);

r.post('/users/:id/restore', requirePermission(PERMISSIONS.MANAGE_USERS), idParam, validate(z.object({ note: z.string().max(2000).optional() })), async (req, res) =>
  res.json(await users.restore(req.user, req.params.id, req.body, req, { allowBan: false }))
);

r.post('/users/:id/unban', requireMaster, requireStepUp('user.ban'), idParam, validate(z.object({ note: z.string().min(5).max(2000) })), async (req, res) =>
  res.json(await users.restore(req.user, req.params.id, req.body, req, { allowBan: true }))
);

r.post('/users/:id/sign-out', requirePermission(PERMISSIONS.MANAGE_USERS), idParam, async (req, res) =>
  res.json(await users.signOutEverywhere(req.user, req.params.id, req))
);

r.post(
  '/users/:id/roles/:role/status',
  requirePermission(PERMISSIONS.MANAGE_USERS),
  validate(z.object({ id: z.uuid(), role: z.enum(ROLE_LIST) }), 'params'),
  validate(
    z.object({
      status: z.enum(['in_review', 'active', 'changes_requested', 'rejected', 'suspended']),
      reasonCode: z.string().trim().min(2).max(40).optional(),
      note: z.string().max(2000).optional(),
    })
  ),
  async (req, res) => res.json(await users.setRoleStatus(req.user, req.params.id, req.params.role, req.body, req))
);

// ---------------- Staff (master only; writes need step-up) ----------------
r.get('/staff', requireMaster, async (_req, res) => res.json(await staff.list()));

r.post(
  '/staff',
  requireMaster,
  requireStepUp('staff.write'),
  validate(
    z.object({
      userId: z.uuid(),
      employeeId: z.string().trim().min(2).max(32),
      team: z.string().trim().max(60).optional(),
      permissions: z.array(z.enum(PERMISSION_LIST)).max(PERMISSION_LIST.length).default([]),
    })
  ),
  async (req, res) => res.status(201).json(await staff.invite(req.user, req.body, req))
);

r.put(
  '/staff/permissions',
  requireMaster,
  requireStepUp('staff.write'),
  validate(
    z.object({
      changes: z
        .array(
          z.object({
            userId: z.uuid(),
            grant: z.array(z.enum(PERMISSION_LIST)).default([]),
            revoke: z.array(z.enum(PERMISSION_LIST)).default([]),
          })
        )
        .min(1)
        .max(200),
      reason: z.string().trim().min(3).max(500),
    })
  ),
  async (req, res) => res.json(await staff.setPermissions(req.user, req.body, req))
);

r.post('/staff/:id/offboard', requireMaster, requireStepUp('staff.write'), idParam, validate(z.object({ note: z.string().max(2000).optional() })), async (req, res) =>
  res.json(await staff.offboard(req.user, req.params.id, req.body, req))
);

r.post('/staff/:id/reset-2fa', requireMaster, requireStepUp('twofa.reset'), idParam, async (req, res) =>
  res.json(await staff.resetTwoFactor(req.user, req.params.id, req))
);

r.post('/staff/:id/promote-master', requireMaster, requireStepUp('staff.write'), idParam, async (req, res) =>
  res.json(await staff.promoteToMaster(req.user, req.params.id, req))
);

module.exports = r;
