'use strict';

const { z } = require('zod');
const { ROLE_LIST, ROLE_STATUS_LIST, PERMISSION_LIST } = require('../../common/enums');

const REASONS = ['fraud', 'abuse', 'fake_documents', 'chargebacks', 'policy_breach', 'risk_flag', 'other'];
const sanctionBody = z.object({
  reasonCode: z.enum(REASONS),
  note: z.string().trim().min(5, 'Add a short note').max(2000),
  until: z.iso.datetime({ offset: true }).optional(),
});

module.exports = {
  REASONS,
  idParam: z.object({ id: z.uuid() }),
  userSearch: z.object({
    q: z.string().trim().min(2).max(100).optional(),
    status: z.enum(['active', 'suspended', 'banned', 'closed']).optional(),
    role: z.enum(ROLE_LIST).optional(),
    roleStatus: z.enum(ROLE_STATUS_LIST.concat(['documents_pending', 'withdrawn'])).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(200).optional(),
  }),
  suspend: sanctionBody,
  ban: sanctionBody.omit({ until: true }),
  restore: z.object({ note: z.string().max(2000).optional() }),
  gender: z.object({ gender: z.enum(['male', 'female', 'third']), reason: z.string().trim().min(5).max(255) }),
  unban: z.object({ note: z.string().min(5).max(2000) }),
  roleStatusParams: z.object({ id: z.uuid(), role: z.enum(ROLE_LIST) }),
  roleStatus: z.object({
    status: z.enum(['in_review', 'active', 'changes_requested', 'rejected', 'suspended']),
    reasonCode: z.string().trim().min(2).max(40).optional(),
    note: z.string().max(2000).optional(),
  }),
  staffInvite: z.object({
    userId: z.uuid(),
    employeeId: z.string().trim().min(2).max(32),
    team: z.string().trim().max(60).optional(),
    permissions: z.array(z.enum(PERMISSION_LIST)).max(PERMISSION_LIST.length).default([]),
  }),
  staffPermissions: z.object({
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
  }),
  offboard: z.object({ note: z.string().max(2000).optional() }),
};
