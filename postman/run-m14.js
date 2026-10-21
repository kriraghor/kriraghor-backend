'use strict';

/**
 * Unattended M14 acceptance run with the Postman CLI.
 *   node postman/run-m14.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in master A and a reviewer
 * (approve_listings, approve_documents), makes a verified sports organisation whose owner has an
 * active payout account (and a staff member of it), and five captains with an NID and a badminton team. It serves {{controlUrl}},
 * a local test-only control: /approve (claims, ticks and approves the open submission of a subject),
 * /pay (pays an intent on the simulator as a captain), /settle (drains events), /check (the owner's
 * payable and notice counts). Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-tournaments.postman_collection.json');
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
  const tf = require('../tests/fixtures/tournaments');
  const bf = require('../tests/fixtures/business');
  const { closeAllRedis } = require('../src/common/redis');
  const { models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const reviewer = await f.staffWith(a, ['approve_listings', 'approve_documents']);
  const { owner, org } = await tf.sportsOrg(reviewer);
  // Round B2: a staff member of the organisation (the registrations CSV is for admins only).
  const orgStaff = await bf.addOrgMember(owner, org.id, 'staff');
  const caps = [];
  for (const name of ['Rafi Ahmed', 'Sakib Hasan', 'Nabil Khan', 'Tamim Iqbal', 'Mushfiq Rahim']) caps.push(await tf.captain(name));
  const area = await f.areaId();
  const d = tf.dates();

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
    approve: async (q) => {
      await h.drainEvents();
      await f.review(reviewer, q.get('kind'), q.get('id'));
      return {};
    },
    pay: async (q) => {
      const c = caps[Number(q.get('captain')) - 1];
      await h.payWithSimulator(c, q.get('payment'));
      await h.drainPaymentJobs();
      await h.drainEvents();
      return {};
    },
    check: async () => {
      await h.drainEvents();
      return {
        payable: await tf.balance(`payable:user:${owner.user.id}`),
        fixturesNotices: await models.Notification.count({ where: { code: 'FIXTURES_PUBLISHED' } }),
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
    ownerToken: owner.accessToken,
    orgId: org.id,
    orgStaffToken: orgStaff.accessToken,
    modToken: reviewer.accessToken,
    venueArea: area,
    opensAt: d.registrationOpensAt,
    closesAt: d.registrationClosesAt,
    startDate: d.startDate,
    endDate: d.endDate,
    run: String(Date.now()).slice(-6),
    controlUrl: `http://127.0.0.1:${controlPort}`,
  };
  caps.forEach((c, i) => {
    vars[`cap${i + 1}Token`] = c.accessToken;
    vars[`cap${i + 1}Id`] = c.user.id;
    vars[`team${i + 1}`] = c.team.id;
  });
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
