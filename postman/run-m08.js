'use strict';

/**
 * Unattended M08 acceptance run (the Phase 1 exit check) with the Postman CLI.
 *   node postman/run-m08.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in two masters (with email
 * addresses) and a member, pre-mints one settings.write step-up token per master, starts the API on
 * a free port and a worker loop next to it: relay the outbox, run consumers, deliver notifications.
 * Never point this at a real database.
 */
require('../tests/env');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-notifications.postman_collection.json');

async function main() {
  const migrate = spawnSync(process.execPath, ['scripts/release.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' } });
  if (migrate.status !== 0) throw new Error('migrate + seed failed');

  const h = require('../tests/helpers');
  const { createApp } = require('../src/app');
  const { closeAllRedis } = require('../src/common/redis');

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const b = await h.createSecondMaster();
  await h.models.User.update({ displayName: 'Rahim Uddin', email: 'rahim@kriraghor.test', emailVerifiedAt: new Date() }, { where: { id: b.userId } });
  await h.models.User.update({ email: 'ayesha@kriraghor.test', emailVerifiedAt: new Date() }, { where: { id: a.userId } });
  const m = await h.signupUser({ name: 'Fahim Rahman' });
  const vars = {
    adminAccessToken: a.accessToken,
    adminAccessToken2: b.accessToken,
    accessToken: m.accessToken,
    stepUpQueueA: await h.stepUp(a, 'settings.write'),
    stepUpQueueB: await h.stepUp(b, 'settings.write'),
  };

  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  vars.baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  // Mini worker: what the BullMQ worker does, in-process.
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      await h.drainEvents().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('worker loop:', err.message);
      });
      await new Promise((r) => setTimeout(r, 200));
    }
  })();

  const args = ['collection', 'run', `"${collection}"`, ...Object.entries(vars).flatMap(([k, v]) => ['--env-var', `"${k}=${v}"`])];
  const status = await new Promise((resolve) => spawn('postman', args, { stdio: 'inherit', shell: true }).on('close', resolve));

  stop = true;
  await loop;
  await new Promise((r) => server.close(r));
  await closeAllRedis();
  await h.models.sequelize.close();
  process.exit(status ?? 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
