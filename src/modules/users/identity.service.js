'use strict';

const { User, OAuthIdentity, sequelize } = require('../../models');
const { E } = require('../../common/errors');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const otp = require('../auth/otp.service');
const google = require('../../providers/google');
const { AppError } = require('../../common/errors');
const authz = require('../auth/authz.service');
const { normalizePhone } = require('../../common/identifiers');

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
    await events.publish(transaction, { name: 'user.email_changed', aggregateType: 'user', aggregateId: user.id, payload: { userId: user.id }, actor: principal, req });
  });
  return { email, verified: true };
}

/**
 * M16: add a phone to an account that has no verified one (Google sign-ups). Step 1 sends an OTP to
 * the number (purpose phone_change_new; the OTP limits apply). Changing a verified phone is M01-FR-24.
 */
async function startPhoneAdd(principal, phone, req) {
  const { user } = principal;
  if (user.phone && user.phoneVerifiedAt) throw E.conflict('PHONE_ALREADY_VERIFIED', 'Your account already has a verified phone');
  const e164 = normalizePhone(phone);
  if (!e164) throw new AppError(422, 'PHONE_INVALID', 'Enter a Bangladeshi mobile number');
  const other = await User.findOne({ where: { phone: e164 } });
  if (other && other.id !== user.id) throw E.conflict('PHONE_IN_USE', 'This number is used by another account');
  const result = await otp.issue({ target: { type: 'phone', value: e164 }, purpose: 'phone_change_new', ip: req.ip, locale: user.locale });
  return { sent: true, ...result };
}

/** Step 2: the code proves the number; it becomes the verified phone (user.phone_verified). */
async function confirmPhoneAdd(principal, { phone, code }, req) {
  const e164 = normalizePhone(phone);
  if (!e164) throw new AppError(422, 'PHONE_INVALID', 'Enter a Bangladeshi mobile number');
  await otp.consume({ target: { type: 'phone', value: e164 }, purpose: 'phone_change_new', code });
  const { user } = principal;
  await sequelize.transaction(async (transaction) => {
    const other = await User.findOne({ where: { phone: e164 }, transaction, lock: transaction.LOCK.UPDATE });
    if (other && other.id !== user.id) throw E.conflict('PHONE_IN_USE', 'This number is used by another account');
    if (user.phone && user.phoneVerifiedAt) throw E.conflict('PHONE_ALREADY_VERIFIED', 'Your account already has a verified phone');
    await user.update({ phone: e164, phoneVerifiedAt: new Date() }, { transaction });
    await authz.bumpVersion(user.id, { transaction });
    await audit.record({ action: 'user.phone_added', actor: principal, entityType: 'user', entityId: user.id, req }, { transaction });
    await events.publish(transaction, { name: 'user.phone_verified', aggregateType: 'user', aggregateId: user.id, payload: { userId: user.id }, actor: principal, req });
  });
  return { phoneVerified: true };
}

/** M16 (Q27): the member declares their gender once (private; staff correct mistakes). */
async function setGender(principal, gender, req) {
  const { user } = principal;
  if (user.gender) throw E.conflict('GENDER_ALREADY_SET', 'Your gender is already recorded. Ask support to correct it.');
  await sequelize.transaction(async (transaction) => {
    await user.update({ gender, genderSource: 'self_declared' }, { transaction });
    await audit.record({ action: 'user.gender_declared', actor: principal, entityType: 'user', entityId: user.id, req }, { transaction });
    await events.publish(transaction, { name: 'user.identity_changed', aggregateType: 'user', aggregateId: user.id, payload: { userId: user.id, fields: ['gender'] }, actor: principal, req });
  });
  return { gender };
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

module.exports = { setUsername, startEmailChange, confirmEmailChange, startPhoneAdd, confirmPhoneAdd, setGender, linkGoogle, unlinkGoogle };
