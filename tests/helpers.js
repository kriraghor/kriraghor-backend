'use strict';

const request = require('supertest');
const { authenticator } = require('otplib');
const { createApp } = require('../src/app');
const models = require('../src/models');
const sms = require('../src/providers/sms');
const mail = require('../src/providers/email');
const { decrypt } = require('../src/common/crypto');

const app = createApp();
const api = () => request(app);
const P = '/api/v1';

const TABLES = ['oauth_identities', 'audit_logs', 'step_up_tokens', 'user_sanctions', 'staff_permissions', 'staff_members', 'otp_codes', 'sessions', 'user_roles', 'users'];

async function resetDb() {
  await models.sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of TABLES) await models.sequelize.query(`TRUNCATE TABLE \`${t}\``);
  await models.sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  sms.clear();
  mail.clear();
}

const lastEmailCode = (address) => mail.lastTo(address)?.text.match(/\b(\d{6})\b/)?.[1];

let phoneSeq = 0;
/** Unique valid BD numbers per test run. */
function nextPhone() {
  phoneSeq += 1;
  return `0171${String(1000000 + phoneSeq).slice(-7)}`;
}
const e164 = (local) => `+880${local.slice(1)}`;

function lastCode(local) {
  const msg = sms.lastTo(e164(local));
  return msg?.text.match(/\b(\d{6})\b/)?.[1];
}

/** Full OTP signup; returns { accessToken, cookie, user, phone }. */
async function signupUser({ name = 'Test Member', password, role, roleMeta, username } = {}) {
  const phone = nextPhone();
  await api().post(`${P}/auth/otp/send`).send({ target: phone, purpose: 'signup' }).expect(202);
  const v = await api().post(`${P}/auth/otp/verify`).send({ target: phone, purpose: 'signup', code: lastCode(phone) }).expect(200);
  const res = await api()
    .post(`${P}/auth/signup`)
    .send({ signupToken: v.body.signupToken, displayName: name, password, role, roleMeta, username })
    .expect(201);
  return { accessToken: res.body.accessToken, cookie: res.headers['set-cookie'], user: res.body.user, phone };
}

/** Make the member role active (KYC approved) directly in the DB. */
async function verifyMember(userId) {
  await models.UserRole.update({ status: 'active', activatedAt: new Date() }, { where: { userId, role: 'member' } });
  await models.User.update({ kycStatus: 'verified' }, { where: { id: userId } });
  await models.User.increment('authzVersion', { where: { id: userId } });
}

/** Current TOTP for a staff user. Clears the replay guard so tests can issue several codes per 30 s step. */
async function totpFor(userId) {
  const staff = await models.StaffMember.findOne({ where: { userId } });
  await staff.update({ totpLastStep: null });
  return authenticator.generate(decrypt(staff.totpSecretEnc));
}

/** Create a master via the same steps as the CLI, then complete OTP + TOTP enrolment. */
async function createSignedInMaster() {
  const phone = nextPhone();
  const user = await models.User.create({ phone: e164(phone), phoneVerifiedAt: new Date(), displayName: 'Ayesha Siddiqua' });
  for (const role of ['member', 'staff', 'master_admin']) await models.UserRole.create({ userId: user.id, role, status: 'active', activatedAt: new Date() });
  await models.StaffMember.create({ userId: user.id, employeeId: `KG-M-${phoneSeq}`, team: 'Platform', isMaster: true });
  return signInStaff(phone, user.id);
}

/** Move earlier OTPs for a number out of the resend-cooldown window (the 60 s rule itself is tested separately). */
async function allowResend(local) {
  await models.sequelize.query('UPDATE otp_codes SET created_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 11 MINUTE) WHERE target = ?', {
    replacements: [e164(local)],
  });
}

/** OTP sign-in for a staff account, enrolling TOTP if needed. */
async function signInStaff(phone, userId) {
  await allowResend(phone);
  await api().post(`${P}/auth/otp/send`).send({ target: phone, purpose: 'login' }).expect(202);
  const v = await api().post(`${P}/auth/otp/verify`).send({ target: phone, purpose: 'login', code: lastCode(phone) }).expect(200);
  let res;
  if (v.body.status === 'two_factor_setup_required') {
    await api().post(`${P}/auth/2fa/totp/setup`).send({ challengeToken: v.body.challengeToken }).expect(200);
    res = await api().post(`${P}/auth/2fa/totp/activate`).send({ challengeToken: v.body.challengeToken, code: await totpFor(userId) }).expect(200);
  } else {
    res = await api().post(`${P}/auth/2fa/totp/verify`).send({ challengeToken: v.body.challengeToken, code: await totpFor(userId) }).expect(200);
  }
  return { accessToken: res.body.accessToken, cookie: res.headers['set-cookie'], user: res.body.user, phone, userId };
}

async function stepUp(session, scope) {
  const res = await api()
    .post(`${P}/auth/step-up`)
    .set('Authorization', `Bearer ${session.accessToken}`)
    .send({ scope, code: await totpFor(session.userId ?? session.user.id) })
    .expect(200);
  return res.body.stepUpToken;
}

const bearer = (s) => ({ Authorization: `Bearer ${s.accessToken}` });

module.exports = { api, P, models, resetDb, nextPhone, e164, lastCode, lastEmailCode, mail, allowResend, signupUser, verifyMember, totpFor, createSignedInMaster, signInStaff, stepUp, bearer, sms };
