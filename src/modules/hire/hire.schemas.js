'use strict';

/**
 * M11 request and response schemas (zod → validation and OpenAPI). Money in poisha; times ISO.
 */
const { z } = require('zod');

const id = z.uuid();
const poisha = z.number().int().nonnegative();
const dateTime = z.iso.datetime({ offset: true });
const text = (min, max) => z.string().trim().min(min).max(max);
const UNITS = ['hourly', 'match'];
const FORMATS = ['T10', 'T20', 'OD', 'TAPE'];
const LEVELS = ['amateur', 'semi_pro', 'pro', 'national'];
const REQUEST_STATUSES = ['pending', 'accepted_unpaid', 'confirmed', 'completed', 'declined', 'expired', 'withdrawn', 'lapsed', 'cancelled'];
const DECLINE_REASONS = ['not_available', 'outside_area', 'fee_too_low', 'credential_not_covering', 'other'];

// ---------------- requests
const idParam = z.object({ id });
const slugParam = z.object({ slug: z.string().min(1).max(96) });
const codeParam = z.object({ code: z.string().regex(/^HR-\d{2}-\d{6,}$/) });
const profileParam = z.object({ profileId: id });
const listQuery = z.object({
  category: z.string().max(40).optional(),
  role: z.string().max(40).optional(),
  exp: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter((x) => LEVELS.includes(x)) : undefined)),
  unit: z.enum(UNITS).optional(),
  sport: z.string().max(40).optional(),
  areaId: id.optional(),
  q: z.string().trim().min(1).max(60).optional(),
  sort: z.enum(['rating', 'rate', 'jobs', 'experience']).default('rating'),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const engagement = z.object({
  start: dateTime,
  format: z.enum(FORMATS).optional(),
  hours: z.number().min(1).max(12).multipleOf(0.5).optional().meta({ description: 'For hourly sessions' }),
  night: z.boolean().optional().meta({ description: 'Floodlit work; a start at or after 18:00 Dhaka counts as night anyway' }),
  u16: z.boolean().optional(),
  venueGroundId: id.optional(),
  venueText: text(3, 200),
  venueAreaId: id,
});
const quoteBody = z
  .object({ unit: z.enum(UNITS), engagements: z.array(engagement).min(1).max(30) })
  .refine((b) => b.unit !== 'hourly' || b.engagements.every((e) => e.hours), { message: 'Each session needs its hours', path: ['engagements'] });
const requestBody = z
  .object({ profileId: id, unit: z.enum(UNITS), engagements: z.array(engagement).min(1).max(30), note: text(2, 500).optional() })
  .refine((b) => b.unit !== 'hourly' || b.engagements.every((e) => e.hours), { message: 'Each session needs its hours', path: ['engagements'] });
const statusQuery = z.object({ status: z.enum(REQUEST_STATUSES).optional() });
const declineBody = z.object({ reason: z.enum(DECLINE_REASONS), text: text(2, 300).optional() });
const messageBody = z.object({ body: text(1, 1000) });
const disputeBody = z.object({ statement: text(10, 2000) });
const completeBody = z.object({ note: text(2, 1000).optional(), result: text(2, 120).optional() });
const withdrawBody = z.object({ reason: z.enum(['not_available', 'injury', 'emergency', 'other']) });
const jobsQuery = z.object({ from: dateTime.optional(), to: dateTime.optional() });
const profileBody = z.object({
  roleKey: z.string().min(3).max(40),
  headline: text(5, 80),
  specialisation: z.string().max(40).optional(),
  sportKeys: z.array(z.string().max(40)).max(6).default([]),
  experienceLevel: z.enum(LEVELS),
  years: z.number().int().min(0).max(60).default(0),
  baseAreaId: id,
  bio: text(10, 2000).optional(),
  worksWithU16: z.boolean().default(false),
});
const profilePatch = profileBody.omit({ roleKey: true }).partial();
const rateCardBody = z.object({
  items: z.array(z.object({ unit: z.enum(UNITS), format: z.enum(FORMATS).optional(), rate: poisha })).min(1).max(8),
  nightPct: z.number().min(0).max(100).default(0),
  shortNoticePct: z.number().min(0).max(100).default(0),
  shortNoticeHours: z.number().int().min(0).max(336).optional(),
  travel: z.object({ north: poisha, south: poisha, outside: poisha }),
  maxJobsPerDay: z.number().int().min(1).max(12),
});
const adminListQuery = z.object({ code: z.string().trim().max(24).optional(), status: z.enum(REQUEST_STATUSES).optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
const adminProfilesQuery = z.object({ status: z.enum(['pending_review', 'live', 'paused', 'suspended', 'rejected', 'changes_requested']).optional(), q: z.string().trim().max(60).optional() });
const reasonBody = z.object({ reason: text(5, 300) });

// ---------------- responses (the views of hire.common, directory, profiles and hire.admin)
const nullable = (t) => t.nullable();
const ZONES = ['home', 'north', 'south', 'outside'];
const JOB_STATUSES = ['reserved', 'scheduled', 'checked_in', 'live', 'completed_marked', 'released', 'cancelled', 'withdrawn', 'void', 'disputed', 'refunded'];
const PROFILE_STATUSES = ['draft', 'pending_review', 'changes_requested', 'live', 'paused', 'rejected', 'withdrawn', 'suspended', 'removed'];
const AreaRef = z.object({ id, key: z.string(), nameEn: z.string(), nameBn: z.string(), isDhakaMetro: z.boolean(), dhakaZone: nullable(z.string()) });
const RoleRef = z.object({ key: z.string(), nameEn: z.string(), nameBn: z.string(), categoryKey: z.string() });
const Tier = z.object({ level: z.enum(LEVELS), labelEn: z.string(), labelBn: z.string() }).loose();
const TaxRole = RoleRef.extend({
  id,
  forRole: z.enum(['player', 'pro']),
  sportKeys: z.array(z.string()),
  allowedUnits: z.array(z.enum(UNITS)),
  formatPriced: z.boolean(),
  formats: z.array(z.enum(FORMATS)),
  baseHourlyPoisha: poisha,
  specialisations: z.array(z.string()),
  credentialTiers: z.array(Tier),
  levels: z.array(z.enum(LEVELS)),
  requiresCredential: z.boolean(),
  policeCheckForU16: z.boolean(),
  isOfficial: z.boolean(),
});
const Taxonomy = z
  .object({ items: z.array(z.object({ id, key: z.string(), code: z.string(), forRole: z.enum(['player', 'pro']), nameEn: z.string(), nameBn: z.string(), tint: nullable(z.string()), roles: z.array(TaxRole) })) })
  .meta({ id: 'HireTaxonomy' });
const RateItem = z.object({ unit: z.enum(UNITS), format: nullable(z.enum(FORMATS)), rate: poisha });
const RateCard = z
  .object({ version: z.number().int(), nightPct: z.number(), shortNoticePct: z.number(), shortNoticeHours: z.number().int(), travel: z.object({ north: poisha, south: poisha, outside: poisha }), maxJobsPerDay: z.number().int(), items: z.array(RateItem) })
  .meta({ id: 'HireRateCard' });
const Card = z
  .object({
    id,
    slug: z.string(),
    name: z.string(),
    headline: z.string(),
    specialisation: nullable(z.string()),
    experienceLevel: z.enum(LEVELS),
    years: z.number().int(),
    role: RoleRef,
    area: nullable(AreaRef),
    rateFrom: nullable(poisha),
    rateUnit: nullable(z.enum(UNITS)),
    units: z.array(z.enum(UNITS)),
    ratingAvg: nullable(z.number()),
    ratingCount: z.number().int(),
    jobsDone: z.number().int(),
    shortlisted: z.boolean(),
  })
  .meta({ id: 'HireCard' });
const ProfileList = z.object({ items: z.array(Card), total: z.number().int().optional(), counts: z.record(z.string(), z.number().int()).optional(), nextCursor: nullable(z.string()).optional() }).meta({ id: 'HireProfileList' });
const ProfilePage = Card.extend({
  bio: nullable(z.string()),
  sportKeys: z.array(z.string()),
  worksWithU16: z.boolean(),
  taking: z.boolean(),
  role: RoleRef.extend({ allowedUnits: z.array(z.enum(UNITS)), formatPriced: z.boolean(), formats: z.array(z.enum(FORMATS)) }),
  credential: nullable(z.object({ level: z.enum(LEVELS), labelEn: nullable(z.string()), labelBn: nullable(z.string()), verified: z.boolean() })),
  rateCard: nullable(RateCard),
  busy: z.array(z.object({ start: dateTime, end: dateTime })),
}).meta({ id: 'HireProfilePage' });
const QuoteLine = z.object({ key: z.string().meta({ description: 'base, night, short_notice, travel_north, travel_south or travel_outside' }), amount: poisha });
const QuotedEngagement = z.object({
  start: dateTime,
  end: dateTime,
  hours: z.number(),
  format: nullable(z.enum(FORMATS)),
  night: z.boolean(),
  u16: z.boolean(),
  zone: z.enum(ZONES),
  venueAreaId: id,
  venueText: z.string(),
  venueGroundId: nullable(id),
  lines: z.array(QuoteLine),
  total: poisha,
});
const Quote = z.object({ lines: z.array(QuotedEngagement), total: poisha }).meta({ id: 'HireQuote' });
const OwnerProfile = z
  .object({
    id,
    slug: z.string(),
    status: z.enum(PROFILE_STATUSES),
    editStatus: nullable(z.string()),
    liveVersion: nullable(z.number().int()),
    role: nullable(TaxRole.omit({ id: true, forRole: true, sportKeys: true, baseHourlyPoisha: true, specialisations: true, levels: true, isOfficial: true })),
    headline: nullable(z.string()),
    specialisation: nullable(z.string()),
    sportKeys: nullable(z.array(z.string())),
    experienceLevel: nullable(z.enum(LEVELS)),
    years: nullable(z.number().int()),
    baseAreaId: nullable(id),
    bio: nullable(z.string()),
    worksWithU16: nullable(z.boolean()),
    live: nullable(z.object({ version: z.number().int() }).loose()),
    reviewReason: nullable(z.object({ code: z.string(), text: nullable(z.string()) })),
    rateCard: nullable(RateCard),
    limits: z.record(z.string(), z.object({ min: poisha, max: poisha }).loose()).meta({ description: 'unit:format → the allowed rate range (Q74)' }),
  })
  .meta({ id: 'HireOwnerProfile' });
const JobCan = z
  .object({ confirm: z.boolean(), cancel: z.boolean(), noShow: z.boolean(), problem: z.boolean(), checkIn: z.boolean(), start: z.boolean(), complete: z.boolean(), withdraw: z.boolean() })
  .partial()
  .meta({ id: 'HireJobCan', description: 'The hirer sees confirm, cancel, noShow and problem; the pro checkIn, start, complete and withdraw' });
const Job = z
  .object({
    id,
    code: z.string(),
    status: z.enum(JOB_STATUSES),
    start: dateTime,
    end: dateTime,
    hours: z.number(),
    format: nullable(z.enum(FORMATS)),
    night: z.boolean(),
    u16: z.boolean(),
    venue: z.object({ groundId: nullable(id), text: z.string(), areaId: id, zone: z.enum(ZONES) }),
    money: z.object({ quote: poisha, fee: poisha, net: poisha, refunded: poisha, released: poisha, cancelFee: nullable(poisha) }),
    checkedInAt: nullable(dateTime),
    late: nullable(z.boolean()),
    startedAt: nullable(dateTime),
    completedAt: nullable(dateTime),
    workNote: nullable(z.string()),
    result: nullable(z.string()),
    releaseAt: nullable(dateTime),
    releasedAt: nullable(dateTime),
    releasedBy: nullable(z.string()),
    cancelledAt: nullable(dateTime),
    cancelledBy: nullable(z.string()),
    cancelReason: nullable(z.string()),
    disputeId: nullable(id),
    requestCode: z.string().optional(),
    can: JobCan.optional(),
  })
  .meta({ id: 'HireJob' });
const JobList = z.object({ items: z.array(Job) }).meta({ id: 'HireJobList' });
const Check = z.object({ key: z.enum(['credential', 'police_clearance', 'free', 'daily_limit', 'in_future']), ok: z.boolean() });
const Request = z
  .object({
    id,
    code: z.string(),
    status: z.enum(REQUEST_STATUSES),
    role: z.enum(['hirer', 'pro']).meta({ description: 'The viewer’s side' }),
    unit: z.enum(UNITS),
    note: nullable(z.string()),
    profile: z.object({ id, slug: z.string(), headline: z.string(), role: RoleRef.omit({ categoryKey: true }) }),
    other: z.object({ name: nullable(z.string()), phone: nullable(z.string()).meta({ description: 'Shows once the request is paid (v3)' }) }),
    money: z.object({ total: poisha, fee: nullable(poisha), net: nullable(poisha) }),
    quote: z.object({}).loose(),
    replyBy: nullable(dateTime),
    payBy: nullable(dateTime),
    paymentId: nullable(id),
    declineReason: nullable(z.string()),
    createdAt: nullable(dateTime),
    confirmedAt: nullable(dateTime),
    jobs: z.array(Job),
  })
  .meta({ id: 'HireRequest' });
const RequestResult = z.object({ request: Request, payment: nullable(z.object({ id, payUrl: z.string() })), checks: nullable(z.array(Check)).optional() }).meta({ id: 'HireRequestResult' });
const RequestList = z.object({ items: z.array(RequestResult) }).meta({ id: 'HireRequestList' });
const CancelPlan = z
  .object({ tier: z.enum(['free', 'mid', 'high']), pct: z.number(), cancelFee: poisha, refund: poisha, proGets: poisha, platformFee: poisha })
  .loose()
  .meta({ id: 'HireCancelPlan' });
const CancelResult = z.object({ job: Job, plan: CancelPlan }).meta({ id: 'HireCancelResult' });
const Message = z.object({ id, mine: z.boolean(), author: z.string().optional(), body: z.string(), at: dateTime }).meta({ id: 'HireMessage' });
const Messages = z.object({ items: z.array(Message), contactAllowed: z.boolean() }).meta({ id: 'HireMessages' });
const StaffRequest = z
  .object({
    id,
    code: z.string(),
    status: z.enum(REQUEST_STATUSES),
    hirerId: id,
    proUserId: id,
    profile: z.object({ id, slug: z.string(), headline: z.string() }),
    unit: z.enum(UNITS),
    money: z.object({ total: poisha, fee: poisha, net: poisha, feeBps: z.number().int() }),
    replyBy: nullable(dateTime),
    payBy: nullable(dateTime),
    paymentId: nullable(id),
    createdAt: nullable(dateTime),
    confirmedAt: nullable(dateTime),
    jobs: z.array(Job.omit({ requestCode: true, can: true }).extend({ escrow: nullable(z.object({}).loose()) })),
  })
  .meta({ id: 'HireStaffRequest' });
const StaffRequestList = z
  .object({ items: z.array(z.object({ id, code: z.string(), status: z.enum(REQUEST_STATUSES), total: poisha, jobs: z.number().int(), createdAt: nullable(dateTime) })), nextCursor: nullable(z.string()) })
  .meta({ id: 'HireStaffRequestList' });
const StaffProfile = OwnerProfile.extend({
  owner: z.object({ id, displayName: nullable(z.string()) }),
  credential: nullable(z.object({ level: z.enum(LEVELS), issuer: nullable(z.string()), expiresOn: nullable(z.string()) })),
  baseArea: nullable(z.object({ id, nameEn: z.string(), nameBn: z.string() })),
  updatedAt: nullable(dateTime),
}).meta({ id: 'HireStaffProfile' });
const StaffProfileList = z.object({ items: z.array(StaffProfile) }).meta({ id: 'HireStaffProfileList' });
const StaffAction = z.object({ id, status: z.enum(PROFILE_STATUSES) });

module.exports = {
  UNITS,
  FORMATS,
  DECLINE_REASONS,
  idParam,
  slugParam,
  codeParam,
  profileParam,
  listQuery,
  quoteBody,
  requestBody,
  statusQuery,
  declineBody,
  messageBody,
  disputeBody,
  completeBody,
  withdrawBody,
  jobsQuery,
  profileBody,
  profilePatch,
  rateCardBody,
  adminListQuery,
  adminProfilesQuery,
  reasonBody,
  Taxonomy,
  ProfileList,
  ProfilePage,
  Quote,
  OwnerProfile,
  RequestResult,
  RequestList,
  Job,
  JobList,
  CancelPlan,
  CancelResult,
  Messages,
  Message,
  StaffRequest,
  StaffRequestList,
  StaffProfile,
  StaffProfileList,
  StaffAction,
};
