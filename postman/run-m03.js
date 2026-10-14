'use strict';

/**
 * Unattended M03 acceptance run with the Postman CLI.
 *   node postman/run-m03.js
 *
 * Uses the kriraghor_test database (it is reset, like `npm test` does): migrates and seeds it,
 * creates two masters (four-eyes), signs them in with OTP + TOTP from the in-memory providers,
 * pre-mints settings.write step-up tokens, starts the API on a free port and runs the collection.
 * Never point this at a real database.
 */
require('../tests/env');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-settings.postman_collection.json');
const FOLDERS = ['0. Public (no sign-in)', '1. Admin reads (master A)', '2. Guards', '3. Single-approval change (applies at once)', '4. Four-eyes fee change (A proposes, B approves)', '5. Esports catalogue (master A)'];
// Writes per master in the folders above; each consumes one single-use step-up token.
const TOKENS = { A: 4, B: 2 };

async function main() {
  const migrate = spawnSync(process.execPath, ['scripts/release.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' } });
  if (migrate.status !== 0) throw new Error('migrate + seed failed');

  const h = require('../tests/helpers');
  const { createApp } = require('../src/app');
  const { closeAllRedis } = require('../src/common/redis');

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const b = await h.createSecondMaster();
  const queue = async (session, n) => {
    const list = [];
    for (let i = 0; i < n; i += 1) list.push(await h.stepUp(session, 'settings.write'));
    return list.join(',');
  };
  const vars = {
    adminAccessToken: a.accessToken,
    adminAccessToken2: b.accessToken,
    stepUpQueueA: await queue(a, TOKENS.A),
    stepUpQueueB: await queue(b, TOKENS.B),
  };

  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  vars.baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  const args = ['collection', 'run', `"${collection}"`, ...FOLDERS.flatMap((f) => ['-i', `"${f}"`]), ...Object.entries(vars).flatMap(([k, v]) => ['--env-var', `"${k}=${v}"`])];
  // Async: the API answers from this same process while the CLI runs.
  const status = await new Promise((resolve) => spawn('postman', args, { stdio: 'inherit', shell: true }).on('close', resolve));

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
