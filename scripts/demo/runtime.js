'use strict';
/* eslint-disable no-console -- a command-line tool: its output is the report */

/**
 * The demo seeder's runtime. It drives the real API in-process, the way tests/fixtures do, so every
 * route's validation, gate and service rule applies: the app listens on a random loopback port and
 * requests carry access tokens minted for demo accounts (no passwords, no OTP codes). Events are
 * relayed and consumed in-process (what the worker does), so moderation decisions, KYC approvals and
 * payment hooks take effect before the next step.
 *
 * Only demo accounts get sessions here, and every record the seeder makes is written to demo_records.
 */
const crypto = require('crypto');
const config = require('../../src/config');
const models = require('../../src/models');
const { createApp } = require('../../src/app');
const settings = require('../../src/modules/settings/settings.service');
const consumers = require('../../src/modules/events/events.consumers');
const relay = require('../../src/modules/events/events.relay');
const sessions = require('../../src/modules/auth/session.service');
const tokens = require('../../src/modules/auth/token.service');

const P = config.apiPrefix ?? '/api/v1';
const jobs = [];
let server;
let base;
let runId;
let profile;

async function boot(opts) {
  profile = opts.profile;
  runId = `demo-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${crypto.randomBytes(2).toString('hex')}`;
  await settings.load();
  require('../../src/modules/events/subscriptions').registerAll();
  consumers.useDispatcher((job) => {
    jobs.push(job);
    return Promise.resolve();
  });
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}${P}`;
  return { runId, profile };
}

async function shutdown() {
  if (server) await new Promise((resolve) => server.close(resolve));
  const { closeAllRedis } = (() => {
    try {
      return require('../../src/common/redis');
    } catch {
      return {};
    }
  })();
  if (closeAllRedis) await closeAllRedis().catch(() => {});
  try {
    const { closeQueues } = require('../../src/jobs/queues');
    if (closeQueues) await closeQueues().catch(() => {});
  } catch {
    /* no queues opened */
  }
  await models.sequelize.close();
}

/** Relay the outbox and run every consumer job in-process until nothing is left (what the worker does). */
async function drain(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await relay.relayOnce();
    const batch = jobs.splice(0, jobs.length);
    for (const job of batch) {
      await consumers.processConsume(job.data).catch((err) => console.warn(`  consumer ${job.data?.consumer ?? ''} failed: ${err.message}`));
    }
    if (!batch.length) break;
  }
}

// ---------------------------------------------------------------- actors and requests

/** An actor is a demo account with its own session; staff use the admin audience with 2FA marked done. */
async function actor(user, { staff = false } = {}) {
  const { session } = await sessions.create(user, null, { audience: staff ? 'admin' : 'api', twoFactorAt: staff ? new Date() : null });
  return { user, userId: user.id, sessionId: session.id, audience: staff ? 'admin' : 'api', staff };
}

async function tokenFor(a) {
  const u = await models.User.findByPk(a.userId, { attributes: ['authzVersion'] });
  return tokens.signAccess({ userId: a.userId, sessionId: a.sessionId, authzVersion: u.authzVersion, audience: a.audience }).accessToken;
}

/** A step-up token for a staff actor (what POST /auth/step-up issues after a TOTP code). */
async function stepUp(a, scope) {
  const { token, jti, expiresAt } = tokens.signSpecial('step_up', { scope, sid: a.sessionId }, a.userId);
  await models.StepUpToken.create({ jti, userId: a.userId, sessionId: a.sessionId, scope, expiresAt });
  return token;
}

class ApiError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} → ${status} ${body?.code ?? ''} ${body?.detail ?? body?.title ?? JSON.stringify(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Call the API as an actor (or anonymously with a = null). `raw` sends bytes with `contentType`.
 * Throws ApiError unless the status is 2xx or listed in `ok`.
 */
async function call(a, method, path, body, { raw, contentType, headers = {}, ok = [], idem } = {}) {
  const h = { ...headers };
  if (a) h.Authorization = `Bearer ${await tokenFor(a)}`;
  if (idem) h['Idempotency-Key'] = idem === true ? crypto.randomUUID() : idem;
  let payload;
  if (raw) {
    h['Content-Type'] = contentType;
    payload = raw;
  } else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { text };
  }
  if ((res.status < 200 || res.status >= 300) && !ok.includes(res.status)) throw new ApiError(method, path, res.status, json);
  return json;
}

const get = (a, path, opts) => call(a, 'GET', path, undefined, opts);
const post = (a, path, body, opts) => call(a, 'POST', path, body, opts);
const put = (a, path, body, opts) => call(a, 'PUT', path, body, opts);
const patch = (a, path, body, opts) => call(a, 'PATCH', path, body, opts);

// ---------------------------------------------------------------- demo bookkeeping

async function mark(entity, entityId, label) {
  await models.DemoRecord.findOrCreate({ where: { entity, entityId }, defaults: { runId, profile, label: label ? String(label).slice(0, 120) : null } });
}

async function marked(entity, label) {
  const row = await models.DemoRecord.findOne({ where: { entity, label } });
  return row?.entityId ?? null;
}

const log = (msg) => console.log(msg);

module.exports = { boot, shutdown, drain, actor, stepUp, call, get, post, put, patch, mark, marked, log, models, config, ApiError, get base() { return base; }, get runId() { return runId; }, get profile() { return profile; } };
