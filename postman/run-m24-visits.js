'use strict';

/**
 * Unattended "M24 · Trial visits" acceptance run with the Postman CLI.
 *   node postman/run-m24-visits.js
 *
 * Uses the test database (reset; set DB_NAME to keep it apart from other runs): migrates and seeds it, makes a
 * Basic gym (published, open 06:00 to 22:00 every day) with a desk staff member (attendance.mark), three
 * guests with a verified phone, and a Free-tier gym. Serves {{controlUrl}}, a local test-only control (never
 * part of the API):
 *   POST /today?visitId=   move a visit to today
 *   POST /daily?at=HH:MM   the morning job (gym-manage.visits-daily) at that Dhaka time today
 *   POST /drain            deliver events (as the worker would)
 * Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-gym-visits.postman_collection.json');

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
  const guests = require('../src/modules/gym-manage/guests.service');
  const rules = require('../src/modules/gym-manage/gym-manage.rules');
  const { closeAllRedis } = require('../src/common/redis');
  const { models } = h;

  await h.resetDb();
  await h.createSignedInMaster();
  const hours = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, openTime: '06:00', closeTime: '22:00', womenOnly: false }));
  const publish = async (gym) => {
    await models.Gym.update({ status: 'live', liveVersion: 1, liveSnapshot: { name: gym.name, hours } }, { where: { id: gym.id } });
    return (await models.Gym.findByPk(gym.id)).slug;
  };
  const { owner, gym } = await gm.privateGym({ tier: 'basic' });
  const slug = await publish(gym);
  const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rumi' }), ['attendance.mark']);
  const ana = await h.signupUser({ name: 'Guest Ana' });
  const bo = await h.signupUser({ name: 'Guest Bo' });
  const cy = await h.signupUser({ name: 'Guest Cy' });
  const free = await gm.privateGym({ name: 'Free Gym', shortCode: 'FG' });
  const freeSlug = await publish(free.gym);

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  const steps = {
    today: async (q) => {
      await models.GymVisit.update({ visitDate: gm.today() }, { where: { id: q.get('visitId') } });
      return {};
    },
    daily: async (q) => guests.daily(rules.visitStartAt(gm.today(), q.get('at'))),
    drain: async () => {
      await h.drainEvents({ rounds: 10 });
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

  const vars = {
    controlUrl: `http://127.0.0.1:${controlPort}`,
    ownerToken: owner.accessToken,
    deskToken: desk.accessToken,
    anaToken: ana.accessToken,
    boToken: bo.accessToken,
    cyToken: cy.accessToken,
    freeOwnerToken: free.owner.accessToken,
    gymId: gym.id,
    slug,
    freeGymId: free.gym.id,
    freeSlug,
    tomorrow: gm.inDays(1),
    in2: gm.inDays(2),
    in20: gm.inDays(20),
    yesterday: gm.inDays(-1),
    today: gm.today(),
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
