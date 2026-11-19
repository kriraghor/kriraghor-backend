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
  // M11-FR-16: a link to the intro video (checked by hire/video.rules); empty or null removes it.
  introVideoUrl: z.string().max(500).nullable().optional().meta({ description: 'YouTube, Vimeo, Facebook, Google Drive, OneDrive (embed link), Dropbox, or an https .mp4/.webm/.m4v/.m3u8 link; never uploaded' }),
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

// ---------------- Round B1: insights, availability
const insightsQuery = z.object({ period: z.enum(['7w', 'qtr', 'yr']).default('7w') });
const rangeQuery = z.object({ from: dateTime.optional(), to: dateTime.optional() });
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const repeatRule = z.object({
  weekdays: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .max(7)
    .refine((d) => new Set(d).size === d.length, 'Each weekday once')
    .meta({ description: '0 = Sunday … 6 = Saturday (Dhaka calendar)' }),
  from: hhmm,
  to: z.union([hhmm, z.literal('24:00')]).meta({ description: 'HH:MM, or 24:00 for the end of the day' }),
  until: z.iso.date().optional().meta({ description: 'The last day the repeat applies (Dhaka); open without it' }),
  reason: text(1, 120).optional(),
});
const blocksBody = z.object({
  from: dateTime,
  to: dateTime,
  blocks: z.array(z.object({ start: dateTime, end: dateTime, reason: text(1, 120).optional() })).max(200),
  repeats: z.array(repeatRule).max(20).optional().meta({ description: 'When sent, the full set of weekly repeats (missing ones are removed)' }),
});

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
    acceptanceRate: nullable(z.number()).meta({ description: '% of requests accepted over hire.acceptance_window_days (FR-52)' }),
    medianReplyMinutes: nullable(z.number().int()),
    availableToday: z.boolean().meta({ description: 'Some time left today (Dhaka) that is neither blocked nor booked (FR-05)' }),
    avatarUrl: nullable(z.string()),
    shortlisted: z.boolean(),
    hasIntroVideo: z.boolean().meta({ description: 'The reviewed profile has an intro video (M11-FR-16)' }),
  })
  .meta({ id: 'HireCard' });
const IntroVideo = z
  .object({
    url: z.string().meta({ description: 'The link as given' }),
    provider: z.enum(['youtube', 'vimeo', 'facebook', 'google_drive', 'onedrive', 'dropbox', 'video_file', 'hls']),
    kind: z.enum(['iframe', 'file', 'hls']).meta({ description: 'iframe: embed playUrl; file: <video src=playUrl>; hls: an HLS playlist' }),
    playUrl: z.string(),
  })
  .meta({ id: 'HireIntroVideo', description: 'M11-FR-16: an intro video given as a link, never uploaded to Kriraghor' });
const ProfileList = z.object({ items: z.array(Card), total: z.number().int().optional(), counts: z.record(z.string(), z.number().int()).optional(), nextCursor: nullable(z.string()).optional() }).meta({ id: 'HireProfileList' });
const ProfilePage = Card.extend({
  bio: nullable(z.string()),
  introVideo: nullable(IntroVideo),
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
const Completeness = z
  .object({ score: z.number().int().min(0).max(100), steps: z.array(z.object({ key: z.string(), done: z.boolean() })) })
  .meta({ id: 'Completeness', description: 'Steps left to a complete profile; score = % of steps done' });
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
    introVideoUrl: nullable(z.string()),
    introVideo: nullable(IntroVideo).meta({ description: 'How the link in the working copy plays' }),
    worksWithU16: nullable(z.boolean()),
    live: nullable(z.object({ version: z.number().int() }).loose()),
    reviewReason: nullable(z.object({ code: z.string(), text: nullable(z.string()) })),
    rateCard: nullable(RateCard),
    stats: z.object({ jobsDone: z.number().int(), acceptanceRate: nullable(z.number()), medianReplyMinutes: nullable(z.number().int()), ratingAvg: nullable(z.number()), ratingCount: z.number().int() }),
    completeness: Completeness,
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
const Check = z.object({ key: z.enum(['credential', 'police_clearance', 'free', 'daily_limit', 'in_future', 'available']), ok: z.boolean() });
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
  owner: z.object({ id, displayName: nullable(z.string()), avatarUrl: nullable(z.string()) }),
  credential: nullable(z.object({ level: z.enum(LEVELS), issuer: nullable(z.string()), expiresOn: nullable(z.string()) })),
  baseArea: nullable(z.object({ id, nameEn: z.string(), nameBn: z.string() })),
  updatedAt: nullable(dateTime),
}).meta({ id: 'HireStaffProfile' });
const StaffProfileList = z.object({ items: z.array(StaffProfile) }).meta({ id: 'HireStaffProfileList' });
const StaffAction = z.object({ id, status: z.enum(PROFILE_STATUSES) });
const Span = z.object({ start: dateTime, end: dateTime });
const Insights = z
  .object({
    period: z.enum(['7w', 'qtr', 'yr']),
    asOf: dateTime,
    from: z.string().meta({ description: 'First Dhaka day of the period' }),
    buckets: z.array(z.object({ key: z.string(), from: z.string(), amount: poisha })).meta({ description: 'Earned (net) per Dhaka week or month, oldest first' }),
    earned: z.object({ total: poisha, previous: poisha, delta: nullable(z.number()).meta({ description: '% change against the same days one period earlier' }) }),
    releasingSoon: z.object({ net: poisha, count: z.number().int(), nextAt: nullable(dateTime) }),
    jobs: z.object({ done: z.number().int(), upcoming: z.number().int() }),
    acceptanceRate: nullable(z.number()),
    medianReplyMinutes: nullable(z.number().int()),
    rating: z.object({ avg: nullable(z.number()), count: z.number().int() }),
    whoHiresYou: z.array(z.object({ key: z.string(), label: z.string(), jobs: z.number().int() })),
  })
  .meta({ id: 'HireInsights' });
const Availability = z
  .object({
    from: dateTime,
    to: dateTime,
    horizonDays: z.number().int(),
    horizonEnd: dateTime,
    blocks: z.array(Span.extend({ id, reason: nullable(z.string()) })),
    repeats: z.array(z.object({ id, weekdays: z.array(z.number().int()), from: z.string(), to: z.string(), until: z.string().optional(), validFrom: dateTime, reason: nullable(z.string()) })),
    spans: z.array(Span.extend({ reason: nullable(z.string()), blockId: id, repeat: z.boolean() })).meta({ description: 'Blocked time in the range, repeats expanded' }),
    booked: z.array(Span.extend({ jobId: id, code: z.string(), status: z.string(), locked: z.literal(true) })),
  })
  .meta({ id: 'HireAvailability' });
const PublicAvailability = z.object({ from: dateTime, to: dateTime, busy: z.array(Span) }).meta({ id: 'HireBusy', description: 'Busy spans only: no reasons, no jobs' });

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
  Card,
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
  insightsQuery,
  rangeQuery,
  blocksBody,
  Insights,
  Availability,
  PublicAvailability,
  Completeness,
};
