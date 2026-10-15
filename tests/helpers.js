'use strict';

const request = require('supertest');
const { authenticator } = require('otplib');
const { createApp } = require('../src/app');
const models = require('../src/models');
const sms = require('../src/providers/sms');
const mail = require('../src/providers/email');
const { decrypt } = require('../src/common/crypto');
const settings = require('../src/modules/settings/settings.service');
const { seedReference } = require('../src/db/seed');
const events = require('../src/modules/events/events.service');
const consumers = require('../src/modules/events/events.consumers');

const app = createApp();
const api = () => request(app);
const P = '/api/v1';

// M03 tables are reseeded after the truncate, so every test starts from the seeded settings and catalogue.
const TABLES = ['consumed_events', 'outbox_events', 'audit_chain', 'audit_exports', 'settings_history', 'settings_change_requests', 'platform_settings', 'esports_points_presets', 'esports_maps', 'esports_modes', 'esports_games', 'oauth_identities', 'audit_logs', 'step_up_tokens', 'user_sanctions', 'staff_permissions', 'staff_members', 'otp_codes', 'sessions', 'user_roles', 'users'];

async function resetDb() {
  await models.sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of TABLES) await models.sequelize.query(`TRUNCATE TABLE \`${t}\``);
  await models.sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  await seedReference();
  await settings.load();
  // All tests run from one IP; the per-IP OTP cap (auth.otp_sends_per_ip_hour) is tested on its own.
  await setSettingForTest('auth.otp_sends_per_ip_hour', 100000);
  sms.clear();
  mail.clear();
  events.clearRecorded();
  consumers.takeTestJobs();
}

/**
 * Test-only: write a setting directly (no change request, no history) and reload the cache.
 * Production changes always go through POST /admin/settings/change-requests.
 */
async function setSettingForTest(key, value) {
  await models.PlatformSetting.update({ value }, { where: { key } });
  await settings.load();
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

/** A second master (four-eyes approver), signed in to the admin portal. */
const createSecondMaster = () => createSignedInMaster();

/** Move earlier OTPs for a number out of the resend-cooldown window (the 60 s rule itself is tested separately). */
async function allowResend(local) {
  await models.sequelize.query('UPDATE otp_codes SET created_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 11 MINUTE) WHERE target = ?', {
    replacements: [e164(local)],
  });
}

// ADR-004 origins used by the tests (see tests/env.js).
const ADMIN_ORIGIN = 'http://localhost:3002';
const WEB_ORIGIN = 'http://localhost:3000';
/** POST from the admin portal origin. */
const adminPost = (path) => api().post(`${P}${path}`).set('Origin', ADMIN_ORIGIN);

/** Admin portal sign-in for a staff account (login OTP, then TOTP), enrolling TOTP if needed. */
async function signInStaff(phone, userId) {
  await allowResend(phone);
  await api().post(`${P}/auth/otp/send`).send({ target: phone, purpose: 'login' }).expect(202);
  const v = await adminPost('/auth/admin/login').send({ target: phone, code: lastCode(phone) }).expect(200);
  let res;
  if (v.body.status === 'two_factor_setup_required') {
    await adminPost('/auth/2fa/totp/setup').send({ challengeToken: v.body.challengeToken }).expect(200);
    res = await adminPost('/auth/2fa/totp/activate').send({ challengeToken: v.body.challengeToken, code: await totpFor(userId) }).expect(200);
  } else {
    res = await adminPost('/auth/2fa/totp/verify').send({ challengeToken: v.body.challengeToken, code: await totpFor(userId) }).expect(200);
  }
  return { accessToken: res.body.accessToken, cookie: res.headers['set-cookie'], user: res.body.user, phone, userId };
}

/** Value of one cookie from Set-Cookie lines. */
function cookieValue(setCookie, name) {
  const line = (setCookie || []).find((c) => c.startsWith(`${name}=`));
  return line ? decodeURIComponent(line.split(';')[0].slice(name.length + 1)) : undefined;
}

/** A Cookie request header built from Set-Cookie lines (cleared cookies are dropped). */
const cookieHeader = (setCookie) =>
  (setCookie || [])
    .map((c) => c.split(';')[0])
    .filter((c) => !c.endsWith('='))
    .join('; ');

/**
 * Browser-style refresh (ADR-004): the cookies from an earlier response, an allowed Origin
 * and X-CSRF-Token copied from the readable CSRF cookie. Pass admin: true for the admin portal.
 */
function refreshWeb(setCookie, { admin = false, origin } = {}) {
  const csrfName = admin ? 'kg_acsrf' : 'kg_csrf';
  return api()
    .post(`${P}/auth/${admin ? 'admin/refresh' : 'refresh'}`)
    .set('Origin', origin ?? (admin ? ADMIN_ORIGIN : WEB_ORIGIN))
    .set('Cookie', cookieHeader(setCookie))
    .set('X-CSRF-Token', cookieValue(setCookie, csrfName) ?? '');
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

module.exports = { ADMIN_ORIGIN, WEB_ORIGIN, adminPost, cookieValue, cookieHeader, refreshWeb, api, P, models, resetDb, nextPhone, e164, lastCode, lastEmailCode, mail, allowResend, signupUser, verifyMember, totpFor, createSignedInMaster, createSecondMaster, signInStaff, stepUp, bearer, sms, settings, setSettingForTest, events, consumers };
