'use strict';

/**
 * M19 routes (§9, step 1).
 *   meRouter     /me/dashboard     the member's, ground owner's, shop owner's, gym owner's and sports
 *                                  organiser's dashboards (?role=, organiser with ?orgId=), actions and CSV
 *   kpiRouter    /kpis             what each tile counts (public)
 *   adminRouter  /admin/analytics  the platform overview and its CSV (master or view_analytics), staff actions,
 *                                  the review figures (masters and reviewers, M19-FR-33)
 */
const { Router } = require('express');
const { validate } = require('../../common/validate');
const { E } = require('../../common/errors');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, requireStaff } = require('../../middlewares/auth');
const dashboards = require('./dashboards.service');
const actions = require('./actions.registry');
const exportsSvc = require('./exports.service');
const reviews = require('./reviews.service');
const { definition } = require('./kpis');
const s = require('./analytics.schemas');

const sendCsv = (res, { filename, body }) =>
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${filename}"`).set('Cache-Control', 'no-store').send(body);

/** The dashboard of each role (M19-FR-01; Round B2 adds shops, gyms and sports organisers). */
const DASHBOARDS = {
  member: dashboards.memberDashboard,
  ground_owner: dashboards.ownerDashboard,
  shop_owner: dashboards.shopDashboard,
  gym_owner: dashboards.gymDashboard,
  organiser: dashboards.organiserDashboard,
};

const meRouter = Router();
meRouter.use(authenticate);
meRouter.get('/', validate(s.dashboardQuery, 'query'), async (req, res) => res.json(await DASHBOARDS[req.validQuery.role](req.user, req.validQuery)));
meRouter.get('/actions', validate(s.actionsQuery, 'query'), async (req, res) => {
  const { role } = req.validQuery;
  // Organisers' items come from their organisation memberships (staff need no organiser role); a
  // business's staff get the items of their workplaces (Round B3), none when they work nowhere.
  if (!['member', 'organiser', 'business_staff'].includes(role) && req.user.roles?.[role] !== 'active') throw E.forbidden('ROLE_REQUIRED', 'This list is for active business owners', undefined, { role });
  res.json(await actions.list(req.user, req.validQuery.role));
});
meRouter.get('/export', validate(s.exportQuery, 'query'), async (req, res) => sendCsv(res, await exportsSvc.exportCsv(req.user, req.validQuery, exportsSvc.DATASETS[req.validQuery.dataset].role, req)));

const kpiRouter = Router();
kpiRouter.get('/:key/definition', validate(s.kpiParam, 'params'), validate(s.kpiQuery, 'query'), async (req, res) => {
  const d = definition(req.params.key, req.validQuery.locale);
  if (!d) throw E.notFound('KPI');
  res.json(d);
});

/** Masters, or staff with view_analytics (Q104). */
const canAnalyse = (req, _res, next) =>
  req.user.isMaster || req.user.permissions.has(PERMISSIONS.VIEW_ANALYTICS) ? next() : next(E.forbidden('PERMISSION_REQUIRED', 'You need view analytics', undefined, { permission: PERMISSIONS.VIEW_ANALYTICS }));

// M19-FR-33: the review figures are for masters and staff who review (M05: approve_documents or approve_listings).
const canReview = (req, _res, next) =>
  req.user.isMaster || req.user.permissions.has(PERMISSIONS.APPROVE_DOCUMENTS) || req.user.permissions.has(PERMISSIONS.APPROVE_LISTINGS)
    ? next()
    : next(E.forbidden('PERMISSION_REQUIRED', 'Only staff who review submissions see these figures'));
const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff);
adminRouter.get('/overview', canAnalyse, validate(s.platformQuery, 'query'), async (req, res) => res.json(await dashboards.platformOverview(req.user, req.validQuery)));
adminRouter.get('/export', canAnalyse, validate(s.platformExportQuery, 'query'), async (req, res) => sendCsv(res, await exportsSvc.exportCsv(req.user, req.validQuery, 'platform', req)));
adminRouter.get('/actions', async (req, res) => res.json(await actions.list(req.user, 'staff')));
adminRouter.get('/reviews', canReview, validate(s.reviewsQuery, 'query'), async (req, res) => res.json(await reviews.reviewFigures(req.user, req.validQuery)));

module.exports = { meRouter, kpiRouter, adminRouter };
