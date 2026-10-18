'use strict';

/**
 * Unattended M16 acceptance run with the Postman CLI.
 *   node postman/run-m16.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in master A, a manage_users
 * staff member, a captain (phone sign-up, Rafi Ahmed), a member (Sakib) and an email-only account.
 * It serves {{controlUrl}}, a local test-only control: /settle drains events, /signup signs up a
 * phone (the OTP is read from the test SMS box), /otp reads the last code sent to a phone,
 * /refresh-email refreshes the email account's token after its phone is added, /check counts the
 * notices. Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-teams.postman_collection.json');
const fixtures = path.join(__dirname, 'fixtures');

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
  const f = require('../tests/fixtures/market');
  const { closeAllRedis } = require('../src/common/redis');
  const { api, P, models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const mod = await f.staffWith(a, ['manage_users']);
  const cap = await h.signupUser({ name: 'Rafi Ahmed' });
  const sakib = await h.signupUser({ name: 'Sakib Hasan' });
  const emailAddr = 'tanvir.google@example.com';
  await api().post(`${P}/auth/otp/send`).send({ target: emailAddr, purpose: 'signup' }).expect(202);
  const v = await api().post(`${P}/auth/otp/verify`).send({ target: emailAddr, purpose: 'signup', code: h.lastEmailCode(emailAddr) }).expect(200);
  const er = await api().post(`${P}/auth/signup`).send({ signupToken: v.body.signupToken, displayName: 'Tanvir Islam' }).expect(201);
  const emailUser = { accessToken: er.body.accessToken, cookie: er.headers['set-cookie'], user: er.body.user };
  const strangerPhone = h.nextPhone();
  const laterPhone = h.nextPhone();
  const users = {};

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  const steps = {
    settle: async () => {
      await h.drainEvents();
      return {};
    },
    signup: async (q) => {
      const phone = q.get('phone');
      await api().post(`${P}/auth/otp/send`).send({ target: phone, purpose: 'signup' }).expect(202);
      const ov = await api().post(`${P}/auth/otp/verify`).send({ target: phone, purpose: 'signup', code: h.lastCode(phone) }).expect(200);
      const r = await api().post(`${P}/auth/signup`).send({ signupToken: ov.body.signupToken, displayName: 'Nabil Khan' }).expect(201);
      users.stranger = r.body.user.id;
      await h.drainEvents();
      return { accessToken: r.body.accessToken, userId: r.body.user.id };
    },
    otp: async (q) => ({ code: h.lastCode(q.get('phone')) }),
    'refresh-email': async () => {
      await f.refresh(emailUser);
      return { accessToken: emailUser.accessToken };
    },
    check: async () => {
      await h.drainEvents();
      const n = (userId, code) => models.Notification.count({ where: { userId, code } });
      return {
        sakibInvites: await n(sakib.user.id, 'TEAM_INVITE'),
        strangerInvites: await n(users.stranger, 'TEAM_INVITE'),
        emailInvites: await n(emailUser.user.id, 'TEAM_INVITE'),
        capAccepted: await n(cap.user.id, 'TEAM_INVITE_ACCEPTED'),
      };
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

  const vars = {
    capToken: cap.accessToken,
    capPhone: cap.phone,
    capId: cap.user.id,
    sakibToken: sakib.accessToken,
    sakibPhone: sakib.phone,
    sakibId: sakib.user.id,
    emailToken: emailUser.accessToken,
    modToken: mod.accessToken,
    strangerPhone,
    laterPhone,
    freshPhone: h.nextPhone(),
    run: String(Date.now()).slice(-6),
    controlUrl: `http://127.0.0.1:${controlPort}`,
  };
  const server = require('../src/app').createApp().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  vars.baseUrl = `http://127.0.0.1:${port}/api/v1`;

  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        await serial(() => h.drainEvents());
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('worker loop:', err.message);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();

  const args = ['collection', 'run', `"${collection}"`, '--working-dir', `"${fixtures}"`, ...Object.entries(vars).flatMap(([k, val]) => ['--env-var', `"${k}=${val}"`])];
  const status = await new Promise((resolve) => spawn('postman', args, { stdio: 'inherit', shell: true }).on('close', resolve));

  stop = true;
  await loop;
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
