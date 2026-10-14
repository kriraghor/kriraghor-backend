'use strict';

const http = require('http');
const express = require('express');
const config = require('../config');
const logger = require('./logger');
const lifecycle = require('./lifecycle');
const { registry } = require('./metrics');
const { pingRedis } = require('./redis');

/**
 * Probes and metrics on a separate port (OPS_PORT) for every process. The ingress never
 * routes here; Prometheus scrapes it inside the cluster (ADR-003).
 *  - /health/live:  the event loop answers. No dependency checks, so a DB outage never restarts pods.
 *  - /health/ready: the process is not draining, and the DB and Redis are reachable.
 */
function createOpsApp({ checks = {} } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));

  app.get('/health/ready', async (_req, res) => {
    const results = {};
    let ok = lifecycle.isReady();
    for (const [name, check] of Object.entries(checks)) {
      try {
        results[name] = (await check()) ? 'up' : 'down';
      } catch {
        results[name] = 'down';
      }
      if (results[name] !== 'up') ok = false;
    }
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', draining: lifecycle.isShuttingDown(), ...results });
  });

  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  });
  return app;
}

/** Default readiness checks: the DB (Sequelize) and Redis. */
function defaultChecks() {
  const { sequelize } = require('../models');
  return {
    db: async () => {
      await sequelize.authenticate();
      return true;
    },
    redis: () => pingRedis(),
  };
}

function startOpsServer(opts = {}) {
  const server = http.createServer(createOpsApp({ checks: defaultChecks(), ...opts }));
  server.listen(config.opsPort, () => logger.info(`ops endpoints on :${config.opsPort} (/health/live, /health/ready, /metrics)`));
  lifecycle.onShutdown('ops-server', () => new Promise((resolve) => server.close(() => resolve())));
  return server;
}

module.exports = { createOpsApp, startOpsServer, defaultChecks };
