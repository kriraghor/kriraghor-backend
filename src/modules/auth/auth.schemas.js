'use strict';

const { z } = require('zod');
const { identifierSchema, loginIdentifierSchema, usernameSchema } = require('../../common/identifiers');
const { SELF_SERVICE_ROLES, LOCALES } = require('../../common/enums');

const code6 = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code');
const password = z.string().min(8, 'Use at least 8 characters').max(128);

module.exports = {
  otpSend: z.object({
    target: identifierSchema,
    purpose: z.enum(['signup', 'login', 'reset']),
    locale: z.enum(LOCALES).optional(),
  }),
  otpVerify: z.object({
    target: identifierSchema,
    purpose: z.enum(['signup', 'login']),
    code: code6,
  }),
  signup: z.object({
    signupToken: z.string().min(20),
    displayName: z.string().trim().min(2, 'Enter your name').max(80),
    username: usernameSchema.optional(),
    password: password.optional(),
    locale: z.enum(LOCALES).optional(),
    role: z.enum(SELF_SERVICE_ROLES).optional(),
    roleMeta: z.record(z.string(), z.unknown()).optional(),
  }),
  login: z.object({
    identifier: loginIdentifierSchema,
    password: z.string().min(1).max(128),
  }),
  passwordReset: z.object({
    target: identifierSchema,
    code: code6,
    newPassword: password,
  }),
  google: z.object({ idToken: z.string().min(100, 'Missing Google credential').max(4096) }),
  usernameCheck: z.object({ username: usernameSchema }),
  challenge: z.object({ challengeToken: z.string().min(20) }),
  challengeCode: z.object({ challengeToken: z.string().min(20), code: code6 }),
  stepUp: z.object({
    scope: z.enum(['settings.write', 'staff.write', 'payout.approve', 'refund.large', 'user.ban', 'audit.export', 'twofa.reset']),
    code: code6,
  }),
  refresh: z.object({ refreshToken: z.string().min(20).optional() }),
};
