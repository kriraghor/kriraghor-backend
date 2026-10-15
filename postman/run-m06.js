'use strict';

/**
 * Unattended M06 acceptance run with the Postman CLI.
 *   node postman/run-m06.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in a master, a payer and a
 * payee, pre-mints the master's escrow.manage step-up token, starts the API on a free port (with the
 * SSLCommerz simulator mounted, so the gateway page is reachable from Postman) and a worker loop next
 * to it: relay the outbox, run consumers and deliveries, and run payment jobs (refund calls and polls).
 * Never point this at a real database.
 */
require('../tests/env');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-payments.postman_collection.json');

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

  // The gateway page and the return URL must point at this server (config reads it at load time).
  const port = await freePort();
  process.env.API_PUBLIC_URL = `http://127.0.0.1:${port}`;

  const h = require('../tests/helpers');
  const { closeAllRedis } = require('../src/common/redis');

  await h.resetDb();
  const master = await h.createSignedInMaster();
  const payer = await h.signupUser({ name: 'Fahim Rahman' });
  const payee = await h.signupUser({ name: 'Nusrat Jahan' });
  const vars = {
    adminAccessToken: master.accessToken,
    accessToken: payer.accessToken,
    payerId: payer.user.id,
    payeeId: payee.user.id,
    stepUpQueueA: await h.stepUp(master, 'escrow.manage'),
    businessDate: new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 10),
  };

  const server = require('../src/app').createApp().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  vars.baseUrl = `http://127.0.0.1:${port}/api/v1`;

  // Mini worker: what the BullMQ worker does, in-process.
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        await h.drainEvents();
        await h.drainPaymentJobs();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('worker loop:', err.message);
      }
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
