'use strict';

const { z } = require('zod');

const dateTime = z.iso.datetime({ offset: true });
const ACTOR_TYPES = ['user', 'staff', 'master', 'system', 'provider'];
const SEVERITIES = ['info', 'notice', 'critical'];

const filterFields = {
  from: dateTime.optional(),
  to: dateTime.optional(),
  actorId: z.uuid().optional(),
  actorType: z.enum(ACTOR_TYPES).optional(),
  module: z.string().regex(/^M\d{2}$/).optional(),
  action: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^[a-z_]+\.[a-z_]+$/)).max(20))
    .optional()
    .meta({ description: 'One action or a comma-separated list' }),
  entityType: z.string().max(40).optional(),
  entityId: z.string().max(64).optional(),
  severity: z.enum(SEVERITIES).optional(),
  stepUp: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
};

const page = { cursor: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) };

// ---------------- responses ----------------
const AuditEntry = z
  .object({
    id: z.string(),
    occurredAt: dateTime,
    actor: z.object({ type: z.enum(ACTOR_TYPES), id: z.uuid().nullable(), name: z.string().nullable(), role: z.string().nullable() }),
    action: z.string(),
    module: z.string(),
    summary: z.object({ en: z.string(), bn: z.string() }),
    entity: z.object({ type: z.string().nullable(), id: z.string().nullable(), code: z.string().nullable() }),
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
    reason: z.string().nullable(),
    severity: z.enum(SEVERITIES),
    stepUp: z.boolean(),
    ip: z.string().nullable(),
  })
  .meta({ id: 'AuditEntry' });

const AuditEntryDetail = AuditEntry.extend({
  meta: z.unknown().nullable(),
  requestId: z.string().nullable(),
  sessionId: z.string().nullable(),
  userAgent: z.string().nullable(),
  chain: z.object({ sealed: z.boolean(), seq: z.number().int().nullable(), intact: z.boolean().nullable() }),
}).meta({ id: 'AuditEntryDetail' });

const AuditPage = z.object({ items: z.array(AuditEntry), nextCursor: z.string().nullable() }).meta({ id: 'AuditPage' });

const AuditExport = z
  .object({
    id: z.uuid(),
    status: z.enum(['queued', 'running', 'ready', 'failed', 'expired']),
    rowCount: z.number().int().nullable(),
    filters: z.record(z.string(), z.unknown()),
    createdAt: dateTime,
    completedAt: dateTime.nullable(),
    expiresAt: dateTime.nullable(),
    downloadPath: z.string().nullable(),
  })
  .meta({ id: 'AuditExport' });

module.exports = {
  searchQuery: z.object({ ...filterFields, ...page }),
  idParam: z.object({ id: z.string().regex(/^\d+$/) }),
  entityParams: z.object({ entityType: z.string().max(40), entityId: z.string().max(64) }),
  pageQuery: z.object(page),
  exportBody: z.object({ filters: z.object(filterFields).default({}) }),
  exportIdParam: z.object({ id: z.uuid() }),
  AuditEntry,
  AuditEntryDetail,
  AuditPage,
  AuditExport,
};
