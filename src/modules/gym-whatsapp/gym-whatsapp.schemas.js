'use strict';

/**
 * M24 §25 WhatsApp request and response schemas (zod → validation and OpenAPI). Phone numbers are accepted
 * in any Bangladesh form (01…, 880…, +880…) and normalised by the service; a member's number is never
 * returned to staff, only its last 4 digits.
 */
const { z } = require('zod');
const { AUTO_KINDS } = require('./templates');

const id = z.uuid();
const dateTime = z.iso.datetime({ offset: true });
const phoneIn = z.string().trim().min(10).max(20);
const e164 = z.string().regex(/^\+8801[3-9]\d{8}$/);

// ---------------- params
const gymParam = z.object({ gymId: id });
const memberParam = z.object({ gymId: id, memberId: id });
const myMemberParam = z.object({ memberId: id });
const senderParam = z.object({ senderId: id });
const feePaymentParam = z.object({ gymId: id, feePaymentId: id });
const sendsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() });
const messagesQuery = z.object({ memberId: id, limit: z.coerce.number().int().min(1).max(100).optional() });

// ---------------- bodies
/** PUT /manage/whatsapp/number: the owner's number for every branch (null removes it). */
const ownerNumberBody = z.object({ number: phoneIn.nullable() });
/** PATCH /manage/gyms/:gymId/whatsapp: the branch's own number (null: use the owner's) and the gym page button. */
const gymPatch = z
  .object({
    number: phoneIn.nullable().optional(),
    showOnPage: z.boolean().optional(),
    senderId: id.nullable().optional().meta({ description: 'Step 2: the connected number this branch sends from (null: none)' }),
    autoKinds: z.array(z.enum(AUTO_KINDS)).max(AUTO_KINDS.length).optional().meta({ description: 'Step 2: the automatic messages this branch sends on WhatsApp' }),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to change' });
/** POST /manage/whatsapp/senders: what Meta's embedded sign-up returned to the panel. */
const connectBody = z.object({ code: z.string().min(4).max(1024), wabaId: z.string().regex(/^\d{5,32}$/), phoneNumberId: z.string().regex(/^\d{5,32}$/) });
const segment = z.object({ kind: z.enum(['active', 'expiring', 'expired', 'not_seen', 'package']), days: z.number().int().optional(), packageId: id.optional() }).meta({ id: 'GymWhatsappSegment' });
const estimateBody = z.object({ kind: z.enum(['notice', 'greeting']), segment });
const text = (min, max) => z.string().trim().min(min).max(max);
const sendBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('notice'), segment, title: text(1, 80), message: text(1, 500) }),
  z.object({ kind: z.literal('greeting'), segment, message: text(1, 500) }),
  z.object({ kind: z.literal('single'), memberId: id, message: text(1, 500) }),
]);
/** PUT …/members/:memberId/whatsapp and PUT /me/gym-whatsapp/:memberId: null number = the member's phone. */
const consentBody = z.object({ number: phoneIn.nullable().default(null), service: z.boolean(), news: z.boolean() });

// ---------------- responses
const NumberSource = z.enum(['own', 'owner', 'none']);
const GymNumber = z.object({
  gymId: id,
  name: z.string(),
  number: e164.nullable().meta({ description: 'The branch’s own number; null uses the owner’s' }),
  showOnPage: z.boolean(),
  source: NumberSource,
  shown: e164.nullable().meta({ description: 'The number the gym page shows, or null' }),
  senderId: id.nullable(),
  autoKinds: z.array(z.enum(AUTO_KINDS)),
});
const Sender = z
  .object({
    id,
    displayNumber: z.string(),
    verifiedName: z.string().nullable(),
    status: z.enum(['connected', 'restricted', 'disconnected']),
    quality: z.string().nullable(),
    messagingLimit: z.string().nullable(),
    creditAttached: z.boolean(),
    connectedAt: dateTime.nullable(),
    templates: z.object({ approved: z.number().int(), pending: z.number().int(), rejected: z.number().int() }),
  })
  .meta({ id: 'GymWhatsappSender' });
const Units = z.object({
  available: z.boolean(),
  enabled: z.boolean(),
  status: z.enum(['active', 'paused', 'ended']).nullable(),
  balance: z.number().int(),
  included: z.number().int(),
  bundle: z.object({ size: z.number().int(), pricePoisha: z.number().int(), validDays: z.number().int() }),
  units: z.object({ utility: z.number().int(), marketing: z.number().int() }),
  lowBalance: z.number().int(),
  bundles: z.array(z.object({ units: z.number().int(), expiresOn: z.string() })),
});
const OwnerWhatsapp = z.object({
  apiEnabled: z.boolean().meta({ description: 'gym_whatsapp.api_enabled: sending from the panel (off until Meta approves)' }),
  number: e164.nullable(),
  gyms: z.array(GymNumber),
  senders: z.array(Sender),
  units: Units,
  signUp: z.object({ appId: z.string(), configId: z.string() }).nullable().meta({ description: 'Meta embedded sign-up values for the panel (null while off or not set up)' }),
});
const GymWhatsapp = GymNumber.extend({ ownerNumber: e164.nullable(), apiEnabled: z.boolean(), sender: Sender.nullable(), autoKindsAvailable: z.array(z.enum(AUTO_KINDS)) });
const Senders = z.array(Sender);
const Estimate = z.object({
  members: z.number().int(),
  reachable: z.number().int(),
  no_consent: z.number().int(),
  template: z.number().int().meta({ description: 'Members whose language has no approved template yet' }),
  no_sender: z.number().int(),
  unitsNeeded: z.number().int(),
  balance: z.number().int(),
  bulkLeft: z.number().int(),
  senderConnected: z.boolean(),
  addonActive: z.boolean(),
});
const StatusCounts = z.object({ queued: z.number().int(), sent: z.number().int(), delivered: z.number().int(), read: z.number().int(), failed: z.number().int() });
const Send = z.object({
  id,
  kind: z.enum(['notice', 'greeting', 'single']),
  params: z.record(z.string(), z.string()),
  segment: segment.nullable(),
  memberId: id.nullable(),
  targetCount: z.number().int(),
  queuedCount: z.number().int(),
  unitsHeld: z.number().int(),
  sentAt: dateTime.nullable(),
  status: StatusCounts,
});
const Sends = z.object({ items: z.array(Send), bulkLeft: z.number().int() });
const Message = z.object({
  id,
  kind: z.enum(['receipt', 'renewal_due', 'ends_today', 'overdue', 'pay_link', 'notice', 'greeting', 'single']),
  category: z.enum(['utility', 'marketing']),
  text: z.string(),
  status: z.enum(['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'expired']),
  errorCode: z.string().nullable(),
  createdAt: dateTime.nullable(),
  sentAt: dateTime.nullable(),
  deliveredAt: dateTime.nullable(),
  readAt: dateTime.nullable(),
});
const Messages = z.object({ items: z.array(Message) });
const ReceiptQueued = z.object({ queued: z.literal(true), messageId: id });
const Consent = z.object({
  service: z.boolean().meta({ description: 'Receipts and reminders (WhatsApp utility messages)' }),
  news: z.boolean().meta({ description: 'News and offers (WhatsApp marketing messages)' }),
  source: z.enum(['member', 'desk', 'stop_reply']).nullable(),
  at: dateTime.nullable(),
  numberLast4: z.string().nullable(),
  consentVersion: z.number().int().nullable(),
  currentVersion: z.number().int().meta({ description: 'gym_whatsapp.consent_version: a member who agreed to an older text is asked again' }),
});
const MemberConsent = Consent.extend({ phoneLast4: z.string().nullable().meta({ description: 'The member’s phone in the gym’s record (the default number)' }) });
const MyConsent = Consent.extend({
  number: e164.nullable().meta({ description: 'The member’s own WhatsApp number (only to them)' }),
  phone: e164.nullable().meta({ description: 'The phone in the gym’s record, used when no WhatsApp number is given' }),
  gymName: z.string(),
});

module.exports = { gymParam, memberParam, myMemberParam, senderParam, feePaymentParam, sendsQuery, messagesQuery, ownerNumberBody, gymPatch, connectBody, estimateBody, sendBody, consentBody, OwnerWhatsapp, GymWhatsapp, Senders, Estimate, Send, Sends, Messages, ReceiptQueued, MemberConsent, MyConsent };
