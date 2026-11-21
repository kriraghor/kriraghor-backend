'use strict';

/**
 * M24 §25 WhatsApp request and response schemas (zod → validation and OpenAPI). Phone numbers are accepted
 * in any Bangladesh form (01…, 880…, +880…) and normalised by the service; a member's number is never
 * returned to staff, only its last 4 digits.
 */
const { z } = require('zod');

const id = z.uuid();
const dateTime = z.iso.datetime({ offset: true });
const phoneIn = z.string().trim().min(10).max(20);
const e164 = z.string().regex(/^\+8801[3-9]\d{8}$/);

// ---------------- params
const gymParam = z.object({ gymId: id });
const memberParam = z.object({ gymId: id, memberId: id });
const myMemberParam = z.object({ memberId: id });

// ---------------- bodies
/** PUT /manage/whatsapp/number: the owner's number for every branch (null removes it). */
const ownerNumberBody = z.object({ number: phoneIn.nullable() });
/** PATCH /manage/gyms/:gymId/whatsapp: the branch's own number (null: use the owner's) and the gym page button. */
const gymPatch = z.object({ number: phoneIn.nullable().optional(), showOnPage: z.boolean().optional() }).refine((b) => b.number !== undefined || b.showOnPage !== undefined, { message: 'Nothing to change' });
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
});
const OwnerWhatsapp = z.object({
  apiEnabled: z.boolean().meta({ description: 'gym_whatsapp.api_enabled: sending from the panel (off until Meta approves)' }),
  number: e164.nullable(),
  gyms: z.array(GymNumber),
});
const GymWhatsapp = GymNumber.extend({ ownerNumber: e164.nullable(), apiEnabled: z.boolean() });
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

module.exports = { gymParam, memberParam, myMemberParam, ownerNumberBody, gymPatch, consentBody, OwnerWhatsapp, GymWhatsapp, MemberConsent, MyConsent };
