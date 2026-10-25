'use strict';

/**
 * Unattended "M24 prompt 1 · Desk" acceptance run with the Postman CLI.
 *   node postman/run-m24.js
 *
 * Uses the test database (reset; set DB_NAME to keep it apart from other runs): migrates and seeds it,
 * signs in master A, a gym owner with only a verified phone, the member who will accept the invite,
 * the person who becomes front-desk staff and a Kriraghor staff member with manage_gyms. Writes the
 * import file m24-members.csv (dates relative to today) into a temporary working directory and serves
 * {{controlUrl}}, a local test-only control (never part of the API):
 *   POST /refresh?who=   a fresh access token for a session whose access changed (desk, owner)
 *   POST /drain          deliver events (as the worker would)
 *   POST /daily          run gym-manage.daily and gym-manage.dues-overdue twice; the second runs change nothing
 * Never point this at a real database.
 */
require('../tests/env');
const fs = require('fs');
const os = require('os');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-gym-manage.postman_collection.json');

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
  const rules = require('../src/modules/gym-manage/gym-manage.rules');
  const jobs = require('../src/modules/gym-manage/gym-manage.jobs');
  const { closeAllRedis } = require('../src/common/redis');
  const { models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const owner = await h.signupUser({ name: 'Karim Uddin' });
  const person = await h.signupUser({ name: 'Rafiq Hasan' });
  const desk = await h.signupUser({ name: 'Tania Desk' });
  const support = await mf.staffWith(a, ['manage_gyms']);
  const today = rules.dhakaDate(new Date());

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-m24-'));
  const csv = [
    'Name,Phone,Gender,Date of birth,Package,Start,End,Last payment date,Last payment amount,Amount due,Member code',
    `Sakib Khan,01711000301,male,1995-01-15,Monthly,${rules.addDays(today, -10)},,${rules.addDays(today, -10)},2500,0,`,
    `Mitu Akter,01811000302,female,,Quarterly,${rules.addDays(today, -30)},,,,6500,`,
    'Tamim Iqbal,01911000303,,,,,,,,,',
    `Duplicate Phone,${person.phone},,,,,,,,,`,
  ].join('\n');
  fs.writeFileSync(path.join(work, 'm24-members.csv'), String.fromCharCode(0xfeff) + `${csv}\n`);

  const sessions = { owner, person, desk };
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
      await mf.refresh(who);
      return { accessToken: who.accessToken };
    },
    drain: async () => {
      await h.drainEvents({ rounds: 10 });
      return {};
    },
    daily: async () => {
      const first = await jobs.daily();
      const second = await jobs.daily();
      const firstOverdue = await jobs.duesOverdue();
      const secondOverdue = await jobs.duesOverdue();
      return { first, second, firstOverdue, secondOverdue };
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
    personToken: person.accessToken,
    personPhone: person.phone,
    // deskToken is not passed: the collection saves it from /refresh after the hire (an environment value would win).
    deskPhone: desk.phone,
    supportToken: support.accessToken,
    areaBanani: (await models.Area.findOne({ where: { key: 'banani' } })).id,
    today,
    yesterday: rules.addDays(today, -1),
    in3: rules.addDays(today, 3),
    ikAdd: `pm-add-${Date.now()}`,
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

  const args = ['collection', 'run', `"${collection}"`, '--working-dir', `"${work}"`, ...Object.entries(vars).flatMap(([k, v]) => ['--env-var', `"${k}=${v}"`])];
  const status = await new Promise((resolve) => spawn('postman', args, { stdio: 'inherit', shell: true }).on('close', resolve));

  stop = true;
  await loop;
  await new Promise((r) => server.close(r));
  await new Promise((r) => control.close(r));
  fs.rmSync(work, { recursive: true, force: true });
  await closeAllRedis();
  await models.sequelize.close();
  process.exit(status ?? 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
