'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');
const config = require('./config');
const logger = require('./common/logger');
const { compile } = require('./common/origins');
const { httpMetrics } = require('./common/metrics');
const passport = require('./middlewares/passport');
const { requestId, notFound, errorHandler } = require('./middlewares/errors');
const { sequelize } = require('./models');
const docs = require('./openapi/docs');

const authRoutes = require('./modules/auth/auth.routes');
const meRoutes = require('./modules/users/users.routes');
const adminRoutes = require('./modules/admin/admin.routes');
const settingsRoutes = require('./modules/settings/settings.routes');
const catalogRoutes = require('./modules/catalog/catalog.routes');
const auditRoutes = require('./modules/audit/audit.routes');
const eventsRoutes = require('./modules/events/events.routes');
const subscriptions = require('./modules/events/subscriptions');
const notifyRoutes = require('./modules/notifications/notify.routes');
const paymentRoutes = require('./modules/payments/payments.routes');
const payoutRoutes = require('./modules/payouts/payouts.routes');
const kycRoutes = require('./modules/kyc/kyc.routes');
const moderationRoutes = require('./modules/moderation/moderation.routes');
const esportsRoutes = require('./modules/esports/esports.routes');
const groundsRoutes = require('./modules/grounds/grounds.routes');
const bookingsRoutes = require('./modules/bookings/bookings.routes');
const analyticsRoutes = require('./modules/analytics/analytics.routes');
const trustRoutes = require('./modules/trust/trust.routes');
const riskRoutes = require('./modules/risk/risk.routes');

// ADR-004: customer and admin origins (exact or one-label wildcard). Unknown origins get no CORS headers.
const allowedOrigin = compile([...config.corsOrigins, ...config.adminOrigins]);

function createApp() {
  // Event consumers are known to every process (replay checks here, delivery in the worker).
  subscriptions.registerAll();
  const app = express();
  app.disable('x-powered-by');
  // Number of proxy hops (Cloudflare + ingress-nginx) so req.ip is the real client for rate limits.
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => req.id, autoLogging: !config.isTest }));
  app.use(httpMetrics);
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, done) => done(null, Boolean(origin) && allowedOrigin(origin)),
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Step-Up', 'X-Client-Type', 'X-Request-Id', 'X-CSRF-Token', 'Idempotency-Key'],
      exposedHeaders: ['X-Request-Id', 'Retry-After'],
      maxAge: 600,
    })
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(passport.initialize());

  // Kept for compatibility; Kubernetes probes use /health/live and /health/ready on OPS_PORT.
  app.get('/health', async (_req, res) => {
    try {
      await sequelize.authenticate();
      res.json({ status: 'ok', db: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  docs.mount(app);

  // M06: SSLCommerz-compatible simulator for dev, tests and k3d (config refuses it in production).
  if (config.payments.simulator) app.use('/dev/sslcommerz', require('./providers/payments/sslcommerz.simulator').router());

  const api = express.Router();
  api.use('/auth', authRoutes);
  api.use('/me/notifications', notifyRoutes.meRouter);
  api.use('/me/notification-prefs', notifyRoutes.prefsRouter);
  api.use('/me/payments', paymentRoutes.meRouter);
  api.use('/me/payout-accounts', payoutRoutes.meAccounts);
  api.use('/me/payouts', payoutRoutes.mePayouts);
  api.use('/me/withdrawals', payoutRoutes.meWithdrawals);
  api.use('/me/verification', kycRoutes.meVerification);
  api.use('/me/documents', kycRoutes.meDocuments);
  api.use('/me/document-requests', kycRoutes.meDocumentRequests);
  api.use('/me/submissions', moderationRoutes.meSubmissions);
  api.use('/me/esports', esportsRoutes.meRouter);
  api.use('/esports', esportsRoutes.publicRouter);
  api.use('/me/grounds', groundsRoutes.meGrounds);
  api.use('/me/grounds', bookingsRoutes.meWalkIns);
  api.use('/me/courts', groundsRoutes.meCourts);
  api.use('/me/closures', groundsRoutes.meClosures);
  api.use('/me/series', groundsRoutes.meSeries);
  api.use('/me/bookings', bookingsRoutes.meBookings);
  api.use('/me/dashboard', analyticsRoutes.meRouter);
  api.use('/kpis', analyticsRoutes.kpiRouter);
  api.use('/me/ground-bookings', bookingsRoutes.meOwner);
  api.use('/me/trust', riskRoutes.meTrust);
  api.use('/trust', riskRoutes.publicTrust);
  api.use('/me/disputes', trustRoutes.meDisputes);
  api.use('/me/reports', trustRoutes.meReports);
  api.use('/me/reviewable', trustRoutes.meReviewable);
  api.use('/me/reviews', trustRoutes.meReviews);
  api.use('/me/ground-reviews', trustRoutes.meGroundReviews);
  api.use('/disputes', trustRoutes.disputesRouter);
  api.use('/reports', trustRoutes.reportsRouter);
  api.use('/reviews', trustRoutes.reviewsRouter);
  api.use('/grounds', trustRoutes.groundsReviews);
  api.use('/bookings', bookingsRoutes.bookingsRouter);
  api.use('/grounds', bookingsRoutes.groundsPublic);
  api.use('/grounds', groundsRoutes.publicRouter);
  api.use('/payments', paymentRoutes.payerRouter);
  api.use('/webhooks', paymentRoutes.webhookRouter);
  api.use('/me', meRoutes);
  api.use('/settings', settingsRoutes.publicRouter);
  api.use('/catalog', catalogRoutes.publicRouter);
  // Module admin routers first: each authenticates itself, so /admin does not run auth twice.
  api.use('/admin/settings', settingsRoutes.adminRouter);
  api.use('/admin/catalog', catalogRoutes.adminRouter);
  api.use('/admin/audit-logs', auditRoutes.auditRouter);
  api.use('/admin/entities', auditRoutes.entityRouter);
  api.use('/admin/events', eventsRoutes.router);
  api.use('/admin/me/notifications', notifyRoutes.adminMeRouter);
  api.use('/admin/notifications', notifyRoutes.adminRouter);
  api.use('/admin/payments', paymentRoutes.adminPayments);
  api.use('/admin/refunds', paymentRoutes.adminRefunds);
  api.use('/admin/ledger', paymentRoutes.adminLedger);
  api.use('/admin/escrow', paymentRoutes.adminEscrow);
  api.use('/admin/reconciliation', paymentRoutes.adminRecon);
  api.use('/admin/payouts', payoutRoutes.adminPayouts);
  api.use('/admin/payout-batches', payoutRoutes.adminBatches);
  api.use('/admin/payout-accounts', payoutRoutes.adminAccounts);
  api.use('/admin/kyc', kycRoutes.adminKyc);
  api.use('/admin/submissions', moderationRoutes.adminRouter);
  api.use('/admin/esports', esportsRoutes.adminRouter);
  api.use('/admin/grounds', groundsRoutes.adminRouter);
  api.use('/admin/bookings', bookingsRoutes.adminRouter);
  api.use('/admin/analytics', analyticsRoutes.adminRouter);
  api.use('/admin/risk', riskRoutes.adminRouter);
  api.use('/admin/disputes', trustRoutes.adminDisputes);
  api.use('/admin/reports', trustRoutes.adminReports);
  api.use('/admin/reviews', trustRoutes.adminReviews);
  api.use('/admin', adminRoutes);
  app.use(config.apiPrefix, api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
