'use strict';

/**
 * Unattended "M27 round 1 · Front desk and money" acceptance run with the Postman CLI.
 *   node postman/run-m27.js
 *
 * Uses the test database (reset; set DB_NAME to keep it apart from other runs): migrates and seeds it,
 * makes a gym owner with a Standard gym (short code IY), a member "Rafiq Hasan" who paid ৳1,000 cash for
 * a month and whose own account (same phone) is linked, and three staff: a cashier (members.view,
 * cash.drawer, pos.sell), a store keeper (stock.manage) and a desk hand (members.view). Serves
 * {{controlUrl}}, a local test-only control (never part of the API):
 *   POST /drain     deliver events (as the worker would)
 *   POST /lockers   the daily lockers job (reminders before the end, rentals past it end)
 * Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-gym-ops.postman_collection.json');

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
  const lockers = require('../src/modules/gym-ops/lockers.service');
  const { closeAllRedis } = require('../src/common/redis');
  const { models } = h;

  await h.resetDb();
  await h.createSignedInMaster();
  const { owner, gym, pkg } = await gm.privateGym({ tier: 'standard' });
  const payer = await h.signupUser({ name: 'Rafiq Hasan' });
  const added = await gm.addMember(owner, gym.id, {
    displayName: 'Rafiq Hasan',
    phone: payer.phone,
    membership: { packageId: pkg('month').id, startsOn: gm.today() },
    payment: { amountPoisha: 100000, method: 'cash' },
  });
  await gm.linkMember(owner, gym.id, added.member.id, payer);
  const cashier = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Tania Cashier' }), ['members.view', 'cash.drawer', 'pos.sell']);
  const keeper = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Sumon Store' }), ['stock.manage']);
  const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Rina Desk' }), ['members.view']);

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  const steps = {
    drain: async () => {
      await h.drainEvents({ rounds: 10 });
      return {};
    },
    lockers: async () => {
      const r = await lockers.daily();
      await h.drainEvents({ rounds: 10 });
      return r;
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
    controlUrl: `http://127.0.0.1:${controlPort}`,
    ownerToken: owner.accessToken,
    cashierToken: cashier.accessToken,
    keeperToken: keeper.accessToken,
    deskToken: desk.accessToken,
    memberToken: payer.accessToken,
    gymId: gym.id,
    memberId: added.member.id,
    lockerEnds: gm.inDays(29), // 30 days: one month's fee
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

  const args = ['collection', 'run', `"${collection}"`, ...Object.entries(vars).flatMap(([k, v]) => ['--env-var', `"${k}=${v}"`])];
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
