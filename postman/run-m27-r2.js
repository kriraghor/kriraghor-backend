'use strict';

/**
 * Unattended "M27 round 2 · Members and engagement" acceptance run with the Postman CLI.
 *   node postman/run-m27-r2.js
 *
 * Uses the test database (reset; set DB_NAME to keep it apart from other runs): migrates and seeds it,
 * makes a gym owner with a published Standard gym, two members with a month each whose own accounts are
 * linked (Lima Akter, Rafi Khan), a member who has not paid yet (Friend Faruk), and three staff: a trainer
 * (classes.manage, members.view), a cashier (members.view, rewards.redeem) and a desk hand
 * (attendance.mark, members.view). Serves {{controlUrl}}, a local test-only control (never part of the API):
 *   POST /drain                         deliver events (as the worker would)
 *   POST /visits-close                  the job that closes visits left open
 *   POST /soon?sessionId=&minutes=      move a class session to start in N minutes (negative: started)
 *   POST /reminders                     the class reminder job
 * Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-gym-ops-r2.postman_collection.json');

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
  const rules = require('../src/modules/gym-ops/gym-ops.rules');
  const visits = require('../src/modules/gym-manage/visits.service');
  const classes = require('../src/modules/gym-ops/classes.service');
  const { closeAllRedis, getRedis } = require('../src/common/redis');
  const config = require('../src/config');
  const { models } = h;

  await h.resetDb();
  // The enquiry and reveal limits live in Redis and outlast the database reset (a jest run from 127.0.0.1
  // in the same hour counts too): start them at zero. Test Redis only.
  const redis = getRedis();
  for (const name of ['gym_lead_ip', 'gym_lead_phone', 'gym_phone_reveal']) {
    const keys = await redis.keys(`${config.redis.prefix}:vel:${name}:*`);
    if (keys.length) await redis.del(...keys);
  }
  await h.createSignedInMaster();
  const { owner, gym, pkg } = await gm.privateGym({ tier: 'standard' });
  // Published, so the gym page shows the timetable and takes enquiries (the runner's shortcut past review).
  await models.Gym.update({ status: 'live', liveVersion: 1, liveSnapshot: { name: gym.name } }, { where: { id: gym.id } });
  const linked = async (name) => {
    const who = await h.signupUser({ name });
    const added = await gm.addMember(owner, gym.id, { displayName: name, phone: who.phone, membership: { packageId: pkg('month').id, startsOn: gm.today() } });
    await gm.linkMember(owner, gym.id, added.member.id, who);
    return { who, member: added.member };
  };
  const lima = await linked('Lima Akter');
  const rafi = await linked('Rafi Khan');
  const friend = await gm.addMember(owner, gym.id, { displayName: 'Friend Faruk', membership: { packageId: pkg('month').id, startsOn: gm.today() } });
  const trainer = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Coach Tania' }), ['classes.manage', 'members.view']);
  const cashier = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Cashier Mitu' }), ['members.view', 'rewards.redeem']);
  const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rumi' }), ['attendance.mark', 'members.view']);

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  const MIN = 60000;
  const steps = {
    drain: async () => {
      await h.drainEvents({ rounds: 10 });
      return {};
    },
    'visits-close': async () => visits.closeStale(),
    soon: async (q) => {
      const s = await models.GymClassSession.findByPk(q.get('sessionId'));
      if (!s) throw new Error('no such session');
      const startsAt = new Date(Date.now() + Number(q.get('minutes')) * MIN);
      await s.update({ startsAt, endsAt: new Date(startsAt.getTime() + 45 * MIN) });
      return { startsAt };
    },
    reminders: async () => {
      const r = await classes.reminders();
      await h.drainEvents({ rounds: 10 });
      return r;
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

  const tomorrow = gm.inDays(1);
  const vars = {
    controlUrl: `http://127.0.0.1:${controlPort}`,
    ownerToken: owner.accessToken,
    trainerToken: trainer.accessToken,
    trainerUserId: trainer.user.id,
    cashierToken: cashier.accessToken,
    deskToken: desk.accessToken,
    limaToken: lima.who.accessToken,
    rafiToken: rafi.who.accessToken,
    gymId: gym.id,
    gymSlug: gym.slug,
    limaId: lima.member.id,
    rafiId: rafi.member.id,
    friendId: friend.member.id,
    friendDueId: friend.due.id,
    tomorrow,
    dow: rules.dowOf(tomorrow),
    from: gm.today(),
    to: gm.inDays(27),
  };
  const server = require('../src/app').createApp().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  vars.baseUrl = `http://127.0.0.1:${port}/api/v1`;

  // No background drain loop: points, promotions and notices are delivered by the "Runner: deliver events"
  // steps, so the checks that follow them see a settled state.
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
