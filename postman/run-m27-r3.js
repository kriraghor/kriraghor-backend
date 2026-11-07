'use strict';

/**
 * Unattended "M27 round 3 · Staff and equipment" acceptance run with the Postman CLI.
 *   node postman/run-m27-r3.js
 *
 * Uses the test database (reset; set DB_NAME to keep it apart from other runs): migrates and seeds it,
 * makes a gym owner with a Pro gym, a member assigned to the trainer with a month's due, and four staff: Rumi
 * (attendance.mark, members.view, clock.in), Tania (members.view, members.trainer, pos.sell, clock.in), a
 * technician (assets.manage) and Other (members.view). Serves {{controlUrl}}, a local test-only control
 * (never part of the API):
 *   POST /backdate?staffId=&minutes=   move a staff member's clock rows back (the table is append-only)
 *   POST /clockout                     the job that closes clock-ins left open
 *   POST /service                      the equipment service reminders (part of gym-ops.daily)
 *   POST /drain                        deliver events (as the worker would)
 * Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-gym-ops-r3.postman_collection.json');

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
  const staff = require('../src/modules/gym-ops/staff.service');
  const assets = require('../src/modules/gym-ops/assets.service');
  const { closeAllRedis } = require('../src/common/redis');
  const { models } = h;

  await h.resetDb();
  await h.createSignedInMaster();
  const { owner, gym, pkg } = await gm.privateGym({ tier: 'pro' });
  const hire = async (name, perms) => {
    const who = await gm.hire(owner, gym.id, await h.signupUser({ name }), perms);
    const row = await models.BusinessMember.findOne({ where: { businessId: gym.id, memberId: who.user.id } });
    return { who, id: row.id };
  };
  const rumi = await hire('Desk Rumi', ['attendance.mark', 'members.view', 'clock.in']);
  const tania = await hire('Coach Tania', ['members.view', 'members.trainer', 'pos.sell', 'clock.in']);
  const tech = await hire('Tech Rafi', ['assets.manage']);
  const other = await hire('Other Staff', ['members.view']);
  const m = await gm.addMember(owner, gym.id, { displayName: 'Lima Akter', membership: { packageId: pkg('month').id, startsOn: gm.today() } });
  await models.GymMember.update({ trainerBusinessMemberId: tania.id }, { where: { id: m.member.id } });

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  const steps = {
    backdate: async (q) => {
      await models.sequelize.query('ALTER TABLE gym_staff_times DISABLE TRIGGER trg_gym_staff_times_append_only');
      try {
        await models.sequelize.query("UPDATE gym_staff_times SET at = at - (:ms || ' milliseconds')::interval WHERE business_member_id = :id", { replacements: { id: q.get('staffId'), ms: String(Number(q.get('minutes')) * 60000) } });
      } finally {
        await models.sequelize.query('ALTER TABLE gym_staff_times ENABLE TRIGGER trg_gym_staff_times_append_only');
      }
      return {};
    },
    clockout: async () => staff.autoClockOut(),
    service: async () => assets.serviceReminders(),
    drain: async () => {
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
    rumiToken: rumi.who.accessToken,
    taniaToken: tania.who.accessToken,
    techToken: tech.who.accessToken,
    otherToken: other.who.accessToken,
    gymId: gym.id,
    rumiId: rumi.id,
    taniaId: tania.id,
    otherId: other.id,
    memberDueId: m.due.id,
    period: gm.today().slice(0, 7),
    boughtOn: gm.inDays(-29),
    tomorrow: gm.inDays(1),
    in30: gm.inDays(30),
    today: gm.today(),
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
