'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');
const config = require('./config');
const logger = require('./common/logger');
const passport = require('./middlewares/passport');
const { requestId, notFound, errorHandler } = require('./middlewares/errors');
const { sequelize } = require('./models');

const authRoutes = require('./modules/auth/auth.routes');
const meRoutes = require('./modules/users/users.routes');
const adminRoutes = require('./modules/admin/admin.routes');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => req.id, autoLogging: !config.isTest }));
  app.use(helmet());
  app.use(
    cors({
      origin: config.webOrigin,
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Step-Up', 'X-Client-Type', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'Retry-After'],
    })
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(passport.initialize());

  app.get('/health', async (_req, res) => {
    try {
      await sequelize.authenticate();
      res.json({ status: 'ok', db: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  const api = express.Router();
  api.use('/auth', authRoutes);
  api.use('/me', meRoutes);
  api.use('/admin', adminRoutes);
  app.use(config.apiPrefix, api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
