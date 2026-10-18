'use strict';

const { z } = require('zod');
const { SELF_SERVICE_ROLES, ROLE_LIST, LOCALES } = require('../../common/enums');
const { usernameSchema, normalizeEmail } = require('../../common/identifiers');

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

module.exports = {
  updateProfile: z
    .object({
      displayName: z.string().trim().min(2).max(80).optional(),
      locale: z.enum(LOCALES).optional(),
      lastPanelRole: z.enum(ROLE_LIST).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, 'Nothing to update'),
  gateQuery: z.object({ action: z.string().min(2).max(40) }),
  applyRole: z.object({ role: z.enum(SELF_SERVICE_ROLES), meta: z.record(z.string(), z.unknown()).optional() }),
  roleParam: z.object({ role: z.string().min(2).max(40) }),
  changePassword: z.object({ currentPassword: z.string().max(128).optional(), newPassword: z.string().min(8).max(128) }),
  sessionParam: z.object({ id: z.uuid() }),
  setUsername: z.object({ username: usernameSchema }),
  startEmail: z.object({ email: emailSchema }),
  verifyEmail: z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }),
  linkGoogle: z.object({ idToken: z.string().min(100).max(4096) }),
  // M16: add a phone (accounts without one), and the member's own gender (once).
  startPhone: z.object({ phone: z.string().trim().min(10).max(20) }),
  verifyPhone: z.object({ phone: z.string().trim().min(10).max(20), code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }),
  setGender: z.object({ gender: z.enum(['male', 'female', 'third']) }),
};
