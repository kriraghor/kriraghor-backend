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
const { seedReference } = require('./db/seed');
const { createApp } = require('./app');

function runCliCommand(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: process.env,
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command ${args.join(' ')} failed with code ${code}`));
    });

    proc.on('error', (err) => reject(err));
  });
}

async function runReleaseSteps() {
  const cliPath = 'node_modules/sequelize-cli/lib/sequelize';
  
  logger.info('Running database migrations...');
  await runCliCommand([cliPath, 'db:migrate']);

  logger.info('Seeding reference data from JSON...');
  await seedReference();
  logger.info('Reference data seeded successfully.');

  logger.info('Loading platform settings into cache...');
  await settings.load();
  logger.info('Platform settings loaded successfully.');
}

async function main() {
  initMetrics('api');
  lifecycle.onShutdown('database', () => sequelize.close());
  lifecycle.onShutdown('redis', closeAllRedis);

  await sequelize.authenticate();
  logger.info({ db: config.db.name }, 'database connected');

  await runReleaseSteps();

  await settings.bootCheck();
  await settings.subscribe();

  const app = createApp();
  const server = app.listen(config.port, () => logger.info(`Kriraghor API listening on :${config.port}${config.apiPrefix}`));
  // Keep-alive longer than the ingress idle timeout, so the proxy never reuses a closed socket.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  lifecycle.onShutdown('http', () => new Promise((resolve) => server.close(() => resolve())));

  startOpsServer();
  lifecycle.handleSignals();
  lifecycle.setReady(true);
  startDemoSeed();
}

/**
 * Demo data on hosts without a shell (scripts/demo/README.md). After the API is ready it runs, in the
 * background and with its own environment:
 *   DEMO_SEED=listings  the seeder, listings profile only (no payments); it skips what exists, so a
 *                       restart resumes it
 *   DEMO_SEED=hide      the hide command (cancels demo events, suspends demo accounts; deletes nothing)
 * Remove the variable when the log shows the run finished.
 */
const DEMO_COMMANDS = {
  listings: ['scripts/demo-seed.js', '--profile=listings', '--confirm-live'],
  hide: ['scripts/demo-hide.js', '--confirm-live'],
};

function startDemoSeed() {
  const mode = process.env.DEMO_SEED;
  if (!mode) return;
  if (!DEMO_COMMANDS[mode]) {
    logger.warn({ mode }, 'DEMO_SEED ignored: use "listings" or "hide"');
    return;
  }
  logger.info({ mode }, 'DEMO_SEED: starting the demo command in the background');
  const child = spawn(process.execPath, DEMO_COMMANDS[mode], { stdio: 'inherit', env: process.env });
  child.on('close', (code) => logger.info({ mode, code }, code === 0 ? 'demo command finished; remove DEMO_SEED' : 'demo command stopped; it runs again on the next start'));
  child.on('error', (err) => logger.warn({ err: err.message }, 'demo command could not start'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});