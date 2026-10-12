'use strict';

const { User, OAuthIdentity, sequelize } = require('../../models');
const { E } = require('../../common/errors');
const audit = require('../audit/audit.service');
const otp = require('../auth/otp.service');
const google = require('../../providers/google');

/** Set or change the username. */
async function setUsername(principal, username, req) {
  const { user } = principal;
  if (user.username === username) return { username };
  await sequelize.transaction(async (transaction) => {
    const taken = await User.findOne({ where: { username }, transaction });
    if (taken && taken.id !== user.id) throw E.conflict('USERNAME_TAKEN', 'That username is taken. Choose another one.');
    const before = user.username;
    await user.update({ username }, { transaction });
    await audit.record({ action: 'user.username_changed', actor: principal, entityType: 'user', entityId: user.id, before: { username: before }, after: { username }, req }, { transaction });
  });
  return { username };
}

/** Step 1 of adding/changing an email: send an OTP to the new address. */
async function startEmailChange(principal, email, req) {
  const { user } = principal;
  if (user.email === email && user.emailVerifiedAt) throw E.conflict('EMAIL_ALREADY_VERIFIED', 'This email is already verified on your account');
  const other = await User.findOne({ where: { email } });
  if (other && other.id !== user.id) throw E.conflict('EMAIL_IN_USE', 'This email is used by another account');
  const result = await otp.issue({ target: { type: 'email', value: email }, purpose: 'email_verify', ip: req.ip, locale: user.locale });
  return { sent: true, ...result };
}

/** Step 2: confirm the code; the email becomes a verified sign-in identifier. */
async function confirmEmailChange(principal, { email, code }, req) {
  await otp.consume({ target: { type: 'email', value: email }, purpose: 'email_verify', code });
  const { user } = principal;
  await sequelize.transaction(async (transaction) => {
    const other = await User.findOne({ where: { email }, transaction, lock: transaction.LOCK.UPDATE });
    if (other && other.id !== user.id) throw E.conflict('EMAIL_IN_USE', 'This email is used by another account');
    const before = user.email;
    await user.update({ email, emailVerifiedAt: new Date() }, { transaction });
    await audit.record({ action: 'user.email_changed', actor: principal, entityType: 'user', entityId: user.id, before: { email: before }, after: { email }, req }, { transaction });
  });
  return { email, verified: true };
}

/** Connect a Google account to the signed-in user (settings → "Connect Google"). */
async function linkGoogle(principal, idToken, req) {
  const profile = await google.verifyIdToken(idToken);
  const { user } = principal;
  return sequelize.transaction(async (transaction) => {
    const bySubject = await OAuthIdentity.findOne({ where: { provider: 'google', providerUserId: profile.subject }, transaction });
    if (bySubject && bySubject.userId !== user.id) throw E.conflict('GOOGLE_ALREADY_LINKED', 'This Google account is connected to another Kriraghor account');
    if (bySubject) return bySubject.toPublic();
    const mine = await OAuthIdentity.findOne({ where: { userId: user.id, provider: 'google' }, transaction });
    if (mine) throw E.conflict('GOOGLE_ALREADY_CONNECTED', 'Disconnect your current Google account first');

    const identity = await OAuthIdentity.create(
      { userId: user.id, provider: 'google', providerUserId: profile.subject, email: profile.email, emailVerified: profile.emailVerified, displayName: profile.name, pictureUrl: profile.picture, lastUsedAt: new Date() },
      { transaction }
    );
    // Adopt the Google email as the account email if the account has none and nobody else uses it.
    if (!user.email && profile.email && profile.emailVerified) {
      const other = await User.findOne({ where: { email: profile.email }, transaction });
      if (!other) await user.update({ email: profile.email, emailVerifiedAt: new Date() }, { transaction });
    }
    await audit.record({ action: 'user.identity_linked', actor: principal, entityType: 'user', entityId: user.id, meta: { provider: 'google' }, req }, { transaction });
    return identity.toPublic();
  });
}

/** Disconnect Google — only if another way to sign in remains. */
async function unlinkGoogle(principal, req) {
  const { user } = principal;
  return sequelize.transaction(async (transaction) => {
    const identity = await OAuthIdentity.findOne({ where: { userId: user.id, provider: 'google' }, transaction });
    if (!identity) throw E.notFound('Google connection');
    const hasOther = Boolean(user.phone) || Boolean(user.email && user.emailVerifiedAt) || Boolean(user.passwordHash && user.username);
    if (!hasOther) throw E.conflict('LAST_SIGN_IN_METHOD', 'Add a phone number, verified email or password first, so you can still sign in');
    await identity.destroy({ transaction });
    await audit.record({ action: 'user.identity_unlinked', actor: principal, entityType: 'user', entityId: user.id, meta: { provider: 'google' }, req }, { transaction });
  });
}

module.exports = { setUsername, startEmailChange, confirmEmailChange, linkGoogle, unlinkGoogle };
