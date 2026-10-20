'use strict';

const { User, UserRole, StaffMember, StepUpToken, OAuthIdentity, sequelize } = require('../../models');
const google = require('../../providers/google');
const { E } = require('../../common/errors');
const { ROLES, SELF_SERVICE_ROLES } = require('../../common/enums');
const audit = require('../audit').audit;
const events = require('../events').events;
const otp = require('./otp.service');
const limits = require('./limits');
const passwords = require('./password');
const tokens = require('./token.service');
const sessions = require('./session.service');
const totp = require('./totp.service');
const authz = require('./authz.service');
const { AUDIENCES } = require('./access.service');

const findByIdentifier = (id) => User.findOne({ where: { [id.type]: id.value } });

function assertCanSignIn(user) {
  if (user.status === 'suspended') throw E.forbidden('ACCOUNT_SUSPENDED', 'Your account is suspended');
  if (user.status === 'banned') throw E.forbidden('ACCOUNT_BANNED', 'Your account has been closed by Kriraghor');
  if (user.status === 'closed') throw E.forbidden('ACCOUNT_CLOSED', 'This account was closed');
}

/** Issue the session and access token for a fully authenticated user. */
async function issueSession(user, req, { twoFactorAt = null, method, audience = AUDIENCES.API } = {}) {
  const { session, refreshToken } = await sequelize.transaction(async (transaction) => {
    const created = await sessions.create(user, req, { twoFactorAt, audience, transaction });
    await user.update({ lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null }, { transaction });
    await audit.record(
      { action: 'auth.signed_in', actor: { id: user.id }, entityType: 'session', entityId: created.session.id, meta: { method, audience }, req },
      { transaction }
    );
    return created;
  });
  const access = tokens.signAccess({ userId: user.id, sessionId: session.id, authzVersion: user.authzVersion, audience });
  const principal = await authz.loadPrincipal(user.id);
  return { status: 'signed_in', audience, ...access, refreshToken, sessionId: session.id, familyId: session.familyId, principal };
}

async function activeStaff(userId) {
  const staff = await StaffMember.findOne({ where: { userId } });
  return staff && staff.status !== 'offboarded' ? staff : null;
}

/**
 * After primary authentication (ADR-004, Q33: staff use separate accounts):
 *  - customer sign-in (audience "api") refuses staff accounts with STAFF_USE_ADMIN_PORTAL;
 *  - admin sign-in (audience "admin") refuses non-staff with NOT_STAFF, and always continues
 *    to the TOTP challenge (M01-FR-10). The challenge can only produce an admin session.
 */
async function completePrimaryAuth(user, req, method, audience = AUDIENCES.API) {
  assertCanSignIn(user);
  const staff = await activeStaff(user.id);
  if (audience === AUDIENCES.API) {
    if (staff) throw E.forbidden('STAFF_USE_ADMIN_PORTAL', 'Staff accounts sign in at the admin portal');
    return issueSession(user, req, { method });
  }
  if (!staff) throw E.forbidden('NOT_STAFF', 'This sign-in is for Kriraghor staff only');
  if (staff.status === 'suspended') throw E.forbidden('ACCOUNT_SUSPENDED', 'Your staff access is suspended');
  const next = staff.totpEnabledAt ? 'totp' : 'totp_setup';
  const { token, expiresAt } = tokens.signSpecial('mfa_challenge', { m: method }, user.id);
  return { status: next === 'totp' ? 'two_factor_required' : 'two_factor_setup_required', next, challengeToken: token, challengeExpiresAt: expiresAt };
}

// ---------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------

/** Always answers the same way regardless of whether the account exists (M01-FR-03). */
async function sendOtp({ target, purpose, locale }, req) {
  let deliver = true;
  if (purpose === 'reset') {
    const user = await findByIdentifier(target);
    deliver = Boolean(user && user.status === 'active');
  }
  // signup and login share behaviour: verify signs in an existing account or starts signup.
  const stored = purpose === 'login' ? 'signup' : purpose;
  const result = await otp.issue({ target, purpose: stored, ip: req.ip, locale, deliver });
  return { sent: true, ...result };
}

async function verifyOtp({ target, purpose, code }, req) {
  const stored = purpose === 'login' ? 'signup' : purpose;
  if (stored !== 'signup') throw E.badRequest('OTP_PURPOSE_INVALID', 'Use the password reset endpoint for reset codes');
  await otp.consume({ target, purpose: stored, code });

  const existing = await findByIdentifier(target);
  if (existing) {
    // Verified possession of the phone/email = sign in (non-enumerating signup).
    const verifiedField = target.type === 'phone' ? 'phoneVerifiedAt' : 'emailVerifiedAt';
    if (!existing[verifiedField]) {
      await sequelize.transaction(async (transaction) => {
        await existing.update({ [verifiedField]: new Date() }, { transaction });
        // M16: a phone verified for the first time can pick up team invites sent to it.
        if (target.type === 'phone') await events.publish(transaction, { name: 'user.phone_verified', aggregateType: 'user', aggregateId: existing.id, payload: { userId: existing.id } });
      });
    }
    return completePrimaryAuth(existing, req, 'otp');
  }
  const { token, expiresAt } = tokens.signSpecial('signup', { idt: target.type, idv: target.value }, 'signup');
  return { status: 'signup', signupToken: token, signupTokenExpiresAt: expiresAt };
}

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------

async function assertUsernameFree(username, transaction) {
  if (!username) return;
  const taken = await User.findOne({ where: { username }, transaction });
  if (taken) throw E.conflict('USERNAME_TAKEN', 'That username is taken. Choose another one.');
}

/**
 * Complete signup from a verified phone/email OTP or a verified Google identity.
 * Google claims: { idt:'google', gsub, gem, gev, gname, gpic }.
 */
async function signup({ signupToken, displayName, username, password, locale, role, roleMeta }, req) {
  const claims = tokens.verifySpecial('signup', signupToken);
  if (role && !SELF_SERVICE_ROLES.includes(role)) throw E.badRequest('ROLE_NOT_SELF_SERVICE', 'That role cannot be requested at signup');

  const viaGoogle = claims.idt === 'google';
  const target = viaGoogle ? (claims.gem && claims.gev ? { type: 'email', value: claims.gem } : null) : { type: claims.idt, value: claims.idv };
  if (password) await passwords.assertAcceptable(password, { identifiers: [target?.value, displayName, username] });
  const passwordHash = password ? await passwords.hash(password) : null;

  const user = await sequelize.transaction(async (transaction) => {
    // Another signup may have raced us with the same verified identifier.
    if (target) {
      const dup = await User.findOne({ where: { [target.type]: target.value }, transaction, lock: transaction.LOCK.UPDATE });
      if (dup) throw E.conflict('ACCOUNT_EXISTS', 'An account already exists. Sign in instead.');
    }
    if (viaGoogle && (await OAuthIdentity.findOne({ where: { provider: 'google', providerUserId: claims.gsub }, transaction }))) {
      throw E.conflict('ACCOUNT_EXISTS', 'This Google account is already registered. Sign in instead.');
    }
    await assertUsernameFree(username, transaction);

    const fields = { displayName, username: username ?? null, passwordHash, locale: locale ?? 'en' };
    if (target) {
      fields[target.type] = target.value;
      fields[target.type === 'phone' ? 'phoneVerifiedAt' : 'emailVerifiedAt'] = new Date();
    }
    if (viaGoogle && !target && !username) {
      // A Google account without a verified email must pick a username so it has a second identifier.
      throw E.validation([{ field: 'username', message: 'Choose a username for your account' }]);
    }
    const created = await User.create(fields, { transaction });
    if (viaGoogle) {
      await OAuthIdentity.create(
        { userId: created.id, provider: 'google', providerUserId: claims.gsub, email: claims.gem ?? null, emailVerified: Boolean(claims.gev), displayName: claims.gname ?? null, pictureUrl: claims.gpic ?? null, lastUsedAt: new Date() },
        { transaction }
      );
    }
    await UserRole.create({ userId: created.id, role: ROLES.MEMBER, status: 'applied' }, { transaction });
    if (role) await UserRole.create({ userId: created.id, role, status: 'applied', meta: roleMeta ?? null }, { transaction });

    await audit.record({ action: 'user.registered', actor: { id: created.id }, entityType: 'user', entityId: created.id, meta: { via: viaGoogle ? 'google' : target.type, role: role ?? null }, req }, { transaction });
    await events.publish(transaction, { name: 'user.registered', aggregateType: 'user', aggregateId: created.id, payload: { userId: created.id, roles: [ROLES.MEMBER, ...(role ? [role] : [])] }, actor: { id: created.id }, req });
    return created;
  });

  return issueSession(user, req, { method: viaGoogle ? 'google_signup' : 'signup' });
}

// ---------------------------------------------------------------------------
// Google sign-in
// ---------------------------------------------------------------------------

/**
 * "Sign in with Google": the frontend sends the Google ID token (credential).
 *  1. Known Google identity → sign in.
 *  2. Google email is verified and matches an account whose email is ALSO verified → link and sign in.
 *  3. Matches an account with an unverified email → refuse (prevents account takeover).
 *  4. Otherwise → signup token; the client finishes signup (name, role, optional username).
 * Staff/master still have to pass TOTP afterwards.
 */
async function signInWithGoogle({ idToken }, req) {
  const profile = await google.verifyIdToken(idToken);

  const identity = await OAuthIdentity.findOne({ where: { provider: 'google', providerUserId: profile.subject } });
  if (identity) {
    const user = await User.findByPk(identity.userId);
    await identity.update({ lastUsedAt: new Date(), email: profile.email, emailVerified: profile.emailVerified, pictureUrl: profile.picture });
    return completePrimaryAuth(user, req, 'google');
  }

  if (profile.email && profile.emailVerified) {
    const user = await User.findOne({ where: { email: profile.email } });
    if (user) {
      if (!user.emailVerifiedAt) {
        throw E.conflict('ACCOUNT_EXISTS_UNVERIFIED', 'An account with this email exists. Sign in with your phone or password, then connect Google in settings.');
      }
      assertCanSignIn(user);
      await sequelize.transaction(async (transaction) => {
        await OAuthIdentity.create(
          { userId: user.id, provider: 'google', providerUserId: profile.subject, email: profile.email, emailVerified: true, displayName: profile.name, pictureUrl: profile.picture, lastUsedAt: new Date() },
          { transaction }
        );
        await audit.record({ action: 'user.identity_linked', actor: { id: user.id }, entityType: 'user', entityId: user.id, meta: { provider: 'google', via: 'verified_email_match' }, req }, { transaction });
      });
      return completePrimaryAuth(user, req, 'google');
    }
  }

  const { token, expiresAt } = tokens.signSpecial(
    'signup',
    { idt: 'google', gsub: profile.subject, gem: profile.email, gev: profile.emailVerified, gname: profile.name, gpic: profile.picture },
    'signup'
  );
  return {
    status: 'signup',
    signupToken: token,
    signupTokenExpiresAt: expiresAt,
    suggested: { displayName: profile.name, email: profile.emailVerified ? profile.email : null, needsUsername: !(profile.email && profile.emailVerified) },
  };
}

// ---------------------------------------------------------------------------
// Password sign-in (with lockout) and reset
// ---------------------------------------------------------------------------

async function loginWithPassword({ identifier, password }, req, audience = AUDIENCES.API) {
  const user = await findByIdentifier(identifier);
  const generic = () => E.unauthorized('INVALID_CREDENTIALS', 'Wrong phone/email or password');

  if (!user || !user.passwordHash) {
    await passwords.dummyVerify(password);
    throw generic();
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const retryAfter = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
    throw E.tooMany('AUTH_LOCKED', 'Too many wrong passwords', 'Sign in with a code instead, or wait and try again.', { retryAfter });
  }
  const ok = await passwords.verify(user.passwordHash, password);
  if (!ok) {
    const count = user.failedLoginCount + 1;
    const lock = count >= limits.loginFailLimit();
    await user.update({
      failedLoginCount: lock ? 0 : count,
      lockedUntil: lock ? new Date(Date.now() + limits.loginLockMs()) : user.lockedUntil,
    });
    await audit.record({ action: lock ? 'auth.locked' : 'auth.sign_in_failed', actor: { id: user.id }, entityType: 'user', entityId: user.id, req });
    throw generic();
  }
  return completePrimaryAuth(user, req, 'password', audience);
}

/**
 * Admin portal sign-in (ADR-004): password, or a login OTP sent with POST /auth/otp/send.
 * Unknown accounts and non-staff both get NOT_STAFF, so the admin endpoint reveals nothing
 * beyond what the customer endpoints already do.
 */
async function adminLogin(body, req) {
  if (body.password) return loginWithPassword(body, req, AUDIENCES.ADMIN);
  await otp.consume({ target: body.target, purpose: 'signup', code: body.code });
  const user = await findByIdentifier(body.target);
  if (!user) throw E.forbidden('NOT_STAFF', 'This sign-in is for Kriraghor staff only');
  return completePrimaryAuth(user, req, 'otp', AUDIENCES.ADMIN);
}

async function resetPassword({ target, code, newPassword }, req) {
  const user = await findByIdentifier(target);
  // Consume first so attempts are counted even for unknown targets (no enumeration).
  await otp.consume({ target, purpose: 'reset', code });
  if (!user) throw E.badRequest('OTP_INVALID', 'That code is not right. Check it or request a new one.');
  assertCanSignIn(user);
  await passwords.assertAcceptable(newPassword, { identifiers: [user.phone, user.email, user.displayName] });
  const passwordHash = await passwords.hash(newPassword);

  await sequelize.transaction(async (transaction) => {
    await user.update({ passwordHash, failedLoginCount: 0, lockedUntil: null }, { transaction });
    await sessions.revokeAllForUser(user.id, 'password_change', { transaction });
    await audit.record({ action: 'user.password_reset', actor: { id: user.id }, entityType: 'user', entityId: user.id, req }, { transaction });
    // Tell the owner on every channel, so a reset they didn't ask for is noticed (M01 §password).
    await events.publish(transaction, { name: 'user.password_changed', aggregateType: 'user', aggregateId: user.id, payload: { userId: user.id, via: 'reset', at: new Date().toISOString() }, actor: { id: user.id }, req });
  });
  return { reset: true };
}

// ---------------------------------------------------------------------------
// Staff two-factor (TOTP)
// ---------------------------------------------------------------------------

async function loadChallenge(challengeToken) {
  const claims = tokens.verifySpecial('mfa_challenge', challengeToken);
  const user = await User.findByPk(claims.sub);
  if (!user) throw E.unauthorized('CHALLENGE_INVALID', 'Your sign-in attempt expired. Sign in again.');
  assertCanSignIn(user);
  const staff = await StaffMember.findOne({ where: { userId: user.id } });
  if (!staff || staff.status === 'offboarded') throw E.unauthorized('CHALLENGE_INVALID', 'Your sign-in attempt expired. Sign in again.');
  return { user, staff, method: claims.m };
}

/** Step 1 of enrolment: returns a fresh secret (not active until a code is confirmed). */
async function totpSetup({ challengeToken }, req) {
  const { user, staff } = await loadChallenge(challengeToken);
  if (staff.totpEnabledAt) throw E.conflict('TWO_FACTOR_ALREADY_ENABLED', 'Two-factor sign-in is already set up');
  const label = user.email || user.phone;
  const { secretEnc, otpauthUrl, secret } = totp.createSecret(label);
  await staff.update({ totpSecretEnc: secretEnc });
  await audit.record({ action: 'staff.totp_setup_started', actor: { id: user.id }, entityType: 'staff_member', entityId: staff.id, req });
  return { secret, otpauthUrl };
}

async function totpActivate({ challengeToken, code }, req) {
  const { user, staff, method } = await loadChallenge(challengeToken);
  if (staff.totpEnabledAt) throw E.conflict('TWO_FACTOR_ALREADY_ENABLED', 'Two-factor sign-in is already set up');
  const step = totp.verifyCode(staff, code);
  await sequelize.transaction(async (transaction) => {
    await staff.update({ totpEnabledAt: new Date(), totpLastStep: step, status: staff.status === 'invited' ? 'active' : staff.status }, { transaction });
    await authz.bumpVersion(user.id, { transaction });
    const firstActivation = staff.status === 'invited';
    await audit.record({ action: 'staff.totp_enabled', actor: { id: user.id }, entityType: 'staff_member', entityId: staff.id, req }, { transaction });
    if (firstActivation) await events.publish(transaction, { name: 'staff.activated', aggregateType: 'user', aggregateId: user.id, payload: { userId: user.id }, actor: { id: user.id }, req });
  });
  await user.reload();
  return issueSession(user, req, { twoFactorAt: new Date(), method: `${method}+totp`, audience: AUDIENCES.ADMIN });
}

async function totpVerify({ challengeToken, code }, req) {
  const { user, staff, method } = await loadChallenge(challengeToken);
  if (!staff.totpEnabledAt) throw E.forbidden('TWO_FACTOR_REQUIRED', 'Set up two-factor sign-in first');
  let step;
  try {
    step = totp.verifyCode(staff, code);
  } catch (err) {
    await audit.record({ action: 'auth.totp_failed', actor: { id: user.id }, entityType: 'staff_member', entityId: staff.id, req });
    throw err;
  }
  await staff.update({ totpLastStep: step });
  return issueSession(user, req, { twoFactorAt: new Date(), method: `${method}+totp`, audience: AUDIENCES.ADMIN });
}

// ---------------------------------------------------------------------------
// Step-up (single-use, scope-bound). WebAuthn replaces TOTP here in a later iteration.
// ---------------------------------------------------------------------------

// esports.money (Q128): cancelling an esports tournament with refunds and finalising prizes (M21 §3).
// escrow.manage (M06): manual escrow release, freeze and unfreeze.
const STEP_UP_SCOPES = ['settings.write', 'staff.write', 'payout.approve', 'refund.large', 'user.ban', 'audit.export', 'twofa.reset', 'esports.money', 'events.replay', 'escrow.manage', 'moderation.override', 'risk.manage'];

async function stepUp(principal, sessionId, { scope, code }, req) {
  if (!STEP_UP_SCOPES.includes(scope)) throw E.badRequest('STEP_UP_SCOPE_INVALID', 'Unknown step-up scope');
  if (!principal.isStaff || !principal.staff?.totpEnabledAt) throw E.forbidden('TWO_FACTOR_REQUIRED', 'Two-factor sign-in is required');
  let step;
  try {
    step = totp.verifyCode(principal.staff, code);
  } catch (err) {
    await audit.record({ action: 'auth.step_up_failed', actor: principal, meta: { scope }, req });
    throw err;
  }
  await principal.staff.update({ totpLastStep: step });
  const { token, jti, expiresAt } = tokens.signSpecial('step_up', { scope, sid: sessionId }, principal.id);
  await StepUpToken.create({ jti, userId: principal.id, sessionId, scope, expiresAt });
  await audit.record({ action: 'auth.step_up_granted', actor: principal, meta: { scope }, req });
  return { stepUpToken: token, scope, expiresAt };
}

/** Atomically consume a step-up token for `scope` (used by the requireStepUp middleware). */
async function consumeStepUp(token, { principal, sessionId, scope }) {
  if (!token) throw E.forbidden('STEP_UP_REQUIRED', 'Confirm it is you to continue', undefined, { scope });
  const claims = tokens.verifySpecial('step_up', token);
  if (claims.sub !== principal.id || claims.sid !== sessionId || claims.scope !== scope) {
    throw E.forbidden('STEP_UP_REQUIRED', 'Confirm it is you to continue', undefined, { scope });
  }
  const [used] = await StepUpToken.update({ usedAt: new Date() }, { where: { jti: claims.jti, usedAt: null } });
  if (used !== 1) throw E.forbidden('STEP_UP_REQUIRED', 'This confirmation was already used', undefined, { scope });
}

// ---------------------------------------------------------------------------
// Refresh / logout
// ---------------------------------------------------------------------------

async function refresh(refreshToken, req, audience = AUDIENCES.API) {
  const { session, refreshToken: next } = await sessions.rotate(refreshToken, req, { audience });
  const user = await User.findByPk(session.userId);
  assertCanSignIn(user);
  // A member promoted to staff keeps no customer session (Q33); a removed staff member keeps no admin session.
  const staff = await activeStaff(user.id);
  if (audience === AUDIENCES.API && staff) {
    await sessions.revokeFamilyOf(session.id, 'permission_change');
    throw E.forbidden('STAFF_USE_ADMIN_PORTAL', 'Staff accounts sign in at the admin portal');
  }
  if (audience === AUDIENCES.ADMIN && !staff) {
    await sessions.revokeFamilyOf(session.id, 'permission_change');
    throw E.forbidden('NOT_STAFF', 'This sign-in is for Kriraghor staff only');
  }
  const access = tokens.signAccess({ userId: user.id, sessionId: session.id, authzVersion: user.authzVersion, audience });
  return { ...access, refreshToken: next, familyId: session.familyId, audience };
}

async function logout(principal, sessionId, req, { all = false } = {}) {
  await sequelize.transaction(async (transaction) => {
    if (all) await sessions.revokeAllForUser(principal.id, 'logout', { transaction });
    else await sessions.revokeFamilyOf(sessionId, 'logout', { transaction });
    await audit.record({ action: all ? 'auth.signed_out_everywhere' : 'auth.signed_out', actor: principal, entityType: 'session', entityId: sessionId, req }, { transaction });
  });
}

module.exports = {
  signInWithGoogle,
  assertUsernameFree,
  sendOtp,
  verifyOtp,
  signup,
  loginWithPassword,
  adminLogin,
  resetPassword,
  totpSetup,
  totpActivate,
  totpVerify,
  stepUp,
  consumeStepUp,
  refresh,
  logout,
  STEP_UP_SCOPES,
};
