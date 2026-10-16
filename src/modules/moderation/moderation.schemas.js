'use strict';

/** M05 request and response schemas (zod → validation and OpenAPI). */
const { z } = require('zod');

const dateTime = z.iso.datetime({ offset: true });
const STATUSES = ['pending_review', 'changes_requested', 'approved', 'rejected', 'withdrawn', 'superseded'];

const idParam = z.object({ id: z.uuid() });
const mineQuery = z.object({ kind: z.string().max(30).optional(), status: z.enum(STATUSES).optional() });
const listQuery = z.object({
  status: z.enum(STATUSES).default('pending_review'),
  kind: z.string().max(30).optional(),
  claimed: z.enum(['me', 'others', 'none']).optional(),
  overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  q: z.string().trim().max(80).optional(),
});
const ticksBody = z.object({ ticks: z.array(z.string().max(60)).max(30) });
const releaseBody = z.object({ force: z.boolean().optional().meta({ description: 'Master only: release another reviewer’s lock (audited)' }) });
const decideBody = z.object({
  decision: z.enum(['approve', 'request_changes', 'reject']),
  reasonCode: z.string().max(40).optional(),
  reasonText: z.string().trim().max(500).optional().meta({ description: 'Sent to the submitter; required when the reason is "other"' }),
  override: z.string().trim().min(3).max(500).optional().meta({ description: 'Master only, with step-up moderation.override: approve despite a failing hard check (audited)' }),
});
const reopenBody = z.object({ reason: z.string().trim().min(3).max(500) });

// ---------------- responses
const Person = z.object({ id: z.uuid(), name: z.string().nullable() });
const Claim = z.object({ staffId: z.uuid(), name: z.string().nullable(), mine: z.boolean(), expiresAt: dateTime, hardExpiresAt: dateTime }).nullable();
const Row = z.object({
  id: z.uuid(),
  kind: z.string(),
  subjectId: z.uuid(),
  version: z.number().int(),
  isEdit: z.boolean(),
  title: z.string(),
  status: z.enum(STATUSES),
  submittedBy: Person,
  submittedAt: dateTime,
  slaDueAt: dateTime,
  sla: z.enum(['ok', 'warn', 'overdue']).nullable(),
  claim: Claim,
  reasonCode: z.string().nullable(),
  decidedAt: dateTime.nullable(),
  decidedBy: Person.nullable(),
});
const Queue = z.object({ items: z.array(Row) }).meta({ id: 'ModerationQueue' });
const Stats = z.object({ inQueue: z.number().int(), overdue: z.number().int(), claimedByYou: z.number().int(), decidedToday: z.number().int() }).meta({ id: 'ModerationStats' });
const Check = z.object({ key: z.string(), severity: z.enum(['hard', 'soft']), result: z.enum(['pass', 'warn', 'fail', 'pending', 'not_computed']), detail: z.string().nullable() });
const Detail = Row.extend({
  payload: z.object({}).loose(),
  reasonText: z.string().nullable(),
  checks: z.array(Check),
  rubric: z.object({ id: z.uuid(), version: z.number().int(), items: z.array(z.object({ key: z.string(), labelEn: z.string(), labelBn: z.string() }).loose()) }).nullable(),
  ticks: z.array(z.string()),
  rubricResult: z.array(z.object({ itemKey: z.string(), ticked: z.boolean() })).nullable(),
  override: z.object({ by: z.string().nullable(), reason: z.string().nullable() }).nullable(),
  appliedAt: dateTime.nullable(),
  reasons: z.array(z.object({ code: z.string(), labelEn: z.string(), labelBn: z.string(), requiresText: z.boolean() })),
  history: z.array(z.object({ id: z.uuid(), version: z.number().int(), status: z.enum(STATUSES), reasonCode: z.string().nullable(), decidedBy: z.string().nullable(), decidedAt: dateTime.nullable(), submittedAt: dateTime })),
}).meta({ id: 'ModerationDetail' });
const Heartbeat = z.object({ expiresAt: dateTime, hardExpiresAt: dateTime }).meta({ id: 'ModerationHeartbeat' });
const Ticks = z.object({ ticks: z.array(z.string()), missing: z.array(z.string()) }).meta({ id: 'ModerationTicks' });
const Released = z.object({ released: z.boolean() }).meta({ id: 'ModerationReleased' });
const Own = z
  .object({
    id: z.uuid(),
    kind: z.string(),
    subjectId: z.uuid(),
    version: z.number().int(),
    title: z.string(),
    status: z.enum(STATUSES),
    reasonCode: z.string().nullable(),
    reasonText: z.string().nullable(),
    submittedAt: dateTime,
    decidedAt: dateTime.nullable(),
    appliedAt: dateTime.nullable(),
  })
  .meta({ id: 'MySubmission' });
const OwnList = z.object({ items: z.array(Own) }).meta({ id: 'MySubmissionList' });

module.exports = { idParam, mineQuery, listQuery, ticksBody, releaseBody, decideBody, reopenBody, Queue, Stats, Detail, Heartbeat, Ticks, Released, Own, OwnList };
