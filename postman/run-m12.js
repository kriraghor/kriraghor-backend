'use strict';

/**
 * Unattended M12 acceptance run with the Postman CLI.
 *   node postman/run-m12.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in masters A and B (B
 * reviews), a shop owner who is an active member and has applied for shop_owner, and a buyer. It serves
 * {{controlUrl}}, a local test-only control: /settle drains events, /refresh drains them and hands
 * back a fresh owner access token (the role change bumps the authz version, so the old token is
 * stale). Runs with --working-dir postman/fixtures (the uploads). Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-market.postman_collection.json');
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
  const { closeAllRedis } = require('../src/common/redis');
  const { api, P, models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const b = await h.createSecondMaster();
  const owner = await h.signupUser({ name: 'Nayeem Sports' });
  const buyer = await h.signupUser({ name: 'Fahim Rahman' });
  const refresh = async () => {
    const r = await h.refreshWeb(owner.cookie).expect(200);
    owner.accessToken = r.body.accessToken;
    owner.cookie = r.headers['set-cookie'] ?? owner.cookie;
    return owner.accessToken;
  };
  await h.verifyMember(owner.user.id);
  await refresh();
  await api().post(`${P}/me/roles`).set(h.bearer(owner)).send({ role: 'shop_owner' }).expect(201);
  await refresh();

  // The worker loop and the control steps take turns, so a refresh always follows every event it waits for.
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
    refresh: async () => {
      await h.drainEvents();
      return { accessToken: await refresh() };
    },
  };
  const control = http.createServer((rq, rs) => {
    const step = steps[new URL(rq.url, 'http://127.0.0.1').pathname.slice(1)];
    const reply = (code, body) => rs.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (rq.method !== 'POST' || !step) return reply(404, { error: 'unknown step' });
    return serial(step).then(
      (body) => reply(200, { ok: true, ...body }),
      (err) => reply(500, { error: err.message })
    );
  });
  const controlPort = await freePort();
  await new Promise((r) => control.listen(controlPort, '127.0.0.1', r));

  const vars = {
    adminAccessToken: a.accessToken,
    adminAccessToken2: b.accessToken,
    accessToken: owner.accessToken,
    memberToken: buyer.accessToken,
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

  const args = ['collection', 'run', `"${collection}"`, '--working-dir', `"${fixtures}"`, ...Object.entries(vars).flatMap(([k, v]) => ['--env-var', `"${k}=${v}"`])];
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
