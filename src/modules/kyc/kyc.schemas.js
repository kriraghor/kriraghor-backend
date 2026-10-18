'use strict';

/**
 * M02 request and response schemas (zod → validation and OpenAPI). NID numbers appear in the submit
 * request and the audited reveal response only; everything else carries `•••• 1234`.
 */
const { z } = require('zod');

const dateTime = z.iso.datetime({ offset: true });
const DOC_STATUSES = ['in_review', 'changes_requested', 'approved', 'rejected', 'superseded', 'withdrawn'];

const idParam = z.object({ id: z.uuid() });
const fileParams = z.object({ id: z.uuid(), fileId: z.uuid() });
const BUSINESS_TYPES = ['trade_license', 'deed_or_lease', 'tin', 'bin', 'credential', 'police_clearance'];
const BUSINESS_ROLES = ['ground_owner', 'shop_owner', 'gym_owner', 'player', 'pro'];
const verificationQuery = z.object({ locale: z.enum(['en', 'bn']).default('en'), role: z.enum(['member', ...BUSINESS_ROLES]).default('member') });
const uploadQuery = z.object({ slot: z.enum(['front', 'back', 'selfie', 'document']), docType: z.enum(['nid', ...BUSINESS_TYPES]).default('nid') });

const nidBody = z.object({
  docType: z.literal('nid'),
  fields: z.object({
    legalName: z.string().trim().min(3).max(120).meta({ description: 'Full name exactly as printed on the NID' }),
    number: z.string().trim().min(10).max(24).meta({ description: '10, 13 or 17 digits (spaces and dashes are ignored)' }),
    dob: z.iso.date().meta({ description: 'Date of birth as on the NID (YYYY-MM-DD)' }),
  }),
  files: z.object({ front: z.uuid(), back: z.uuid(), selfie: z.uuid() }).meta({ description: 'File ids from POST /me/documents/files, by slot' }),
  consent: z.literal(true).meta({ description: 'Agreement to the Privacy Policy and Terms for identity checks' }),
});

/** A business document: fields follow the requirement (GET /me/verification?role= lists them). */
const businessBody = z.object({
  docType: z.enum(BUSINESS_TYPES),
  fields: z.record(z.string(), z.string().max(200).nullable()).meta({ description: 'By field key, e.g. number, holderName, expiresOn (YYYY-MM-DD), kind' }),
  files: z.object({ document: z.uuid() }).meta({ description: 'The file id from POST /me/documents/files?slot=document' }),
  role: z.enum(BUSINESS_ROLES).optional().meta({ description: 'The business role the document is for (documents are kept per role). Needed only when more than one applied role asks for this type' }),
  consent: z.literal(true),
});
const submitBody = z.discriminatedUnion('docType', [nidBody, ...BUSINESS_TYPES.map((t) => businessBody.extend({ docType: z.literal(t) }))]);

const revealBody = z.object({ reason: z.string().trim().min(3).max(300) });

// ---------------- responses
const File = z.object({ id: z.uuid(), slot: z.string(), mime: z.string(), sizeBytes: z.number().int(), purged: z.boolean() });
const Document = z
  .object({
    id: z.uuid(),
    docType: z.string(),
    version: z.number().int(),
    status: z.enum(DOC_STATUSES),
    numberMasked: z.string().nullable(),
    birthYear: z.number().int().nullable(),
    expiresOn: z.string().nullable(),
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
  required: z.enum(['always', 'conditional', 'optional']),
  fields: z.array(z.object({ key: z.string(), type: z.string(), required: z.boolean(), options: z.array(z.string()).nullable(), label: z.string() })),
  status: z.string(),
  document: Document.nullable(),
});
const Verification = z
  .object({
    role: z.string(),
    memberStatus: z.string().nullable(),
    roleStatus: z.string().nullable(),
    badge: z.enum(['fully_verified', 'documents_in_review', 'verification_needed']),
    progress: z.object({ approved: z.number().int(), total: z.number().int() }),
    items: z.array(Item),
    unlocks: z.array(z.string()),
    limits: z.array(z.string()),
  })
  .meta({ id: 'Verification' });
const Uploaded = z.object({ fileId: z.uuid(), slot: z.string(), mime: z.string(), sizeBytes: z.number().int() }).meta({ id: 'DocumentFileUploaded' });
const Check = z.object({ key: z.string(), ok: z.boolean(), blocks: z.boolean(), detail: z.string().nullable().optional() });
const Review = Document.extend({
  fields: z.looseObject({ legalName: z.string().optional(), dob: z.string().optional(), numberMasked: z.string().nullable() }).meta({ description: 'NID: legalName, dob. Business: the typed fields (holderName, expiresOn, kind) and the role' }),
  checks: z.array(Check),
  decidedBy: z.uuid().nullable(),
  user: z.object({ id: z.uuid(), displayName: z.string().nullable(), kycStatus: z.string().nullable(), phoneVerified: z.boolean(), accountStatus: z.string().nullable() }),
  history: z.array(z.object({ id: z.uuid(), version: z.number().int(), status: z.string(), reasonCode: z.string().nullable(), submittedAt: dateTime, decidedAt: dateTime.nullable() })),
}).meta({ id: 'KycReview' });
const Reveal = z
  .object({ documentId: z.uuid(), number: z.string(), normalised: z.string(), showForSeconds: z.number().int() })
  .meta({ id: 'KycNidReveal', description: 'The full NID number for 60 seconds. Audited (critical); never stored or logged; do not cache.' });

module.exports = { idParam, fileParams, verificationQuery, uploadQuery, submitBody, revealBody, Document, Verification, Uploaded, Review, Reveal };
