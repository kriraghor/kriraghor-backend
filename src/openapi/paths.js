'use strict';

const { z } = require('zod');
const C = require('./components');
const authS = require('../modules/auth/auth.schemas');
const userS = require('../modules/users/users.schemas');
const adminS = require('../modules/admin/admin.schemas');
const settingsS = require('../modules/settings/settings.schemas');
const catalogS = require('../modules/catalog/catalog.schemas');
const auditS = require('../modules/audit/audit.schemas');
const eventsS = require('../modules/events/events.routes').schemas;
const notifyS = require('../modules/notifications/notify.schemas');
const paymentsS = require('../modules/payments/payments.schemas');
const payoutsS = require('../modules/payouts/payouts.schemas');
const kycS = require('../modules/kyc/kyc.schemas');
const modS = require('../modules/moderation/moderation.schemas');
const esS = require('../modules/esports/esports.schemas');
const grS = require('../modules/grounds/grounds.schemas');
const bkS = require('../modules/bookings/bookings.schemas');
const anS = require('../modules/analytics/analytics.schemas');
const trS = require('../modules/trust/trust.schemas');
const rkS = require('../modules/risk/risk.schemas');
const mkS = require('../modules/market/market.schemas');
const orS = require('../modules/orders/orders.schemas');
const hiS = require('../modules/hire/hire.schemas');
const gyS = require('../modules/gym/gym.schemas');
const gmS = require('../modules/gym-manage/gym-manage.schemas');
const orgS = require('../modules/organisations/organisations.schemas');
const saS = require('../modules/organiser-saas/saas.schemas');
const evS = require('../modules/esports-events/events.schemas');
const tmS = require('../modules/teams/teams.schemas');
const toS = require('../modules/tournaments/tournaments.schemas');
const usersS = require('../modules/users/users.schemas');
const bmS = require('../modules/business-members/business-members.schemas');
const adminSS = require('../modules/admin/admin.schemas');

/**
 * Every route (M01 to M14 lite, M17 to M23), registered with its request and response schemas and the stable error
 * codes it can return (ADR-002). When a route is added in a module, add it here: the
 * coverage test fails if an Express route has no OpenAPI entry.
 */
const json = (schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const noContent = { description: 'No content' };
const problem = (codes) => ({
  description: `Error. Codes: ${codes.join(', ')}`,
  content: { 'application/problem+json': { schema: C.Problem } },
});

/** Group error codes by HTTP status into OpenAPI responses. */
function errors(map) {
  const out = {};
  for (const [status, codes] of Object.entries(map)) out[status] = problem(codes);
  return out;
}

const COMMON_AUTH = { 401: ['AUTH_REQUIRED', 'TOKEN_EXPIRED', 'TOKEN_AUDIENCE_INVALID', 'SESSION_REVOKED', 'AUTHZ_STALE'] };
const ADMIN_AUTH = {
  401: COMMON_AUTH[401],
  403: ['NOT_STAFF', 'TWO_FACTOR_REQUIRED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_BANNED', 'PERMISSION_REQUIRED', 'MASTER_REQUIRED'],
};
const VALIDATION = { 422: ['VALIDATION_FAILED'] };
const RATE = { 429: ['RATE_LIMITED'] };

const bearer = [{ bearer: [] }];
const adminBearer = [{ adminBearer: [] }];
const stepUpHeader = z.object({ 'x-step-up': z.string().meta({ description: 'Single-use step-up token from POST /auth/step-up' }) });
const csrfHeader = z.object({ 'x-csrf-token': z.string().optional().meta({ description: 'Value of the CSRF cookie. Not needed with X-Client-Type: mobile and a body token' }) });
const body = (schema) => ({ body: { content: { 'application/json': { schema } } } });

function register(registry) {
  const p = (def) => registry.registerPath(def);

  // ------------------------------------------------------------------ auth (customer)
  p({ method: 'post', path: '/auth/otp/send', tags: ['auth'], summary: 'Send a one-time code to a phone or email (non-enumerating)',
    request: body(authS.otpSend), responses: { 202: json(C.OtpSent, 'Accepted'), ...errors({ ...VALIDATION, 429: ['OTP_RATE_LIMITED', 'OTP_COOLDOWN', 'RATE_LIMITED'] }) } });
  p({ method: 'post', path: '/auth/otp/verify', tags: ['auth'], summary: 'Verify a code: signs in, or returns a signup token',
    request: body(authS.otpVerify),
    responses: { 200: json(z.union([C.SignedIn, C.SignupRequired])), ...errors({ 400: ['OTP_INVALID', 'OTP_EXPIRED', 'OTP_PURPOSE_INVALID'], 403: ['STAFF_USE_ADMIN_PORTAL', 'ACCOUNT_SUSPENDED', 'ACCOUNT_BANNED', 'ACCOUNT_CLOSED'], ...VALIDATION, ...RATE }) } });
  p({ method: 'post', path: '/auth/signup', tags: ['auth'], summary: 'Finish signup with a signup token',
    request: body(authS.signup), responses: { 201: json(C.SignedIn, 'Created'), ...errors({ 400: ['SIGNUP_TOKEN_INVALID', 'ROLE_NOT_SELF_SERVICE', 'PASSWORD_WEAK'], 409: ['ACCOUNT_EXISTS', 'USERNAME_TAKEN'], ...VALIDATION, ...RATE }) } });
  p({ method: 'post', path: '/auth/google', tags: ['auth'], summary: 'Sign in with a Google ID token',
    request: body(authS.google), responses: { 200: json(z.union([C.SignedIn, C.SignupRequired])), ...errors({ 401: ['GOOGLE_TOKEN_INVALID'], 403: ['STAFF_USE_ADMIN_PORTAL', 'ACCOUNT_SUSPENDED', 'ACCOUNT_BANNED'], 409: ['ACCOUNT_EXISTS_UNVERIFIED'], ...VALIDATION, ...RATE }) } });
  p({ method: 'get', path: '/auth/username-available', tags: ['auth'], summary: 'Check whether a username is free',
    request: { query: authS.usernameCheck }, responses: { 200: json(z.object({ username: z.string(), available: z.boolean() })), ...errors({ ...VALIDATION, ...RATE }) } });
  p({ method: 'post', path: '/auth/login', tags: ['auth'], summary: 'Password sign-in with phone, email or username',
    request: body(authS.login), responses: { 200: json(C.SignedIn), ...errors({ 401: ['INVALID_CREDENTIALS'], 403: ['STAFF_USE_ADMIN_PORTAL', 'ACCOUNT_SUSPENDED', 'ACCOUNT_BANNED', 'ACCOUNT_CLOSED'], 429: ['AUTH_LOCKED', 'RATE_LIMITED'], ...VALIDATION }) } });
  p({ method: 'post', path: '/auth/password/reset', tags: ['auth'], summary: 'Reset a password with a reset code',
    request: body(authS.passwordReset), responses: { 200: json(z.object({ reset: z.literal(true) })), ...errors({ 400: ['OTP_INVALID', 'OTP_EXPIRED', 'PASSWORD_WEAK'], ...VALIDATION, ...RATE }) } });
  p({ method: 'post', path: '/auth/refresh', tags: ['auth'], summary: 'Rotate the customer refresh token (cookie, or body for mobile)',
    request: { headers: csrfHeader, ...body(authS.refresh) },
    responses: { 200: json(C.TokenPair), ...errors({ 401: ['SESSION_REVOKED'], 403: ['CSRF_ORIGIN_REJECTED', 'CSRF_TOKEN_INVALID', 'STAFF_USE_ADMIN_PORTAL', 'ACCOUNT_SUSPENDED', 'ACCOUNT_BANNED'] }) } });
  p({ method: 'post', path: '/auth/logout', tags: ['auth'], summary: 'Sign out this session (or every session with ?all=true)', security: bearer,
    request: { query: z.object({ all: z.enum(['true', 'false']).optional() }) }, responses: { 204: noContent, ...errors(COMMON_AUTH) } });

  // ------------------------------------------------------------------ auth (admin portal)
  p({ method: 'post', path: '/auth/admin/login', tags: ['auth-admin'], summary: 'Staff sign-in (password or login OTP); always continues to TOTP',
    request: body(authS.adminLogin),
    responses: { 200: json(C.TwoFactorChallenge), ...errors({ 400: ['OTP_INVALID', 'OTP_EXPIRED'], 401: ['INVALID_CREDENTIALS'], 403: ['CSRF_ORIGIN_REJECTED', 'NOT_STAFF', 'ACCOUNT_SUSPENDED', 'ACCOUNT_BANNED'], 429: ['AUTH_LOCKED', 'RATE_LIMITED'], ...VALIDATION }) } });
  p({ method: 'post', path: '/auth/2fa/totp/setup', tags: ['auth-admin'], summary: 'Start TOTP enrolment with a challenge token',
    request: body(authS.challenge), responses: { 200: json(z.object({ secret: z.string(), otpauthUrl: z.string() })), ...errors({ 401: ['CHALLENGE_INVALID'], 403: ['CSRF_ORIGIN_REJECTED'], 409: ['TWO_FACTOR_ALREADY_ENABLED'], ...VALIDATION, ...RATE }) } });
  p({ method: 'post', path: '/auth/2fa/totp/activate', tags: ['auth-admin'], summary: 'Confirm TOTP enrolment; signs in to the admin portal',
    request: body(authS.challengeCode), responses: { 200: json(C.SignedIn), ...errors({ 400: ['TOTP_INVALID'], 401: ['CHALLENGE_INVALID'], 403: ['CSRF_ORIGIN_REJECTED'], 409: ['TWO_FACTOR_ALREADY_ENABLED'], ...VALIDATION, ...RATE }) } });
  p({ method: 'post', path: '/auth/2fa/totp/verify', tags: ['auth-admin'], summary: 'Verify a TOTP code; signs in to the admin portal',
    request: body(authS.challengeCode), responses: { 200: json(C.SignedIn), ...errors({ 400: ['TOTP_INVALID'], 401: ['CHALLENGE_INVALID'], 403: ['CSRF_ORIGIN_REJECTED', 'TWO_FACTOR_REQUIRED'], ...VALIDATION, ...RATE }) } });
  p({ method: 'post', path: '/auth/admin/refresh', tags: ['auth-admin'], summary: 'Rotate the admin refresh token (admin cookie only)',
    request: { headers: csrfHeader }, responses: { 200: json(C.TokenPair), ...errors({ 401: ['SESSION_REVOKED'], 403: ['CSRF_ORIGIN_REJECTED', 'CSRF_TOKEN_INVALID', 'NOT_STAFF'] }) } });
  p({ method: 'post', path: '/auth/admin/logout', tags: ['auth-admin'], summary: 'Sign out of the admin portal', security: adminBearer,
    request: { query: z.object({ all: z.enum(['true', 'false']).optional() }) }, responses: { 204: noContent, ...errors({ ...ADMIN_AUTH, 403: ADMIN_AUTH[403].concat('CSRF_ORIGIN_REJECTED') }) } });
  p({ method: 'post', path: '/auth/step-up', tags: ['auth-admin'], summary: 'Get a single-use step-up token for a sensitive action', security: adminBearer,
    request: body(authS.stepUp),
    responses: { 200: json(z.object({ stepUpToken: z.string(), scope: z.string(), expiresAt: dateTimeOf() })), ...errors({ ...ADMIN_AUTH, 400: ['STEP_UP_SCOPE_INVALID', 'TOTP_INVALID'], ...VALIDATION, ...RATE }) } });

  // ------------------------------------------------------------------ me
  p({ method: 'get', path: '/me', tags: ['me'], summary: 'The signed-in user', security: bearer, responses: { 200: json(C.Me), ...errors(COMMON_AUTH) } });

  // ------------------------------------------------------------------ Round B3 staff accounts for businesses
  const bmId = { params: bmS.idParam };
  const TEAM = { ...COMMON_AUTH, 403: ['ROLE_REQUIRED', 'ROLE_SUSPENDED'], 404: ['NOT_FOUND'] };
  p({ method: 'get', path: '/me/workplaces', tags: ['business-members'], summary: 'Where I work as staff: each venue, gym or shop (live owners only), its owner and my permissions (Q169: a verified phone is enough)', security: bearer, responses: { 200: json(bmS.WorkplaceList), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/me/team', tags: ['business-members'], summary: 'My staff at my venues, gyms and shops (names and the last 4 digits of their phones), my businesses, the permission catalogue with defaults, and business.team_max_members', security: bearer,
    request: { query: bmS.teamQuery }, responses: { 200: json(bmS.TeamList), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'post', path: '/me/team', tags: ['business-members'], summary: 'Add a staff member to one of my businesses by their verified phone (no NID needed, Q169; scope is that business only, Q170). Leave out permissions for the defaults. Refused: unknown numbers, myself, Kriraghor staff accounts, unverified phones, someone already on the team and a full team (the refusals never carry the person’s name or details). At most business.team_adds_per_hour adds per owner per hour (Q180; 429 RATE_LIMITED with retryAfter)', security: bearer,
    request: body(bmS.addBody),
    responses: { 201: json(bmS.TeamChange, 'Created'), ...errors({ ...TEAM, 404: ['NOT_FOUND', 'MEMBER_NOT_FOUND'], 409: ['ALREADY_MEMBER', 'TEAM_FULL'], 422: ['VALIDATION_FAILED', 'MEMBER_IS_OWNER', 'MEMBER_IS_STAFF', 'PHONE_NOT_VERIFIED', 'PERMISSIONS_INVALID'], 429: ['RATE_LIMITED'] }) } });
  p({ method: 'patch', path: '/me/team/{id}', tags: ['business-members'], summary: 'Change what a staff member may do (from the allow-list of the business type); their access token goes stale at once', security: bearer,
    request: { ...bmId, ...body(bmS.permissionsBody) }, responses: { 200: json(bmS.TeamChange), ...errors({ ...TEAM, 422: ['VALIDATION_FAILED', 'PERMISSIONS_INVALID'] }) } });
  p({ method: 'post', path: '/me/team/{id}/remove', tags: ['business-members'], summary: 'Remove a staff member: they lose access on their next request (the row is kept as removed)', security: bearer,
    request: bmId, responses: { 200: json(bmS.TeamChange), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'] }) } });
  p({ method: 'patch', path: '/me', tags: ['me'], summary: 'Update profile', security: bearer, request: body(userS.updateProfile), responses: { 200: json(C.Me), ...errors({ ...COMMON_AUTH, ...VALIDATION }) } });
  const avatarImage = { description: 'The photo itself (at most users.avatar_max_bytes)', content: { 'image/jpeg': { schema: z.string() }, 'image/png': { schema: z.string() }, 'image/webp': { schema: z.string() } } };
  p({ method: 'post', path: '/me/avatar', tags: ['me'], summary: 'Upload my photo (raw JPEG, PNG or WebP; public bucket)', security: bearer, request: { body: avatarImage }, responses: { 200: json(C.Me), ...errors({ ...COMMON_AUTH, 413: ['FILE_TOO_LARGE'], 415: ['FILE_TYPE_NOT_ALLOWED', 'FILE_TYPE_MISMATCH'], 422: ['FILE_EMPTY'] }) } });
  p({ method: 'delete', path: '/me/avatar', tags: ['me'], summary: 'Remove my photo', security: bearer, responses: { 200: json(C.Me), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/me/gate', tags: ['me'], summary: 'Preview whether a gated action is allowed', security: bearer,
    request: { query: userS.gateQuery }, responses: { 200: json(C.GateResult), ...errors({ ...COMMON_AUTH, 400: ['GATE_ACTION_UNKNOWN'], ...VALIDATION }) } });
  p({ method: 'post', path: '/me/roles', tags: ['me'], summary: 'Apply for a self-service role', security: bearer,
    request: body(userS.applyRole), responses: { 201: json(C.UserRole, 'Created'), ...errors({ ...COMMON_AUTH, 400: ['ROLE_NOT_SELF_SERVICE'], 409: ['ROLE_ALREADY_APPLIED'], ...VALIDATION }) } });
  p({ method: 'post', path: '/me/roles/{role}/withdraw', tags: ['me'], summary: 'Withdraw an open role application', security: bearer,
    request: { params: userS.roleParam }, responses: { 200: json(C.UserRole), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], 409: ['ROLE_NOT_WITHDRAWABLE'] }) } });
  p({ method: 'post', path: '/me/password', tags: ['me'], summary: 'Set or change the password', security: bearer,
    request: body(userS.changePassword), responses: { 204: noContent, ...errors({ ...COMMON_AUTH, 400: ['PASSWORD_INCORRECT', 'PASSWORD_WEAK'], ...VALIDATION }) } });
  p({ method: 'get', path: '/me/sessions', tags: ['me'], summary: 'Active sessions', security: bearer, responses: { 200: json(z.object({ data: z.array(C.SessionItem) })), ...errors(COMMON_AUTH) } });
  p({ method: 'delete', path: '/me/sessions/{id}', tags: ['me'], summary: 'Sign out one session', security: bearer,
    request: { params: userS.sessionParam }, responses: { 204: noContent, ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'] }) } });
  p({ method: 'put', path: '/me/username', tags: ['me'], summary: 'Set the username', security: bearer,
    request: body(userS.setUsername), responses: { 200: json(z.object({ username: z.string() })), ...errors({ ...COMMON_AUTH, 409: ['USERNAME_TAKEN'], ...VALIDATION }) } });
  p({ method: 'post', path: '/me/email', tags: ['me'], summary: 'Send a code to a new email address', security: bearer,
    request: body(userS.startEmail), responses: { 202: json(C.OtpSent, 'Accepted'), ...errors({ ...COMMON_AUTH, 409: ['EMAIL_TAKEN'], ...VALIDATION, 429: ['OTP_RATE_LIMITED', 'OTP_COOLDOWN'] }) } });
  p({ method: 'post', path: '/me/email/verify', tags: ['me'], summary: 'Confirm the new email address', security: bearer,
    request: body(userS.verifyEmail), responses: { 200: json(z.object({ email: z.string(), verified: z.literal(true) })), ...errors({ ...COMMON_AUTH, 400: ['OTP_INVALID', 'OTP_EXPIRED'], 409: ['EMAIL_TAKEN'], ...VALIDATION, ...RATE }) } });
  p({ method: 'post', path: '/me/identities/google', tags: ['me'], summary: 'Connect a Google account', security: bearer,
    request: body(userS.linkGoogle), responses: { 201: json(C.Identity, 'Created'), ...errors({ ...COMMON_AUTH, 401: COMMON_AUTH[401].concat('GOOGLE_TOKEN_INVALID'), 409: ['GOOGLE_ALREADY_LINKED', 'GOOGLE_ALREADY_CONNECTED'], ...VALIDATION }) } });
  p({ method: 'delete', path: '/me/identities/google', tags: ['me'], summary: 'Disconnect Google (another sign-in method must remain)', security: bearer,
    responses: { 204: noContent, ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], 409: ['LAST_SIGN_IN_METHOD'] }) } });

  // ------------------------------------------------------------------ admin
  p({ method: 'get', path: '/admin/me', tags: ['admin'], summary: 'The signed-in staff member', security: adminBearer, responses: { 200: json(C.Me), ...errors(ADMIN_AUTH) } });
  p({ method: 'get', path: '/admin/users', tags: ['admin'], summary: 'Search users (manage_users)', security: adminBearer,
    request: { query: adminS.userSearch }, responses: { 200: json(z.object({ data: z.array(C.AdminUser), nextCursor: z.string().nullable() })), ...errors({ ...ADMIN_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/users/{id}', tags: ['admin'], summary: 'One user (manage_users)', security: adminBearer,
    request: { params: adminS.idParam }, responses: { 200: json(C.AdminUser), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'] }) } });
  const sanctionResult = z.object({ sanctionId: z.uuid(), status: z.enum(['suspended', 'banned']), sessionsRevoked: z.number().int() });
  p({ method: 'post', path: '/admin/users/{id}/suspend', tags: ['admin'], summary: 'Suspend a user (manage_users)', security: adminBearer,
    request: { params: adminS.idParam, ...body(adminS.suspend) }, responses: { 200: json(sanctionResult), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'], 409: ['TARGET_PROTECTED', 'ALREADY_SANCTIONED'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/users/{id}/ban', tags: ['admin'], summary: 'Ban a user (master, step-up user.ban)', security: adminBearer,
    request: { params: adminS.idParam, headers: stepUpHeader, ...body(adminS.ban) }, responses: { 200: json(sanctionResult), ...errors({ ...ADMIN_AUTH, 403: ADMIN_AUTH[403].concat('STEP_UP_REQUIRED'), 404: ['NOT_FOUND'], 409: ['TARGET_PROTECTED'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/users/{id}/restore', tags: ['admin'], summary: 'Lift a suspension (manage_users)', security: adminBearer,
    request: { params: adminS.idParam, ...body(adminS.restore) }, responses: { 200: json(z.object({ status: z.literal('active') })), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'], 409: ['NOT_SANCTIONED'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/users/{id}/unban', tags: ['admin'], summary: 'Lift a ban (master, step-up user.ban)', security: adminBearer,
    request: { params: adminS.idParam, headers: stepUpHeader, ...body(adminS.unban) }, responses: { 200: json(z.object({ status: z.literal('active') })), ...errors({ ...ADMIN_AUTH, 403: ADMIN_AUTH[403].concat('STEP_UP_REQUIRED'), 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/users/{id}/sign-out', tags: ['admin'], summary: 'Sign a user out everywhere (manage_users)', security: adminBearer,
    request: { params: adminS.idParam }, responses: { 200: json(z.object({ sessionsRevoked: z.number().int() })), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'] }) } });
  p({ method: 'post', path: '/admin/users/{id}/roles/{role}/status', tags: ['admin'], summary: 'Change a role status (manage_users)', security: adminBearer,
    request: { params: adminS.roleStatusParams, ...body(adminS.roleStatus) }, responses: { 200: json(C.UserRole), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'], 409: ['ROLE_TRANSITION_INVALID'], ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/staff', tags: ['admin'], summary: 'Staff and permissions (master)', security: adminBearer, responses: { 200: json(C.StaffList), ...errors(ADMIN_AUTH) } });
  p({ method: 'post', path: '/admin/staff', tags: ['admin'], summary: 'Invite a staff member (master, step-up staff.write)', security: adminBearer,
    request: { headers: stepUpHeader, ...body(adminS.staffInvite) },
    responses: { 201: json(z.object({ userId: z.uuid(), status: z.literal('invited'), permissions: z.array(z.string()) }), 'Created'), ...errors({ ...ADMIN_AUTH, 403: ADMIN_AUTH[403].concat('STEP_UP_REQUIRED'), 404: ['NOT_FOUND'], 409: ['ALREADY_STAFF'], ...VALIDATION }) } });
  p({ method: 'put', path: '/admin/staff/permissions', tags: ['admin'], summary: 'Grant and revoke staff permissions (master, step-up staff.write)', security: adminBearer,
    request: { headers: stepUpHeader, ...body(adminS.staffPermissions) },
    responses: { 200: json(z.object({ applied: z.number().int(), sessionsRevoked: z.number().int() })), ...errors({ ...ADMIN_AUTH, 403: ADMIN_AUTH[403].concat('STEP_UP_REQUIRED'), 400: ['PERMISSION_NOT_GRANTABLE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/staff/{id}/offboard', tags: ['admin'], summary: 'Offboard a staff member (master, step-up staff.write)', security: adminBearer,
    request: { params: adminS.idParam, headers: stepUpHeader, ...body(adminS.offboard) }, responses: { 200: json(z.object({ status: z.literal('offboarded') })), ...errors({ ...ADMIN_AUTH, 403: ADMIN_AUTH[403].concat('STEP_UP_REQUIRED'), 404: ['NOT_FOUND'] }) } });
  p({ method: 'post', path: '/admin/staff/{id}/reset-2fa', tags: ['admin'], summary: "Reset a staff member's two-factor (master, step-up twofa.reset)", security: adminBearer,
    request: { params: adminS.idParam, headers: stepUpHeader }, responses: { 200: json(z.object({ twoFactorEnabled: z.literal(false) })), ...errors({ ...ADMIN_AUTH, 403: ADMIN_AUTH[403].concat('STEP_UP_REQUIRED'), 404: ['NOT_FOUND'] }) } });
  p({ method: 'post', path: '/admin/staff/{id}/promote-master', tags: ['admin'], summary: 'Promote to master (master, step-up staff.write)', security: adminBearer,
    request: { params: adminS.idParam, headers: stepUpHeader }, responses: { 200: json(z.object({ isMaster: z.literal(true) })), ...errors({ ...ADMIN_AUTH, 403: ADMIN_AUTH[403].concat('STEP_UP_REQUIRED'), 404: ['NOT_FOUND'] }) } });

  // ------------------------------------------------------------------ M03 settings
  const SETTING_WRITE = {
    ...ADMIN_AUTH,
    403: ADMIN_AUTH[403].concat('STEP_UP_REQUIRED', 'FOUR_EYES_REQUIRED'),
    422: ['VALIDATION_FAILED', 'SETTING_UNKNOWN', 'SETTING_TYPE_INVALID', 'SETTING_OUT_OF_RANGE', 'SETTING_CROSS_RULE'],
  };
  p({ method: 'get', path: '/settings/public', tags: ['settings'], summary: 'Public platform settings (cacheable, ETag)',
    responses: { 200: json(settingsS.PublicSettings), 304: { description: 'Not modified' } } });
  p({ method: 'get', path: '/admin/settings', tags: ['settings'], summary: 'Every setting with bounds and version (master, or manage_catalog read-only)', security: adminBearer,
    request: { query: settingsS.settingsQuery }, responses: { 200: json(z.object({ items: z.array(settingsS.Setting), version: z.string().nullable() })), ...errors({ ...ADMIN_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/settings/{key}/history', tags: ['settings'], summary: 'History of one setting, newest first', security: adminBearer,
    request: { params: settingsS.keyParam, query: settingsS.historyQuery },
    responses: { 200: json(z.object({ key: z.string(), items: z.array(settingsS.SettingHistoryEntry) })), ...errors({ ...ADMIN_AUTH, 422: ['VALIDATION_FAILED', 'SETTING_UNKNOWN'] }) } });
  p({ method: 'get', path: '/admin/settings/change-requests', tags: ['settings'], summary: 'Settings change requests, newest first', security: adminBearer,
    request: { query: settingsS.requestsQuery }, responses: { 200: json(z.object({ items: z.array(settingsS.ChangeRequest) })), ...errors({ ...ADMIN_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/settings/change-requests/{id}', tags: ['settings'], summary: 'One change request', security: adminBearer,
    request: { params: settingsS.idParam }, responses: { 200: json(settingsS.ChangeRequest), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/settings/change-requests', tags: ['settings'],
    summary: 'Propose a change (master, step-up settings.write). Applies at once unless a four-eyes key or a later effectiveAt', security: adminBearer,
    request: { headers: stepUpHeader, ...body(settingsS.changeRequestCreate) },
    responses: { 201: json(settingsS.ChangeRequest, 'Created'), ...errors({ ...SETTING_WRITE, 400: ['EFFECTIVE_AT_PAST'], 422: SETTING_WRITE[422].concat('SETTING_UNCHANGED') }) } });
  for (const [action, schema, summary] of [
    ['approve', settingsS.approve, 'Approve a four-eyes change (another master, step-up settings.write)'],
    ['reject', settingsS.reject, 'Reject a proposed change (another master, step-up settings.write)'],
    ['withdraw', settingsS.withdraw, 'Withdraw your own change before it takes effect (step-up settings.write)'],
  ]) {
    p({ method: 'post', path: `/admin/settings/change-requests/{id}/${action}`, tags: ['settings'], summary, security: adminBearer,
      request: { params: settingsS.idParam, headers: stepUpHeader, ...body(schema) },
      responses: { 200: json(settingsS.ChangeRequest), ...errors({ ...SETTING_WRITE, 403: SETTING_WRITE[403].concat('NOT_PROPOSER'), 404: ['NOT_FOUND'], 409: ['CHANGE_REQUEST_CLOSED'] }) } });
  }

  // ------------------------------------------------------------------ M03 esports catalogue
  const CATALOG_AUTH = { ...ADMIN_AUTH, 404: ['NOT_FOUND'], ...VALIDATION };
  p({ method: 'get', path: '/catalog/esports/games', tags: ['catalog'], summary: 'Active esports games with modes, maps and current points presets (cacheable, ETag)',
    responses: { 200: json(z.object({ items: z.array(catalogS.EsportsGameWithChildren) })), 304: { description: 'Not modified' } } });
  const cached = { 304: { description: 'Not modified' } };
  p({ method: 'get', path: '/catalog/sports', tags: ['catalog'], summary: 'Active sports (M03 §6.1; rows only, rule schemas come with M14)', responses: { 200: json(catalogS.SportList), ...cached } });
  p({ method: 'get', path: '/catalog/locations', tags: ['catalog'], summary: 'Divisions with their districts (BBS geocodes)', request: { query: catalogS.locationsQuery }, responses: { 200: json(catalogS.LocationList), ...cached, ...errors(VALIDATION) } });
  p({ method: 'get', path: '/catalog/areas', tags: ['catalog'], summary: 'Active areas; filter by district, by service (grounds: Dhaka metro, Q15) or by name and aliases (q)',
    request: { query: catalogS.areasQuery }, responses: { 200: json(catalogS.AreaList), ...cached, ...errors(VALIDATION) } });
  p({ method: 'get', path: '/catalog/facilities', tags: ['catalog'], summary: 'Ground facilities (floodlights, parking …)', responses: { 200: json(catalogS.FacilityList), ...cached } });
  p({ method: 'get', path: '/catalog/surfaces', tags: ['catalog'], summary: 'Playing surfaces', responses: { 200: json(catalogS.SurfaceList), ...cached } });
  p({ method: 'get', path: '/admin/catalog/{table}', tags: ['catalog'], summary: 'Every row of a catalogue, inactive rows and all preset versions included (manage_esports or manage_catalog)', security: adminBearer,
    request: { params: catalogS.tableParam, query: catalogS.listQuery }, responses: { 200: json(z.object({ items: z.array(catalogS.CatalogItem) })), ...errors(CATALOG_AUTH) } });
  p({ method: 'post', path: '/admin/catalog/{table}', tags: ['catalog'], summary: 'Add a catalogue row; the body matches the table', security: adminBearer,
    request: { params: catalogS.tableParam, ...body(catalogS.createBody) }, responses: { 201: json(catalogS.CatalogItem, 'Created'), ...errors({ ...CATALOG_AUTH, 409: ['CATALOG_KEY_TAKEN'] }) } });
  p({ method: 'patch', path: '/admin/catalog/{table}/{id}', tags: ['catalog'], summary: 'Edit a row (key is immutable). A points preset edit creates a new version', security: adminBearer,
    request: { params: catalogS.tableIdParam, ...body(catalogS.updateBody) }, responses: { 200: json(catalogS.CatalogItem), ...errors({ ...CATALOG_AUTH, 422: ['VALIDATION_FAILED', 'CATALOG_KEY_IMMUTABLE'] }) } });
  for (const action of ['deactivate', 'reactivate']) {
    p({ method: 'post', path: `/admin/catalog/{table}/{id}/${action}`, tags: ['catalog'], summary: `${action === 'deactivate' ? 'Hide a row from pickers (never deleted)' : 'Show a hidden row again'}`, security: adminBearer,
      request: { params: catalogS.tableIdParam }, responses: { 200: json(catalogS.CatalogItem), ...errors(CATALOG_AUTH) } });
  }

  // ------------------------------------------------------------------ M04 audit log
  const MASTER_AUTH = { ...ADMIN_AUTH };
  p({ method: 'get', path: '/admin/audit-logs', tags: ['audit'], summary: 'Search the audit log, newest first (master). Defaults to the last 7 days', security: adminBearer,
    request: { query: auditS.searchQuery }, responses: { 200: json(auditS.AuditPage), ...errors({ ...MASTER_AUTH, 422: ['VALIDATION_FAILED', 'RANGE_TOO_LARGE'] }) } });
  p({ method: 'get', path: '/admin/audit-logs/{id}', tags: ['audit'], summary: 'One audit entry with request metadata and hash-chain status (master)', security: adminBearer,
    request: { params: auditS.idParam }, responses: { 200: json(auditS.AuditEntryDetail), ...errors({ ...MASTER_AUTH, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/audit-logs/exports', tags: ['audit'], summary: 'Export the audit log as CSV (master, step-up audit.export); built in the background', security: adminBearer,
    request: { headers: stepUpHeader, ...body(auditS.exportBody) },
    responses: { 202: json(auditS.AuditExport, 'Accepted'), ...errors({ ...MASTER_AUTH, 403: MASTER_AUTH[403].concat('STEP_UP_REQUIRED'), 422: ['VALIDATION_FAILED', 'RANGE_TOO_LARGE'] }) } });
  p({ method: 'get', path: '/admin/audit-logs/exports/{id}', tags: ['audit'], summary: 'Status of your export', security: adminBearer,
    request: { params: auditS.exportIdParam }, responses: { 200: json(auditS.AuditExport), ...errors({ ...MASTER_AUTH, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/audit-logs/exports/{id}/download', tags: ['audit'], summary: 'Download your export (CSV) until it expires', security: adminBearer,
    request: { params: auditS.exportIdParam },
    responses: { 200: { description: 'CSV file', content: { 'text/csv': { schema: z.string() } } }, ...errors({ ...MASTER_AUTH, 404: ['NOT_FOUND'], 409: ['EXPORT_NOT_READY'], 410: ['EXPORT_EXPIRED'], ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/entities/{entityType}/{entityId}/history', tags: ['audit'], summary: 'Audit history of one entity (masters see all rows, other staff only their own)', security: adminBearer,
    request: { params: auditS.entityParams, query: auditS.pageQuery }, responses: { 200: json(auditS.AuditPage), ...errors({ ...ADMIN_AUTH, ...VALIDATION }) } });

  // ------------------------------------------------------------------ M04 events (ops)
  const EventItem = z
    .object({
      id: z.uuid(),
      name: z.string(),
      aggregateType: z.string(),
      aggregateId: z.string(),
      occurredAt: z.string().nullable(),
      status: z.enum(['pending', 'published', 'failed', 'dead']),
      attempts: z.number().int(),
      lastError: z.string().nullable(),
      consumers: z.array(z.string()),
      consumer: z.string().optional(),
      deadAt: z.string().nullable().optional(),
    })
    .meta({ id: 'OutboxEventItem' });
  p({ method: 'get', path: '/admin/events', tags: ['events'], summary: 'Outbox health, pending or failed events, and dead-lettered deliveries (master)', security: adminBearer,
    request: { query: eventsS.listQuery },
    responses: { 200: json(z.object({ health: z.object({ pending: z.number().int(), oldestPendingSeconds: z.number().int().nullable() }), items: z.array(EventItem) })), ...errors({ ...MASTER_AUTH, ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/events/{id}/replay', tags: ['events'], summary: 'Deliver an event to one consumer again (master, step-up events.replay)', security: adminBearer,
    request: { params: eventsS.idParam, headers: stepUpHeader, ...body(eventsS.replayBody) },
    responses: { 202: json(z.object({ eventId: z.uuid(), consumer: z.string(), status: z.literal('queued') }), 'Accepted'), ...errors({ ...MASTER_AUTH, 403: MASTER_AUTH[403].concat('STEP_UP_REQUIRED'), 404: ['NOT_FOUND'], 409: ['EVENT_NOT_REPLAYABLE'], ...VALIDATION }) } });

  // ------------------------------------------------------------------ M08 notifications
  const ReadResult = z.object({ updated: z.number().int(), unreadCount: z.number().int() });
  const Unread = z.object({ unreadCount: z.number().int() });
  for (const [prefix, security, auth, tag] of [
    ['/me/notifications', bearer, COMMON_AUTH, 'customer'],
    ['/admin/me/notifications', adminBearer, ADMIN_AUTH, 'staff'],
  ]) {
    p({ method: 'get', path: prefix, tags: ['notifications'], summary: `The bell: newest first, with the unread count (${tag})`, security,
      request: { query: notifyS.listQuery }, responses: { 200: json(notifyS.NotificationPage), ...errors({ ...auth, ...VALIDATION }) } });
    p({ method: 'get', path: `${prefix}/unread-count`, tags: ['notifications'], summary: `Unread count for the badge (${tag})`, security,
      responses: { 200: json(Unread), ...errors(auth) } });
    p({ method: 'post', path: `${prefix}/read`, tags: ['notifications'], summary: `Mark notifications read: { ids } or { all: true, before } (${tag})`, security,
      request: body(notifyS.readBody), responses: { 200: json(ReadResult), ...errors({ ...auth, ...VALIDATION }) } });
  }
  p({ method: 'get', path: '/me/notification-prefs', tags: ['notifications'], summary: 'Notification preferences: category × channel, mandatory cells locked, quiet hours', security: bearer,
    responses: { 200: json(notifyS.NotificationPrefs), ...errors(COMMON_AUTH) } });
  p({ method: 'put', path: '/me/notification-prefs', tags: ['notifications'], summary: 'Change notification preferences', security: bearer,
    request: body(notifyS.prefsBody), responses: { 200: json(notifyS.NotificationPrefs), ...errors({ ...COMMON_AUTH, 422: ['VALIDATION_FAILED', 'PREF_MANDATORY'] }) } });
  p({ method: 'post', path: '/me/push-subscriptions', tags: ['notifications'], summary: "Register this phone's push token (the mobile app; idempotent per token: 201 new, 200 already registered)", security: bearer,
    request: body(notifyS.pushSubscribeBody), responses: { 200: json(notifyS.PushDevice), 201: json(notifyS.PushDevice), ...errors({ ...COMMON_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/me/push-subscriptions', tags: ['notifications'], summary: 'Phones that get push notifications (tokens are never returned)', security: bearer,
    responses: { 200: json(notifyS.PushDeviceList), ...errors(COMMON_AUTH) } });
  p({ method: 'delete', path: '/me/push-subscriptions/{id}', tags: ['notifications'], summary: 'Stop push notifications to one phone (the app calls this before signing out)', security: bearer,
    request: { params: notifyS.pushIdParams }, responses: { 204: noContent, ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/notifications/deliveries', tags: ['notifications'], summary: 'Delivery log with masked phones (manage_users or master)', security: adminBearer,
    request: { query: notifyS.deliveriesQuery }, responses: { 200: json(z.object({ items: z.array(notifyS.Delivery) })), ...errors({ ...ADMIN_AUTH, ...VALIDATION }) } });

  // ------------------------------------------------------------------ M06 payments, ledger and escrow
  const idem = z.object({ 'idempotency-key': z.string().meta({ description: '8–80 letters, digits, - or _. Retries with the same key and body replay the first response' }) });
  const IDEM = { 400: ['IDEMPOTENCY_KEY_REQUIRED', 'IDEMPOTENCY_KEY_INVALID'], 409: ['IDEMPOTENCY_IN_PROGRESS'], 422: ['VALIDATION_FAILED', 'IDEMPOTENCY_KEY_REUSED'] };
  const STEP = { 403: ADMIN_AUTH[403].concat('STEP_UP_REQUIRED') };
  const idP = { params: paymentsS.idParam };
  const redirect = { description: 'See other: the web result page (never trust its query; read GET /payments/{id})' };

  p({ method: 'get', path: '/payments/{id}', tags: ['payments'], summary: 'A payment, for its payer: amount, status, refunds, methods', security: bearer,
    request: idP, responses: { 200: json(paymentsS.PayerPayment), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'post', path: '/payments/{id}/attempts', tags: ['payments'], summary: 'Start paying with bKash, Nagad or a card: returns the gateway URL (FR-02)', security: bearer,
    request: { ...idP, headers: idem, ...body(paymentsS.attemptBody) },
    responses: { 201: json(paymentsS.AttemptStarted, 'Created'), ...errors({ ...COMMON_AUTH, ...IDEM, 404: ['NOT_FOUND'], 409: ['PAYMENT_ALREADY_SUCCEEDED', 'PAYMENT_CANCELLED', 'IDEMPOTENCY_IN_PROGRESS'], 410: ['PAYMENT_EXPIRED'], 503: ['PROVIDER_UNAVAILABLE'] }) } });
  p({ method: 'post', path: '/payments/{id}/verify', tags: ['payments'], summary: 'Ask the gateway now (the result page calls this); the server decides, never the browser (FR-03)', security: bearer,
    request: idP, responses: { 200: json(paymentsS.PayerPayment), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  for (const method of ['get', 'post']) {
    p({ method, path: '/payments/return/sslcommerz', tags: ['payments'], summary: `Gateway return (${method === 'post' ? 'SSLCommerz form post' : 'simulator redirect'}): verify, then 303 to the web result page`,
      request: { query: paymentsS.returnInput }, responses: { 303: redirect } });
  }
  p({ method: 'get', path: '/me/payments', tags: ['payments'], summary: 'My payments, newest first, with their refunds', security: bearer,
    request: { query: paymentsS.meListQuery }, responses: { 200: json(paymentsS.PaymentPage), ...errors({ ...COMMON_AUTH, ...VALIDATION }) } });
  p({ method: 'post', path: '/webhooks/sslcommerz', tags: ['payments'], summary: 'SSLCommerz IPN (form). Stored once per event, signature checked, re-validated with the gateway (FR-04)',
    request: { body: { content: { 'application/x-www-form-urlencoded': { schema: z.object({ tran_id: z.string(), val_id: z.string().optional(), status: z.string(), verify_sign: z.string(), verify_key: z.string() }).loose() } } } },
    responses: { 200: json(paymentsS.WebhookAck), ...errors({ 401: ['WEBHOOK_SIGNATURE_INVALID'] }) } });

  const VIEW = ADMIN_AUTH;
  p({ method: 'get', path: '/admin/payments', tags: ['payments'], summary: 'Payments for the finance desk (view_payouts or master)', security: adminBearer,
    request: { query: paymentsS.adminPaymentsQuery }, responses: { 200: json(paymentsS.AdminPaymentPage), ...errors({ ...VIEW, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/payments/config', tags: ['payments'], summary: 'Payment environment: provider, simulator and test-charge flags', security: adminBearer,
    responses: { 200: json(z.object({ testCharges: z.boolean(), simulator: z.boolean(), provider: z.string(), testChargeMax: z.number().int() })), ...errors(VIEW) } });
  p({ method: 'get', path: '/admin/payments/{id}', tags: ['payments'], summary: 'One payment with attempts, refunds, escrow hold and ledger transactions', security: adminBearer,
    request: idP, responses: { 200: json(paymentsS.AdminPayment), ...errors({ ...VIEW, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/payments/test-charges', tags: ['payments'], summary: 'Master test charge (dev and staging only): a real gateway payment held in escrow', security: adminBearer,
    request: { headers: idem, ...body(paymentsS.testChargeBody) },
    responses: { 201: json(paymentsS.TestCharge, 'Created'), ...errors({ ...MASTER_AUTH, 403: MASTER_AUTH[403].concat('TEST_CHARGES_DISABLED'), ...IDEM, 422: IDEM[422].concat('TEST_CHARGE_TOO_LARGE', 'PAYER_INVALID', 'PAYEE_INVALID') }) } });

  p({ method: 'get', path: '/admin/refunds', tags: ['payments'], summary: 'Refunds, with the escalation queue (status=pending_master)', security: adminBearer,
    request: { query: paymentsS.refundsQuery }, responses: { 200: json(paymentsS.RefundPage), ...errors({ ...VIEW, ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/refunds', tags: ['payments'], summary: 'Refund to the original method (refund_small up to the staff limit, else escalated; masters above it need step-up refund.large)', security: adminBearer,
    request: { headers: idem.extend({ 'x-step-up': z.string().optional() }), ...body(paymentsS.refundCreate) },
    responses: {
      201: json(paymentsS.Refund, 'Approved'),
      202: json(paymentsS.Refund, 'Escalated to a master (pending_master)'),
      ...errors({ ...ADMIN_AUTH, ...STEP, ...IDEM, 404: ['NOT_FOUND'], 409: ['PAYMENT_NOT_REFUNDABLE', 'ESCROW_FROZEN', 'IDEMPOTENCY_IN_PROGRESS'], 422: IDEM[422].concat('REFUND_EXCEEDS_CAPTURED', 'REFUND_EXCEEDS_HELD') }),
    } });
  for (const [action, schema, summary] of [
    ['approve', paymentsS.approveBody, 'Approve an escalated refund'],
    ['reject', paymentsS.rejectBody, 'Reject an escalated refund (note required)'],
  ]) {
    p({ method: 'post', path: `/admin/refunds/{id}/${action}`, tags: ['payments'], summary: `${summary} (master, step-up refund.large)`, security: adminBearer,
      request: { ...idP, headers: stepUpHeader, ...body(schema) },
      responses: { 200: json(paymentsS.Refund), ...errors({ ...MASTER_AUTH, ...STEP, 404: ['NOT_FOUND'], 409: ['REFUND_NOT_PENDING', 'ESCROW_FROZEN'], 422: ['VALIDATION_FAILED', 'REFUND_EXCEEDS_HELD'] }) } });
  }

  p({ method: 'get', path: '/admin/ledger/accounts', tags: ['payments'], summary: 'Ledger accounts with balances (search by code)', security: adminBearer,
    request: { query: paymentsS.accountsQuery }, responses: { 200: json(paymentsS.AccountList), ...errors({ ...VIEW, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/ledger/accounts/{id}/entries', tags: ['payments'], summary: 'Entries of one account, newest first', security: adminBearer,
    request: { ...idP, query: paymentsS.entriesQuery }, responses: { 200: json(paymentsS.Entries), ...errors({ ...VIEW, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/ledger/transactions/{id}', tags: ['payments'], summary: 'One balanced transaction with its lines', security: adminBearer,
    request: idP, responses: { 200: json(paymentsS.Transaction), ...errors({ ...VIEW, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/ledger/trial-balance', tags: ['payments'], summary: 'Trial balance: debit − credit must be 0', security: adminBearer,
    responses: { 200: json(paymentsS.TrialBalance), ...errors(VIEW) } });
  p({ method: 'get', path: '/admin/ledger/invariants', tags: ['payments'], summary: 'Run the ledger invariant checks now (read-only, FR-19)', security: adminBearer,
    responses: { 200: json(z.object({ ok: z.boolean(), checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string().nullable() })), checkedAt: z.string() })), ...errors(VIEW) } });

  p({ method: 'get', path: '/admin/escrow', tags: ['payments'], summary: 'Escrow holds with totals by status', security: adminBearer,
    request: { query: paymentsS.escrowQuery }, responses: { 200: json(paymentsS.HoldPage), ...errors({ ...VIEW, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/escrow/{id}', tags: ['payments'], summary: 'One escrow hold', security: adminBearer,
    request: idP, responses: { 200: json(paymentsS.Hold), ...errors({ ...VIEW, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/escrow/{id}/release', tags: ['payments'], summary: 'Release a hold to its payee by hand (master, step-up escrow.manage)', security: adminBearer,
    request: { ...idP, headers: stepUpHeader, ...body(paymentsS.releaseBody) },
    responses: { 200: json(paymentsS.Release), ...errors({ ...MASTER_AUTH, ...STEP, 404: ['NOT_FOUND'], 409: ['ESCROW_FROZEN', 'ESCROW_CLOSED', 'ESCROW_POOLED', 'ESCROW_EMPTY', 'LEDGER_INSUFFICIENT_BALANCE'], ...VALIDATION }) } });
  for (const [action, summary, conflict] of [
    ['freeze', 'Freeze a hold: no release, no automatic refund (master, step-up escrow.manage)', 'ESCROW_NOT_OPEN'],
    ['unfreeze', 'Unfreeze a hold (master, step-up escrow.manage)', 'ESCROW_NOT_FROZEN'],
  ]) {
    p({ method: 'post', path: `/admin/escrow/{id}/${action}`, tags: ['payments'], summary, security: adminBearer,
      request: { ...idP, headers: stepUpHeader, ...body(paymentsS.freezeBody) },
      responses: { 200: json(paymentsS.Hold), ...errors({ ...MASTER_AUTH, ...STEP, 404: ['NOT_FOUND'], 409: [conflict], ...VALIDATION }) } });
  }

  p({ method: 'get', path: '/admin/reconciliation/runs', tags: ['payments'], summary: 'Daily reconciliation runs, newest first', security: adminBearer,
    responses: { 200: json(paymentsS.RunPage), ...errors(VIEW) } });
  p({ method: 'post', path: '/admin/reconciliation/runs', tags: ['payments'], summary: 'Reconcile a business day now (master)', security: adminBearer,
    request: body(paymentsS.runBody), responses: { 201: json(paymentsS.Run, 'Created'), ...errors({ ...MASTER_AUTH, 409: ['RECON_RUN_EXISTS'], ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/reconciliation/runs/{id}/items', tags: ['payments'], summary: 'Items of a run (open=true: unresolved exceptions)', security: adminBearer,
    request: { ...idP, query: paymentsS.itemsQuery }, responses: { 200: json(paymentsS.ItemList), ...errors({ ...VIEW, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/reconciliation/items/{id}/resolve', tags: ['payments'], summary: 'Resolve an exception with a note (master)', security: adminBearer,
    request: { ...idP, ...body(paymentsS.resolveBody) }, responses: { 200: json(paymentsS.Item), ...errors({ ...MASTER_AUTH, 404: ['NOT_FOUND'], 409: ['RECON_ITEM_CLOSED'], ...VALIDATION }) } });

  // ------------------------------------------------------------------ M07 payouts
  const poIdP = { params: payoutsS.idParam };
  const PO_STATE = ['INVALID_STATE', 'PAYOUT_ACCOUNT_REQUIRED', 'PAYOUT_ACCOUNT_UNVERIFIED', 'PAYOUT_ON_HOLD'];
  const SELF = { 403: STEP[403].concat('SELF_PAYOUT_FORBIDDEN') };

  p({ method: 'get', path: '/me/payout-accounts', tags: ['payouts'], summary: 'My payout accounts (masked): the active one and any waiting for review', security: bearer,
    responses: { 200: json(payoutsS.AccountList), ...errors(COMMON_AUTH) } });
  p({ method: 'post', path: '/me/payout-accounts/otp', tags: ['payouts'], summary: 'Send a code to my registered phone to confirm a payout account change', security: bearer,
    responses: { 202: json(payoutsS.CodeSent, 'Accepted'), ...errors({ ...COMMON_AUTH, 409: ['PHONE_REQUIRED'], 429: ['OTP_RATE_LIMITED', 'OTP_COOLDOWN'] }) } });
  p({ method: 'post', path: '/me/payout-accounts', tags: ['payouts'], summary: 'Add or change my bKash / Nagad payout account (code required); staff check the name against my NID (FR-01, FR-02)', security: bearer,
    request: body(payoutsS.accountAdd),
    responses: { 201: json(payoutsS.Account, 'Created'), ...errors({ ...COMMON_AUTH, 400: ['OTP_INVALID', 'OTP_EXPIRED'], 409: ['PHONE_REQUIRED', 'PAYOUT_ACCOUNT_UNCHANGED'], 422: ['VALIDATION_FAILED', 'PAYOUT_ACCOUNT_INVALID'] }) } });
  p({ method: 'get', path: '/me/payouts/summary', tags: ['payouts'], summary: 'Next payout projection, on hold, fees owed, paid this month (FR-16)', security: bearer,
    responses: { 200: json(payoutsS.Summary), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/me/payouts', tags: ['payouts'], summary: 'My payouts, newest first', security: bearer,
    request: { query: payoutsS.meListQuery }, responses: { 200: json(payoutsS.MePage), ...errors({ ...COMMON_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/me/payouts/{id}', tags: ['payouts'], summary: 'One of my payouts with its lines', security: bearer,
    request: poIdP, responses: { 200: json(payoutsS.MeDetail), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'get', path: '/me/payouts/{id}/statement.csv', tags: ['payouts'], summary: 'Statement for one payout (CSV, EN or BN headings)', security: bearer,
    request: { ...poIdP, query: payoutsS.statementQuery },
    responses: { 200: { description: 'CSV file', content: { 'text/csv': { schema: z.string() } } }, ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], ...VALIDATION }) } });

  p({ method: 'get', path: '/admin/payouts', tags: ['payouts'], summary: 'Payouts for the finance desk, with counts per status (view_payouts)', security: adminBearer,
    request: { query: payoutsS.adminListQuery }, responses: { 200: json(payoutsS.AdminPage), ...errors({ ...VIEW, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/payouts/{id}', tags: ['payouts'], summary: 'One payout: lines, holds, approvals, reveals and ledger transactions', security: adminBearer,
    request: poIdP, responses: { 200: json(payoutsS.PayoutDetail), ...errors({ ...VIEW, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/payouts/{id}/release', tags: ['payouts'], summary: 'Release a payout up to the four-eyes threshold (release_payouts, step-up payout.approve)', security: adminBearer,
    request: { ...poIdP, headers: idem.extend({ 'x-step-up': z.string() }) },
    responses: { 200: json(payoutsS.Payout), ...errors({ ...ADMIN_AUTH, ...SELF, ...IDEM, 404: ['NOT_FOUND'], 409: PO_STATE.concat('FOUR_EYES_REQUIRED', 'LEDGER_INSUFFICIENT_BALANCE', 'IDEMPOTENCY_IN_PROGRESS') }) } });
  p({ method: 'post', path: '/admin/payouts/{id}/approve', tags: ['payouts'], summary: 'Approve a payout above the threshold: step 1 or 2 of 2, by different masters; step 2 releases it (step-up payout.approve)', security: adminBearer,
    request: { ...poIdP, headers: idem.extend({ 'x-step-up': z.string() }) },
    responses: { 200: json(payoutsS.Approved), ...errors({ ...MASTER_AUTH, ...SELF, ...IDEM, 404: ['NOT_FOUND'], 409: PO_STATE.concat('SAME_APPROVER', 'HOLD_ACTOR_CANNOT_APPROVE', 'LEDGER_INSUFFICIENT_BALANCE', 'IDEMPOTENCY_IN_PROGRESS') }) } });
  p({ method: 'post', path: '/admin/payouts/{id}/reveal', tags: ['payouts'], summary: 'Show the full wallet number of a released payout, to send it by hand. Audited (critical), never stored or logged', security: adminBearer,
    request: { ...poIdP, headers: stepUpHeader },
    responses: { 200: json(payoutsS.Reveal), ...errors({ ...ADMIN_AUTH, ...SELF, 404: ['NOT_FOUND'], 409: ['PAYOUT_REVEAL_FORBIDDEN'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/payouts/{id}/mark-paid', tags: ['payouts'], summary: 'Record the bKash / Nagad reference of a payout sent by hand (FR-08)', security: adminBearer,
    request: { ...poIdP, headers: idem, ...body(payoutsS.markPaidBody) },
    responses: { 200: json(payoutsS.Payout), ...errors({ ...ADMIN_AUTH, 403: ADMIN_AUTH[403].concat('SELF_PAYOUT_FORBIDDEN'), ...IDEM, 404: ['NOT_FOUND'], 409: ['INVALID_STATE', 'IDEMPOTENCY_IN_PROGRESS'] }) } });
  p({ method: 'post', path: '/admin/payouts/{id}/mark-failed', tags: ['payouts'], summary: 'The send failed: the money returns to the payee balance (FR-10)', security: adminBearer,
    request: { ...poIdP, ...body(payoutsS.markFailedBody) }, responses: { 200: json(payoutsS.Payout), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'], 409: ['INVALID_STATE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/payouts/{id}/retry', tags: ['payouts'], summary: 'Release a failed payout again (step-up payout.approve)', security: adminBearer,
    request: { ...poIdP, headers: stepUpHeader },
    responses: { 200: json(payoutsS.Payout), ...errors({ ...ADMIN_AUTH, ...SELF, 404: ['NOT_FOUND'], 409: PO_STATE.concat('PAYOUT_ACCOUNT_UPDATE_REQUIRED', 'LEDGER_INSUFFICIENT_BALANCE'), ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/payouts/{id}/cancel', tags: ['payouts'], summary: 'Cancel before sending (or after a failure); the lines return to the next run', security: adminBearer,
    request: { ...poIdP, ...body(payoutsS.cancelBody) }, responses: { 200: json(payoutsS.Payout), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'], 409: ['INVALID_STATE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/payouts/{id}/hold', tags: ['payouts'], summary: 'Put this payout (or every payout of the payee) on hold, with a reason', security: adminBearer,
    request: { ...poIdP, ...body(payoutsS.holdBody) }, responses: { 200: json(payoutsS.PayoutDetail), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'], 409: ['INVALID_STATE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/payouts/{id}/lift-hold', tags: ['payouts'], summary: 'Lift a manual hold (risk freezes are cleared on the Risk desk, FR-13)', security: adminBearer,
    request: { ...poIdP, ...body(payoutsS.liftBody) },
    responses: { 200: json(payoutsS.PayoutDetail), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'], 409: ['RISK_HOLD_MANAGED_IN_RISK', 'HOLD_NOT_LIFTABLE'], ...VALIDATION }) } });

  p({ method: 'get', path: '/admin/payout-batches', tags: ['payouts'], summary: 'Payout runs, newest first, with totals', security: adminBearer,
    request: { query: payoutsS.batchesQuery }, responses: { 200: json(payoutsS.BatchPage), ...errors({ ...VIEW, ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/payout-batches/run', tags: ['payouts'], summary: 'Build a payout run now (master): a catch-up, or in dev', security: adminBearer,
    request: body(payoutsS.runBody), responses: { 201: json(payoutsS.BatchRun, 'Created'), ...errors({ ...MASTER_AUTH, 400: ['SCHEDULE_INVALID'], ...VALIDATION }) } });

  p({ method: 'get', path: '/admin/payout-accounts', tags: ['payouts'], summary: 'Payout accounts to review, with the payee NID legal name and same-wallet warnings', security: adminBearer,
    request: { query: payoutsS.accountsQuery }, responses: { 200: json(payoutsS.ReviewPage), ...errors({ ...VIEW, ...VALIDATION }) } });
  for (const [action, schema, summary] of [
    ['verify', payoutsS.verifyBody, 'Approve: the account name matches the NID; replacing an account starts the change hold'],
    ['reject', payoutsS.rejectBody, 'Reject with a note the payee sees'],
  ]) {
    p({ method: 'post', path: `/admin/payout-accounts/{id}/${action}`, tags: ['payouts'], summary: `${summary} (release_payouts)`, security: adminBearer,
      request: { ...poIdP, ...body(schema) },
      responses: { 200: json(payoutsS.Account), ...errors({ ...ADMIN_AUTH, 403: ADMIN_AUTH[403].concat('SELF_REVIEW_FORBIDDEN'), 404: ['NOT_FOUND'], 409: ['PAYOUT_ACCOUNT_NOT_PENDING'], ...VALIDATION }) } });
  }

  // ------------------------------------------------------------------ M02 KYC (lite: NID)
  const kycDocP = { params: kycS.idParam };
  const kycFileP = { params: kycS.fileParams };
  const binary = (description) => ({ description, content: { 'image/jpeg': { schema: z.string() }, 'image/png': { schema: z.string() }, 'application/pdf': { schema: z.string() } } });
  const KYC_STAFF = { ...ADMIN_AUTH };

  p({ method: 'get', path: '/me/verification', tags: ['kyc'], summary: 'My verification checklist: phone and NID status, badge, unlocks and limits, the consent text and version to show, and the minimum age (FR-18, FR-05)', security: bearer,
    request: { query: kycS.verificationQuery }, responses: { 200: json(kycS.Verification), ...errors({ ...COMMON_AUTH, ...VALIDATION }) } });
  p({ method: 'post', path: '/me/documents/files', tags: ['kyc'], summary: 'Upload one NID image or PDF (raw body: image/jpeg, image/png or application/pdf; checked by its first bytes)', security: bearer,
    request: { query: kycS.uploadQuery, body: binary('The file itself, up to kyc.max_file_bytes') },
    responses: { 201: json(kycS.Uploaded, 'Created'), ...errors({ ...COMMON_AUTH, 413: ['FILE_TOO_LARGE', 'PAYLOAD_TOO_LARGE'], 415: ['FILE_TYPE_NOT_ALLOWED', 'FILE_TYPE_MISMATCH'], 422: ['VALIDATION_FAILED', 'FILE_EMPTY'], 429: ['UPLOAD_RATE_LIMITED'] }) } });
  p({ method: 'post', path: '/me/documents', tags: ['kyc'], summary: 'Submit my NID (number, date of birth, legal name, three files) or a business document of a role I applied for (fields from the requirement, one file), with consent { accepted: true, version } to the current text (FR-05)', security: bearer,
    request: body(kycS.submitBody),
    responses: { 201: json(kycS.Document, 'Created'), ...errors({ ...COMMON_AUTH, 409: ['PHONE_REQUIRED', 'DOC_ALREADY_APPROVED', 'MEMBER_NOT_ACTIVE', 'ROLE_NOT_APPLIED'], 422: ['VALIDATION_FAILED', 'CONSENT_REQUIRED', 'CONSENT_VERSION_STALE', 'NID_FORMAT_INVALID', 'DOB_INVALID', 'DOB_IN_FUTURE', 'UNDER_MIN_AGE', 'FILES_INCOMPLETE', 'DOC_TYPE_NOT_REQUIRED'] }) } });
  p({ method: 'get', path: '/me/documents/{id}/files/{fileId}', tags: ['kyc'], summary: 'View my own upload (no-store)', security: bearer,
    request: kycFileP, responses: { 200: binary('The file'), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], 410: ['FILE_PURGED'], ...VALIDATION }) } });

  p({ method: 'get', path: '/admin/kyc/documents/{id}', tags: ['kyc'], summary: 'The document panel on the Moderation desk: legal name, DOB, masked number, checks, files and history', security: adminBearer,
    request: kycDocP, responses: { 200: json(kycS.Review), ...errors({ ...KYC_STAFF, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/kyc/under-min-age', tags: ['kyc'], summary: 'Current NID documents (approved, in review, changes requested) whose holder is under kyc.min_age_years today in Dhaka: user, status, age, decided date. Read-only; every view is audited (no-store)', security: adminBearer,
    responses: { 200: json(kycS.UnderMinAge), ...errors(KYC_STAFF) } });
  p({ method: 'get', path: '/admin/kyc/documents/{id}/files/{fileId}', tags: ['kyc'], summary: 'View one image or PDF (inline, no-store, sandboxed). Every view is audited (FR-12)', security: adminBearer,
    request: kycFileP, responses: { 200: binary('The file'), ...errors({ ...KYC_STAFF, 404: ['NOT_FOUND'], 410: ['FILE_PURGED'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/kyc/documents/{id}/reveal-nid', tags: ['kyc'], summary: 'Show the full NID number for 60 seconds, with a reason (critical audit, FR-13)', security: adminBearer,
    request: { ...kycDocP, ...body(kycS.revealBody) }, responses: { 200: json(kycS.Reveal), ...errors({ ...KYC_STAFF, 403: KYC_STAFF[403].concat('SELF_REVIEW_FORBIDDEN'), 404: ['NOT_FOUND'], ...VALIDATION }) } });

  // ------------------------------------------------------------------ M05 Moderation (lite: the document kind)
  const subP = { params: modS.idParam };
  const MOD = { ...ADMIN_AUTH };
  const modIdem = z.object({ 'idempotency-key': z.string().meta({ description: '8–80 letters, digits, - or _. Retries with the same key and body replay the first response' }) });
  const MOD_IDEM = { 400: ['IDEMPOTENCY_KEY_REQUIRED', 'IDEMPOTENCY_KEY_INVALID'], 409: ['IDEMPOTENCY_IN_PROGRESS'], 422: ['VALIDATION_FAILED', 'IDEMPOTENCY_KEY_REUSED'] };

  p({ method: 'get', path: '/me/submissions', tags: ['moderation'], summary: 'My submissions and their decisions, with the reason and note (FR-14)', security: bearer,
    request: { query: modS.mineQuery }, responses: { 200: json(modS.OwnList), ...errors({ ...COMMON_AUTH, ...VALIDATION }) } });
  p({ method: 'post', path: '/me/submissions/{id}/withdraw', tags: ['moderation'], summary: 'Withdraw my open submission (kinds that allow it; documents are replaced by resubmitting)', security: bearer,
    request: subP, responses: { 200: json(modS.Own), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], 409: ['INVALID_STATE', 'WITHDRAW_NOT_ALLOWED'], ...VALIDATION }) } });

  p({ method: 'get', path: '/admin/submissions', tags: ['moderation'], summary: 'The Moderation queue: kinds I may review, oldest deadline first, with SLA and lock (FR-07, FR-17)', security: adminBearer,
    request: { query: modS.listQuery }, responses: { 200: json(modS.Queue), ...errors({ ...MOD, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/submissions/stats', tags: ['moderation'], summary: 'Desk KPIs: in the queue, overdue, claimed by me, decided today (Asia/Dhaka)', security: adminBearer,
    responses: { 200: json(modS.Stats), ...errors(MOD) } });
  p({ method: 'get', path: '/admin/submissions/{id}', tags: ['moderation'], summary: 'One submission: payload summary, latest checks, rubric, my ticks, reasons for the kind and version history. A kind I may not review is 404', security: adminBearer,
    request: subP, responses: { 200: json(modS.Detail), ...errors({ ...MOD, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/submissions/{id}/claim', tags: ['moderation'], summary: 'Claim the review lock (moderation.claim_ttl_min, capped at moderation.claim_max_min); checks re-run (FR-05, FR-08)', security: adminBearer,
    request: subP, responses: { 200: json(modS.Detail), ...errors({ ...MOD, 403: MOD[403].concat('SELF_REVIEW_FORBIDDEN'), 404: ['NOT_FOUND'], 409: ['ALREADY_CLAIMED', 'INVALID_STATE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/submissions/{id}/heartbeat', tags: ['moderation'], summary: 'Keep my lock while the review pane is open (every moderation.heartbeat_sec)', security: adminBearer,
    request: subP, responses: { 200: json(modS.Heartbeat), ...errors({ ...MOD, 403: MOD[403].concat('CLAIM_REQUIRED'), 404: ['NOT_FOUND'], 409: ['CLAIM_EXPIRED'], ...VALIDATION }) } });
  p({ method: 'put', path: '/admin/submissions/{id}/ticks', tags: ['moderation'], summary: 'Save my rubric ticks on the server (FR-09)', security: adminBearer,
    request: { ...subP, ...body(modS.ticksBody) }, responses: { 200: json(modS.Ticks), ...errors({ ...MOD, 403: MOD[403].concat('CLAIM_REQUIRED'), 404: ['NOT_FOUND'], 409: ['CLAIM_EXPIRED'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/submissions/{id}/release', tags: ['moderation'], summary: 'Release my lock; a master may force-release another reviewer’s lock (audited)', security: adminBearer,
    request: { ...subP, ...body(modS.releaseBody) }, responses: { 200: json(modS.Released), ...errors({ ...MOD, 403: MOD[403].concat('CLAIM_REQUIRED'), 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/submissions/{id}/decide', tags: ['moderation'], summary: 'Approve (every rubric tick, no failing hard check), request changes or reject (a reason for the kind). A master may approve over a failing check with step-up moderation.override and a reason (Q46)', security: adminBearer,
    request: { ...subP, headers: modIdem.extend({ 'x-step-up': z.string().optional().meta({ description: 'Required with override' }) }), ...body(modS.decideBody) },
    responses: {
      200: json(modS.Detail),
      ...errors({ ...MOD, ...MOD_IDEM, 403: MOD[403].concat('SELF_REVIEW_FORBIDDEN', 'CLAIM_REQUIRED', 'STEP_UP_REQUIRED'), 404: ['NOT_FOUND'], 409: ['INVALID_STATE', 'CLAIM_EXPIRED', 'IDEMPOTENCY_IN_PROGRESS'], 422: MOD_IDEM[422].concat('RUBRIC_INCOMPLETE', 'CHECK_FAILED', 'CHECK_LOCKED', 'REASON_REQUIRED', 'REASON_NOT_ALLOWED_FOR_KIND') }),
    } });
  p({ method: 'post', path: '/admin/submissions/{id}/reopen', tags: ['moderation'], summary: 'Master: reopen a decided submission for review, with a reason (step-up moderation.override, critical audit)', security: adminBearer,
    request: { ...subP, headers: stepUpHeader, ...body(modS.reopenBody) }, responses: { 200: json(modS.Detail), ...errors({ ...MOD, 403: MOD[403].concat('STEP_UP_REQUIRED'), 404: ['NOT_FOUND'], 409: ['INVALID_STATE'], ...VALIDATION }) } });

  // ------------------------------------------------------------------ M21 Esports (step 1)
  const esId = { params: esS.idParam };
  const ES = { ...ADMIN_AUTH };
  const esIdem = z.object({ 'idempotency-key': z.string().meta({ description: '8–80 letters, digits, - or _. Retries with the same key and body replay the first response' }) });
  const ES_IDEM = { 400: ['IDEMPOTENCY_KEY_REQUIRED', 'IDEMPOTENCY_KEY_INVALID'], 409: ['IDEMPOTENCY_IN_PROGRESS'], 422: ['VALIDATION_FAILED', 'IDEMPOTENCY_KEY_REUSED'] };
  const esMoney = { headers: stepUpHeader };
  const NF = { 404: ['NOT_FOUND'] };
  const image = (description) => ({ description, content: { 'image/jpeg': { schema: z.string() }, 'image/png': { schema: z.string() } } });

  // public
  p({ method: 'get', path: '/esports/games', tags: ['esports'], summary: 'Games with their modes, maps and points presets (M03 catalogue)', responses: { 200: json(z.object({ items: z.array(z.object({}).loose()) })) } });
  p({ method: 'get', path: '/esports/tournaments', tags: ['esports'], summary: 'Published tournaments, by start time (filters: game key, mode, tier, status, featured; cursor)',
    request: { query: esS.listQuery }, responses: { 200: json(esS.TournamentList), ...errors(VALIDATION) } });
  p({ method: 'get', path: '/esports/tournaments/{id}', tags: ['esports'], summary: 'A tournament by slug or id: prize table, schedule, slots taken, streams',
    request: { params: esS.slugParam }, responses: { 200: json(esS.Tournament), ...errors({ ...NF, ...VALIDATION }) } });
  p({ method: 'get', path: '/esports/tournaments/{id}/standings', tags: ['esports'], summary: 'Standings with tie-breakers (points, wins, kills, latest placement, registration time)',
    request: esId, responses: { 200: json(esS.Standings), ...errors({ ...NF, ...VALIDATION }) } });
  p({ method: 'post', path: '/esports/tournaments/{id}/registrations', tags: ['esports'], summary: 'Register (gate join_esports; every player needs a verified UID): a slot held for esports.payment_hold_minutes with an M06 payment, or the waitlist when full (FR-08 to FR-10)', security: bearer,
    request: { ...esId, headers: esIdem, ...body(esS.registerBody) },
    responses: {
      201: json(esS.Registered, 'Created'),
      ...errors({ ...COMMON_AUTH, ...ES_IDEM, 403: ['PHONE_REQUIRED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_BANNED', 'ESPORTS_GAME_PROFILE_REQUIRED', 'ESPORTS_UID_BANNED', 'ESPORTS_NOT_IN_SQUAD', 'ESPORTS_SQUAD_CAPTAIN_ONLY'], ...NF, 409: ['ESPORTS_REGISTRATION_CLOSED', 'ESPORTS_ALREADY_REGISTERED', 'IDEMPOTENCY_IN_PROGRESS'], 422: ES_IDEM[422].concat('ESPORTS_SQUAD_SIZE_INVALID') }),
    } });
  p({ method: 'get', path: '/esports/matches/{id}', tags: ['esports'], summary: 'A match: status and its posted results', request: esId, responses: { 200: json(esS.Match), ...errors({ ...NF, ...VALIDATION }) } });
  p({ method: 'get', path: '/esports/leaderboards', tags: ['esports'], summary: 'Top players for a game: rolling (decayed) or a season; the formula is in the response (FR-27, FR-28)',
    request: { query: esS.leaderboardQuery }, responses: { 200: json(esS.Leaderboard), ...errors({ ...NF, ...VALIDATION }) } });
  p({ method: 'get', path: '/esports/top-players', tags: ['esports'], summary: 'Best rolling ranks across games (home pages)', responses: { 200: json(esS.TopPlayers) } });
  p({ method: 'get', path: '/esports/players/{handle}', tags: ['esports'], summary: 'A player by username or id: games, IGNs, masked UIDs, ranks, wins, kills (FR-32)',
    request: { params: esS.handleParam }, responses: { 200: json(esS.Player), ...errors({ ...NF, ...VALIDATION }) } });

  // player
  p({ method: 'post', path: '/me/esports/uploads', tags: ['esports'], summary: 'Upload a screenshot (raw JPEG or PNG, checked by its first bytes); returns a key for a profile or evidence', security: bearer,
    request: { body: image('The screenshot itself') }, responses: { 201: json(esS.Upload, 'Created'), ...errors({ ...COMMON_AUTH, 413: ['FILE_TOO_LARGE', 'PAYLOAD_TOO_LARGE'], 415: ['FILE_TYPE_NOT_ALLOWED', 'FILE_TYPE_MISMATCH'], 422: ['FILE_EMPTY'], 429: ['UPLOAD_RATE_LIMITED'] }) } });
  p({ method: 'get', path: '/me/esports/profiles', tags: ['esports'], summary: 'My game UIDs and their review status', security: bearer, responses: { 200: json(esS.ProfileList), ...errors(COMMON_AUTH) } });
  p({ method: 'post', path: '/me/esports/profiles', tags: ['esports'], summary: 'Add a UID and IGN with a screenshot; reviewed on the Moderation desk (FR-02, FR-03)', security: bearer,
    request: body(esS.profileBody), responses: { 201: json(esS.Profile, 'Created'), ...errors({ ...COMMON_AUTH, 403: ['ESPORTS_UID_BANNED'], 409: ['ESPORTS_UID_TAKEN', 'ESPORTS_PROFILE_EXISTS'], 422: ['VALIDATION_FAILED', 'ESPORTS_GAME_UNKNOWN', 'ESPORTS_UID_FORMAT', 'ESPORTS_IGN_INVALID', 'ESPORTS_UPLOAD_INVALID'] }) } });
  p({ method: 'post', path: '/me/esports/profiles/{id}/unlink', tags: ['esports'], summary: 'Remove a UID (not while it is in an active entry); leaves that game\'s squad', security: bearer,
    request: esId, responses: { 200: json(esS.Profile), ...errors({ ...COMMON_AUTH, ...NF, 409: ['ESPORTS_PROFILE_IN_USE'], ...VALIDATION }) } });
  p({ method: 'get', path: '/me/esports/squads', tags: ['esports'], summary: 'My squads and invites', security: bearer, responses: { 200: json(esS.SquadList), ...errors(COMMON_AUTH) } });
  p({ method: 'post', path: '/me/esports/squads', tags: ['esports'], summary: 'Create a squad (needs a verified UID for the game; one squad per game)', security: bearer,
    request: body(esS.squadBody), responses: { 201: json(esS.Squad, 'Created'), ...errors({ ...COMMON_AUTH, 403: ['ESPORTS_GAME_PROFILE_REQUIRED'], 409: ['ESPORTS_ALREADY_IN_SQUAD', 'ESPORTS_SQUAD_NAME_TAKEN'], 422: ['VALIDATION_FAILED', 'ESPORTS_GAME_UNKNOWN'] }) } });
  p({ method: 'post', path: '/me/esports/squads/join', tags: ['esports'], summary: 'Join with an invite code', security: bearer,
    request: body(esS.joinBody), responses: { 200: json(esS.Squad), ...errors({ ...COMMON_AUTH, 403: ['ESPORTS_GAME_PROFILE_REQUIRED'], 404: ['ESPORTS_SQUAD_INVITE_UNKNOWN'], 409: ['ESPORTS_ALREADY_IN_SQUAD', 'ESPORTS_SQUAD_FULL'], ...VALIDATION }) } });
  p({ method: 'post', path: '/me/esports/squads/{id}/invites', tags: ['esports'], summary: 'Invite a player by username (captain)', security: bearer,
    request: { ...esId, ...body(esS.inviteBody) }, responses: { 200: json(esS.Squad), ...errors({ ...COMMON_AUTH, 403: ['ESPORTS_SQUAD_CAPTAIN_ONLY'], ...NF, 409: ['ESPORTS_SQUAD_FULL'], ...VALIDATION }) } });
  p({ method: 'post', path: '/me/esports/squads/{id}/leave', tags: ['esports'], summary: 'Leave a squad (the captaincy passes on; the last member out disbands it)', security: bearer,
    request: esId, responses: { 200: json(esS.Left), ...errors({ ...COMMON_AUTH, 403: ['ESPORTS_NOT_IN_SQUAD'], ...NF, ...VALIDATION }) } });
  p({ method: 'post', path: '/me/esports/squads/{id}/captain', tags: ['esports'], summary: 'Hand the captaincy to a member (captain)', security: bearer,
    request: { ...esId, ...body(esS.captainBody) }, responses: { 200: json(esS.Squad), ...errors({ ...COMMON_AUTH, 403: ['ESPORTS_SQUAD_CAPTAIN_ONLY', 'ESPORTS_NOT_IN_SQUAD'], ...NF, ...VALIDATION }) } });
  p({ method: 'delete', path: '/me/esports/squads/{id}/members/{userId}', tags: ['esports'], summary: 'Remove a member (captain)', security: bearer,
    request: { params: esS.memberParams }, responses: { 200: json(esS.Squad), ...errors({ ...COMMON_AUTH, 403: ['ESPORTS_SQUAD_CAPTAIN_ONLY', 'ESPORTS_NOT_IN_SQUAD'], ...NF, ...VALIDATION }) } });
  p({ method: 'post', path: '/me/esports/squad-invites/{id}/accept', tags: ['esports'], summary: 'Accept a squad invite', security: bearer,
    request: esId, responses: { 200: json(esS.Squad), ...errors({ ...COMMON_AUTH, 403: ['ESPORTS_GAME_PROFILE_REQUIRED'], 404: ['ESPORTS_SQUAD_INVITE_UNKNOWN', 'NOT_FOUND'], 409: ['ESPORTS_ALREADY_IN_SQUAD', 'ESPORTS_SQUAD_FULL'], ...VALIDATION }) } });
  p({ method: 'post', path: '/me/esports/squad-invites/{id}/decline', tags: ['esports'], summary: 'Decline a squad invite', security: bearer,
    request: esId, responses: { 200: json(esS.Squad), ...errors({ ...COMMON_AUTH, 404: ['ESPORTS_SQUAD_INVITE_UNKNOWN', 'NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'get', path: '/me/esports/registrations', tags: ['esports'], summary: 'My entries, with their tournament, matches and any payment still to make', security: bearer,
    responses: { 200: json(esS.RegistrationList), ...errors(COMMON_AUTH) } });
  p({ method: 'post', path: '/me/esports/registrations/{id}/accept-offer', tags: ['esports'], summary: 'Take a waitlist slot offer (pay within the hold, Q124)', security: bearer,
    request: { ...esId, headers: esIdem }, responses: { 200: json(esS.Registered), ...errors({ ...COMMON_AUTH, ...ES_IDEM, ...NF, 409: ['ESPORTS_REGISTRATION_STATE', 'ESPORTS_OFFER_EXPIRED', 'ESPORTS_REGISTRATION_CLOSED', 'SLOTS_FULL', 'IDEMPOTENCY_IN_PROGRESS'] }) } });
  p({ method: 'post', path: '/me/esports/registrations/{id}/withdraw', tags: ['esports'], summary: 'Withdraw: before registration closes the fee is refunded (esports.withdraw_refund_pct); after, it is forfeited (Q122)', security: bearer,
    request: esId, responses: { 200: json(esS.Registration), ...errors({ ...COMMON_AUTH, ...NF, 409: ['ESPORTS_REGISTRATION_STATE'], ...VALIDATION }) } });
  p({ method: 'put', path: '/me/esports/registrations/{id}/prize-split', tags: ['esports'], summary: 'Declare the prize split (captain, before the first match; whole percents summing to 100)', security: bearer,
    request: { ...esId, ...body(esS.splitBody) }, responses: { 200: json(esS.Registration), ...errors({ ...COMMON_AUTH, ...NF, 409: ['ESPORTS_REGISTRATION_STATE', 'ESPORTS_SPLIT_LOCKED'], 422: ['VALIDATION_FAILED', 'SPLIT_INVALID'] }) } });
  p({ method: 'post', path: '/me/esports/registrations/{id}/check-in', tags: ['esports'], summary: 'Check in for the stage (within the window); the entry is checked in when enough players are', security: bearer,
    request: esId, responses: { 200: json(esS.Registration), ...errors({ ...COMMON_AUTH, ...NF, 403: ['ESPORTS_NOT_IN_MATCH'], 409: ['ESPORTS_REGISTRATION_STATE', 'ESPORTS_CHECKIN_CLOSED'], ...VALIDATION }) } });
  p({ method: 'get', path: '/me/esports/matches/{id}/room', tags: ['esports'], summary: 'The room ID and password: checked-in players only, from the reveal time; audited, rate-limited, no-store (FR-15, FR-16)', security: bearer,
    request: esId, responses: { 200: json(esS.Room), ...errors({ ...COMMON_AUTH, ...NF, 403: ['ESPORTS_NOT_CHECKED_IN'], 409: ['ESPORTS_ROOM_NOT_REVEALED', 'ESPORTS_ROOM_NOT_SET'], ...RATE, ...VALIDATION }) } });
  p({ method: 'post', path: '/me/esports/matches/{id}/evidence', tags: ['esports'], summary: 'Add evidence for a match: a screenshot (upload key) or a video link', security: bearer,
    request: { ...esId, ...body(esS.evidenceBody) }, responses: { 201: json(esS.Evidence, 'Created'), ...errors({ ...COMMON_AUTH, ...NF, 403: ['ESPORTS_NOT_IN_MATCH'], 422: ['VALIDATION_FAILED', 'ESPORTS_UPLOAD_INVALID', 'STREAM_URL_INVALID'] }) } });
  p({ method: 'post', path: '/me/esports/matches/{id}/disputes', tags: ['esports'], summary: 'Dispute posted results within the window, with evidence (FR-20; built in until M17)', security: bearer,
    request: { ...esId, ...body(esS.disputeBody) }, responses: { 201: json(esS.Dispute, 'Created'), ...errors({ ...COMMON_AUTH, ...NF, 403: ['ESPORTS_NOT_IN_MATCH'], 409: ['ESPORTS_DISPUTE_WINDOW_CLOSED', 'ESPORTS_DISPUTE_LIMIT'], ...VALIDATION }) } });
  p({ method: 'get', path: '/me/esports/winnings', tags: ['esports'], summary: 'My withdrawable winnings and prize history', security: bearer, responses: { 200: json(esS.Winnings), ...errors(COMMON_AUTH) } });

  // M07 on-demand withdrawal (M21-FR-26)
  const wd = z.object({ id: z.uuid(), code: z.string(), amount: z.number().int(), status: z.string(), createdAt: dateTimeOf(), paidAt: dateTimeOf().nullable() }).meta({ id: 'Withdrawal' });
  p({ method: 'get', path: '/me/withdrawals', tags: ['payouts'], summary: 'My withdrawals of winnings', security: bearer, responses: { 200: json(z.object({ items: z.array(wd) })), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/me/withdrawals/available', tags: ['payouts'], summary: 'What I can withdraw now (minimum and today\'s limit applied)', security: bearer,
    responses: { 200: json(z.object({ amount: z.number().int(), withdrawable: z.number().int(), dailyLeft: z.number().int(), minimum: z.number().int() }).meta({ id: 'WithdrawalAvailable' })), ...errors(COMMON_AUTH) } });
  p({ method: 'post', path: '/me/withdrawals', tags: ['payouts'], summary: 'Withdraw my esports winnings to my verified bKash / Nagad account (gate withdraw_winnings: NID KYC; minimum and daily limit)', security: bearer,
    request: { headers: esIdem },
    responses: { 201: json(z.object({}).loose().meta({ description: 'The payout (kind withdrawal)' }), 'Created'), ...errors({ ...COMMON_AUTH, ...ES_IDEM, 403: ['KYC_REQUIRED', 'KYC_PENDING', 'ACCOUNT_SUSPENDED', 'ACCOUNT_BANNED'], 409: ['WITHDRAW_OPEN', 'WITHDRAW_NOTHING', 'PAYOUT_ACCOUNT_REQUIRED', 'IDEMPOTENCY_IN_PROGRESS'], 422: ES_IDEM[422].concat('WITHDRAW_BELOW_MINIMUM', 'WITHDRAW_DAILY_LIMIT') }) } });

  // staff
  p({ method: 'get', path: '/admin/esports/tournaments', tags: ['esports'], summary: 'Tournaments in every status (manage_esports or enter_results); status is a comma list', security: adminBearer,
    request: { query: esS.adminListQuery }, responses: { 200: json(esS.TournamentList), ...errors({ ...ES, ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/esports/tournaments', tags: ['esports'], summary: 'Create a draft: game, mode, format, tier, fee, slots, minimum, prize table, kill reward, points (preset or custom), schedule, rules (FR-06)', security: adminBearer,
    request: body(esS.tournamentBody), responses: { 201: json(esS.Tournament, 'Created'), ...errors({ ...ES, 422: ['VALIDATION_FAILED', 'ESPORTS_GAME_UNKNOWN', 'POINTS_INVALID'] }) } });
  p({ method: 'get', path: '/admin/esports/tournaments/{id}', tags: ['esports'], summary: 'A tournament with its staff fields (snapshot, settlement, submission)', security: adminBearer,
    request: esId, responses: { 200: json(esS.Tournament), ...errors({ ...ES, ...NF, ...VALIDATION }) } });
  p({ method: 'patch', path: '/admin/esports/tournaments/{id}', tags: ['esports'], summary: 'Edit: a draft takes the whole body; after submit only title, rules and featured (ESPORTS_PRIZE_TABLE_LOCKED)', security: adminBearer,
    request: { ...esId, ...body(esS.tournamentPatch) }, responses: { 200: json(esS.Tournament), ...errors({ ...ES, ...NF, 409: ['ESPORTS_PRIZE_TABLE_LOCKED', 'ESPORTS_TOURNAMENT_STATE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/esports/tournaments/{id}/submit', tags: ['esports'], summary: 'Send for review on the Moderation desk (kind esports_tournament; another reviewer approves, FR-07)', security: adminBearer,
    request: esId, responses: { 200: json(esS.Tournament), ...errors({ ...ES, ...NF, 409: ['ESPORTS_TOURNAMENT_STATE'], 422: ['PRIZE_TABLE_REQUIRED', 'PRIZE_PLACES_INVALID', 'PRIZE_AMOUNT_INVALID', 'MIN_ABOVE_MAX', 'ENTRY_UNIT_INVALID', 'SLOTS_ABOVE_LOBBY', 'SCHEDULE_INVALID', 'POINTS_INVALID'] }) } });
  p({ method: 'post', path: '/admin/esports/tournaments/{id}/cancel', tags: ['esports'], summary: 'Cancel with a reason (step-up esports.money): every paid entry refunded 100% (FR-30)', security: adminBearer,
    request: { ...esId, ...esMoney, ...body(esS.cancelBody) }, responses: { 200: json(esS.Tournament), ...errors({ ...ES, 403: ES[403].concat('STEP_UP_REQUIRED'), ...NF, 409: ['ESPORTS_TOURNAMENT_STATE'], ...VALIDATION }) } });
  p({ method: 'put', path: '/admin/esports/tournaments/{id}/streams', tags: ['esports'], summary: 'Replace the stream links (https on YouTube, Facebook, TikTok) and mark them live (FR-29)', security: adminBearer,
    request: { ...esId, ...body(esS.streamsBody) }, responses: { 200: json(esS.Tournament), ...errors({ ...ES, ...NF, 422: ['VALIDATION_FAILED', 'STREAM_URL_INVALID'] }) } });
  p({ method: 'get', path: '/admin/esports/tournaments/{id}/checkins', tags: ['esports'], summary: 'The check-in board: entries, players, who checked in, the waitlist', security: adminBearer,
    request: esId, responses: { 200: json(esS.Board), ...errors({ ...ES, ...NF, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/esports/tournaments/{id}/finalise-preview', tags: ['esports'], summary: 'Awards by final rank, shares, and the ledger outcome (subsidy or revenue)', security: adminBearer,
    request: esId, responses: { 200: json(esS.Preview), ...errors({ ...ES, ...NF, ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/esports/tournaments/{id}/finalise', tags: ['esports'], summary: 'Finalise and credit prizes through the M06 pool settlement (step-up esports.money; escrow ends at zero, FR-23 to FR-25)', security: adminBearer,
    request: { ...esId, ...esMoney }, responses: { 200: json(esS.Tournament), ...errors({ ...ES, 403: ES[403].concat('STEP_UP_REQUIRED'), ...NF, 409: ['ESPORTS_NOT_FINALISABLE', 'ESCROW_FROZEN'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/esports/registrations/{id}/check-in', tags: ['esports'], summary: 'Check a player in by hand (audited; edge case 7)', security: adminBearer,
    request: { ...esId, ...body(esS.staffCheckinBody) }, responses: { 200: json(esS.Registration), ...errors({ ...ES, ...NF, 403: ES[403].concat('ESPORTS_NOT_IN_MATCH'), 409: ['ESPORTS_REGISTRATION_STATE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/esports/registrations/{id}/disqualify', tags: ['esports'], summary: 'Disqualify an entry: out of the standings, prize forfeited (reversed if credited and unwithdrawn), optional UID ban (FR-22)', security: adminBearer,
    request: { ...esId, ...body(esS.dqBody) }, responses: { 200: json(esS.Disqualified), ...errors({ ...ES, ...NF, 409: ['ESPORTS_ALREADY_DISQUALIFIED', 'ESPORTS_TOURNAMENT_STATE'], ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/esports/matches/{id}', tags: ['esports'], summary: 'A match for staff: entries, draft and posted results, disputes', security: adminBearer,
    request: esId, responses: { 200: json(esS.Match), ...errors({ ...ES, ...NF, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/esports/matches/{id}/room', tags: ['esports'], summary: 'The room panel: versions, reveal time, number of views (no secret)', security: adminBearer,
    request: esId, responses: { 200: json(esS.RoomPanel), ...errors({ ...ES, ...NF, ...VALIDATION }) } });
  p({ method: 'put', path: '/admin/esports/matches/{id}/room', tags: ['esports'], summary: 'Set the room ID and password (encrypted; reveal at starts_at − esports.room_reveal_minutes unless given)', security: adminBearer,
    request: { ...esId, ...body(esS.roomBody) }, responses: { 200: json(esS.RoomPanel), ...errors({ ...ES, ...NF, 409: ['ESPORTS_MATCH_STATE', 'ESPORTS_TOURNAMENT_STATE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/esports/matches/{id}/room/rotate', tags: ['esports'], summary: 'Rotate leaked credentials: a new version, pushed at once to checked-in players (FR-17)', security: adminBearer,
    request: { ...esId, ...body(esS.rotateBody) }, responses: { 200: json(esS.RoomPanel), ...errors({ ...ES, ...NF, 409: ['ESPORTS_ROOM_NOT_SET'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/esports/matches/{id}/room/reveal-now', tags: ['esports'], summary: 'Reveal now to checked-in players', security: adminBearer,
    request: esId, responses: { 200: json(esS.RoomPanel), ...errors({ ...ES, ...NF, 409: ['ESPORTS_ROOM_NOT_SET'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/esports/matches/{id}/room/view', tags: ['esports'], summary: 'Read the secret as staff (audited view, no-store)', security: adminBearer,
    request: esId, responses: { 200: json(esS.StaffRoom), ...errors({ ...ES, ...NF, 409: ['ESPORTS_ROOM_NOT_SET'], ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/esports/matches/{id}/room/views', tags: ['esports'], summary: 'Who saw which version of the room, and when (FR-16)', security: adminBearer,
    request: esId, responses: { 200: json(esS.Views), ...errors({ ...ES, ...VALIDATION }) } });
  p({ method: 'put', path: '/admin/esports/matches/{id}/results', tags: ['esports'], summary: 'Enter results as a draft (enter_results): placement and kills per player (FR-18)', security: adminBearer,
    request: { ...esId, ...body(esS.resultsBody) },
    responses: { 200: json(esS.Match), ...errors({ ...ES, ...NF, 409: ['ESPORTS_MATCH_STATE'], 422: ['VALIDATION_FAILED', 'ESPORTS_RESULT_ENTRY_UNKNOWN', 'ESPORTS_PLACEMENT_INVALID', 'ESPORTS_PLACEMENT_DUPLICATE', 'ESPORTS_KILLS_MISMATCH'] }) } });
  p({ method: 'post', path: '/admin/esports/matches/{id}/results/post', tags: ['esports'], summary: 'Post results: visible, the dispute window opens; missing entries count as not played (FR-20)', security: adminBearer,
    request: esId, responses: { 200: json(esS.Match), ...errors({ ...ES, ...NF, 409: ['ESPORTS_MATCH_STATE', 'ESPORTS_TOO_EARLY'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/esports/matches/{id}/cancel', tags: ['esports'], summary: 'Cancel a match (lobby crash); the standings use the other matches', security: adminBearer,
    request: { ...esId, ...body(esS.cancelBody) }, responses: { 200: json(esS.Match), ...errors({ ...ES, ...NF, 409: ['ESPORTS_MATCH_STATE'], ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/esports/disputes', tags: ['esports'], summary: 'Result disputes (open first)', security: adminBearer,
    request: { query: esS.disputesQuery }, responses: { 200: json(esS.DisputeList), ...errors({ ...ES, ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/esports/disputes/{id}/resolve', tags: ['esports'], summary: 'Resolve a dispute: reject, or correct the results; the match then continues or becomes final', security: adminBearer,
    request: { ...esId, ...body(esS.resolveBody) },
    responses: { 200: json(esS.Dispute), ...errors({ ...ES, ...NF, 409: ['ESPORTS_DISPUTE_NOT_OPEN'], 422: ['VALIDATION_FAILED', 'ESPORTS_RESULT_ENTRY_UNKNOWN', 'ESPORTS_PLACEMENT_INVALID', 'ESPORTS_PLACEMENT_DUPLICATE', 'ESPORTS_KILLS_MISMATCH'] }) } });
  p({ method: 'get', path: '/admin/esports/uid-bans', tags: ['esports'], summary: 'UID bans', security: adminBearer, request: { query: esS.bansQuery }, responses: { 200: json(esS.BanList), ...errors({ ...ES, ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/esports/uid-bans', tags: ['esports'], summary: 'Ban a UID: profiles banned, open entries disqualified with no refund (FR-04)', security: adminBearer,
    request: body(esS.banBody), responses: { 201: json(esS.Ban, 'Created'), ...errors({ ...ES, 422: ['VALIDATION_FAILED', 'ESPORTS_GAME_UNKNOWN'] }) } });
  p({ method: 'post', path: '/admin/esports/uid-bans/{id}/lift', tags: ['esports'], summary: 'Lift a ban (the player can add the UID again)', security: adminBearer,
    request: { ...esId, ...body(esS.liftBody) }, responses: { 200: json(esS.Ban), ...errors({ ...ES, ...NF, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/esports/profiles/{id}/screenshot', tags: ['esports'], summary: 'A UID screenshot for the Moderation desk (approve_listings or manage_esports; audited, no-store)', security: adminBearer,
    request: esId, responses: { 200: image('The screenshot'), ...errors({ ...ES, ...NF, ...VALIDATION }) } });

  // ------------------------------------------------------------------ M09 grounds
  const grId = { params: grS.idParam };
  const OWNER = { ...COMMON_AUTH, 403: ['ROLE_REQUIRED', 'KYC_REQUIRED', 'PHONE_REQUIRED', 'NOT_OWNER'], 404: ['NOT_FOUND'] };
  const photo = (description) => ({ description, content: { 'image/jpeg': { schema: z.string() }, 'image/png': { schema: z.string() }, 'image/webp': { schema: z.string() } } });
  p({ method: 'get', path: '/grounds', tags: ['grounds'], summary: 'Live grounds: filters, facet counts, sorts cheapest / nearest / newest (FR-25)', request: { query: grS.listQuery }, responses: { 200: json(grS.GroundList), ...errors(VALIDATION) } });
  p({ method: 'get', path: '/grounds/{slug}', tags: ['grounds'], summary: 'A live ground: facts, courts and hours, facilities, rules, price table, v3 payment line (FR-27; ETag)',
    request: { params: grS.slugParam }, responses: { 200: json(grS.GroundDetail), 304: { description: 'Not modified' }, ...errors({ 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'post', path: '/grounds/{id}/quote', tags: ['grounds'], summary: 'Price a slot on public courts: both payment options and the platform fee (FR-13)',
    request: { ...grId, ...body(grS.publicQuote) }, responses: { 200: json(grS.Quote), ...errors({ 404: ['NOT_FOUND'], 409: ['PRICING_MISSING'], 422: ['VALIDATION_FAILED', 'COURT_UNKNOWN', 'NOT_COMBINABLE', 'LENGTH_INVALID', 'OUTSIDE_HOURS'] }) } });

  p({ method: 'get', path: '/me/grounds', tags: ['grounds'], summary: 'My grounds (ground owner)', security: bearer, responses: { 200: json(grS.OwnerGroundList), ...errors(OWNER) } });
  p({ method: 'post', path: '/me/grounds', tags: ['grounds'], summary: 'Start a ground: a draft with a first pricing draft (FR-01; gate list_ground)', security: bearer,
    request: body(grS.createGround), responses: { 201: json(grS.OwnerGround, 'Created'), ...errors({ ...OWNER, 422: ['VALIDATION_FAILED', 'AREA_NOT_SERVED', 'CATALOG_ITEM_UNKNOWN'] }) } });
  p({ method: 'get', path: '/me/grounds/{id}', tags: ['grounds'], summary: 'My ground: the working copy with photos, courts and hours', security: bearer, request: grId, responses: { 200: json(grS.OwnerGround), ...errors(OWNER) } });
  p({ method: 'patch', path: '/me/grounds/{id}', tags: ['grounds'], summary: 'Edit my ground; on a live ground, review fields start an edit and the rest apply at once (FR-04)', security: bearer,
    request: { ...grId, ...body(grS.updateGround) }, responses: { 200: json(grS.OwnerGround), ...errors({ ...OWNER, 409: ['GROUND_IN_REVIEW', 'GROUND_STATE'], 422: ['VALIDATION_FAILED', 'AREA_NOT_SERVED', 'CATALOG_ITEM_UNKNOWN'] }) } });
  p({ method: 'post', path: '/me/grounds/{id}/submit', tags: ['grounds'], summary: 'Send the ground, or an edit of a live ground, for review (FR-02, FR-03)', security: bearer,
    request: grId, responses: { 200: json(grS.OwnerGround), ...errors({ ...OWNER, 409: ['GROUND_IN_REVIEW', 'GROUND_STATE', 'NOTHING_TO_REVIEW'], 422: ['GROUND_INCOMPLETE'] }) } });
  p({ method: 'post', path: '/me/grounds/{id}/withdraw', tags: ['grounds'], summary: 'Take the ground (or its edit) out of review', security: bearer, request: grId, responses: { 200: json(grS.OwnerGround), ...errors({ ...OWNER, 409: ['GROUND_STATE'] }) } });
  p({ method: 'post', path: '/me/grounds/{id}/pause', tags: ['grounds'], summary: 'Hide a live ground; bookings stay (FR-05)', security: bearer, request: grId, responses: { 200: json(grS.OwnerGround), ...errors({ ...OWNER, 409: ['GROUND_STATE'] }) } });
  p({ method: 'post', path: '/me/grounds/{id}/resume', tags: ['grounds'], summary: 'Show a paused ground again', security: bearer, request: grId, responses: { 200: json(grS.OwnerGround), ...errors({ ...OWNER, 409: ['GROUND_STATE'] }) } });
  p({ method: 'post', path: '/me/grounds/{id}/courts', tags: ['grounds'], summary: 'Add a court (pending until approved); hours default to the whole bookable day', security: bearer,
    request: { ...grId, ...body(grS.createCourt) }, responses: { 201: json(grS.OwnerGround, 'Created'), ...errors({ ...OWNER, 409: ['GROUND_IN_REVIEW', 'GROUND_STATE', 'COURT_NAME_TAKEN'], 422: ['VALIDATION_FAILED', 'CATALOG_ITEM_UNKNOWN'] }) } });
  p({ method: 'patch', path: '/me/courts/{id}', tags: ['grounds'], summary: 'Edit a court; sports, surface, size and name of an active court need review (FR-04)', security: bearer,
    request: { ...grId, ...body(grS.updateCourt) }, responses: { 200: json(grS.OwnerGround), ...errors({ ...OWNER, 409: ['GROUND_IN_REVIEW', 'GROUND_STATE', 'COURT_NAME_TAKEN'], 422: ['VALIDATION_FAILED', 'CATALOG_ITEM_UNKNOWN'] }) } });
  p({ method: 'post', path: '/me/courts/{id}/retire', tags: ['grounds'], summary: 'Retire a court (no upcoming bookings; a live ground keeps one court) (FR-06)', security: bearer,
    request: grId, responses: { 200: json(grS.OwnerGround), ...errors({ ...OWNER, 409: ['GROUND_IN_REVIEW', 'COURT_HAS_BOOKINGS', 'LAST_COURT'] }) } });
  p({ method: 'put', path: '/me/courts/{id}/hours', tags: ['grounds'], summary: 'Set a court\'s weekly hours: 7 rows, half-hour aligned, inside the bookable day (FR-07, FR-08)', security: bearer,
    request: { ...grId, ...body(grS.hoursBody) }, responses: { 200: json(grS.OwnerGround), ...errors({ ...OWNER, 409: ['GROUND_STATE', 'HOURS_CONFLICT'], ...VALIDATION }) } });
  p({ method: 'post', path: '/me/grounds/{id}/photos', tags: ['grounds'], summary: 'Upload a photo (raw JPEG, PNG or WebP, checked by its first bytes) to the public bucket', security: bearer,
    request: { ...grId, body: photo('The photo itself, up to ground.photo_max_bytes') },
    responses: { 201: json(grS.Photo, 'Created'), ...errors({ ...OWNER, 409: ['GROUND_IN_REVIEW', 'GROUND_STATE', 'PHOTO_LIMIT'], 413: ['FILE_TOO_LARGE', 'PAYLOAD_TOO_LARGE'], 415: ['FILE_TYPE_NOT_ALLOWED', 'FILE_TYPE_MISMATCH'], 422: ['FILE_EMPTY'], 429: ['UPLOAD_RATE_LIMITED'] }) } });
  p({ method: 'put', path: '/me/grounds/{id}/photos/order', tags: ['grounds'], summary: 'Reorder the photos (first = cover)', security: bearer,
    request: { ...grId, ...body(grS.photoOrder) }, responses: { 200: json(z.object({ items: z.array(grS.Photo) })), ...errors({ ...OWNER, 409: ['GROUND_IN_REVIEW', 'GROUND_STATE'], 422: ['VALIDATION_FAILED', 'PHOTOS_MISMATCH'] }) } });
  p({ method: 'post', path: '/me/grounds/{id}/photos/{photoId}/remove', tags: ['grounds'], summary: 'Remove a photo (status; nothing is deleted)', security: bearer,
    request: { params: grS.photoParams }, responses: { 200: json(z.object({ removed: z.uuid() })), ...errors({ ...OWNER, 409: ['GROUND_IN_REVIEW', 'GROUND_STATE'], ...VALIDATION }) } });
  p({ method: 'get', path: '/me/grounds/{id}/pricing', tags: ['grounds'], summary: 'Published and draft pricing, limits, the v3 payment policy, upcoming bookings (FR-11)', security: bearer,
    request: grId, responses: { 200: json(grS.PricingView), ...errors(OWNER) } });
  p({ method: 'put', path: '/me/grounds/{id}/pricing/draft', tags: ['grounds'], summary: 'Save the pricing draft (validated on the server; base locked in review) (FR-09)', security: bearer,
    request: { ...grId, ...body(grS.pricingDraft) }, responses: { 200: json(grS.Rules), ...errors({ ...OWNER, 409: ['GROUND_IN_REVIEW'], 422: ['VALIDATION_FAILED', 'COURT_UNKNOWN'] }) } });
  p({ method: 'post', path: '/me/grounds/{id}/pricing/draft/discard', tags: ['grounds'], summary: 'Discard the pricing draft (FR-10)', security: bearer,
    request: grId, responses: { 200: json(z.object({ discarded: z.number().int() })), ...errors({ ...OWNER, 409: ['PRICING_DRAFT_MISSING'] }) } });
  p({ method: 'post', path: '/me/grounds/{id}/pricing/publish', tags: ['grounds'], summary: 'Publish the draft; optionally the same rules on all my grounds (FR-09, FR-12, FR-14)', security: bearer,
    request: { ...grId, ...body(grS.publishBody) }, responses: { 200: json(grS.PublishResult), ...errors({ ...OWNER, 409: ['PRICING_DRAFT_MISSING', 'GROUND_IN_REVIEW'], ...VALIDATION }) } });
  p({ method: 'get', path: '/me/grounds/{id}/pricing/history', tags: ['grounds'], summary: 'Every published version with its summary (FR-14)', security: bearer, request: grId, responses: { 200: json(grS.History), ...errors(OWNER) } });
  p({ method: 'get', path: '/me/grounds/{id}/pricing/heatmap', tags: ['grounds'], summary: 'Hourly rates for the next days (06–22), draft or published', security: bearer,
    request: { ...grId, query: grS.heatmapQuery }, responses: { 200: json(grS.Heatmap), ...errors({ ...OWNER, 409: ['PRICING_MISSING'], ...VALIDATION }) } });
  p({ method: 'post', path: '/me/grounds/{id}/pricing/quote', tags: ['grounds'], summary: 'Quote a slot with unsaved changes (FR-13)', security: bearer,
    request: { ...grId, ...body(grS.ownerQuote) }, responses: { 200: json(grS.Quote), ...errors({ ...OWNER, 409: ['PRICING_MISSING'], 422: ['VALIDATION_FAILED', 'COURT_UNKNOWN', 'NOT_COMBINABLE', 'LENGTH_INVALID', 'OUTSIDE_HOURS'] }) } });

  const STAFF = { ...ADMIN_AUTH, 404: ['NOT_FOUND'], 409: ['GROUND_STATE'], ...VALIDATION };
  p({ method: 'get', path: '/admin/grounds', tags: ['grounds'], summary: 'Grounds for staff (approve_listings or manage_users): status filter, name or slug search', security: adminBearer, request: { query: grS.staffListQuery }, responses: { 200: json(grS.StaffList), ...errors({ ...ADMIN_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/grounds/{id}', tags: ['grounds'], summary: 'A ground for reviewers: the working copy, the public version and pricing', security: adminBearer, request: grId, responses: { 200: json(grS.StaffGround), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/grounds/{id}/suspend', tags: ['grounds'], summary: 'Suspend a live or paused ground (manage_users)', security: adminBearer, request: { ...grId, ...body(grS.reasonBody) }, responses: { 200: json(grS.StaffResult), ...errors(STAFF) } });
  p({ method: 'post', path: '/admin/grounds/{id}/restore', tags: ['grounds'], summary: 'Restore a suspended ground (master)', security: adminBearer, request: { ...grId, ...body(grS.reasonBody) }, responses: { 200: json(grS.StaffResult), ...errors(STAFF) } });
  p({ method: 'post', path: '/admin/grounds/{id}/remove', tags: ['grounds'], summary: 'Remove a ground (master; status, never deleted)', security: adminBearer, request: { ...grId, ...body(grS.reasonBody) }, responses: { 200: json(grS.StaffResult), ...errors(STAFF) } });
  // ------------------------------------------------------------------ M09 step 2: closures and series
  const OWNER2 = { ...COMMON_AUTH, 403: ['ROLE_REQUIRED', 'KYC_REQUIRED', 'PHONE_REQUIRED', 'NOT_OWNER', 'REASON_NOT_ALLOWED'], 404: ['NOT_FOUND'] };
  const CLOSURE_422 = { 422: ['VALIDATION_FAILED', 'NOT_HALF_HOUR', 'CLOSURE_EMPTY', 'CLOSURE_IN_PAST', 'OUT_OF_RANGE', 'COURT_UNKNOWN'] };
  p({ method: 'post', path: '/me/grounds/{id}/closures/preview', tags: ['grounds'], summary: 'What a closure would clash with: bookings, holds, series weeks, closures (FR-16)', security: bearer,
    request: { ...grId, ...body(grS.closureBody) }, responses: { 200: json(grS.ClosurePreview), ...errors({ ...OWNER2, 409: ['GROUND_STATE'], ...CLOSURE_422 }) } });
  p({ method: 'post', path: '/me/grounds/{id}/closures', tags: ['grounds'], summary: 'Close courts for a half-hour aligned period, up to 90 days ahead; nothing partial on a clash (FR-15, FR-16, Q63)', security: bearer,
    request: { ...grId, ...body(grS.closureBody) }, responses: { 201: json(grS.Closure), ...errors({ ...OWNER2, 409: ['GROUND_STATE', 'CLOSURE_CLASHES'], ...CLOSURE_422 }) } });
  p({ method: 'get', path: '/me/grounds/{id}/closures', tags: ['grounds'], summary: 'Upcoming or past closures', security: bearer,
    request: { ...grId, query: grS.closureListQuery }, responses: { 200: json(grS.ClosureList), ...errors({ ...OWNER2, ...VALIDATION }) } });
  p({ method: 'post', path: '/me/closures/{id}/reopen', tags: ['grounds'], summary: 'Reopen an upcoming closure (FR-17)', security: bearer, request: grId, responses: { 200: json(grS.Closure), ...errors({ ...OWNER2, 409: ['CLOSURE_STATE'] }) } });
  p({ method: 'post', path: '/me/closures/{id}/end-now', tags: ['grounds'], summary: 'End an in-progress closure at the next half-hour (FR-17)', security: bearer, request: grId, responses: { 200: json(grS.Closure), ...errors({ ...OWNER2, 409: ['CLOSURE_STATE'] }) } });
  const SERIES_422 = { 422: ['VALIDATION_FAILED', 'SERIES_WEEKS_INVALID', 'SERIES_DAY_MISMATCH', 'LENGTH_INVALID', 'NOT_HALF_HOUR', 'OUT_OF_RANGE', 'COURT_UNKNOWN'] };
  p({ method: 'post', path: '/me/grounds/{id}/series/preview', tags: ['grounds'], summary: 'Weeks of a weekly series with their clashes and the price per session (FR-19, FR-20)', security: bearer,
    request: { ...grId, ...body(grS.seriesBody) }, responses: { 200: json(grS.SeriesPreview), ...errors({ ...OWNER2, 409: ['GROUND_NOT_BOOKABLE', 'PRICING_MISSING'], ...SERIES_422 }) } });
  p({ method: 'post', path: '/me/grounds/{id}/series', tags: ['grounds'], summary: 'Book a weekly series: every week becomes a booking paid at the venue (FR-19 to FR-21, Q64)', security: bearer,
    request: { ...grId, ...body(grS.seriesBody) }, responses: { 201: json(grS.Series), ...errors({ ...OWNER2, 409: ['GROUND_NOT_BOOKABLE', 'PRICING_MISSING', 'SERIES_CLASHES', 'SLOT_UNAVAILABLE'], ...SERIES_422 }) } });
  p({ method: 'get', path: '/me/grounds/{id}/series', tags: ['grounds'], summary: 'Series of a ground', security: bearer, request: grId, responses: { 200: json(grS.SeriesList), ...errors(OWNER2) } });
  p({ method: 'get', path: '/me/series/{id}', tags: ['grounds'], summary: 'A series with its sessions', security: bearer, request: grId, responses: { 200: json(grS.Series), ...errors(OWNER2) } });
  p({ method: 'post', path: '/me/series/{id}/weeks/{week}/skip', tags: ['grounds'], summary: 'Skip a future week; the court is free (FR-22)', security: bearer,
    request: { params: grS.weekParams }, responses: { 200: json(grS.Series), ...errors({ ...OWNER2, 409: ['SERIES_STATE', 'BOOKING_STATE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/me/series/{id}/weeks/{week}/restore', tags: ['grounds'], summary: 'Restore a skipped week if the court is still free (FR-22)', security: bearer,
    request: { params: grS.weekParams }, responses: { 200: json(grS.Series), ...errors({ ...OWNER2, 409: ['SERIES_STATE', 'BOOKING_STATE', 'SLOT_UNAVAILABLE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/me/series/{id}/end', tags: ['grounds'], summary: 'End a series: future weeks are cancelled, no penalty, no refund (paid at the venue) (FR-23)', security: bearer,
    request: { ...grId, ...body(grS.seriesEndBody) }, responses: { 200: json(grS.Series), ...errors({ ...OWNER2, 409: ['SERIES_STATE'], ...VALIDATION }) } });

  // ------------------------------------------------------------------ M10 bookings (v3 money)
  const bkId = { params: bkS.idParam };
  const MEMBER = { ...COMMON_AUTH, 404: ['NOT_FOUND'] };
  const BOWNER = { ...COMMON_AUTH, 403: ['ROLE_REQUIRED', 'KYC_REQUIRED', 'NOT_OWNER'], 404: ['NOT_FOUND'] };
  // Round B3: the venue desk (gate work_ground) also answers staff: PERMISSION_REQUIRED without the
  // permission, PHONE_REQUIRED without a verified phone, 404 for another business's ids.
  const BSTAFF = { ...BOWNER, 403: [...BOWNER[403], 'PERMISSION_REQUIRED', 'PHONE_REQUIRED', 'ROLE_SUSPENDED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_BANNED'] };
  p({ method: 'get', path: '/grounds/{id}/availability', tags: ['bookings'], summary: 'Half-hour grid per court for a Dhaka day: open, booked, yours, closed, past, with the hourly rate (FR-01 to FR-03)',
    request: { ...bkId, query: bkS.availabilityQuery }, responses: { 200: json(bkS.Availability), ...errors({ 404: ['NOT_FOUND'], 422: ['VALIDATION_FAILED', 'OUT_OF_RANGE'] }) } });
  p({ method: 'post', path: '/bookings/holds', tags: ['bookings'], summary: 'Hold a slot and start paying the advance or the full price (gate book_ground: a verified phone; FR-04 to FR-06)', security: bearer,
    request: { headers: idem, ...body(bkS.holdBody) },
    responses: {
      201: json(bkS.HoldResult),
      ...errors({ ...COMMON_AUTH, 403: ['PHONE_REQUIRED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_BANNED'], 404: ['NOT_FOUND'], 409: ['GROUND_NOT_BOOKABLE', 'SLOT_UNAVAILABLE', 'PRICING_MISSING', 'IDEMPOTENCY_IN_PROGRESS'],
        422: ['VALIDATION_FAILED', 'OWN_GROUND', 'COURT_UNKNOWN', 'NOT_COMBINABLE', 'NOT_HALF_HOUR', 'TOO_LATE', 'OUT_OF_RANGE', 'LENGTH_INVALID', 'OUTSIDE_HOURS', 'PAYMENT_CHOICE_UNAVAILABLE'], 429: ['HOLD_LIMIT', 'HOLD_RATE_LIMITED'] }),
    } });
  p({ method: 'post', path: '/bookings/{id}/pay', tags: ['bookings'], summary: 'The payment link of a booking on hold', security: bearer, request: bkId, responses: { 200: json(bkS.HoldResult), ...errors({ ...MEMBER, 409: ['BOOKING_STATE'] }) } });
  p({ method: 'post', path: '/bookings/{id}/release', tags: ['bookings'], summary: 'Let a held slot go before paying', security: bearer, request: bkId, responses: { 200: json(bkS.HoldResult), ...errors({ ...MEMBER, 409: ['BOOKING_STATE'] }) } });
  p({ method: 'get', path: '/me/bookings', tags: ['bookings'], summary: 'My bookings, upcoming or past', security: bearer, request: { query: bkS.myListQuery }, responses: { 200: json(bkS.MyBookings), ...errors({ ...COMMON_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/me/bookings/{id}', tags: ['bookings'], summary: 'A booking with its cancel terms', security: bearer, request: bkId, responses: { 200: json(bkS.MyBooking), ...errors(MEMBER) } });
  p({ method: 'post', path: '/me/bookings/{id}/cancel-preview', tags: ['bookings'], summary: 'What cancelling gives back (v3: the advance is retained; above-advance refunded, Q120)', security: bearer,
    request: bkId, responses: { 200: json(bkS.CancelTerms), ...errors({ ...MEMBER, 409: ['BOOKING_STATE'] }) } });
  p({ method: 'post', path: '/me/bookings/{id}/cancel', tags: ['bookings'], summary: 'Cancel before the start, confirming the refund shown (FR-10 to FR-12)', security: bearer,
    request: { ...bkId, ...body(bkS.cancelBody) }, responses: { 200: json(bkS.CancelResult), ...errors({ ...MEMBER, 409: ['BOOKING_STATE', 'ALREADY_STARTED', 'REFUND_CHANGED'], ...VALIDATION }) } });
  p({ method: 'get', path: '/me/ground-bookings', tags: ['bookings'], summary: 'The owner\'s day at a ground: courts, hours, bookings, closures (FR-35). Round B3: also the venue’s staff with the permission (bookings.view); staff never see the fee, released or retained amounts', security: bearer,
    request: { query: bkS.timelineQuery }, responses: { 200: json(bkS.Timeline), ...errors({ ...BSTAFF, ...VALIDATION }) } });
  p({ method: 'get', path: '/me/ground-bookings/search', tags: ['bookings'], summary: 'Search my bookings at any venue and date: code, phone last 4 digits, team or contact name (newest start first). Round B3: also the venue’s staff with the permission (bookings.view; without groundId, every venue where they hold it); staff never see the fee, released or retained amounts', security: bearer,
    request: { query: bkS.ownerSearchQuery }, responses: { 200: json(bkS.OwnerSearch), ...errors({ ...BSTAFF, ...VALIDATION }) } });
  p({ method: 'get', path: '/me/ground-bookings/{id}', tags: ['bookings'], summary: 'A booking at my ground. Round B3: also the venue’s staff with the permission (bookings.view); staff never see the fee, released or retained amounts', security: bearer, request: bkId, responses: { 200: json(bkS.OwnerDetail), ...errors(BSTAFF) } });
  p({ method: 'post', path: '/me/ground-bookings/{id}/check-in', tags: ['bookings'], summary: 'Check in from start − 30 min to the end; releases the online money minus the fee on the full value (FR-13, v3). Round B3: also the venue’s staff with the permission (bookings.check_in); staff never see the fee, released or retained amounts', security: bearer,
    request: bkId, responses: { 200: json(bkS.OwnerResult), ...errors({ ...BSTAFF, 409: ['BOOKING_STATE', 'NOT_CHECKIN_WINDOW'] }) } });
  p({ method: 'post', path: '/me/ground-bookings/{id}/no-show', tags: ['bookings'], summary: 'Mark a no-show once late, until auto-complete; the advance is retained (FR-15, Q68). Round B3: also the venue’s staff with the permission (bookings.no_show); staff never see the fee, released or retained amounts', security: bearer,
    request: bkId, responses: { 200: json(bkS.OwnerResult), ...errors({ ...BSTAFF, 409: ['BOOKING_STATE', 'NOT_LATE_YET', 'NO_SHOW_WINDOW_CLOSED'] }) } });
  p({ method: 'post', path: '/me/ground-bookings/{id}/extend', tags: ['bookings'], summary: 'Extend by 30 minutes, paid at the venue; the fee is owed (FR-16). Round B3: also the venue’s staff with the permission (bookings.extend); staff never see the fee, released or retained amounts', security: bearer,
    request: bkId, responses: { 200: json(bkS.OwnerResult), ...errors({ ...BSTAFF, 409: ['BOOKING_STATE', 'BOOKING_ENDED', 'NEXT_SLOT_TAKEN'], 422: ['OUTSIDE_HOURS'] }) } });
  p({ method: 'post', path: '/me/ground-bookings/{id}/collect-balance', tags: ['bookings'], summary: 'Record the balance paid at the venue (cash or bKash), the full amount due (FR-17). Round B3: also the venue’s staff with the permission (bookings.collect_balance); staff never see the fee, released or retained amounts', security: bearer,
    request: { ...bkId, ...body(bkS.balanceBody) }, responses: { 200: json(bkS.OwnerResult), ...errors({ ...BSTAFF, 409: ['BOOKING_STATE', 'NO_BALANCE_DUE'], 422: ['VALIDATION_FAILED', 'BALANCE_MISMATCH'] }) } });
  p({ method: 'post', path: '/me/ground-bookings/{id}/cancel', tags: ['bookings'], summary: 'Cancel as the owner before the start: 100% back to the member (FR-19, v3; weather not penalised, Q22). Round B3: also the venue’s staff with the permission (bookings.cancel, optional and off by default, Q170); staff never see the fee, released or retained amounts', security: bearer,
    request: { ...bkId, ...body(bkS.ownerCancelBody) }, responses: { 200: json(bkS.OwnerResult), ...errors({ ...BSTAFF, 409: ['BOOKING_STATE', 'ALREADY_STARTED'], ...VALIDATION }) } });
  p({ method: 'get', path: '/me/ground-bookings/{id}/move-targets', tags: ['bookings'], summary: 'Free courts at my grounds for the same time (M09 §6.4). Round B3: also the venue’s staff with the permission (bookings.move; staff see that venue’s courts only); staff never see the fee, released or retained amounts', security: bearer, request: bkId, responses: { 200: json(bkS.MoveTargets), ...errors(BSTAFF) } });
  p({ method: 'post', path: '/me/ground-bookings/{id}/move', tags: ['bookings'], summary: 'Move to another court, same time and price; a new ground lets the member cancel free (FR-20). Round B3: also the venue’s staff with the permission (bookings.move, optional; within that venue only); staff never see the fee, released or retained amounts', security: bearer,
    request: { ...bkId, ...body(bkS.moveBody) }, responses: { 200: json(bkS.OwnerResult), ...errors({ ...BSTAFF, 409: ['BOOKING_STATE', 'ALREADY_STARTED', 'SLOT_UNAVAILABLE'], 422: ['VALIDATION_FAILED', 'MOVE_TARGET_INVALID', 'OUTSIDE_HOURS'] }) } });
  p({ method: 'post', path: '/me/grounds/{id}/walk-ins', tags: ['bookings'], summary: 'Record a walk-in paid in full at the counter; checked in at once when starting soon (FR-18). Round B3: also the venue’s staff with the permission (bookings.walk_in); staff never see the fee, released or retained amounts', security: bearer,
    request: { ...grId, headers: idem, ...body(bkS.walkInBody) },
    responses: { 201: json(bkS.OwnerResult), ...errors({ ...BSTAFF, 409: ['GROUND_NOT_BOOKABLE', 'PRICING_MISSING', 'SLOT_UNAVAILABLE'], 422: ['VALIDATION_FAILED', 'NOT_HALF_HOUR', 'TOO_LATE', 'OUT_OF_RANGE', 'COURT_UNKNOWN', 'LENGTH_INVALID', 'OUTSIDE_HOURS', 'NOT_COMBINABLE'] }) } });
  p({ method: 'get', path: '/admin/bookings', tags: ['bookings'], summary: 'Bookings for staff (manage_users or view_payouts)', security: adminBearer, request: { query: bkS.staffListQuery }, responses: { 200: json(bkS.StaffList), ...errors({ ...ADMIN_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/bookings/{id}', tags: ['bookings'], summary: 'A booking with its ledger trail', security: adminBearer, request: bkId, responses: { 200: json(bkS.StaffDetail), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'] }) } });
  p({ method: 'post', path: '/admin/bookings/{id}/cancel', tags: ['bookings'], summary: 'Cancel for the platform with a full refund (master, step-up escrow.manage)', security: adminBearer,
    request: { ...bkId, headers: stepUpHeader, ...body(bkS.reasonBody) }, responses: { 200: json(bkS.OwnerResult), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'], 409: ['BOOKING_STATE'], ...VALIDATION }) } });
  // ------------------------------------------------------------------ M19 dashboards and analytics
  const csv = { description: 'CSV (UTF-8 with a byte-order mark; taka with two decimals; +06:00 times)', content: { 'text/csv': { schema: z.string() } } };
  p({ method: 'get', path: '/me/dashboard', tags: ['analytics'], summary: 'My dashboard by role (FR-01 to FR-07, §6.3): member (spent, bookings, where it went); ground owner (revenue, occupancy, bookings, repeat teams); shop owner (sales, orders, average order, repeat buyers, sales by category, best sellers; conversion comes later); gym owner (pass sales, passes by kind, admissions, unused share, busiest hours, sales by package); sports organiser with orgId (teams of places, entry fees from escrow, matches played, registrations over time, fees by event; members of the organisation only, anyone else 404)', security: bearer,
    request: { query: anS.dashboardQuery }, responses: { 200: json(z.union([anS.MemberDashboard, anS.OwnerDashboard, anS.ShopDashboard, anS.GymDashboard, anS.OrganiserDashboard])), ...errors({ ...COMMON_AUTH, 403: ['ROLE_REQUIRED'], 404: ['NOT_FOUND'], 422: ['VALIDATION_FAILED', 'PERIOD_INVALID'] }) } });
  p({ method: 'get', path: '/me/dashboard/actions', tags: ['analytics'], summary: 'Needs your action, from the owning modules (FR-11); role organiser: registrations waiting for approval (admins) and unpaid entry fees in your sports organisations; role business_staff (Round B3): check-ins and balances at your venues, orders to accept or ship and stock at your shops, by your permissions (nothing while your phone is not verified)', security: bearer,
    request: { query: anS.actionsQuery }, responses: { 200: json(anS.Actions), ...errors({ ...COMMON_AUTH, 403: ['ROLE_REQUIRED'], ...VALIDATION }) } });
  p({ method: 'get', path: '/me/dashboard/export', tags: ['analytics'], summary: 'CSV of my bookings, revenue by week or payments; shop orders and sales by product; gym passes and admissions (FR-22, FR-23; no buyer or holder data; at most analytics.export_sync_max_rows; audited; analytics.exports_per_hour)', security: bearer,
    request: { query: anS.exportQuery }, responses: { 200: csv, ...errors({ ...COMMON_AUTH, 403: ['ROLE_REQUIRED'], 404: ['DATASET_UNKNOWN'], 422: ['VALIDATION_FAILED', 'EXPORT_TOO_LARGE'], 429: ['EXPORT_LIMIT'] }) } });
  p({ method: 'get', path: '/kpis/{key}/definition', tags: ['analytics'], summary: 'What a dashboard tile counts, in English or Bangla', request: { params: anS.kpiParam, query: anS.kpiQuery }, responses: { 200: json(anS.KpiDefinition), ...errors({ 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/analytics/overview', tags: ['analytics'], summary: 'Platform overview: GTV with venue money, fee revenue, take rate, bookings, esports, members, review queue (master or view_analytics)', security: adminBearer,
    request: { query: anS.platformQuery }, responses: { 200: json(anS.PlatformOverview), ...errors({ ...ADMIN_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/analytics/export', tags: ['analytics'], summary: 'CSV of the platform day table (master or view_analytics)', security: adminBearer,
    request: { query: anS.platformExportQuery }, responses: { 200: csv, ...errors({ ...ADMIN_AUTH, 404: ['DATASET_UNKNOWN'], 422: ['VALIDATION_FAILED', 'EXPORT_TOO_LARGE'], 429: ['EXPORT_LIMIT'] }) } });
  p({ method: 'get', path: '/admin/analytics/actions', tags: ['analytics'], summary: 'Needs your action for staff (the review queue)', security: adminBearer, responses: { 200: json(anS.Actions), ...errors(ADMIN_AUTH) } });
  // ------------------------------------------------------------------ M17 disputes, reports and reviews
  const dCode = { params: trS.codeParam };
  const dEv = { params: trS.evidenceParam };
  const rvId = { params: trS.idParam };
  const file = { description: 'The file (inline, no-store, sandboxed)', content: { 'application/octet-stream': { schema: z.string() } } };
  const DPARTY = { ...COMMON_AUTH, 404: ['NOT_A_PARTY', 'NOT_FOUND'] };
  const DSTAFF = { ...ADMIN_AUTH, 404: ['NOT_FOUND'] };
  const DECIDE = {
    403: [...ADMIN_AUTH[403], 'CONFLICT_OF_INTEREST', 'CLAIM_REQUIRED', 'REFUND_PERMISSION_REQUIRED', 'ESCALATION_REQUIRED', 'STEP_UP_REQUIRED'],
    409: ['DISPUTE_STATE', 'DISPUTE_VERSION', 'DISPUTE_SOURCE_CHANGED', 'ESCROW_FROZEN'],
    422: ['VALIDATION_FAILED', 'OUTCOME_NOT_ALLOWED', 'REFUND_INVALID', 'CORRECTION_REQUIRED'],
  };
  p({ method: 'post', path: '/disputes', tags: ['disputes'], summary: 'Open a booking dispute as the member who paid (gate file_dispute: a verified phone); the escrow hold is frozen (FR-01 to FR-04)', security: bearer,
    request: { headers: idem, ...body(trS.openBody) }, responses: { 201: json(trS.PartyCase, 'Created'), ...errors({ ...COMMON_AUTH, 403: ['PHONE_REQUIRED', 'NOT_YOUR_BOOKING', 'ACCOUNT_SUSPENDED'], 409: ['DISPUTE_NOT_ELIGIBLE', 'DISPUTE_WINDOW_CLOSED', 'DISPUTE_ALREADY_OPEN', 'ESCROW_NOT_OPEN'], 429: ['DISPUTE_LIMIT'], ...VALIDATION }) } });
  p({ method: 'get', path: '/me/disputes', tags: ['disputes'], summary: 'My disputes, as the claimant or the respondent', security: bearer, request: { query: trS.mineQuery }, responses: { 200: json(trS.CaseList), ...errors({ ...COMMON_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/me/disputes/options', tags: ['disputes'], summary: 'What I can dispute on a booking now, and its latest case', security: bearer, request: { query: trS.optionsQuery }, responses: { 200: json(trS.Options), ...errors({ ...COMMON_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/me/disputes/{code}', tags: ['disputes'], summary: 'A case: the booking, both sides, the timeline and what I can do', security: bearer, request: dCode, responses: { 200: json(trS.PartyCase), ...errors(DPARTY) } });
  p({ method: 'post', path: '/me/disputes/{code}/statement', tags: ['disputes'], summary: 'Add a statement while the case is open (FR-05)', security: bearer,
    request: { ...dCode, ...body(trS.statementBody) }, responses: { 200: json(trS.PartyCase), ...errors({ ...DPARTY, 409: ['DISPUTE_STATE', 'EVIDENCE_LIMIT'], ...VALIDATION }) } });
  p({ method: 'post', path: '/me/disputes/{code}/evidence', tags: ['disputes'], summary: 'Upload a file (raw body: JPEG, PNG, WebP or PDF, typed by its bytes; private, audited) (FR-05)', security: bearer,
    request: { ...dCode, body: { content: { 'application/octet-stream': { schema: z.string() } } } }, responses: { 201: json(trS.EvidenceResult, 'Created'), ...errors({ ...DPARTY, 409: ['DISPUTE_STATE', 'EVIDENCE_LIMIT'], 413: ['FILE_TOO_LARGE'], 415: ['FILE_TYPE'], 429: ['UPLOAD_RATE_LIMITED'] }) } });
  p({ method: 'get', path: '/me/disputes/{code}/evidence/{eid}/file', tags: ['disputes'], summary: 'Read a file of the case (audited)', security: bearer, request: dEv, responses: { 200: file, ...errors(DPARTY) } });
  p({ method: 'post', path: '/me/disputes/{code}/respond', tags: ['disputes'], summary: "The respondent's side; the case goes to staff (FR-06)", security: bearer,
    request: { ...dCode, ...body(trS.statementBody) }, responses: { 200: json(trS.PartyCase), ...errors({ ...DPARTY, 409: ['DISPUTE_STATE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/me/disputes/{code}/withdraw', tags: ['disputes'], summary: 'Withdraw my case; the hold is unfrozen and the booking settles as usual (FR-07)', security: bearer,
    request: { ...dCode, ...body(trS.withdrawBody) }, responses: { 200: json(trS.PartyCase), ...errors({ ...DPARTY, 409: ['DISPUTE_STATE'], ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/disputes', tags: ['disputes'], summary: 'The dispute queue, escalated and most urgent first (resolve_reports for bookings, manage_esports for results)', security: adminBearer,
    request: { query: trS.adminListQuery }, responses: { 200: json(trS.StaffList), ...errors({ ...ADMIN_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/disputes/{code}', tags: ['disputes'], summary: 'A case with both sides, the policy line, the outcomes and what each would move', security: adminBearer, request: dCode, responses: { 200: json(trS.StaffCase), ...errors(DSTAFF) } });
  for (const [action, summary] of [['claim', 'Claim a case (one reviewer at a time; parties cannot)'], ['heartbeat', 'Keep my claim'], ['release', 'Let my claim go']]) {
    p({ method: 'post', path: `/admin/disputes/{code}/${action}`, tags: ['disputes'], summary, security: adminBearer, request: dCode,
      responses: { 200: json(action === 'claim' ? trS.StaffCase : z.object({}).loose()), ...errors({ ...DSTAFF, 403: [...ADMIN_AUTH[403], 'CONFLICT_OF_INTEREST', 'CLAIM_REQUIRED'], 409: ['DISPUTE_STATE', 'CLAIMED_BY_OTHER'] }) } });
  }
  p({ method: 'post', path: '/admin/disputes/{code}/notes', tags: ['disputes'], summary: 'A staff-only note', security: adminBearer, request: { ...dCode, ...body(trS.noteBody) }, responses: { 200: json(trS.StaffCase), ...errors({ ...DSTAFF, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/disputes/{code}/evidence/{eid}/file', tags: ['disputes'], summary: 'Read a file of the case (audited)', security: adminBearer, request: dEv, responses: { 200: file, ...errors(DSTAFF) } });
  p({ method: 'post', path: '/admin/disputes/{code}/evidence/{eid}/hide', tags: ['disputes'], summary: 'Hide an item from the parties, with a reason', security: adminBearer, request: { ...dEv, ...body(trS.hideBody) }, responses: { 200: json(trS.StaffCase), ...errors({ ...DSTAFF, ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/disputes/{code}/decide', tags: ['disputes'], summary: 'Decide a claimed case: refunds within refunds.staff_limit_poisha need refund_small; the money moves in the same transaction (FR-11, FR-13)', security: adminBearer,
    request: { ...dCode, headers: idem, ...body(trS.decideBody) }, responses: { 200: json(trS.StaffCase), ...errors({ ...DSTAFF, ...DECIDE }) } });
  p({ method: 'post', path: '/admin/disputes/{code}/escalate', tags: ['disputes'], summary: 'Escalate to the masters with a recommendation (FR-12)', security: adminBearer,
    request: { ...dCode, ...body(trS.escalateBody) }, responses: { 200: json(trS.StaffCase), ...errors({ ...DSTAFF, 403: [...ADMIN_AUTH[403], 'CONFLICT_OF_INTEREST'], 409: ['DISPUTE_STATE', 'DISPUTE_VERSION'], 422: ['VALIDATION_FAILED', 'OUTCOME_NOT_ALLOWED', 'REFUND_INVALID'] }) } });
  p({ method: 'post', path: '/admin/disputes/{code}/master-decide', tags: ['disputes'], summary: 'A master decides any amount (step-up refund.large)', security: adminBearer,
    request: { ...dCode, headers: stepUpHeader.extend(idem.shape), ...body(trS.decideBody) }, responses: { 200: json(trS.StaffCase), ...errors({ ...DSTAFF, ...DECIDE }) } });
  p({ method: 'post', path: '/admin/disputes/{code}/send-back', tags: ['disputes'], summary: 'A master sends an escalated case back to staff', security: adminBearer,
    request: { ...dCode, ...body(trS.sendBackBody) }, responses: { 200: json(trS.StaffCase), ...errors({ ...DSTAFF, 409: ['DISPUTE_STATE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/reports', tags: ['reports'], summary: 'Report a ground, booking, member, review or tournament (reports.per_day) (FR-15, FR-16)', security: bearer,
    request: body(trS.reportBody), responses: { 201: json(trS.ReportResult, 'Created'), ...errors({ ...COMMON_AUTH, 404: ['REPORT_SUBJECT_UNKNOWN'], 409: ['REPORT_DUPLICATE'], 422: ['VALIDATION_FAILED', 'REPORT_SELF'], 429: ['REPORT_RATE_LIMITED'] }) } });
  p({ method: 'get', path: '/me/reports', tags: ['reports'], summary: 'What I reported and how it ended', security: bearer, responses: { 200: json(trS.MyReports), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/admin/reports', tags: ['reports'], summary: 'Reported subjects, flagged first (resolve_reports) (FR-17)', security: adminBearer, request: { query: trS.reportListQuery }, responses: { 200: json(trS.ReportQueue), ...errors({ ...ADMIN_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/reports/subjects/{type}/{id}', tags: ['reports'], summary: 'Every report of a subject and the actions that apply', security: adminBearer, request: { params: trS.subjectParam }, responses: { 200: json(trS.ReportSubject), ...errors({ ...ADMIN_AUTH, ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/reports/resolve', tags: ['reports'], summary: 'Resolve every open report of a subject with one action (suspensions need manage_users) (FR-18)', security: adminBearer,
    request: body(trS.resolveBody), responses: { 200: json(trS.ReportAction), ...errors({ ...ADMIN_AUTH, 404: ['REPORT_SUBJECT_UNKNOWN'], 409: ['NOTHING_OPEN', 'USER_NOT_ACTIVE', 'GROUND_STATE'], 422: ['VALIDATION_FAILED', 'RESOLUTION_NOT_ALLOWED'] }) } });
  p({ method: 'post', path: '/admin/reports/escalate', tags: ['reports'], summary: "Escalate a subject's reports to the masters", security: adminBearer, request: body(trS.escalateReportBody), responses: { 200: json(trS.ReportAction), ...errors({ ...ADMIN_AUTH, 409: ['NOTHING_OPEN'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/reports/{code}/dismiss', tags: ['reports'], summary: 'Dismiss one report', security: adminBearer, request: { ...dCode, ...body(trS.dismissBody) }, responses: { 200: json(trS.ReportAction), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'], 409: ['NOTHING_OPEN'], ...VALIDATION }) } });
  p({ method: 'get', path: '/grounds/{id}/reviews', tags: ['reviews'], summary: 'Published reviews of a ground with the summary (the average from reviews.min_count_display reviews)', request: { ...rvId, query: trS.publicReviewsQuery }, responses: { 200: json(trS.PublicReviews), ...errors(VALIDATION) } });
  p({ method: 'get', path: '/reviews', tags: ['reviews'], summary: 'Published reviews of a venue, pro profile, shop or gym, with the owner reply and the summary (the average from reviews.min_count_display reviews) (FR-35)',
    request: { query: trS.subjectReviewsQuery }, responses: { 200: json(trS.PublicReviews), ...errors(VALIDATION) } });
  p({ method: 'post', path: '/reviews', tags: ['reviews'], summary: 'Rate what I paid for, once per source, within reviews.window_days: a played booking (the venue), a released hire job (the pro), a completed sub-order (the shop) or a used gym pass (the gym). Held while the source has an open dispute or when the text has contact details. One review per gym: a newer pass updates it (200) (FR-30 to FR-33). v1 body { bookingId, stars, text } still works', security: bearer,
    request: body(trS.reviewBody), responses: { 200: json(trS.ReviewResult, 'Updated: my gym review, from a newer pass'), 201: json(trS.ReviewResult, 'Created'), ...errors({ ...COMMON_AUTH, 403: ['NOT_YOUR_BOOKING', 'NOT_YOUR_JOB', 'NOT_YOUR_ORDER', 'NOT_YOUR_PASS'], 404: ['NOT_FOUND'], 409: ['NOT_PLAYED', 'JOB_NOT_RELEASED', 'ORDER_NOT_COMPLETED', 'PASS_NOT_REDEEMED', 'REVIEW_WINDOW_CLOSED', 'REVIEW_EXISTS', 'REVIEW_HIDDEN'], ...VALIDATION }) } });
  p({ method: 'patch', path: '/reviews/{id}', tags: ['reviews'], summary: 'Change my review within reviews.edit_days (FR-22)', security: bearer,
    request: { ...rvId, ...body(trS.reviewPatch) }, responses: { 200: json(trS.ReviewResult), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], 409: ['REVIEW_EDIT_CLOSED', 'REVIEW_HIDDEN'], ...VALIDATION }) } });
  p({ method: 'get', path: '/me/reviewable', tags: ['reviews'], summary: 'Waiting to review, newest first: played bookings, released hire jobs, completed sub-orders and used gym passes (one per gym until it is reviewed)', security: bearer, responses: { 200: json(trS.Reviewable), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/me/reviews', tags: ['reviews'], summary: 'My reviews; with role=owner (or a subjectType or subjectId) the published reviews of my venues, pro profiles, shops and gyms, to reply to. Round B3: venue staff with reviews.reply see that venue’s reviews (subjectType=ground&subjectId=), with a verified phone (403 PHONE_REQUIRED otherwise)', security: bearer,
    request: { query: trS.myReviewsQuery }, responses: { 200: json(trS.ReviewList), ...errors({ ...COMMON_AUTH, 403: ['PHONE_REQUIRED'], ...VALIDATION }) } });
  p({ method: 'post', path: '/me/reviews/{id}/reply', tags: ['reviews'], summary: 'Reply to (or edit my reply to) a published review of something I own; contact details are refused; the author is told about the first reply (FR-34). Round B3: also a venue’s staff with reviews.reply (optional, off by default, Q170); staff of another venue get 404', security: bearer,
    request: { ...rvId, ...body(trS.replyBody) }, responses: { 200: json(trS.ReviewResult), ...errors({ ...COMMON_AUTH, 403: ['NOT_OWNER', 'PERMISSION_REQUIRED', 'PHONE_REQUIRED'], 404: ['NOT_FOUND'], 409: ['REVIEW_STATE'], 422: ['VALIDATION_FAILED', 'REPLY_HAS_CONTACT'] }) } });
  p({ method: 'get', path: '/me/ground-reviews', tags: ['reviews'], summary: 'Reviews of my venues (gate list_ground; alias of GET /me/reviews?subjectType=ground)', security: bearer, request: { query: trS.ownerReviewsQuery }, responses: { 200: json(trS.ReviewList), ...errors({ ...COMMON_AUTH, 403: ['ROLE_REQUIRED', 'KYC_REQUIRED'], ...VALIDATION }) } });
  p({ method: 'post', path: '/me/ground-reviews/{id}/reply', tags: ['reviews'], summary: 'Reply to a review of my venue (alias of POST /me/reviews/{id}/reply) (FR-34)', security: bearer,
    request: { ...rvId, ...body(trS.replyBody) }, responses: { 200: json(trS.ReviewResult), ...errors({ ...COMMON_AUTH, 403: ['NOT_OWNER', 'ROLE_REQUIRED'], 404: ['NOT_FOUND'], 409: ['REVIEW_STATE'], 422: ['VALIDATION_FAILED', 'REPLY_HAS_CONTACT'] }) } });
  p({ method: 'get', path: '/admin/reviews', tags: ['reviews'], summary: 'Held, hidden or published reviews (resolve_reports)', security: adminBearer, request: { query: trS.adminReviewsQuery }, responses: { 200: json(trS.ReviewList), ...errors({ ...ADMIN_AUTH, ...VALIDATION }) } });
  for (const [action, summary, extra] of [['hide', 'Hide a review with a reason', body(trS.hideReviewBody)], ['restore', 'Restore a hidden review', {}], ['publish', 'Publish a held review', {}]]) {
    p({ method: 'post', path: `/admin/reviews/{id}/${action}`, tags: ['reviews'], summary, security: adminBearer, request: { ...rvId, ...extra }, responses: { 200: json(trS.ReviewResult), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'], 409: ['REVIEW_STATE'], ...VALIDATION }) } });
  }
  // ------------------------------------------------------------------ M18 risk and trust
  const rkUser = { params: rkS.userParam };
  const RK = { ...ADMIN_AUTH, 404: ['NOT_FOUND'] };
  p({ method: 'get', path: '/admin/risk/overview', tags: ['risk'], summary: 'Open flags by severity and the rules with their live thresholds (manage_users or master)', security: adminBearer, responses: { 200: json(rkS.Overview), ...errors(ADMIN_AUTH) } });
  p({ method: 'get', path: '/admin/risk/flags', tags: ['risk'], summary: 'Flags, critical first (FR-05)', security: adminBearer, request: { query: rkS.flagsQuery }, responses: { 200: json(rkS.FlagList), ...errors({ ...ADMIN_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/risk/accounts/{userId}', tags: ['risk'], summary: 'One account: flags, metrics, actions with undo, reliability, payout holds, document requests', security: adminBearer, request: rkUser, responses: { 200: json(rkS.Account), ...errors(RK) } });
  p({ method: 'post', path: '/admin/risk/accounts/{userId}/actions', tags: ['risk'], summary: 'Freeze payouts or ban (master; step-up risk.manage / user.ban), ask for documents, clear, suspend (staff up to risk.staff_suspend_max_days) (FR-06 to FR-11)', security: adminBearer,
    request: { ...rkUser, headers: stepUpHeader.partial(), ...body(rkS.actionBody) },
    responses: { 201: json(rkS.Action, 'Created'), ...errors({ ...RK, 403: [...ADMIN_AUTH[403], 'STEP_UP_REQUIRED', 'SELF_ACTION_FORBIDDEN'], 409: ['ALREADY_FROZEN', 'FLAG_STATE', 'USER_NOT_ACTIVE', 'USER_ALREADY_BANNED', 'DOCUMENT_ALREADY_REQUESTED'], 422: ['VALIDATION_FAILED', 'SUSPENSION_TOO_LONG', 'FLAG_REQUIRED'] }) } });
  p({ method: 'post', path: '/admin/risk/actions/{id}/undo', tags: ['risk'], summary: 'Undo an action with its compensating action: unfreeze, cancel the request, reopen, restore (FR-09)', security: adminBearer,
    request: { params: rkS.idParam, headers: stepUpHeader.partial(), ...body(rkS.undoBody) },
    responses: { 201: json(rkS.Action, 'Created'), ...errors({ ...RK, 403: [...ADMIN_AUTH[403], 'STEP_UP_REQUIRED'], 409: ['ACTION_NOT_REVERSIBLE', 'ACTION_ALREADY_REVERSED', 'FLAG_STATE', 'USER_ALREADY_ACTIVE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/risk/thresholds', tags: ['risk'], summary: 'Propose new risk or trust thresholds: an M03 change request (master, step-up settings.write; re-evaluation follows) (FR-02, FR-03)', security: adminBearer,
    request: { headers: stepUpHeader, ...body(rkS.thresholdsBody) }, responses: { 201: json(z.object({}).loose(), 'Created'), ...errors({ ...ADMIN_AUTH, 422: ['VALIDATION_FAILED', 'SETTING_UNCHANGED', 'SETTING_OUT_OF_RANGE'] }) } });
  p({ method: 'get', path: '/me/trust', tags: ['risk'], summary: 'My reliability scores and the counts behind them (FR-14)', security: bearer, responses: { 200: json(rkS.Scores), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/trust/{userId}', tags: ['risk'], summary: 'Reliability scores that are shown (enough bookings, trust.min_sample)', request: rkUser, responses: { 200: json(rkS.Scores), ...errors(VALIDATION) } });
  p({ method: 'get', path: '/me/document-requests', tags: ['kyc'], summary: 'Documents our team asked me for (M02, from the risk desk)', security: bearer, responses: { 200: json(rkS.DocumentRequests), ...errors(COMMON_AUTH) } });
  // ------------------------------------------------------------------ M12 market catalogue (step 1)
  const mkId = { params: mkS.idParam };
  const SHOP = { ...COMMON_AUTH, 403: ['ROLE_REQUIRED', 'ROLE_PENDING', 'KYC_REQUIRED', 'PHONE_REQUIRED', 'NOT_OWNER'], 404: ['NOT_FOUND'] };
  // Round B3: the stock and order desks (gate work_shop) also answer the shop's staff.
  const SHOP_DESK = { ...SHOP, 403: [...SHOP[403], 'PERMISSION_REQUIRED', 'ROLE_SUSPENDED'], 422: ['VALIDATION_FAILED', 'BUSINESS_REQUIRED'] };
  const PRODUCT_EDIT = { 409: ['PRODUCT_IN_REVIEW', 'PRODUCT_STATE', 'SHOP_REQUIRED'] };
  const mkPhoto = { description: 'The photo itself, up to market.photo_max_bytes', content: { 'image/jpeg': { schema: z.string() }, 'image/png': { schema: z.string() }, 'image/webp': { schema: z.string() } } };
  p({ method: 'get', path: '/market/items', tags: ['market'], summary: 'Live shop products: category, item types, price band, area, search; facet counts; sorts newest / price (FR-30 to FR-32)', request: { query: mkS.listQuery }, responses: { 200: json(mkS.ItemList), ...errors(VALIDATION) } });
  p({ method: 'get', path: '/market/categories', tags: ['market'], summary: 'The M03 item catalogue: categories, item types with price ranges and spec fields (ETag)', responses: { 200: json(mkS.Categories), 304: { description: 'Not modified' } } });
  p({ method: 'get', path: '/market/products/{slug}', tags: ['market'], summary: 'A product page: public version, variant picker with live stock, specs, supplement details, the shop (410 once removed)',
    request: { params: mkS.slugParam }, responses: { 200: json(mkS.ProductPage), ...errors({ 404: ['NOT_FOUND'], 410: ['PRODUCT_GONE'], ...VALIDATION }) } });
  p({ method: 'get', path: '/market/shops/{slug}', tags: ['market'], summary: 'A live shop and its products', request: { params: mkS.slugParam, query: mkS.shopPageQuery }, responses: { 200: json(mkS.ShopPage), ...errors({ 404: ['NOT_FOUND'], ...VALIDATION }) } });

  p({ method: 'get', path: '/me/saved', tags: ['market'], summary: 'My saved items with badges (price dropped, out of stock, unavailable) (FR-33)', security: bearer, responses: { 200: json(mkS.SavedList), ...errors(COMMON_AUTH) } });
  p({ method: 'put', path: '/me/saved/{itemType}/{id}', tags: ['market'], summary: 'Save an item (idempotent; at most market.saved_max; not your own, FR-34)', security: bearer,
    request: { params: mkS.savedParams }, responses: { 200: json(mkS.SavedResult), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], 409: ['OWN_ITEM', 'SAVED_LIMIT'], ...VALIDATION }) } });
  p({ method: 'delete', path: '/me/saved/{itemType}/{id}', tags: ['market'], summary: 'Unsave an item (the row is kept with removed_at)', security: bearer, request: { params: mkS.savedParams }, responses: { 200: json(mkS.SavedResult), ...errors({ ...COMMON_AUTH, ...VALIDATION }) } });

  p({ method: 'get', path: '/shop/profile', tags: ['market'], summary: 'My shop (shop owner; gate list_product)', security: bearer, responses: { 200: json(mkS.ShopOwner), ...errors(SHOP) } });
  p({ method: 'post', path: '/shop/profile', tags: ['market'], summary: 'Open my shop: a draft of a type from market.shop_types (FR-01; one per owner)', security: bearer,
    request: body(mkS.createShop), responses: { 201: json(mkS.ShopOwner, 'Created'), ...errors({ ...SHOP, 409: ['SHOP_EXISTS'], 422: ['VALIDATION_FAILED', 'SHOP_TYPE_UNKNOWN', 'AREA_UNKNOWN'] }) } });
  p({ method: 'patch', path: '/shop/profile', tags: ['market'], summary: 'Edit my shop; on a live shop the name, area and address start an edit, the rest apply at once', security: bearer,
    request: body(mkS.updateShop), responses: { 200: json(mkS.ShopOwner), ...errors({ ...SHOP, 409: ['SHOP_IN_REVIEW', 'SHOP_STATE', 'SHOP_REQUIRED'], 422: ['VALIDATION_FAILED', 'SHOP_TYPE_UNKNOWN', 'AREA_UNKNOWN'] }) } });
  for (const [action, summary] of [['submit', 'Send the shop (or an edit of it) for review (M05 kind shop)'], ['withdraw', 'Take the shop or its edit out of review'], ['pause', 'Hide the shop and its products'], ['resume', 'Show a paused shop again']]) {
    p({ method: 'post', path: `/shop/profile/${action}`, tags: ['market'], summary, security: bearer, responses: { 200: json(mkS.ShopOwner), ...errors({ ...SHOP, 409: ['SHOP_STATE', 'SHOP_IN_REVIEW', 'NOTHING_TO_REVIEW', 'SHOP_REQUIRED'] }) } });
  }
  p({ method: 'put', path: '/shop/stock-rules', tags: ['market'], summary: 'Low-stock alert, hide when out of stock, made-to-order days (FR-06, FR-14, FR-15; explicit save, audited)', security: bearer,
    request: body(mkS.stockRules), responses: { 200: json(mkS.ShopOwner), ...errors({ ...SHOP, 409: ['SHOP_REQUIRED'], 422: ['VALIDATION_FAILED', 'MTO_DAYS_INVALID'] }) } });
  p({ method: 'get', path: '/shop/products', tags: ['market'], summary: 'My products with status, cover and stock totals', security: bearer, request: { query: mkS.ownerListQuery }, responses: { 200: json(mkS.ProductOwnerList), ...errors({ ...SHOP, 409: ['SHOP_REQUIRED'] }) } });
  p({ method: 'post', path: '/shop/products', tags: ['market'], summary: 'Draft a product of an item type with its variants and opening stock (FR-02 to FR-06)', security: bearer,
    request: body(mkS.createProduct),
    responses: { 201: json(mkS.ProductOwner, 'Created'), ...errors({ ...SHOP, 409: ['SHOP_REQUIRED', 'SHOP_STATE', 'VARIANT_DUPLICATE', 'SKU_TAKEN', 'MTO_NO_STOCK'], 422: ['VALIDATION_FAILED', 'ITEM_TYPE_UNKNOWN', 'CATEGORY_NOT_FOR_SHOP', 'SPECS_INVALID', 'ATTRIBUTES_INVALID', 'AXES_MISMATCH', 'PRICE_OUT_OF_RANGE', 'EXPIRY_REQUIRED', 'MTO_DAYS_INVALID', 'QTY_LIMIT_INVALID'] }) } });
  p({ method: 'get', path: '/shop/products/{id}', tags: ['market'], summary: 'My product: the working copy with photos and variants', security: bearer, request: mkId, responses: { 200: json(mkS.ProductOwner), ...errors(SHOP) } });
  p({ method: 'patch', path: '/shop/products/{id}', tags: ['market'], summary: 'Edit my product; title, type, brand, specs, supplement details and price moves above market.product_reprice_moderation_pct need review (FR-02)', security: bearer,
    request: { ...mkId, ...body(mkS.updateProduct) },
    responses: { 200: json(mkS.ProductOwner), ...errors({ ...SHOP, 409: [...PRODUCT_EDIT[409], 'VARIANT_HAS_HELD'], 422: ['VALIDATION_FAILED', 'ITEM_TYPE_UNKNOWN', 'CATEGORY_NOT_FOR_SHOP', 'SPECS_INVALID', 'ATTRIBUTES_INVALID', 'PRICE_OUT_OF_RANGE', 'MTO_DAYS_INVALID', 'QTY_LIMIT_INVALID'] }) } });
  p({ method: 'post', path: '/shop/products/{id}/submit', tags: ['market'], summary: 'Send the product (or an edit of a live one) for review (M05 kind product; the shop must be live)', security: bearer,
    request: mkId, responses: { 200: json(mkS.ProductOwner), ...errors({ ...SHOP, 409: ['SHOP_NOT_LIVE', 'PRODUCT_STATE', 'PRODUCT_IN_REVIEW', 'NOTHING_TO_REVIEW'], 422: ['PRODUCT_INCOMPLETE', 'ITEM_TYPE_UNKNOWN', 'CATEGORY_NOT_FOR_SHOP'] }) } });
  p({ method: 'post', path: '/shop/products/{id}/withdraw', tags: ['market'], summary: 'Take the product or its edit out of review', security: bearer, request: mkId, responses: { 200: json(mkS.ProductOwner), ...errors({ ...SHOP, 409: ['PRODUCT_STATE'] }) } });
  p({ method: 'post', path: '/shop/products/{id}/pause', tags: ['market'], summary: 'Hide a live product', security: bearer, request: mkId, responses: { 200: json(mkS.ProductOwner), ...errors({ ...SHOP, 409: ['PRODUCT_STATE'] }) } });
  p({ method: 'post', path: '/shop/products/{id}/resume', tags: ['market'], summary: 'Show a paused product again', security: bearer, request: mkId, responses: { 200: json(mkS.ProductOwner), ...errors({ ...SHOP, 409: ['PRODUCT_STATE'] }) } });
  p({ method: 'post', path: '/shop/products/{id}/remove', tags: ['market'], summary: 'Remove a product (no units held for orders; nothing is deleted)', security: bearer, request: mkId, responses: { 200: json(mkS.StatusResult), ...errors({ ...SHOP, 409: ['PRODUCT_STATE', 'VARIANT_HAS_HELD'] }) } });
  p({ method: 'post', path: '/shop/products/{id}/variants', tags: ['market'], summary: 'Add a variant (a size or option) with its opening stock; public at once on a live product (FR-04)', security: bearer,
    request: { ...mkId, ...body(mkS.createVariant) }, responses: { 201: json(mkS.ProductOwner, 'Created'), ...errors({ ...SHOP, 409: [...PRODUCT_EDIT[409], 'VARIANT_DUPLICATE', 'SKU_TAKEN', 'MTO_NO_STOCK'], 422: ['VALIDATION_FAILED', 'ATTRIBUTES_INVALID', 'AXES_MISMATCH', 'PRICE_OUT_OF_RANGE', 'EXPIRY_REQUIRED'] }) } });
  p({ method: 'patch', path: '/shop/variants/{id}', tags: ['market'], summary: 'Edit a variant: SKU, price, expiry date and batch (supplements)', security: bearer,
    request: { ...mkId, ...body(mkS.updateVariant) }, responses: { 200: json(mkS.ProductOwner), ...errors({ ...SHOP, 409: [...PRODUCT_EDIT[409], 'VARIANT_STATE', 'SKU_TAKEN'], 422: ['VALIDATION_FAILED', 'PRICE_OUT_OF_RANGE', 'EXPIRY_REQUIRED'] }) } });
  p({ method: 'post', path: '/shop/variants/{id}/retire', tags: ['market'], summary: 'Retire a variant (none held for orders; a product keeps one)', security: bearer, request: mkId, responses: { 200: json(mkS.ProductOwner), ...errors({ ...SHOP, 409: [...PRODUCT_EDIT[409], 'VARIANT_STATE', 'VARIANT_HAS_HELD', 'LAST_VARIANT'] }) } });
  p({ method: 'post', path: '/shop/products/{id}/photos', tags: ['market'], summary: 'Upload a photo (raw JPEG, PNG or WebP, checked by its first bytes) to the public bucket', security: bearer,
    request: { ...mkId, body: mkPhoto },
    responses: { 201: json(mkS.Photo, 'Created'), ...errors({ ...SHOP, 409: ['PRODUCT_IN_REVIEW', 'PRODUCT_STATE', 'PHOTO_LIMIT'], 413: ['FILE_TOO_LARGE', 'PAYLOAD_TOO_LARGE'], 415: ['FILE_TYPE_NOT_ALLOWED', 'FILE_TYPE_MISMATCH'], 422: ['FILE_EMPTY'], 429: ['UPLOAD_RATE_LIMITED'] }) } });
  p({ method: 'put', path: '/shop/products/{id}/photos/order', tags: ['market'], summary: 'Reorder the photos (first = cover)', security: bearer,
    request: { ...mkId, ...body(mkS.photoOrder) }, responses: { 200: json(z.object({ items: z.array(mkS.Photo) })), ...errors({ ...SHOP, 409: ['PRODUCT_IN_REVIEW', 'PRODUCT_STATE'], 422: ['VALIDATION_FAILED', 'PHOTOS_MISMATCH'] }) } });
  p({ method: 'post', path: '/shop/products/{id}/photos/{photoId}/remove', tags: ['market'], summary: 'Remove a photo (status; nothing is deleted)', security: bearer,
    request: { params: mkS.photoParams }, responses: { 200: json(z.object({ removed: z.uuid() })), ...errors({ ...SHOP, 409: ['PRODUCT_IN_REVIEW', 'PRODUCT_STATE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/shop/variants/{id}/adjust', tags: ['market'], summary: 'Change the count on the shelf with a reason (received, count correction, damaged, lost, other) (FR-13). Round B3: also the shop’s staff with stock.adjust', security: bearer,
    request: { ...mkId, ...body(mkS.adjustBody) }, responses: { 200: json(mkS.StockResult), ...errors({ ...SHOP_DESK, 409: ['BELOW_HELD', 'MTO_NO_STOCK', 'VARIANT_STATE'], ...VALIDATION }) } });
  p({ method: 'get', path: '/shop/variants/{id}/movements', tags: ['market'], summary: 'The stock ledger of a variant, newest first (FR-11). Round B3: also the shop’s staff with stock.view', security: bearer, request: { ...mkId, query: mkS.cursorQuery }, responses: { 200: json(mkS.MovementList), ...errors(SHOP_DESK) } });
  p({ method: 'get', path: '/shop/inventory', tags: ['market'], summary: 'Inventory desk: stock value, out, low, held, blocked; every active variant (§4). Round B3: also the shop’s staff with stock.view (shopId names the shop; never the stock value)', security: bearer, request: { query: mkS.inventoryQuery }, responses: { 200: json(mkS.InventoryOverview), ...errors({ ...SHOP_DESK, 409: ['SHOP_REQUIRED'] }) } });

  const MK = { ...ADMIN_AUTH, 404: ['NOT_FOUND'] };
  p({ method: 'get', path: '/admin/market/shops', tags: ['market'], summary: 'Shops (approve_listings or manage_users)', security: adminBearer, request: { query: mkS.staffShopsQuery }, responses: { 200: json(mkS.StaffShopList), ...errors({ ...ADMIN_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/market/shops/{id}', tags: ['market'], summary: 'A shop: the working copy and the public version', security: adminBearer, request: mkId, responses: { 200: json(z.object({}).loose()), ...errors(MK) } });
  p({ method: 'get', path: '/admin/market/products', tags: ['market'], summary: 'Shop products (approve_listings or manage_users)', security: adminBearer, request: { query: mkS.staffProductsQuery }, responses: { 200: json(mkS.StaffProductList), ...errors({ ...ADMIN_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/market/products/{id}', tags: ['market'], summary: 'A product: the working copy and the public version', security: adminBearer, request: mkId, responses: { 200: json(z.object({}).loose()), ...errors(MK) } });
  for (const what of ['shops', 'products']) {
    p({ method: 'post', path: `/admin/market/${what}/{id}/suspend`, tags: ['market'], summary: `Suspend (manage_users): hidden from Market`, security: adminBearer, request: { ...mkId, ...body(mkS.reasonBody) }, responses: { 200: json(mkS.StatusResult), ...errors({ ...MK, 409: ['SHOP_STATE', 'PRODUCT_STATE'], ...VALIDATION }) } });
    p({ method: 'post', path: `/admin/market/${what}/{id}/restore`, tags: ['market'], summary: 'Restore a suspended one (masters)', security: adminBearer, request: { ...mkId, ...body(mkS.reasonBody) }, responses: { 200: json(mkS.StatusResult), ...errors({ ...MK, 409: ['SHOP_STATE', 'PRODUCT_STATE'], ...VALIDATION }) } });
    p({ method: 'post', path: `/admin/market/${what}/{id}/remove`, tags: ['market'], summary: 'Remove for good (masters; nothing is deleted)', security: adminBearer, request: { ...mkId, ...body(mkS.reasonBody) }, responses: { 200: json(mkS.StatusResult), ...errors({ ...MK, 409: ['SHOP_STATE', 'PRODUCT_STATE', 'VARIANT_HAS_HELD'], ...VALIDATION }) } });
  }

  // ------------------------------------------------------------------ M13 orders and fulfilment (step 1)
  const orId = { params: orS.idParam };
  const orCode = { params: orS.codeParam };
  const orVariant = { params: orS.variantParam };
  const BUY = { ...COMMON_AUTH, 403: ['PHONE_REQUIRED', 'ACCOUNT_SUSPENDED'] };
  const LINE = { 409: ['ITEM_UNAVAILABLE', 'INSUFFICIENT_STOCK'], 422: ['OWN_ITEM', 'QTY_LIMIT', 'VALIDATION_FAILED'] };
  const SUB = { ...COMMON_AUTH, 404: ['NOT_FOUND'], 409: ['ORDER_STATE'] };
  const SELLER = { ...SHOP, 403: [...SHOP[403], 'NOT_YOUR_SHOP'], 409: ['ORDER_STATE'] };
  const SELLER_DESK = { ...SELLER, 403: [...SELLER[403], 'PERMISSION_REQUIRED', 'ROLE_SUSPENDED'] };
  const proof = { description: 'Optional delivery photo (raw JPEG, PNG or WebP, up to market.photo_max_bytes); send an empty body for none', content: { 'image/jpeg': { schema: z.string() }, 'image/png': { schema: z.string() }, 'image/webp': { schema: z.string() } } };
  p({ method: 'get', path: '/me/cart', tags: ['orders'], summary: 'My cart grouped by shop, with live prices and stock (FR-01, FR-02)', security: bearer, responses: { 200: json(orS.Cart), ...errors(COMMON_AUTH) } });
  p({ method: 'delete', path: '/me/cart', tags: ['orders'], summary: 'Empty my cart', security: bearer, responses: { 200: json(orS.Cart), ...errors(COMMON_AUTH) } });
  p({ method: 'put', path: '/me/cart/items/{variantId}', tags: ['orders'], summary: 'Add an item or set its quantity (at most the stock and the per-order limit; not your own shop)', security: bearer,
    request: { ...orVariant, ...body(orS.cartQty) }, responses: { 200: json(orS.Cart), ...errors({ ...COMMON_AUTH, ...LINE }) } });
  p({ method: 'delete', path: '/me/cart/items/{variantId}', tags: ['orders'], summary: 'Remove an item (the line is kept with removed_at)', security: bearer, request: orVariant, responses: { 200: json(orS.Cart), ...errors(COMMON_AUTH) } });
  p({ method: 'post', path: '/checkout/quote', tags: ['orders'], summary: 'Price the cart on the server: a sub-order per shop, delivery by area (৳80 Dhaka metro, ৳150 outside), price changes (FR-03)', security: bearer,
    request: body(orS.quoteBody), responses: { 200: json(orS.Quote), ...errors({ ...BUY, ...LINE, 422: [...LINE[422], 'CART_EMPTY', 'AREA_UNKNOWN'] }) } });
  p({ method: 'post', path: '/checkout', tags: ['orders'], summary: 'Place the order (gate buy: a verified phone): stock held, one payment split into an escrow hold per shop; pay within market.checkout_hold_minutes (FR-04 to FR-07)', security: bearer,
    request: { headers: idem, ...body(orS.checkoutBody) }, responses: { 201: json(orS.OrderResult, 'Created'), ...errors({ ...BUY, 409: [...LINE[409], 'PRICE_CHANGED'], 422: [...LINE[422], 'CART_EMPTY', 'AREA_UNKNOWN'] }) } });
  p({ method: 'get', path: '/me/orders', tags: ['orders'], summary: 'My orders, newest first', security: bearer, request: { query: orS.myOrdersQuery }, responses: { 200: json(orS.OrderList), ...errors({ ...COMMON_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/me/orders/{code}', tags: ['orders'], summary: 'An order with its sub-orders, tracking and what I can do now', security: bearer, request: orCode, responses: { 200: json(orS.OrderResult), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'] }) } });
  p({ method: 'post', path: '/me/orders/{code}/pay', tags: ['orders'], summary: 'The payment link of an unpaid order', security: bearer, request: orCode, responses: { 200: json(orS.OrderResult), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], 409: ['ORDER_STATE'] }) } });
  p({ method: 'post', path: '/me/sub-orders/{id}/cancel', tags: ['orders'], summary: 'Cancel before the shop accepts, or once shipping is late by market.ship_overdue_buyer_cancel_hours (100% refund)', security: bearer,
    request: { ...orId, ...body(orS.cancelBody) }, responses: { 200: json(orS.OrderResult), ...errors({ ...SUB, 409: ['ORDER_STATE', 'CANCEL_NOT_YET'] }) } });
  p({ method: 'post', path: '/me/sub-orders/{id}/received', tags: ['orders'], summary: 'I have the parcel: the sub-order completes and the shop is paid (minus the commission on the items)', security: bearer, request: orId, responses: { 200: json(orS.OrderResult), ...errors(SUB) } });
  p({ method: 'post', path: '/me/sub-orders/{id}/not-received', tags: ['orders'], summary: 'Open an M17 dispute (not_received): the hold freezes until staff decide (gate file_dispute)', security: bearer,
    request: { ...orId, headers: idem, ...body(orS.notReceivedBody) }, responses: { 201: json(z.object({}).loose(), 'Created'), ...errors({ ...COMMON_AUTH, 403: ['PHONE_REQUIRED', 'NOT_YOUR_ORDER'], 404: ['NOT_FOUND'], 409: ['DISPUTE_NOT_ELIGIBLE', 'DISPUTE_WINDOW_CLOSED', 'DISPUTE_ALREADY_OPEN'], 429: ['DISPUTE_LIMIT'], ...VALIDATION }) } });
  p({ method: 'get', path: '/shop/sub-orders', tags: ['orders'], summary: 'My shop orders by tab (to accept, to ship, shipped, done, cancelled) with counts. Round B3: also the shop’s staff (orders.view; shopId names the shop; never the buyer’s contact in lists); staff never see the commission, net or released amounts', security: bearer, request: { query: orS.shopListQuery }, responses: { 200: json(orS.ShopSubList), ...errors({ ...SHOP_DESK, ...VALIDATION }) } });
  p({ method: 'get', path: '/shop/sub-orders/{id}', tags: ['orders'], summary: 'A shop order; the buyer’s phone and address show once accepted (FR-10). Round B3: also the shop’s staff (orders.view; the buyer’s contact only with orders.ship, each view audited (Q168)); staff never see the commission, net or released amounts', security: bearer, request: orId, responses: { 200: json(orS.ShopSub), ...errors(SELLER_DESK) } });
  p({ method: 'post', path: '/shop/sub-orders/{id}/accept', tags: ['orders'], summary: 'Accept within market.shop_accept_hours (FR-08). Round B3: also the shop’s staff (orders.accept); staff never see the commission, net or released amounts', security: bearer, request: orId, responses: { 200: json(orS.ShopSub), ...errors(SELLER_DESK) } });
  p({ method: 'post', path: '/shop/sub-orders/{id}/reject', tags: ['orders'], summary: 'Reject the whole sub-order with a reason (Q82): 100% refund, stock released. Round B3: also the shop’s staff (orders.reject, optional and off by default); staff never see the commission, net or released amounts', security: bearer, request: { ...orId, ...body(orS.rejectBody) }, responses: { 200: json(orS.ShopSub), ...errors({ ...SELLER_DESK, ...VALIDATION }) } });
  p({ method: 'post', path: '/shop/sub-orders/{id}/ship', tags: ['orders'], summary: 'Ship with the courier and tracking number; the held stock is committed. Round B3: also the shop’s staff (orders.ship); staff never see the commission, net or released amounts', security: bearer, request: { ...orId, ...body(orS.shipBody) }, responses: { 200: json(orS.ShopSub), ...errors({ ...SELLER_DESK, 422: ['TRACKING_INVALID', 'VALIDATION_FAILED'] }) } });
  p({ method: 'post', path: '/shop/sub-orders/{id}/delivered', tags: ['orders'], summary: 'Mark delivered (optional photo proof, private storage); auto-completes after market.auto_complete_days. Round B3: also the shop’s staff (orders.deliver); staff never see the commission, net or released amounts', security: bearer,
    request: { ...orId, body: proof }, responses: { 200: json(orS.ShopSub), ...errors({ ...SELLER_DESK, 413: ['FILE_TOO_LARGE', 'PAYLOAD_TOO_LARGE'], 415: ['FILE_TYPE_NOT_ALLOWED', 'FILE_TYPE_MISMATCH'], 429: ['UPLOAD_RATE_LIMITED'] }) } });
  p({ method: 'get', path: '/shop/settlement', tags: ['orders'], summary: 'Completed (released to my payable), in escrow and refunded totals (the owner only; never for staff, Round B3)', security: bearer, responses: { 200: json(orS.Settlement), ...errors(SHOP) } });
  p({ method: 'get', path: '/admin/orders', tags: ['orders'], summary: 'Orders by code or status (manage_users, refund_small or view_payouts)', security: adminBearer, request: { query: orS.adminListQuery }, responses: { 200: json(orS.StaffOrderList), ...errors({ ...ADMIN_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/orders/{code}', tags: ['orders'], summary: 'An order: each sub-order’s timeline and escrow hold (no phone or address)', security: adminBearer, request: { params: z.object({ code: z.string() }) }, responses: { 200: json(orS.StaffOrder), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'] }) } });
  p({ method: 'post', path: '/admin/orders/sub-orders/{id}/cancel', tags: ['orders'], summary: 'Cancel a sub-order not yet shipped for the platform with a full refund (master, step-up escrow.manage)', security: adminBearer,
    request: { ...orId, headers: stepUpHeader, ...body(orS.reasonBody) }, responses: { 200: json(orS.StaffOrder), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'], 409: ['ORDER_STATE'], ...VALIDATION }) } });

  // ------------------------------------------------------------------ M11 hire (step 1)
  const hiId = { params: hiS.idParam };
  const HIRER = { ...COMMON_AUTH, 404: ['NOT_FOUND', 'NOT_A_PARTY'], 409: ['REQUEST_STATE', 'JOB_STATE'] };
  const PRO = { ...COMMON_AUTH, 403: ['NOT_YOUR_PROFILE', 'ROLE_REQUIRED', 'MEMBER_NOT_ACTIVE'], 404: ['NOT_FOUND', 'NOT_A_PARTY'], 409: ['PROFILE_STATE', 'REQUEST_STATE', 'JOB_STATE'] };
  p({ method: 'get', path: '/hire/taxonomy', tags: ['hire'], summary: 'M03 hire taxonomy: 6 categories and their roles (units, match formats, credential tiers)', responses: { 200: json(hiS.Taxonomy) } });
  p({ method: 'get', path: '/hire/profiles', tags: ['hire'], summary: 'The directory: live profiles by category, role, experience, unit, sport, area and search; sorted by rating, rate (normalised hourly, FR-03), jobs or experience', request: { query: hiS.listQuery }, responses: { 200: json(hiS.ProfileList), ...errors(VALIDATION) } });
  p({ method: 'get', path: '/hire/profiles/{slug}', tags: ['hire'], summary: 'A profile page: rates, the verified credential level, a 14-day busy strip (times only)', request: { params: hiS.slugParam }, responses: { 200: json(hiS.ProfilePage), ...errors({ 404: ['NOT_FOUND'] }) } });
  p({ method: 'post', path: '/hire/profiles/{id}/quote', tags: ['hire'], summary: 'A non-binding quote per engagement (§6.3: base, night, short notice, travel zone, rounded to ৳50)', request: { ...hiId, ...body(hiS.quoteBody) }, responses: { 200: json(hiS.Quote), ...errors({ 409: ['PROFILE_NOT_AVAILABLE'], 422: ['UNIT_NOT_OFFERED', 'AREA_UNKNOWN', 'VALIDATION_FAILED'] }) } });
  p({ method: 'post', path: '/hire/requests', tags: ['hire'], summary: 'Send a hire request (gate hire: a verified phone); the server quotes and snapshots each engagement (FR-20, FR-21)', security: bearer,
    request: { headers: idem, ...body(hiS.requestBody) }, responses: { 201: json(hiS.RequestResult, 'Created'), ...errors({ ...COMMON_AUTH, 403: ['PHONE_REQUIRED'], 409: ['PROFILE_NOT_AVAILABLE', 'DUPLICATE_REQUEST', 'PRO_UNAVAILABLE'], 422: ['OWN_PROFILE', 'UNIT_NOT_OFFERED', 'AREA_UNKNOWN', 'VALIDATION_FAILED'] }) } });
  p({ method: 'get', path: '/hire/profiles/{id}/availability', tags: ['hire'], summary: 'Busy spans of a profile (blocked time and jobs merged; no reasons, no job details), from today up to hire.availability_horizon_days (FR-05)', request: { ...hiId, query: hiS.rangeQuery }, responses: { 200: json(hiS.PublicAvailability), ...errors({ 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'get', path: '/me/shortlist', tags: ['hire'], summary: 'My shortlist', security: bearer, responses: { 200: json(hiS.ProfileList), ...errors(COMMON_AUTH) } });
  p({ method: 'put', path: '/me/shortlist/{profileId}', tags: ['hire'], summary: 'Shortlist a profile (at most hire.shortlist_max)', security: bearer, request: { params: hiS.profileParam }, responses: { 200: json(z.object({ shortlisted: z.boolean() })), ...errors({ ...COMMON_AUTH, 409: ['SHORTLIST_LIMIT'] }) } });
  p({ method: 'delete', path: '/me/shortlist/{profileId}', tags: ['hire'], summary: 'Remove from my shortlist', security: bearer, request: { params: hiS.profileParam }, responses: { 200: json(z.object({ shortlisted: z.boolean() })), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/me/hire-requests', tags: ['hire'], summary: 'My hire requests as the manager', security: bearer, request: { query: hiS.statusQuery }, responses: { 200: json(hiS.RequestList), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/me/hire-requests/{id}', tags: ['hire'], summary: 'A request (by id or code) as either party; the other party’s phone shows once paid', security: bearer, request: { params: z.object({ id: z.string() }) }, responses: { 200: json(hiS.RequestResult), ...errors(HIRER) } });
  p({ method: 'post', path: '/me/hire-requests/{id}/withdraw', tags: ['hire'], summary: 'Withdraw while pending or unpaid (free)', security: bearer, request: hiId, responses: { 200: json(hiS.RequestResult), ...errors(HIRER) } });
  p({ method: 'post', path: '/me/hire-requests/{id}/pay', tags: ['hire'], summary: 'The payment link of an accepted, unpaid request', security: bearer, request: hiId, responses: { 200: json(hiS.RequestResult), ...errors(HIRER) } });
  p({ method: 'get', path: '/me/hire-requests/{id}/messages', tags: ['hire'], summary: 'The request’s thread (both parties)', security: bearer, request: hiId, responses: { 200: json(hiS.Messages), ...errors(HIRER) } });
  p({ method: 'post', path: '/me/hire-requests/{id}/messages', tags: ['hire'], summary: 'Post a message; contact details are refused until paid (v3)', security: bearer, request: { ...hiId, ...body(hiS.messageBody) }, responses: { 201: json(hiS.Message, 'Created'), ...errors({ ...HIRER, 422: ['CONTACT_NOT_ALLOWED', 'VALIDATION_FAILED'], 429: ['MESSAGES_RATE_LIMITED'] }) } });
  p({ method: 'get', path: '/me/hire-jobs/{id}', tags: ['hire'], summary: 'A job with what the viewer can do now', security: bearer, request: hiId, responses: { 200: json(hiS.Job), ...errors(HIRER) } });
  p({ method: 'get', path: '/me/hire-jobs/{id}/cancel-preview', tags: ['hire'], summary: 'The cancellation fee now (§6.6: free over 72 h, 25% to 24 h, 50% under)', security: bearer, request: hiId, responses: { 200: json(hiS.CancelPlan), ...errors(HIRER) } });
  p({ method: 'post', path: '/me/hire-jobs/{id}/cancel', tags: ['hire'], summary: 'Cancel a scheduled job: the fee goes to the pro (minus the platform’s share), the rest is refunded', security: bearer, request: hiId, responses: { 200: json(hiS.CancelResult), ...errors(HIRER) } });
  p({ method: 'post', path: '/me/hire-jobs/{id}/confirm', tags: ['hire'], summary: 'Confirm the work: the job’s hold is released to the pro minus fees.hire_pct', security: bearer, request: hiId, responses: { 200: json(hiS.Job), ...errors(HIRER) } });
  for (const [path, what] of [['no-show', 'a no-show (from hire.no_show_after_min after the start, no check-in)'], ['problem', 'a problem with the work (once marked complete)']]) {
    p({ method: 'post', path: `/me/hire-jobs/{id}/${path}`, tags: ['hire'], summary: `Report ${what}: an M17 dispute; the hold freezes (gate file_dispute)`, security: bearer,
      request: { ...hiId, headers: idem, ...body(hiS.disputeBody) }, responses: { 201: json(z.object({}).loose(), 'Created'), ...errors({ ...HIRER, 403: ['PHONE_REQUIRED', 'NOT_YOUR_JOB'], 409: ['DISPUTE_NOT_ELIGIBLE', 'DISPUTE_WINDOW_CLOSED', 'DISPUTE_ALREADY_OPEN'] }) } });
  }
  p({ method: 'get', path: '/pro/profiles', tags: ['hire'], summary: 'My hire profiles with rate cards and their limits', security: bearer, responses: { 200: json(z.object({ items: z.array(hiS.OwnerProfile) })), ...errors(COMMON_AUTH) } });
  p({ method: 'post', path: '/pro/profiles', tags: ['hire'], summary: 'A draft profile for one hire role (player or pro role applied; NID verified)', security: bearer, request: body(hiS.profileBody), responses: { 201: json(hiS.OwnerProfile, 'Created'), ...errors({ ...PRO, 409: ['PROFILE_EXISTS'], 422: ['AREA_UNKNOWN', 'VALIDATION_FAILED'] }) } });
  p({ method: 'get', path: '/pro/profiles/{id}', tags: ['hire'], summary: 'My profile', security: bearer, request: hiId, responses: { 200: json(hiS.OwnerProfile), ...errors(PRO) } });
  p({ method: 'patch', path: '/pro/profiles/{id}', tags: ['hire'], summary: 'Edit the working copy (an edit of a live profile waits for review)', security: bearer, request: { ...hiId, ...body(hiS.profilePatch) }, responses: { 200: json(hiS.OwnerProfile), ...errors({ ...PRO, 409: ['PROFILE_IN_REVIEW', 'PROFILE_STATE'] }) } });
  p({ method: 'put', path: '/pro/profiles/{id}/rate-card', tags: ['hire'], summary: 'Save a new rate card version, within the role’s limits (Q74)', security: bearer, request: { ...hiId, ...body(hiS.rateCardBody) }, responses: { 200: json(hiS.OwnerProfile), ...errors({ ...PRO, ...VALIDATION }) } });
  p({ method: 'post', path: '/pro/profiles/{id}/submit', tags: ['hire'], summary: 'Send for review (M05 kind hire_profile)', security: bearer, request: hiId, responses: { 200: json(hiS.OwnerProfile), ...errors({ ...PRO, 409: ['PROFILE_IN_REVIEW', 'PROFILE_STATE', 'RATE_CARD_REQUIRED', 'NOTHING_TO_REVIEW'] }) } });
  for (const action of ['pause', 'resume']) p({ method: 'post', path: `/pro/profiles/{id}/${action}`, tags: ['hire'], summary: `${action === 'pause' ? 'Stop' : 'Start'} taking requests`, security: bearer, request: hiId, responses: { 200: json(hiS.OwnerProfile), ...errors(PRO) } });
  p({ method: 'get', path: '/pro/requests', tags: ['hire'], summary: 'Requests to my profiles; pending ones carry the automatic checks (§6.5)', security: bearer, request: { query: hiS.statusQuery }, responses: { 200: json(hiS.RequestList), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/pro/requests/{id}', tags: ['hire'], summary: 'A request to me', security: bearer, request: hiId, responses: { 200: json(hiS.RequestResult), ...errors(PRO) } });
  p({ method: 'post', path: '/pro/requests/{id}/accept', tags: ['hire'], summary: 'Accept: checks re-run, the jobs reserved, the manager asked to pay (FR-22, FR-25)', security: bearer, request: hiId, responses: { 200: json(hiS.RequestResult), ...errors({ ...PRO, 409: ['REQUEST_STATE', 'REPLY_WINDOW_CLOSED', 'SCHEDULE_CLASH'], 422: ['CHECKS_FAILED'] }) } });
  p({ method: 'post', path: '/pro/requests/{id}/decline', tags: ['hire'], summary: 'Decline with a reason (FR-24)', security: bearer, request: { ...hiId, ...body(hiS.declineBody) }, responses: { 200: json(hiS.RequestResult), ...errors({ ...PRO, ...VALIDATION }) } });
  p({ method: 'get', path: '/pro/jobs', tags: ['hire'], summary: 'My jobs', security: bearer, request: { query: hiS.jobsQuery }, responses: { 200: json(hiS.JobList), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/pro/jobs/{id}', tags: ['hire'], summary: 'A job of mine', security: bearer, request: hiId, responses: { 200: json(hiS.Job), ...errors(PRO) } });
  p({ method: 'post', path: '/pro/jobs/{id}/check-in', tags: ['hire'], summary: 'Check in (from hire.checkin_open_before_min before the start; late after hire.late_before_start_min)', security: bearer, request: hiId, responses: { 200: json(hiS.Job), ...errors({ ...PRO, 409: ['JOB_STATE', 'TOO_EARLY', 'JOB_ENDED'] }) } });
  p({ method: 'post', path: '/pro/jobs/{id}/start', tags: ['hire'], summary: 'Start (toss) from hire.toss_open_before_min before', security: bearer, request: hiId, responses: { 200: json(hiS.Job), ...errors({ ...PRO, 409: ['JOB_STATE', 'TOO_EARLY'] }) } });
  p({ method: 'post', path: '/pro/jobs/{id}/complete', tags: ['hire'], summary: 'Mark the work complete; released when the manager confirms or after hire.auto_release_hours', security: bearer, request: { ...hiId, ...body(hiS.completeBody) }, responses: { 200: json(hiS.Job), ...errors(PRO) } });
  p({ method: 'post', path: '/pro/jobs/{id}/withdraw', tags: ['hire'], summary: 'Withdraw from a scheduled job: the manager gets 100% back', security: bearer, request: { ...hiId, ...body(hiS.withdrawBody) }, responses: { 200: json(hiS.Job), ...errors(PRO) } });
  p({ method: 'get', path: '/admin/hire/requests', tags: ['hire'], summary: 'Hire requests by code or status (manage_users, approve_listings, refund_small or view_payouts)', security: adminBearer, request: { query: hiS.adminListQuery }, responses: { 200: json(hiS.StaffRequestList), ...errors({ ...ADMIN_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/hire/requests/{code}', tags: ['hire'], summary: 'A request with each job’s escrow hold (no phone numbers)', security: adminBearer, request: { params: z.object({ code: z.string() }) }, responses: { 200: json(hiS.StaffRequest), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'] }) } });
  p({ method: 'get', path: '/admin/hire/profiles', tags: ['hire'], summary: 'Hire profiles', security: adminBearer, request: { query: hiS.adminProfilesQuery }, responses: { 200: json(hiS.StaffProfileList), ...errors(ADMIN_AUTH) } });
  p({ method: 'get', path: '/admin/hire/profiles/{id}', tags: ['hire'], summary: 'A profile with its working copy, rate card, owner, credential and base area (the Moderation desk panel)', security: adminBearer, request: hiId, responses: { 200: json(hiS.StaffProfile), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'] }) } });
  p({ method: 'post', path: '/admin/hire/profiles/{id}/suspend', tags: ['hire'], summary: 'Suspend a profile (manage_users)', security: adminBearer, request: { ...hiId, ...body(hiS.reasonBody) }, responses: { 200: json(hiS.StaffAction), ...errors({ ...ADMIN_AUTH, 409: ['PROFILE_STATE'] }) } });
  p({ method: 'post', path: '/admin/hire/profiles/{id}/restore', tags: ['hire'], summary: 'Restore a suspended profile (masters)', security: adminBearer, request: { ...hiId, ...body(hiS.reasonBody) }, responses: { 200: json(hiS.StaffAction), ...errors({ ...ADMIN_AUTH, 409: ['PROFILE_STATE'] }) } });
  // Round B1: insights and the availability calendar.
  p({ method: 'get', path: '/pro/insights', tags: ['hire'], summary: 'Earnings and performance (M19 §6.3 Pro): earned per Dhaka week or month from the ledger (net), releasing soon, jobs, acceptance, reply time, rating, who hires you', security: bearer, request: { query: hiS.insightsQuery }, responses: { 200: json(hiS.Insights), ...errors({ ...COMMON_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/pro/availability', tags: ['hire'], summary: 'My availability calendar: blocks, weekly repeats, the blocked spans in the range (repeats expanded) and booked jobs (locked)', security: bearer, request: { query: hiS.rangeQuery }, responses: { 200: json(hiS.Availability), ...errors({ ...COMMON_AUTH, ...VALIDATION }) } });
  p({ method: 'put', path: '/pro/availability/blocks', tags: ['hire'], summary: 'Replace the one-off blocks starting in [from, to) (and every weekly repeat when repeats is sent); up to hire.availability_horizon_days ahead, never over a booked job; audited, not moderated (FR-14)', security: bearer,
    request: body(hiS.blocksBody), responses: { 200: json(hiS.Availability), ...errors({ ...COMMON_AUTH, 409: ['BLOCK_OVER_JOB'], ...VALIDATION }) } });
  p({ method: 'post', path: '/admin/hire/jobs/{id}/cancel', tags: ['hire'], summary: 'Cancel a job for the platform with a full refund (master, step-up escrow.manage)', security: adminBearer, request: { ...hiId, headers: stepUpHeader, ...body(hiS.reasonBody) }, responses: { 200: json(hiS.Job), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'], 409: ['JOB_STATE'] }) } });

  // ------------------------------------------------------------------ M20 gym (step 1)
  const gyId = { params: gyS.idParam };
  const gyPhoto = (description) => ({ description, content: { 'image/jpeg': { schema: z.string() }, 'image/png': { schema: z.string() }, 'image/webp': { schema: z.string() } } });
  const GYM_OWNER = { ...COMMON_AUTH, 403: ['NOT_OWNER', 'ROLE_REQUIRED', 'ROLE_PENDING', 'KYC_REQUIRED', 'PHONE_REQUIRED', 'ROLE_SUSPENDED'], 404: ['NOT_FOUND'], 409: ['GYM_IN_REVIEW', 'GYM_STATE'] };
  // Round B3: the front desk (gate work_gym) also answers the gym's staff.
  const GYM_DESK = { ...GYM_OWNER, 403: [...GYM_OWNER[403], 'PERMISSION_REQUIRED', 'PHONE_REQUIRED', 'ROLE_SUSPENDED'] };
  const GYM_MEMBER = { ...COMMON_AUTH, 404: ['NOT_FOUND'] };
  p({ method: 'get', path: '/gym/gyms', tags: ['gym'], summary: 'Live gyms by area, facility and name; sorted by the day pass price, rating or newest', request: { query: gyS.listQuery }, responses: { 200: json(gyS.GymList), ...errors(VALIDATION) } });
  p({ method: 'get', path: '/gym/gyms/{slug}', tags: ['gym'], summary: 'A gym page: photos, address, weekly hours (women-only windows), facilities, packages, open now (ETag)', request: { params: gyS.slugParam }, responses: { 200: json(gyS.GymPage), 304: { description: 'Not modified' }, ...errors({ 404: ['NOT_FOUND'] }) } });
  p({ method: 'get', path: '/gym/trainers', tags: ['gym'], summary: 'Fitness trainers (M11 profiles in role fitness_trainer) with their monthly plans', request: { query: gyS.trainersQuery }, responses: { 200: json(gyS.TrainerList) } });
  p({ method: 'get', path: '/gym/trainers/{id}/plans', tags: ['gym'], summary: 'The active monthly plans of a trainer profile', request: gyId, responses: { 200: json(gyS.PlanOffer) } });
  p({ method: 'post', path: '/gym/passes', tags: ['gym'], summary: 'Buy a package for a date (gate buy_gym_pass: a verified phone); one payment into escrow (FR-03)', security: bearer,
    request: { headers: idem, ...body(gyS.buyBody) }, responses: { 201: json(gyS.PassResult, 'Created'), ...errors({ ...COMMON_AUTH, 403: ['PHONE_REQUIRED'], 409: ['GYM_NOT_AVAILABLE', 'PASS_CAPACITY_FULL'], 422: ['PACKAGE_UNKNOWN', 'DATE_OUT_OF_RANGE', 'GYM_CLOSED_ON_DATE', 'VALIDATION_FAILED'] }) } });
  p({ method: 'get', path: '/me/passes', tags: ['gym'], summary: 'My passes (active, used, expired)', security: bearer, request: { query: gyS.passesQuery }, responses: { 200: json(gyS.PassList), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/me/passes/{code}', tags: ['gym'], summary: 'One pass with its QR token and backup code while it can be used (no-store)', security: bearer, request: { params: gyS.codeParam }, responses: { 200: json(gyS.PassResult), ...errors(GYM_MEMBER) } });
  p({ method: 'post', path: '/me/passes/{id}/cancel', tags: ['gym'], summary: 'Cancel: a day pass before its date, a month or quarter pass before its first use, in full (FR-06)', security: bearer, request: gyId, responses: { 200: json(gyS.PassResult), ...errors({ ...GYM_MEMBER, 409: ['PASS_NOT_ACTIVE', 'PASS_NOT_REFUNDABLE'] }) } });
  p({ method: 'post', path: '/gym/subscriptions', tags: ['gym'], summary: 'Subscribe to a trainer’s monthly plan (gate subscribe_trainer); the first month into escrow', security: bearer,
    request: { headers: idem, ...body(gyS.subscribeBody) }, responses: { 201: json(gyS.Subscription, 'Created'), ...errors({ ...COMMON_AUTH, 403: ['PHONE_REQUIRED'], 409: ['PLAN_NOT_AVAILABLE', 'ALREADY_SUBSCRIBED'], 422: ['OWN_PLAN', 'DATE_OUT_OF_RANGE', 'VALIDATION_FAILED'] }) } });
  p({ method: 'get', path: '/me/subscriptions', tags: ['gym'], summary: 'My trainer subscriptions', security: bearer, responses: { 200: json(gyS.SubscriptionList), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/me/subscriptions/{id}', tags: ['gym'], summary: 'A subscription (by id or code) as the member or the trainer', security: bearer, request: { params: gyS.idOrCodeParam }, responses: { 200: json(gyS.Subscription), ...errors(GYM_MEMBER) } });
  p({ method: 'post', path: '/me/subscriptions/{id}/renew', tags: ['gym'], summary: 'The pay link of the next month (from gym.subscription_renew_notice_days before the end until the grace days end)', security: bearer, request: gyId, responses: { 200: json(gyS.Subscription), ...errors({ ...GYM_MEMBER, 409: ['RENEWAL_NOT_OPEN', 'SUBSCRIPTION_STATE'] }) } });
  p({ method: 'post', path: '/me/subscriptions/{id}/cancel', tags: ['gym'], summary: 'Cancel: unpaid → void; the first gym.subscription_cancel_days of a paid month → full refund; later → no renewal', security: bearer, request: gyId, responses: { 200: json(gyS.Subscription), ...errors({ ...GYM_MEMBER, 409: ['SUBSCRIPTION_STATE'] }) } });
  p({ method: 'post', path: '/me/subscriptions/{id}/problem', tags: ['gym'], summary: 'Report a problem with the current month: an M17 case (service_problem); the month’s money waits', security: bearer,
    request: { ...gyId, headers: idem, ...body(gyS.problemBody) }, responses: { 201: json(z.object({}).loose(), 'Created'), ...errors({ ...GYM_MEMBER, 409: ['SUBSCRIPTION_STATE', 'DISPUTE_WINDOW_CLOSED', 'DISPUTE_ALREADY_OPEN'] }) } });
  p({ method: 'get', path: '/me/gyms', tags: ['gym'], summary: 'My gyms (gate run_gym: a verified phone, M24-FR-01)', security: bearer, responses: { 200: json(gyS.OwnerGymList), ...errors(GYM_OWNER) } });
  p({ method: 'post', path: '/me/gyms', tags: ['gym'], summary: 'A draft (private) gym (FR-01; gate run_gym: a verified phone, no documents, M24-FR-01); creates the owner’s gym plan (free) with the first gym', security: bearer, request: body(gyS.createGym), responses: { 201: json(gyS.OwnerGym, 'Created'), ...errors({ ...GYM_OWNER, 422: ['AREA_UNKNOWN', 'CATALOG_ITEM_UNKNOWN', 'VALIDATION_FAILED'] }) } });
  p({ method: 'get', path: '/me/gyms/{id}', tags: ['gym'], summary: 'My gym (the working copy)', security: bearer, request: gyId, responses: { 200: json(gyS.OwnerGym), ...errors(GYM_OWNER) } });
  p({ method: 'patch', path: '/me/gyms/{id}', tags: ['gym'], summary: 'Edit the working copy (an edit of a live gym waits for review)', security: bearer, request: { ...gyId, ...body(gyS.updateGym) }, responses: { 200: json(gyS.OwnerGym), ...errors({ ...GYM_OWNER, ...VALIDATION }) } });
  p({ method: 'put', path: '/me/gyms/{id}/hours', tags: ['gym'], summary: 'The week of opening windows (some women-only)', security: bearer, request: { ...gyId, ...body(gyS.hoursBody) }, responses: { 200: json(gyS.OwnerGym), ...errors({ ...GYM_OWNER, ...VALIDATION }) } });
  p({ method: 'put', path: '/me/gyms/{id}/packages', tags: ['gym'], summary: 'Every active package (M24-FR-24): day, month, quarter, 6 months, 12 months (one each) and custom days (at most gym_manage.max_custom_packages); admission fee, channel desk/online/both, visit limit, order. A day pass sold online (within gym.day_pass_min/max_poisha) is needed only to submit', security: bearer, request: { ...gyId, ...body(gyS.packagesBody) }, responses: { 200: json(gyS.OwnerGym), ...errors({ ...GYM_OWNER, ...VALIDATION }) } });
  p({ method: 'post', path: '/me/gyms/{id}/photos', tags: ['gym'], summary: 'Upload a photo (raw JPEG, PNG or WebP, checked by its first bytes) to the public bucket', security: bearer,
    request: { ...gyId, body: gyPhoto('The photo itself, up to ground.photo_max_bytes') }, responses: { 201: json(z.object({ id: z.uuid(), url: z.string() }), 'Created'), ...errors({ ...GYM_OWNER, 409: ['GYM_IN_REVIEW', 'GYM_STATE', 'PHOTO_LIMIT'], 413: ['FILE_TOO_LARGE'], 415: ['FILE_TYPE_NOT_ALLOWED', 'FILE_TYPE_MISMATCH'], 422: ['FILE_EMPTY'], 429: ['UPLOAD_RATE_LIMITED'] }) } });
  p({ method: 'put', path: '/me/gyms/{id}/photos/order', tags: ['gym'], summary: 'Every active photo id, first = cover', security: bearer, request: { ...gyId, ...body(gyS.photoOrder) }, responses: { 200: json(gyS.OwnerGym), ...errors({ ...GYM_OWNER, 422: ['PHOTOS_MISMATCH'] }) } });
  p({ method: 'post', path: '/me/gyms/{id}/photos/{photoId}/remove', tags: ['gym'], summary: 'Remove a photo (status only; the object stays)', security: bearer, request: { params: gyS.photoParams }, responses: { 200: json(gyS.OwnerGym), ...errors(GYM_OWNER) } });
  p({ method: 'post', path: '/me/gyms/{id}/submit', tags: ['gym'], summary: 'Send for review (M05 kind gym)', security: bearer, request: gyId, responses: { 200: json(gyS.OwnerGym), ...errors({ ...GYM_OWNER, 409: ['GYM_IN_REVIEW', 'GYM_STATE', 'NOTHING_TO_REVIEW'], 422: ['GYM_INCOMPLETE'] }) } });
  for (const action of ['pause', 'resume']) p({ method: 'post', path: `/me/gyms/{id}/${action}`, tags: ['gym'], summary: `${action === 'pause' ? 'Stop' : 'Start'} selling passes`, security: bearer, request: gyId, responses: { 200: json(gyS.OwnerGym), ...errors(GYM_OWNER) } });
  p({ method: 'post', path: '/me/gyms/{id}/redemptions', tags: ['gym'], summary: 'The front desk: admit a pass by its QR token or 6-character code (FR-05). Round B3: also the gym’s staff with desk.admit (never the amount released)', security: bearer,
    request: { ...gyId, ...body(gyS.redeemBody) }, responses: { 201: json(gyS.Admission, 'Created'), ...errors({ ...GYM_DESK, 409: ['PASS_WRONG_GYM', 'PASS_NOT_ACTIVE', 'PASS_NOT_VALID_TODAY', 'PASS_ALREADY_REDEEMED', 'GYM_CLOSED_NOW'], 422: ['INVALID_PASS_TOKEN', 'VALIDATION_FAILED'] }) } });
  p({ method: 'get', path: '/me/gyms/{id}/redemptions', tags: ['gym'], summary: 'The day’s admissions (default today, Dhaka). Round B3: also the gym’s staff with desk.admissions', security: bearer, request: { ...gyId, query: gyS.admissionsQuery }, responses: { 200: json(gyS.AdmissionList), ...errors(GYM_DESK) } });
  p({ method: 'get', path: '/me/gyms/{id}/passes', tags: ['gym'], summary: 'Passes sold (the buyer’s name only). Round B3: also the gym’s staff with passes.view (optional), without any money', security: bearer, request: { ...gyId, query: gyS.soldQuery }, responses: { 200: json(gyS.SoldList), ...errors(GYM_DESK) } });
  p({ method: 'get', path: '/pro/trainer-plans', tags: ['gym'], summary: 'My monthly plans and my fitness trainer profiles', security: bearer, responses: { 200: json(gyS.MyPlans), ...errors(COMMON_AUTH) } });
  p({ method: 'post', path: '/pro/trainer-plans', tags: ['gym'], summary: 'A monthly plan (a live fitness trainer profile; price within gym.trainer_plan_min/max_poisha)', security: bearer, request: body(gyS.planBody), responses: { 201: json(gyS.Plan, 'Created'), ...errors({ ...COMMON_AUTH, 403: ['NOT_A_FITNESS_TRAINER'], ...VALIDATION }) } });
  p({ method: 'patch', path: '/pro/trainer-plans/{id}', tags: ['gym'], summary: 'Edit a plan (a new price applies to new members only)', security: bearer, request: { ...gyId, ...body(gyS.planPatch) }, responses: { 200: json(gyS.Plan), ...errors({ ...GYM_MEMBER, 409: ['PLAN_NOT_AVAILABLE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/pro/trainer-plans/{id}/retire', tags: ['gym'], summary: 'Retire a plan: no new members or renewals', security: bearer, request: gyId, responses: { 200: json(gyS.Plan), ...errors(GYM_MEMBER) } });
  p({ method: 'get', path: '/pro/subscriptions', tags: ['gym'], summary: 'My subscribers', security: bearer, responses: { 200: json(gyS.SubscriptionList), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/admin/gym/gyms', tags: ['gym'], summary: 'Gyms (manage_users, approve_listings, refund_small or view_payouts)', security: adminBearer, request: { query: gyS.adminGymsQuery }, responses: { 200: json(gyS.OwnerGymList), ...errors(ADMIN_AUTH) } });
  p({ method: 'get', path: '/admin/gym/gyms/{id}', tags: ['gym'], summary: 'One gym with its working copy (the Moderation desk panel)', security: adminBearer, request: gyId, responses: { 200: json(gyS.OwnerGym), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'] }) } });
  p({ method: 'post', path: '/admin/gym/gyms/{id}/suspend', tags: ['gym'], summary: 'Suspend a gym (manage_users)', security: adminBearer, request: { ...gyId, ...body(gyS.reasonBody) }, responses: { 200: json(gyS.StaffAction), ...errors({ ...ADMIN_AUTH, 409: ['GYM_STATE'] }) } });
  p({ method: 'post', path: '/admin/gym/gyms/{id}/restore', tags: ['gym'], summary: 'Restore a suspended gym (masters)', security: adminBearer, request: { ...gyId, ...body(gyS.reasonBody) }, responses: { 200: json(gyS.StaffAction), ...errors({ ...ADMIN_AUTH, 409: ['GYM_STATE'] }) } });
  p({ method: 'get', path: '/admin/gym/passes/{code}', tags: ['gym'], summary: 'A pass with its escrow hold', security: adminBearer, request: { params: gyS.codeParam }, responses: { 200: json(gyS.StaffPass), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'] }) } });
  p({ method: 'post', path: '/admin/gym/passes/{code}/cancel', tags: ['gym'], summary: 'Cancel an active pass for the platform with a refund of what is held (master, step-up escrow.manage)', security: adminBearer,
    request: { params: gyS.codeParam, headers: stepUpHeader, ...body(gyS.reasonBody) }, responses: { 200: json(gyS.StaffPass), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'], 409: ['PASS_NOT_ACTIVE'], ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/gym/subscriptions/{code}', tags: ['gym'], summary: 'A trainer subscription and each month with its escrow hold', security: adminBearer, request: { params: gyS.codeParam }, responses: { 200: json(gyS.StaffSubscription), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'] }) } });

  // ------------------------------------------------------------------ M24 gym management, prompt 1 (Desk MVP)
  // Every /manage/gyms/{gymId} route: gate work_gym, then business-members actFor for that gym (404 for
  // anyone unrelated; staff without the permission 403 PERMISSION_REQUIRED naming it; owner-only routes
  // name owner.only). Keys marked "fees.collect only" are absent for staff who may not collect fees.
  const gmG = { params: gmS.gymParam };
  const gmM = { params: gmS.memberParam };
  const gmMs = { params: gmS.membershipParam };
  const gmD = { params: gmS.dueParam };
  const gmF = { params: gmS.feePaymentParam };
  const gmI = { params: gmS.importParam };
  const gmMe = { params: gmS.meMemberParam };
  const gmImage = (description) => ({ description, content: { 'image/jpeg': { schema: z.string() }, 'image/png': { schema: z.string() }, 'image/webp': { schema: z.string() } } });
  const gmFile = (description) => ({ description, content: { 'text/csv': { schema: z.string() }, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { schema: z.string() } } });
  const GM = { ...COMMON_AUTH, 403: ['PERMISSION_REQUIRED', 'PHONE_REQUIRED', 'ROLE_SUSPENDED', 'ACCOUNT_SUSPENDED'], 404: ['NOT_FOUND'], ...VALIDATION };
  const GMW = { ...GM, 403: [...GM[403], 'GYM_ACCOUNT_RESTRICTED'] };
  const GMS = { ...GMW, 409: ['GYM_SETUP_REQUIRED'] };
  const gmTag = ['gym-manage'];
  const gp = (method, path, summary, extra) => p({ method, path: `/manage/gyms/{gymId}${path}`, tags: gmTag, summary, security: bearer, ...extra });
  p({ method: 'get', path: '/manage/gyms', tags: gmTag, summary: 'My gyms (owner) and the gyms I work at (staff), with the plan, features and restriction state (gate work_gym)', security: bearer, responses: { 200: json(gmS.ManageGyms), ...errors(COMMON_AUTH) } });
  gp('get', '/overview', 'Dashboard tiles: check-ins today, members, new this month, expiring this week, not seen, requests, dues today; money tiles only for the owner and reports.view (M24-FR-70)', { request: gmG, responses: { 200: json(gmS.Overview), ...errors(GM) } });
  gp('get', '/packages', 'Active packages sold at the desk (channel desk or both), for adding members and memberships (members.view, M24-FR-25)', { request: gmG, responses: { 200: json(gmS.Packages), ...errors(GM) } });
  gp('get', '/settings', 'The gym’s management settings (owner)', { request: gmG, responses: { 200: json(gmS.Settings), ...errors(GM) } });
  gp('patch', '/settings', 'Change the settings (owner). The first call must carry the short code (2–6 capital letters, unique among the owner’s gyms) and creates the settings (M24-FR-09)', {
    request: { ...gmG, ...body(gmS.settingsPatch) },
    responses: { 200: json(gmS.Settings), ...errors({ ...GMW, 409: ['GYM_SETUP_REQUIRED', 'GYM_SHORT_CODE_TAKEN'] }) },
  });
  gp('get', '/desk/search', 'Desk search (attendance.mark): members by name, phone, member code or member QR token (cards without amounts unless fees.collect); an M20 pass by its token or backup code (desk.admit)', { request: { ...gmG, query: gmS.deskSearchQuery }, responses: { 200: json(gmS.DeskSearch), ...errors(GM) } });
  gp('post', '/checkins', 'Check a member in by id or member QR token (attendance.mark, plan feature attendance; works while restricted). 201 counted; 200 a repeat the same day (counted false). Policy block: 409 GYM_ENTRY_BLOCKED; the owner overrides with { override, reason } (M24-FR-47 to FR-50)', {
    request: { ...gmG, ...body(gmS.checkinBody) },
    responses: { 201: json(gmS.DeskCard, 'Counted'), 200: json(gmS.DeskCard, 'A repeat the same Dhaka day'), ...errors({ ...GM, 403: [...GM[403], 'GYM_TIER_REQUIRED'], 409: ['GYM_ENTRY_BLOCKED', 'GYM_MEMBER_STATE'], 422: ['VALIDATION_FAILED', 'GYM_CHECKIN_TOKEN_INVALID'] }) },
  });
  gp('get', '/checkins', 'Check-ins of a Dhaka day (attendance.mark; default today)', { request: { ...gmG, query: gmS.dayQuery }, responses: { 200: json(gmS.CheckinDay), ...errors(GM) } });
  gp('get', '/members', 'Members with filters and search, cursor pages (members.view; a trainer-only caller sees their assigned members) (M24-FR-23)', { request: { ...gmG, query: gmS.membersQuery }, responses: { 200: json(gmS.MemberList), ...errors(GM) } });
  gp('post', '/members', 'Add a member (members.edit), optionally with a membership and the first payment (fees.collect), in one transaction; the member code comes from the settings row lock (M24-FR-10)', {
    request: { ...gmG, headers: idem, ...body(gmS.memberBody) },
    responses: { 201: json(gmS.AddMemberResult, 'Created'), ...errors({ ...GMS, 409: ['GYM_SETUP_REQUIRED', 'GYM_MEMBER_PHONE_TAKEN', 'GYM_MEMBERSHIP_OVERLAP'], 422: ['VALIDATION_FAILED', 'GYM_PACKAGE_UNAVAILABLE', 'GYM_DATE_OUT_OF_RANGE', 'GYM_PAYMENT_EXCEEDS_DUE'], 400: ['IDEMPOTENCY_KEY_REQUIRED'] }) },
  });
  gp('get', '/members/{memberId}', 'A member’s profile: what the gym typed, the link state, memberships with freezes, dues (amounts with fees.collect), what the caller can do', { request: gmM, responses: { 200: json(gmS.MemberProfile), ...errors(GM) } });
  gp('patch', '/members/{memberId}', 'Edit a member (members.edit) with the version (optimistic locking); encrypted fields audit as "changed" (M24-FR-13)', { request: { ...gmM, ...body(gmS.memberPatch) }, responses: { 200: json(gmS.MemberProfile), ...errors({ ...GMW, 409: ['VERSION_CONFLICT', 'GYM_MEMBER_PHONE_TAKEN', 'GYM_MEMBER_STATE'] }) } });
  gp('post', '/members/{memberId}/reveal-phone', 'The full phone (members.edit): no-store, audited, at most gym_manage.phone_reveals_per_hour per staff member (M24-FR-12)', { request: gmM, responses: { 200: json(gmS.RevealedPhone), ...errors({ ...GM, ...RATE }) } });
  gp('post', '/members/{memberId}/invite', 'Invite the member to link a Kriraghor account (members.edit): by their phone (default), another phone or a username; one pending invite per member (M24-FR-14)', {
    request: { ...gmM, ...body(gmS.inviteBody) },
    responses: { 201: json(gmS.RequestResult, 'Created'), ...errors({ ...GMW, 409: ['GYM_LINK_REQUEST_PENDING', 'GYM_ALREADY_LINKED'] }) },
  });
  gp('post', '/members/{memberId}/unlink', 'Clear the account link (members.edit); the record stays (M24-FR-18)', { request: gmM, responses: { 200: json(gmS.UnlinkResult), ...errors({ ...GM, 409: ['GYM_MEMBER_STATE'] }) } });
  gp('post', '/members/{memberId}/leave', 'Mark the member left with a reason and date (members.edit): running and upcoming memberships end, unpaid dues stay (M24-FR-19)', { request: { ...gmM, ...body(gmS.leaveBody) }, responses: { 200: json(gmS.MemberProfile), ...errors({ ...GMW, 409: ['GYM_MEMBER_STATE'], 422: ['VALIDATION_FAILED', 'GYM_DATE_OUT_OF_RANGE'] }) } });
  gp('post', '/members/{memberId}/rejoin', 'Re-join a member who left (members.edit): back to new with the same code', { request: gmM, responses: { 200: json(gmS.MemberProfile), ...errors({ ...GMW, 409: ['GYM_MEMBER_STATE'] }) } });
  gp('post', '/members/{memberId}/remove', 'Remove a mistaken entry (owner): unpaid dues void; refused while a due holds payments (M24-FR-20)', { request: { ...gmM, ...body(gmS.reasonBody) }, responses: { 200: json(gmS.MemberProfile), ...errors({ ...GMW, 409: ['GYM_MEMBER_STATE'] }) } });
  gp('get', '/members/{memberId}/notes', 'Notes (whoever can see the member; never shown to the member)', { request: gmM, responses: { 200: json(gmS.NoteList), ...errors(GM) } });
  gp('post', '/members/{memberId}/notes', 'Add a note (append-only, up to 2,000 characters; M24-FR-22)', { request: { ...gmM, ...body(gmS.noteBody) }, responses: { 201: json(gmS.Note, 'Created'), ...errors(GM) } });
  gp('get', '/members/{memberId}/attendance', 'The member’s counted check-ins of a month (YYYY-MM, default this Dhaka month)', { request: { ...gmM, query: gmS.monthQuery }, responses: { 200: json(gmS.Calendar), ...errors(GM) } });
  gp('put', '/members/{memberId}/photo', 'Set the member’s photo (raw JPEG, PNG or WebP up to ground.photo_max_bytes; private bucket; members.edit)', {
    request: { ...gmM, body: gmImage('The photo itself') },
    responses: { 200: json(gmS.PhotoResult), ...errors({ ...GMW, 409: ['GYM_MEMBER_STATE'], 413: ['FILE_TOO_LARGE'], 415: ['FILE_TYPE_NOT_ALLOWED', 'FILE_TYPE_MISMATCH'], 422: ['FILE_EMPTY'] }) },
  });
  gp('get', '/members/{memberId}/photo', 'The member’s photo, streamed (no-store)', { request: gmM, responses: { 200: gmImage('The photo'), ...errors(GM) } });
  gp('post', '/members/{memberId}/memberships', 'Assign a membership (members.edit): an active desk package, start from gym_manage.backdate_days ago to 60 days ahead; admission fee on the first membership and after a re-join; a discount needs fees.adjust; optional first payment (M24-FR-25, FR-26)', {
    request: { ...gmM, headers: idem, ...body(gmS.assignBody) },
    responses: { 201: json(gmS.MembershipResult, 'Created'), ...errors({ ...GMS, 409: ['GYM_SETUP_REQUIRED', 'GYM_MEMBERSHIP_OVERLAP', 'GYM_MEMBER_STATE'], 422: ['VALIDATION_FAILED', 'GYM_PACKAGE_UNAVAILABLE', 'GYM_DATE_OUT_OF_RANGE', 'GYM_PAYMENT_EXCEEDS_DUE'] }) },
  });
  gp('get', '/requests', 'Link requests of the gym (members.view; pending by default)', { request: { ...gmG, query: gmS.requestsQuery }, responses: { 200: json(gmS.RequestList), ...errors(GM) } });
  gp('post', '/requests/{requestId}/cancel', 'Cancel a pending gym invite (members.edit)', { request: { params: gmS.requestParam }, responses: { 200: json(gmS.RequestResult), ...errors({ ...GM, 409: ['GYM_LINK_REQUEST_STATE'] }) } });
  gp('post', '/memberships/{membershipId}/renew', 'Renew (members.edit): continuous within gym_manage.renew_grace_days, else from the chosen date; its own due; optional payment (M24-FR-27)', {
    request: { ...gmMs, headers: idem, ...body(gmS.renewBody) },
    responses: { 201: json(gmS.MembershipResult, 'Created'), ...errors({ ...GMS, 409: ['GYM_SETUP_REQUIRED', 'GYM_MEMBERSHIP_STATE', 'GYM_MEMBERSHIP_OVERLAP', 'GYM_MEMBER_STATE'], 422: ['VALIDATION_FAILED', 'GYM_PACKAGE_UNAVAILABLE', 'GYM_DATE_OUT_OF_RANGE'] }) },
  });
  gp('post', '/memberships/{membershipId}/freeze', 'Freeze from today or later inside the membership; the end moves by the frozen days (members.edit; M24-FR-28)', { request: { ...gmMs, ...body(gmS.freezeBody) }, responses: { 200: json(gmS.MembershipResult), ...errors({ ...GMW, 409: ['GYM_MEMBERSHIP_STATE'], 422: ['VALIDATION_FAILED', 'GYM_FREEZE_LIMIT', 'GYM_DATE_OUT_OF_RANGE'] }) } });
  gp('post', '/memberships/{membershipId}/unfreeze', 'End the running freeze today (unused days given back) or cancel a scheduled one (members.edit; works while restricted)', { request: gmMs, responses: { 200: json(gmS.MembershipResult), ...errors({ ...GM, 409: ['GYM_MEMBERSHIP_STATE'] }) } });
  gp('post', '/memberships/{membershipId}/change', 'Change package (members.edit): the old one ends the day before, the new due = new price − unused credit; editing the amount needs fees.adjust (M24-FR-29)', {
    request: { ...gmMs, headers: idem, ...body(gmS.changeBody) },
    responses: { 201: json(gmS.MembershipResult, 'Created'), ...errors({ ...GMS, 409: ['GYM_SETUP_REQUIRED', 'GYM_MEMBERSHIP_STATE', 'GYM_MEMBER_STATE'], 422: ['VALIDATION_FAILED', 'GYM_PACKAGE_UNAVAILABLE', 'GYM_DATE_OUT_OF_RANGE'] }) },
  });
  gp('post', '/memberships/{membershipId}/cancel', 'Cancel (members.edit): before it starts → cancelled and its due void when nothing was paid; after → ends today (M24-FR-30)', { request: { ...gmMs, ...body(gmS.reasonBody) }, responses: { 200: json(gmS.MembershipResult), ...errors({ ...GMW, 409: ['GYM_MEMBERSHIP_STATE'] }) } });
  gp('get', '/dues', 'Dues (fees.collect): unpaid and partial by default; filters status, overdue, dueOn, memberId', { request: { ...gmG, query: gmS.duesQuery }, responses: { 200: json(gmS.DueList), ...errors(GM) } });
  gp('post', '/dues/{dueId}/payments', 'Record a counter payment (fees.collect; works while restricted): ৳1 to the outstanding; earlier dates need fees.adjust; a receipt number per gym and year. Bookkeeping only: no ledger entry (M24-FR-33, FR-34)', {
    request: { ...gmD, headers: idem, ...body(gmS.paymentBody) },
    responses: { 201: json(gmS.PaymentResult, 'Created'), ...errors({ ...GM, 409: ['GYM_DUE_STATE', 'GYM_SETUP_REQUIRED'], 422: ['VALIDATION_FAILED', 'GYM_PAYMENT_EXCEEDS_DUE', 'GYM_DATE_OUT_OF_RANGE'] }) },
  });
  gp('post', '/dues/{dueId}/waive', 'Waive all or part of the outstanding with a reason (fees.adjust; M24-FR-36)', { request: { ...gmD, ...body(gmS.waiveBody) }, responses: { 200: json(gmS.DueResult), ...errors({ ...GMW, 409: ['GYM_DUE_STATE'], 422: ['VALIDATION_FAILED', 'GYM_PAYMENT_EXCEEDS_DUE'] }) } });
  gp('post', '/fee-payments/{feePaymentId}/reverse', 'Reverse a counter payment once (fees.adjust): a new negative row; the original never changes (M24-FR-35)', {
    request: { ...gmF, headers: idem, ...body(gmS.reasonBody) },
    responses: { 201: json(gmS.ReverseResult, 'Created'), ...errors({ ...GM, 409: ['GYM_PAYMENT_NOT_REVERSIBLE'] }) },
  });
  gp('get', '/fee-payments/{feePaymentId}/receipt', 'The receipt JSON (fees.collect); the printable page is gym.kriraghor.com/r/{token} (M24-FR-37)', { request: gmF, responses: { 200: json(gmS.Receipt), ...errors(GM) } });
  gp('get', '/cash-closing', 'Daily cash closing for a Dhaka date: totals by staff member and method (fees.collect: own; owner and reports.view: everyone) (M24-FR-38)', { request: { ...gmG, query: gmS.dayQuery }, responses: { 200: json(gmS.CashClosing), ...errors(GM) } });
  gp('get', '/imports', 'The gym’s member list imports, newest first (owner)', { request: gmG, responses: { 200: json(gmS.ImportList), ...errors(GM) } });
  gp('post', '/imports', 'Upload a member list (owner): raw CSV or XLSX on the template, up to gym_manage.import_max_bytes and import_max_rows; returns the preview, nothing else is saved (M24-FR-75)', {
    request: { ...gmG, query: gmS.importQuery, body: gmFile('The file itself (Content-Type text/csv or the XLSX type)') },
    responses: { 201: json(gmS.Import, 'Previewed'), ...errors({ ...GMS, 409: ['GYM_SETUP_REQUIRED'], 422: ['GYM_IMPORT_INVALID'] }) },
  });
  gp('get', '/imports/{importId}', 'One import with its row report (owner)', { request: gmI, responses: { 200: json(gmS.Import), ...errors(GM) } });
  gp('post', '/imports/{importId}/apply', 'Apply the ok rows (owner): members, memberships, dues and opening payments; sends nothing (M24-FR-76, FR-78)', { request: { ...gmI, headers: idem }, responses: { 200: json(gmS.Import), ...errors({ ...GMW, 409: ['GYM_IMPORT_STATE'] }) } });
  gp('post', '/imports/{importId}/undo', 'Undo within gym_manage.import_undo_hours when no imported member has later activity (owner; M24-FR-77)', { request: gmI, responses: { 200: json(gmS.Import), ...errors({ ...GM, 409: ['GYM_IMPORT_STATE', 'GYM_IMPORT_UNDO_BLOCKED'] }) } });
  gp('post', '/imports/{importId}/discard', 'Discard a preview; its file is deleted (owner)', { request: gmI, responses: { 200: json(gmS.Import), ...errors({ ...GM, 409: ['GYM_IMPORT_STATE'] }) } });
  gp('post', '/imports/{importId}/send-invites', 'Send app invites to every imported member, once (owner; M24-FR-78)', { request: gmI, responses: { 200: json(gmS.Import), ...errors({ ...GMW, 409: ['GYM_IMPORT_STATE'] }) } });
  gp('put', '/import-consent', 'Let Kriraghor staff upload a member list for gym_manage.import_consent_days, or withdraw it (owner; M24-FR-79)', { request: { ...gmG, ...body(gmS.consentBody) }, responses: { 200: json(gmS.ConsentResult), ...errors({ ...GM, 409: ['GYM_SETUP_REQUIRED'] }) } });
  p({ method: 'get', path: '/manage/billing', tags: gmTag, summary: 'My gym plan (gate run_gym, owner of a gym): the tier, today’s active members against its limit, the features, the plans', security: bearer, responses: { 200: json(gmS.Billing), ...errors({ ...COMMON_AUTH, 403: ['PERMISSION_REQUIRED', 'PHONE_REQUIRED', 'ROLE_SUSPENDED'] }) } });
  p({ method: 'put', path: '/manage/billing/tier', tags: gmTag, summary: 'Choose the plan: features change at once; the month is billed at the highest tier chosen in it (M24-FR-82)', security: bearer, request: body(gmS.tierBody), responses: { 200: json(gmS.Billing), ...errors({ ...COMMON_AUTH, 403: ['PERMISSION_REQUIRED', 'PHONE_REQUIRED', 'ROLE_SUSPENDED', 'GYM_ACCOUNT_RESTRICTED'], ...VALIDATION }) } });
  p({ method: 'get', path: '/gym-manage/pricing', tags: gmTag, summary: 'The gym plans: member limits, prices and features from settings (public)', responses: { 200: json(gmS.Pricing) } });
  p({ method: 'get', path: '/gym-receipts/{token}', tags: gmTag, summary: 'A receipt behind its signed link, no sign-in (noindex; a token for another receipt is 404)', request: { params: gmS.tokenParam }, responses: { 200: json(gmS.Receipt), ...errors({ 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'get', path: '/me/gym-requests', tags: gmTag, summary: 'Gym invites to me (pending by default) with what the gym will see', security: bearer, request: { query: gmS.meRequestsQuery }, responses: { 200: json(gmS.MyRequests), ...errors(COMMON_AUTH) } });
  p({ method: 'post', path: '/me/gym-requests/{requestId}/accept', tags: gmTag, summary: 'Accept a gym invite (gate join_gym): my account is linked to the member (M24-FR-15)', security: bearer, request: { params: gmS.meRequestParam }, responses: { 200: json(gmS.AcceptResult), ...errors({ ...COMMON_AUTH, 403: ['PHONE_REQUIRED'], 404: ['NOT_FOUND'], 409: ['GYM_LINK_REQUEST_STATE', 'GYM_ALREADY_LINKED'] }) } });
  p({ method: 'post', path: '/me/gym-requests/{requestId}/decline', tags: gmTag, summary: 'Decline a gym invite (the record stays unlinked)', security: bearer, request: { params: gmS.meRequestParam }, responses: { 200: json(gmS.DeclineResult), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], 409: ['GYM_LINK_REQUEST_STATE'] }) } });
  p({ method: 'get', path: '/me/gym-memberships', tags: gmTag, summary: 'My gyms: current links and past ones (read-only receipts), the running membership and what is outstanding', security: bearer, responses: { 200: json(gmS.MyMemberships), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/me/gym-memberships/{memberId}', tags: gmTag, summary: 'One of my gym memberships: memberships with freezes, dues with payments, receipts', security: bearer, request: gmMe, responses: { 200: json(gmS.MyMembership), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'] }) } });
  p({ method: 'get', path: '/me/gym-memberships/{memberId}/attendance', tags: gmTag, summary: 'My check-ins of a month', security: bearer, request: { ...gmMe, query: gmS.monthQuery }, responses: { 200: json(gmS.Calendar), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'] }) } });
  p({ method: 'get', path: '/me/gym-memberships/{memberId}/checkin-token', tags: gmTag, summary: 'My rotating check-in QR token (linked only; no-store; valid for gym_manage.member_qr_seconds, the desk also accepts the previous one) (M24-FR-50)', security: bearer, request: gmMe, responses: { 200: json(gmS.CheckinToken), ...errors({ ...COMMON_AUTH, 403: ['GYM_NOT_A_MEMBER'], 404: ['NOT_FOUND'] }) } });
  p({ method: 'put', path: '/me/gym-memberships/{memberId}/health-note', tags: gmTag, summary: 'My health note at this gym (encrypted; shown to the owner and plans.manage staff; empty clears it)', security: bearer, request: { ...gmMe, ...body(gmS.healthNoteBody) }, responses: { 200: json(gmS.HealthNote), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'post', path: '/me/gym-memberships/{memberId}/unlink', tags: gmTag, summary: 'Unlink my account from this gym (the gym keeps its record; my receipts stay under Past)', security: bearer, request: gmMe, responses: { 200: json(gmS.UnlinkResult), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], 409: ['GYM_MEMBER_STATE'] }) } });
  p({ method: 'get', path: '/me/gym-receipts', tags: gmTag, summary: 'My gym receipts across gyms', security: bearer, responses: { 200: json(gmS.MyReceipts), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/me/gym-receipts/{feePaymentId}', tags: gmTag, summary: 'One of my receipts', security: bearer, request: { params: gmS.meReceiptParam }, responses: { 200: json(gmS.Receipt), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'] }) } });
  p({ method: 'post', path: '/admin/gym-manage/gyms/{gymId}/imports', tags: gmTag, summary: 'Upload a member list for an owner (manage_gyms, while the owner’s consent lasts); preview only, the owner applies (M24-FR-79)', security: adminBearer,
    request: { params: gmS.gymParam, query: gmS.importQuery, body: gmFile('The file itself') }, responses: { 201: json(gmS.Import, 'Previewed'), ...errors({ ...ADMIN_AUTH, 403: [...ADMIN_AUTH[403], 'GYM_IMPORT_CONSENT_REQUIRED'], 404: ['NOT_FOUND'], 422: ['GYM_IMPORT_INVALID'] }) } });

  // ------------------------------------------------------------------ M14 lite organisations and M22 organiser SaaS (step 1)
  const orgP = { params: saS.orgParam };
  const orgIdP = { params: saS.orgIdParam };
  const orgMatchP = { params: saS.orgMatchParam };
  const saId = { params: saS.idParam };
  // Organiser console: not a member (or not an admin where admins are needed) is a 404 (M22-FR-03).
  const ORG = { ...COMMON_AUTH, 404: ['NOT_FOUND'] };
  const ORG_T = { ...ORG, 409: ['ESPORTS_TOURNAMENT_STATE', 'ESPORTS_PRIZE_TABLE_LOCKED'], 422: ['VALIDATION_FAILED'] };
  const saImage = (description) => ({ description, content: { 'image/jpeg': { schema: z.string() }, 'image/png': { schema: z.string() }, 'image/webp': { schema: z.string() } } });
  const saPdf = (description) => ({ description, content: { 'application/pdf': { schema: z.string() } } });
  p({ method: 'get', path: '/me/organisations', tags: ['organisers'], summary: 'Organisations I belong to, with my role', security: bearer, responses: { 200: json(orgS.OrganisationList), ...errors(COMMON_AUTH) } });
  p({ method: 'post', path: '/me/organisations', tags: ['organisers'], summary: 'Apply with an organisation (needs the organiser role applied for: NID and the registration document)', security: bearer,
    request: body(orgS.createBody), responses: { 201: json(orgS.Organisation, 'Created'), ...errors({ ...COMMON_AUTH, 403: ['ORG_ROLE_REQUIRED', 'ORG_KIND_CLOSED'], 422: ['AREA_UNKNOWN', 'VALIDATION_FAILED'] }) } });
  p({ method: 'get', path: '/me/organisations/{id}', tags: ['organisers'], summary: 'One of my organisations', security: bearer, request: { params: orgS.idParam }, responses: { 200: json(orgS.Organisation), ...errors(ORG) } });
  p({ method: 'patch', path: '/me/organisations/{id}', tags: ['organisers'], summary: 'Edit (owner); the name and area are fixed once verified', security: bearer, request: { params: orgS.idParam, ...body(orgS.updateBody) }, responses: { 200: json(orgS.Organisation), ...errors({ ...ORG, 409: ['ORG_IN_REVIEW', 'ORG_STATE'], 422: ['AREA_UNKNOWN', 'VALIDATION_FAILED'] }) } });
  p({ method: 'post', path: '/me/organisations/{id}/submit', tags: ['organisers'], summary: 'Send for review on the Moderation desk (M05 kind organisation)', security: bearer, request: { params: orgS.idParam }, responses: { 200: json(orgS.Organisation), ...errors({ ...ORG, 403: ['ORG_ROLE_REQUIRED', 'ORG_KIND_CLOSED'], 409: ['ORG_IN_REVIEW', 'ORG_STATE'] }) } });
  p({ method: 'get', path: '/org/{orgId}/members', tags: ['organisers'], summary: 'Members of the organisation (any member)', security: bearer, request: orgP, responses: { 200: json(orgS.MemberList), ...errors(ORG) } });
  p({ method: 'post', path: '/org/{orgId}/members', tags: ['organisers'], summary: 'Add an existing member by phone as admin or staff (owner or admin)', security: bearer, request: { ...orgP, ...body(orgS.memberBody) }, responses: { 201: json(orgS.MemberResult, 'Created'), ...errors({ ...ORG, 409: ['ORG_MEMBER_EXISTS'], 422: ['VALIDATION_FAILED'] }) } });
  p({ method: 'post', path: '/org/{orgId}/members/{memberId}/remove', tags: ['organisers'], summary: 'Remove a member (the owner stays)', security: bearer, request: { params: orgS.memberParams }, responses: { 200: json(orgS.MemberResult), ...errors({ ...ORG, 409: ['ORG_OWNER_FIXED'] }) } });
  p({ method: 'get', path: '/org/{orgId}/esports/dashboard', tags: ['organisers'], summary: 'Contract, unpaid invoices, whether tournaments can be submitted, tournaments by status', security: bearer, request: orgP, responses: { 200: json(saS.Dashboard), ...errors(ORG) } });
  p({ method: 'get', path: '/org/{orgId}/esports/tournaments', tags: ['organisers'], summary: 'The organisation\'s tournaments (every status)', security: bearer, request: { ...orgP, query: saS.tournamentsQuery }, responses: { 200: json(esS.TournamentList), ...errors(ORG) } });
  p({ method: 'post', path: '/org/{orgId}/esports/tournaments', tags: ['organisers'], summary: 'A draft owned by the organisation (FR-04); a per-kill reward needs maxPaidKills', security: bearer,
    request: { ...orgP, ...body(esS.tournamentBody) }, responses: { 201: json(esS.Tournament, 'Created'), ...errors({ ...ORG, 422: ['ESPORTS_KILL_CAP_REQUIRED', 'POINTS_INVALID', 'VALIDATION_FAILED'] }) } });
  p({ method: 'get', path: '/org/{orgId}/esports/tournaments/{id}', tags: ['organisers'], summary: 'A tournament with its prize fund and SaaS fee snapshot', security: bearer, request: orgIdP, responses: { 200: json(esS.Tournament.extend({ fund: z.object({}).loose(), saas: z.object({}).loose() })), ...errors(ORG) } });
  p({ method: 'patch', path: '/org/{orgId}/esports/tournaments/{id}', tags: ['organisers'], summary: 'Edit a draft (the prize fund follows; a smaller pool than deposited is refused)', security: bearer,
    request: { ...orgIdP, ...body(esS.tournamentPatch) }, responses: { 200: json(esS.Tournament), ...errors({ ...ORG_T, 409: ORG_T[409].concat('PRIZE_FUND_SHRINK'), 422: ['ESPORTS_KILL_CAP_REQUIRED', 'VALIDATION_FAILED'] }) } });
  p({ method: 'post', path: '/org/{orgId}/esports/tournaments/{id}/prize-fund', tags: ['organisers'], summary: 'Pay what the prize pool still needs into escrow (FR-05; org admins)', security: bearer,
    request: { ...orgIdP, headers: idem }, responses: { 201: json(saS.FundPayment, 'Created'), ...errors({ ...ORG, ...IDEM, 409: ['PRIZE_FUND_LOCKED', 'IDEMPOTENCY_IN_PROGRESS'] }) } });
  p({ method: 'post', path: '/org/{orgId}/esports/tournaments/{id}/submit', tags: ['organisers'], summary: 'Send for review (org admins): an active contract, no invoice overdue past grace, a funded pool', security: bearer,
    request: orgIdP, responses: { 200: json(esS.Tournament), ...errors({ ...ORG, 409: ['ESPORTS_TOURNAMENT_STATE', 'ORG_SUSPENDED', 'ORG_CONTRACT_REQUIRED', 'ORG_CONTRACT_SUSPENDED', 'INVOICE_OVERDUE', 'PRIZE_FUND_REQUIRED', 'PRIZE_FUND_AMOUNT_MISMATCH'], 422: ['SCHEDULE_INVALID', 'PRIZE_PLACES_INVALID'] }) } });
  p({ method: 'post', path: '/org/{orgId}/esports/tournaments/{id}/cancel', tags: ['organisers'], summary: 'Cancel a draft or a tournament in review (the prize fund returns to the owner)', security: bearer,
    request: { ...orgIdP, ...body(esS.cancelBody) }, responses: { 200: json(esS.Tournament), ...errors({ ...ORG, 409: ['ORG_TOURNAMENT_STATE', 'ESPORTS_TOURNAMENT_STATE'] }) } });
  p({ method: 'get', path: '/org/{orgId}/esports/tournaments/{id}/checkins', tags: ['organisers'], summary: 'The check-in board', security: bearer, request: orgIdP, responses: { 200: json(esS.Board), ...errors(ORG) } });
  p({ method: 'get', path: '/org/{orgId}/esports/tournaments/{id}/finalise-preview', tags: ['organisers'], summary: 'The awards and totals finalising would pay', security: bearer, request: orgIdP, responses: { 200: json(esS.Preview), ...errors(ORG) } });
  p({ method: 'post', path: '/org/{orgId}/esports/tournaments/{id}/finalise/code', tags: ['organisers'], summary: 'Send a code to the admin\'s phone to confirm the payout', security: bearer, request: orgIdP, responses: { 200: json(saS.CodeSent), ...errors({ ...ORG, 409: ['PHONE_REQUIRED'], 429: ['OTP_RATE_LIMITED'] }) } });
  p({ method: 'post', path: '/org/{orgId}/esports/tournaments/{id}/finalise', tags: ['organisers'], summary: 'Finalise with the code: prizes from the fund, the fee, the rest to the owner (FR-07, FR-10)', security: bearer,
    request: { ...orgIdP, ...body(saS.finaliseBody) }, responses: { 200: json(esS.Tournament), ...errors({ ...ORG, 409: ['ESPORTS_NOT_FINALISABLE', 'ESCROW_FROZEN'], 400: ['OTP_INVALID', 'OTP_EXPIRED'], 422: ['VALIDATION_FAILED'] }) } });
  p({ method: 'get', path: '/org/{orgId}/esports/matches/{matchId}', tags: ['organisers'], summary: 'A match with its entries and results', security: bearer, request: orgMatchP, responses: { 200: json(esS.Match), ...errors(ORG) } });
  p({ method: 'get', path: '/org/{orgId}/esports/matches/{matchId}/room', tags: ['organisers'], summary: 'The room panel (no-store)', security: bearer, request: orgMatchP, responses: { 200: json(esS.RoomPanel), ...errors(ORG) } });
  p({ method: 'put', path: '/org/{orgId}/esports/matches/{matchId}/room', tags: ['organisers'], summary: 'Set the room (org staff, Q135; encrypted, audited)', security: bearer, request: { ...orgMatchP, ...body(esS.roomBody) }, responses: { 200: json(esS.RoomPanel), ...errors({ ...ORG, ...VALIDATION }) } });
  p({ method: 'post', path: '/org/{orgId}/esports/matches/{matchId}/room/rotate', tags: ['organisers'], summary: 'Rotate the room credentials and push them again', security: bearer, request: { ...orgMatchP, ...body(esS.rotateBody) }, responses: { 200: json(esS.RoomPanel), ...errors({ ...ORG, ...VALIDATION }) } });
  p({ method: 'put', path: '/org/{orgId}/esports/matches/{matchId}/results', tags: ['organisers'], summary: 'Enter placements and kills (org staff, Q135)', security: bearer, request: { ...orgMatchP, ...body(esS.resultsBody) }, responses: { 200: json(esS.Match), ...errors({ ...ORG, ...VALIDATION }) } });
  p({ method: 'post', path: '/org/{orgId}/esports/matches/{matchId}/results/post', tags: ['organisers'], summary: 'Post the results (the dispute window opens)', security: bearer, request: orgMatchP, responses: { 200: json(esS.Match), ...errors({ ...ORG, 409: ['ESPORTS_TOO_EARLY'] }) } });
  p({ method: 'get', path: '/org/{orgId}/billing/contracts', tags: ['organisers'], summary: 'The organisation\'s contracts (org admins)', security: bearer, request: orgP, responses: { 200: json(saS.ContractList), ...errors(ORG) } });
  p({ method: 'get', path: '/org/{orgId}/billing/invoices', tags: ['organisers'], summary: 'The organisation\'s invoices (org admins)', security: bearer, request: orgP, responses: { 200: json(saS.InvoiceList), ...errors(ORG) } });
  p({ method: 'post', path: '/org/{orgId}/billing/invoices/{id}/pay', tags: ['organisers'], summary: 'Pay an invoice (M06 purpose fee_invoice)', security: bearer,
    request: { ...orgIdP, headers: idem }, responses: { 201: json(saS.PayResult, 'Created'), ...errors({ ...ORG, ...IDEM, 409: ['INVOICE_STATE', 'IDEMPOTENCY_IN_PROGRESS'] }) } });
  p({ method: 'get', path: '/org/{orgId}/branding', tags: ['organisers'], summary: 'Logo, colours, taglines and subdomain', security: bearer, request: orgP, responses: { 200: json(saS.Branding), ...errors(ORG) } });
  p({ method: 'put', path: '/org/{orgId}/branding', tags: ['organisers'], summary: 'Colours (WCAG AA checked) and taglines', security: bearer, request: { ...orgP, ...body(saS.brandingBody) }, responses: { 200: json(saS.Branding), ...errors({ ...ORG, 422: ['BRAND_PRIMARY_CONTRAST', 'BRAND_ACCENT_CONTRAST', 'VALIDATION_FAILED'] }) } });
  p({ method: 'put', path: '/org/{orgId}/branding/subdomain', tags: ['organisers'], summary: 'Claim {sub}.esports.kriraghor.com (the first claim wins)', security: bearer, request: { ...orgP, ...body(saS.subdomainBody) }, responses: { 200: json(saS.Branding), ...errors({ ...ORG, 409: ['SUBDOMAIN_TAKEN'], 422: ['SUBDOMAIN_INVALID', 'SUBDOMAIN_RESERVED'] }) } });
  p({ method: 'post', path: '/org/{orgId}/branding/logo', tags: ['organisers'], summary: 'Upload the logo (raw JPEG, PNG or WebP, up to 2 MB, public bucket)', security: bearer,
    request: { ...orgP, body: saImage('The logo itself') }, responses: { 201: json(saS.Branding, 'Created'), ...errors({ ...ORG, 413: ['FILE_TOO_LARGE'], 415: ['FILE_TYPE_NOT_ALLOWED', 'FILE_TYPE_MISMATCH'], 422: ['FILE_EMPTY'] }) } });
  p({ method: 'get', path: '/esports/organisers/{subdomain}', tags: ['organisers'], summary: 'A verified organisation\'s branded page: branding and public tournaments', request: { params: saS.subdomainParam }, responses: { 200: json(saS.Organiser), ...errors({ 404: ['NOT_FOUND'] }) } });
  const STAFF_ORG = { ...ADMIN_AUTH, 404: ['NOT_FOUND'] };
  p({ method: 'get', path: '/admin/organisers', tags: ['organisers'], summary: 'Organisations (manage_organisers, approve_listings or manage_esports)', security: adminBearer, request: { query: orgS.adminQuery }, responses: { 200: json(orgS.OrganisationList), ...errors(ADMIN_AUTH) } });
  p({ method: 'get', path: '/admin/organisers/{id}', tags: ['organisers'], summary: 'One organisation with its members', security: adminBearer, request: saId, responses: { 200: json(orgS.StaffOrganisation), ...errors(STAFF_ORG) } });
  p({ method: 'post', path: '/admin/organisers/{id}/suspend', tags: ['organisers'], summary: 'Suspend an organisation (manage_organisers)', security: adminBearer, request: { ...saId, ...body(orgS.reasonBody) }, responses: { 200: json(orgS.Organisation), ...errors({ ...STAFF_ORG, 409: ['ORG_STATE'] }) } });
  p({ method: 'post', path: '/admin/organisers/{id}/restore', tags: ['organisers'], summary: 'Restore a suspended organisation (masters)', security: adminBearer, request: { ...saId, ...body(orgS.reasonBody) }, responses: { 200: json(orgS.Organisation), ...errors({ ...STAFF_ORG, 409: ['ORG_STATE'] }) } });
  p({ method: 'get', path: '/admin/organisers/{id}/contracts', tags: ['organisers'], summary: 'An organisation\'s contracts', security: adminBearer, request: saId, responses: { 200: json(saS.ContractList), ...errors(STAFF_ORG) } });
  p({ method: 'post', path: '/admin/organisers/{id}/contracts', tags: ['organisers'], summary: 'A contract draft (percentage at fees.esports_saas_pct or its own pct; or flat per month or quarter)', security: adminBearer,
    request: { ...saId, ...body(saS.contractBody) }, responses: { 201: json(saS.Contract, 'Created'), ...errors({ ...STAFF_ORG, 409: ['ESPORTS_ORGANISERS_CLOSED'], 422: ['CONTRACT_FIELDS_INVALID', 'VALIDATION_FAILED'] }) } });
  p({ method: 'patch', path: '/admin/organisers/contracts/{id}', tags: ['organisers'], summary: 'Edit a contract draft', security: adminBearer, request: { ...saId, ...body(saS.contractPatch) }, responses: { 200: json(saS.Contract), ...errors({ ...STAFF_ORG, 409: ['CONTRACT_STATE'], 422: ['CONTRACT_FIELDS_INVALID', 'VALIDATION_FAILED'] }) } });
  p({ method: 'post', path: '/admin/organisers/contracts/{id}/document', tags: ['organisers'], summary: 'Attach the signed contract (raw PDF, private bucket)', security: adminBearer,
    request: { ...saId, body: saPdf('The signed contract') }, responses: { 200: json(saS.Contract), ...errors({ ...STAFF_ORG, 409: ['CONTRACT_STATE'], 413: ['FILE_TOO_LARGE'], 415: ['FILE_TYPE_NOT_ALLOWED', 'FILE_TYPE_MISMATCH'], 422: ['FILE_EMPTY'] }) } });
  p({ method: 'post', path: '/admin/organisers/contracts/{id}/activate', tags: ['organisers'], summary: 'Activate or reinstate (step-up esports.money); a flat contract is invoiced at once', security: adminBearer,
    request: { ...saId, headers: stepUpHeader }, responses: { 200: json(saS.Contract), ...errors({ ...STAFF_ORG, ...STEP, 409: ['ESPORTS_ORGANISERS_CLOSED', 'CONTRACT_STATE', 'ORG_NOT_VERIFIED', 'CONTRACT_DOCUMENT_REQUIRED', 'CONTRACT_ACTIVE_EXISTS'] }) } });
  p({ method: 'post', path: '/admin/organisers/contracts/{id}/suspend', tags: ['organisers'], summary: 'Suspend (step-up): new submits stop, running tournaments finish (FR-13)', security: adminBearer,
    request: { ...saId, headers: stepUpHeader, ...body(saS.reasonBody) }, responses: { 200: json(saS.Contract), ...errors({ ...STAFF_ORG, ...STEP, 409: ['CONTRACT_STATE'] }) } });
  p({ method: 'post', path: '/admin/organisers/contracts/{id}/end', tags: ['organisers'], summary: 'End a contract (step-up)', security: adminBearer,
    request: { ...saId, headers: stepUpHeader, ...body(saS.reasonBody) }, responses: { 200: json(saS.Contract), ...errors({ ...STAFF_ORG, ...STEP, 409: ['CONTRACT_STATE'] }) } });
  p({ method: 'get', path: '/admin/organisers/invoices', tags: ['organisers'], summary: 'Organiser invoices by organisation and status', security: adminBearer, request: { query: saS.invoicesQuery }, responses: { 200: json(saS.InvoiceList), ...errors(ADMIN_AUTH) } });
  p({ method: 'post', path: '/admin/organisers/invoices/{id}/void', tags: ['organisers'], summary: 'Void an unpaid invoice (step-up), with a reason', security: adminBearer,
    request: { ...saId, headers: stepUpHeader, ...body(saS.reasonBody) }, responses: { 200: json(saS.Invoice), ...errors({ ...STAFF_ORG, ...STEP, 409: ['INVOICE_STATE'] }) } });

  // ------------------------------------------------------------------ M23 esports big events (step 1)
  const evId = { params: evS.idParam };
  const EV = { 404: ['NOT_FOUND'] };
  const EV_STAFF = { ...ADMIN_AUTH, 404: ['NOT_FOUND'] };
  const evImage = (description) => ({ description, content: { 'image/jpeg': { schema: z.string() }, 'image/png': { schema: z.string() }, 'image/webp': { schema: z.string() } } });
  const IMG = { 413: ['FILE_TOO_LARGE'], 415: ['FILE_TYPE_NOT_ALLOWED', 'FILE_TYPE_MISMATCH'], 422: ['FILE_EMPTY'] };
  p({ method: 'get', path: '/esports/events', tags: ['esports-events'], summary: 'Big events: live first, then upcoming, then ended (cacheable)', request: { query: evS.listQuery }, responses: { 200: json(evS.EventList), 304: noContent } });
  p({ method: 'get', path: '/esports/events/{slug}', tags: ['esports-events'], summary: 'An event page: stages, qualifications, streams with embeds, sponsors, polls with totals, the feed (no viewer data; cacheable)',
    request: { params: evS.slugParam }, responses: { 200: json(evS.Bundle), 304: noContent, ...errors(EV) } });
  p({ method: 'get', path: '/esports/events/{id}/feed', tags: ['esports-events'], summary: 'The event feed, newest first', request: { ...evId, query: evS.feedQuery }, responses: { 200: json(evS.Feed) } });
  p({ method: 'get', path: '/esports/events/{id}/me', tags: ['esports-events'], summary: 'Whether I follow the event and my poll votes', security: bearer, request: evId, responses: { 200: json(evS.Me), ...errors(COMMON_AUTH) } });
  p({ method: 'post', path: '/esports/events/{id}/follow', tags: ['esports-events'], summary: 'Follow the event (in-app alerts when it starts, a stream goes live and before the final)', security: bearer,
    request: evId, responses: { 200: json(evS.Follow), ...errors({ ...COMMON_AUTH, ...EV, ...RATE }) } });
  p({ method: 'post', path: '/esports/events/{id}/unfollow', tags: ['esports-events'], summary: 'Stop following', security: bearer, request: evId, responses: { 200: json(evS.Follow), ...errors({ ...COMMON_AUTH, ...EV, ...RATE }) } });
  p({ method: 'post', path: '/esports/events/{id}/polls/{pollId}/vote', tags: ['esports-events'], summary: 'Vote in a free poll (verified phone; one vote, final; no stakes)', security: bearer,
    request: { params: evS.pollParam, ...body(evS.voteBody) },
    responses: { 200: json(evS.Poll), ...errors({ ...COMMON_AUTH, 403: ['PHONE_REQUIRED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_BANNED'], ...EV, 409: ['POLL_CLOSED', 'POLL_ALREADY_VOTED'], 422: ['POLL_OPTION_UNKNOWN', 'VALIDATION_FAILED'], ...RATE }) } });
  p({ method: 'get', path: '/me/esports/events', tags: ['esports-events'], summary: 'Events I follow', security: bearer, responses: { 200: json(evS.EventList), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/admin/esports/events', tags: ['esports-events'], summary: 'Every event (manage_esports)', security: adminBearer, request: { query: evS.adminListQuery }, responses: { 200: json(evS.EventList), ...errors(ADMIN_AUTH) } });
  p({ method: 'post', path: '/admin/esports/events', tags: ['esports-events'], summary: 'A draft event', security: adminBearer,
    request: body(evS.eventBody), responses: { 201: json(evS.EventDraft, 'Created'), ...errors({ ...ADMIN_AUTH, 422: ['EVENT_DATES_INVALID', 'EVENT_ACCENT_INVALID', 'VALIDATION_FAILED'] }) } });
  p({ method: 'get', path: '/admin/esports/events/{id}', tags: ['esports-events'], summary: 'An event with drafts, polls in draft and the link check', security: adminBearer, request: evId, responses: { 200: json(evS.AdminEvent), ...errors(EV_STAFF) } });
  p({ method: 'patch', path: '/admin/esports/events/{id}', tags: ['esports-events'], summary: 'Change a draft or published event (the slug stays)', security: adminBearer,
    request: { ...evId, ...body(evS.eventPatch) }, responses: { 200: json(evS.EventDraft), ...errors({ ...EV_STAFF, 409: ['EVENT_STATE'], 422: ['EVENT_DATES_INVALID', 'EVENT_ACCENT_INVALID', 'VALIDATION_FAILED'] }) } });
  p({ method: 'post', path: '/admin/esports/events/{id}/banner', tags: ['esports-events'], summary: 'Upload the banner (public bucket)', security: adminBearer,
    request: { ...evId, body: evImage('The banner') }, responses: { 200: json(evS.EventDraft), ...errors({ ...EV_STAFF, ...IMG }) } });
  p({ method: 'put', path: '/admin/esports/events/{id}/stages', tags: ['esports-events'], summary: 'Link tournaments: qualifiers feeding invite-only finals (each link checked)', security: adminBearer,
    request: { ...evId, ...body(evS.stagesBody) },
    responses: { 200: json(evS.StageList), ...errors({ ...EV_STAFF, 409: ['EVENT_STATE', 'EVENT_TOURNAMENT_IN_OTHER_EVENT', 'EVENT_TOURNAMENT_STATE'], 422: ['EVENT_STAGES_INVALID', 'EVENT_TOURNAMENT_NOT_OURS', 'EVENT_FINAL_NOT_INVITE', 'EVENT_LINK_MISMATCH', 'EVENT_FINAL_SLOTS', 'EVENT_FINAL_MIN', 'EVENT_QUALIFY_GAP', 'VALIDATION_FAILED'] }) } });
  p({ method: 'post', path: '/admin/esports/events/{id}/publish', tags: ['esports-events'], summary: 'Publish (a published tournament must be linked)', security: adminBearer,
    request: evId, responses: { 200: json(evS.EventDraft), ...errors({ ...EV_STAFF, 409: ['EVENT_STATE', 'EVENT_NOT_PUBLISHABLE'] }) } });
  p({ method: 'post', path: '/admin/esports/events/{id}/cancel', tags: ['esports-events'], summary: 'Cancel the event (never its tournaments; refused while one runs)', security: adminBearer,
    request: { ...evId, ...body(evS.reasonBody) }, responses: { 200: json(evS.EventDraft), ...errors({ ...EV_STAFF, 409: ['EVENT_STATE', 'EVENT_TOURNAMENT_RUNNING'], ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/esports/events/{id}/qualifications', tags: ['esports-events'], summary: 'Every qualification with its reason', security: adminBearer, request: evId, responses: { 200: json(evS.QualificationList), ...errors(EV_STAFF) } });
  p({ method: 'post', path: '/admin/esports/events/{id}/qualifications', tags: ['esports-events'], summary: 'Invite a squad or a player into a final', security: adminBearer,
    request: { ...evId, ...body(evS.inviteBody) }, responses: { 201: json(evS.Qualification, 'Created'), ...errors({ ...EV_STAFF, 409: ['EVENT_STATE', 'EVENT_QUALIFICATION_STATE', 'EVENT_ALREADY_QUALIFIED'], 422: ['EVENT_INVITE_INVALID', 'VALIDATION_FAILED'] }) } });
  p({ method: 'post', path: '/admin/esports/events/{id}/qualifications/{qualificationId}/revoke', tags: ['esports-events'], summary: 'Withdraw a place not yet used', security: adminBearer,
    request: { params: evS.qualParam, ...body(evS.reasonBody) }, responses: { 200: json(evS.Qualification), ...errors({ ...EV_STAFF, 409: ['EVENT_QUALIFICATION_STATE'], ...VALIDATION }) } });
  p({ method: 'put', path: '/admin/esports/events/{id}/streams', tags: ['esports-events'], summary: 'The event broadcast links; a stream turning live alerts followers (cooldown)', security: adminBearer,
    request: { ...evId, ...body(evS.streamsBody) }, responses: { 200: json(evS.StreamList), ...errors({ ...EV_STAFF, 409: ['EVENT_STATE'], 422: ['STREAM_URL_INVALID', 'VALIDATION_FAILED'] }) } });
  p({ method: 'post', path: '/admin/esports/events/{id}/sponsors', tags: ['esports-events'], summary: 'Add a sponsor placement (no money in the app)', security: adminBearer,
    request: { ...evId, ...body(evS.sponsorBody) }, responses: { 201: json(evS.Sponsor, 'Created'), ...errors({ ...EV_STAFF, 409: ['EVENT_STATE', 'SPONSOR_LIMIT'], 422: ['SPONSOR_URL_INVALID', 'VALIDATION_FAILED'] }) } });
  p({ method: 'patch', path: '/admin/esports/events/{id}/sponsors/{sponsorId}', tags: ['esports-events'], summary: 'Change a sponsor', security: adminBearer,
    request: { params: evS.sponsorParam, ...body(evS.sponsorPatch) }, responses: { 200: json(evS.Sponsor), ...errors({ ...EV_STAFF, 422: ['SPONSOR_URL_INVALID', 'VALIDATION_FAILED'] }) } });
  p({ method: 'post', path: '/admin/esports/events/{id}/sponsors/{sponsorId}/remove', tags: ['esports-events'], summary: 'Remove a sponsor (kept, status removed)', security: adminBearer,
    request: { params: evS.sponsorParam }, responses: { 200: json(evS.Removed), ...errors(EV_STAFF) } });
  p({ method: 'post', path: '/admin/esports/events/{id}/sponsors/{sponsorId}/logo', tags: ['esports-events'], summary: 'Upload a sponsor logo (public bucket)', security: adminBearer,
    request: { params: evS.sponsorParam, body: evImage('The logo') }, responses: { 200: json(evS.Sponsor), ...errors({ ...EV_STAFF, ...IMG }) } });
  p({ method: 'post', path: '/admin/esports/events/{id}/polls', tags: ['esports-events'], summary: 'A draft poll', security: adminBearer,
    request: { ...evId, ...body(evS.pollBody) }, responses: { 201: json(evS.Poll, 'Created'), ...errors({ ...EV_STAFF, 409: ['EVENT_STATE'], 422: ['POLL_OPTIONS_INVALID', 'VALIDATION_FAILED'] }) } });
  p({ method: 'post', path: '/admin/esports/events/{id}/polls/{pollId}/open', tags: ['esports-events'], summary: 'Open a poll (the event must be published)', security: adminBearer,
    request: { params: evS.pollParam }, responses: { 200: json(evS.Poll), ...errors({ ...EV_STAFF, 409: ['POLL_STATE'] }) } });
  p({ method: 'post', path: '/admin/esports/events/{id}/polls/{pollId}/close', tags: ['esports-events'], summary: 'Close a poll', security: adminBearer,
    request: { params: evS.pollParam }, responses: { 200: json(evS.Poll), ...errors({ ...EV_STAFF, 409: ['POLL_STATE'] }) } });
  p({ method: 'post', path: '/admin/esports/events/{id}/feed', tags: ['esports-events'], summary: 'Post an announcement to the feed', security: adminBearer,
    request: { ...evId, ...body(evS.announceBody) }, responses: { 201: json(evS.Announcement, 'Created'), ...errors({ ...EV_STAFF, 409: ['EVENT_STATE'], ...VALIDATION }) } });

  // ------------------------------------------------------------------ M16 teams and players (step 1), and the M01 additions
  const tmId = { params: tmS.idParam };
  const TM = { ...COMMON_AUTH, 404: ['NOT_FOUND'] };
  const CAPT = { ...TM, 403: ['CAPTAIN_ONLY'], 409: ['TEAM_ARCHIVED'] };
  const tmImage = (description) => ({ description, content: { 'image/jpeg': { schema: z.string() }, 'image/png': { schema: z.string() }, 'image/webp': { schema: z.string() } } });
  p({ method: 'post', path: '/me/phone', tags: ['me'], summary: 'Add a phone to an account without a verified one (sends a code)', security: bearer,
    request: body(usersS.startPhone), responses: { 202: json(C.OtpSent, 'Accepted'), ...errors({ ...COMMON_AUTH, 409: ['PHONE_ALREADY_VERIFIED', 'PHONE_IN_USE'], 422: ['PHONE_INVALID', 'VALIDATION_FAILED'], 429: ['OTP_RATE_LIMITED', 'OTP_COOLDOWN', 'RATE_LIMITED'] }) } });
  p({ method: 'post', path: '/me/phone/verify', tags: ['me'], summary: 'Confirm the code: the phone becomes verified (user.phone_verified)', security: bearer,
    request: body(usersS.verifyPhone), responses: { 200: json(z.object({ phoneVerified: z.boolean() })), ...errors({ ...COMMON_AUTH, 400: ['OTP_INVALID', 'OTP_EXPIRED'], 409: ['PHONE_ALREADY_VERIFIED', 'PHONE_IN_USE'], 422: ['PHONE_INVALID', 'VALIDATION_FAILED'], ...RATE }) } });
  p({ method: 'put', path: '/me/gender', tags: ['me'], summary: 'Record my gender once (private; only men\'s and women\'s events read it)', security: bearer,
    request: body(usersS.setGender), responses: { 200: json(z.object({ gender: z.string() })), ...errors({ ...COMMON_AUTH, 409: ['GENDER_ALREADY_SET'], ...VALIDATION }) } });
  p({ method: 'put', path: '/admin/users/{id}/gender', tags: ['admin'], summary: 'Correct a member\'s gender (manage_users, with a reason)', security: adminBearer,
    request: { params: adminSS.idParam, ...body(adminSS.gender) }, responses: { 200: json(C.AdminUser), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'], ...VALIDATION }) } });
  p({ method: 'post', path: '/teams', tags: ['teams'], summary: 'Create a team (verified phone); I become its captain', security: bearer,
    request: body(tmS.createBody), responses: { 201: json(tmS.Team, 'Created'), ...errors({ ...COMMON_AUTH, 403: ['PHONE_REQUIRED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_BANNED'], 404: ['NOT_FOUND'], 409: ['TOO_MANY_TEAMS'], 422: ['TEAM_NAME_INVALID', 'TEAM_SHORT_CODE_INVALID', 'TEAM_SPORT_UNKNOWN', 'VALIDATION_FAILED'] }) } });
  p({ method: 'get', path: '/me/teams', tags: ['teams'], summary: 'My teams with my role', security: bearer, responses: { 200: json(tmS.TeamList), ...errors(COMMON_AUTH) } });
  p({ method: 'get', path: '/teams/{id}', tags: ['teams'], summary: 'A team I am in (members with the NID-verified boolean; invites for captains)', security: bearer, request: tmId, responses: { 200: json(tmS.Team), ...errors(TM) } });
  p({ method: 'patch', path: '/teams/{id}', tags: ['teams'], summary: 'Change the name, short code or home area (captain)', security: bearer,
    request: { ...tmId, ...body(tmS.updateBody) }, responses: { 200: json(tmS.Team), ...errors({ ...CAPT, 422: ['TEAM_NAME_INVALID', 'TEAM_SHORT_CODE_INVALID', 'VALIDATION_FAILED'] }) } });
  p({ method: 'post', path: '/teams/{id}/logo', tags: ['teams'], summary: 'Upload the team logo (captain; public bucket)', security: bearer,
    request: { ...tmId, body: tmImage('The logo') }, responses: { 200: json(tmS.Team), ...errors({ ...CAPT, 413: ['FILE_TOO_LARGE'], 415: ['FILE_TYPE_NOT_ALLOWED', 'FILE_TYPE_MISMATCH'], 422: ['FILE_EMPTY'] }) } });
  p({ method: 'post', path: '/teams/{id}/archive', tags: ['teams'], summary: 'Archive the team (captain)', security: bearer, request: tmId, responses: { 200: json(tmS.Team), ...errors(CAPT) } });
  p({ method: 'post', path: '/teams/{id}/leave', tags: ['teams'], summary: 'Leave (a captain hands over first; the last member archives the team)', security: bearer,
    request: tmId, responses: { 200: json(tmS.Left), ...errors({ ...TM, 409: ['CAPTAIN_MUST_HAND_OVER'] }) } });
  p({ method: 'post', path: '/teams/{id}/captain', tags: ['teams'], summary: 'Hand the captaincy to a member (captain)', security: bearer,
    request: { ...tmId, ...body(tmS.captainBody) }, responses: { 200: json(tmS.Team), ...errors({ ...CAPT, 404: ['NOT_FOUND', 'NOT_A_MEMBER'] }) } });
  p({ method: 'post', path: '/teams/{id}/members/{userId}/remove', tags: ['teams'], summary: 'Remove a member (captain or vice-captain; never the captain)', security: bearer,
    request: { params: tmS.memberParam }, responses: { 200: json(tmS.Team), ...errors({ ...TM, 403: ['CAPTAIN_ONLY'], 404: ['NOT_FOUND', 'NOT_A_MEMBER'], 409: ['CANNOT_REMOVE_CAPTAIN'] }) } });
  p({ method: 'put', path: '/teams/{id}/members/{userId}', tags: ['teams'], summary: 'Set a member\'s role (one vice-captain) or jersey number (captain)', security: bearer,
    request: { params: tmS.memberParam, ...body(tmS.memberBody) }, responses: { 200: json(tmS.Team), ...errors({ ...CAPT, 404: ['NOT_FOUND', 'NOT_A_MEMBER'], ...VALIDATION }) } });
  p({ method: 'post', path: '/teams/{id}/invites', tags: ['teams'], summary: 'Invite a phone: a share link always; members with an account also get it in-app and by SMS', security: bearer,
    request: { ...tmId, ...body(tmS.inviteBody) },
    responses: { 201: json(tmS.Invited, 'Created'), ...errors({ ...TM, 403: ['CAPTAIN_ONLY'], 409: ['TEAM_ARCHIVED', 'ALREADY_MEMBER', 'TEAM_FULL'], 422: ['PHONE_INVALID', 'INVITE_SELF', 'VALIDATION_FAILED'], ...RATE }) } });
  p({ method: 'post', path: '/teams/{id}/invites/{inviteId}/cancel', tags: ['teams'], summary: 'Cancel a pending invite', security: bearer,
    request: { params: tmS.inviteParam }, responses: { 200: json(tmS.Invite), ...errors({ ...TM, 403: ['CAPTAIN_ONLY'], 409: ['INVITE_STATE'] }) } });
  p({ method: 'post', path: '/teams/{id}/invites/{inviteId}/resend', tags: ['teams'], summary: 'Send again (new link, renewed expiry) after the cooldown', security: bearer,
    request: { params: tmS.inviteParam }, responses: { 200: json(tmS.Invited), ...errors({ ...TM, 403: ['CAPTAIN_ONLY'], 409: ['INVITE_STATE'], 429: ['INVITE_RESEND_TOO_SOON'] }) } });
  p({ method: 'get', path: '/me/team-invites', tags: ['teams'], summary: 'Invites sent to my verified phone', security: bearer, responses: { 200: json(tmS.MyInvites), ...errors(COMMON_AUTH) } });
  p({ method: 'post', path: '/me/team-invites/{id}/accept', tags: ['teams'], summary: 'Accept (verified phone; expiry, team size and my team count re-checked)', security: bearer,
    request: tmId, responses: { 200: json(tmS.Accepted), ...errors({ ...COMMON_AUTH, 403: ['PHONE_REQUIRED', 'ACCOUNT_INACTIVE'], 404: ['INVITE_NOT_YOURS'], 409: ['INVITE_STATE', 'INVITE_EXPIRED', 'TEAM_ARCHIVED', 'ALREADY_MEMBER', 'TEAM_FULL', 'TOO_MANY_TEAMS'] }) } });
  p({ method: 'post', path: '/me/team-invites/{id}/decline', tags: ['teams'], summary: 'Decline', security: bearer,
    request: tmId, responses: { 200: json(tmS.Archived), ...errors({ ...COMMON_AUTH, 404: ['INVITE_NOT_YOURS'], 409: ['INVITE_STATE'] }) } });
  p({ method: 'get', path: '/team-invites/{token}', tags: ['teams'], summary: 'What a share link opens: the team, sport, inviter\'s first name, the masked number', request: { params: tmS.tokenParam }, responses: { 200: json(tmS.InviteLink), ...errors({ 404: ['NOT_FOUND'] }) } });
  p({ method: 'get', path: '/me/player-profile', tags: ['players'], summary: 'My player profile', security: bearer, responses: { 200: json(tmS.Profile), ...errors(COMMON_AUTH) } });
  p({ method: 'put', path: '/me/player-profile', tags: ['players'], summary: 'Set my sports, positions, bio and visibility', security: bearer,
    request: body(tmS.profileBody), responses: { 200: json(tmS.Profile), ...errors({ ...COMMON_AUTH, 422: ['PROFILE_SPORTS_INVALID', 'VALIDATION_FAILED'] }) } });
  p({ method: 'get', path: '/players/{handle}', tags: ['players'], summary: 'A public player page (never DOB, age, gender or phone)', request: { params: tmS.handleParam }, responses: { 200: json(tmS.PublicPlayer), ...errors({ 404: ['NOT_FOUND'] }) } });
  p({ method: 'get', path: '/me/eligibility', tags: ['players'], summary: 'My readiness, and a preview against an event\'s age and gender rules (me only)', security: bearer,
    request: { query: tmS.eligibilityQuery }, responses: { 200: json(tmS.Eligibility), ...errors({ ...COMMON_AUTH, ...VALIDATION }) } });
  p({ method: 'get', path: '/admin/teams', tags: ['teams'], summary: 'Search teams (manage_users)', security: adminBearer, request: { query: tmS.adminQuery }, responses: { 200: json(tmS.TeamList), ...errors(ADMIN_AUTH) } });
  p({ method: 'get', path: '/admin/teams/{id}', tags: ['teams'], summary: 'A team with members (NID booleans) and invites (masked)', security: adminBearer, request: tmId, responses: { 200: json(tmS.AdminTeam), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'] }) } });
  p({ method: 'post', path: '/admin/teams/{id}/archive', tags: ['teams'], summary: 'Archive a team with a reason (e.g. an offensive name)', security: adminBearer,
    request: { ...tmId, ...body(tmS.reasonBody) }, responses: { 200: json(tmS.Archived), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'], 409: ['TEAM_ARCHIVED'], ...VALIDATION }) } });

  // ------------------------------------------------------------------ M14 tournaments (step 1) with M15 lite results
  const tParams = { params: toS.orgTournamentParam };
  const mParams = { params: toS.orgMatchParam };
  const rParams = { params: toS.orgRegParam };
  const TORG = { ...COMMON_AUTH, 404: ['NOT_FOUND'] };
  const TSTATE = { ...TORG, 409: ['TOURNAMENT_STATE', 'VERSION_CONFLICT'] };
  const T_INVALID = ['RULE_OUT_OF_RANGE', 'RULE_PRESET_UNKNOWN', 'RULE_UNKNOWN_FIELD', 'TIEBREAKER_INVALID', 'VENUE_INVALID', 'VALIDATION_FAILED'];
  const RESULT = ['RESULT_INVALID', 'KNOCKOUT_NEEDS_WINNER', 'VALIDATION_FAILED'];
  p({ method: 'get', path: '/catalog/sport-rules/{sportKey}', tags: ['catalog'], summary: 'A sport\'s rule fields, presets and allowed tiebreakers (M03, for the tournament wizard)', request: { params: toS.sportKeyParam }, responses: { 200: json(toS.SportRules), ...cached, ...errors({ 404: ['NOT_FOUND'] }) } });
  p({ method: 'get', path: '/org/{orgId}/sports/tournaments', tags: ['tournaments'], summary: 'My sports organisation\'s tournaments (organisation staff)', security: bearer,
    request: { params: orgS.orgParam, query: toS.listQuery }, responses: { 200: json(toS.TournamentList), ...errors(TORG) } });
  p({ method: 'post', path: '/org/{orgId}/sports/tournaments', tags: ['tournaments'], summary: 'A draft tournament; rules start from the sport\'s first preset', security: bearer,
    request: { params: orgS.orgParam, ...body(toS.createBody) }, responses: { 201: json(toS.Tournament, 'Created'), ...errors({ ...TORG, 422: ['SPORT_NOT_SUPPORTED', ...T_INVALID], ...RATE }) } });
  p({ method: 'get', path: '/org/{orgId}/sports/tournaments/{id}', tags: ['tournaments'], summary: 'A tournament in the console', security: bearer, request: tParams, responses: { 200: json(toS.Tournament), ...errors(TORG) } });
  p({ method: 'patch', path: '/org/{orgId}/sports/tournaments/{id}', tags: ['tournaments'], summary: 'Edit a draft; a running tournament takes cosmetic edits only; rules while unlocked (FR-07/09)', security: bearer,
    request: { ...tParams, ...body(toS.updateBody) }, responses: { 200: json(toS.Tournament), ...errors({ ...TORG, 409: ['TOURNAMENT_STATE', 'RULES_LOCKED', 'VERSION_CONFLICT', 'VENUE_IN_USE', 'NAME_TAKEN'], 422: T_INVALID, ...RATE }) } });
  p({ method: 'get', path: '/org/{orgId}/sports/tournaments/{id}/overview', tags: ['tournaments'], summary: 'KPIs, money from escrow and the setup checklist (§4.1)', security: bearer, request: tParams, responses: { 200: json(toS.Overview), ...errors(TORG) } });
  p({ method: 'post', path: '/org/{orgId}/sports/tournaments/{id}/submit', tags: ['tournaments'], summary: 'Send for staff review (M05 kind tournament) after the automatic checks (organisation admins)', security: bearer,
    request: tParams, responses: { 200: json(toS.Tournament), ...errors({ ...TSTATE, 422: ['TOURNAMENT_INCOMPLETE'] }) } });
  p({ method: 'post', path: '/org/{orgId}/sports/tournaments/{id}/cancel', tags: ['tournaments'], summary: 'Cancel with refunds (before the first result 100%, after it what is still held)', security: bearer,
    request: { ...tParams, ...body(toS.reasonBody) }, responses: { 200: json(toS.Tournament), ...errors({ ...TSTATE, 403: ['ORG_OWNER_ONLY'], ...VALIDATION }) } });
  p({ method: 'post', path: '/org/{orgId}/sports/tournaments/{id}/registration/close', tags: ['tournaments'], summary: 'Close registration now: unpaid places, offers and the reserve list lapse', security: bearer, request: tParams, responses: { 200: json(toS.Tournament), ...errors(TSTATE) } });
  p({ method: 'post', path: '/org/{orgId}/sports/tournaments/{id}/registration/extend', tags: ['tournaments'], summary: 'Reopen registration once, before fixtures (FR-14)', security: bearer,
    request: { ...tParams, ...body(toS.extendBody) }, responses: { 200: json(toS.Tournament), ...errors({ ...TORG, 409: ['EXTEND_NOT_ALLOWED'], 422: ['REGISTRATION_WINDOW_INVALID', 'REGISTRATION_CLOSES_TOO_LATE', 'VALIDATION_FAILED'] }) } });
  p({ method: 'post', path: '/org/{orgId}/sports/tournaments/{id}/rules/unlock', tags: ['tournaments'], summary: 'Unlock the rules with a reason (audited; they lock again after tournament.rules_relock_hours)', security: bearer,
    request: { ...tParams, ...body(toS.unlockBody) }, responses: { 200: json(toS.Tournament), ...errors({ ...TSTATE, ...VALIDATION }) } });
  p({ method: 'get', path: '/org/{orgId}/sports/tournaments/{id}/registrations', tags: ['tournaments'], summary: 'Registrations with squad readiness (names and NID booleans only)', security: bearer,
    request: { ...tParams, query: toS.regQuery }, responses: { 200: json(toS.OrgRegistrations), ...errors(TORG) } });
  p({ method: 'get', path: '/org/{orgId}/sports/tournaments/{id}/registrations.csv', tags: ['tournaments'], summary: 'Registrations as CSV for organisation admins (Round B2): team, status, fee, refund, dates, squad and eligibility counts; include=roster adds one row per player with the display name and NID verified yes/no. Never phones, emails or ids. At most analytics.export_sync_max_rows rows, counted against analytics.exports_per_hour, audited', security: bearer,
    request: { ...tParams, query: toS.regCsvQuery }, responses: { 200: csv, ...errors({ ...TORG, 422: ['VALIDATION_FAILED', 'EXPORT_TOO_LARGE'], 429: ['EXPORT_LIMIT'] }) } });
  p({ method: 'post', path: '/org/{orgId}/sports/registrations/{regId}/approve', tags: ['tournaments'], summary: 'Approve a team (a ready squad and a free place, under the tournament lock)', security: bearer,
    request: rParams, responses: { 200: json(toS.Decision), ...errors({ ...TORG, 409: ['REGISTRATION_STATE', 'CAPACITY_FULL', 'ROSTER_NOT_READY'] }) } });
  p({ method: 'post', path: '/org/{orgId}/sports/registrations/{regId}/reject', tags: ['tournaments'], summary: 'Reject with a reason: a 100% refund; the place goes to the next reserve team', security: bearer,
    request: { ...rParams, ...body(toS.reasonBody) }, responses: { 200: json(toS.Decision), ...errors({ ...TORG, 409: ['REGISTRATION_STATE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/org/{orgId}/sports/registrations/{regId}/remove', tags: ['tournaments'], summary: 'Remove an approved team (refund per §6.9; its matches become walkovers)', security: bearer,
    request: { ...rParams, ...body(toS.reasonBody) }, responses: { 200: json(toS.Decision), ...errors({ ...TORG, 409: ['REGISTRATION_STATE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/org/{orgId}/sports/registrations/{regId}/waive', tags: ['tournaments'], summary: 'Waive the entry fee (organisation admins, audited; no escrow)', security: bearer,
    request: { ...rParams, ...body(toS.reasonBody) }, responses: { 200: json(toS.Decision), ...errors({ ...TORG, 409: ['REGISTRATION_STATE'], ...VALIDATION }) } });
  p({ method: 'post', path: '/org/{orgId}/sports/tournaments/{id}/draw', tags: ['tournaments'], summary: 'Preview the draw (a random draw is made at confirm)', security: bearer,
    request: { ...tParams, ...body(toS.drawBody) },
    responses: { 200: json(toS.DrawPreview), ...errors({ ...TORG, 409: ['REGISTRATION_STILL_OPEN', 'PENDING_DECISIONS', 'NOT_ENOUGH_TEAMS', 'RESULTS_EXIST', 'TOURNAMENT_STATE'], 422: ['DRAW_INVALID', 'GROUPS_INVALID', 'QUALIFIERS_INVALID', 'KNOCKOUT_TOP_INVALID', 'VALIDATION_FAILED'] }) } });
  p({ method: 'post', path: '/org/{orgId}/sports/tournaments/{id}/draw/confirm', tags: ['tournaments'], summary: 'Confirm the draw: seeds, stages and groups; a random draw publishes its seed', security: bearer,
    request: { ...tParams, ...body(toS.drawBody) },
    responses: { 200: json(z.object({ draw: toS.Draw })), ...errors({ ...TORG, 409: ['REGISTRATION_STILL_OPEN', 'PENDING_DECISIONS', 'NOT_ENOUGH_TEAMS', 'RESULTS_EXIST', 'TOURNAMENT_STATE'], 422: ['DRAW_INVALID', 'GROUPS_INVALID', 'QUALIFIERS_INVALID', 'KNOCKOUT_TOP_INVALID', 'VALIDATION_FAILED'], ...RATE }) } });
  p({ method: 'get', path: '/org/{orgId}/sports/tournaments/{id}/fixtures', tags: ['tournaments'], summary: 'Every match (drafts too), the venues and the draw', security: bearer, request: tParams, responses: { 200: json(toS.Fixtures), ...errors(TORG) } });
  p({ method: 'post', path: '/org/{orgId}/sports/tournaments/{id}/fixtures/generate', tags: ['tournaments'], summary: 'Generate matches from the draw, optionally scheduled (§6.2–6.6); a dry run writes nothing', security: bearer,
    request: { ...tParams, ...body(toS.generateBody) }, responses: { 200: json(toS.Generated), ...errors({ ...TORG, 409: ['TOURNAMENT_STATE', 'RESULTS_EXIST', 'DRAW_NOT_CONFIRMED'], ...VALIDATION, ...RATE }) } });
  p({ method: 'post', path: '/org/{orgId}/sports/tournaments/{id}/fixtures/publish', tags: ['tournaments'], summary: 'Publish the fixtures (captains are told)', security: bearer, request: tParams, responses: { 200: json(z.object({ fixtures: toS.Fixtures })), ...errors({ ...TORG, 409: ['FIXTURES_MISSING'] }) } });
  p({ method: 'post', path: '/org/{orgId}/sports/tournaments/{id}/lots', tags: ['tournaments'], summary: 'Record a draw of lots for a tie nothing breaks (organisation admins, audited)', security: bearer,
    request: { ...tParams, ...body(toS.lotsBody) }, responses: { 200: json(z.object({ standings: z.array(toS.Table) })), ...errors({ ...TORG, 409: ['LOTS_NOT_NEEDED'], 422: ['LOTS_INVALID', 'VALIDATION_FAILED'] }) } });
  p({ method: 'patch', path: '/org/{orgId}/sports/matches/{matchId}', tags: ['tournaments'], summary: 'Move a match (time, venue, court) with clash checks (FR-18)', security: bearer,
    request: { ...mParams, ...body(toS.moveBody) }, responses: { 200: json(toS.Match), ...errors({ ...TORG, 409: ['MATCH_STATE', 'SCHEDULE_CLASH', 'VERSION_CONFLICT'], 422: ['VENUE_INVALID', 'VALIDATION_FAILED'], ...RATE }) } });
  p({ method: 'post', path: '/org/{orgId}/sports/matches/{matchId}/postpone', tags: ['tournaments'], summary: 'Postpone with a reason, optionally to a new time', security: bearer,
    request: { ...mParams, ...body(toS.postponeBody) }, responses: { 200: json(toS.Match), ...errors({ ...TORG, 409: ['MATCH_STATE', 'SCHEDULE_CLASH'], ...VALIDATION }) } });
  p({ method: 'post', path: '/org/{orgId}/sports/matches/{matchId}/walkover', tags: ['tournaments'], summary: 'Give the match to one team (organisation admins)', security: bearer,
    request: { ...mParams, ...body(toS.walkoverBody) }, responses: { 200: json(toS.Match), ...errors({ ...TORG, 409: ['MATCH_STATE', 'MATCH_TEAMS_UNKNOWN', 'RESULT_EXISTS'], ...VALIDATION }) } });
  p({ method: 'post', path: '/org/{orgId}/sports/matches/{matchId}/cancel', tags: ['tournaments'], summary: 'Cancel a match (no result; it no longer counts)', security: bearer,
    request: { ...mParams, ...body(toS.reasonBody) }, responses: { 200: json(toS.Match), ...errors({ ...TORG, 409: ['MATCH_STATE'], ...VALIDATION }) } });
  p({ method: 'put', path: '/org/{orgId}/sports/matches/{matchId}/result', tags: ['tournaments'], summary: 'Enter the final result (M15 lite): placeholders resolve, the first result releases tranche 1', security: bearer,
    request: { ...mParams, ...body(toS.resultBody) }, responses: { 200: json(toS.MatchResultView), ...errors({ ...TORG, 409: ['MATCH_STATE', 'MATCH_TEAMS_UNKNOWN', 'RESULT_EXISTS'], 422: RESULT, ...RATE }) } });
  p({ method: 'post', path: '/org/{orgId}/sports/matches/{matchId}/result/amend', tags: ['tournaments'], summary: 'Correct a result with a reason (organisation admins), unless a later match already used it', security: bearer,
    request: { ...mParams, ...body(toS.amendBody) }, responses: { 200: json(toS.MatchResultView), ...errors({ ...TORG, 409: ['NO_RESULT_YET', 'AMEND_BLOCKED'], 422: RESULT }) } });
  p({ method: 'get', path: '/tournaments', tags: ['tournaments'], summary: 'Discover tournaments (public statuses only)', request: { query: toS.publicQuery }, responses: { 200: json(toS.TournamentList), ...errors(VALIDATION) } });
  p({ method: 'get', path: '/tournaments/{slug}', tags: ['tournaments'], summary: 'The hub: facts, rules, fixtures, standings, teams (no DOB, gender or phone)', request: { params: toS.slugParam }, responses: { 200: json(toS.Hub), ...errors({ 404: ['NOT_FOUND'] }) } });
  p({ method: 'post', path: '/tournaments/{id}/registrations', tags: ['tournaments'], summary: 'Register my team with a squad (captain or vice-captain, NID member); pay into escrow or join the reserve list', security: bearer,
    request: { params: toS.idParam, headers: idem, ...body(toS.registerBody) },
    responses: {
      201: json(toS.MyRegistration, 'Created'),
      ...errors({ ...COMMON_AUTH, ...IDEM, 403: ['ROLE_REQUIRED', 'KYC_REQUIRED', 'PHONE_REQUIRED', 'NOT_TEAM_CAPTAIN'], 404: ['NOT_FOUND'], 409: ['REGISTRATION_NOT_YET_OPEN', 'REGISTRATION_CLOSED', 'TEAM_ALREADY_REGISTERED', 'TEAM_ARCHIVED', 'PLAYER_IN_OTHER_TEAM', 'IDEMPOTENCY_IN_PROGRESS'], 422: IDEM[422].concat('TEAM_SPORT_MISMATCH', 'SQUAD_TOO_SMALL', 'SQUAD_TOO_LARGE', 'PLAYER_NOT_IN_TEAM') }),
    } });
  p({ method: 'get', path: '/me/registrations', tags: ['tournaments'], summary: 'Registrations of the teams I captain or vice-captain', security: bearer, responses: { 200: json(toS.MyRegistrations), ...errors(COMMON_AUTH) } });
  p({ method: 'post', path: '/me/registrations/{id}/accept-offer', tags: ['tournaments'], summary: 'Take an offered reserve place (pay within the hold)', security: bearer,
    request: { params: toS.idParam, headers: idem }, responses: { 200: json(toS.MyRegistration), ...errors({ ...COMMON_AUTH, ...IDEM, 404: ['NOT_FOUND'], 409: ['REGISTRATION_STATE', 'IDEMPOTENCY_IN_PROGRESS'] }) } });
  p({ method: 'post', path: '/me/registrations/{id}/withdraw', tags: ['tournaments'], summary: 'Withdraw (refund per §6.9: 100% before close, 50% after, none after the first result)', security: bearer,
    request: { params: toS.idParam }, responses: { 200: json(toS.MyRegistration), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], 409: ['REGISTRATION_STATE'] }) } });
  p({ method: 'put', path: '/me/registrations/{id}/roster', tags: ['tournaments'], summary: 'Change the squad before it freezes (the first result)', security: bearer,
    request: { params: toS.idParam, ...body(toS.rosterBody) }, responses: { 200: json(toS.MyRegistration), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], 409: ['REGISTRATION_STATE', 'ROSTER_FROZEN', 'PLAYER_IN_OTHER_TEAM'], 422: ['SQUAD_TOO_SMALL', 'SQUAD_TOO_LARGE', 'PLAYER_NOT_IN_TEAM', 'VALIDATION_FAILED'] }) } });
  p({ method: 'get', path: '/admin/tournaments', tags: ['tournaments'], summary: 'All tournaments (approve_listings or manage_organisers)', security: adminBearer, request: { query: toS.adminQuery }, responses: { 200: json(toS.TournamentList), ...errors(ADMIN_AUTH) } });
  p({ method: 'get', path: '/admin/tournaments/{id}', tags: ['tournaments'], summary: 'A tournament with its registrations and escrow', security: adminBearer, request: { params: toS.idParam }, responses: { 200: json(toS.AdminTournament), ...errors({ ...ADMIN_AUTH, 404: ['NOT_FOUND'] }) } });
  p({ method: 'post', path: '/admin/tournaments/{id}/cancel', tags: ['tournaments'], summary: 'Cancel a tournament with refunds (masters, step-up escrow.manage)', security: adminBearer,
    request: { params: toS.idParam, ...body(toS.reasonBody) }, responses: { 200: json(toS.AdminTournament), ...errors({ ...ADMIN_AUTH, 403: ADMIN_AUTH[403].concat('STEP_UP_REQUIRED'), 404: ['NOT_FOUND'], 409: ['TOURNAMENT_STATE'], ...VALIDATION }) } });
}

function dateTimeOf() {
  return z.iso.datetime({ offset: true });
}

module.exports = { register };
