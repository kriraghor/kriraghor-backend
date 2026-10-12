'use strict';

const config = require('./config');
const logger = require('./common/logger');
const { sequelize } = require('./models');
const { createApp } = require('./app');
const { liftExpiredSuspensions } = require('./modules/admin/admin-users.service');

async function main() {
  await sequelize.authenticate();
  logger.info({ db: config.db.name }, 'database connected');

  const app = createApp();
  const server = app.listen(config.port, () => logger.info(`Kriraghor API listening on :${config.port}${config.apiPrefix}`));

  // Lightweight scheduler until BullMQ arrives (M01 §10 identity.sanction-expire).
  const timer = setInterval(() => {
    liftExpiredSuspensions().catch((err) => logger.error({ err }, 'sanction-expire job failed'));
  }, 60 * 1000);

  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(timer);
    server.close(async () => {
      await sequelize.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
