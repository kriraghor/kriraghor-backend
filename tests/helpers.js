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
const notify = require('../src/modules/notifications/notify.service');
const notifyTemplates = require('../src/modules/notifications/notify.templates');
const realtime = require('../src/modules/notifications/notify.realtime');
const paymentJobs = require('../src/modules/payments/payments.jobs');
const simulator = require('../src/providers/payments/sslcommerz.simulator');
const { createRedis } = require('../src/common/redis');
const config = require('../src/config');

const app = createApp();
const api = () => request(app);
const P = '/api/v1';

// The simulator's IPN goes straight into the app (no network in tests).
simulator.setIpnSender((_url, body) => request(app).post(`${P}/webhooks/sslcommerz`).type('form').send(body).then((r) => r.status));

// M03 tables are reseeded after the truncate, so every test starts from the seeded settings and catalogue.
const TABLES = ['esports_rankings', 'esports_ranking_entries', 'esports_streams', 'esports_prize_shares', 'esports_prize_awards', 'esports_standings', 'esports_disqualifications', 'esports_result_disputes', 'esports_result_evidence', 'esports_result_players', 'esports_results', 'esports_credential_views', 'esports_room_credentials', 'esports_checkins', 'esports_registration_players', 'esports_registrations', 'esports_matches', 'esports_stages', 'esports_prize_places', 'esports_tournaments', 'esports_squad_members', 'esports_squads', 'esports_uid_bans', 'esports_game_profiles', 'review_claims', 'submission_checks', 'submissions', 'review_rubrics', 'rejection_reasons', 'document_files', 'verification_documents', 'document_requirements', 'payout_reveals', 'payout_approvals', 'payout_holds', 'payout_items', 'payouts', 'payout_batches', 'payout_accounts', 'reconciliation_items', 'reconciliation_runs', 'ledger_entries', 'ledger_transactions', 'ledger_accounts', 'escrow_holds', 'refunds', 'provider_webhook_events', 'payment_attempts', 'payments', 'idempotency_keys', 'id_sequences', 'sms_log', 'notification_deliveries', 'notifications', 'notification_prefs', 'message_templates', 'consumed_events', 'outbox_events', 'audit_chain', 'audit_exports', 'settings_history', 'settings_change_requests', 'platform_settings', 'esports_points_presets', 'esports_maps', 'esports_modes', 'esports_games', 'oauth_identities', 'audit_logs', 'step_up_tokens', 'user_sanctions', 'staff_permissions', 'staff_members', 'otp_codes', 'sessions', 'user_roles', 'users'];

async function resetDb() {
  // One statement: CASCADE covers foreign keys, RESTART IDENTITY resets bigserial ids (TRUNCATE fires no row triggers).
  await models.sequelize.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await seedReference();
  await settings.load();
  // All tests run from one IP; the per-IP OTP cap (auth.otp_sends_per_ip_hour) is tested on its own.
  await setSettingForTest('auth.otp_sends_per_ip_hour', 100000);
  // No quiet window (start = end), so SMS and email go out at any hour the suite runs; the quiet-hours
  // test sets its own window around the current time.
  await setSettingForTest('notify.quiet_hours_start', '00:00');
  await setSettingForTest('notify.quiet_hours_end', '00:00');
  sms.clear();
  mail.clear();
  events.clearRecorded();
  consumers.takeTestJobs();
  notify.takeTestJobs();
  notifyTemplates.reset();
  realtime.clearEmitted();
  paymentJobs.takeTestJobs();
  await clearSimulator();
}

/**
 * Drop the simulator's Redis state (sessions, refunds, controls). Uses its own short-lived connection,
 * so test files that never touch Redis do not keep the shared one open (Jest would not exit).
 */
async function clearSimulator() {
  const redis = createRedis('test-sim-clear');
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${config.redis.prefix}:sslsim:*`, 'COUNT', 500);
      if (keys.length) await redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  } finally {
    await redis.quit();
  }
}

/**
 * Pay a payment as its payer through the simulator: start an attempt (Idempotency-Key), choose the
 * outcome on the gateway page (the IPN is delivered unless the outcome loses it), then follow the
 * browser back through the return URL. Returns { attempt, returnTo }.
 */
async function payWithSimulator(member, paymentId, { method = 'bkash', outcome = 'success', key } = {}) {
  const attempt = await api()
    .post(`${P}/payments/${paymentId}/attempts`)
    .set(bearer(member))
    .set('Idempotency-Key', key ?? `att-${paymentId.slice(0, 8)}-${Math.random().toString(36).slice(2, 10)}`)
    .send({ method })
    .expect(201);
  const sessionkey = attempt.body.redirectUrl.split('/').pop();
  const back = new URL(await simulator.pay(sessionkey, outcome));
  const ret = await api().get(`${P}/payments/return/sslcommerz${back.search}`).expect(303);
  return { attempt: attempt.body, returnTo: ret.headers.location };
}

/** Run collected payments jobs (polls, refund processing) until none are left. */
async function drainPaymentJobs({ rounds = 10 } = {}) {
  const { byName } = require('../src/jobs/definitions');
  const ran = [];
  for (let i = 0; i < rounds; i += 1) {
    const jobs = paymentJobs.takeTestJobs();
    if (!jobs.length) break;
    for (const j of jobs) ran.push({ name: j.name, result: await byName.get(j.name).run(j.data).catch((err) => ({ error: err.message })) });
  }
  return ran;
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

/**
 * Run what the worker would: relay the outbox, deliver every queued consumer job, then every queued
 * notification delivery, until nothing is left. Returns the notification delivery results.
 */
async function drainEvents({ rounds = 5 } = {}) {
  const relay = require('../src/modules/events/events.relay');
  const results = [];
  for (let i = 0; i < rounds; i += 1) {
    await relay.relayOnce();
    const jobs = consumers.takeTestJobs();
    for (const job of jobs) await consumers.processConsume(job.data).catch(() => {});
    const deliveries = notify.takeTestJobs();
    for (const d of deliveries) results.push(await notify.deliver(d.data).catch((err) => ({ error: err.message })));
    if (!jobs.length && !deliveries.length) break;
  }
  return results;
}

/** A second master (four-eyes approver), signed in to the admin portal. */
const createSecondMaster = () => createSignedInMaster();

/** Move earlier OTPs for a number out of the resend-cooldown window (the 60 s rule itself is tested separately). */
async function allowResend(local) {
  await models.sequelize.query("UPDATE otp_codes SET created_at = clock_timestamp() - interval '11 minutes' WHERE target = ?", {
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

module.exports = { ADMIN_ORIGIN, WEB_ORIGIN, adminPost, cookieValue, cookieHeader, refreshWeb, api, P, models, resetDb, nextPhone, e164, lastCode, lastEmailCode, mail, allowResend, signupUser, verifyMember, totpFor, createSignedInMaster, createSecondMaster, signInStaff, stepUp, bearer, sms, settings, setSettingForTest, events, consumers, notify, realtime, drainEvents, simulator, paymentJobs, payWithSimulator, drainPaymentJobs, clearSimulator };
