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

/**
 * Every route (M01, M02, M03, M04, M06, M07, M08), registered with its request and response schemas and the stable error
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

  p({ method: 'get', path: '/me/verification', tags: ['kyc'], summary: 'My verification checklist: phone and NID status, badge, unlocks and limits (FR-18)', security: bearer,
    request: { query: kycS.verificationQuery }, responses: { 200: json(kycS.Verification), ...errors({ ...COMMON_AUTH, ...VALIDATION }) } });
  p({ method: 'post', path: '/me/documents/files', tags: ['kyc'], summary: 'Upload one NID image or PDF (raw body: image/jpeg, image/png or application/pdf; checked by its first bytes)', security: bearer,
    request: { query: kycS.uploadQuery, body: binary('The file itself, up to kyc.max_file_bytes') },
    responses: { 201: json(kycS.Uploaded, 'Created'), ...errors({ ...COMMON_AUTH, 413: ['FILE_TOO_LARGE', 'PAYLOAD_TOO_LARGE'], 415: ['FILE_TYPE_NOT_ALLOWED', 'FILE_TYPE_MISMATCH'], 422: ['VALIDATION_FAILED', 'FILE_EMPTY'], 429: ['UPLOAD_RATE_LIMITED'] }) } });
  p({ method: 'post', path: '/me/documents', tags: ['kyc'], summary: 'Submit my NID for review: number, date of birth, legal name and the three files (FR-05 to FR-07, FR-11)', security: bearer,
    request: body(kycS.submitBody),
    responses: { 201: json(kycS.Document, 'Created'), ...errors({ ...COMMON_AUTH, 409: ['PHONE_REQUIRED', 'DOC_ALREADY_APPROVED'], 422: ['VALIDATION_FAILED', 'NID_FORMAT_INVALID', 'DOB_INVALID', 'DOB_IN_FUTURE', 'UNDER_MIN_AGE', 'FILES_INCOMPLETE'] }) } });
  p({ method: 'get', path: '/me/documents/{id}/files/{fileId}', tags: ['kyc'], summary: 'View my own upload (no-store)', security: bearer,
    request: kycFileP, responses: { 200: binary('The file'), ...errors({ ...COMMON_AUTH, 404: ['NOT_FOUND'], 410: ['FILE_PURGED'], ...VALIDATION }) } });

  p({ method: 'get', path: '/admin/kyc/documents/{id}', tags: ['kyc'], summary: 'The document panel on the Moderation desk: legal name, DOB, masked number, checks, files and history', security: adminBearer,
    request: kycDocP, responses: { 200: json(kycS.Review), ...errors({ ...KYC_STAFF, 404: ['NOT_FOUND'], ...VALIDATION }) } });
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
}

function dateTimeOf() {
  return z.iso.datetime({ offset: true });
}

module.exports = { register };
