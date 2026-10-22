'use strict';

const { z } = require('zod');
const { ROLE_LIST, ROLE_STATUS_LIST, PERMISSION_LIST, LOCALES } = require('../common/enums');

/**
 * Response schemas for the OpenAPI document (ADR-002). They describe what the serializers
 * and services return today; tests compare live responses against them, so drift fails CI.
 */
const dateTime = z.iso.datetime({ offset: true });
const nullableDateTime = dateTime.nullable();

const Problem = z
  .object({
    type: z.string().meta({ example: 'https://docs.kriraghor.com/errors/AUTH_REQUIRED' }),
    title: z.string(),
    status: z.number().int(),
    code: z.string().meta({ description: 'Stable machine-readable error code' }),
    detail: z.string().optional(),
    instance: z.string().optional(),
    errors: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: 'Problem', description: 'RFC 7807 problem details (application/problem+json)' });

const UserRole = z
  .object({
    role: z.enum(ROLE_LIST),
    status: z.enum(ROLE_STATUS_LIST),
    meta: z.record(z.string(), z.unknown()).nullable(),
    appliedAt: nullableDateTime,
    activatedAt: nullableDateTime,
    reasonCode: z.string().nullable(),
  })
  .meta({ id: 'UserRole' });

const Identity = z
  .object({ provider: z.enum(['google']), email: z.string().nullable(), linkedAt: dateTime, lastUsedAt: nullableDateTime })
  .meta({ id: 'Identity' });

const Me = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
    phone: z.string().nullable(),
    phoneVerified: z.boolean(),
    email: z.string().nullable(),
    emailVerified: z.boolean(),
    gender: z.enum(['male', 'female', 'third']).nullable().meta({ description: 'M16: self-declared, private (only the member and staff see it)' }),
    username: z.string().nullable(),
    avatarUrl: z.string().nullable().meta({ description: 'M01 avatar (public bucket); null without a photo' }),
    locale: z.enum(LOCALES),
    status: z.enum(['active', 'suspended', 'banned', 'closed']),
    kycStatus: z.string(),
    hasPassword: z.boolean(),
    lastPanelRole: z.string().nullable(),
    roles: z.array(UserRole),
    permissions: z.array(z.enum(PERMISSION_LIST)),
    signInMethods: z.object({ phoneOtp: z.boolean(), emailOtp: z.boolean(), password: z.boolean(), google: z.boolean() }),
    identities: z.array(Identity),
    isStaff: z.boolean(),
    isMaster: z.boolean(),
    twoFactor: z.object({ required: z.boolean(), enabled: z.boolean() }),
    workplaces: z.array(z.object({ id: z.uuid(), businessType: z.enum(['venue', 'gym', 'shop']), businessId: z.uuid(), permissions: z.array(z.string()) })).meta({ description: 'Round B3: the venues, gyms and shops this member works at as staff (live owners only)' }),
  })
  .meta({ id: 'Me', description: "The signed-in user's own view" });

const SignedIn = z
  .object({
    status: z.literal('signed_in'),
    accessToken: z.string(),
    accessTokenExpiresAt: dateTime,
    user: Me,
    refreshToken: z.string().optional().meta({ description: 'Only for X-Client-Type: mobile' }),
  })
  .meta({ id: 'SignedIn' });

const SignupRequired = z
  .object({
    status: z.literal('signup'),
    signupToken: z.string(),
    signupTokenExpiresAt: dateTime,
    suggested: z.object({ displayName: z.string().nullable(), email: z.string().nullable(), needsUsername: z.boolean() }).optional(),
  })
  .meta({ id: 'SignupRequired' });

const TwoFactorChallenge = z
  .object({
    status: z.enum(['two_factor_required', 'two_factor_setup_required']),
    next: z.enum(['totp', 'totp_setup']),
    challengeToken: z.string(),
    challengeExpiresAt: dateTime,
  })
  .meta({ id: 'TwoFactorChallenge' });

const TokenPair = z
  .object({ accessToken: z.string(), accessTokenExpiresAt: dateTime, refreshToken: z.string().optional() })
  .meta({ id: 'TokenPair' });

const OtpSent = z.object({ sent: z.literal(true), expiresInSeconds: z.number().int(), resendInSeconds: z.number().int() }).meta({ id: 'OtpSent' });

const SessionItem = z
  .object({ id: z.uuid(), device: z.string().nullable(), ip: z.string().nullable(), lastSeenAt: dateTime, createdAt: dateTime, current: z.boolean() })
  .meta({ id: 'SessionItem' });

const GateResult = z
  .object({
    action: z.string(),
    allowed: z.boolean(),
    code: z.string().optional(),
    next: z.string().optional(),
    role: z.string().optional(),
  })
  .meta({ id: 'GateResult' });

const AdminUser = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
    phone: z.string().nullable().meta({ description: 'Masked' }),
    email: z.string().nullable().meta({ description: 'Masked' }),
    username: z.string().nullable(),
    status: z.string(),
    kycStatus: z.string(),
    nidLast4: z.string().nullable(),
    gender: z.enum(['male', 'female', 'third']).nullable(),
    genderSource: z.enum(['self_declared', 'staff_corrected']).nullable(),
    locale: z.string(),
    lastLoginAt: nullableDateTime,
    createdAt: dateTime,
    roles: z.array(UserRole),
    sanctions: z.array(
      z.object({
        id: z.uuid(),
        kind: z.string(),
        role: z.string().nullable(),
        reasonCode: z.string(),
        note: z.string(),
        startsAt: dateTime,
        endsAt: nullableDateTime,
        liftedAt: nullableDateTime,
      })
    ),
    staff: z
      .object({ employeeId: z.string(), team: z.string().nullable(), status: z.string(), isMaster: z.boolean(), twoFactorEnabled: z.boolean() })
      .nullable(),
  })
  .meta({ id: 'AdminUser', description: 'Admin projection with masked identifiers (M01-FR-19)' });

const StaffList = z
  .object({
    grantable: z.array(z.string()),
    locked: z.array(z.string()),
    data: z.array(
      z.object({
        userId: z.uuid(),
        displayName: z.string(),
        phone: z.string().nullable(),
        email: z.string().nullable(),
        employeeId: z.string(),
        team: z.string().nullable(),
        isMaster: z.boolean(),
        status: z.string(),
        twoFactorEnabled: z.boolean(),
        permissions: z.array(z.string()),
      })
    ),
  })
  .meta({ id: 'StaffList' });

module.exports = {
  Problem,
  UserRole,
  Identity,
  Me,
  SignedIn,
  SignupRequired,
  TwoFactorChallenge,
  TokenPair,
  OtpSent,
  SessionItem,
  GateResult,
  AdminUser,
  StaffList,
};
