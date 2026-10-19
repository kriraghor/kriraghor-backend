'use strict';

// Worker entrypoint: BullMQ consumers and job schedulers (ADR-003 backend-worker).
const logger = require('./common/logger');
const lifecycle = require('./common/lifecycle');
const { initMetrics } = require('./common/metrics');
const { startOpsServer } = require('./common/ops-server');
const { closeAllRedis } = require('./common/redis');
const { sequelize } = require('./models');
const settings = require('./modules/settings/settings.service');
const { closeQueues } = require('./jobs/queues');
const { registerSchedules, startWorkers } = require('./jobs/runtime');
const registry = require('./modules/registry');

async function main() {
  initMetrics('worker');
  lifecycle.onShutdown('database', () => sequelize.close());
  lifecycle.onShutdown('redis', closeAllRedis);
  lifecycle.onShutdown('queues', closeQueues);

  await sequelize.authenticate();
  // M03 boot check: refuse to start before the release step has seeded every setting.
  await settings.bootCheck();
  await settings.subscribe();
  // M04: every event consumer must be known before the relay and the events queue start.
  registry.registerAll();
  const schedules = await registerSchedules();
  const workers = startWorkers();
  // Closing a worker waits for its running jobs to finish.
  lifecycle.onShutdown('workers', () => Promise.all(workers.map((w) => w.close())));

  startOpsServer();
  lifecycle.handleSignals();
  lifecycle.setReady(true);
  logger.info({ schedules, queues: workers.map((w) => w.name) }, 'worker started');
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
