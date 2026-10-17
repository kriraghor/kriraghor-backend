'use strict';

/** M18 request and response schemas (zod → validation and OpenAPI). */
const { z } = require('zod');

const id = z.uuid();
const dateTime = z.string();
const SEVERITIES = ['info', 'medium', 'high', 'critical'];
const ACTIONS = ['freeze_payouts', 'request_documents', 'clear', 'suspend', 'ban'];

const userParam = z.object({ userId: id });
const idParam = z.object({ id });
const flagsQuery = z.object({
  status: z.enum(['active', 'open', 'actioned', 'cleared', 'lapsed']).default('active'),
  severity: z.enum(SEVERITIES).optional(),
  rule: z.string().max(40).optional(),
  cursor: dateTime.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const reason = z.string().trim().min(10).max(500).meta({ description: 'Why (at least 10 characters; kept in the audit log)' });
const actionBody = z.object({
  action: z.enum(ACTIONS),
  flagId: id.optional(),
  reason,
  params: z
    .object({ days: z.number().int().min(1).max(365).optional(), docType: z.enum(['nid', 'trade_license', 'deed_or_lease', 'tin']).optional() })
    .default({})
    .meta({ description: 'suspend: days (staff up to risk.staff_suspend_max_days; masters may leave it out); request_documents: docType' }),
});
const undoBody = z.object({ reason });
const thresholdsBody = z.object({ changes: z.array(z.object({ key: z.string().regex(/^(risk|trust)\./), to: z.unknown() })).min(1).max(20), reason: z.string().trim().min(5).max(500) });

const Flag = z
  .object({ id, userId: id, ruleKey: z.string(), severity: z.enum(SEVERITIES), status: z.string(), metricValue: z.number(), threshold: z.number(), reasonText: z.string(), escalated: z.boolean(), firstSeenAt: dateTime, lastSeenAt: dateTime })
  .loose()
  .meta({ id: 'RiskFlag' });
const FlagList = z.object({ items: z.array(Flag), nextCursor: z.string().nullable() }).meta({ id: 'RiskFlagList' });
const Counts = z.object(Object.fromEntries(SEVERITIES.map((s) => [s, z.number().int()])));
const Overview = z.object({ counts: Counts, rules: z.array(z.object({ key: z.string(), settingKey: z.string().nullable(), threshold: z.number(), severity: z.string(), description: z.string(), enabled: z.boolean(), open: z.number().int() }).loose()) }).meta({ id: 'RiskOverview' });
const Action = z.object({ id, userId: id, flagId: id.nullable(), action: z.string(), reason: z.string(), actorRole: z.string(), reversesActionId: id.nullable(), createdAt: dateTime }).loose().meta({ id: 'RiskAction' });
const Score = z.object({ kind: z.enum(['owner', 'booker']), score: z.number().int().nullable(), shown: z.boolean(), sample: z.number().int() }).loose().meta({ id: 'TrustScore' });
const Account = z
  .object({
    user: z.object({ id, displayName: z.string().nullable(), status: z.string(), kycStatus: z.string().nullable() }).loose(),
    riskLevel: z.enum(['none', ...SEVERITIES]),
    flags: z.array(Flag),
    metrics: z.array(z.object({ metric: z.string(), value: z.number(), sample: z.number().int() }).loose()),
    actions: z.array(Action.extend({ undone: z.boolean(), undoable: z.boolean() })),
    trust: z.array(Score),
    holds: z.array(z.object({ id, type: z.string(), scope: z.string() }).loose()),
    documentRequests: z.array(z.object({ id, docType: z.string(), status: z.string(), dueAt: dateTime }).loose()),
  })
  .meta({ id: 'RiskAccount' });
const Scores = z.object({ items: z.array(Score) }).meta({ id: 'TrustScores' });
const DocumentRequests = z.object({ items: z.array(z.object({ id, docType: z.string(), reason: z.string(), status: z.string(), dueAt: dateTime }).loose()) }).meta({ id: 'DocumentRequests' });

module.exports = { SEVERITIES, ACTIONS, userParam, idParam, flagsQuery, actionBody, undoBody, thresholdsBody, Flag, FlagList, Overview, Action, Account, Scores, DocumentRequests };
