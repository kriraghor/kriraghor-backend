'use strict';

/**
 * Unattended M13 acceptance run with the Postman CLI.
 *   node postman/run-m13.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in master A, and builds two
 * live shops through the M12 fixtures (owners onboarded through M02, shops and boots approved on the
 * Moderation desk): A sells boots at ৳2,600 in EU 42 and 43, B at ৳1,200 in EU 42. A buyer and a
 * disputes desk member (resolve_reports, refund_small) sign in. It serves {{controlUrl}}, a local
 * test-only control: /settle drains events, /pay pays a payment through the SSLCommerz simulator,
 * /expire moves a sub-order past its accept deadline and runs orders.tick, /check reads the ledger.
 * Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-orders.postman_collection.json');

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
  const { closeAllRedis } = require('../src/common/redis');
  const ledger = require('../src/modules/payments/ledger.service');
  const invariants = require('../src/modules/payments/invariants.service');
  const orderJobs = require('../src/modules/orders/orders.jobs');
  const { models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const reviewer = await f.staffWith(a, ['approve_listings']);
  const docsReviewer = await f.staffWith(a, ['approve_documents']);
  const desk = await f.staffWith(a, ['resolve_reports', 'refund_small']);
  const shop = async (name, price, sizes) => {
    const owner = await f.shopOwner(docsReviewer, name);
    await f.liveShop(owner, reviewer, { name });
    const ready = await f.readyBoots(owner, { sizes, stock: 3, over: { title: `${name} Turf Boots`, basePricePoisha: price } });
    const product = await f.liveProduct(owner, reviewer, ready);
    return { owner, v: (size) => product.variants.find((x) => x.attributes.eu_size === size).id };
  };
  const A = await shop('Elephant Road Sports', 260000, ['42', '43']);
  const B = await shop('Gulshan Boot House', 120000, ['42']);
  const buyer = await h.signupUser({ name: 'Tanvir Hasan' });
  const outside = await models.Area.findOne({ where: { isDhakaMetro: false } });

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
      await h.payWithSimulator(buyer, q.get('paymentId'));
      await h.drainEvents();
      return {};
    },
    expire: async (q) => {
      const s = await models.SubOrder.findByPk(q.get('subOrderId'));
      const tick = await orderJobs.tick(new Date(s.acceptBy.getTime() + 1000));
      await h.drainEvents();
      return { tick };
    },
    check: async () => {
      const inv = await invariants.check({ publish: false });
      return {
        invariantsOk: inv.ok,
        payableA: await ledger.balance(`payable:user:${A.owner.user.id}`),
        payableB: await ledger.balance(`payable:user:${B.owner.user.id}`),
        feeRevenue: await ledger.balance('fee_revenue:market'),
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
    deskToken: desk.accessToken,
    shopAToken: A.owner.accessToken,
    shopBToken: B.owner.accessToken,
    buyerToken: buyer.accessToken,
    vA42: A.v('42'),
    vA43: A.v('43'),
    vB42: B.v('42'),
    areaDhaka: await f.areaId('dhanmondi'),
    areaOutside: outside.id,
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
