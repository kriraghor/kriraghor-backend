'use strict';

/**
 * Unattended "M24 prompt 3 · Public and plans" acceptance run with the Postman CLI.
 *   node postman/run-m24-plans.js
 *
 * Uses the test database (reset; set DB_NAME to keep it apart from other runs): migrates and seeds it,
 * signs in master A and Kriraghor staff who review documents and listings, makes a gym owner whose
 * documents are approved with a live Standard gym at Gulshan's pin (short code IY) and a second live gym
 * at Uttara with a cheaper monthly package, a desk member "Bashir", staff "Coach Sabbir"
 * (members.trainer, plans.manage) and "Cashier Mitu" (members.view, fees.collect), and three people who
 * will ask to join (Ayesha, Rafiq, Nadia). Serves {{controlUrl}}, a local test-only control (never part
 * of the API):
 *   POST /drain                 deliver events (as the worker would)
 *   POST /old-entrance-token    the gym's entrance code from two windows ago (a photo of an old code)
 *   POST /daily                 gym-manage.daily twice → { first, second }
 * Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-gym-manage-plans.postman_collection.json');

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
  const mf = require('../tests/fixtures/market');
  const gm = require('../tests/fixtures/gym-manage');
  const g = require('../tests/fixtures/gym');
  const rules = require('../src/modules/gym-manage/gym-manage.rules');
  const jobs = require('../src/modules/gym-manage/gym-manage.jobs');
  const crypto = require('../src/common/crypto');
  const { closeAllRedis } = require('../src/common/redis');
  const { models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const reviewer = await mf.staffWith(a, ['approve_listings', 'approve_documents']);
  const owner = await g.gymOwner(reviewer, 'Iron Yard Fitness');
  const gym = await g.liveGym(owner, reviewer, { name: 'Iron Yard Banani', lat: 23.7925, lng: 90.4078 });
  await g.liveGym(owner, reviewer, {
    name: 'Uttara Fitness',
    lat: 23.8759,
    lng: 90.3795,
    packages: [
      { kind: 'month', title: 'Monthly', price: 300000 },
    ],
  });
  await gm.manage(owner, gym.id).patch('/settings', { shortCode: 'IY' }).expect(200);
  await h.api().put(`${h.P}/manage/billing/tier`).set(h.bearer(owner)).send({ tier: 'standard' }).expect(200);
  const bashir = await gm.addMember(owner, gym.id, { displayName: 'Bashir Ahmed' });
  const trainer = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Coach Sabbir' }), ['members.trainer', 'plans.manage']);
  const cashier = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Cashier Mitu' }), ['members.view', 'fees.collect']);
  const cashierBm = (await models.BusinessMember.findOne({ where: { memberId: cashier.user.id, status: 'active' } })).id;
  const person = await h.signupUser({ name: 'Ayesha Rahman' });
  const person2 = await h.signupUser({ name: 'Rafiq Hasan' });
  const person3 = await h.signupUser({ name: 'Nadia Islam' });
  const today = rules.dhakaDate(new Date());

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
    'old-entrance-token': async () => {
      const seconds = require('../src/modules/settings').settings.get('gym_manage.entrance_qr_seconds');
      return { token: rules.entranceToken({ gymId: gym.id, window: rules.windowOf(Date.now(), seconds) - 2 }, crypto.hmac) };
    },
    daily: async () => ({ first: await jobs.daily(), second: await jobs.daily() }),
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
    personToken: person.accessToken,
    person2Token: person2.accessToken,
    person3Token: person3.accessToken,
    trainerToken: trainer.accessToken,
    cashierToken: cashier.accessToken,
    cashierBm,
    adminAccessToken: a.accessToken,
    gymId: gym.id,
    slug: gym.slug,
    monthPackageId: gym.packages.find((p) => p.kind === 'month').id,
    bashirId: bashir.member.id,
    today,
    startsOn: rules.addDays(today, -10),
    day7: rules.addDays(today, -7),
    day8: rules.addDays(today, -8),
    lat: 23.794,
    lng: 90.405,
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
