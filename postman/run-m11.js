'use strict';

/**
 * Unattended M11 acceptance run with the Postman CLI.
 *   node postman/run-m11.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in master A and two staff
 * (documents and listings reviewers), a pro applicant (an active member who applied as a pro; the
 * collection sends the credential and the profile) and two managers. It serves {{controlUrl}}, a
 * local test-only control: /settle drains events, /refresh hands back a fresh pro token after the
 * role changes, /pay pays a payment through the simulator, /move moves a job's start by minutes from
 * now, /tick runs hire.tick at a time, /check reads the ledger. Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-hire.postman_collection.json');
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
  const x = require('../tests/fixtures/hire');
  const { closeAllRedis } = require('../src/common/redis');
  const ledger = require('../src/modules/payments/ledger.service');
  const invariants = require('../src/modules/payments/invariants.service');
  const hireJobs = require('../src/modules/hire/hire.jobs');
  const { models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const docs = await f.staffWith(a, ['approve_documents']);
  const listings = await f.staffWith(a, ['approve_listings']);
  const desk = await f.staffWith(a, ['resolve_reports', 'refund_small']);
  const proUser = await x.applicant('pro', 'Kamrul Hasan');
  const m1 = await h.signupUser({ name: 'Rafi Ahmed' });
  const m2 = await h.signupUser({ name: 'Nadia Islam' });

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  const people = { m1, m2 };
  const steps = {
    settle: async () => {
      await h.drainEvents();
      return {};
    },
    refresh: async () => {
      await h.drainEvents();
      await f.refresh(proUser);
      return { accessToken: proUser.accessToken };
    },
    pay: async (q) => {
      await h.payWithSimulator(people[q.get('who') ?? 'm1'], q.get('paymentId'));
      await h.drainEvents();
      return {};
    },
    move: async (q) => {
      const j = await x.moveJob(q.get('jobId'), Number(q.get('minutes')));
      return { start: j.startAt };
    },
    tick: async (q) => {
      const j = q.get('jobId') ? await models.HireJob.findByPk(q.get('jobId')) : null;
      const at = j?.releaseAt ? new Date(j.releaseAt.getTime() + 1000) : new Date();
      const tick = await hireJobs.tick(at);
      await h.drainEvents();
      return { tick };
    },
    check: async () => {
      const inv = await invariants.check({ publish: false });
      return { invariantsOk: inv.ok, proPayable: await ledger.balance(`payable:user:${proUser.user.id}`), feeRevenue: await ledger.balance('fee_revenue:hire') };
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
    docsToken: docs.accessToken,
    listingsToken: listings.accessToken,
    deskToken: desk.accessToken,
    proToken: proUser.accessToken,
    proUserId: proUser.user.id,
    m1Token: m1.accessToken,
    m2Token: m2.accessToken,
    areaDhanmondi: await f.areaId('dhanmondi'),
    areaMirpur: await f.areaId('mirpur'),
    start4: x.at1930(4),
    start5: x.at1930(5),
    start6: x.at1930(6),
    // Round B1: the calendar range (today 00:00 Dhaka to 14 and 70 days on) and a block around a day-8 match.
    ...(() => {
      const rules = require('../src/modules/hire/hire.rules');
      const day = (n) => rules.dhakaMidnight(rules.addDays(rules.dhakaDay(new Date()), n)).toISOString();
      const start8 = x.at1930(8);
      const off = (min) => new Date(Date.parse(start8) + min * 60000).toISOString();
      return { day0: day(0), day14: day(14), day70: day(70), start8, block8Start: off(-30), block8End: off(90) };
    })(),
    stepUpQueueA: await h.stepUp(a, 'escrow.manage'),
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
