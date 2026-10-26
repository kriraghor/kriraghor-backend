'use strict';

/**
 * Unattended "M24 prompt 2 · Money and billing" acceptance run with the Postman CLI.
 *   node postman/run-m24-money.js
 *
 * Uses the test database (reset; set DB_NAME to keep it apart from other runs): migrates and seeds it,
 * signs in master A and Kriraghor staff with manage_gyms, makes a gym owner with the gym_owner role
 * active and a Basic gym (short code IY), a member "Rafiq Hasan" with a ৳3,500 monthly due whose own
 * account (same phone) pays, and staff with members.view and fees.collect. Serves {{controlUrl}}, a local
 * test-only control (never part of the API):
 *   POST /pay?who=&paymentId=&method=   pay through the SSLCommerz simulator, then deliver events
 *   POST /drain                         deliver events (as the worker would)
 *   POST /release                       gym-manage.online-fee-release 73 hours on; the ledger balances
 *   POST /refunds                       payment jobs (refund settlement), then events
 *   POST /reminders                     the reminder and morning-summary jobs twice on today's clock
 *   POST /payout                        the weekly payout batch → { payoutId }
 *   POST /cycle                         the invoice cycle on the 1st of next month → { invoiceId }
 *   POST /stepup?scope=                 a step-up token for master A
 * Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-gym-manage-money.postman_collection.json');

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
  const rules = require('../src/modules/gym-manage/gym-manage.rules');
  const jobs = require('../src/modules/gym-manage/gym-manage.jobs');
  const ledger = require('../src/modules/payments/ledger.service');
  const invariants = require('../src/modules/payments/invariants.service');
  const payouts = require('../src/modules/payouts/payouts.service');
  const config = require('../src/config');
  const { closeAllRedis } = require('../src/common/redis');
  const { models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const support = await mf.staffWith(a, ['manage_gyms']);
  const { owner, gym, pkg } = await gm.privateGym({ tier: 'basic' });
  await gm.listOwner(owner);
  const payer = await h.signupUser({ name: 'Rafiq Hasan' });
  const added = await gm.addMember(owner, gym.id, { displayName: 'Rafiq Hasan', phone: payer.phone, membership: { packageId: pkg('month').id, startsOn: gm.today() } });
  const cashier = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Tania Cashier' }), ['members.view', 'fees.collect']);
  const today = rules.dhakaDate(new Date());
  const sessions = { owner, payer };

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  const HOUR = 3600000;
  const steps = {
    pay: async (q) => {
      const who = sessions[q.get('who')];
      if (!who) throw new Error(`unknown session ${q.get('who')}`);
      const { returnTo } = await h.payWithSimulator(who, q.get('paymentId'), { method: q.get('method') || 'bkash' });
      await h.drainEvents({ rounds: 10 });
      return { returnTo, gymApp: config.apps.gym };
    },
    drain: async () => {
      await h.drainEvents({ rounds: 10 });
      return {};
    },
    release: async () => {
      const r = await jobs.onlineFeeRelease(new Date(Date.now() + 73 * HOUR));
      return {
        released: r.released,
        payable: await ledger.balance(`payable:user:${owner.user.id}`),
        providerFeeExpense: await ledger.balance('provider_fee_expense'),
        feeRevenue: await ledger.balance('fee_revenue:gym_fee'),
        escrow: await ledger.balance('escrow:gym_membership_fee'),
        invariantsOk: (await invariants.check({ publish: false })).ok,
      };
    },
    refunds: async () => {
      await h.drainPaymentJobs();
      await h.drainEvents({ rounds: 10 });
      return {};
    },
    reminders: async () => {
      const at = new Date(rules.instantOf(today).getTime() + 9 * HOUR);
      const first = await jobs.reminders(at);
      const second = await jobs.reminders(at);
      const firstMorning = await jobs.morningSummary(at);
      const secondMorning = await jobs.morningSummary(at);
      await h.drainEvents({ rounds: 10 });
      return { first, second, firstMorning, secondMorning };
    },
    payout: async () => {
      await payouts.buildBatch({ schedule: 'ground_weekly', windowEnd: new Date(Date.now() + 24 * HOUR) });
      const p = await models.Payout.findOne({ where: { payeeId: owner.user.id }, order: [['createdAt', 'DESC']] });
      return { payoutId: p?.id ?? null };
    },
    cycle: async () => {
      // The subscription started months ago (no first-month proration in this run).
      await models.GymOwnerSubscription.update({ startedOn: rules.addMonths(today, -6) }, { where: { ownerId: owner.user.id } });
      const at = new Date(rules.instantOf(rules.addMonths(today, 1)).getTime() + 2 * HOUR);
      const r = await jobs.invoiceCycle(at);
      const inv = await models.GymSubscriptionInvoice.findOne({ where: { ownerId: owner.user.id } });
      return { issued: r.issued, invoiceId: inv?.id ?? null };
    },
    stepup: async (q) => ({ token: await h.stepUp(a, q.get('scope')) }),
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
    payerToken: payer.accessToken,
    cashierToken: cashier.accessToken,
    adminAccessToken: a.accessToken,
    supportToken: support.accessToken,
    gymId: gym.id,
    dueId: added.due.id,
    memberId: added.member.id,
    ownerId: owner.user.id,
    month: rules.monthOf(today),
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
