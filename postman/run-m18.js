'use strict';

/**
 * Unattended M18 acceptance run with the Postman CLI.
 *   node postman/run-m18.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in master A and a staff member
 * with manage_users, and two members who submit the same NID (the second raises a critical
 * accounts_per_nid flag). It mints master A's step-up tokens in the order the collection uses them
 * (risk.manage ×3, settings.write) and serves {{controlUrl}}, a local test-only control:
 *   POST /settle   deliver events and run the queued risk jobs (what the worker does)
 *   POST /check    the second member's account status and their active risk_freeze holds
 * Runs with --working-dir postman/fixtures. Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-risk.postman_collection.json');
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
  const runtime = require('../src/jobs/runtime');
  const riskJobs = require('../src/modules/risk/risk.jobs');
  const { api, P, models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const s = await h.signupUser({ name: 'Risk Analyst' });
  await api().post(`${P}/admin/staff`).set(h.bearer(a)).set('X-Step-Up', await h.stepUp(a, 'staff.write')).send({ userId: s.user.id, employeeId: 'KG-PM-RISK', permissions: ['manage_users'] }).expect(201);
  const staff = await h.signInStaff(s.phone, s.user.id);

  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg body')]);
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png')]);
  const PDF = Buffer.from('%PDF-1.7\n% test document\n');
  async function submitNid(who, salt) {
    const files = {};
    for (const [slot, buf, type] of [['front', JPEG, 'image/jpeg'], ['back', PNG, 'image/png'], ['selfie', PDF, 'application/pdf']]) {
      files[slot] = (await api().post(`${P}/me/documents/files?slot=${slot}`).set(h.bearer(who)).set('Content-Type', type).send(Buffer.concat([buf, Buffer.from(salt)])).expect(201)).body.fileId;
    }
    await api().post(`${P}/me/documents`).set(h.bearer(who)).send({ docType: 'nid', fields: { number: '1990 1234 5678 9012 3', dob: '1990-05-14', legalName: 'Same Person' }, files, consent: h.consent() }).expect(201);
  }
  const first = await h.signupUser({ name: 'First Holder' });
  const second = await h.signupUser({ name: 'Second Holder' });
  await submitNid(first, 'a');
  await submitNid(second, 'b');
  // Submitting the NID moves the member role to review, which makes older access tokens stale.
  const { refresh } = require('../tests/fixtures/bookings');
  await h.drainEvents();
  await refresh(first);
  await refresh(second);

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  async function settle() {
    await h.drainEvents();
    for (const j of riskJobs.takeTestJobs()) await runtime.processJob({ name: j.name, data: j.data });
    await h.drainEvents();
  }
  await settle();
  const steps = {
    settle: async () => (await settle(), {}),
    check: async () => ({
      status: (await models.User.findByPk(second.user.id)).status,
      frozen: await models.PayoutHold.count({ where: { payeeId: second.user.id, type: 'risk_freeze', liftedAt: null } }),
    }),
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

  const tokens = [];
  for (const scope of ['risk.manage', 'risk.manage', 'risk.manage', 'settings.write']) tokens.push(await h.stepUp(a, scope));
  const vars = {
    adminAccessToken: a.accessToken,
    staffToken: staff.accessToken,
    memberToken: second.accessToken,
    member1Token: first.accessToken,
    userId: second.user.id,
    stepUpQueueA: tokens.join(','),
    controlUrl: `http://127.0.0.1:${controlPort}`,
  };
  const server = require('../src/app').createApp().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  vars.baseUrl = `http://127.0.0.1:${port}/api/v1`;

  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        await serial(() => settle());
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
