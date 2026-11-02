'use strict';

/**
 * Unattended Round B3 (business members) acceptance run with the Postman CLI.
 *   node postman/run-b3.js
 *
 * Uses the test database (reset): migrates and seeds it, signs in master A, a venue owner with a
 * two-court fixture ground (৳2,000/h flat, 25% advance), another owner with a ground, a member who
 * books, members with verified phones who become staff (desk, none, other, packer, frontdesk) and one
 * whose phone is not verified; a live shop with two placed orders and a live gym with a paid monthly package.
 * Serves {{controlUrl}}, a local test-only control (never part of the API):
 *   POST /refresh?who=      a fresh access token for a session whose access changed (staff, owner)
 *   POST /pay?paymentId=    pay through the SSLCommerz simulator as the member, then drain events
 *   POST /shift?bookingId=  move a booking so it starts now
 *   POST /drain             deliver events (as the worker would)
 *   POST /fill-team-adds?who=  use up all but one of that owner's staff adds this hour (Q180)
 * Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-business-members.postman_collection.json');
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
  const bf = require('../tests/fixtures/business');
  const { closeAllRedis } = require('../src/common/redis');
  const velocity = require('../src/common/velocity');
  const config = require('../src/config');
  const { models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const owner = await fx.owner('Kamal Hossain');
  const ground = await fx.liveGround(owner, { name: 'Dhanmondi Turf Arena', courts: 2 });
  const owner2 = await fx.owner('Shafiq Rahman');
  const ground2 = await fx.liveGround(owner2, { name: 'Uttara Turf' });
  const member = await h.signupUser({ name: 'Rafi Ahmed' });
  const people = {};
  for (const [k, name] of [['desk', 'Sakib Counter'], ['none', 'Mitu Akter'], ['other', 'Nabil Khan'], ['packer', 'Rumana Packer'], ['frontdesk', 'Tania Desk']]) people[k] = await h.signupUser({ name });
  const unverified = await h.signupUser({ name: 'Unverified Phone' });
  await models.User.update({ phoneVerifiedAt: null }, { where: { id: unverified.user.id } });

  const reviewer = await mf.staffWith(a, ['approve_listings', 'approve_documents']);
  const shop = await bf.bootShop(reviewer, reviewer);
  const buyer = await h.signupUser({ name: 'Tanvir Hasan' });
  const s1 = await bf.paidOrder(buyer, shop, ['42']);
  const s2 = await bf.paidOrder(buyer, shop, ['43']);
  const { owner: gymOwner, gym } = await bf.liveGym(reviewer, reviewer);
  const pass = await bf.paidPass(member, gym, 'month');
  const base = Math.ceil((Date.now() + 86400000) / HALF) * HALF;

  const sessions = { ...people, owner, owner2 };
  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  const steps = {
    refresh: async (q) => {
      const who = sessions[q.get('who')];
      if (!who) throw new Error(`unknown session ${q.get('who')}`);
      await fx.refresh(who);
      return { accessToken: who.accessToken };
    },
    pay: async (q) => {
      await h.payWithSimulator(member, q.get('paymentId'));
      await h.drainEvents();
      return {};
    },
    shift: async (q) => {
      await fx.moveTo(await models.Booking.findByPk(q.get('bookingId')), Date.now());
      return {};
    },
    drain: async () => {
      await h.drainEvents({ rounds: 10 });
      return {};
    },
    // Q180: use up all but one of an owner's staff adds this hour (business.team_adds_per_hour; the
    // test config runs velocity limits ×100), so the collection can reach the limit in two requests.
    'fill-team-adds': async (q) => {
      const who = sessions[q.get('who')];
      if (!who) throw new Error(`unknown session ${q.get('who')}`);
      const limit = h.settings.get('business.team_adds_per_hour') * (config.isTest ? 100 : 1);
      // Adds already made this hour count too: fill up to limit − 1, whatever is there.
      while ((await velocity.hit({ name: 'bmadd', scope: who.user.id, limit: limit - 1, windowMs: 3600000 })).allowed);
      return { limit };
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
    masterPhone: a.phone,
    ownerToken: owner.accessToken,
    ownerId: owner.user.id,
    ownerPhone: owner.phone,
    owner2Token: owner2.accessToken,
    memberToken: member.accessToken,
    controlUrl: `http://127.0.0.1:${controlPort}`,
    groundId: ground.id,
    ground2Id: ground2.id,
    courtId: ground.courts[0],
    court2Id: ground.courts[1],
    s1: new Date(base).toISOString(),
    s2: new Date(base + 4 * 3600000).toISOString(),
    deskPhone: people.desk.phone,
    nonePhone: people.none.phone,
    otherPhone: people.other.phone,
    packerPhone: people.packer.phone,
    frontdeskPhone: people.frontdesk.phone,
    unverifiedPhone: unverified.phone,
    shopOwnerToken: shop.owner.accessToken,
    shopId: shop.product.shopId,
    subOrderId: s1.id,
    subOrder2Id: s2.id,
    variantId: shop.variant('44'),
    gymOwnerToken: gymOwner.accessToken,
    gymId: gym.id,
    passToken: pass.token,
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
