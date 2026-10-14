'use strict';

// Realtime entrypoint (ADR-003 backend-realtime): Socket.IO with the Redis adapter, so an
// event emitted on any pod (or by the worker) reaches sockets connected to every pod.
const http = require('http');
const { createAdapter } = require('@socket.io/redis-adapter');
const config = require('./config');
const logger = require('./common/logger');
const lifecycle = require('./common/lifecycle');
const { initMetrics } = require('./common/metrics');
const { startOpsServer } = require('./common/ops-server');
const { createRedis, closeAllRedis } = require('./common/redis');
const { sequelize } = require('./models');
const { createRealtimeServer } = require('./realtime/server');

async function main() {
  initMetrics('realtime');
  lifecycle.onShutdown('database', () => sequelize.close());
  lifecycle.onShutdown('redis', closeAllRedis);

  await sequelize.authenticate();
  const pub = createRedis('socket-pub');
  const sub = pub.duplicate();
  const adapter = createAdapter(pub, sub, { key: `${config.redis.prefix}:socket.io` });

  const httpServer = http.createServer((_req, res) => res.writeHead(404).end());
  const io = createRealtimeServer(httpServer, { adapter });
  httpServer.listen(config.realtimePort, () => logger.info(`realtime listening on :${config.realtimePort}/socket.io`));
  // Closers run in reverse order: Socket.IO closes (clients reconnect to another pod) before its adapter.
  lifecycle.onShutdown('redis-adapter', async () => {
    await Promise.allSettled([pub.quit(), sub.quit()]);
  });
  lifecycle.onShutdown('socket.io', () => new Promise((resolve) => io.close(() => resolve())));

  startOpsServer();
  lifecycle.handleSignals();
  lifecycle.setReady(true);
}

main().catch((err) => {
  logger.fatal({ err }, 'realtime failed to start');
  process.exit(1);
});
