'use strict';

const config = require('../config');
const { buildOpenApi } = require('./index');

let cached;
const document = () => {
  if (!cached) cached = buildOpenApi();
  return cached;
};

/**
 * GET /api/docs/openapi.json in every environment (frontends and CI read it), and
 * Swagger UI at /api/docs outside production (ADR-002).
 */
function mount(app) {
  app.get('/api/docs/openapi.json', (_req, res) => res.json(document()));
  if (!config.isProd && !config.isTest) {
    const swaggerUi = require('swagger-ui-express');
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(null, { swaggerOptions: { url: '/api/docs/openapi.json' } }));
  }
}

module.exports = { mount, document };
