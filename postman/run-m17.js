'use strict';

/**
 * Unattended M17 acceptance run with the Postman CLI.
 *   node postman/run-m17.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in master A, an owner
 * (fixtures: a live ground at ৳2,000/h flat, 25% advance), two members, three staff (desk with
 * refund_small, desk only, desk with manage_users), three eligible reporters (NID-verified, accounts
 * ten days old) and a member to report. It prepares a no-show booking (b1, ৳500 retained) and two
 * played bookings (b2, b3), lowers refunds.staff_limit_poisha to ৳300 (so ৳500 needs a master), and
 * serves {{controlUrl}}, a local test-only control (never part of the API). Round B1 review sources:
 * a live pro profile whose job for member was paid out, a live shop whose sub-order for member was
 * received, and a live gym where member2's day pass was admitted.
 *   POST /gympass                      a newer gym pass for member2, used (returns passId)
 *   POST /settle                       drain events
 *   POST /noshow?who=member|member2    a new booking marked a no-show (returns bookingId)
 *   POST /tick?plusHours=              bookings.tick as if plusHours later (no-show settlement)
 *   POST /dtick?plusHours=             trust.tick as if plusHours later (respondent timeouts, SLAs)
 *   POST /check                        owner A's payable balance and the ledger invariants
 * Runs with --working-dir postman/fixtures (the evidence files). Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-disputes.postman_collection.json');
const fixtures = path.join(__dirname, 'fixtures');
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
  const disputes = require('../src/modules/trust/disputes.service');
  const { api, P, models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  let emp = 0;
  const staffWith = async (permissions, name) => {
    emp += 1;
    const s = await h.signupUser({ name });
    await api().post(`${P}/admin/staff`).set(h.bearer(a)).set('X-Step-Up', await h.stepUp(a, 'staff.write')).send({ userId: s.user.id, employeeId: `KG-PM-${emp}`, permissions }).expect(201);
    return h.signInStaff(s.phone, s.user.id);
  };
  const owner = await fx.owner('Kamal Hossain');
  const ground = await fx.liveGround(owner, { name: 'Mirpur Turf Arena' });
  const member = await h.signupUser({ name: 'Rafi Ahmed' });
  const member2 = await h.signupUser({ name: 'Nadia Islam' });
  const staff = await staffWith(['resolve_reports', 'refund_small'], 'Sadia Rahman');
  const staff2 = await staffWith(['resolve_reports'], 'Imran Hasan');
  const ops = await staffWith(['resolve_reports', 'manage_users'], 'Ops Lead');
  const reporters = [];
  for (const name of ['Reporter One', 'Reporter Two', 'Reporter Three']) {
    const r = await h.signupUser({ name });
    await h.verifyMember(r.user.id);
    await models.sequelize.query("UPDATE users SET created_at = now() - interval '10 days' WHERE id = :id", { replacements: { id: r.user.id } });
    reporters.push(await fx.refresh(r));
  }
  const target = await h.signupUser({ name: 'Scam Account' });
  await h.setSettingForTest('refunds.staff_limit_poisha', 30000);

  // Bookings: each in its own hour so fixtures never collide on the court.
  let hour = 0;
  const slot = () => new Date(Math.ceil((Date.now() + 86400000) / HALF) * HALF + (hour += 2) * HALF).toISOString();
  const people = { member, member2 };
  async function book(who) {
    const r = await api().post(`${P}/bookings/holds`).set(h.bearer(who)).set('Idempotency-Key', `pm-hold-${(hour += 1)}-${Date.now()}`).send({ groundId: ground.id, courtIds: [ground.courts[0]], start: slot(), minutes: 60, payment: 'advance' }).expect(201);
    await h.payWithSimulator(who, r.body.payment.id);
    await h.drainEvents();
    return models.Booking.findByPk(r.body.booking.id);
  }
  let past = 0;
  async function noShow(who) {
    const b = await book(who);
    await fx.moveTo(b, Date.now() - (1 + (past += 2)) * 3600000);
    await api().post(`${P}/me/ground-bookings/${b.id}/no-show`).set(h.bearer(owner)).expect(200);
    await h.drainEvents();
    return b.id;
  }
  async function played(who) {
    const b = await book(who);
    await fx.moveTo(b, Date.now() - (26 + (past += 2)) * 3600000);
    await bookings.tick();
    await h.drainEvents();
    return b.id;
  }
  const b1 = await noShow(member);
  const b2 = await played(member);
  const b3 = await played(member2);

  // Round B1 review sources: member hires a pro (a released job) and buys from a shop (a completed
  // sub-order); member2 uses a gym day pass at the front desk.
  const hx = require('../tests/fixtures/hire');
  const mx = require('../tests/fixtures/market');
  const gx = require('../tests/fixtures/gym');
  const lister = await staffWith(['approve_listings'], 'Listing Reviewer');
  const docs = await staffWith(['approve_documents'], 'Documents Reviewer');
  const { pro, profile } = await hx.liveProfile({ docsReviewer: docs, reviewer: lister });
  const hr = await api().post(`${P}/hire/requests`).set(h.bearer(member)).set('Idempotency-Key', `pm-hr-${Date.now()}`).send(await hx.matchRequest(profile.id, [hx.at1930(4)])).expect(201);
  await api().post(`${P}/pro/requests/${hr.body.request.id}/accept`).set(h.bearer(pro)).expect(200);
  await h.payWithSimulator(member, (await models.HireRequest.findByPk(hr.body.request.id)).paymentId);
  await h.drainEvents();
  const job = await models.HireJob.findOne({ where: { requestId: hr.body.request.id } });
  await hx.moveJob(job.id, 5);
  await api().post(`${P}/pro/jobs/${job.id}/check-in`).set(h.bearer(pro)).expect(200);
  await api().post(`${P}/pro/jobs/${job.id}/complete`).set(h.bearer(pro)).send({ note: 'Umpired the full match' }).expect(200);
  await api().post(`${P}/me/hire-jobs/${job.id}/confirm`).set(h.bearer(member)).send({}).expect(200);
  const seller = await mx.shopOwner(docs, 'Nayeem Sports');
  const shop = await mx.liveShop(seller, lister, { name: 'Nayeem Sports' });
  const boots = await mx.liveProduct(seller, lister, await mx.readyBoots(seller, { sizes: ['42'], stock: 2 }));
  await api().put(`${P}/me/cart/items/${boots.variants[0].id}`).set(h.bearer(member)).send({ qty: 1 }).expect(200);
  const ship = { name: 'Rafi Ahmed', phone: '01711000111', areaId: await mx.areaId('dhanmondi'), line: 'House 12, Road 5, Dhanmondi' };
  const quote = (await api().post(`${P}/checkout/quote`).set(h.bearer(member)).send({ areaId: ship.areaId }).expect(200)).body.total;
  const placed = await api().post(`${P}/checkout`).set(h.bearer(member)).set('Idempotency-Key', `pm-co-${Date.now()}`).send({ ship, expectedTotal: quote }).expect(201);
  await h.payWithSimulator(member, placed.body.payment.id);
  await h.drainEvents();
  const sub = await models.SubOrder.findOne({ where: { orderId: placed.body.order.id } });
  for (const [action, body] of [['accept'], ['ship', { courierName: 'Pathao', trackingNo: 'PTH-1001' }], ['delivered']]) await api().post(`${P}/shop/sub-orders/${sub.id}/${action}`).set(h.bearer(seller)).send(body ?? {}).expect(200);
  await api().post(`${P}/me/sub-orders/${sub.id}/received`).set(h.bearer(member)).send({}).expect(200);
  const gymOwner = await gx.gymOwner(docs);
  const gym = await gx.liveGym(gymOwner, lister);
  const dayPass = gym.packages.find((p) => p.kind === 'day').id;
  async function gymPass(validFrom) {
    const r = await api().post(`${P}/gym/passes`).set(h.bearer(member2)).set('Idempotency-Key', `pm-gp-${Date.now()}-${(hour += 1)}`).send({ packageId: dayPass, validFrom }).expect(201);
    await h.payWithSimulator(member2, r.body.payment.id);
    await h.drainEvents();
    return models.GymPass.findOne({ where: { code: r.body.pass.code } });
  }
  const pass1 = await gymPass(gx.today());
  const token = (await api().get(`${P}/me/passes/${pass1.code}`).set(h.bearer(member2)).expect(200)).body.pass.token;
  await api().post(`${P}/me/gyms/${gym.id}/redemptions`).set(h.bearer(gymOwner)).send({ token }).expect(201);
  await h.drainEvents();

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  const later = (q) => new Date(Date.now() + Number(q.get('plusHours') ?? 0) * 3600000);
  const steps = {
    settle: async () => {
      await h.drainEvents();
      return {};
    },
    noshow: async (q) => ({ bookingId: await noShow(people[q.get('who') ?? 'member']) }),
    tick: async (q) => ({ tick: await bookings.tick(later(q)) }),
    dtick: async (q) => ({ tick: await disputes.tick(later(q)) }),
    // A newer gym pass for member2, used (as if admitted at the desk tomorrow).
    gympass: async () => {
      const p = await gymPass(gx.inDays(1));
      await p.update({ status: 'redeemed', firstRedeemedAt: new Date(), lastRedeemedAt: new Date() });
      return { passId: p.id };
    },
    check: async () => ({ invariantsOk: (await invariants.check({ publish: false })).ok, ownerPayable: await ledger.balance(`payable:user:${owner.user.id}`) }),
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
    member2Token: member2.accessToken,
    staffToken: staff.accessToken,
    staff2Token: staff2.accessToken,
    opsToken: ops.accessToken,
    r1Token: reporters[0].accessToken,
    r2Token: reporters[1].accessToken,
    r3Token: reporters[2].accessToken,
    targetUserId: target.user.id,
    groundId: ground.id,
    groundSlug: ground.slug,
    b1,
    b2,
    b3,
    proToken: pro.accessToken,
    sellerToken: seller.accessToken,
    gymOwnerToken: gymOwner.accessToken,
    hireJobId: job.id,
    hireProfileId: profile.id,
    subOrderId: sub.id,
    shopId: shop.id,
    gymPassId: pass1.id,
    gymId: gym.id,
    stepUpQueueA: await h.stepUp(a, 'refund.large'),
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
