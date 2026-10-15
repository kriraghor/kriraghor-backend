'use strict';

/**
 * Unattended M04 acceptance run with the Postman CLI.
 *   node postman/run-m04.js
 *
 * Uses the kriraghor_test database (reset, like `npm test`): migrates and seeds it, signs in a test
 * master, pre-mints step-up tokens (settings.write, then audit.export), starts the API on a free port
 * and, next to it, a small worker loop that does what the BullMQ worker does: relay the outbox, run
 * consumer deliveries and build queued exports. Never point this at a real database.
 */
require('../tests/env');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-audit-events.postman_collection.json');

async function main() {
  const migrate = spawnSync(process.execPath, ['scripts/release.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' } });
  if (migrate.status !== 0) throw new Error('migrate + seed failed');

  const h = require('../tests/helpers');
  const { createApp } = require('../src/app');
  const { closeAllRedis } = require('../src/common/redis');
  const relay = require('../src/modules/events/events.relay');
  const consumers = require('../src/modules/events/events.consumers');
  const chain = require('../src/modules/audit/audit.chain');
  const auditAdmin = require('../src/modules/audit/audit.admin.service');

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const tokens = [await h.stepUp(a, 'settings.write'), await h.stepUp(a, 'audit.export')];
  await chain.seal();

  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));

  // Mini worker: the same work the BullMQ worker does, in-process.
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        await relay.relayOnce();
        for (const job of consumers.takeTestJobs()) await consumers.processConsume(job.data);
        for (const row of await h.models.AuditExport.findAll({ where: { status: 'queued' } })) await auditAdmin.runExport({ exportId: row.id });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('worker loop:', err.message);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();

  const vars = { baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`, adminAccessToken: a.accessToken, stepUpQueueA: tokens.join(',') };
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
