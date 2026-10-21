'use strict';

/**
 * Unattended M22 acceptance run with the Postman CLI.
 *   node postman/run-m22.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in master A and two staff
 * (listings reviewer, manage_organisers), an organiser whose role and organisation registration were
 * approved (M02), a member without the role, a player who joins the organisation's staff, four players
 * and another verified organisation. It serves {{controlUrl}}, a local test-only control: /settle drains
 * events, /body builds tournament bodies, /pay pays a payment through the simulator, /review approves a
 * submission on the desk, /open, /fill, /start and /close-disputes move the tournament clock, /code reads
 * the finalise code sent to the owner's phone, /check reads the ledger. Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-organisers.postman_collection.json');
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
  const es = require('../tests/fixtures/esports');
  const o = require('../tests/fixtures/organiser');
  const { closeAllRedis } = require('../src/common/redis');
  const ledger = require('../src/modules/payments/ledger.service');
  const invariants = require('../src/modules/payments/invariants.service');
  const { models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const docs = await f.staffWith(a, ['approve_documents']);
  const listings = await f.staffWith(a, ['approve_listings']);
  const mgr = await f.staffWith(a, ['manage_organisers']);
  const owner = await o.organiserOwner(docs);
  const plain = await h.signupUser({ name: 'Nadia Islam' });
  const insider = await es.player(listings, 'Insider Ifty');
  const people = [];
  for (const n of ['Player One', 'Player Two', 'Player Three', 'Player Four']) people.push(await es.player(listings, n));
  const otherOwner = await o.organiserOwner(docs, 'Owner of Chittagong Gamers');
  // M22 is switched off by default (esports is organised by Kriraghor only, 21 Oct 2026): the setup
  // turns it on for the second organisation, then off again; the collection proves it is closed, then
  // turns it on (/esports-on) to document the feature.
  await h.setSettingForTest('esports.external_organisers_enabled', true);
  const otherOrg = await o.verifiedOrg(otherOwner, listings, 'Chittagong Gamers');
  await h.setSettingForTest('esports.external_organisers_enabled', false);
  const stepUps = [];
  for (let i = 0; i < 4; i += 1) stepUps.push(await h.stepUp(a, 'esports.money'));

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  const row = (p, placement, kills) => ({ registrationId: p.reg.id, placement, kills: kills ? [{ userId: p.user.id, kills }] : [] });
  const steps = {
    settle: async () => {
      await h.drainEvents();
      return {};
    },
    'esports-on': async () => {
      await h.setSettingForTest('esports.external_organisers_enabled', true);
      return { on: true };
    },
    // Places ৳1,000 and ৳500 at ৳400 a head; the capped one pays ৳100 a kill up to 5 kills.
    body: async () => ({
      noCap: await es.tournamentBody({ fee: 40000, prizes: [100000, 50000], killReward: 10000 }),
      cap: await es.tournamentBody({ fee: 40000, prizes: [100000, 50000], killReward: 10000, maxPaidKills: 5 }),
      small: await es.tournamentBody({ prizes: [100000, 50000] }),
    }),
    pay: async (q) => {
      await h.payWithSimulator(owner, q.get('paymentId'));
      await h.drainEvents();
      return {};
    },
    review: async (q) => {
      await h.drainEvents();
      await f.review(listings, q.get('kind'), q.get('id'));
      await h.drainEvents();
      const t = await models.EsportsTournament.findByPk(q.get('id'));
      return { status: t.status, saasFeeModel: t.saasFeeModel, saasFeeBps: t.saasFeeBps };
    },
    open: async (q) => {
      await es.openRegistration(q.get('id'));
      return {};
    },
    fill: async (q) => {
      await es.fill(q.get('id'), people);
      const [m] = await es.matchesOf(q.get('id'));
      const [p1, p2, p3, p4] = people;
      // 3 + 2 + 1 = 6 kills over the cap of 5.
      return { matchId: m.id, rows: [row(p1, 1, 3), row(p2, 2, 2), row(p3, 3, 1), row(p4, 4, 0)] };
    },
    start: async (q) => {
      await es.startMatches(q.get('id'));
      return {};
    },
    'close-disputes': async (q) => {
      await es.closeDisputes(q.get('id'));
      return {};
    },
    code: async () => ({ code: h.lastCode(owner.phone) }),
    check: async () => {
      const inv = await invariants.check({ publish: false });
      return {
        invariantsOk: inv.ok,
        ownerPayable: await ledger.balance(`payable:user:${owner.user.id}`),
        p1: await ledger.balance(`payable:user:${people[0].user.id}`),
        feeRevenue: await ledger.balance('fee_revenue:esports_saas'),
        entryEscrow: await ledger.balance('escrow:esports_entry'),
        fundEscrow: await ledger.balance('escrow:esports_prize_fund'),
        invoiceEscrow: await ledger.balance('escrow:fee_invoice'),
        subsidy: await ledger.balance('prize_subsidy_expense'),
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
    listingsToken: listings.accessToken,
    mgrToken: mgr.accessToken,
    ownerToken: owner.accessToken,
    plainToken: plain.accessToken,
    insiderToken: insider.accessToken,
    insiderProfileId: insider.profileId,
    insiderPhone: insider.phone,
    otherToken: otherOwner.accessToken,
    otherOrgId: otherOrg.id,
    stepUpQueueA: stepUps.join(','),
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
