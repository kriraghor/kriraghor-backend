'use strict';

const { Router } = require('express');
const { validate } = require('../../common/validate');
const { sendCached } = require('../../common/http-cache');
const { authenticateAdmin, requireStaff, requirePermission, requireMaster, requireStepUp } = require('../../middlewares/auth');
const { PERMISSIONS } = require('../../common/enums');
const settings = require('./settings.service');
const requests = require('./change-request.service');
const { serializeSetting } = require('./settings.serializer');
const s = require('./settings.schemas');

// ---------------- public: GET /settings/public (M03-FR-18) ----------------
const publicRouter = Router();
publicRouter.get('/public', (req, res) => sendCached(req, res, settings.publicView(), settings.stamp()));

// ---------------- admin: /admin/settings ----------------
// Reads: master, or manage_catalog read-only. Writes: master + step-up settings.write (M03-FR-15).
const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff);
const canRead = requirePermission(PERMISSIONS.MANAGE_CATALOG);
// Validate before consuming the single-use step-up token, so a typo does not cost a new TOTP.
const write = (...checks) => [requireMaster, ...checks, requireStepUp('settings.write')];
const idParam = validate(s.idParam, 'params');

adminRouter.get('/', canRead, validate(s.settingsQuery, 'query'), (req, res) =>
  res.json({ items: settings.list(req.validQuery).map(serializeSetting), version: settings.stamp() })
);

adminRouter.get('/change-requests', canRead, validate(s.requestsQuery, 'query'), async (req, res) => res.json(await requests.list(req.validQuery)));

adminRouter.get('/change-requests/:id', canRead, idParam, async (req, res) => res.json(await requests.getOne(req.params.id)));

adminRouter.post('/change-requests', ...write(validate(s.changeRequestCreate)), async (req, res) =>
  res.status(201).json(await requests.create(req.user, req.body, req))
);

adminRouter.post('/change-requests/:id/approve', ...write(idParam, validate(s.approve)), async (req, res) =>
  res.json(await requests.approve(req.user, req.params.id, req.body, req))
);

adminRouter.post('/change-requests/:id/reject', ...write(idParam, validate(s.reject)), async (req, res) =>
  res.json(await requests.reject(req.user, req.params.id, req.body, req))
);

adminRouter.post('/change-requests/:id/withdraw', ...write(idParam, validate(s.withdraw)), async (req, res) =>
  res.json(await requests.withdraw(req.user, req.params.id, req.body, req))
);

// Declared last so "change-requests" is never read as a key.
adminRouter.get('/:key/history', canRead, validate(s.keyParam, 'params'), validate(s.historyQuery, 'query'), async (req, res) =>
  res.json(await settings.history(req.params.key, req.validQuery))
);

module.exports = { publicRouter, adminRouter };
