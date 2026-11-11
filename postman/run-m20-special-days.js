'use strict';

/**
 * Unattended "M20 · Holidays and special hours, M27 · Conversion report" acceptance run with the Postman CLI.
 *   node postman/run-m20-special-days.js
 *
 * Uses the test database (reset; set DB_NAME to keep it apart from other runs): migrates and seeds it, makes a
 * Standard gym (published, open 06:00 to 22:00 every day, trial visits on) with a class tomorrow at 06:30 and
 * one member booked into it, a guest with a visit booked tomorrow at 18:00, a second guest, desk staff
 * (attendance.mark, classes.manage), an accountant (reports.view) and another gym's owner. Serves
 * {{controlUrl}}, a local test-only control (never part of the API):
 *   POST /drain          deliver events (as the worker would)
 *   POST /visits-today   date the gym's visits today, so the month's report holds them on any day of the month
 * Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-gym-special-days.postman_collection.json');

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
  const rules = require('../src/modules/gym/gym.rules');
  const { closeAllRedis } = require('../src/common/redis');
  const { models } = h;

  await h.resetDb();
  await h.clearVelocity('gym_lead_');
  await h.createSignedInMaster();
  const hours = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, openTime: '06:00', closeTime: '22:00', womenOnly: false }));
  const { owner, gym } = await gm.privateGym({ tier: 'standard' });
  await models.Gym.update(
    { status: 'live', liveVersion: 1, liveSnapshot: { name: gym.name, areaId: null, addressLine: 'Road 11, Banani', photos: [], packages: [], facilityIds: [], hours } },
    { where: { id: gym.id } }
  );
  const slug = (await models.Gym.findByPk(gym.id)).slug;
  const g = gm.manage(owner, gym.id);
  const tomorrow = gm.inDays(1);

  // A class tomorrow morning with one member booked, and a guest's free visit tomorrow evening.
  const pkg = (await g.get('/packages').expect(200)).body.items.find((p) => p.kind === 'month');
  const rafi = await gm.addMember(owner, gym.id, { displayName: 'Rafi Ahmed', membership: { packageId: pkg.id, startsOn: gm.today() } });
  const klass = (await g.post('/classes', { name: 'Morning HIIT', capacity: 10, minutes: 45, slots: [{ dow: rules.dowOf(tomorrow), startTime: '06:30' }] }).expect(201)).body;
  const sessions = (await g.get(`/class-sessions?from=${gm.today()}&to=${gm.inDays(7)}`).expect(200)).body.items;
  const session = sessions.find((s) => s.classId === klass.id && s.localDate === tomorrow);
  await h.api().post(`${h.P}/manage/gyms/${gym.id}/class-sessions/${session.id}/bookings`).set(h.bearer(owner)).set('Idempotency-Key', gm.key()).send({ memberId: rafi.member.id }).expect(201);
  await g.patch('/settings', { visitsOpen: true }).expect(200);
  const ana = await h.signupUser({ name: 'Guest Ana' });
  const bo = await h.signupUser({ name: 'Guest Bo' });
  await h.api().post(`${h.P}/me/gym-visits`).set(h.bearer(ana)).set('Idempotency-Key', gm.key()).send({ gymId: gym.id, date: tomorrow, arriveAt: '18:00' }).expect(201);

  const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rumi' }), ['attendance.mark', 'classes.manage']);
  const account = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Accountant Mina' }), ['reports.view']);
  const other = await gm.privateGym({ name: 'Other Gym', shortCode: 'OG' });

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
    'visits-today': async () => {
      await models.GymVisit.update({ visitDate: gm.today() }, { where: { gymId: gym.id } });
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
    accountToken: account.accessToken,
    anaToken: ana.accessToken,
    boToken: bo.accessToken,
    otherOwnerToken: other.owner.accessToken,
    gymId: gym.id,
    slug,
    sessionId: session.id,
    today: gm.today(),
    tomorrow,
    in2: gm.inDays(2),
    in5: gm.inDays(5),
    in7: gm.inDays(7),
    in61: gm.inDays(61),
    yesterday: gm.inDays(-1),
    month: gm.today().slice(0, 7),
  };
  const server = require('../src/app').createApp().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  vars.baseUrl = `http://127.0.0.1:${port}/api/v1`;

  const args = ['collection', 'run', `"${collection}"`, ...Object.entries(vars).flatMap(([k, v]) => ['--env-var', `"${k}=${v}"`])];
  const status = await new Promise((resolve) => spawn('postman', args, { stdio: 'inherit', shell: true }).on('close', resolve));

  await new Promise((r) => server.close(r));
  await new Promise((r) => control.close(r));
  await h.clearVelocity('gym_lead_');
  await closeAllRedis();
  await models.sequelize.close();
  process.exit(status ?? 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
