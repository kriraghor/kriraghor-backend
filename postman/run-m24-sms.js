'use strict';

/**
 * Unattended "M24 · SMS add-on" acceptance run with the Postman CLI.
 *   node postman/run-m24-sms.js
 *
 * Uses the test database (reset; set DB_NAME to keep it apart from other runs) and the memory SMS driver:
 * migrates and seeds, makes a master, a Basic gym (its owner's gym_owner role active, for online fees) with
 * a phone-only member and a second member, each with a month's due, and a Free gym. Serves {{controlUrl}},
 * a local test-only control (never part of the API):
 *   POST /switch?on=1|0          the platform setting gym_saas.sms_addon_enabled with prices (as a master would)
 *   POST /drain                  deliver events (as the worker would)
 *   POST /last-sms?phone=        the last test SMS to a number { text }
 *   POST /pay?paymentId=         pay through the SSLCommerz simulator, then deliver events
 *   POST /daily, /allowance      the SMS jobs (the allowance as on the 1st of next month)
 *   POST /stepup?scope=          a step-up token for the master
 * Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-gym-sms.postman_collection.json');

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
  const gm = require('../tests/fixtures/gym-manage');
  const sms = require('../src/modules/gym-manage/sms.service');
  const { closeAllRedis } = require('../src/common/redis');
  const { models } = h;

  await h.resetDb();
  const master = await h.createSignedInMaster();
  const { owner, gym, pkg } = await gm.privateGym({ tier: 'basic' });
  await gm.listOwner(owner);
  const a = await gm.addMember(owner, gym.id, { displayName: 'Phone Only', membership: { packageId: pkg('month').id, startsOn: gm.today() } });
  const phoneB = h.nextPhone();
  const b = await gm.addMember(owner, gym.id, { displayName: 'Link By Sms', phone: phoneB, membership: { packageId: pkg('month').id, startsOn: gm.today() } });
  const free = await gm.privateGym({ name: 'Free Gym', shortCode: 'FG' });
  await h.drainEvents();

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  const ON = { 'gym_saas.sms_addon_price_poisha': 20000, 'gym_saas.sms_addon_included': 10, 'gym_saas.sms_bundle_size': 100, 'gym_saas.sms_bundle_price_poisha': 50000 };
  const steps = {
    switch: async (q) => {
      const on = q.get('on') === '1';
      if (on) for (const [k, v] of Object.entries(ON)) await h.setSettingForTest(k, v);
      await h.setSettingForTest('gym_saas.sms_addon_enabled', on);
      return { on };
    },
    drain: async () => {
      await h.drainEvents({ rounds: 10 });
      return {};
    },
    'last-sms': async (q) => ({ text: h.sms.lastTo(h.e164(q.get('phone')))?.text ?? '' }),
    pay: async (q) => {
      await h.payWithSimulator(owner, q.get('paymentId'));
      await h.drainEvents({ rounds: 10 });
      return {};
    },
    daily: async () => sms.daily(),
    allowance: async () => sms.allowance(new Date(`${gm.inDays(40).slice(0, 7)}-01T00:30:00+06:00`)),
    stepup: async (q) => ({ token: await h.stepUp(master, q.get('scope')) }),
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
    controlUrl: `http://127.0.0.1:${controlPort}`,
    ownerToken: owner.accessToken,
    freeOwnerToken: free.owner.accessToken,
    adminAccessToken: master.accessToken,
    gymId: gym.id,
    ownerId: owner.user.id,
    dueA: a.due.id,
    dueB: b.due.id,
    phoneB,
  };
  const server = require('../src/app').createApp().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  vars.baseUrl = `http://127.0.0.1:${port}/api/v1`;

  const args = ['collection', 'run', `"${collection}"`, ...Object.entries(vars).flatMap(([k, v]) => ['--env-var', `"${k}=${v}"`])];
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
