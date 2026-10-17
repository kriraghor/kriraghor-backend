'use strict';

/**
 * M19 routes (§9, step 1).
 *   meRouter     /me/dashboard     the member's and the ground owner's dashboards, actions and CSV
 *   kpiRouter    /kpis             what each tile counts (public)
 *   adminRouter  /admin/analytics  the platform overview and its CSV (master or view_analytics), staff actions
 */
const { Router } = require('express');
const { validate } = require('../../common/validate');
const { E } = require('../../common/errors');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, requireStaff } = require('../../middlewares/auth');
const dashboards = require('./dashboards.service');
const actions = require('./actions.registry');
const exportsSvc = require('./exports.service');
const { definition } = require('./kpis');
const s = require('./analytics.schemas');

const sendCsv = (res, { filename, body }) =>
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${filename}"`).set('Cache-Control', 'no-store').send(body);

const meRouter = Router();
meRouter.use(authenticate);
meRouter.get('/', validate(s.dashboardQuery, 'query'), async (req, res) => {
  const q = req.validQuery;
  res.json(q.role === 'ground_owner' ? await dashboards.ownerDashboard(req.user, q) : await dashboards.memberDashboard(req.user, q));
});
meRouter.get('/actions', validate(s.actionsQuery, 'query'), async (req, res) => {
  const { role } = req.validQuery;
  if (role !== 'member' && req.user.roles?.[role] !== 'active') throw E.forbidden('ROLE_REQUIRED', 'This list is for active business owners', undefined, { role });
  res.json(await actions.list(req.user, req.validQuery.role));
});
meRouter.get('/export', validate(s.exportQuery, 'query'), async (req, res) => {
  const scope = req.validQuery.dataset.startsWith('owner_') ? 'ground_owner' : 'member';
  sendCsv(res, await exportsSvc.exportCsv(req.user, req.validQuery, scope, req));
});

const kpiRouter = Router();
kpiRouter.get('/:key/definition', validate(s.kpiParam, 'params'), validate(s.kpiQuery, 'query'), async (req, res) => {
  const d = definition(req.params.key, req.validQuery.locale);
  if (!d) throw E.notFound('KPI');
  res.json(d);
});

/** Masters, or staff with view_analytics (Q104). */
const canAnalyse = (req, _res, next) =>
  req.user.isMaster || req.user.permissions.has(PERMISSIONS.VIEW_ANALYTICS) ? next() : next(E.forbidden('PERMISSION_REQUIRED', 'You need view analytics', undefined, { permission: PERMISSIONS.VIEW_ANALYTICS }));

const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff);
adminRouter.get('/overview', canAnalyse, validate(s.platformQuery, 'query'), async (req, res) => res.json(await dashboards.platformOverview(req.user, req.validQuery)));
adminRouter.get('/export', canAnalyse, validate(s.platformExportQuery, 'query'), async (req, res) => sendCsv(res, await exportsSvc.exportCsv(req.user, req.validQuery, 'platform', req)));
adminRouter.get('/actions', async (req, res) => res.json(await actions.list(req.user, 'staff')));

module.exports = { meRouter, kpiRouter, adminRouter };
