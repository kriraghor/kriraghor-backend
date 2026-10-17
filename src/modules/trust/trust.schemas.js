'use strict';

/**
 * M17 request and response schemas (zod → validation and OpenAPI). Money in poisha; times ISO.
 */
const { z } = require('zod');
const esS = require('../esports/esports.schemas');

const id = z.uuid();
const poisha = z.number().int().nonnegative();
const dateTime = z.string();
const code = z.string().regex(/^[A-Z0-9-]{6,20}$/);
const text = (max) => z.string().trim().min(2).max(max);
const limit = (max, dflt) => z.coerce.number().int().min(1).max(max).default(dflt);

const OUTCOMES = ['all', 'half', 'none', 'custom', 'upheld', 'rejected', 'corrected'];
const CATEGORIES = ['no_show_contest', 'venue_problem', 'cash_problem', 'not_received'];
const SUBJECTS = ['ground', 'booking', 'user', 'review', 'esports_tournament', 'shop', 'product'];
const REASONS = ['fake_listing', 'wrong_info', 'unsafe', 'harassment', 'fraud', 'spam', 'offensive', 'cheating', 'other'];
const RESOLUTIONS = ['no_violation', 'content_removed', 'owner_warned', 'user_suspended', 'converted_to_dispute'];

// ---------------- requests
const codeParam = z.object({ code });
const evidenceParam = z.object({ code, eid: id });
const idParam = z.object({ id });
const subjectParam = z.object({ type: z.enum(SUBJECTS), id });

const openBody = z.object({
  sourceType: z.enum(['booking', 'sub_order']).meta({ description: 'A booking or a shop sub-order (M13). Esports result disputes open from the match page (POST /me/esports/matches/{id}/disputes)' }),
  sourceId: id,
  category: z.enum(CATEGORIES),
  statement: text(2000),
});
const optionsQuery = z.object({ sourceType: z.enum(['booking', 'esports_result', 'sub_order']).default('booking'), sourceId: id });
const mineQuery = z.object({ role: z.enum(['claimant', 'respondent']).default('claimant'), status: z.enum(['active', 'closed']).optional(), sourceId: id.optional(), cursor: dateTime.optional(), limit: limit(50, 20) });
const statementBody = z.object({ text: text(2000) });
const withdrawBody = z.object({ reason: text(500).optional() });
const adminListQuery = z.object({
  status: z.enum(['active', 'awaiting_response', 'under_review', 'escalated', 'resolved', 'withdrawn', 'all']).default('active'),
  sourceType: z.enum(['booking', 'esports_result', 'sub_order']).optional(),
  mine: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  code: code.optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: limit(100, 50),
});
const decideBody = z.object({
  outcome: z.enum(OUTCOMES),
  refund: poisha.optional().meta({ description: 'The refund for outcome custom (at most what the case holds)' }),
  rows: z.array(esS.resultRow).max(200).default([]).meta({ description: 'Corrected results (esports, outcome corrected)' }),
  reason: text(1000),
  version: z.number().int().positive().optional(),
});
const escalateBody = z.object({ outcome: z.enum(OUTCOMES).optional(), refund: poisha.optional(), note: text(1000), version: z.number().int().positive().optional() });
const noteBody = z.object({ text: text(2000) });
const hideBody = z.object({ reason: text(200) });
const sendBackBody = z.object({ note: text(1000) });

const reportBody = z.object({ subjectType: z.enum(SUBJECTS), subjectId: id, reasonCode: z.enum(REASONS), note: z.string().trim().max(500).optional() });
const reportListQuery = z.object({ status: z.enum(['open', 'escalated']).default('open'), subjectType: z.enum(SUBJECTS).optional(), limit: limit(100, 50) });
const resolveBody = z.object({ subjectType: z.enum(SUBJECTS), subjectId: id, action: z.enum(RESOLUTIONS), note: text(500) });
const escalateReportBody = z.object({ subjectType: z.enum(SUBJECTS), subjectId: id, note: text(500) });
const dismissBody = z.object({ note: text(500) });

const reviewBody = z.object({ bookingId: id, stars: z.number().int().min(1).max(5), text: z.string().trim().max(1000).optional() });
const reviewPatch = z.object({ stars: z.number().int().min(1).max(5).optional(), text: z.string().trim().max(1000).nullable().optional() }).refine((v) => v.stars !== undefined || v.text !== undefined, 'Change the stars or the text');
const replyBody = z.object({ text: text(1000) });
const publicReviewsQuery = z.object({ cursor: dateTime.optional(), limit: limit(50, 20) });
const ownerReviewsQuery = z.object({ groundId: id.optional(), cursor: dateTime.optional(), limit: limit(100, 50) });
const adminReviewsQuery = z.object({ status: z.enum(['held', 'hidden', 'published']).default('held'), groundId: id.optional(), cursor: dateTime.optional(), limit: limit(100, 50) });
const hideReviewBody = z.object({ reason: text(200) });

// ---------------- responses
const Case = z
  .object({
    code: z.string(),
    sourceType: z.string(),
    sourceId: id,
    sourceRef: z.string(),
    category: z.string(),
    status: z.string(),
    money: z.boolean(),
    paid: poisha,
    held: poisha,
    policyKey: z.string(),
    policy: z.object({}).loose(),
    outcome: z.string().nullable(),
    refund: poisha.nullable(),
    released: poisha.nullable(),
    fee: poisha.nullable(),
    decisionReason: z.string().nullable(),
    version: z.number().int(),
  })
  .loose()
  .meta({ id: 'Dispute' });
const Evidence = z.object({ id, party: z.string(), kind: z.string(), text: z.string().nullable(), file: z.object({ mime: z.string(), sizeBytes: z.number().int() }).nullable(), hidden: z.boolean(), createdAt: dateTime }).loose().meta({ id: 'DisputeEvidence' });
const PartyCase = z
  .object({ dispute: Case, role: z.string().nullable(), source: z.object({}).loose().nullable(), evidence: z.array(Evidence), can: z.object({ respond: z.boolean(), addEvidence: z.boolean(), filesLeft: z.number().int(), withdraw: z.boolean() }) })
  .meta({ id: 'PartyDispute' });
const CaseList = z.object({ items: z.array(Case), nextCursor: z.string().nullable() }).meta({ id: 'DisputeList' });
const Options = z.object({ items: z.array(z.object({ category: z.string(), money: z.boolean(), held: poisha, closesAt: dateTime.nullable() })), dispute: z.string().nullable() }).meta({ id: 'DisputeOptions' });
const Plan = z.object({ refund: poisha, release: poisha, feeBase: poisha, fee: poisha, net: poisha });
const StaffCase = z
  .object({ dispute: Case, claimant: z.object({}).loose().nullable(), respondent: z.object({}).loose().nullable(), claim: z.object({}).loose().nullable(), source: z.object({}).loose().nullable(), evidence: z.array(Evidence), outcomes: z.array(z.string()), previews: z.record(z.string(), Plan), limits: z.object({ staffRefundPoisha: poisha, canRefund: z.boolean() }) })
  .loose()
  .meta({ id: 'StaffDispute' });
const StaffList = z.object({ items: z.array(Case.extend({ dueAt: dateTime.nullable(), overdue: z.boolean(), claimedBy: id.nullable(), claimedByMe: z.boolean() })), nextCursor: z.string().nullable() }).meta({ id: 'StaffDisputeList' });
const EvidenceResult = z.object({ evidence: Evidence }).meta({ id: 'DisputeEvidenceResult' });

const ReportResult = z.object({ report: z.object({ code: z.string(), status: z.string(), subjectType: z.string(), subjectId: id, createdAt: dateTime }) }).meta({ id: 'ReportResult' });
const MyReports = z.object({ items: z.array(z.object({ code: z.string(), subjectType: z.string(), subjectId: id, reasonCode: z.string(), status: z.string(), resolution: z.string().nullable() }).loose()) }).meta({ id: 'MyReports' });
const ReportQueue = z.object({ items: z.array(z.object({ subjectType: z.string(), subjectId: id, reports: z.number().int(), eligible: z.number().int(), flagged: z.boolean(), reasons: z.array(z.string()), subject: z.object({}).loose().nullable() }).loose()), threshold: z.number().int() }).meta({ id: 'ReportQueue' });
const ReportSubject = z.object({ subjectType: z.string(), subjectId: id, subject: z.object({}).loose().nullable(), actions: z.array(z.string()), items: z.array(z.object({}).loose()) }).meta({ id: 'ReportSubject' });
const ReportAction = z.object({}).loose().meta({ id: 'ReportActionResult' });

const ReviewView = z
  .object({ id, subjectType: z.string(), subjectId: id, bookingId: id, stars: z.number().int(), text: z.string().nullable(), status: z.string(), author: z.object({ displayName: z.string().nullable() }).loose(), reply: z.object({ text: z.string(), at: dateTime.nullable() }).nullable(), createdAt: dateTime })
  .loose()
  .meta({ id: 'Review' });
const ReviewResult = z.object({ review: ReviewView }).meta({ id: 'ReviewResult' });
const ReviewList = z.object({ items: z.array(ReviewView), nextCursor: z.string().nullable().optional() }).meta({ id: 'ReviewList' });
const PublicReviews = ReviewList.extend({ summary: z.object({ count: z.number().int(), avg: z.number().nullable(), histogram: z.array(z.number().int()) }) }).meta({ id: 'PublicReviews' });
const Reviewable = z.object({ items: z.array(z.object({ bookingId: id, code: z.string(), groundId: id, groundName: z.string().nullable(), groundSlug: z.string().nullable(), end: dateTime })) }).meta({ id: 'Reviewable' });

module.exports = {
  OUTCOMES,
  CATEGORIES,
  SUBJECTS,
  REASONS,
  codeParam,
  evidenceParam,
  idParam,
  subjectParam,
  openBody,
  optionsQuery,
  mineQuery,
  statementBody,
  withdrawBody,
  adminListQuery,
  decideBody,
  escalateBody,
  noteBody,
  hideBody,
  sendBackBody,
  reportBody,
  reportListQuery,
  resolveBody,
  escalateReportBody,
  dismissBody,
  reviewBody,
  reviewPatch,
  replyBody,
  publicReviewsQuery,
  ownerReviewsQuery,
  adminReviewsQuery,
  hideReviewBody,
  Case,
  PartyCase,
  CaseList,
  Options,
  StaffCase,
  StaffList,
  EvidenceResult,
  ReportResult,
  MyReports,
  ReportQueue,
  ReportSubject,
  ReportAction,
  ReviewResult,
  ReviewList,
  PublicReviews,
  Reviewable,
};
