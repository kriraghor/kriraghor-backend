'use strict';

/**
 * Unattended M10 acceptance run with the Postman CLI.
 *   node postman/run-m10.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in master A, two owners
 * (fixtures: an active ground_owner role; owner A has a live two-court ground at ৳2,000/h flat with a
 * 25% advance, open around the clock) and two members. It computes the slot times and serves
 * {{controlUrl}}, a local test-only control (never part of the API):
 *   POST /settle                         drain events
 *   POST /pay?paymentId=&who=member|member2   pay through the SSLCommerz simulator, then drain
 *   POST /shift?bookingId=&to=now|late|past   move a booking so it starts now, 30 min ago, or 26 h ago
 *   POST /tick                           run bookings.tick (holds, completion, reminders)
 *   POST /check                          ledger balances of owner A and the invariants
 * Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-bookings.postman_collection.json');
const HALF = 30 * 60 * 1000;

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
  const fx = require('../tests/fixtures/bookings');
  const { closeAllRedis } = require('../src/common/redis');
  const ledger = require('../src/modules/payments/ledger.service');
  const invariants = require('../src/modules/payments/invariants.service');
  const bookings = require('../src/modules/bookings/bookings.service');
  const { models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const ownerA = await fx.owner('Kamal Hossain');
  const ownerB = await fx.owner('Rina Begum');
  const member = await h.signupUser({ name: 'Rafi Ahmed' });
  const member2 = await h.signupUser({ name: 'Nadia Islam' });
  const ground = await fx.liveGround(ownerA, { courts: 2, name: 'Dhanmondi Turf Arena' });

  // Slots: tomorrow at the next half-hour, each two hours apart (court 1), on the Dhaka grid.
  const base = Math.ceil((Date.now() + 86400000) / HALF) * HALF;
  const at = (hours) => new Date(base + hours * 3600000).toISOString();
  const dhakaDate = (iso) => new Date(new Date(iso).getTime() + 6 * 3600000).toISOString().slice(0, 10);
  const day3 = new Date(base + 3 * 86400000);
  const seriesFirst = new Date(base + 3 * 86400000 + 6 * 3600000); // Dhaka wall clock of day+3
  const seriesDow = seriesFirst.getUTCDay();
  const seriesStart = `${String(seriesFirst.getUTCHours()).padStart(2, '0')}:${String(seriesFirst.getUTCMinutes()).padStart(2, '0')}`;

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  const people = { member, member2 };
  const steps = {
    settle: async () => {
      await h.drainEvents();
      return {};
    },
    pay: async (q) => {
      await h.payWithSimulator(people[q.get('who') ?? 'member'], q.get('paymentId'));
      await h.drainEvents();
      return {};
    },
    shift: async (q) => {
      const b = await models.Booking.findByPk(q.get('bookingId'));
      const to = { now: Date.now(), late: Date.now() - 30 * 60000, past: Date.now() - 26 * 3600000 }[q.get('to')];
      await fx.moveTo(b, to);
      return {};
    },
    tick: async () => ({ tick: await bookings.tick() }),
    check: async () => {
      const inv = await invariants.check({ publish: false });
      return {
        invariantsOk: inv.ok,
        ownerPayable: await ledger.balance(`payable:user:${ownerA.user.id}`),
        feeRevenue: await ledger.balance('fee_revenue:grounds'),
        feeReceivable: -(await ledger.balance(`fee_receivable:user:${ownerA.user.id}`)),
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
    adminAccessToken: a.accessToken,
    ownerToken: ownerA.accessToken,
    owner2Token: ownerB.accessToken,
    memberToken: member.accessToken,
    member2Token: member2.accessToken,
    controlUrl: `http://127.0.0.1:${controlPort}`,
    groundId: ground.id,
    groundSlug: ground.slug,
    courtId: ground.courts[0],
    court2Id: ground.courts[1],
    day1: dhakaDate(at(0)),
    s1: at(0),
    s2: at(2),
    s3: at(4),
    s4: at(6),
    s5: at(8),
    s6: at(10),
    closeStart: new Date(day3.getTime()).toISOString(),
    closeEnd: new Date(day3.getTime() + 3 * 3600000).toISOString(),
    seriesFirstDate: seriesFirst.toISOString().slice(0, 10),
    seriesDow: String(seriesDow),
    seriesStart,
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
