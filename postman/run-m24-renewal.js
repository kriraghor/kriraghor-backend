'use strict';

/**
 * Unattended "M24 · A member renews by themselves, and body progress" acceptance run with the Postman CLI.
 *   node postman/run-m24-renewal.js
 *
 * Uses the test database (reset; set DB_NAME to keep it apart from other runs): migrates and seeds it, makes
 * a Standard gym whose owner may take fees online, with two members linked to accounts (Rafi on a Monthly
 * package that started 20 days ago, Lima on one that started today), desk staff (members.view,
 * fees.collect), a coach (plans.manage, members.view), a signed-in stranger, and a Basic gym with one
 * linked member. Serves {{controlUrl}}, a local test-only control (never part of the API):
 *   POST /drain                 deliver events (as the worker would)
 *   POST /pay?paymentId=        pay that payment as Rafi through the gateway simulator, then deliver events
 * Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-gym-renewal.postman_collection.json');

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
  const gm = require('../tests/fixtures/gym-manage');
  const { closeAllRedis } = require('../src/common/redis');
  const { models } = h;

  await h.resetDb();
  await h.createSignedInMaster();

  /** A member with a Monthly package that started `daysAgo` days ago, linked to a new account. */
  const linked = async (owner, gym, pkg, name, daysAgo) => {
    const who = await h.signupUser({ name });
    const added = await gm.addMember(owner, gym.id, { displayName: name, phone: who.phone, ...(pkg ? { membership: { packageId: pkg.id, startsOn: gm.inDays(-daysAgo) } } : {}) });
    await gm.linkMember(owner, gym.id, added.member.id, who);
    return { who, member: added.member };
  };

  const { owner, gym, pkg } = await gm.privateGym({ tier: 'standard' });
  await gm.listOwner(owner);
  const rafi = await linked(owner, gym, pkg('month'), 'Rafi Ahmed', 20);
  const lima = await linked(owner, gym, pkg('month'), 'Lima Akter', 0);
  const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rumi' }), ['members.view', 'fees.collect']);
  const coach = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Coach Tania' }), ['plans.manage', 'members.view']);
  const other = await h.signupUser({ name: 'Other Person' });
  const basicGym = await gm.privateGym({ name: 'Basic Gym', shortCode: 'BG', tier: 'basic' });
  const basic = await linked(basicGym.owner, basicGym.gym, null, 'Basic Member', 0);

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  const steps = {
    drain: async () => {
      await h.drainEvents({ rounds: 10 });
      return {};
    },
    pay: async (q) => {
      await h.payWithSimulator(rafi.who, q.get('paymentId'));
      await h.drainEvents({ rounds: 10 });
      return {};
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
    controlUrl: `http://127.0.0.1:${controlPort}`,
    ownerToken: owner.accessToken,
    deskToken: desk.accessToken,
    coachToken: coach.accessToken,
    rafiToken: rafi.who.accessToken,
    rafiMember: rafi.member.id,
    limaToken: lima.who.accessToken,
    limaMember: lima.member.id,
    otherToken: other.accessToken,
    basicOwnerToken: basicGym.owner.accessToken,
    basicGymId: basicGym.gym.id,
    basicToken: basic.who.accessToken,
    basicMember: basic.member.id,
    gymId: gym.id,
    monthPkg: pkg('month').id,
    quarterPkg: pkg('quarter').id,
    deskPkg: pkg('custom').id,
    today: gm.today(),
    tomorrow: gm.inDays(1),
    in10: gm.inDays(10),
    in15: gm.inDays(15),
    in39: gm.inDays(39),
    back60: gm.inDays(-60),
    back400: gm.inDays(-400),
  };
  const server = require('../src/app').createApp().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  vars.baseUrl = `http://127.0.0.1:${port}/api/v1`;

  const args = ['collection', 'run', `"${collection}"`, ...Object.entries(vars).flatMap(([k, v]) => ['--env-var', `"${k}=${v}"`])];
  const status = await new Promise((resolve) => spawn('postman', args, { stdio: 'inherit', shell: true }).on('close', resolve));

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
