'use strict';

const IORedis = require('ioredis');
const config = require('../config');
const logger = require('./logger');

const clients = new Set();

/**
 * New Redis connection. BullMQ workers and the Socket.IO adapter each need dedicated
 * connections, and BullMQ requires maxRetriesPerRequest: null.
 */
function createRedis(name, { bullmq = false } = {}) {
  const client = new IORedis(config.redis.url, {
    connectionName: `kriraghor:${name}`,
    maxRetriesPerRequest: bullmq ? null : 3,
    enableReadyCheck: true,
  });
  client.on('error', (err) => logger.warn({ err: err.message, redis: name }, 'redis error'));
  clients.add(client);
  client.once('end', () => clients.delete(client));
  return client;
}

let shared;
/** Shared general-purpose connection (rate limits, readiness, small caches). */
function getRedis() {
  if (!shared) shared = createRedis('shared');
  return shared;
}

async function pingRedis(timeoutMs = 1000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('redis ping timeout')), timeoutMs);
  });
  try {
    return (await Promise.race([getRedis().ping(), timeout])) === 'PONG';
  } finally {
    clearTimeout(timer);
  }
}

async function closeAllRedis() {
  await Promise.allSettled([...clients].map((c) => c.quit().catch(() => c.disconnect())));
  clients.clear();
  shared = undefined;
}

module.exports = { createRedis, getRedis, pingRedis, closeAllRedis };
