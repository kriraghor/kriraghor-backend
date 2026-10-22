'use strict';

/**
 * M10 routes (§9), step 1.
 *   groundsPublic   /grounds/:id/availability        the half-hour grid (public; "yours" when signed in)
 *   bookingsRouter  /bookings                        holds and payment (gate book_ground: a verified phone)
 *   meBookings      /me/bookings                     the member's bookings and cancel
 *   meOwner         /me/ground-bookings              the owner's day: check-in, no-show, extend, balance, cancel, move
 *                                                    (gate work_ground, Round B3: the owner or the venue's staff,
 *                                                    each action checked against the staff's permissions)
 *   meWalkIns       /me/grounds/:id/walk-ins         walk-ins (gate work_ground; mounted before the owner-only
 *                                                    /me/grounds router, so its middleware runs per route)
 *   adminRouter     /admin/bookings                  staff list and detail; master platform cancel (step-up escrow.manage)
 */
const { Router } = require('express');
const { validate } = require('../../common/validate');
const { requireIdempotencyKey } = require('../../common/idempotency');
const { PERMISSIONS } = require('../../common/enums');
const { authenticate, authenticateAdmin, optionalAuth, requireStaff, requireAnyPermission, requireMaster, requireStepUp, requireGate } = require('../../middlewares/auth');
require('./occupancy.impl').register(); // M09's OccupancyPort, before any request
const availability = require('./availability.service');
const holds = require('./holds.service');
const bookings = require('./bookings.service');
const s = require('./bookings.schemas');

const id = validate(s.idParam, 'params');

// ---------------- public
const groundsPublic = Router();
groundsPublic.get('/:id/availability', optionalAuth, id, validate(s.availabilityQuery, 'query'), async (req, res) => res.json(await availability.forDay(req.params.id, req.validQuery, req.user)));

// ---------------- member: holds and payment
const bookingsRouter = Router();
bookingsRouter.use(authenticate);
bookingsRouter.post('/holds', requireGate('book_ground'), validate(s.holdBody), requireIdempotencyKey('bookings.hold'), async (req, res) =>
  res.status(201).json(await holds.create(req.user, req.body, req.idempotencyKey, req))
);
bookingsRouter.post('/:id/pay', id, async (req, res) => res.json(await holds.payLink(req.user, req.params.id)));
bookingsRouter.post('/:id/release', id, async (req, res) => res.json(await holds.releaseHold(req.user, req.params.id, req)));

// ---------------- member: my bookings
const meBookings = Router();
meBookings.use(authenticate);
meBookings.get('/', validate(s.myListQuery, 'query'), async (req, res) => res.json(await bookings.listMine(req.user, req.validQuery)));
meBookings.get('/:id', id, async (req, res) => res.json(await bookings.getMine(req.user, req.params.id)));
meBookings.post('/:id/cancel-preview', id, async (req, res) => res.json(await bookings.cancelPreview(req.user, req.params.id)));
meBookings.post('/:id/cancel', id, validate(s.cancelBody), async (req, res) => res.json(await bookings.cancel(req.user, req.params.id, req.body, req)));

// ---------------- owner
const meOwner = Router();
meOwner.use(authenticate, requireGate('work_ground'));
meOwner.get('/', validate(s.timelineQuery, 'query'), async (req, res) => res.json(await bookings.timeline(req.user, req.validQuery)));
meOwner.get('/search', validate(s.ownerSearchQuery, 'query'), async (req, res) => res.json(await bookings.ownerSearch(req.user, req.validQuery)));
meOwner.get('/:id', id, async (req, res) => res.json(await bookings.ownerGet(req.user, req.params.id)));
meOwner.post('/:id/check-in', id, async (req, res) => res.json(await bookings.checkIn(req.user, req.params.id, req)));
meOwner.post('/:id/no-show', id, async (req, res) => res.json(await bookings.noShow(req.user, req.params.id, req)));
meOwner.post('/:id/extend', id, async (req, res) => res.json(await bookings.extend(req.user, req.params.id, req)));
meOwner.post('/:id/collect-balance', id, validate(s.balanceBody), async (req, res) => res.json(await bookings.collectBalance(req.user, req.params.id, req.body, req)));
meOwner.post('/:id/cancel', id, validate(s.ownerCancelBody), async (req, res) => res.json(await bookings.ownerCancel(req.user, req.params.id, req.body, req)));
meOwner.get('/:id/move-targets', id, async (req, res) => res.json(await bookings.moveTargets(req.user, req.params.id)));
meOwner.post('/:id/move', id, validate(s.moveBody), async (req, res) => res.json(await bookings.move(req.user, req.params.id, req.body, req)));

const meWalkIns = Router();
meWalkIns.post('/:id/walk-ins', authenticate, requireGate('work_ground'), id, validate(s.walkInBody), requireIdempotencyKey('bookings.walk_in'), async (req, res) =>
  res.status(201).json(await bookings.walkIn(req.user, req.params.id, req.body, req.idempotencyKey, req))
);

// ---------------- staff
const adminRouter = Router();
adminRouter.use(authenticateAdmin, requireStaff);
const canSee = requireAnyPermission(PERMISSIONS.MANAGE_USERS, PERMISSIONS.VIEW_PAYOUTS);
adminRouter.get('/', canSee, validate(s.staffListQuery, 'query'), async (req, res) => res.json(await bookings.staffList(req.validQuery)));
adminRouter.get('/:id', canSee, id, async (req, res) => res.json(await bookings.staffGet(req.params.id)));
adminRouter.post('/:id/cancel', requireMaster, requireStepUp('escrow.manage'), id, validate(s.reasonBody), async (req, res) => res.json(await bookings.staffCancel(req.user, req.params.id, req.body, req)));

module.exports = { groundsPublic, bookingsRouter, meBookings, meOwner, meWalkIns, adminRouter };
