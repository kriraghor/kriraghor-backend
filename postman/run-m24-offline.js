'use strict';

/**
 * Unattended "M24 · The desk through a lost connection" acceptance run with the Postman CLI.
 *   node postman/run-m24-offline.js
 *
 * Uses the test database (reset; set DB_NAME to keep it apart from other runs): migrates and seeds it, makes
 * a Basic gym, a desk clerk (attendance.mark, fees.collect, members.view), a door keeper (attendance.mark),
 * a coach (plans.manage), Rafiq (Monthly from today, ৳1,000 paid) and Tanvir (his month ended 30 days ago,
 * the due overdue). Never point this at a real database.
 */
require('../tests/env');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-gym-offline.postman_collection.json');

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

  const { owner, gym, pkg } = await gm.privateGym({ tier: 'basic' });
  const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rumi' }), ['attendance.mark', 'fees.collect', 'members.view']);
  const door = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Door Sumon' }), ['attendance.mark']);
  const coach = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Coach Tania' }), ['plans.manage']);
  const rafiq = await gm.addMember(owner, gym.id, { displayName: 'Rafiq Hasan', membership: { packageId: pkg('month').id, startsOn: gm.today() }, payment: { amountPoisha: 100000, method: 'cash' } });
  const tanvir = await gm.addMember(owner, gym.id, { displayName: 'Tanvir Ahmed', membership: { packageId: pkg('month').id, startsOn: gm.inDays(-30) } });

  const vars = {
    ownerToken: owner.accessToken,
    deskToken: desk.accessToken,
    deskUser: desk.user.id,
    doorToken: door.accessToken,
    coachToken: coach.accessToken,
    gymId: gym.id,
    rafiqMember: rafiq.member.id,
    rafiqDue: rafiq.due.dueId ?? rafiq.due.id,
    tanvirMember: tanvir.member.id,
    tanvirDue: tanvir.due.dueId ?? tanvir.due.id,
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`c${n}`, crypto.randomUUID()])),
  };
  const server = require('../src/app').createApp().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  vars.baseUrl = `http://127.0.0.1:${port}/api/v1`;

  const args = ['collection', 'run', `"${collection}"`, ...Object.entries(vars).flatMap(([k, v]) => ['--env-var', `"${k}=${v}"`])];
  const status = await new Promise((resolve) => spawn('postman', args, { stdio: 'inherit', shell: true }).on('close', resolve));

  await new Promise((r) => server.close(r));
  await closeAllRedis();
  await models.sequelize.close();
  process.exit(status ?? 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
