'use strict';

/**
 * Unattended M01 forgot-password run with the Postman CLI (folder "2b"; the other M01 folders need
 * real OTP and authenticator codes and are run by hand, see M01-acceptance-checklist.md).
 *   node postman/run-m01.js
 *
 * Uses the kriraghor_test database (reset): signs up a member with a password and serves
 * {{controlUrl}}, a local test-only control: /otp reads the last code sent to a phone, /settle drains
 * events so the PASSWORD_CHANGED alert exists. Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-auth.postman_collection.json');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function main() {
  const migrate = spawnSync(process.execPath, ['scripts/release.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' } });
  if (migrate.status !== 0) throw new Error('migrate + seed failed');
  const port = await freePort();
  process.env.API_PUBLIC_URL = `http://127.0.0.1:${port}`;

  const h = require('../tests/helpers');
  const { closeAllRedis } = require('../src/common/redis');
  const { models } = h;

  await h.resetDb();
  const member = await h.signupUser({ name: 'Fahim Rahman', password: 'Turf-Booking-2026' });

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  const steps = {
    otp: async (q) => ({ code: h.lastCode(q.get('phone')) }),
    settle: async () => {
      await h.drainEvents();
      return {};
    },
  };
  const control = http.createServer((rq, rs) => {
    const u = new URL(rq.url, 'http://127.0.0.1');
    const step = steps[u.pathname.slice(1)];
    const reply = (code, body) => rs.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (rq.method !== 'POST' || !step) return reply(404, { error: 'unknown step' });
    return serial(() => step(u.searchParams)).then(
      (body) => reply(200, { ok: true, ...body }),
      (err) => reply(500, { error: err.message })
    );
  });
  const controlPort = await freePort();
  await new Promise((r) => control.listen(controlPort, '127.0.0.1', r));

  const server = require('../src/app').createApp().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const vars = { baseUrl: `http://127.0.0.1:${port}/api/v1`, phone: member.phone, controlUrl: `http://127.0.0.1:${controlPort}` };

  const args = ['collection', 'run', `"${collection}"`, '-i', '"2b. Forgot password and the security alert"', ...Object.entries(vars).flatMap(([k, val]) => ['--env-var', `"${k}=${val}"`])];
  const status = await new Promise((resolve) => spawn('postman', args, { stdio: 'inherit', shell: true }).on('close', resolve));

  await new Promise((r) => server.close(r));
  await new Promise((r) => control.close(r));
  await closeAllRedis();
  await models.sequelize.close();
  process.exit(status ?? 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
