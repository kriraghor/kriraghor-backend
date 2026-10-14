'use strict';

const config = require('../config');
const logger = require('./logger');

/**
 * Process lifecycle shared by the api, realtime and worker entrypoints (ADR-003):
 *  - ready flips to false the moment SIGTERM arrives, so /health/ready fails and the
 *    Service stops routing new traffic;
 *  - after SHUTDOWN_DRAIN_MS (time for the endpoint change to propagate) the registered
 *    closers run in reverse order: servers first, then queues, Redis and the DB.
 */
const state = { ready: false, shuttingDown: false };
const closers = [];

const isReady = () => state.ready && !state.shuttingDown;
const isShuttingDown = () => state.shuttingDown;
function setReady(value = true) {
  state.ready = value;
}

/** Register a close step. Steps run during shutdown in reverse registration order. */
function onShutdown(name, fn) {
  closers.push({ name, fn });
}

async function shutdown(signal, { exit = true } = {}) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  logger.info({ signal }, 'shutdown: not ready, draining');
  const force = setTimeout(() => {
    logger.error('shutdown: timed out, forcing exit');
    process.exit(1);
  }, config.shutdownDrainMs + 20000);
  force.unref();

  await new Promise((resolve) => setTimeout(resolve, config.shutdownDrainMs));
  for (const { name, fn } of [...closers].reverse()) {
    try {
      await fn();
      logger.info({ step: name }, 'shutdown: closed');
    } catch (err) {
      logger.error({ err, step: name }, 'shutdown: close failed');
    }
  }
  clearTimeout(force);
  if (exit) process.exit(0);
}

function handleSignals() {
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

/** Test helper: reset state between tests. */
function _reset() {
  state.ready = false;
  state.shuttingDown = false;
  closers.length = 0;
}

module.exports = { isReady, setReady, isShuttingDown, onShutdown, shutdown, handleSignals, _reset };
