'use strict';

/**
 * M20 request and response schemas (zod → validation and OpenAPI). Money in poisha; dates are Dhaka
 * calendar dates (YYYY-MM-DD); times ISO.
 */
const { z } = require('zod');
const hireSchemas = require('../hire').schemas;
const { staffHidden } = require('../business-members').schemas;

const id = z.uuid();
const poisha = z.number().int().nonnegative();
const date = z.iso.date();
const dateTime = z.iso.datetime({ offset: true });
const nullable = (t) => t.nullable();
const text = (min, max) => z.string().trim().min(min).max(max);
// M24 §7.1 (G2): 6 months, 12 months and custom days; channel desk (the gym's own books), online or both.
const SOLD_KINDS = ['month', 'quarter', 'half_year', 'year', 'custom'];
// Passes and history keep `day`: day passes sold before 2 Nov 2026 stay readable; none can be created.
const KINDS = ['day', ...SOLD_KINDS];
const CHANNELS = ['desk', 'online', 'both'];
const GYM_STATUSES = ['draft', 'pending_review', 'changes_requested', 'live', 'paused', 'rejected', 'withdrawn', 'suspended', 'removed'];
const PASS_STATUSES = ['pending_payment', 'active', 'redeemed', 'expired', 'cancelled', 'refunded', 'void'];
const SUB_STATUSES = ['pending_payment', 'active', 'cancelled', 'ended', 'lapsed', 'void'];
const PERIOD_STATUSES = ['pending_payment', 'paid', 'released', 'refunded', 'disputed', 'void'];
const time = z.string().regex(/^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/, 'HH:MM');

// ---------------- requests
const idParam = z.object({ id });
const slugParam = z.object({ slug: z.string().min(1).max(140) });
const codeParam = z.object({ code: z.string().trim().min(6).max(36) });
const idOrCodeParam = z.object({ id: z.string().trim().min(6).max(36).meta({ description: 'The id or the code (TS-26-000123)' }) });
const photoParams = z.object({ id, photoId: id });
const listQuery = z
  .object({
    areaId: id.optional(),
    facility: id.optional(),
    q: z.string().trim().min(2).max(60).optional(),
    // M24 prompt 3 (§4.1): the viewer's position (never stored), a radius, the monthly price cap and the nearest sort.
    lat: z.coerce.number().min(20).max(27).optional().meta({ description: 'The viewer’s position (with lng); used for this answer only' }),
    lng: z.coerce.number().min(88).max(93).optional(),
    radiusKm: z.coerce.number().min(1).max(50).optional().meta({ description: 'Only gyms within this distance (needs lat and lng)' }),
    priceMax: z.coerce.number().int().min(0).optional().meta({ description: 'The monthly package costs at most this (poisha); gyms without a monthly package are left out' }),
    sort: z.enum(['price', 'rating', 'newest', 'nearest']).optional().meta({ description: 'Default nearest with a position, else price (the monthly package)' }),
    cursor: z.string().regex(/^\d+$/).optional(),
    limit: z.coerce.number().int().min(1).max(48).default(24),
  })
  .refine((q) => (q.lat === undefined) === (q.lng === undefined), { message: 'Send lat and lng together', path: ['lng'] })
  .refine((q) => q.lat !== undefined || (q.radiusKm === undefined && q.sort !== 'nearest'), { message: 'The radius and the nearest sort need lat and lng', path: ['lat'] });
const trainersQuery = z.object({ areaId: id.optional(), sort: z.enum(['rating', 'rate', 'jobs', 'experience']).default('rating'), cursor: z.string().regex(/^\d+$/).optional() });
const gymFields = {
  name: text(3, 120),
  areaId: id,
  addressLine: text(5, 300),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  about: text(10, 3000).nullable().optional(),
  facilityIds: z.array(id).max(30).optional(),
};
const createGym = z.object(gymFields);
const updateGym = z
  .object(gymFields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
const hoursBody = z.object({
  hours: z.array(z.object({ dow: z.number().int().min(0).max(6), openTime: time, closeTime: time, womenOnly: z.boolean().default(false) })).max(28).meta({ description: 'Windows per weekday (0 = Sunday); a day without windows is closed' }),
});
// M24-FR-24: up to 5 kinds plus gym_manage.max_custom_packages custom ones (the setting's top bound, 30, here; the setting itself in the service).
const packagesBody = z.object({
  packages: z
    .array(
      z.object({
        kind: z.enum(SOLD_KINDS),
        title: text(2, 80),
        price: z.number().int().positive(),
        days: z.number().int().min(1).max(366).optional().meta({ description: 'Custom packages only (1–366); other kinds take their days from settings' }),
        admissionFee: z.number().int().nonnegative().optional().meta({ description: 'Poisha, added to a desk membership on the first one and after a re-join (never to passes)' }),
        channel: z.enum(CHANNELS).optional().meta({ description: 'desk (the gym’s own books only), online (passes) or both (default)' }),
        visitLimit: z.number().int().min(1).max(1000).nullable().optional(),
        sort: z.number().int().min(0).max(1000).optional(),
      })
    )
    .min(1)
    .max(35)
    .meta({ description: 'Every active package: one per kind except custom (at most gym_manage.max_custom_packages); one sold online is needed only to submit. Days: gym.month_days, gym.quarter_days, gym.half_year_days, gym.year_days, or the custom days' }),
});
const photoOrder = z.object({ ids: z.array(id).min(1).max(20) });
const buyBody = z.object({ packageId: id, validFrom: date.meta({ description: 'The first day' }) });
const passesQuery = z.object({ status: z.enum(['active', 'used', 'expired']).optional() });
const redeemBody = z
  .object({ token: z.string().trim().min(10).max(200).optional(), code: z.string().trim().min(6).max(12).optional() })
  .refine((b) => Boolean(b.token) !== Boolean(b.code), 'Send the QR token or the 6-character code');
const admissionsQuery = z.object({ date: date.optional() });
const soldQuery = z.object({ status: z.enum(PASS_STATUSES).optional() });
const planBody = z.object({
  profileId: id,
  title: text(3, 80),
  description: text(5, 500).nullable().optional(),
  sessionsPerMonth: z.number().int().min(1).max(62).nullable().optional().meta({ description: 'Empty = as agreed' }),
  price: z.number().int().positive(),
  whereKind: z.enum(['gym', 'home', 'online']),
  gymId: id.nullable().optional(),
  areaId: id.nullable().optional(),
});
const planPatch = planBody
  .omit({ profileId: true })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
const subscribeBody = z.object({ planId: id, startDate: date });
const problemBody = z.object({ statement: text(10, 2000) });
const reasonBody = z.object({ reason: text(5, 300) });
const adminGymsQuery = z.object({ status: z.enum(GYM_STATUSES).optional(), q: z.string().trim().max(60).optional() });

// ---------------- responses
const named = z.object({ id, key: z.string(), nameEn: z.string(), nameBn: z.string() });
const Hours = z.array(z.object({ dow: z.number().int(), openTime: z.string(), closeTime: z.string(), womenOnly: z.boolean() }));
const Package = z.object({
  id,
  kind: z.enum(KINDS),
  title: z.string(),
  price: poisha,
  days: z.number().int(),
  // M24 §7.1; absent on gyms approved before prompt 1 (their packages are sold online, no admission fee).
  admissionFee: poisha.optional(),
  channel: z.enum(CHANNELS).optional(),
  visitLimit: nullable(z.number().int()).optional(),
  sort: z.number().int().optional(),
});
const OwnerPackage = Package.extend({ admissionFee: poisha, channel: z.enum(CHANNELS), visitLimit: nullable(z.number().int()), sort: z.number().int() }).meta({ id: 'GymOwnerPackage' });
const GymCard = z
  .object({
    id,
    slug: z.string(),
    name: z.string(),
    area: nullable(named),
    cover: nullable(z.string()),
    facilities: z.array(named.extend({ icon: nullable(z.string()) })),
    dayPrice: nullable(poisha).meta({ description: 'Always null: gyms sell no day pass since 2 Nov 2026. Installed apps still read it; it goes in a later release.' }),
    monthPrice: nullable(poisha),
    quarterPrice: nullable(poisha),
    womenOnlyHours: z.boolean(),
    openNow: z.boolean(),
    ratingAvg: nullable(z.number()),
    ratingCount: z.number().int(),
    taking: z.boolean(),
    distanceM: nullable(z.number().int()).meta({ description: 'Metres from the position sent (the gym’s pin, else its area’s centre); null without a position' }),
  })
  .meta({ id: 'GymCard' });
const GymList = z.object({ items: z.array(GymCard), total: z.number().int(), nextCursor: nullable(z.string()) }).meta({ id: 'GymList' });
const GymPage = GymCard.extend({
  addressLine: z.string(),
  lat: nullable(z.number()),
  lng: nullable(z.number()),
  about: nullable(z.string()),
  photos: z.array(z.object({ id, url: z.string() })),
  hours: Hours,
  packages: z.array(Package),
  advanceDays: z.number().int(),
  today: date,
  joinRequestsOpen: z.boolean().meta({ description: 'M24: the gym takes join requests (live, managed on gym.kriraghor.com, switched on); show Join this gym' }),
}).meta({ id: 'GymPage' });
const OwnerGym = z
  .object({
    id,
    slug: z.string(),
    status: z.enum(GYM_STATUSES),
    editStatus: nullable(z.string()),
    liveVersion: z.number().int(),
    name: z.string(),
    areaId: id,
    addressLine: z.string(),
    lat: nullable(z.number()),
    lng: nullable(z.number()),
    about: nullable(z.string()),
    facilityIds: z.array(id),
    photos: z.array(z.object({ id, url: z.string() })),
    hours: Hours,
    packages: z.array(OwnerPackage),
    reviewReason: nullable(z.object({ code: z.string(), text: nullable(z.string()) })),
    limits: z.object({
      minPhotos: z.number().int(),
      maxPhotos: z.number().int(),
      maxCustomPackages: z.number().int().meta({ description: "gym_manage.max_custom_packages (M24-FR-24)" }),
      kindDays: z.object({ day: z.number().int(), month: z.number().int(), quarter: z.number().int(), half_year: z.number().int(), year: z.number().int() }).meta({ description: "Days each kind covers (custom: the days chosen)" }),
    }),
    firstLiveAt: nullable(dateTime),
    ownerId: id.optional(),
  })
  .meta({ id: 'OwnerGym' });
const OwnerGymList = z.object({ items: z.array(OwnerGym) }).meta({ id: 'OwnerGymList' });
const Pass = z
  .object({
    id,
    code: z.string(),
    status: z.enum(PASS_STATUSES),
    kind: z.enum(KINDS),
    title: z.string(),
    gym: nullable(z.object({ id, slug: z.string(), name: z.string(), addressLine: nullable(z.string()) })),
    validFrom: date,
    validTo: date,
    money: z.object({ price: poisha, refunded: poisha }),
    paidAt: nullable(dateTime),
    firstRedeemedAt: nullable(dateTime),
    lastRedeemedAt: nullable(dateTime),
    closedAt: nullable(dateTime),
    closeReason: nullable(z.string()),
    token: nullable(z.string()).meta({ description: 'The QR payload, only to the holder while the pass is active' }),
    backupCode: nullable(z.string()).meta({ description: '6 characters, only to the holder while the pass is active' }),
    can: z.object({ cancel: z.boolean() }),
  })
  .meta({ id: 'GymPass' });
const PassResult = z.object({ pass: Pass, payment: nullable(z.object({ id, payUrl: z.string() })) }).meta({ id: 'GymPassResult' });
const PassList = z.object({ items: z.array(Pass) }).meta({ id: 'GymPassList' });
const Admission = z
  .object({ passCode: z.string(), kind: z.enum(KINDS), title: z.string(), validFrom: date, validTo: date, status: z.enum(PASS_STATUSES), holder: z.object({ displayName: nullable(z.string()) }), redeemedAt: dateTime, released: staffHidden(poisha) })
  .meta({ id: 'GymAdmission' });
const AdmissionList = z
  .object({ date, items: z.array(z.object({ passCode: z.string(), kind: z.enum(KINDS), title: z.string(), holder: nullable(z.string()), method: z.enum(['qr', 'code']), redeemedAt: dateTime })) })
  .meta({ id: 'GymAdmissionList' });
const SoldList = z
  .object({
    items: z.array(
      z.object({
        id,
        code: z.string(),
        kind: z.enum(KINDS),
        title: z.string(),
        status: z.enum(PASS_STATUSES),
        validFrom: date,
        validTo: date,
        holder: nullable(z.string()),
        // Round B3: staff with passes.view get the passes without any money.
        money: staffHidden(z.object({ price: poisha, fee: poisha, net: poisha, released: poisha, refunded: poisha })),
        paidAt: nullable(dateTime),
        firstRedeemedAt: nullable(dateTime),
      })
    ),
  })
  .meta({ id: 'GymSoldList' });
const Plan = z
  .object({ id, profileId: id, title: z.string(), description: nullable(z.string()), sessionsPerMonth: nullable(z.number().int()), price: poisha, where: z.enum(['gym', 'home', 'online']), gymId: nullable(id), areaId: nullable(id), status: z.enum(['active', 'retired']) })
  .meta({ id: 'TrainerPlan' });
const PlanList = z.object({ items: z.array(Plan) }).meta({ id: 'TrainerPlanList' });
const PlanOffer = PlanList.extend({ today: date, startDays: z.number().int(), cancelDays: z.number().int() }).meta({ id: 'TrainerPlanOffer', description: 'The active plans of a trainer, with the Dhaka date today and how far ahead a subscription may start' });
const MyPlans = z.object({ profiles: z.array(z.object({ id, slug: z.string(), headline: z.string(), status: z.string() })), items: z.array(Plan) }).meta({ id: 'MyTrainerPlans' });
const Period = z.object({
  id,
  seq: z.number().int(),
  periodStart: date,
  periodEnd: date,
  status: z.enum(PERIOD_STATUSES),
  price: poisha,
  payBy: nullable(dateTime),
  releaseAt: nullable(dateTime),
  released: poisha,
  refunded: poisha,
  disputeId: nullable(z.string()),
});
const Subscription = z
  .object({
    id,
    code: z.string(),
    status: z.enum(SUB_STATUSES),
    phase: z.string().meta({ description: 'active, renewal_due, grace or lapsed while active; otherwise the status' }),
    role: z.enum(['member', 'trainer']),
    title: z.string(),
    sessionsPerMonth: nullable(z.number().int()),
    price: poisha,
    other: z.object({ name: nullable(z.string()) }),
    startedOn: date,
    paidThrough: nullable(date),
    renew: z.boolean(),
    current: nullable(Period),
    next: nullable(Period),
    payment: nullable(z.object({ id, payUrl: z.string() })),
    can: z.object({ pay: z.boolean(), cancel: z.boolean(), refundOnCancel: z.boolean(), problem: z.boolean() }),
    endedAt: nullable(dateTime),
    endReason: nullable(z.string()),
  })
  .meta({ id: 'TrainerSubscription' });
const SubscriptionList = z.object({ items: z.array(Subscription) }).meta({ id: 'TrainerSubscriptionList' });
const TrainerCard = hireSchemas.Card.extend({ planFrom: nullable(poisha), plans: z.number().int() }).meta({ id: 'GymTrainerCard', description: 'A fitness trainer (M11 HireCard) with the cheapest active monthly plan and the number of plans' });
const TrainerList = z.object({ items: z.array(TrainerCard), nextCursor: nullable(z.string()) }).meta({ id: 'GymTrainerList' });
const StaffPass = Pass.extend({ holderId: id, ownerId: id, money: z.object({ price: poisha, fee: poisha, net: poisha, released: poisha, refunded: poisha }), escrow: nullable(z.object({}).loose()) }).meta({ id: 'GymStaffPass' });
const StaffSubscription = z
  .object({
    id,
    code: z.string(),
    status: z.enum(SUB_STATUSES),
    title: z.string(),
    price: poisha,
    memberId: id,
    trainerId: id,
    startedOn: date,
    paidThrough: nullable(date),
    renew: z.boolean(),
    periods: z.array(z.object({ seq: z.number().int(), periodStart: date, periodEnd: date, status: z.enum(PERIOD_STATUSES), price: poisha, released: poisha, refunded: poisha, releaseAt: nullable(dateTime), escrow: nullable(z.object({}).loose()) })),
  })
  .meta({ id: 'GymStaffSubscription' });
const StaffAction = z.object({ id, status: z.enum(GYM_STATUSES) });

module.exports = {
  KINDS,
  CHANNELS,
  idParam,
  slugParam,
  codeParam,
  idOrCodeParam,
  photoParams,
  listQuery,
  trainersQuery,
  createGym,
  updateGym,
  hoursBody,
  packagesBody,
  photoOrder,
  buyBody,
  passesQuery,
  redeemBody,
  admissionsQuery,
  soldQuery,
  planBody,
  planPatch,
  subscribeBody,
  problemBody,
  reasonBody,
  adminGymsQuery,
  GymList,
  GymPage,
  OwnerGym,
  OwnerGymList,
  PassResult,
  PassList,
  Admission,
  AdmissionList,
  SoldList,
  Plan,
  PlanList,
  PlanOffer,
  MyPlans,
  Subscription,
  SubscriptionList,
  TrainerList,
  StaffPass,
  StaffSubscription,
  StaffAction,
};
