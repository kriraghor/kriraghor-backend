'use strict';

/**
 * Unattended M19 acceptance run with the Postman CLI.
 *   node postman/run-m19.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in master A, an owner
 * (fixture ground at ৳2,000/h flat, 25% advance) and a member. Serves {{controlUrl}}, a local
 * test-only control (never part of the API):
 *   POST /pay?paymentId=        pay through the SSLCommerz simulator, then drain events
 *   POST /shift?bookingId=      move a booking so it starts now
 *   POST /settle                drain events and refresh the dashboard views
 *   POST /forget?bookingId=     delete one booking fact (the nightly reconcile must restore it)
 *   POST /reconcile             run the nightly reconcile now
 *   POST /forget-sub-order?subOrderId=   delete one shop fact (Round B2)
 *   POST /backfill              empty the shop and gym facts and the backfill marker, then reconcile
 *   POST /businesses            Round B2: make a live shop with four orders (one rejected), a live gym
 *                               with three passes (two admitted) and a sports organisation with a busy
 *                               event and a staff member; answers their tokens and ids
 * Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-analytics.postman_collection.json');
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
  const mf = require('../tests/fixtures/market');
  const gf = require('../tests/fixtures/gym');
  const bf = require('../tests/fixtures/business');
  const { closeAllRedis } = require('../src/common/redis');
  const facts = require('../src/modules/analytics/facts.service');
  const { models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const owner = await fx.owner('Kamal Hossain');
  const member = await h.signupUser({ name: 'Rafi Ahmed' });
  const ground = await fx.liveGround(owner, { name: 'Dhanmondi Turf Arena' });
  const base = Math.ceil((Date.now() + 86400000) / HALF) * HALF;

  /**
   * Round B2 businesses, made when the collection reaches them (so the earlier platform and member
   * numbers stay those of the bookings): a shop with four orders from two buyers (one rejected), a gym
   * with a day, a month and a tomorrow's day pass (two admitted), a sports organisation with a busy event.
   */
  async function businesses() {
    const reviewer = await mf.staffWith(a, ['approve_listings', 'approve_documents']);
    const shop = await bf.bootShop(reviewer, reviewer);
    const tanvir = await h.signupUser({ name: 'Tanvir Hasan' });
    const nadia = await h.signupUser({ name: 'Nadia Islam' });
    const s1 = await bf.paidOrder(tanvir, shop, ['42', '43']);
    const s2 = await bf.paidOrder(tanvir, shop, ['44']);
    const s3 = await bf.paidOrder(nadia, shop, ['40']);
    const s4 = await bf.paidOrder(nadia, shop, ['41']);
    await bf.shopPost(shop.owner, s4.id, 'reject', { reason: 'out_of_stock' }).expect(200);
    const { owner: gymOwner, gym: fresh } = await bf.liveGym(reviewer, reviewer);
    const gym = await gf.withOldDayPass(fresh); // the history still counts day passes sold before 2 Nov 2026
    const fahim = await h.signupUser({ name: 'Fahim Rahman' });
    const rina = await h.signupUser({ name: 'Rina Begum' });
    const day = await bf.paidPass(fahim, gym, 'day');
    const month = await bf.paidPass(rina, gym, 'month');
    await bf.paidPass(rina, gym, 'day', gf.inDays(1));
    await bf.admit(gymOwner, gym, day);
    await bf.admit(gymOwner, gym, month);
    const busy = await bf.busyOrganiser(reviewer);
    const orgStaff = await bf.addOrgMember(busy.owner, busy.org.id, 'staff');
    await h.drainEvents({ rounds: 10 });
    return {
      shopOwnerToken: shop.owner.accessToken,
      shopSales: [s1, s2, s3].reduce((n, x) => n + x.itemsPoisha, 0),
      subOrderId: s1.id,
      gymOwnerToken: gymOwner.accessToken,
      orgOwnerToken: busy.owner.accessToken,
      orgStaffToken: orgStaff.accessToken,
      orgId: busy.org.id,
    };
  }

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  const steps = {
    pay: async (q) => {
      await h.payWithSimulator(member, q.get('paymentId'));
      await h.drainEvents();
      return {};
    },
    shift: async (q) => {
      await fx.moveTo(await models.Booking.findByPk(q.get('bookingId')), Date.now());
      return {};
    },
    settle: async () => {
      await h.drainEvents({ rounds: 10 });
      return facts.refreshViews();
    },
    forget: async (q) => ({ deleted: await models.KpiFactBooking.destroy({ where: { bookingId: q.get('bookingId') } }) }),
    reconcile: async () => facts.reconcile(),
    businesses: async () => businesses(),
    // Round B2: lose one shop fact; or empty every shop and gym fact and the backfill marker (as on the
    // day of the migration) and let the reconcile backfill them once.
    'forget-sub-order': async (q) => ({ deleted: await models.KpiFactSubOrder.destroy({ where: { subOrderId: q.get('subOrderId') } }) }),
    backfill: async () => {
      for (const m of [models.KpiFactSubOrder, models.KpiFactOrderLine, models.KpiFactGymPass, models.KpiFactGymAdmission]) await m.destroy({ where: {} });
      await models.KpiProcessedEvent.destroy({ where: { consumer: 'analytics.backfill.round-b2' } });
      return facts.reconcile();
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
    ownerToken: owner.accessToken,
    memberToken: member.accessToken,
    controlUrl: `http://127.0.0.1:${controlPort}`,
    groundId: ground.id,
    courtId: ground.courts[0],
    s1: new Date(base).toISOString(),
    s2: new Date(base + 4 * 3600000).toISOString(),
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
