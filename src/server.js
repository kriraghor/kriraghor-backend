'use strict';

const { spawn } = require('child_process');
// API entrypoint (ADR-003 backend-api). Scheduled jobs run in src/worker.js, never here.
const config = require('./config');
const logger = require('./common/logger');
const lifecycle = require('./common/lifecycle');
const { initMetrics } = require('./common/metrics');
const { startOpsServer } = require('./common/ops-server');
const { closeAllRedis } = require('./common/redis');
const { sequelize } = require('./models');
const settings = require('./modules/settings/settings.service');
const { createApp } = require('./app');

function runMigrations() {
  return new Promise((resolve, reject) => {
    const migrate = spawn(
      process.execPath,
      ['node_modules/sequelize-cli/lib/sequelize', 'db:migrate'],
      {
        stdio: 'inherit',
        env: process.env,
      }
    );

    migrate.on('close', (code) => {
      if (code === 0) {
        logger.info('Database migrations completed successfully');
        resolve();
      } else {
        reject(new Error(`Migration process exited with code ${code}`));
      }
    });

    migrate.on('error', (err) => reject(err));
  });
}

async function main() {
  initMetrics('api');
  lifecycle.onShutdown('database', () => sequelize.close());
  lifecycle.onShutdown('redis', closeAllRedis);

  await runMigrations();
  await sequelize.authenticate();
  // M03 boot check: refuse to start before the release step has seeded every setting.
  await settings.bootCheck();
  await settings.subscribe();
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