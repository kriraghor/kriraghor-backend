'use strict';

const { Router } = require('express');
const { validate } = require('../../common/validate');
const { authenticate, authenticateAdmin, requireStaff, requireAnyPermission } = require('../../middlewares/auth');
const { PERMISSIONS } = require('../../common/enums');
const svc = require('./notify.service');
const s = require('./notify.schemas');

/** The bell (M08 §4.1, FR-04, FR-05). Same routes for customer and admin audiences (ADR-004). */
function bellRouter(auth) {
  const r = Router();
  r.use(...auth);
  r.get('/', validate(s.listQuery, 'query'), async (req, res) => res.json(await svc.list(req.user.id, req.validQuery)));
  r.get('/unread-count', async (req, res) => res.json({ unreadCount: await svc.unreadCount(req.user.id) }));
  r.post('/read', validate(s.readBody), async (req, res) => res.json(await svc.markRead(req.user.id, req.body)));
  return r;
}

const meRouter = bellRouter([authenticate]); // /me/notifications
const adminMeRouter = bellRouter([authenticateAdmin, requireStaff]); // /admin/me/notifications

// /me/notification-prefs (§4.3)
const prefsRouter = Router();
prefsRouter.use(authenticate);
prefsRouter.get('/', async (req, res) => res.json(await svc.getPrefs(req.user.id)));
prefsRouter.put('/', validate(s.prefsBody), async (req, res) => res.json(await svc.putPrefs(req.user.id, req.body)));

// /admin/notifications/deliveries (support, masked phones)
const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff, requireAnyPermission(PERMISSIONS.MANAGE_USERS));
adminRouter.get('/deliveries', validate(s.deliveriesQuery, 'query'), async (req, res) => res.json(await svc.deliveries(req.validQuery)));

module.exports = { meRouter, adminMeRouter, prefsRouter, adminRouter };
