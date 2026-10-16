'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const { validate } = require('../../common/validate');
const { sendCached } = require('../../common/http-cache');
const { authenticateAdmin, requireStaff, requireAnyPermission } = require('../../middlewares/auth');
const { PERMISSIONS } = require('../../common/enums');
const catalog = require('./catalog.service');
const s = require('./catalog.schemas');

// ---------------- public: /catalog (M03-FR-02, cacheable) ----------------
const publicRouter = Router();
const cached = (req, res, body) => sendCached(req, res, body, crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex'));
publicRouter.get('/esports/games', async (req, res) => cached(req, res, await catalog.publicGames()));
publicRouter.get('/sports', async (req, res) => cached(req, res, await catalog.publicSports()));
publicRouter.get('/facilities', async (req, res) => cached(req, res, await catalog.publicFacilities()));
publicRouter.get('/surfaces', async (req, res) => cached(req, res, await catalog.publicSurfaces()));
publicRouter.get('/locations', validate(s.locationsQuery, 'query'), async (req, res) => cached(req, res, await catalog.publicLocations(req.validQuery)));
publicRouter.get('/areas', validate(s.areasQuery, 'query'), async (req, res) => cached(req, res, await catalog.publicAreas(req.validQuery)));

// ---------------- admin: /admin/catalog/:table ----------------
// Esports tables: manage_esports or manage_catalog. Sports and places: manage_catalog only.
const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff, requireAnyPermission(PERMISSIONS.MANAGE_ESPORTS, PERMISSIONS.MANAGE_CATALOG));
const catalogOnly = requireAnyPermission(PERMISSIONS.MANAGE_CATALOG);
adminRouter.param('table', (req, res, next, table) => (catalog.TABLES[table] && !catalog.TABLES[table].esports ? catalogOnly(req, res, next) : next()));

/** The body schema depends on :table, so pick it after the params are validated. */
const bodyFor = (schemas) => (req, res, next) => validate(schemas[req.params.table])(req, res, next);

adminRouter.get('/:table', validate(s.tableParam, 'params'), validate(s.listQuery, 'query'), async (req, res) =>
  res.json(await catalog.list(req.params.table, req.validQuery))
);

adminRouter.post('/:table', validate(s.tableParam, 'params'), bodyFor(s.CREATE), async (req, res) =>
  res.status(201).json(await catalog.create(req.user, req.params.table, req.body, req))
);

adminRouter.patch('/:table/:id', validate(s.tableIdParam, 'params'), bodyFor(s.UPDATE), async (req, res) =>
  res.json(await catalog.update(req.user, req.params.table, req.params.id, req.body, req))
);

adminRouter.post('/:table/:id/deactivate', validate(s.tableIdParam, 'params'), async (req, res) =>
  res.json(await catalog.setActive(req.user, req.params.table, req.params.id, false, req))
);

adminRouter.post('/:table/:id/reactivate', validate(s.tableIdParam, 'params'), async (req, res) =>
  res.json(await catalog.setActive(req.user, req.params.table, req.params.id, true, req))
);

module.exports = { publicRouter, adminRouter };
