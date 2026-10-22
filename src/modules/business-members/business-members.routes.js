'use strict';

/**
 * Round B3 routes (plan B3 "Endpoints").
 *   meWorkplaces  /me/workplaces   where the signed-in member works (businesses, owners, permissions)
 *   meTeam        /me/team         the owner's staff: list, add by verified phone, change permissions,
 *                                  remove (the business must be the caller's own; 404 otherwise)
 * No Idempotency-Key: adding a staff member creates no money, and a repeat answers ALREADY_MEMBER.
 * Adds are limited per owner (business.team_adds_per_hour, Redis sliding window; 429 RATE_LIMITED):
 * the refusals tell an owner whether a number has a verified account (Q180).
 */
const { Router } = require('express');
const { validate } = require('../../common/validate');
const { authenticate } = require('../../middlewares/auth');
const limits = require('../../middlewares/rateLimit');
const c = require('./business-members.controller');
const s = require('./business-members.schemas');

const id = validate(s.idParam, 'params');

const meWorkplaces = Router();
meWorkplaces.get('/', authenticate, c.workplaces);

const meTeam = Router();
meTeam.use(authenticate);
meTeam.get('/', validate(s.teamQuery, 'query'), c.listTeam);
meTeam.post('/', validate(s.addBody), limits.teamAdd, c.add);
meTeam.patch('/:id', id, validate(s.permissionsBody), c.updatePermissions);
meTeam.post('/:id/remove', id, c.remove);

module.exports = { meWorkplaces, meTeam };
