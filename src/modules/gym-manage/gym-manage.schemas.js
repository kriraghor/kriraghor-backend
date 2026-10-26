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
// ---------------- prompt 2 (online money, reminders and billing)
const LINK_CHANNELS = ['in_app', 'email'];
const LINK_STATUSES = ['open', 'paid', 'expired', 'cancelled'];
const INVOICE_STATUSES = ['issued', 'overdue', 'paid', 'void'];
const SUB_STATUSES = ['active', 'past_due', 'restricted', 'closed'];
const OVERRIDE_KEYS = ['fees.gym_referral_poisha', 'fees.gym_pct'];
const FEE_SOURCES = ['setting', 'owner_override', 'gym_override'];
const linkParam = z.object({ gymId: id, linkId: id });
const meDueParam = z.object({ dueId: id });
const invoiceParam = z.object({ invoiceId: id });
const ownerParam = z.object({ ownerId: id });
const overrideParam = z.object({ overrideId: id });
const linkBody = z.object({
  amountPoisha: z.number().int().positive().optional().meta({ description: 'Up to the outstanding; default all of it (M24-FR-40)' }),
  channels: z.array(z.enum(LINK_CHANNELS)).max(2).optional().meta({ description: 'Send the link in-app (and by push) and by email; default both. [] only shows the QR. SMS needs the add-on (prompt 3b)' }),
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
    offsets: z.object({ remindBeforeDays: z.number().int(), overdueRemindDays: z.array(z.number().int()), morningSummaryTime: z.string() }),
    sms: z.object({ available: z.boolean().meta({ description: 'The SMS add-on (prompt 3b); false in prompt 2' }), kinds: z.array(z.string()) }),
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
    smsAddon: z.object({ available: z.boolean(), status: z.null(), balance: z.number().int() }),
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
    smsAddon: z.object({ available: z.boolean(), status: z.null(), balance: z.number().int() }).meta({ description: 'The SMS add-on (prompt 3b)' }),
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
        onlineFees: z.boolean().meta({ description: 'The gym takes fees online now (owner documents, plan, not restricted; M24-FR-41)' }),
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
  linkParam,
  meDueParam,
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
};
