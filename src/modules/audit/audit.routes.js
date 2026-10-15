'use strict';

const { Router } = require('express');
const { validate } = require('../../common/validate');
const { authenticateAdmin, requireStaff, requireMaster, requireStepUp } = require('../../middlewares/auth');
const svc = require('./audit.admin.service');
const s = require('./audit.schemas');

// /admin/audit-logs (master) and /admin/entities/:type/:id/history (staff, FR-07).
const auditRouter = Router();
auditRouter.use(authenticateAdmin, requireStaff, requireMaster);

auditRouter.get('/', validate(s.searchQuery, 'query'), async (req, res) => res.json(await svc.search(req.validQuery)));

// Validate before consuming the single-use step-up token (same rule as settings writes).
auditRouter.post('/exports', validate(s.exportBody), requireStepUp('audit.export'), async (req, res) =>
  res.status(202).json(await svc.requestExport(req.user, req.body.filters))
);

auditRouter.get('/exports/:id', validate(s.exportIdParam, 'params'), async (req, res) => res.json(await svc.getExport(req.user, req.params.id)));

auditRouter.get('/exports/:id/download', validate(s.exportIdParam, 'params'), async (req, res) => {
  const { body, filename } = await svc.downloadExport(req.user, req.params.id);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.set('Cache-Control', 'no-store');
  if (Buffer.isBuffer(body)) return res.send(body);
  return body.pipe(res);
});

auditRouter.get('/:id', validate(s.idParam, 'params'), async (req, res) => res.json(await svc.getOne(req.params.id)));

const entityRouter = Router();
entityRouter.use(authenticateAdmin, requireStaff);
entityRouter.get('/:entityType/:entityId/history', validate(s.entityParams, 'params'), validate(s.pageQuery, 'query'), async (req, res) =>
  res.json(await svc.entityHistory(req.user, req.params.entityType, req.params.entityId, req.validQuery))
);

module.exports = { auditRouter, entityRouter };
