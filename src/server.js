'use strict';

// API entrypoint (ADR-003 backend-api). Scheduled jobs run in src/worker.js, never here.
const config = require('./config');
const logger = require('./common/logger');
const lifecycle = require('./common/lifecycle');
const { initMetrics } = require('./common/metrics');
const { startOpsServer } = require('./common/ops-server');
const { closeAllRedis } = require('./common/redis');
const { sequelize } = require('./models');
const { createApp } = require('./app');

async function main() {
  initMetrics('api');
  lifecycle.onShutdown('database', () => sequelize.close());
  lifecycle.onShutdown('redis', closeAllRedis);

  await sequelize.authenticate();
  logger.info({ db: config.db.name }, 'database connected');

  const app = createApp();
  const server = app.listen(config.port, () => logger.info(`Kriraghor API listening on :${config.port}${config.apiPrefix}`));
  // Keep-alive longer than the ingress idle timeout, so the proxy never reuses a closed socket.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  lifecycle.onShutdown('http', () => new Promise((resolve) => server.close(() => resolve())));

  startOpsServer();
  lifecycle.handleSignals();
  lifecycle.setReady(true);
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
