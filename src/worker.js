'use strict';

// Worker entrypoint: BullMQ consumers and job schedulers (ADR-003 backend-worker).
const logger = require('./common/logger');
const lifecycle = require('./common/lifecycle');
const { initMetrics } = require('./common/metrics');
const { startOpsServer } = require('./common/ops-server');
const { closeAllRedis } = require('./common/redis');
const { sequelize } = require('./models');
const { closeQueues } = require('./jobs/queues');
const { registerSchedules, startWorkers } = require('./jobs/runtime');

async function main() {
  initMetrics('worker');
  lifecycle.onShutdown('database', () => sequelize.close());
  lifecycle.onShutdown('redis', closeAllRedis);
  lifecycle.onShutdown('queues', closeQueues);

  await sequelize.authenticate();
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
