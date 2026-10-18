'use strict';

/**
 * Unattended M20 acceptance run with the Postman CLI.
 *   node postman/run-m20.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in master A and two staff
 * (listings reviewer, manage_users), an approved gym owner (gym_owner role with its documents), a live
 * fitness trainer and a member. It serves {{controlUrl}}, a local test-only control: /settle drains
 * events, /pay pays a payment through the simulator, /tick runs gym.tick at a Dhaka date and minute,
 * /check reads the ledger. Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-gym.postman_collection.json');
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
  const g = require('../tests/fixtures/gym');
  const { closeAllRedis } = require('../src/common/redis');
  const ledger = require('../src/modules/payments/ledger.service');
  const invariants = require('../src/modules/payments/invariants.service');
  const gymJobs = require('../src/modules/gym/gym.jobs');
  const rules = require('../src/modules/gym/gym.rules');
  const { models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const docs = await f.staffWith(a, ['approve_documents']);
  const listings = await f.staffWith(a, ['approve_listings']);
  const mod = await f.staffWith(a, ['manage_users']);
  const owner = await g.gymOwner(docs);
  const { pro: trainer, profile } = await g.trainer({ docsReviewer: docs, reviewer: listings });
  const m1 = await h.signupUser({ name: 'Fahim Rahman' });

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
    pay: async (q) => {
      await h.payWithSimulator(m1, q.get('paymentId'));
      await h.drainEvents();
      return {};
    },
    tick: async (q) => {
      const at = q.get('date') ? rules.instantOf(q.get('date'), Number(q.get('minutes') ?? 0)) : new Date();
      const tick = await gymJobs.tick(at);
      await h.drainEvents();
      return { tick };
    },
    check: async () => {
      const inv = await invariants.check({ publish: false });
      return { invariantsOk: inv.ok, ownerPayable: await ledger.balance(`payable:user:${owner.user.id}`), feeRevenue: await ledger.balance('fee_revenue:gym') };
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
    adminAccessToken: a.accessToken,
    listingsToken: listings.accessToken,
    modToken: mod.accessToken,
    ownerToken: owner.accessToken,
    trainerToken: trainer.accessToken,
    trainerProfileId: profile.id,
    m1Token: m1.accessToken,
    areaBanani: await f.areaId('banani'),
    today: g.today(),
    tomorrow: g.inDays(1),
    in9: g.inDays(9),
    stepUpA: await h.stepUp(a, 'escrow.manage'),
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
