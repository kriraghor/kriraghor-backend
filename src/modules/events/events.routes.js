'use strict';

const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../../common/validate');
const { authenticateAdmin, requireStaff, requireMaster, requireStepUp } = require('../../middlewares/auth');
const admin = require('./events.admin.service');
const consumers = require('./events.consumers');

const schemas = {
  listQuery: z.object({
    status: z.enum(['pending', 'failed', 'dead']).default('dead'),
    name: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  idParam: z.object({ id: z.uuid() }),
  replayBody: z.object({ consumer: z.string().min(1).max(80) }),
};

// /admin/events: outbox health, dead letters and replay (master, ops; M04 §9).
const router = Router();
router.use(authenticateAdmin, requireStaff, requireMaster);

router.get('/', validate(schemas.listQuery, 'query'), async (req, res) => res.json(await admin.list(req.validQuery)));

router.post('/:id/replay', validate(schemas.idParam, 'params'), validate(schemas.replayBody), requireStepUp('events.replay'), async (req, res) =>
  res.status(202).json(await consumers.replay(req.user, req.params.id, req.body.consumer, req))
);

module.exports = { router, schemas };
