'use strict';

/**
 * M24 request and response schemas (zod → validation and OpenAPI, §9). Money in poisha; dates are Dhaka
 * calendar dates (YYYY-MM-DD); times ISO 8601. Keys marked "fees.collect only" are absent for staff who
 * may not collect fees (and the owner always gets them); amounts never reach the desk card otherwise.
 */
const { z } = require('zod');
const rules = require('./gym-manage.rules');

const id = z.uuid();
const date = z.iso.date();
const dateTime = z.iso.datetime({ offset: true });
const poisha = z.number().int();
const nullable = (t) => t.nullable();
const text = (min, max) => z.string().trim().min(min).max(max);
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const limit = z.coerce.number().int().min(1).max(100).default(25);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM');
const MONEY_NOTE = 'Only for the owner and staff with fees.collect';
const money = (schema) => schema.optional().meta({ description: MONEY_NOTE });

const GENDERS = ['male', 'female', 'other'];
const MEMBER_STATUSES = ['new', 'active', 'frozen', 'expired', 'left', 'removed'];
const MS_STATUSES = ['upcoming', 'active', 'frozen', 'expired', 'cancelled', 'changed'];
const DUE_STATUSES = ['unpaid', 'partial', 'paid', 'waived', 'void'];
const PAY_METHODS = ['cash', 'owner_bkash', 'owner_nagad', 'card_counter', 'other', 'online', 'opening'];
const KINDS = ['day', 'month', 'quarter', 'half_year', 'year', 'custom'];
const REMINDER_KINDS = ['renewal_due', 'ends_today', 'overdue', 'expired', 'receipt', 'pay_link', 'plan', 'morning', 'monthly'];
const SMS_KINDS = ['renewal_due', 'ends_today', 'overdue', 'receipt', 'pay_link'];
// M27-FR-30: blood group, height, weight, conditions and injuries (encrypted); null clears a field.
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const HEALTH_FIELDS = {
  bloodGroup: z.enum(BLOOD_GROUPS).nullable().optional(),
  heightCm: z.number().int().min(50).max(250).nullable().optional(),
  weightKg: z.number().min(10).max(400).multipleOf(0.1).nullable().optional(),
  medical: z.string().trim().max(500).nullable().optional().meta({ description: 'Conditions and injuries, encrypted; shown to the owner and plans.manage only' }),
};
const Bmi = z.object({ value: z.number(), band: z.enum(['under', 'normal', 'over', 'obese']) }).meta({ id: 'GymBmi' });
const absentQuery = z.object({ days: z.coerce.number().int().min(1).max(365).optional().meta({ description: 'Not seen for this many days (M27-FR-31); default the gym setting' }) });
const REQUEST_STATUSES = ['pending', 'accepted', 'declined', 'expired', 'cancelled'];
const IMPORT_STATUSES = ['previewed', 'applied', 'undone', 'discarded'];
const FEATURES = rules.FEATURES;

// ---------------- params
const gymParam = z.object({ gymId: id });
const memberParam = z.object({ gymId: id, memberId: id });
const attendanceParam = z.object({ gymId: id, attendanceId: id });
const membershipParam = z.object({ gymId: id, membershipId: id });
const dueParam = z.object({ gymId: id, dueId: id });
const feePaymentParam = z.object({ gymId: id, feePaymentId: id });
const requestParam = z.object({ gymId: id, requestId: id });
const importParam = z.object({ gymId: id, importId: id });
const meMemberParam = z.object({ memberId: id });
const meRequestParam = z.object({ requestId: id });
const meReceiptParam = z.object({ feePaymentId: id });
const tokenParam = z.object({ token: z.string().trim().min(10).max(200) });

// ---------------- requests
const shortCode = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(rules.SHORT_CODE, '2 to 6 capital letters'));
const settingsPatch = z
  .object({
    shortCode: shortCode.optional().meta({ description: 'Member codes {SHORT}-0001 and receipts {SHORT}-R26-000001; unique among the owner’s gyms. The first PATCH must carry it (it creates the settings)' }),
    tin: nullable(text(1, 20)).optional(),
    bin: nullable(text(1, 20)).optional(),
    receiptFooter: nullable(text(1, 200)).optional(),
    entryPolicy: z.enum(['allow', 'warn', 'block']).optional(),
    absentAlertDays: nullable(z.number().int()).optional().meta({ description: 'Within the bounds of gym_manage.absent_alert_days; null = the platform default' }),
    joinRequestsOpen: z.boolean().optional(),
    remindersOff: z.array(z.enum(REMINDER_KINDS)).max(REMINDER_KINDS.length).optional(),
    smsKinds: z.array(z.enum(SMS_KINDS)).max(SMS_KINDS.length).optional(),
    vatEnabled: z.boolean().optional().meta({ description: 'M27-FR-28: show VAT on member receipts (prices include it); needs vatBps' }),
    vatBps: nullable(z.number().int().min(1).max(10000)).optional().meta({ description: 'The VAT rate in basis points (15% = 1500), at most gym_manage.vat_max_bps' }),
    visitsOpen: z.boolean().optional().meta({ description: 'Trial visits: people book a free visit from the gym page (plan feature visits)' }),
    visitDailyCap: nullable(z.number().int().min(1).max(1000)).optional().meta({ description: 'Visits a day, at most gym_manage.visit_daily_cap_max; null = gym_manage.visit_daily_cap_default' }),
    visitPerPerson: z.number().int().min(1).max(100).optional().meta({ description: 'Visits one person may book at this gym, at most gym_manage.visit_per_person_max' }),
    visitNote: nullable(text(1, 300)).optional().meta({ description: 'What to bring and where to go, shown with the booking' }),
    selfRenewOpen: z.boolean().optional().meta({ description: 'M24-FR-121: linked members may renew their own membership in the app' }),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
const deskSearchQuery = z.object({ q: text(1, 200) });
const checkinBody = z
  .object({
    memberId: id.optional(),
    token: z.string().trim().min(10).max(200).optional().meta({ description: 'A member QR token (v1.gm.…)' }),
    override: z.boolean().optional().meta({ description: 'Owner only: let a blocked member in (needs reason)' }),
    reason: text(2, 200).optional(),
  })
  .refine((b) => Boolean(b.memberId) !== Boolean(b.token), 'Send the member id or the QR token');
const dayQuery = z.object({ date: date.optional() });
const membersQuery = z.object({
  status: z.enum(MEMBER_STATUSES).optional().meta({ description: 'Default: everyone but removed (removed: owner only)' }),
  due: bool.optional(),
  overdue: bool.optional(),
  expiring: bool.optional().meta({ description: 'The running membership ends within 7 days' }),
  frozen: bool.optional(),
  notSeen: z.coerce.number().int().min(1).max(365).optional().meta({ description: 'Days without a counted check-in (active members with an active membership; frozen members are left out, M24-FR-53)' }),
  packageId: id.optional(),
  linked: bool.optional(),
  trainerId: id.optional().meta({ description: 'Members assigned to this trainer (the business_members id from GET …/trainers; feature trainers)' }),
  q: text(1, 80).optional().meta({ description: 'Name (contains or similar), member code (exact) or phone (exact)' }),
  cursor: z.string().max(400).optional(),
  limit,
});
const paymentBody = z.object({
  amountPoisha: z.number().int().positive(),
  method: z.enum(rules.METHODS),
  paidOn: date.optional().meta({ description: 'Default today (Dhaka); earlier dates up to gym_manage.backdate_days need fees.adjust' }),
  note: text(1, 300).optional(),
});
const assignFields = {
  packageId: id,
  startsOn: date.meta({ description: 'From gym_manage.backdate_days ago to 60 days ahead' }),
  admissionFee: z.boolean().optional().meta({ description: 'Default true on the first membership and after a re-join; false there needs fees.adjust' }),
  discountPoisha: z.number().int().nonnegative().optional().meta({ description: 'Needs fees.adjust and a reason; at most the price' }),
  discountReason: text(2, 200).optional(),
};
const assignBody = z.object({ ...assignFields, payment: paymentBody.optional().meta({ description: 'The first payment (fees.collect)' }) });
const memberBody = z.object({
  displayName: text(2, 80),
  phone: z.string().trim().min(10).max(20).meta({ description: 'Bangladeshi mobile; unique among the gym’s non-removed members' }),
  gender: z.enum(GENDERS).optional(),
  birthDate: date.optional(),
  email: z.email().max(191).nullable().optional(),
  emergencyContact: z.object({ name: text(1, 80), phone: z.string().trim().min(6).max(20) }).nullable().optional(),
  ...HEALTH_FIELDS,
  notes: text(1, 2000).optional().meta({ description: 'The first note (append-only, never shown to the member)' }),
  membership: z.object(assignFields).optional(),
  payment: paymentBody.optional().meta({ description: 'Needs membership; fees.collect' }),
});
const memberPatch = z
  .object({
    version: z.number().int().min(1).meta({ description: 'The member’s version (optimistic locking; 409 VERSION_CONFLICT when stale)' }),
    displayName: text(2, 80).optional(),
    phone: z.string().trim().min(10).max(20).optional(),
    gender: nullable(z.enum(GENDERS)).optional(),
    birthDate: nullable(date).optional(),
    email: z.email().max(191).nullable().optional(),
    emergencyContact: z.object({ name: text(1, 80), phone: z.string().trim().min(6).max(20) }).nullable().optional(),
    ...HEALTH_FIELDS,
  })
  .refine((b) => Object.keys(b).length > 1, 'Nothing to change');
const inviteBody = z
  .object({ phone: z.string().trim().min(10).max(20).optional(), username: z.string().trim().min(3).max(30).optional() })
  .refine((b) => !(b.phone && b.username), 'Send a phone or a username, not both')
  .default({});
const leaveBody = z.object({ reason: z.enum(rules.LEFT_REASONS), leftOn: date.optional(), note: text(1, 2000).optional() });
const reasonBody = z.object({ reason: text(2, 300) });
const noteBody = z.object({ body: text(1, 2000) });
const monthQuery = z.object({ month: month.optional() });
const requestsQuery = z.object({ status: z.enum(REQUEST_STATUSES).optional(), direction: z.enum(['gym_invite', 'join_request']).optional() });
const renewBody = z.object({ packageId: id.optional(), startsOn: date.optional().meta({ description: 'Only used past the renewal grace; never in the past' }), payment: paymentBody.optional() });
const freezeBody = z.object({ fromOn: date, toOn: date, reason: text(2, 200) });
const changeBody = z.object({
  packageId: id,
  onDate: date.optional().meta({ description: 'Default today; from the membership start (or gym_manage.backdate_days ago) to today' }),
  dueAmountPoisha: nullable(z.number().int().nonnegative()).optional().meta({ description: 'Overrides the default (new price − unused credit); needs fees.adjust' }),
});
const duesQuery = z.object({ status: z.enum(DUE_STATUSES).optional().meta({ description: 'Default unpaid and partial' }), overdue: bool.optional(), dueOn: date.optional(), memberId: id.optional(), cursor: z.string().max(400).optional(), limit });
const waiveBody = z.object({ amountPoisha: z.number().int().positive(), reason: text(2, 300) });
const importQuery = z.object({ fileName: z.string().trim().max(200).optional() });
const consentBody = z.object({ grant: z.boolean() });
const tierBody = z.object({ tier: z.enum(rules.TIERS) });
// Prompt 3b, the SMS add-on (M24-FR-96 to FR-100).
const smsAddonBody = z.object({ enabled: z.boolean() });
const smsBundlesBody = z.object({ bundles: z.number().int().min(1).max(20) });
const smsEntriesQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() });
const smsAdjustBody = z.object({ units: z.number().int().min(-100000).max(100000).refine((v) => v !== 0, 'Not 0'), note: text(3, 200) });
const SmsAddonView = z
  .object({
    available: z.boolean().meta({ description: 'The platform switch is on and the plan is paid' }),
    enabled: z.boolean().meta({ description: 'gym_saas.sms_addon_enabled' }),
    status: z.enum(['active', 'paused', 'ended']).nullable(),
    startedAt: z.string().nullable(),
    balance: z.number().int(),
    allowanceLeft: z.number().int(),
    pricePoisha: z.number().int(),
    included: z.number().int(),
    bundle: z.object({ size: z.number().int(), pricePoisha: z.number().int(), validDays: z.number().int() }),
    reserveUnits: z.number().int(),
    lowBalance: z.number().int(),
    bundles: z.array(z.object({ units: z.number().int(), expiresOn: z.string() })),
  })
  .meta({ id: 'GymSmsAddon' });
const SmsEntry = z.object({ id, kind: z.enum(['grant', 'purchase', 'reserve', 'settle', 'expire', 'adjust']), units: z.number().int(), expiresOn: z.string().nullable(), gymId: id.nullable(), invoiceId: id.nullable(), note: z.string().nullable(), createdAt: z.string() });
const SmsEntries = z.object({ balance: z.number().int(), items: z.array(SmsEntry) }).meta({ id: 'GymSmsEntries' });
const SmsBundleBought = z.object({ invoice: z.object({}).passthrough(), units: z.number().int(), payment: z.object({ id, payUrl: z.string() }) }).meta({ id: 'GymSmsBundleBought' });
const SmsAdjusted = z.object({ balance: z.number().int(), entry: SmsEntry }).meta({ id: 'GymSmsAdjusted' });
const meRequestsQuery = z.object({ status: z.enum(REQUEST_STATUSES).optional(), direction: z.enum(['gym_invite', 'join_request']).optional().meta({ description: 'Default both: invites to me and my join requests' }) });
const healthNoteBody = z.object({ text: nullable(z.string().max(500)) });
/** M27-FR-30: the member's own health profile (linked; encrypted conditions). */
const healthBody = z.object(HEALTH_FIELDS).refine((b) => Object.keys(b).length > 0, 'Nothing to change');

// ---------------- responses
const MemberSummary = z
  .object({
    id,
    memberCode: z.string(),
    displayName: z.string(),
    phoneLast4: z.string(),
    gender: nullable(z.enum(GENDERS)),
    status: z.enum(MEMBER_STATUSES),
    source: z.enum(['desk', 'platform', 'import', 'pass']),
    linked: z.boolean(),
    joinedOn: date,
    photoPath: nullable(z.string()).meta({ description: 'API path under /api/v1 (fetch with the bearer token); the photo is private' }),
  })
  .meta({ id: 'GymMemberSummary' });
const Current = z.object({ membershipId: id, title: z.string(), packageId: id, packageKind: z.enum(KINDS), startsOn: date, endsOn: date, status: z.enum(['active', 'frozen']), daysLeft: z.number().int() });
const MemberListItem = MemberSummary.extend({
  current: nullable(Current),
  flags: z.object({ due: z.boolean(), overdue: z.boolean() }),
  lastCheckInOn: nullable(date),
  trainer: nullable(z.object({ businessMemberId: id, displayName: nullable(z.string()) })).meta({ description: 'The assigned trainer (M24-FR-21)' }),
  outstandingPoisha: money(poisha),
}).meta({ id: 'GymMemberListItem' });
const MemberList = z.object({ items: z.array(MemberListItem), nextCursor: nullable(z.string()) }).meta({ id: 'GymMemberList' });
const Freeze = z.object({ id, fromOn: date, toOn: date, endedEarlyOn: nullable(date), reason: z.string(), status: z.enum(['scheduled', 'active', 'done', 'cancelled']) });
const Membership = z
  .object({
    id,
    memberId: id,
    packageId: id,
    packageKind: z.enum(KINDS),
    title: z.string(),
    days: z.number().int(),
    pricePoisha: poisha,
    admissionFeePoisha: poisha,
    discountPoisha: poisha,
    discountReason: nullable(z.string()),
    visitLimit: nullable(z.number().int()),
    origin: z.enum(['new', 'renewal', 'change', 'rejoin', 'import']),
    createdVia: z.enum(['desk', 'member']).meta({ description: 'M24-FR-126: made at the desk, or by the member in the app' }),
    previousId: nullable(id),
    startsOn: date,
    endsOn: date,
    frozenDays: z.number().int(),
    freezesCount: z.number().int(),
    status: z.enum(MS_STATUSES),
    daysLeft: z.number().int(),
    cancelledAt: nullable(dateTime),
    cancelReason: nullable(z.string()),
    dueId: nullable(id),
    freezes: z.array(Freeze),
  })
  .meta({ id: 'GymMembership' });
const FeePayment = z
  .object({
    id,
    dueId: id,
    memberId: id,
    amountPoisha: poisha.meta({ description: 'Negative for a reversal' }),
    method: z.enum(PAY_METHODS),
    paidOn: date,
    receiptNo: nullable(z.string()),
    receiptUrl: nullable(z.string()).meta({ description: 'The signed public receipt page (gym.kriraghor.com/r/…); positive rows only' }),
    reversesId: nullable(id),
    reversedById: nullable(id),
    reason: nullable(z.string()),
    note: nullable(z.string()),
    receivedBy: nullable(z.object({ id, displayName: nullable(z.string()) })),
    paymentId: nullable(id).optional().meta({ description: 'Online payments: the M06 payment' }),
    linkId: nullable(id).optional().meta({ description: 'Online payments: the payment link it paid' }),
    providerCharge: nullable(z.object({ bps: z.number().int(), poisha, netPoisha: poisha }))
      .optional()
      .meta({ description: 'Online payments: the provider’s charge passed through at cost and what the gym receives (M24-FR-43). Round B3: business staff never receive this key; never shown to the member' }),
    createdAt: dateTime,
  })
  .meta({ id: 'GymFeePayment' });
const Due = z
  .object({
    id,
    membershipId: id,
    memberId: id,
    dueOn: date,
    status: z.enum(DUE_STATUSES),
    overdue: z.boolean(),
    amountPoisha: money(poisha),
    paidPoisha: money(poisha),
    waivedPoisha: money(poisha),
    outstandingPoisha: money(poisha),
    waiveReason: money(nullable(z.string())),
    voidedAt: money(nullable(dateTime)),
    voidReason: money(nullable(z.string())),
    payments: money(z.array(FeePayment)),
  })
  .meta({ id: 'GymDue' });
const MemberProfile = z
  .object({
    member: MemberSummary.extend({
      birthDate: nullable(date),
      email: nullable(z.string()).optional().meta({ description: 'Owner and members.edit only' }),
      emergencyContact: nullable(z.object({ name: z.string(), phone: z.string() })).optional().meta({ description: 'Owner and members.edit only' }),
      healthNote: nullable(z.string()).optional().meta({ description: 'Owner (and plans.manage) only' }),
      healthNoteBy: nullable(z.enum(['member', 'staff'])).optional(),
      bloodGroup: nullable(z.enum(BLOOD_GROUPS)).optional().meta({ description: 'Owner and members.edit only (M27-FR-30)' }),
      heightCm: nullable(z.number().int()).optional().meta({ description: 'Owner (and plans.manage) only' }),
      weightKg: nullable(z.number()).optional().meta({ description: 'Owner (and plans.manage) only' }),
      bmi: nullable(Bmi).optional().meta({ description: 'Owner (and plans.manage) only' }),
      medical: nullable(z.string()).optional().meta({ description: 'Conditions and injuries; owner (and plans.manage) only' }),
      leftOn: nullable(date),
      leftReason: nullable(z.enum(rules.LEFT_REASONS)),
      removedAt: nullable(dateTime),
      removedReason: nullable(z.string()),
      importId: nullable(id),
      version: z.number().int(),
      createdAt: dateTime,
      notesCount: z.number().int(),
      trainer: nullable(z.object({ businessMemberId: id, displayName: nullable(z.string()) })).meta({ description: 'The assigned trainer (M24-FR-21)' }),
    }),
    link: z.object({ linked: z.boolean(), linkedAt: nullable(dateTime), unlinkedAt: nullable(dateTime), pendingInvite: nullable(z.object({ id, expiresAt: dateTime, accountKnown: z.boolean() })) }),
    memberships: z.array(Membership),
    dues: z.array(Due),
    can: z.object({ edit: z.boolean(), collect: z.boolean(), adjust: z.boolean(), revealPhone: z.boolean(), remove: z.boolean(), assignTrainer: z.boolean(), plans: z.boolean() }),
  })
  .meta({ id: 'GymMemberProfile' });
const PaymentRef = z.object({ id, receiptNo: z.string(), amountPoisha: poisha, receiptUrl: z.string() });
const AddMemberResult = z.object({ member: MemberSummary, membership: nullable(Membership), due: nullable(Due), payment: nullable(PaymentRef) }).meta({ id: 'GymAddMemberResult' });
const MembershipResult = z
  .object({
    membership: Membership,
    due: nullable(Due),
    payment: nullable(PaymentRef).optional(),
    previous: Membership.optional().meta({ description: 'Change only: the old membership (status changed)' }),
    credit: z.object({ remainingDays: z.number().int(), totalDays: z.number().int(), creditPoisha: poisha }).optional().meta({ description: 'Change only: the unused credit (§6.1)' }),
  })
  .meta({ id: 'GymMembershipResult' });
const PaymentResult = z.object({ payment: FeePayment, due: Due, receipt: z.object({ receiptNo: z.string(), url: z.string() }) }).meta({ id: 'GymPaymentResult' });
const ReverseResult = z.object({ reversal: FeePayment, due: Due }).meta({ id: 'GymReverseResult' });
const DueResult = z.object({ due: Due });
const DueList = z
  .object({ items: z.array(Due.extend({ member: MemberSummary, membership: nullable(z.object({ title: z.string(), packageKind: z.enum(KINDS), startsOn: date, endsOn: date })) })), nextCursor: nullable(z.string()) })
  .meta({ id: 'GymDueList' });
const Receipt = z
  .object({
    id,
    receiptNo: z.string(),
    url: z.string(),
    gym: z.object({ id, name: z.string(), addressLine: nullable(z.string()), tin: nullable(z.string()).meta({ description: 'Only when the owner entered one (G10)' }), bin: nullable(z.string()), footer: nullable(z.string()) }),
    member: z.object({ memberCode: z.string(), displayName: z.string() }),
    membership: nullable(z.object({ title: z.string(), packageKind: z.enum(KINDS), startsOn: date, endsOn: date })),
    amountPoisha: poisha,
    method: z.enum(PAY_METHODS),
    paidOn: date,
    receivedBy: nullable(z.string()),
    outstandingAfterPoisha: poisha,
    issuedAt: dateTime,
    reversed: nullable(z.object({ on: date, at: dateTime })).meta({ description: '"Reversed on {date}" once reversed' }),
  })
  .meta({ id: 'GymReceipt' });
const CashClosing = z
  .object({
    date,
    scope: z.enum(['own', 'all']).meta({ description: 'own: the caller’s collections (fees.collect); all: the owner and reports.view' }),
    totals: z.object({ counterPoisha: poisha, receivedPoisha: poisha, reversedPoisha: poisha, onlinePoisha: poisha, byMethod: z.record(z.string(), poisha) }),
    byStaff: z.array(z.object({ userId: id, displayName: nullable(z.string()), count: z.number().int(), totalPoisha: poisha, byMethod: z.record(z.string(), poisha) })),
    items: z.array(FeePayment),
  })
  .meta({ id: 'GymCashClosing' });
const DeskCard = z
  .object({
    attendanceId: id.optional(),
    counted: z.boolean().optional(),
    checkedInAt: dateTime.optional(),
    method: z.enum(['desk', 'member_qr', 'entrance_qr', 'pass']).optional(),
    override: z.boolean().optional(),
    firstCheckInToday: nullable(dateTime).optional().meta({ description: 'The first counted check-in today, on a repeat' }),
    member: MemberSummary.extend({ avatarUrl: nullable(z.string()).meta({ description: 'A linked member’s public account photo when the gym has none' }) }),
    membership: nullable(z.object({ id, title: z.string(), packageKind: z.enum(KINDS), startsOn: date, endsOn: date, daysLeft: z.number().int(), status: z.enum(['active', 'frozen']), visitLimit: nullable(z.number().int()), visits: z.number().int() })),
    flags: z.array(z.enum(['expired', 'frozen', 'unpaid', 'expiring', 'visitLimitReached'])),
    reasons: z.array(z.enum(['expired', 'frozen', 'none', 'unpaid', 'visit_limit'])),
    decision: z.enum(['allow', 'warn', 'block']),
    canOverride: z.boolean(),
    outstandingPoisha: money(poisha),
  })
  .meta({ id: 'GymDeskCard' });
// ---------------- trial visits (product owner, 9 Nov 2026)
const VISIT_HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour, Dhaka time');
const visitParam = z.object({ gymId: id, visitId: id });
const meVisitParam = z.object({ visitId: id });
const visitSlugParam = z.object({ slug: z.string().min(1).max(120) });
const visitsQuery = z.object({ date: date.optional(), status: z.enum(['booked', 'attended', 'cancelled', 'no_show']).optional() });
const visitBody = z.object({ gymId: id, date, arriveAt: VISIT_HHMM });
const visitCancelBody = z.object({ reason: text(3, 300) });
const VisitStatus = z.enum(['booked', 'attended', 'cancelled', 'no_show']);
const GymVisitView = z
  .object({
    id,
    guest: z.object({ userId: id, name: nullable(z.string()), phoneLast4: nullable(z.string()) }),
    date,
    arriveAt: VISIT_HHMM,
    status: VisitStatus,
    cancelledBy: nullable(z.enum(['guest', 'gym'])),
    cancelReason: nullable(z.string()),
    attendedAt: nullable(dateTime),
    memberId: nullable(id),
    createdAt: dateTime,
  })
  .meta({ id: 'GymVisit' });
const GymVisits = z
  .object({ date, open: z.boolean(), cap: z.number().int(), counts: z.object({ booked: z.number().int(), attended: z.number().int(), cancelled: z.number().int(), no_show: z.number().int() }), items: z.array(GymVisitView) })
  .meta({ id: 'GymVisits' });
const GymVisitOne = z.object({ visit: GymVisitView }).meta({ id: 'GymVisitOne' });
const VisitPhone = z.object({ visitId: id, phone: z.string() }).meta({ id: 'GymVisitPhone' });
const VisitConverted = z.object({ member: z.object({}).passthrough() }).meta({ id: 'GymVisitConverted' });
const MyVisit = z
  .object({
    id,
    gym: nullable(z.object({ id, name: z.string(), slug: z.string(), addressLine: nullable(z.string()) })),
    date,
    arriveAt: VISIT_HHMM,
    status: VisitStatus,
    code: nullable(z.string()).meta({ description: 'The 6-character code for the desk, while booked and not past' }),
    token: nullable(z.string()).meta({ description: 'The QR text for the desk (v1.gv…), while booked and not past' }),
    cancelledBy: nullable(z.enum(['guest', 'gym'])),
    cancelReason: nullable(z.string()),
    attendedAt: nullable(dateTime),
    createdAt: dateTime,
  })
  .meta({ id: 'MyGymVisit' });
const MyVisits = z.object({ items: z.array(MyVisit) }).meta({ id: 'MyGymVisits' });
const MyVisitOne = z.object({ visit: MyVisit }).meta({ id: 'MyGymVisitOne' });
const VisitSlots = z
  .object({
    open: z.boolean(),
    note: nullable(z.string()),
    perPerson: z.number().int().optional(),
    days: z.array(z.object({ date, windows: z.array(z.object({ openTime: VISIT_HHMM, closeTime: VISIT_HHMM, womenOnly: z.boolean() })), placesLeft: z.number().int() })),
  })
  .meta({ id: 'GymVisitSlots' });

const DeskSearch = z
  .object({
    items: z.array(DeskCard),
    pass: nullable(z.object({ passCode: z.string(), kind: z.enum(KINDS), title: z.string(), validFrom: date, validTo: date, status: z.string(), holder: z.object({ displayName: nullable(z.string()) }), method: z.enum(['qr', 'code']) })).meta({ description: 'An M20 pass (desk.admit); admit it with POST /me/gyms/{id}/redemptions' }),
    visit: nullable(GymVisitView).optional().meta({ description: 'A trial-visit guest named by their QR or code (plan feature visits); check in with POST …/visits/{visitId}/check-in' }),
  })
  .meta({ id: 'GymDeskSearch' });
const CheckinDay = z
  .object({
    date,
    counted: z.number().int(),
    inGymNow: z.number().int().meta({ description: 'M27-FR-43: members with an open visit now' }),
    items: z.array(
      z.object({
        id,
        member: MemberSummary,
        checkedInAt: dateTime,
        method: z.enum(['desk', 'member_qr', 'entrance_qr', 'pass']),
        counted: z.boolean(),
        decision: z.enum(['allow', 'warn', 'override']),
        reasons: z.array(z.string()),
        by: nullable(z.object({ id, displayName: nullable(z.string()) })),
        checkedOutAt: nullable(dateTime).meta({ description: 'M27-FR-40: null while the visit is open' }),
        visitMinutes: nullable(z.number().int()).meta({ description: 'null while open or when the visit closed by itself' }),
      })
    ),
  })
  .meta({ id: 'GymCheckinDay' });
const Plan = { tier: z.enum(rules.TIERS), features: z.record(z.enum(FEATURES), z.boolean()), restricted: z.boolean(), subscriptionStatus: z.enum(['active', 'past_due', 'restricted', 'closed']) };
const ManageGyms = z
  .object({
    items: z.array(
      z.object({
        id,
        name: z.string(),
        slug: z.string(),
        listingStatus: z.string().meta({ description: 'The M20 gym status (draft = private, management only)' }),
        role: z.enum(['owner', 'staff']),
        permissions: nullable(z.array(z.string())).meta({ description: 'Staff: their permissions; owner: null (everything)' }),
        shortCode: nullable(z.string()),
        setupDone: z.boolean(),
        today: z.object({ checkIns: z.number().int(), activeMembers: z.number().int() }),
        ...Plan,
      })
    ),
    owner: nullable(z.object(Plan)),
  })
  .meta({ id: 'GymManageGyms' });
const Overview = z
  .object({
    gymId: id,
    date,
    setupDone: z.boolean(),
    ...Plan,
    tiles: z.object({
      checkInsToday: z.number().int(),
      activeMembers: z.number().int(),
      members: z.number().int(),
      newThisMonth: z.number().int(),
      expiringThisWeek: z.number().int(),
      inGymNow: z.number().int().meta({ description: 'M27-FR-43: members with an open visit now' }),
      notSeen: z.number().int(),
      notSeenDays: z.number().int(),
      requestsWaiting: z.number().int(),
      dueTodayCount: z.number().int(),
      overdueCount: z.number().int(),
      guestsToday: z.number().int().optional(),
      collectedTodayPoisha: poisha.optional().meta({ description: 'Owner and reports.view only' }),
      dueTodayPoisha: poisha.optional().meta({ description: 'Owner and reports.view only' }),
    }),
    // M27-FR-32, FR-33 (round 1).
    expiring: z
      .array(z.object({ memberId: id, memberCode: z.string(), displayName: z.string(), phoneLast4: z.string(), endsOn: date, daysLeft: z.number().int(), linked: z.boolean() }))
      .meta({ description: 'Memberships ending within gym_manage.expiring_list_days, not yet renewed (members.view; empty otherwise); at most 50' }),
    mix: z.object({ active: z.number().int(), frozen: z.number().int(), expired: z.number().int(), new: z.number().int(), left: z.number().int() }).meta({ description: 'Members by status (removed left out)' }),
  })
  .meta({ id: 'GymOverview' });
const Packages = z
  .object({
    items: z.array(
      z.object({
        id,
        gymId: id,
        kind: z.enum(['day', 'month', 'quarter', 'half_year', 'year', 'custom']),
        title: z.string(),
        pricePoisha: poisha,
        days: z.number().int(),
        admissionFeePoisha: poisha,
        channel: z.enum(['desk', 'online', 'both']),
        visitLimit: z.number().int().nullable(),
        sort: z.number().int(),
        status: z.string(),
      })
    ),
  })
  .meta({ id: 'GymManagePackages' });
const Settings = z
  .object({
    gymId: id,
    setupDone: z.boolean(),
    shortCode: nullable(z.string()),
    tin: nullable(z.string()),
    bin: nullable(z.string()),
    receiptFooter: nullable(z.string()),
    entryPolicy: z.enum(['allow', 'warn', 'block']),
    absentAlertDays: nullable(z.number().int()),
    absentAlertDaysDefault: z.number().int(),
    joinRequestsOpen: z.boolean(),
    remindersOff: z.array(z.string()),
    smsKinds: z.array(z.string()),
    vatEnabled: z.boolean(),
    vatBps: nullable(z.number().int()),
    vatMaxBps: z.number().int(),
    visitsOpen: z.boolean(),
    visitDailyCap: nullable(z.number().int()),
    visitDailyCapDefault: z.number().int(),
    visitDailyCapMax: z.number().int(),
    visitPerPerson: z.number().int(),
    visitPerPersonMax: z.number().int(),
    visitNote: nullable(z.string()),
    selfRenewOpen: z.boolean(),
    selfRenewDaysBefore: z.number().int(),
    importConsentUntil: nullable(dateTime),
    nextMemberCode: nullable(z.string()),
  })
  .meta({ id: 'GymManageSettings' });
const Tier = z.object({ key: z.enum(rules.TIERS), maxMembers: nullable(z.number().int()), pricePoisha: poisha, features: z.array(z.enum(FEATURES)), minGyms: z.number().int().optional() });
const Pricing = z
  .object({
    currency: z.literal('BDT'),
    tiers: z.array(Tier),
    featureMinTiers: z.record(z.string(), z.enum(rules.TIERS)),
    activeWindowDays: z.number().int(),
    noticePct: z.number().int(),
    foundingPlacesLeft: z.number().int().meta({ description: 'Founding partner places still open (0: hide the offer; M24-FR-88)' }),
    founding: z.object({ limit: z.number().int(), freeMonths: z.number().int(), discountPct: z.number().int(), discountMonths: z.number().int() }).meta({ description: 'The founding partner terms from settings: free months on a paid plan, then the discount for its months' }),
  })
  .meta({ id: 'GymPricing' });
// ---------------- prompt 2 (online money, reminders and billing)
// Prompt 3b: sms with the SMS add-on (falls back to the other channels when it cannot go).
const LINK_CHANNELS = ['in_app', 'email', 'sms'];
const LINK_STATUSES = ['open', 'paid', 'expired', 'cancelled'];
const INVOICE_STATUSES = ['issued', 'overdue', 'paid', 'void'];
const SUB_STATUSES = ['active', 'past_due', 'restricted', 'closed'];
const OVERRIDE_KEYS = ['fees.gym_referral_poisha', 'fees.gym_pct'];
const FEE_SOURCES = ['setting', 'owner_override', 'gym_override'];
const linkParam = z.object({ gymId: id, linkId: id });
const meDueParam = z.object({ dueId: id });

// ---------------- M24 §19: a member renews by themselves
const renewMineBody = z.object({
  packageId: id.optional().meta({ description: 'One of the packages the renewal read offers; left out: the current package' }),
  pay: z.enum(['online', 'counter']).meta({ description: 'online: the payment to open comes back; counter: the fee waits as an unpaid due' }),
});
const RenewalChoice = z.object({ packageId: id, title: z.string(), kind: z.enum(KINDS), days: z.number().int(), pricePoisha: poisha, startsOn: date, endsOn: date, current: z.boolean() });
const MyRenewal = z
  .object({
    memberId: id,
    gym: z.object({ id, name: z.string(), slug: z.string() }),
    can: z.boolean(),
    reason: nullable(z.string()).meta({ description: 'Why not: GYM_SELF_RENEW_OFF, GYM_MEMBER_STATE, GYM_RENEWAL_EXISTS, GYM_NOTHING_TO_RENEW or GYM_RENEW_TOO_EARLY' }),
    opensOn: nullable(date).meta({ description: 'When it is too early: the first day a renewal can be made' }),
    daysBefore: z.number().int(),
    current: nullable(z.object({ title: z.string(), packageKind: z.enum(KINDS), endsOn: date, status: z.enum(MS_STATUSES) })),
    packages: z.array(RenewalChoice),
    renewal: nullable(
      z.object({ membershipId: id, title: z.string(), packageKind: z.enum(KINDS), startsOn: date, endsOn: date, createdVia: z.enum(['desk', 'member']), dueId: nullable(id), amountPoisha: poisha, outstandingPoisha: poisha, cancellable: z.boolean() })
    ).meta({ description: 'A renewal that already waits to start' }),
    onlineFees: z.boolean(),
    onlineFeesReason: nullable(z.string()),
  })
  .meta({ id: 'MyGymRenewal' });
const RenewedByMember = z
  .object({
    membership: Membership,
    due: z.object({ dueId: id, amountPoisha: poisha, dueOn: date, status: z.string() }),
    payment: nullable(z.object({ paymentId: id, payUrl: z.string(), amountPoisha: poisha })).meta({ description: 'Only when paying online: open payUrl' }),
  })
  .meta({ id: 'GymRenewedByMember' });

// ---------------- M24 §20: body progress
const measure = (min, max) => z.number().min(min).max(max).multipleOf(0.1).nullable().optional();
const bodyEntryBody = z
  .object({
    measuredOn: date.optional().meta({ description: 'Today when left out; up to gym_manage.body_backdate_days back' }),
    weightKg: measure(10, 400),
    bodyFatPct: measure(2, 70),
    chestCm: measure(10, 300),
    waistCm: measure(10, 300),
    hipsCm: measure(10, 300),
    armCm: measure(10, 300),
    thighCm: measure(10, 300),
  })
  .meta({ description: 'At least one measurement. A second entry for the same date replaces the first' });
const meBodyEntryParam = z.object({ memberId: id, entryId: id });
const bodyEntryParam = z.object({ gymId: id, memberId: id, entryId: id });
const num = nullable(z.number());
const BodyEntry = z.object({ id, measuredOn: date, weightKg: num, bodyFatPct: num, chestCm: num, waistCm: num, hipsCm: num, armCm: num, thighCm: num, byRole: z.enum(['member', 'staff']), createdAt: dateTime, bmi: num });
const BodyChange = nullable(z.object({ from: z.number(), to: z.number(), delta: z.number(), fromOn: date, toOn: date }));
const BodyRange = z.object({ min: z.number(), max: z.number() });
const BodyProgress = z
  .object({
    memberId: id,
    on: z.boolean().meta({ description: 'false: the gym’s plan does not include body progress' }),
    heightCm: nullable(z.number().int()),
    entries: z.array(BodyEntry).meta({ description: 'Oldest first' }),
    change: z.object({ weightKg: BodyChange, bodyFatPct: BodyChange, chestCm: BodyChange, waistCm: BodyChange, hipsCm: BodyChange, armCm: BodyChange, thighCm: BodyChange }),
    limits: z.object({
      backdateDays: z.number().int(),
      fields: z.object({ weightKg: BodyRange, bodyFatPct: BodyRange, chestCm: BodyRange, waistCm: BodyRange, hipsCm: BodyRange, armCm: BodyRange, thighCm: BodyRange }),
    }),
  })
  .meta({ id: 'GymBodyProgress' });
const invoiceParam = z.object({ invoiceId: id });
const ownerParam = z.object({ ownerId: id });
const overrideParam = z.object({ overrideId: id });
const linkBody = z.object({
  amountPoisha: z.number().int().positive().optional().meta({ description: 'Up to the outstanding; default all of it (M24-FR-40)' }),
  channels: z.array(z.enum(LINK_CHANNELS)).max(3).optional().meta({ description: 'Send the link in-app (and by push), by email and, with the SMS add-on, by SMS; default in-app and email. [] only shows the QR' }),
});
const linksQuery = z.object({ dueId: id.optional(), status: z.enum(LINK_STATUSES).optional() });
const refundBody = z.object({ amountPoisha: z.number().int().positive(), reason: text(2, 300) });
const payLinkBody = z.object({ linkAccount: z.boolean().default(false).meta({ description: 'Link this membership to my account (only when my verified phone is the member’s; M24-FR-41)' }) });
const periodFields = {
  month: month.optional().meta({ description: 'A calendar month (YYYY-MM); otherwise from and to' }),
  from: date.optional(),
  to: date.optional(),
};
const periodCheck = (q) => !q.from || !q.to || (q.from <= q.to && rules.daysBetween(q.from, q.to) <= 366);
const reportQuery = z.object(periodFields).refine(periodCheck, { message: 'from must be before to, at most 366 days apart', path: ['to'] });
const exportQuery = z.object({ ...periodFields, dataset: z.enum(['members', 'payments', 'attendance']) }).refine(periodCheck, { message: 'from must be before to, at most 366 days apart', path: ['to'] });
const adminOwnersQuery = z.object({ tier: z.enum(rules.TIERS).optional(), status: z.enum(SUB_STATUSES).optional(), founding: bool.optional() });
const adminInvoicesQuery = z.object({ status: z.enum(INVOICE_STATUSES).optional(), period: month.optional(), ownerId: id.optional() });
const overridesQuery = z.object({ ownerId: id.optional(), status: z.enum(['active', 'ended']).optional() });
const foundingBody = z.object({ on: z.boolean(), reason: text(2, 300) });
const overrideBody = z
  .object({
    scopeType: z.enum(['owner', 'gym']),
    scopeId: id.meta({ description: 'The owner’s user id, or the gym id' }),
    key: z.enum(OVERRIDE_KEYS),
    value: z.number().nonnegative().meta({ description: 'Poisha for the referral fee, percent for fees.gym_pct; inside the setting’s bounds' }),
    reason: text(2, 300),
    validFrom: dateTime.optional().meta({ description: 'Default now' }),
    validTo: nullable(dateTime).optional().meta({ description: 'Ended by the job at this time; null runs until a master ends it' }),
  })
  .refine((b) => b.key !== 'fees.gym_referral_poisha' || Number.isInteger(b.value), { message: 'A referral fee is a whole number of poisha', path: ['value'] });

const PaymentLink = z
  .object({
    id,
    dueId: id,
    memberId: id,
    amountPoisha: poisha,
    status: z.enum(LINK_STATUSES).meta({ description: 'An open link past expiresAt shows expired' }),
    origin: z.enum(['staff', 'member']),
    channels: z.array(z.enum(LINK_CHANNELS)),
    expiresAt: dateTime,
    url: z.string().meta({ description: 'gym.kriraghor.com/p/{token}: the page the member pays from' }),
    qr: z.string().meta({ description: 'The QR payload (the same URL)' }),
    paymentId: nullable(id),
    paidAt: nullable(dateTime),
    releaseAt: nullable(dateTime).meta({ description: 'paid_at + gym_manage.online_fee_release_hours; the owner can refund until then' }),
    releasedAt: nullable(dateTime),
    refundedPoisha: poisha,
    createdAt: dateTime,
  })
  .meta({ id: 'GymPaymentLink' });
const PaymentLinkList = z.object({ items: z.array(PaymentLink) }).meta({ id: 'GymPaymentLinkList' });
const PayLinkSummary = z
  .object({
    link: z.object({ id, status: z.enum(LINK_STATUSES), amountPoisha: poisha, expiresAt: dateTime }),
    gym: nullable(z.object({ id, name: z.string(), slug: z.string() })),
    member: z.object({ memberCode: z.string(), firstName: z.string().meta({ description: 'The first word of the name only' }) }),
    membership: nullable(z.object({ title: z.string(), packageKind: z.enum(KINDS), startsOn: date, endsOn: date })),
    dueOn: nullable(date),
    onlineFees: z.boolean().meta({ description: 'false: the gym cannot take fees online now (pay at the counter)' }),
    receipt: nullable(z.object({ receiptNo: z.string(), url: z.string() })),
    viewer: nullable(z.object({ phoneMatches: z.boolean(), linked: z.boolean(), canLink: z.boolean() })).meta({ description: 'Signed-in viewers only: show the "Link this membership" tick when canLink' }),
  })
  .meta({ id: 'GymPayLinkSummary' });
const PayStart = z.object({ paymentId: id, payUrl: z.string().meta({ description: 'gym.kriraghor.com/pay/{paymentId} (M24-FR-104)' }), amountPoisha: poisha, willLink: z.boolean() }).meta({ id: 'GymPayStart' });
const MyDues = z
  .object({
    items: z.array(
      z.object({
        dueId: id,
        memberId: id,
        memberCode: z.string(),
        gym: nullable(z.object({ id, name: z.string(), slug: z.string() })),
        membership: nullable(z.object({ title: z.string(), packageKind: z.enum(KINDS), startsOn: date, endsOn: date })),
        amountPoisha: poisha,
        paidPoisha: poisha,
        outstandingPoisha: poisha,
        dueOn: date,
        status: z.enum(['unpaid', 'partial']),
        overdue: z.boolean(),
        onlineFees: z.boolean(),
        onlineFeesReason: nullable(z.enum(['role', 'tier', 'restricted'])),
        openLink: nullable(z.object({ id, amountPoisha: poisha, expiresAt: dateTime, url: z.string() })),
      })
    ),
  })
  .meta({ id: 'MyGymDues' });
const RefundResult = z
  .object({ refund: z.object({ id, amountPoisha: poisha, status: z.string() }), payment: z.lazy(() => FeePayment), link: PaymentLink })
  .meta({ id: 'GymFeeRefundResult' });
const RemindersPage = z
  .object({
    gymId: id,
    feature: z.object({ reminders: z.boolean(), minTier: z.enum(rules.TIERS) }),
    restricted: z.boolean(),
    kinds: z.array(z.object({ kind: z.enum(REMINDER_KINDS), on: z.boolean(), member: z.boolean() })),
    offsets: z.object({ renewalRemindDays: z.array(z.number().int()), overdueRemindDays: z.array(z.number().int()), morningSummaryTime: z.string() }),
    sms: z.object({ available: z.boolean().meta({ description: 'The SMS add-on can be switched on (platform switch and a paid plan)' }), active: z.boolean(), balance: z.number().int(), kinds: z.array(z.string()), choosable: z.array(z.string()) }),
    reachability: z.object({ activeMembers: z.number().int(), smsOnly: z.number().int().meta({ description: 'Active members with no linked account and no email (reachable only by SMS, M24-FR-59)' }) }),
    log: z.object({
      days: z.number().int(),
      items: z.array(
        z.object({
          id,
          kind: z.string(),
          date,
          createdAt: dateTime,
          offsetKey: z.string(),
          channels: z.array(z.string()),
          memberCode: nullable(z.string()),
          status: z.enum(['published', 'skipped']),
          skipReason: nullable(z.string()),
        })
      ),
    }),
  })
  .meta({ id: 'GymRemindersPage' });
const ReportPeriod = z.object({ from: date, to: date, month: nullable(month) });
const ReportFigures = {
  members: z.object({
    activeAtStart: z.number().int(),
    activeAtEnd: z.number().int(),
    activeNow: z.number().int(),
    new: z.number().int(),
    renewals: z.number().int(),
    left: z.object({ total: z.number().int(), byReason: z.record(z.string(), z.number().int()) }),
    churn: nullable(z.number()).meta({ description: 'left ÷ active at the start, 4 decimals' }),
  }),
  money: z.object({
    collectedPoisha: poisha,
    onlinePoisha: poisha,
    counterPoisha: poisha,
    byMethod: z.record(z.string(), poisha),
    outstandingPoisha: poisha,
    overduePoisha: poisha,
    byPackage: z.array(z.object({ title: z.string(), packageKind: z.enum(KINDS), collectedPoisha: poisha })),
    monthOverMonth: z.array(z.object({ month, collectedPoisha: poisha })),
    overdueList: z.array(z.object({ memberId: id, memberCode: z.string(), displayName: z.string(), dueId: id, dueOn: date, outstandingPoisha: poisha })).optional(),
  }),
  attendance: z.object({
    visits: z.number().int(),
    daily: z.array(z.object({ date, visits: z.number().int() })),
    busiestHours: z.array(z.object({ hour: z.number().int(), visits: z.number().int() })),
    averagePerActive: nullable(z.number()),
    notSeen: z.number().int(),
    notSeenDays: z.number().int(),
  }),
};
const GymReport = z.object({ gymId: id, period: ReportPeriod, ...ReportFigures }).meta({ id: 'GymReport' });
const AbsentList = z
  .object({ gymId: id, days: z.number().int(), items: z.array(z.object({ id, memberCode: z.string(), displayName: z.string(), phoneLast4: z.string(), endsOn: date, lastCheckInOn: nullable(date), daysSince: nullable(z.number().int()) })) })
  .meta({ id: 'GymAbsentList' });
const AllGymsReport = z
  .object({
    period: ReportPeriod,
    gyms: z.array(z.object({ id, name: z.string(), slug: z.string() })),
    totals: z.object(ReportFigures),
    multiGym: z.boolean(),
    perGym: nullable(z.array(z.object({ gym: z.object({ id, name: z.string(), slug: z.string() }), ...ReportFigures }))).meta({ description: 'Side by side with the multi_gym feature (Pro)' }),
    passSales: z.object({ available: z.boolean(), dashboard: z.string().meta({ description: 'M19’s gym dashboard (pass sales), for an active gym_owner role' }) }),
  })
  .meta({ id: 'GymAllReports' });
const InvoiceLine = z.object({ id, kind: z.enum(['tier', 'proration', 'founding_free', 'founding_discount', 'referral', 'sms_addon', 'sms_bundle', 'vat', 'adjustment']), descriptionEn: z.string(), descriptionBn: z.string(), quantity: z.number().int(), unitPoisha: poisha, amountPoisha: poisha.meta({ description: 'Negative for discounts' }) });
const Invoice = z
  .object({
    id,
    number: z.string().meta({ description: 'GI-26-000123' }),
    ownerId: id,
    kind: z.enum(['monthly', 'sms_bundle']),
    periodStart: nullable(date),
    periodEnd: nullable(date),
    period: nullable(month),
    billedTier: nullable(z.enum(rules.TIERS)),
    peakActive: nullable(z.number().int()),
    subtotalPoisha: poisha,
    vatPoisha: poisha,
    totalPoisha: poisha,
    status: z.enum(INVOICE_STATUSES),
    issuedAt: dateTime,
    dueAt: dateTime.meta({ description: 'Overdue from this instant (the start of the day after dueOn)' }),
    dueOn: date,
    paidAt: nullable(dateTime),
    paymentId: nullable(id),
    voidedAt: nullable(dateTime),
    voidReason: nullable(z.string()),
    lines: z.array(InvoiceLine).optional(),
  })
  .meta({ id: 'GymInvoice' });
const InvoiceList = z.object({ items: z.array(Invoice) }).meta({ id: 'GymInvoiceList' });
const InvoicePayResult = z.object({ invoice: Invoice, payment: z.object({ id, payUrl: z.string() }) }).meta({ id: 'GymInvoicePayResult' });
const FeeThatApplies = z.object({ source: z.enum(FEE_SOURCES), validTo: nullable(dateTime).meta({ description: 'A special rate until this time; null for the standard rate' }) });
const Fees = z.object({ referral: FeeThatApplies.extend({ valuePoisha: z.number() }), passCommission: FeeThatApplies.extend({ pct: z.number() }) });
const Founding = z.object({
  partner: z.boolean(),
  no: nullable(z.number().int()),
  paidTierSince: nullable(date),
  freeUntil: nullable(date),
  discountUntil: nullable(date),
  discountPct: z.number().int(),
  placesLeft: z.number().int(),
});
const Subscription = z.object({
  id,
  ownerId: id,
  chosenTier: z.enum(rules.TIERS),
  monthMaxTier: z.enum(rules.TIERS),
  monthOf: date,
  status: z.enum(SUB_STATUSES),
  startedOn: date,
  paidTierSince: nullable(date),
  foundingPartner: z.boolean(),
  foundingNo: nullable(z.number().int()),
  pastDueAt: nullable(dateTime),
  restrictedAt: nullable(dateTime),
});
const FeeOverride = z
  .object({
    id,
    scopeType: z.enum(['owner', 'gym']),
    scopeId: id,
    ownerId: id,
    key: z.enum(OVERRIDE_KEYS),
    value: z.number(),
    reason: z.string(),
    validFrom: dateTime,
    validTo: nullable(dateTime),
    status: z.enum(['active', 'ended']),
    source: z.enum(['owner_override', 'gym_override']),
    setBy: id,
    endedBy: nullable(id),
    endedAt: nullable(dateTime),
    endReason: nullable(z.string()),
    createdAt: dateTime,
  })
  .meta({ id: 'GymFeeOverride' });
const FeeOverrideList = z.object({ items: z.array(FeeOverride) }).meta({ id: 'GymFeeOverrideList' });
const AdminOwners = z
  .object({
    items: z.array(
      z.object({
        ownerId: id,
        displayName: nullable(z.string()),
        subscription: Subscription,
        gyms: z.number().int().meta({ description: 'Gyms set up for management' }),
        activeMembers: nullable(z.object({ count: z.number().int(), on: date })),
        lastInvoice: nullable(z.object({ id, number: z.string(), status: z.enum(INVOICE_STATUSES), totalPoisha: poisha, period: nullable(month) })),
      })
    ),
  })
  .meta({ id: 'GymAdminOwners' });
const AdminOwnerDetail = z
  .object({
    owner: z.object({ id, displayName: nullable(z.string()), gymOwnerRole: nullable(z.string()) }),
    subscription: Subscription,
    activeMembers: z.object({ today: z.number().int(), gymsWithMembers: z.number().int(), monthPeak: nullable(z.number().int()), openInvoices: z.array(Invoice), restrictOn: nullable(date), founding: Founding, fees: Fees }),
    gyms: z.array(z.object({ id, name: z.string(), listingStatus: z.string(), members: z.number().int(), activeMembers: z.number().int() })).meta({ description: 'Counts only, never member data' }),
    invoices: z.array(Invoice),
    overrides: z.array(FeeOverride),
    imports: z.array(z.object({ id, gymId: id, status: z.enum(IMPORT_STATUSES), rowsOk: z.number().int(), rowsFailed: z.number().int(), uploadedAs: z.enum(['owner', 'staff']), createdAt: dateTime, appliedAt: nullable(dateTime), undoneAt: nullable(dateTime) })),
    smsAddon: SmsAddonView,
  })
  .meta({ id: 'GymAdminOwnerDetail' });
const AdminInvoices = z
  .object({ items: z.array(Invoice.extend({ ownerName: nullable(z.string()) })), totals: z.record(z.string(), z.object({ count: z.number().int(), totalPoisha: poisha })) })
  .meta({ id: 'GymAdminInvoices' });

const Billing = z
  .object({
    subscription: z.object({
      id,
      chosenTier: z.enum(rules.TIERS),
      monthMaxTier: z.enum(rules.TIERS),
      monthOf: date,
      status: z.enum(SUB_STATUSES),
      startedOn: date,
      foundingPartner: z.boolean(),
      foundingNo: nullable(z.number().int()),
      freeUntil: nullable(date),
      discountUntil: nullable(date),
      restrictOn: nullable(date).meta({ description: 'Past due: the last day before the panel becomes read-only' }),
    }),
    activeMembers: z.object({
      today: z.number().int(),
      monthPeak: z.number().int().meta({ description: 'The highest daily count this month (the next invoice uses the tier that fits it)' }),
      limit: nullable(z.number().int()),
      fitTier: z.enum(rules.TIERS),
      gymsWithMembers: z.number().int(),
      windowDays: z.number().int(),
      noticePct: z.number().int(),
    }),
    features: z.record(z.enum(FEATURES), z.boolean()),
    tiers: z.array(Tier),
    gyms: z.array(z.object({ id, name: z.string(), listingStatus: z.string() })),
    fees: Fees.meta({ description: 'The fees that apply to this owner: standard or a special rate until a date (M24-FR-90)' }),
    founding: Founding,
    smsAddon: SmsAddonView,
    openInvoices: z.array(Invoice),
  })
  .meta({ id: 'GymBilling' });
const Request = z
  .object({
    id,
    direction: z.enum(['gym_invite', 'join_request']),
    status: z.enum(REQUEST_STATUSES),
    memberId: nullable(id),
    member: nullable(z.object({ id, memberCode: z.string(), displayName: z.string(), phoneLast4: z.string() })),
    accountKnown: z.boolean().meta({ description: 'Whether the invite reached a Kriraghor account yet (never which one)' }),
    requester: nullable(z.object({ displayName: nullable(z.string()), avatarUrl: nullable(z.string()), phoneLast4: nullable(z.string()) })).meta({ description: 'Join requests: the person asking (they agreed the gym sees their name and phone; the full phone after accepting, through the reveal)' }),
    package: nullable(z.object({ id, title: z.string(), kind: z.enum(KINDS), pricePoisha: poisha })).meta({ description: 'Join requests: the package asked for' }),
    note: nullable(z.string()).meta({ description: 'Join requests: the note from the person asking' }),
    expiresAt: dateTime,
    decidedAt: nullable(dateTime),
    createdAt: dateTime,
  })
  .meta({ id: 'GymLinkRequest' });
const RequestList = z.object({ items: z.array(Request) }).meta({ id: 'GymLinkRequestList' });
const RequestResult = z.object({ request: Request });
const Note = z.object({ id, body: z.string(), by: z.object({ id, displayName: nullable(z.string()) }), createdAt: dateTime }).meta({ id: 'GymMemberNote' });
const NoteList = z.object({ items: z.array(Note) });
const Calendar = z.object({ month, count: z.number().int(), days: z.array(z.object({ date, at: dateTime, method: z.string() })) }).meta({ id: 'GymCheckinCalendar' });
const RevealedPhone = z.object({ memberId: id, phone: z.string() });
const PhotoResult = z.object({ photoPath: nullable(z.string()) });
const UnlinkResult = z.object({ memberId: id, linked: z.literal(false) });
const ImportReportRow = z
  .object({
    n: z.number().int().meta({ description: 'Line in the file (the header is line 1)' }),
    status: z.enum(['ok', 'error']),
    errors: z.array(z.object({ field: z.string(), code: z.string().meta({ description: 'name_invalid, phone_invalid, duplicate_phone_in_gym, duplicate_phone_in_file, gender_invalid, date_invalid, date_required, code_invalid, duplicate_code_in_gym, duplicate_code_in_file, unknown_package, package_required, end_before_start, too_long, amount_invalid' }) })),
    displayName: nullable(z.string()),
    phoneLast4: nullable(z.string()),
    memberCode: nullable(z.string()),
    package: nullable(z.string()),
    startsOn: nullable(date),
    endsOn: nullable(date),
    lastPaidPoisha: poisha,
    lastPaidOn: nullable(date),
    amountDuePoisha: poisha,
    memberId: nullable(id).meta({ description: 'Set once applied' }),
  })
  .meta({ id: 'GymImportReportRow' });
const Import = z
  .object({
    id,
    gymId: id,
    fileName: z.string(),
    fileBytes: z.number().int(),
    status: z.enum(IMPORT_STATUSES),
    uploadedAs: z.enum(['owner', 'staff']),
    rowsTotal: z.number().int(),
    rowsOk: z.number().int(),
    rowsFailed: z.number().int(),
    createdAt: dateTime,
    appliedAt: nullable(dateTime),
    undoUntil: nullable(dateTime),
    undoneAt: nullable(dateTime),
    invitesSentAt: nullable(dateTime),
    filePurged: z.boolean(),
    can: z.object({ apply: z.boolean(), undo: z.boolean(), discard: z.boolean(), sendInvites: z.boolean() }),
    report: z.array(ImportReportRow).optional(),
    sent: z.number().int().optional().meta({ description: 'send-invites only: invites created' }),
  })
  .meta({ id: 'GymImport' });
const ImportList = z.object({ items: z.array(Import) });
const ConsentResult = z.object({ gymId: id, importConsentUntil: nullable(dateTime) });
const GymRef = nullable(z.object({ id, name: z.string(), slug: z.string() }));
const MyRequests = z
  .object({
    items: z.array(
      z.object({
        id,
        direction: z.enum(['gym_invite', 'join_request']),
        status: z.enum(REQUEST_STATUSES),
        gym: GymRef,
        memberCode: nullable(z.string()),
        displayName: nullable(z.string()).meta({ description: 'The name the gym typed' }),
        shares: z.array(z.string()).meta({ description: 'What the gym will see once linked (M24-FR-15)' }),
        package: nullable(z.object({ id, title: z.string(), kind: z.enum(KINDS) })).meta({ description: 'Join requests: the package I asked for' }),
        note: nullable(z.string()).meta({ description: 'Join requests: my note' }),
        memberId: nullable(id).meta({ description: 'Join requests: my member record once the gym accepted' }),
        canCancel: z.boolean().meta({ description: 'A pending join request of mine' }),
        expiresAt: dateTime,
        createdAt: dateTime,
      })
    ),
  })
  .meta({ id: 'MyGymRequests' });
const AcceptResult = z.object({ request: z.object({ id, status: z.literal('accepted') }), memberId: id, gymId: id });
const DeclineResult = z.object({ request: z.object({ id, status: z.literal('declined') }) });
const MyMemberships = z
  .object({
    items: z.array(
      z.object({
        memberId: id,
        gym: GymRef,
        memberCode: z.string(),
        status: z.enum(MEMBER_STATUSES),
        linked: z.boolean().meta({ description: 'false: a past link (read-only receipts)' }),
        current: nullable(z.object({ title: z.string(), packageKind: z.enum(KINDS), startsOn: date, endsOn: date, daysLeft: z.number().int(), frozen: z.boolean() })),
        outstandingPoisha: poisha,
        onlineFees: z.boolean().meta({ description: 'The gym takes fees online now (owner documents, plan, not restricted; M24-FR-41)' }),
        plans: z.array(z.object({ assignmentId: id, kind: z.enum(['workout', 'diet']), title: z.string() })).meta({ description: 'Today’s workout plan and diet chart titles (active assignments; empty for a past link)' }),
      })
    ),
  })
  .meta({ id: 'MyGymMemberships' });
const MyReceiptItem = z.object({ id, receiptNo: z.string(), amountPoisha: poisha, method: z.enum(PAY_METHODS), paidOn: date, url: z.string(), reversedOn: nullable(date), gym: GymRef.optional(), memberCode: z.string().optional() });
const HealthProfile = z
  .object({ memberId: id, bloodGroup: nullable(z.enum(BLOOD_GROUPS)), heightCm: nullable(z.number().int()), weightKg: nullable(z.number()), bmi: nullable(Bmi), medical: nullable(z.string()) })
  .meta({ id: 'GymHealthProfile' });
const MyMembership = z
  .object({
    member: z.object({ id, memberCode: z.string(), displayName: z.string(), status: z.enum(MEMBER_STATUSES), linked: z.boolean(), joinedOn: date, gym: GymRef, healthNote: nullable(z.string()).optional(), healthNoteAt: nullable(dateTime).optional(), health: HealthProfile.optional().meta({ description: 'M27-FR-30: my own health fields and BMI (linked members)' }) }),
    memberships: z.array(Membership),
    dues: z.array(Due),
    receipts: z.array(MyReceiptItem),
  })
  .meta({ id: 'MyGymMembership' });
const MyReceipts = z.object({ items: z.array(MyReceiptItem) }).meta({ id: 'MyGymReceipts' });
const CheckinToken = z.object({ memberId: id, gymId: id, token: z.string(), expiresAt: dateTime.meta({ description: 'Show a new token before this; the desk accepts the previous one for one more window' }), seconds: z.number().int() }).meta({ id: 'GymCheckinToken' });
const HealthNote = z.object({ memberId: id, healthNote: nullable(z.string()), healthNoteAt: nullable(dateTime) });

// ---------------- prompt 3 (public site, member area, plans)
const PLAN_KINDS = ['workout', 'diet'];
const PLAN_STATUSES = ['active', 'retired'];
const ASSIGNMENT_STATUSES = ['active', 'replaced', 'ended'];
// Hard ceilings are the top of the settings' bounds (gym_manage.plan_max_items 50, diet_max_meals 12);
// the live limits are checked in the service (M24-FR-62).
const PLAN_ITEMS_CEILING = 50;
const DIET_MEALS_CEILING = 12;
const WORKOUT_DAYS = 7;
const joinRequestBody = z.object({
  gymId: id,
  packageId: id.optional().meta({ description: 'The package I would like (an active package of the gym sold online)' }),
  note: text(1, 300).optional(),
});
const joinAcceptBody = z
  .object({
    ...Object.fromEntries(Object.entries(assignFields).map(([k, v]) => [k, v.optional()])),
    startsOn: date.optional().meta({ description: 'With packageId: default today (Dhaka)' }),
    payment: paymentBody.optional().meta({ description: 'The first payment (needs packageId; fees.collect)' }),
  })
  .refine((b) => !b.payment || b.packageId, { message: 'A first payment needs a package', path: ['payment'] })
  .default({});
const joinDeclineBody = z.object({ reason: text(2, 300).optional().meta({ description: 'Kept with the gym; the requester is only told the gym could not accept' }) }).default({});
const trainerBody = z.object({ businessMemberId: nullable(id).meta({ description: 'A staff member from GET …/trainers, or null to take the trainer off' }) });
const planParam = z.object({ gymId: id, planId: id });
const assignmentParam = z.object({ gymId: id, assignmentId: id });
const mePlanParam = z.object({ assignmentId: id });
const plansQuery = z.object({ kind: z.enum(PLAN_KINDS).optional(), status: z.enum(PLAN_STATUSES).optional().meta({ description: 'Default active' }), template: bool.optional() });

const refText = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,20}$/, '1 to 20 letters, digits, - or _')
  .meta({ description: 'Stays the same across versions, so ticks stay attached (§6.10)' });
const bilingual = (max) =>
  z
    .object({ en: nullable(text(1, max)).optional(), bn: nullable(text(1, max)).optional() })
    .refine((n) => Boolean(n.en || n.bn), 'Write it in English or Bangla (or both)')
    .meta({ description: 'English and Bangla side by side; at least one' });
const httpsUrl = z.url({ protocol: /^https$/, hostname: z.regexes.domain }).max(500).meta({ description: 'https links only' });
const Exercise = z.object({
  ref: refText,
  exerciseKey: nullable(z.string().regex(/^[a-z0-9_]{1,40}$/))
    .optional()
    .meta({ description: 'M27-FR-71: an exercise of the library (GET /catalog/exercises); the member sees its steps' }),
  name: bilingual(80),
  sets: nullable(z.number().int().min(1).max(50)).optional(),
  reps: nullable(text(1, 20)).optional().meta({ description: '"8-10", "12" or "to failure"' }),
  timeSec: nullable(z.number().int().min(1).max(7200)).optional(),
  restSec: nullable(z.number().int().min(0).max(3600)).optional(),
  weightNote: nullable(text(1, 80)).optional(),
  note: nullable(text(1, 300)).optional(),
  videoUrl: nullable(httpsUrl).optional(),
});
const WorkoutDay = z.object({ key: refText, name: bilingual(80), items: z.array(Exercise).max(PLAN_ITEMS_CEILING) });
const Food = z.object({
  ref: refText,
  name: bilingual(80),
  portion: nullable(text(1, 40)).optional(),
  kcal: nullable(z.number().int().min(0).max(5000)).optional(),
  proteinG: nullable(z.number().min(0).max(500)).optional(),
  note: nullable(text(1, 300)).optional(),
});
const Meal = z.object({ ref: refText, name: bilingual(80), time: nullable(z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'HH:MM')).optional(), items: z.array(Food).max(PLAN_ITEMS_CEILING) });
const PlanContent = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('workout'), days: z.array(WorkoutDay).min(1).max(WORKOUT_DAYS) }).meta({ id: 'GymWorkoutContent' }),
    z.object({ kind: z.literal('diet'), meals: z.array(Meal).min(1).max(DIET_MEALS_CEILING), notes: nullable(bilingual(500)).optional() }).meta({ id: 'GymDietContent' }),
  ])
  .meta({ id: 'GymPlanContent', description: 'M24 §6.10: up to 7 named days of exercises, or the meals of a diet chart; at most gym_manage.plan_max_items per day or meal and gym_manage.diet_max_meals meals' });
const planBody = z
  .object({
    kind: z.enum(PLAN_KINDS),
    title: text(2, 120),
    isTemplate: z.boolean().default(false),
    source: z.enum(['gym', 'ai', 'self']).default('gym').meta({ description: 'Only gym in M24: ai and self are kept for the later member subscription (M24-FR-68)' }),
    content: PlanContent,
  })
  .refine((b) => b.source === 'gym', { message: 'Only gym plans can be written here', path: ['source'] })
  .refine((b) => b.content.kind === b.kind, { message: 'The content must be of the plan’s kind', path: ['content', 'kind'] });
const planPatch = z
  .object({
    title: text(2, 120).optional(),
    isTemplate: z.boolean().optional(),
    content: PlanContent.optional().meta({ description: 'A new version (n + 1)' }),
    applyToAssigned: z.boolean().default(true).meta({ description: '"Update for the N members who have it": their active assignments move to the new version and they are told once (M24-FR-63)' }),
  })
  .refine((b) => b.title !== undefined || b.isTemplate !== undefined || b.content !== undefined, 'Nothing to change');
const planAssignBody = z
  .object({
    memberIds: z.array(id).min(1).max(100),
    startsOn: date.meta({ description: 'Day 1 of the plan; from gym_manage.backdate_days ago to 60 days ahead' }),
    endsOn: nullable(date).optional(),
  })
  .refine((b) => !b.endsOn || b.endsOn >= b.startsOn, { message: 'Must be on or after startsOn', path: ['endsOn'] })
  .refine((b) => new Set(b.memberIds).size === b.memberIds.length, { message: 'Each member once', path: ['memberIds'] });
const planLogBody = z.object({
  localDate: date.meta({ description: 'Today or up to gym_manage.plan_log_back_days back (Dhaka)' }),
  itemRef: refText,
  done: z.boolean(),
  note: nullable(text(1, 300)).optional(),
});
const meCheckinBody = z.object({ token: z.string().trim().min(10).max(200).meta({ description: 'The entrance QR (v1.ge.…) scanned at the door' }) });

const Bilingual = z.object({ en: z.string(), bn: z.string() });
const Safety = Bilingual.meta({ description: '"Given by {gym}, not medical advice" (M24-FR-69): show it on every plan view' });
const MyRequestItem = MyRequests.shape.items.element;
const JoinRequestResult = z.object({ request: MyRequestItem }).meta({ id: 'MyGymJoinRequest' });
const MyCancelResult = z.object({ request: z.object({ id, status: z.literal('cancelled') }) });
const JoinAcceptResult = z
  .object({ request: Request, member: MemberSummary, linkedExisting: z.boolean().meta({ description: 'An unlinked member with the same phone was linked instead of a new one' }), membership: nullable(Membership), due: nullable(Due), payment: nullable(PaymentRef) })
  .meta({ id: 'GymJoinAcceptResult' });
const Trainers = z
  .object({
    items: z.array(
      z.object({
        businessMemberId: id,
        displayName: nullable(z.string()),
        permissions: z.array(z.enum(['members.trainer', 'plans.manage'])).meta({ description: 'Which of the two trainer permissions they hold' }),
        assignedMembers: z.number().int(),
      })
    ),
  })
  .meta({ id: 'GymTrainers' });
const PlanSummary = z
  .object({
    id,
    gymId: id,
    kind: z.enum(PLAN_KINDS),
    title: z.string(),
    isTemplate: z.boolean(),
    source: z.enum(['gym', 'ai', 'self']),
    currentVersion: z.number().int(),
    status: z.enum(PLAN_STATUSES),
    retiredAt: nullable(dateTime),
    activeAssignments: z.number().int(),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .meta({ id: 'GymPlan' });
const PlanList = z.object({ items: z.array(PlanSummary) }).meta({ id: 'GymPlanList' });
const PlanVersion = z.object({ id, version: z.number().int(), content: PlanContent, createdAt: dateTime, createdBy: z.object({ id, displayName: nullable(z.string()) }) }).meta({ id: 'GymPlanVersion' });
const Assignment = z
  .object({
    id,
    planId: id,
    kind: z.enum(PLAN_KINDS),
    title: z.string(),
    version: z.number().int(),
    memberId: id,
    startsOn: date,
    endsOn: nullable(date),
    status: z.enum(ASSIGNMENT_STATUSES),
    endedAt: nullable(dateTime),
    createdAt: dateTime,
  })
  .meta({ id: 'GymPlanAssignment' });
const PlanAdherence = Assignment.extend({
  member: MemberSummary,
  lastTickOn: nullable(date),
  doneLast7Days: z.number().int().meta({ description: 'Items ticked done in the last 7 days (the latest tick per item and date)' }),
});
const PlanDetail = PlanSummary.extend({
  content: PlanContent.meta({ description: 'The current version' }),
  versions: z.array(PlanVersion).meta({ description: 'Newest first' }),
  assignments: z.array(PlanAdherence).meta({ description: 'Active assignments the caller can see, with adherence' }),
  movedAssignments: z.number().int().optional().meta({ description: 'PATCH with a new version: assignments moved to it' }),
}).meta({ id: 'GymPlanDetail' });
const AssignResult = z.object({ assignments: z.array(Assignment), replaced: z.number().int().meta({ description: 'Earlier assignments of the same kind that were replaced' }) }).meta({ id: 'GymPlanAssignResult' });
const AssignmentResult = z.object({ assignment: Assignment });
const PlanLog = z.object({ id, assignmentId: id, localDate: date, itemRef: z.string(), done: z.boolean(), note: nullable(z.string()), createdAt: dateTime }).meta({ id: 'GymPlanLog' });
const MemberPlans = z
  .object({
    memberId: id,
    healthNote: nullable(z.string()).optional().meta({ description: 'plans.manage and the owner only: the member’s own health note' }),
    items: z.array(
      Assignment.extend({
        content: PlanContent.optional().meta({ description: 'plans.manage and the owner only' }),
        logs: z.array(PlanLog).optional().meta({ description: 'plans.manage and the owner only: the latest tick per item and date, newest first' }),
      })
    ),
  })
  .meta({ id: 'GymMemberPlans' });
const MyPlanItem = z.object({
  assignmentId: id,
  memberId: id,
  gym: GymRef,
  kind: z.enum(PLAN_KINDS),
  title: z.string(),
  version: z.number().int(),
  startsOn: date,
  endsOn: nullable(date),
  status: z.enum(ASSIGNMENT_STATUSES),
  readOnly: z.boolean().meta({ description: 'Ended or replaced, or I left or unlinked: I can read it but not tick (M24-FR-67)' }),
  content: PlanContent,
  todayIndex: nullable(z.number().int()).meta({ description: 'Workout: today’s day in content.days (§6.10); null before the start or after the end. Diet: 0 when it runs today' }),
  week: z.array(z.object({ date, index: nullable(z.number().int()) })).meta({ description: 'Today and the next 6 days with the workout day of each' }),
  ticks: z.array(PlanLog).meta({ description: 'My latest tick per item for the days I can still tick' }),
  safety: Safety,
});
const MyPlans = z
  .object({
    today: date,
    logBackDays: z.number().int(),
    items: z.array(MyPlanItem).meta({ description: 'Active plans first (today’s workout and meals), then the rest' }),
  })
  .meta({ id: 'MyGymPlans' });
const MyPlanDetail = MyPlanItem.extend({
  versions: z.array(z.object({ version: z.number().int(), createdAt: dateTime, content: PlanContent })).meta({ description: 'The versions given to me, newest first' }),
  logs: z.array(PlanLog).meta({ description: 'Every tick I made (the latest per item and date), newest first' }),
}).meta({ id: 'MyGymPlan' });
const PlanLogResult = z.object({ log: PlanLog }).meta({ id: 'MyGymPlanLogResult' });
const EntranceToken = z
  .object({ gymId: id, gymName: z.string(), token: z.string(), expiresAt: dateTime.meta({ description: 'Show the next token before this; members may scan the previous one for one more window' }), seconds: z.number().int(), secondsLeft: z.number().int() })
  .meta({ id: 'GymEntranceToken' });
const CheckOut = z
  .object({ attendanceId: id, checkedOutAt: dateTime, visitMinutes: nullable(z.number().int()), method: z.enum(['desk', 'entrance_qr', 'auto']), member: MemberSummary })
  .meta({ id: 'GymCheckOut', description: 'M27-FR-40: the desk checked the member out' });
const EntranceCheckout = z
  .object({ checkedOut: z.literal(true), attendanceId: id, checkedOutAt: dateTime, visitMinutes: nullable(z.number().int()), gym: GymRef, member: z.object({ id, memberCode: z.string() }) })
  .meta({ id: 'MyGymEntranceCheckout', description: 'M27-FR-41: a second scan after gym_manage.min_visit_minutes checks out' });
const EntranceCheckin = z
  .object({
    checkedOut: z.literal(false).optional(),
    attendanceId: id,
    counted: z.boolean().meta({ description: 'false: already checked in today (the first time is firstCheckInToday)' }),
    checkedInAt: dateTime,
    firstCheckInToday: nullable(dateTime),
    method: z.literal('entrance_qr'),
    gym: GymRef,
    member: z.object({ id, memberCode: z.string() }),
    membership: nullable(z.object({ title: z.string(), endsOn: date, daysLeft: z.number().int(), status: z.enum(['active', 'frozen']) })),
    decision: z.enum(['allow', 'warn']),
    reasons: z.array(z.enum(['expired', 'frozen', 'none', 'unpaid', 'visit_limit'])).meta({ description: 'warn: tell the member why (no amounts)' }),
  })
  .meta({ id: 'MyGymEntranceCheckin' });
const EntranceScan = z.union([EntranceCheckin, EntranceCheckout]).meta({ id: 'MyGymEntranceScan' });


// ---------------------------------------------------------------- desk mode with a PIN (M24 §21, ADR-010)
const deskPin = z.string().regex(/^\d{4}$/, 'Four digits').meta({ description: 'Four digits; never stored or returned, only a keyed hash' });
const deskPinBody = z.object({ gymId: id, pin: deskPin });
const deskTryBody = z.object({ userId: id.meta({ description: 'The person picked on the lock screen' }), pin: deskPin });
const deskPersonParam = z.object({ gymId: id, userId: id });
const DeskPerson = z.object({
  userId: id,
  displayName: nullable(z.string()),
  role: z.enum(['owner', 'staff']),
  lockedUntil: nullable(dateTime).meta({ description: 'Too many wrong PINs: this person waits until then' }),
});
const MyDeskPins = z
  .object({ items: z.array(z.object({ gymId: id, set: z.boolean(), setAt: nullable(dateTime), lockedUntil: nullable(dateTime) })) })
  .meta({ id: 'GymMyDeskPins' });
const MyDeskPin = z.object({ gymId: id, set: z.literal(true), setAt: dateTime, lockedUntil: z.null() }).meta({ id: 'GymMyDeskPin' });
const DeskState = z
  .union([
    z.object({ open: z.literal(false) }),
    z.object({
      open: z.literal(true),
      deskId: id,
      gym: z.object({ id, name: nullable(z.string()) }),
      idleMinutes: z.number().int().meta({ description: 'gym_manage.desk_idle_minutes: without real input the desk locks after this' }),
      pinFailLimit: z.number().int().meta({ description: 'gym_manage.desk_pin_fail_limit: also the wrong PINs a device allows a person while it has no connection (M24 §22)' }),
      deviceLockedUntil: nullable(dateTime).meta({ description: 'Too many wrong PINs on this device: no tries until then' }),
      unlocked: nullable(z.object({ userId: id, unlockId: id.meta({ description: 'This unlock; offline items taken under it send it back (M24 §22)' }), displayName: nullable(z.string()), role: z.enum(['owner', 'staff']), expiresAt: dateTime })),
      people: z.array(DeskPerson).meta({ description: 'Who can unlock: the owner and active staff with a PIN set' }),
    }),
  ])
  .meta({ id: 'GymDeskState' });
const DeskTouch = z.object({ expiresAt: dateTime }).meta({ id: 'GymDeskTouch' });
const DeskClosed = z.object({ open: z.literal(false), signedOut: z.literal(true) }).meta({ id: 'GymDeskClosed' });
const DeskOverview = z
  .object({
    people: z.array(DeskPerson.extend({ pin: z.enum(['set', 'cleared', 'none']) })),
    desks: z.array(
      z.object({
        deskId: id,
        openedBy: z.object({ userId: id, displayName: nullable(z.string()) }),
        openedAt: dateTime,
        unlockedBy: nullable(z.object({ userId: id, displayName: nullable(z.string()) })),
      })
    ),
  })
  .meta({ id: 'GymDeskOverview' });
const DeskPinReset = z.object({ gymId: id, userId: id, pin: z.literal('cleared') }).meta({ id: 'GymDeskPinReset' });
const DeskEnded = z.object({ gymId: id, ended: z.number().int() }).meta({ id: 'GymDeskEnded' });

// M24 §22: the desk through a lost connection.
const OFFLINE_FLAGS = ['would_block', 'time_adjusted', 'late', 'drawer_closed', 'pin_on_device', 'unverified_taker'];
const DeskSnapshot = z
  .object({
    gymId: id,
    date: date.meta({ description: 'The Dhaka day the copy is good for' }),
    serverTime: dateTime,
    stamp: z.string().meta({ description: 'Signed gym and server time; each offline item sends it back with the time that passed on the device' }),
    refreshMinutes: z.number().int().meta({ description: 'gym_manage.desk_snapshot_refresh_minutes' }),
    maxHours: z.number().int().meta({ description: 'gym_manage.desk_offline_max_hours: items sent later are flagged late' }),
    policy: z.enum(['allow', 'warn', 'block']),
    members: z.array(
      z.object({
        id,
        memberCode: z.string(),
        displayName: z.string(),
        phoneLast4: nullable(z.string()),
        package: nullable(z.object({ title: z.string(), endsOn: date, status: z.enum(['active', 'frozen']) })),
        flags: z.array(z.string()),
        reasons: z.array(z.string()),
        decision: z.enum(['allow', 'warn', 'block']),
        inToday: z.boolean().meta({ description: 'Already has a counted check-in today' }),
      })
    ),
    dues: nullable(z.array(z.object({ id, memberId: id, title: nullable(z.string()), dueOn: date, outstandingPoisha: poisha }))).meta({ description: 'Open dues, only with fees.collect' }),
  })
  .meta({ id: 'GymDeskSnapshot' });
const offlineItemBody = z
  .object({
    clientId: id.meta({ description: 'Made by the device; equals the Idempotency-Key' }),
    kind: z.enum(['checkin', 'cash_fee']),
    memberId: id,
    method: z.enum(['desk', 'member_qr']).optional(),
    dueId: id.optional(),
    amountPoisha: poisha.min(100).optional(),
    slipNo: z.string().regex(/^T-[A-Z0-9]{4,12}$/, 'T- and 4 to 12 letters or digits').optional(),
    stamp: z.string().min(10).max(200),
    elapsedMs: z.number().int().min(0).max(30 * 86400000).meta({ description: 'Time that passed on the device between the copy arriving and the item being taken' }),
    takenBy: id.meta({ description: 'Who the device says took it' }),
    unlockId: nullable(id).optional().meta({ description: 'The desk unlock that was live when it was taken (desk mode)' }),
    pinOnDevice: z.boolean().optional().meta({ description: 'The PIN was checked on the device, without a connection' }),
  })
  .superRefine((v, ctx) => {
    const cash = v.kind === 'cash_fee';
    for (const f of ['dueId', 'amountPoisha', 'slipNo']) {
      if (cash && v[f] === undefined) ctx.addIssue({ code: 'custom', path: [f], message: 'Required for a cash fee' });
      if (!cash && v[f] !== undefined) ctx.addIssue({ code: 'custom', path: [f], message: 'Only for a cash fee' });
    }
    if (cash && v.method !== undefined) ctx.addIssue({ code: 'custom', path: ['method'], message: 'Only for a check-in' });
  });
const offlineItemsQuery = z.object({ state: z.enum(['review', 'all']).optional(), cursor: z.string().regex(/^\d{1,6}$/).optional() });
const offlineItemParam = z.object({ gymId: id, itemId: id });
const offlineResolveBody = z.object({ action: z.enum(['checked', 'apply', 'returned']), dueId: id.optional(), note: text(2, 300).optional() });
const OfflineWho = nullable(z.object({ userId: id, displayName: nullable(z.string()) }));
const OfflineReceipt = nullable(z.object({ feePaymentId: id, receiptNo: z.string(), url: z.string() }));
const OfflineItem = z
  .object({
    id,
    clientId: id,
    kind: z.enum(['checkin', 'cash_fee']),
    member: MemberSummary.partial().extend({ id }),
    dueId: nullable(id),
    amountPoisha: nullable(poisha),
    slipNo: nullable(z.string()),
    method: z.enum(['desk', 'member_qr']),
    takenAt: dateTime,
    takenOn: date,
    takenBy: OfflineWho,
    recordedAs: OfflineWho,
    sentBy: OfflineWho,
    sentAt: dateTime,
    pinOnDevice: z.boolean(),
    outcome: z.enum(['applied', 'flagged', 'parked']),
    flags: z.array(z.enum(OFFLINE_FLAGS)),
    parkReason: nullable(z.enum(['due_paid', 'due_changed', 'due_void', 'member_removed', 'member_left'])),
    attendanceId: nullable(id),
    receipt: OfflineReceipt,
    resolution: nullable(z.enum(['checked', 'applied_to_due', 'returned'])),
    resolvedBy: OfflineWho,
    resolvedAt: nullable(dateTime),
    resolutionNote: nullable(z.string()),
    resolutionReceipt: OfflineReceipt,
  })
  .meta({ id: 'GymOfflineItem' });
const OfflineItemResult = z.object({ item: OfflineItem }).meta({ id: 'GymOfflineItemResult' });
const OfflineItems = z.object({ toCheck: z.number().int().meta({ description: 'Flagged and parked items nobody has resolved' }), items: z.array(OfflineItem), nextCursor: nullable(z.string()) }).meta({ id: 'GymOfflineItems' });

module.exports = {
  visitParam,
  meVisitParam,
  visitSlugParam,
  visitsQuery,
  visitBody,
  visitCancelBody,
  GymVisitView,
  GymVisits,
  GymVisitOne,
  VisitPhone,
  VisitConverted,
  MyVisits,
  MyVisitOne,
  VisitSlots,
  joinRequestBody,
  joinAcceptBody,
  joinDeclineBody,
  trainerBody,
  planParam,
  assignmentParam,
  mePlanParam,
  plansQuery,
  PlanContent,
  planBody,
  planPatch,
  planAssignBody,
  planLogBody,
  meCheckinBody,
  JoinRequestResult,
  MyCancelResult,
  JoinAcceptResult,
  Trainers,
  PlanSummary,
  PlanList,
  PlanVersion,
  Assignment,
  PlanDetail,
  AssignResult,
  AssignmentResult,
  PlanLog,
  MemberPlans,
  MyPlans,
  MyPlanDetail,
  PlanLogResult,
  EntranceToken,
  EntranceCheckin,
  EntranceCheckout,
  EntranceScan,
  CheckOut,
  gymParam,
  memberParam,
  attendanceParam,
  membershipParam,
  dueParam,
  feePaymentParam,
  requestParam,
  importParam,
  meMemberParam,
  meRequestParam,
  meReceiptParam,
  tokenParam,
  settingsPatch,
  deskSearchQuery,
  checkinBody,
  dayQuery,
  membersQuery,
  paymentBody,
  assignBody,
  memberBody,
  memberPatch,
  inviteBody,
  leaveBody,
  reasonBody,
  noteBody,
  monthQuery,
  requestsQuery,
  renewBody,
  freezeBody,
  changeBody,
  duesQuery,
  waiveBody,
  importQuery,
  consentBody,
  tierBody,
  smsAddonBody,
  smsBundlesBody,
  smsEntriesQuery,
  smsAdjustBody,
  SmsAddonView,
  SmsEntries,
  SmsBundleBought,
  SmsAdjusted,
  meRequestsQuery,
  healthNoteBody,
  healthBody,
  absentQuery,
  MemberSummary,
  MemberListItem,
  MemberList,
  Membership,
  FeePayment,
  Due,
  MemberProfile,
  AddMemberResult,
  MembershipResult,
  PaymentResult,
  ReverseResult,
  DueResult,
  DueList,
  Receipt,
  CashClosing,
  DeskCard,
  DeskSearch,
  CheckinDay,
  ManageGyms,
  Overview,
  Packages,
  Settings,
  Pricing,
  Billing,
  Request,
  RequestList,
  RequestResult,
  Note,
  NoteList,
  Calendar,
  RevealedPhone,
  PhotoResult,
  UnlinkResult,
  Import,
  ImportList,
  ImportReportRow,
  ConsentResult,
  MyRequests,
  AcceptResult,
  DeclineResult,
  MyMemberships,
  MyMembership,
  MyReceipts,
  CheckinToken,
  HealthNote,
  HealthProfile,
  linkParam,
  meDueParam,
  renewMineBody,
  MyRenewal,
  RenewedByMember,
  bodyEntryBody,
  meBodyEntryParam,
  bodyEntryParam,
  BodyProgress,
  invoiceParam,
  ownerParam,
  overrideParam,
  linkBody,
  linksQuery,
  refundBody,
  payLinkBody,
  reportQuery,
  exportQuery,
  adminOwnersQuery,
  adminInvoicesQuery,
  overridesQuery,
  foundingBody,
  overrideBody,
  PaymentLink,
  PaymentLinkList,
  PayLinkSummary,
  PayStart,
  MyDues,
  RefundResult,
  RemindersPage,
  GymReport,
  AbsentList,
  AllGymsReport,
  Invoice,
  InvoiceList,
  InvoicePayResult,
  FeeOverride,
  FeeOverrideList,
  AdminOwners,
  AdminOwnerDetail,
  AdminInvoices,
  Subscription,
  deskPinBody,
  deskTryBody,
  deskPersonParam,
  DeskSnapshot,
  offlineItemBody,
  offlineItemsQuery,
  offlineItemParam,
  offlineResolveBody,
  OfflineItem,
  OfflineItemResult,
  OfflineItems,
  MyDeskPins,
  MyDeskPin,
  DeskState,
  DeskTouch,
  DeskClosed,
  DeskOverview,
  DeskPinReset,
  DeskEnded,
};
