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
const REQUEST_STATUSES = ['pending', 'accepted', 'declined', 'expired', 'cancelled'];
const IMPORT_STATUSES = ['previewed', 'applied', 'undone', 'discarded'];
const FEATURES = rules.FEATURES;

// ---------------- params
const gymParam = z.object({ gymId: id });
const memberParam = z.object({ gymId: id, memberId: id });
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
  notSeen: z.coerce.number().int().min(1).max(365).optional().meta({ description: 'Days without a counted check-in (members with a running membership)' }),
  packageId: id.optional(),
  linked: bool.optional(),
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
const meRequestsQuery = z.object({ status: z.enum(REQUEST_STATUSES).optional() });
const healthNoteBody = z.object({ text: nullable(z.string().max(500)) });

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
      leftOn: nullable(date),
      leftReason: nullable(z.enum(rules.LEFT_REASONS)),
      removedAt: nullable(dateTime),
      removedReason: nullable(z.string()),
      importId: nullable(id),
      version: z.number().int(),
      createdAt: dateTime,
      notesCount: z.number().int(),
    }),
    link: z.object({ linked: z.boolean(), linkedAt: nullable(dateTime), unlinkedAt: nullable(dateTime), pendingInvite: nullable(z.object({ id, expiresAt: dateTime, accountKnown: z.boolean() })) }),
    memberships: z.array(Membership),
    dues: z.array(Due),
    can: z.object({ edit: z.boolean(), collect: z.boolean(), adjust: z.boolean(), revealPhone: z.boolean(), remove: z.boolean() }),
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
const DeskSearch = z
  .object({
    items: z.array(DeskCard),
    pass: nullable(z.object({ passCode: z.string(), kind: z.enum(KINDS), title: z.string(), validFrom: date, validTo: date, status: z.string(), holder: z.object({ displayName: nullable(z.string()) }), method: z.enum(['qr', 'code']) })).meta({ description: 'An M20 pass (desk.admit); admit it with POST /me/gyms/{id}/redemptions' }),
  })
  .meta({ id: 'GymDeskSearch' });
const CheckinDay = z
  .object({
    date,
    counted: z.number().int(),
    items: z.array(z.object({ id, member: MemberSummary, checkedInAt: dateTime, method: z.enum(['desk', 'member_qr', 'entrance_qr', 'pass']), counted: z.boolean(), decision: z.enum(['allow', 'warn', 'override']), reasons: z.array(z.string()), by: nullable(z.object({ id, displayName: nullable(z.string()) })) })),
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
      notSeen: z.number().int(),
      notSeenDays: z.number().int(),
      requestsWaiting: z.number().int(),
      dueTodayCount: z.number().int(),
      overdueCount: z.number().int(),
      collectedTodayPoisha: poisha.optional().meta({ description: 'Owner and reports.view only' }),
      dueTodayPoisha: poisha.optional().meta({ description: 'Owner and reports.view only' }),
    }),
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
    importConsentUntil: nullable(dateTime),
    nextMemberCode: nullable(z.string()),
  })
  .meta({ id: 'GymManageSettings' });
const Tier = z.object({ key: z.enum(rules.TIERS), maxMembers: nullable(z.number().int()), pricePoisha: poisha, features: z.array(z.enum(FEATURES)), minGyms: z.number().int().optional() });
const Pricing = z.object({ currency: z.literal('BDT'), tiers: z.array(Tier), featureMinTiers: z.record(z.string(), z.enum(rules.TIERS)), activeWindowDays: z.number().int(), noticePct: z.number().int() }).meta({ id: 'GymPricing' });
const Billing = z
  .object({
    subscription: z.object({ id, chosenTier: z.enum(rules.TIERS), monthMaxTier: z.enum(rules.TIERS), monthOf: date, status: z.enum(['active', 'past_due', 'restricted', 'closed']), startedOn: date, foundingPartner: z.boolean() }),
    activeMembers: z.object({ today: z.number().int(), limit: nullable(z.number().int()), fitTier: z.enum(rules.TIERS), gymsWithMembers: z.number().int(), windowDays: z.number().int(), noticePct: z.number().int() }),
    features: z.record(z.enum(FEATURES), z.boolean()),
    tiers: z.array(Tier),
    gyms: z.array(z.object({ id, name: z.string(), listingStatus: z.string() })),
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
        onlineFees: z.boolean().meta({ description: 'Online fee payments (prompt 2); false in prompt 1' }),
        plans: z.null().meta({ description: 'Workout plans and diet charts (prompt 3)' }),
      })
    ),
  })
  .meta({ id: 'MyGymMemberships' });
const MyReceiptItem = z.object({ id, receiptNo: z.string(), amountPoisha: poisha, method: z.enum(PAY_METHODS), paidOn: date, url: z.string(), reversedOn: nullable(date), gym: GymRef.optional(), memberCode: z.string().optional() });
const MyMembership = z
  .object({
    member: z.object({ id, memberCode: z.string(), displayName: z.string(), status: z.enum(MEMBER_STATUSES), linked: z.boolean(), joinedOn: date, gym: GymRef, healthNote: nullable(z.string()).optional(), healthNoteAt: nullable(dateTime).optional() }),
    memberships: z.array(Membership),
    dues: z.array(Due),
    receipts: z.array(MyReceiptItem),
  })
  .meta({ id: 'MyGymMembership' });
const MyReceipts = z.object({ items: z.array(MyReceiptItem) }).meta({ id: 'MyGymReceipts' });
const CheckinToken = z.object({ memberId: id, gymId: id, token: z.string(), expiresAt: dateTime.meta({ description: 'Show a new token before this; the desk accepts the previous one for one more window' }), seconds: z.number().int() }).meta({ id: 'GymCheckinToken' });
const HealthNote = z.object({ memberId: id, healthNote: nullable(z.string()), healthNoteAt: nullable(dateTime) });

module.exports = {
  gymParam,
  memberParam,
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
  meRequestsQuery,
  healthNoteBody,
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
};
