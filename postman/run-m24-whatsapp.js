'use strict';

/**
 * Unattended "M24 · WhatsApp" acceptance run with the Postman CLI.
 *   DB_NAME=kriraghor_wa_postman node postman/run-m24-whatsapp.js
 *
 * Uses a test database (reset; set DB_NAME to keep it apart from a jest run): migrates and seeds it, switches
 * WhatsApp sending on for the run (memory driver, test Meta app values from tests/env.js), makes a Standard gym
 * that is published, a desk clerk (members.view, members.edit), Amin (linked, with a membership) and Bithi
 * (a membership, no consent). Never point this at a real database.
 */
require('../tests/env');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-gym-whatsapp.postman_collection.json');

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
  for (const [k, val] of Object.entries({ 'gym_whatsapp.api_enabled': true, 'gym_whatsapp.included': 20, 'notify.quiet_hours_start': '03:00', 'notify.quiet_hours_end': '03:00' })) await h.setSettingForTest(k, val);

  const { owner, gym, pkg } = await gm.privateGym({ tier: 'standard' });
  await models.Gym.update({ status: 'live', liveVersion: 1, liveSnapshot: { name: gym.name, addressLine: 'House 9, Road 11, Banani, Dhaka', photos: [], packages: [], hours: [] } }, { where: { id: gym.id } });
  const slug = (await models.Gym.findByPk(gym.id)).slug;
  const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rumi' }), ['members.view', 'members.edit']);
  const aminUser = await h.signupUser({ name: 'Amin Uddin' });
  const amin = await gm.addMember(owner, gym.id, { displayName: 'Amin Uddin', phone: aminUser.phone, membership: { packageId: pkg('month').id, startsOn: gm.today() } });
  await gm.linkMember(owner, gym.id, amin.member.id, aminUser);
  const bithi = await gm.addMember(owner, gym.id, { displayName: 'Bithi Akter', membership: { packageId: pkg('month').id, startsOn: gm.today() } });

  const vars = {
    ownerToken: owner.accessToken,
    deskToken: desk.accessToken,
    aminToken: aminUser.accessToken,
    gymId: gym.id,
    slug,
    aminMember: amin.member.id,
    bithiMember: bithi.member.id,
    appSecret: process.env.META_APP_SECRET,
    ...Object.fromEntries([1, 2, 3, 4].map((n) => [`k${n}`, crypto.randomUUID()])),
  };
  const server = require('../src/app').createApp().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  vars.baseUrl = `http://127.0.0.1:${port}/api/v1`;

  const args = ['collection', 'run', `"${collection}"`, ...Object.entries(vars).flatMap(([k, val]) => ['--env-var', `"${k}=${val}"`])];
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
