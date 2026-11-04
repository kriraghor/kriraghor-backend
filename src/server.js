'use strict';

const http = require('http');
const { spawn } = require('child_process');
// API entrypoint (ADR-003 backend-api). Scheduled jobs run in src/worker.js, except in the one-process
// mode for free hosting (JOBS_IN_API=true, ADR-003 amendment of 25 Oct 2026), where this process runs
// them too.
const config = require('./config');
const logger = require('./common/logger');
const lifecycle = require('./common/lifecycle');
const { initMetrics } = require('./common/metrics');
const { startOpsServer } = require('./common/ops-server');
const { closeAllRedis } = require('./common/redis');
const { sequelize } = require('./models');
const settings = require('./modules/settings/settings.service');
const { seedReferenceIfChanged } = require('./db/seed');
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

  // The full seed is about 900 sequential queries (minutes on a remote database): only when the
  // reference data or seed code changed, or REFERENCE_SEED=always.
  logger.info('Checking reference data...');
  const seed = await seedReferenceIfChanged({ force: config.referenceSeed === 'always' });
  logger.info({ skipped: seed.skipped, fingerprint: seed.fingerprint.slice(0, 12) }, seed.skipped ? 'Reference data unchanged; seed skipped.' : 'Reference data seeded successfully.');

  logger.info('Loading platform settings into cache...');
  await settings.load();
  logger.info('Platform settings loaded successfully.');
}

/** Every request before the app is ready: 503, so health checks wait and nothing reads unloaded settings. */
function starting(_req, res) {
  res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ status: 'starting' }));
}

async function main() {
  initMetrics('api');
  lifecycle.onShutdown('database', () => sequelize.close());
  lifecycle.onShutdown('redis', closeAllRedis);

  // Open the port first: hosts such as Render fail a deploy when no port opens within their scan
  // window, and migrations plus the seed can take longer than that. Until the app is ready every
  // request (including /health) answers 503 "starting", so a health check holds traffic back.
  let handler = starting;
  const server = http.createServer((req, res) => handler(req, res));
  // Keep-alive longer than the ingress idle timeout, so the proxy never reuses a closed socket.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  await new Promise((resolve, reject) => server.once('error', reject).listen(config.port, resolve));
  logger.info(`Kriraghor API starting on :${config.port} (503 until ready)`);
  lifecycle.onShutdown('http', () => new Promise((resolve) => server.close(() => resolve())));
  lifecycle.handleSignals();

  await sequelize.authenticate();
  logger.info({ db: config.db.name }, 'database connected');

  await runReleaseSteps();

  await settings.bootCheck();
  await settings.subscribe();

  handler = createApp();
  logger.info(`Kriraghor API listening on :${config.port}${config.apiPrefix}`);

  if (config.jobsInApi) await require('./jobs/in-api').startJobsInApi();

  startOpsServer();
  lifecycle.setReady(true);
  startDemoSeed();
  void bootstrapMasterFromEnv();
}

/**
 * Demo data on hosts without a shell (scripts/demo/README.md). After the API is ready it runs, in the
 * background and with its own environment:
 *   DEMO_SEED=listings  the seeder, listings profile only (no payments); it skips what exists, so a
 *                       restart resumes it
 *   DEMO_SEED=access    only the demo business staff (B3) and the demo sign-in accounts (needs
 *                       DEMO_PASSWORD; listings must exist)
 *   DEMO_SEED=sports    only the demo sports events: closes the retired ones, adds the new ones (listings
 *                       must exist); touches nothing else
 *   DEMO_SEED=hide      the hide command (cancels demo events, suspends demo accounts; deletes nothing)
 * Remove the variable when the log shows the run finished.
 */
const DEMO_COMMANDS = {
  listings: ['scripts/demo-seed.js', '--profile=listings', '--confirm-live'],
  access: ['scripts/demo-seed.js', '--access-only', '--confirm-live'],
  sports: ['scripts/demo-seed.js', '--sports-only', '--confirm-live'],
  hide: ['scripts/demo-hide.js', '--confirm-live'],
};

/**
 * The first master admin on hosts without a shell (M01-FR-40): BOOTSTRAP_MASTER=<email or phone> of
 * an account that already exists with that identifier verified. It does nothing once a master who can
 * sign in exists, so leaving the variable set cannot create a second one; remove it after the log
 * says it is done. Logs carry a masked identifier only.
 */
async function bootstrapMasterFromEnv() {
  const identifier = process.env.BOOTSTRAP_MASTER;
  if (!identifier) return;
  try {
    const result = await require('./modules/admin').masterBootstrap.bootstrapMaster({ identifier });
    if (result.created) logger.info({ target: result.target }, 'BOOTSTRAP_MASTER: master admin created; sign in at the admin portal with a code and enrol two-factor, then remove BOOTSTRAP_MASTER');
    else logger.warn({ target: result.target, reason: result.reason }, 'BOOTSTRAP_MASTER: nothing done');
  } catch (err) {
    logger.error({ err: err.message }, 'BOOTSTRAP_MASTER failed');
  }
}

function startDemoSeed() {
  const mode = process.env.DEMO_SEED;
  if (!mode) return;
  if (!DEMO_COMMANDS[mode]) {
    logger.warn({ mode }, 'DEMO_SEED ignored: use "listings", "access", "sports" or "hide"');
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