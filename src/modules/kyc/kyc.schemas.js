'use strict';

/**
 * M02 request and response schemas (zod → validation and OpenAPI). NID numbers appear in the submit
 * request and the audited reveal response only; everything else carries `•••• 1234`.
 */
const { z } = require('zod');
const rules = require('./kyc.rules');

const dateTime = z.iso.datetime({ offset: true });
const limit = (max, def) => z.coerce.number().int().min(1).max(max).default(def);
const DOC_STATUSES = ['in_review', 'changes_requested', 'approved', 'rejected', 'superseded', 'withdrawn'];

const idParam = z.object({ id: z.uuid() });
const fileParams = z.object({ id: z.uuid(), fileId: z.uuid() });
const verificationQuery = z.object({ locale: z.enum(['en', 'bn']).default('en') });
const uploadQuery = z.object({ slot: z.enum(['front', 'back', 'selfie']) });

const submitBody = z.object({
  docType: z.literal('nid'),
  fields: z.object({
    legalName: z.string().trim().min(3).max(120).meta({ description: 'Full name exactly as printed on the NID' }),
    number: z.string().trim().min(10).max(24).meta({ description: '10, 13 or 17 digits (spaces and dashes are ignored)' }),
    dob: z.iso.date().meta({ description: 'Date of birth as on the NID (YYYY-MM-DD)' }),
  }),
  files: z.object({ front: z.uuid(), back: z.uuid(), selfie: z.uuid() }).meta({ description: 'File ids from POST /me/documents/files, by slot' }),
  consent: z.literal(true).meta({ description: 'Agreement to the Privacy Policy and Terms for identity checks' }),
});

const adminListQuery = z.object({ status: z.enum(DOC_STATUSES).default('in_review'), cursor: z.uuid().optional(), limit: limit(100, 50) });
const revealBody = z.object({ reason: z.string().trim().min(3).max(300) });
const decideBody = z.object({
  decision: z.enum(['approve', 'changes_requested', 'reject']),
  rubric: z.object({ nameMatches: z.boolean(), readable: z.boolean(), notExpired: z.boolean() }).partial().optional(),
  reasonCode: z.enum(rules.REASONS).optional(),
  note: z.string().trim().max(500).optional(),
});

// ---------------- responses
const File = z.object({ id: z.uuid(), slot: z.string(), mime: z.string(), sizeBytes: z.number().int(), purged: z.boolean() });
const Document = z
  .object({
    id: z.uuid(),
    docType: z.string(),
    version: z.number().int(),
    status: z.enum(DOC_STATUSES),
    numberMasked: z.string(),
    birthYear: z.number().int(),
    reasonCode: z.string().nullable(),
    reasonText: z.string().nullable(),
    decidedAt: dateTime.nullable(),
    submittedAt: dateTime,
    files: z.array(File),
  })
  .meta({ id: 'VerificationDocument' });
const Item = z.object({
  key: z.string(),
  label: z.string(),
  why: z.string().nullable(),
  fileSlots: z.array(z.string()),
  status: z.string(),
  document: Document.nullable(),
});
const Verification = z
  .object({
    role: z.string(),
    memberStatus: z.string().nullable(),
    badge: z.enum(['fully_verified', 'documents_in_review', 'verification_needed']),
    progress: z.object({ approved: z.number().int(), total: z.number().int() }),
    items: z.array(Item),
    unlocks: z.array(z.string()),
    limits: z.array(z.string()),
  })
  .meta({ id: 'Verification' });
const Uploaded = z.object({ fileId: z.uuid(), slot: z.string(), mime: z.string(), sizeBytes: z.number().int() }).meta({ id: 'DocumentFileUploaded' });
const Check = z.object({ key: z.string(), ok: z.boolean(), blocks: z.boolean(), detail: z.string().nullable().optional() });
const QueueRow = Document.extend({ user: z.object({ id: z.uuid(), displayName: z.string().nullable() }), failedChecks: z.array(z.string()) });
const Queue = z.object({ items: z.array(QueueRow), nextCursor: z.string().nullable(), counts: z.record(z.string(), z.number().int()) }).meta({ id: 'KycQueue' });
const Review = Document.extend({
  fields: z.object({ legalName: z.string(), dob: z.string(), numberMasked: z.string() }),
  checks: z.array(Check),
  decidedBy: z.uuid().nullable(),
  user: z.object({ id: z.uuid(), displayName: z.string().nullable(), kycStatus: z.string().nullable(), phoneVerified: z.boolean(), accountStatus: z.string().nullable() }),
  history: z.array(z.object({ id: z.uuid(), version: z.number().int(), status: z.string(), reasonCode: z.string().nullable(), submittedAt: dateTime, decidedAt: dateTime.nullable() })),
}).meta({ id: 'KycReview' });
const Decided = Document.extend({ checks: z.array(Check) }).meta({ id: 'KycDecided' });
const Reveal = z
  .object({ documentId: z.uuid(), number: z.string(), normalised: z.string(), showForSeconds: z.number().int() })
  .meta({ id: 'KycNidReveal', description: 'The full NID number for 60 seconds. Audited (critical); never stored or logged; do not cache.' });

module.exports = { idParam, fileParams, verificationQuery, uploadQuery, submitBody, adminListQuery, revealBody, decideBody, Document, Verification, Uploaded, Queue, Review, Decided, Reveal };
