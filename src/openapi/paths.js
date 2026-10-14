'use strict';

const { z } = require('zod');
const C = require('./components');
const authS = require('../modules/auth/auth.schemas');
const userS = require('../modules/users/users.schemas');
const adminS = require('../modules/admin/admin.schemas');
const settingsS = require('../modules/settings/settings.schemas');
const catalogS = require('../modules/catalog/catalog.schemas');

/**
 * Every route (M01, M03), registered with its request and response schemas and the stable error
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
  p({ method: 'patch', path: '/me', tags: ['me'], summary: 'Update profile', security: bearer, request: body(userS.updateProfile), responses: { 200: json(C.Me), ...errors({ ...COMMON_AUTH, ...VALIDATION }) } });
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
}

function dateTimeOf() {
  return z.iso.datetime({ offset: true });
}

module.exports = { register };
