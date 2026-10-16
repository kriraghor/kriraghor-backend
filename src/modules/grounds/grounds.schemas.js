'use strict';

/**
 * M09 request and response schemas (zod → validation and OpenAPI). Money in poisha; percentages as
 * numbers with up to two decimals; times are Asia/Dhaka wall-clock "HH:MM"; weekdays 0 = Sunday.
 */
const { z } = require('zod');

const dateTime = z.iso.datetime({ offset: true });
const id = z.uuid();
const idParam = z.object({ id });
const photoParams = z.object({ id, photoId: id });
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'HH:MM');
const pct = z.number().min(0).max(100).multipleOf(0.01);
const csv = (item) => z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(item).max(20));
const bool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

// ---------------- owner: grounds
const groundFields = {
  name: z.string().trim().min(3).max(80),
  areaId: id,
  addressLine: z.string().trim().min(5).max(200),
  lat: z.number().min(20).max(27),
  lng: z.number().min(88).max(93),
  isIndoor: z.boolean().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  rulesText: z.string().trim().max(1000).nullable().optional(),
  facilityIds: z.array(id).max(30).optional(),
  bookingCutoffMin: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(60)]).optional(),
  requiresOfficial: z.array(z.object({ sportId: id, note: z.string().trim().max(120).optional() })).max(10).optional(),
};
const createGround = z.object({ ...groundFields, basePricePoisha: z.number().int().positive().meta({ description: 'Base price per hour (seeds the first pricing version)' }) });
const updateGround = z.object(groundFields).partial().refine((b) => Object.keys(b).length > 0, 'Nothing to change');

const hoursRow = z.object({ dow: z.number().int().min(0).max(6), isClosed: z.boolean(), openTime: hhmm.nullable().optional(), closeTime: hhmm.nullable().optional() });
const hoursBody = z.object({ hours: z.array(hoursRow).length(7) });
const courtFields = {
  name: z.string().trim().min(1).max(40),
  sportIds: z.array(id).min(1).max(8),
  surfaceId: id,
  sizeText: z.string().trim().max(40).nullable().optional(),
  capacityText: z.string().trim().max(40).nullable().optional(),
  combinableGroup: z.string().regex(/^[a-z0-9_]{2,32}$/).nullable().optional(),
  sort: z.number().int().min(0).max(100).optional(),
};
const createCourt = z.object({ ...courtFields, hours: z.array(hoursRow).length(7).optional() });
const updateCourt = z.object(courtFields).partial().refine((b) => Object.keys(b).length > 0, 'Nothing to change');

const photoOrder = z.object({ ids: z.array(id).min(1).max(40) });

// ---------------- owner: pricing
const ruleFields = {
  basePricePoisha: z.number().int().positive(),
  courtBaseOverrides: z.record(z.string(), z.number().int().positive()),
  peakFromHour: z.number().int(),
  peakPct: pct,
  weekendPct: pct,
  earlyToHour: z.number().int(),
  earlyPct: pct,
  advancePct: pct,
  seriesDiscountPct: pct,
  minBookingMin: z.number().int(),
  fullRefundHours: z.number().int(),
  halfRefundHours: z.number().int(),
  checkinGraceMin: z.number().int(),
};
const pricingDraft = z.object(ruleFields).partial().refine((b) => Object.keys(b).length > 0, 'Nothing to change');
const publishBody = z.object({ applyToAll: z.boolean().default(false) });
const slot = {
  courtIds: z.array(id).min(1).max(4).meta({ description: 'One court, or the courts of one combinable group (priced as the sum)' }),
  start: dateTime,
  minutes: z.number().int().min(30).max(360),
};
const ownerQuote = z.object({ ...slot, draft: z.object(ruleFields).partial().optional().meta({ description: 'Unsaved changes to price with' }) });
const publicQuote = z.object(slot);
const heatmapQuery = z.object({ days: z.coerce.number().int().min(1).max(14).default(7), draft: bool.default(false), courtId: id.optional() });

// ---------------- staff
const reasonBody = z.object({ reason: z.string().trim().min(5).max(300) });
const staffListQuery = z.object({ status: z.enum(['draft', 'pending_review', 'changes_requested', 'live', 'paused', 'rejected', 'withdrawn', 'suspended', 'removed']).optional(), q: z.string().trim().min(1).max(60).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

// ---------------- public
const listQuery = z.object({
  sport: z.string().regex(/^[a-z_]{2,40}$/).optional(),
  areaId: id.optional(),
  lat: z.coerce.number().min(20).max(27).optional(),
  lng: z.coerce.number().min(88).max(93).optional(),
  radiusKm: z.coerce.number().min(1).max(50).optional(),
  priceMin: z.coerce.number().int().min(0).optional(),
  priceMax: z.coerce.number().int().min(0).optional(),
  surface: csv(z.string().regex(/^[a-z_]{2,40}$/)).optional(),
  facilities: csv(z.string().regex(/^[a-z_]{2,40}$/)).optional(),
  indoor: bool.optional(),
  sort: z.enum(['cheapest', 'nearest', 'newest']).optional(),
  cursor: z.string().regex(/^\d{1,6}$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const slugParam = z.object({ slug: z.string().regex(/^[a-z0-9-]{1,96}$/) });

// ---------------- responses
const Named = z.object({ id, key: z.string(), nameEn: z.string(), nameBn: z.string() });
const Hours = z.object({ dow: z.number().int(), isClosed: z.boolean(), openTime: z.string().nullable(), closeTime: z.string().nullable() });
const Photo = z.object({ id, url: z.string(), sort: z.number().int() }).meta({ id: 'GroundPhoto' });
const Court = z
  .object({
    id,
    name: z.string(),
    sportIds: z.array(id),
    surfaceId: id,
    sizeText: z.string().nullable(),
    capacityText: z.string().nullable(),
    combinableGroup: z.string().nullable(),
    sort: z.number().int(),
    status: z.enum(['pending', 'active', 'retired']),
    hours: z.array(Hours),
  })
  .meta({ id: 'GroundCourt' });
const STATUSES = ['draft', 'pending_review', 'changes_requested', 'live', 'paused', 'rejected', 'withdrawn', 'suspended', 'removed'];
const OwnerGround = z
  .object({
    id,
    slug: z.string(),
    name: z.string(),
    areaId: id,
    addressLine: z.string(),
    lat: z.number(),
    lng: z.number(),
    isIndoor: z.boolean(),
    description: z.string().nullable(),
    rulesText: z.string().nullable(),
    facilityIds: z.array(id),
    bookingCutoffMin: z.number().int(),
    requiresOfficial: z.array(z.object({ sportId: id, note: z.string().optional() })),
    status: z.enum(STATUSES),
    editStatus: z.enum(['draft', 'pending_review', 'changes_requested', 'rejected']).nullable(),
    liveVersion: z.number().int(),
    reviewReason: z.object({ code: z.string(), text: z.string().nullable() }).nullable(),
    firstLiveAt: dateTime.nullable(),
    photos: z.array(Photo),
    courts: z.array(Court),
    pricing: z.object({ publishedVersion: z.number().int().nullable(), basePricePoisha: z.number().int().nullable(), hasDraft: z.boolean() }),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .meta({ id: 'OwnerGround' });
const OwnerGroundList = z
  .object({
    items: z.array(
      z.object({
        id,
        slug: z.string(),
        name: z.string(),
        areaId: id,
        status: z.enum(STATUSES),
        editStatus: z.string().nullable(),
        coverUrl: z.string().nullable(),
        courtsCount: z.number().int(),
        basePricePoisha: z.number().int().nullable(),
        reviewReason: z.object({ code: z.string(), text: z.string().nullable() }).nullable(),
        updatedAt: dateTime,
      })
    ),
  })
  .meta({ id: 'OwnerGroundList' });

const Rules = z
  .object({
    id,
    version: z.number().int(),
    status: z.enum(['draft', 'published', 'superseded', 'discarded']),
    ...Object.fromEntries(Object.entries(ruleFields).map(([k, v]) => [k, v])),
    effectiveFrom: dateTime.nullable(),
    effectiveTo: dateTime.nullable(),
    summary: z.string().nullable(),
    changedKeys: z.array(z.string()),
    updatedAt: dateTime,
  })
  .meta({ id: 'PricingRules' });
const Limits = z.object({
  baseMin: z.number(),
  baseMax: z.number(),
  peakMax: z.number(),
  weekendMax: z.number(),
  earlyMax: z.number(),
  advanceMin: z.number(),
  advanceMax: z.number(),
  feePct: z.number(),
  seriesMax: z.number(),
  minLengthOptions: z.array(z.number().int()),
});
const Policy = z.object({ allowFullPayment: z.boolean(), advanceRefundable: z.boolean(), refundAboveAdvanceOnCancel: z.boolean(), feePct: z.number() });
const PricingView = z
  .object({ groundId: id, published: Rules.nullable(), draft: Rules.nullable(), upcomingBookings: z.number().int(), baseLocked: z.boolean(), limits: Limits, policy: Policy })
  .meta({ id: 'GroundPricing' });
const PublishResult = z.object({ published: Rules, alsoPublished: z.array(z.object({ groundId: id, version: z.number().int() })) }).meta({ id: 'PricingPublished' });
const History = z
  .object({
    items: z.array(
      z.object({
        version: z.number().int(),
        status: z.string(),
        summary: z.string().nullable(),
        changedKeys: z.array(z.string()),
        effectiveFrom: dateTime.nullable(),
        effectiveTo: dateTime.nullable(),
        publishedBy: z.object({ id, name: z.string().nullable() }).nullable(),
      })
    ),
  })
  .meta({ id: 'PricingHistory' });
const Quote = z
  .object({
    price: z.number().int(),
    advance: z.number().int(),
    balance: z.number().int(),
    rateAtStart: z.number().int(),
    fee: z.number().int().meta({ description: 'Kriraghor fee on the full value (fees.ground_booking_pct), taken at check-in' }),
    options: z.array(z.object({ kind: z.enum(['advance', 'full']), payNow: z.number().int(), atVenue: z.number().int(), ownerGetsOnline: z.number().int() })),
    applied: z.object({ peak: z.boolean(), early: z.boolean(), weekend: z.boolean() }),
    rulesVersion: z.number().int().nullable(),
    minBookingMin: z.number().int().optional(),
  })
  .meta({ id: 'GroundQuote' });
const HeatRow = z.object({ date: z.string(), dow: z.number().int(), cells: z.array(z.object({ hour: z.number().int(), rate: z.number().int(), tone: z.enum(['low', 'base', 'high', 'peak']) })) });
const Heatmap = z.object({ basePricePoisha: z.number().int(), rows: z.array(HeatRow) }).meta({ id: 'PricingHeatmap' });

const Card = z
  .object({
    id,
    slug: z.string(),
    name: z.string(),
    area: Named.extend({ district: Named.nullable(), lat: z.number(), lng: z.number() }).nullable(),
    coverUrl: z.string().nullable(),
    sports: z.array(Named),
    surfaces: z.array(Named),
    isIndoor: z.boolean(),
    courtsCount: z.number().int(),
    priceFromPoisha: z.number().int(),
    distanceM: z.number().int().nullable(),
    ratingAvg: z.number().nullable(),
    ratingCount: z.number().int(),
  })
  .meta({ id: 'GroundCard' });
const Facet = Named.extend({ count: z.number().int() });
const GroundList = z
  .object({
    items: z.array(Card),
    total: z.number().int(),
    nextCursor: z.string().nullable(),
    facets: z.object({ sports: z.array(Facet), surfaces: z.array(Facet), facilities: z.array(Facet), indoor: z.object({ indoor: z.number().int(), outdoor: z.number().int() }) }),
    sort: z.string(),
  })
  .meta({ id: 'GroundList' });
const GroundDetail = z
  .object({
    id,
    slug: z.string(),
    name: z.string(),
    area: Card.shape.area,
    addressLine: z.string(),
    lat: z.number(),
    lng: z.number(),
    isIndoor: z.boolean(),
    description: z.string().nullable(),
    rulesText: z.string().nullable(),
    bookingCutoffMin: z.number().int(),
    requiresOfficial: z.array(z.object({ sportId: id, note: z.string().optional() })),
    facilities: z.array(Named),
    photos: z.array(z.object({ id, url: z.string() })),
    courts: z.array(
      z.object({ id, name: z.string(), sports: z.array(Named), surface: Named.nullable(), sizeText: z.string().nullable(), capacityText: z.string().nullable(), combinableGroup: z.string().nullable(), hours: z.array(Hours) })
    ),
    pricing: z.object({
      version: z.number().int(),
      basePricePoisha: z.number().int(),
      fromPoisha: z.number().int(),
      toPoisha: z.number().int(),
      minBookingMin: z.number().int(),
      advancePct: z.number(),
      peakFromHour: z.number().int(),
      peakPct: z.number(),
      weekendPct: z.number(),
      earlyToHour: z.number().int(),
      earlyPct: z.number(),
      week: z.array(HeatRow),
    }),
    payment: z.object({
      allowFullPayment: z.boolean(),
      advanceRefundable: z.boolean(),
      refundAboveAdvanceOnCancel: z.boolean(),
      fullRefundHours: z.number().int().nullable(),
      halfRefundHours: z.number().int().nullable(),
    }),
    owner: z.object({ displayName: z.string().nullable() }),
    ratingAvg: z.number().nullable(),
    ratingCount: z.number().int(),
    bookingOpen: z.boolean(),
    version: z.number().int(),
  })
  .meta({ id: 'GroundDetail' });
const StaffResult = z.object({ id, status: z.enum(STATUSES) });
const StaffList = z
  .object({
    items: z.array(
      z.object({ id, slug: z.string(), name: z.string(), areaId: id, status: z.enum(STATUSES), editStatus: z.string().nullable(), liveVersion: z.number().int(), owner: z.object({ id, displayName: z.string().nullable() }), coverUrl: z.string().nullable(), updatedAt: dateTime })
    ),
  })
  .meta({ id: 'StaffGroundList' });
const StaffGround = OwnerGround.extend({
  owner: z.object({ id, displayName: z.string().nullable() }),
  publicVersion: z.object({ version: z.number().int(), name: z.string(), courts: z.number().int(), photos: z.number().int() }).nullable(),
  rules: Rules.nullable(),
}).meta({ id: 'StaffGround' });

module.exports = {
  idParam,
  photoParams,
  createGround,
  updateGround,
  createCourt,
  updateCourt,
  hoursBody,
  photoOrder,
  pricingDraft,
  publishBody,
  ownerQuote,
  publicQuote,
  heatmapQuery,
  reasonBody,
  staffListQuery,
  listQuery,
  slugParam,
  OwnerGround,
  OwnerGroundList,
  Photo,
  PricingView,
  Rules,
  PublishResult,
  History,
  Quote,
  Heatmap,
  GroundList,
  GroundDetail,
  StaffResult,
  StaffList,
  StaffGround,
};
