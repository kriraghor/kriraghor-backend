'use strict';

/**
 * M24 Gym Management, prompts 1, 2 and 3 (migrations 20261113000002, 20261114000003 and 20261115000001, §7.2): the gym's own books. Owned by the
 * gym-manage module (gym group, ADR-007); index.js re-exports them. Encrypted columns (`*Enc`) hold
 * common/crypto.encrypt envelopes and never leave the module undecrypted except through its views.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');
const { toPoisha } = require('../common/money');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const req = (type) => ({ type, allowNull: false });
const by = { createdBy: DataTypes.UUID, updatedBy: DataTypes.UUID };
const poisha = (field, { allowNull = false, dflt } = {}) => ({
  type: DataTypes.BIGINT,
  allowNull,
  ...(dflt === undefined ? {} : { defaultValue: dflt }),
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : toPoisha(v);
  },
});
const enumOf = (values, extra = {}) => ({ type: DataTypes.ENUM(...values), allowNull: false, ...extra });
/** A signed BIGINT poisha amount (invoice discount lines are negative). */
const signed = (field) => ({
  type: DataTypes.BIGINT,
  allowNull: false,
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : Number(v);
  },
});
const TIERS = ['free', 'basic', 'standard', 'pro'];

class GymManageSettings extends Model {}
GymManageSettings.init(
  {
    gymId: { type: DataTypes.UUID, primaryKey: true },
    ownerId: req(DataTypes.UUID),
    shortCode: req(DataTypes.STRING(6)),
    memberSeq: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    receiptYear: req(DataTypes.SMALLINT),
    receiptSeq: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    tin: DataTypes.STRING(20),
    bin: DataTypes.STRING(20),
    receiptFooter: DataTypes.STRING(200),
    entryPolicy: enumOf(['allow', 'warn', 'block'], { defaultValue: 'warn' }),
    absentAlertDays: DataTypes.SMALLINT,
    joinRequestsOpen: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    remindersOff: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    smsKinds: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    importConsentUntil: DataTypes.DATE(3),
    // M27-FR-28: VAT on member receipts, off by default; the owner enters the rate.
    vatEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    vatBps: DataTypes.INTEGER,
    // Trial visits (9 Nov 2026): off by default; null cap = the platform default.
    visitsOpen: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // M24-FR-121: members may renew by themselves (the gym can switch it off).
    selfRenewOpen: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    visitDailyCap: DataTypes.SMALLINT,
    visitPerPerson: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1 },
    visitNote: DataTypes.STRING(300),
    updatedBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymManageSettings', tableName: 'gym_manage_settings' }
);

class GymMember extends Model {}
GymMember.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    ownerId: req(DataTypes.UUID),
    memberCode: req(DataTypes.STRING(12)),
    displayName: req(DataTypes.STRING(80)),
    phoneEnc: req(DataTypes.STRING(255)),
    phoneHash: req(DataTypes.CHAR(64)),
    phoneLast4: req(DataTypes.CHAR(4)),
    emailEnc: DataTypes.STRING(255),
    gender: DataTypes.ENUM('male', 'female', 'other'),
    birthDate: DataTypes.DATEONLY,
    photoKey: DataTypes.STRING(300),
    emergencyContactEnc: DataTypes.STRING(500),
    healthNoteEnc: DataTypes.TEXT,
    healthNoteBy: DataTypes.ENUM('member', 'staff'),
    healthNoteAt: DataTypes.DATE(3),
    // M27-FR-30 (round 1): blood group, height and weight, conditions and injuries (encrypted).
    bloodGroup: DataTypes.ENUM('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'),
    heightCm: DataTypes.SMALLINT,
    weightKg: { type: DataTypes.DECIMAL(5, 1), get() { const v = this.getDataValue('weightKg'); return v === null || v === undefined ? null : Number(v); } },
    medicalEnc: DataTypes.TEXT,
    source: enumOf(['desk', 'platform', 'import', 'pass']),
    status: enumOf(['new', 'active', 'frozen', 'expired', 'left', 'removed'], { defaultValue: 'new' }),
    userId: DataTypes.UUID,
    linkedAt: DataTypes.DATE(3),
    unlinkedAt: DataTypes.DATE(3),
    trainerBusinessMemberId: DataTypes.UUID,
    joinedOn: req(DataTypes.DATEONLY),
    leftOn: DataTypes.DATEONLY,
    leftReason: DataTypes.ENUM('price', 'moved', 'injury', 'other_gym', 'schedule', 'unknown', 'other'),
    removedAt: DataTypes.DATE(3),
    removedReason: DataTypes.STRING(300),
    importId: DataTypes.UUID,
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    ...by,
  },
  { sequelize, modelName: 'GymMember', tableName: 'gym_members' }
);

class GymLinkRequest extends Model {}
GymLinkRequest.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    ownerId: req(DataTypes.UUID),
    direction: enumOf(['gym_invite', 'join_request']),
    memberId: DataTypes.UUID,
    userId: DataTypes.UUID,
    phoneHash: DataTypes.CHAR(64),
    packageId: DataTypes.UUID,
    note: DataTypes.STRING(300),
    status: enumOf(['pending', 'accepted', 'declined', 'expired', 'cancelled'], { defaultValue: 'pending' }),
    expiresAt: req(DataTypes.DATE(3)),
    decidedAt: DataTypes.DATE(3),
    decidedBy: DataTypes.UUID,
    createdBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymLinkRequest', tableName: 'gym_link_requests' }
);

class GymMembership extends Model {}
GymMembership.init(
  {
    id,
    memberId: req(DataTypes.UUID),
    gymId: req(DataTypes.UUID),
    packageId: req(DataTypes.UUID),
    packageKind: req(DataTypes.STRING(9)),
    title: req(DataTypes.STRING(80)),
    days: req(DataTypes.SMALLINT),
    pricePoisha: poisha('pricePoisha'),
    admissionFeePoisha: poisha('admissionFeePoisha', { dflt: 0 }),
    discountPoisha: poisha('discountPoisha', { dflt: 0 }),
    discountReason: DataTypes.STRING(200),
    visitLimit: DataTypes.SMALLINT,
    origin: enumOf(['new', 'renewal', 'change', 'rejoin', 'import']),
    // M24-FR-126: made at the desk, or by the member in the app.
    createdVia: enumOf(['desk', 'member'], { defaultValue: 'desk' }),
    previousId: DataTypes.UUID,
    startsOn: req(DataTypes.DATEONLY),
    endsOn: req(DataTypes.DATEONLY),
    frozenDays: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    freezesCount: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    status: enumOf(['upcoming', 'active', 'frozen', 'expired', 'cancelled', 'changed']),
    cancelledAt: DataTypes.DATE(3),
    cancelReason: DataTypes.STRING(200),
    ...by,
  },
  { sequelize, modelName: 'GymMembership', tableName: 'gym_memberships' }
);

class GymFreeze extends Model {}
GymFreeze.init(
  {
    id,
    membershipId: req(DataTypes.UUID),
    fromOn: req(DataTypes.DATEONLY),
    toOn: req(DataTypes.DATEONLY),
    endedEarlyOn: DataTypes.DATEONLY,
    reason: req(DataTypes.STRING(200)),
    status: enumOf(['scheduled', 'active', 'done', 'cancelled'], { defaultValue: 'scheduled' }),
    createdBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymFreeze', tableName: 'gym_freezes' }
);

class GymDue extends Model {}
GymDue.init(
  {
    id,
    membershipId: req(DataTypes.UUID),
    memberId: req(DataTypes.UUID),
    gymId: req(DataTypes.UUID),
    amountPoisha: poisha('amountPoisha'),
    paidPoisha: poisha('paidPoisha', { dflt: 0 }),
    waivedPoisha: poisha('waivedPoisha', { dflt: 0 }),
    dueOn: req(DataTypes.DATEONLY),
    status: enumOf(['unpaid', 'partial', 'paid', 'waived', 'void'], { defaultValue: 'unpaid' }),
    overdueAt: DataTypes.DATE(3),
    waiveReason: DataTypes.STRING(300),
    voidedAt: DataTypes.DATE(3),
    voidReason: DataTypes.STRING(40),
  },
  { sequelize, modelName: 'GymDue', tableName: 'gym_dues' }
);

class GymFeePayment extends Model {}
GymFeePayment.init(
  {
    id,
    dueId: req(DataTypes.UUID),
    memberId: req(DataTypes.UUID),
    gymId: req(DataTypes.UUID),
    ownerId: req(DataTypes.UUID),
    amountPoisha: {
      type: DataTypes.BIGINT,
      allowNull: false,
      get() {
        const v = this.getDataValue('amountPoisha');
        return v === null || v === undefined ? null : Number(v);
      },
    },
    method: enumOf(['cash', 'owner_bkash', 'owner_nagad', 'card_counter', 'other', 'online', 'opening']),
    paidOn: req(DataTypes.DATEONLY),
    receiptNo: DataTypes.STRING(24),
    reversesId: DataTypes.UUID,
    reason: DataTypes.STRING(300),
    note: DataTypes.STRING(300),
    receivedBy: DataTypes.UUID,
    payerUserId: DataTypes.UUID,
    linkId: DataTypes.UUID,
    paymentId: DataTypes.UUID,
    providerChargeBps: DataTypes.INTEGER,
    providerChargePoisha: poisha('providerChargePoisha', { allowNull: true }),
    providerSettingVersion: DataTypes.INTEGER,
    importId: DataTypes.UUID,
    // M27-FR-28: the VAT rate this payment was recorded at (snapshot; null = no VAT).
    vatBps: DataTypes.INTEGER,
  },
  { sequelize, modelName: 'GymFeePayment', tableName: 'gym_fee_payments', updatedAt: false }
);

class GymAttendance extends Model {}
GymAttendance.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    memberId: req(DataTypes.UUID),
    localDate: req(DataTypes.DATEONLY),
    checkedInAt: req(DataTypes.DATE(3)),
    method: enumOf(['desk', 'member_qr', 'entrance_qr', 'pass']),
    counted: req(DataTypes.BOOLEAN),
    decision: enumOf(['allow', 'warn', 'override']),
    reasons: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    overrideReason: DataTypes.STRING(200),
    byUser: DataTypes.UUID,
    passRedemptionId: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymAttendance', tableName: 'gym_attendance', updatedAt: false }
);

/** Trial visits (9 Nov 2026): a free visit a signed-in person books before joining; never deleted. */
/** A DECIMAL(…, 1) measurement read as a number (Postgres returns DECIMAL as text). */
const measure = (field) => ({
  type: DataTypes.DECIMAL(4, 1),
  allowNull: true,
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : Number(v);
  },
});

/**
 * M24 §20 (FR-128): a member's measurements on a date. One live entry per member and date; a replaced or
 * removed one is voided, never deleted. Seen by the member, the owner and the plan writers only.
 */
class GymBodyEntry extends Model {}
GymBodyEntry.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    memberId: req(DataTypes.UUID),
    measuredOn: req(DataTypes.DATEONLY),
    weightKg: measure('weightKg'),
    bodyFatPct: measure('bodyFatPct'),
    chestCm: measure('chestCm'),
    waistCm: measure('waistCm'),
    hipsCm: measure('hipsCm'),
    armCm: measure('armCm'),
    thighCm: measure('thighCm'),
    byUser: req(DataTypes.UUID),
    byRole: enumOf(['member', 'staff']),
    voidedAt: DataTypes.DATE(3),
    voidedBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymBodyEntry', tableName: 'gym_body_entries', updatedAt: false }
);

/** M24 §21 (ADR-010): a person's own desk PIN at a gym. Only a hash is kept; wrong tries are counted here. */
class GymDeskPin extends Model {}
GymDeskPin.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    userId: req(DataTypes.UUID),
    pinHash: DataTypes.STRING(200),
    status: enumOf(['active', 'cleared'], { defaultValue: 'active' }),
    failedCount: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    lockouts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    lockedUntil: DataTypes.DATE(3),
    setAt: req(DataTypes.DATE(3)),
    clearedAt: DataTypes.DATE(3),
    clearedBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymDeskPin', tableName: 'gym_desk_pins' }
);

/** M24 §21: a device in desk mode, bound to the sign-in's session family. One open row per family. */
class GymDeskSession extends Model {}
GymDeskSession.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    ownerId: req(DataTypes.UUID),
    openedBy: req(DataTypes.UUID),
    familyId: req(DataTypes.UUID),
    openedSessionId: req(DataTypes.UUID),
    status: enumOf(['open', 'closed'], { defaultValue: 'open' }),
    deviceFailCount: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    deviceLockedUntil: DataTypes.DATE(3),
    openedAt: req(DataTypes.DATE(3)),
    closedAt: DataTypes.DATE(3),
    closedBy: DataTypes.UUID,
    closeReason: { type: DataTypes.ENUM('ended', 'ended_by_owner', 'signed_out', 'opener_left'), allowNull: true },
  },
  { sequelize, modelName: 'GymDeskSession', tableName: 'gym_desk_sessions' }
);

/** M24 §21: who unlocked a desk and until when. One live row per desk session; never deleted. */
class GymDeskUnlock extends Model {}
GymDeskUnlock.init(
  {
    id,
    deskSessionId: req(DataTypes.UUID),
    gymId: req(DataTypes.UUID),
    userId: req(DataTypes.UUID),
    unlockedAt: req(DataTypes.DATE(3)),
    lastTouchAt: req(DataTypes.DATE(3)),
    expiresAt: req(DataTypes.DATE(3)),
    endedAt: DataTypes.DATE(3),
    endReason: { type: DataTypes.ENUM('locked', 'idle', 'switched', 'closed', 'pin_reset', 'removed'), allowNull: true },
  },
  { sequelize, modelName: 'GymDeskUnlock', tableName: 'gym_desk_unlocks', updatedAt: false }
);

class GymVisit extends Model {}
GymVisit.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    userId: req(DataTypes.UUID),
    visitDate: req(DataTypes.DATEONLY),
    arriveAt: req(DataTypes.STRING(5)),
    status: enumOf(['booked', 'attended', 'cancelled', 'no_show'], { defaultValue: 'booked' }),
    code: req(DataTypes.STRING(6)),
    qrNonce: req(DataTypes.STRING(32)),
    cancelBy: { type: DataTypes.ENUM('guest', 'gym'), allowNull: true },
    cancelReason: DataTypes.STRING(300),
    cancelledAt: DataTypes.DATE(3),
    attendedAt: DataTypes.DATE(3),
    attendedBy: DataTypes.UUID,
    memberId: DataTypes.UUID,
    convertedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'GymVisit', tableName: 'gym_visits' }
);

/** M27-FR-40: a visit's check-out (append-only), by the desk, a second entrance scan or the auto-close job. */
class GymAttendanceExit extends Model {}
GymAttendanceExit.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    memberId: req(DataTypes.UUID),
    attendanceId: req(DataTypes.UUID),
    checkedOutAt: req(DataTypes.DATE(3)),
    method: enumOf(['desk', 'entrance_qr', 'auto']),
    visitMinutes: DataTypes.INTEGER,
    byUser: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymAttendanceExit', tableName: 'gym_attendance_exits', updatedAt: false }
);

class GymMemberNote extends Model {}
GymMemberNote.init(
  { id, memberId: req(DataTypes.UUID), gymId: req(DataTypes.UUID), body: req(DataTypes.STRING(2000)), byUser: req(DataTypes.UUID) },
  { sequelize, modelName: 'GymMemberNote', tableName: 'gym_member_notes', updatedAt: false }
);

class GymImport extends Model {}
GymImport.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    ownerId: req(DataTypes.UUID),
    fileKey: DataTypes.STRING(300),
    fileName: req(DataTypes.STRING(200)),
    fileSha256: req(DataTypes.CHAR(64)),
    fileBytes: req(DataTypes.INTEGER),
    rowsTotal: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    rowsOk: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    rowsFailed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    report: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    status: enumOf(['previewed', 'applied', 'undone', 'discarded'], { defaultValue: 'previewed' }),
    uploadedBy: req(DataTypes.UUID),
    uploadedAs: enumOf(['owner', 'staff']),
    appliedAt: DataTypes.DATE(3),
    appliedBy: DataTypes.UUID,
    undoUntil: DataTypes.DATE(3),
    undoneAt: DataTypes.DATE(3),
    invitesSentAt: DataTypes.DATE(3),
    filePurgedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'GymImport', tableName: 'gym_imports' }
);

class GymOwnerSubscription extends Model {}
GymOwnerSubscription.init(
  {
    id,
    ownerId: req(DataTypes.UUID),
    chosenTier: enumOf(TIERS, { defaultValue: 'free' }),
    monthMaxTier: enumOf(TIERS, { defaultValue: 'free' }),
    monthOf: req(DataTypes.DATEONLY),
    status: enumOf(['active', 'past_due', 'restricted', 'closed'], { defaultValue: 'active' }),
    startedOn: req(DataTypes.DATEONLY),
    paidTierSince: DataTypes.DATEONLY,
    foundingPartner: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    foundingNo: DataTypes.SMALLINT,
    foundingSetBy: DataTypes.UUID,
    foundingSetAt: DataTypes.DATE(3),
    pastDueAt: DataTypes.DATE(3),
    restrictedAt: DataTypes.DATE(3),
    closedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'GymOwnerSubscription', tableName: 'gym_owner_subscriptions' }
);

// ---------------------------------------------------------------- prompt 2 (migration 20261114000003)

class GymPaymentLink extends Model {}
GymPaymentLink.init(
  {
    id,
    dueId: req(DataTypes.UUID),
    memberId: req(DataTypes.UUID),
    gymId: req(DataTypes.UUID),
    ownerId: req(DataTypes.UUID),
    amountPoisha: poisha('amountPoisha'),
    tokenNonce: req(DataTypes.STRING(24)),
    // M24 prompt 3b: the short pay link in an SMS (gym.kriraghor.com/p/<code>).
    shortCode: DataTypes.STRING(10),
    origin: enumOf(['staff', 'member']),
    channels: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    status: enumOf(['open', 'paid', 'expired', 'cancelled'], { defaultValue: 'open' }),
    expiresAt: req(DataTypes.DATE(3)),
    paymentId: DataTypes.UUID,
    paidAt: DataTypes.DATE(3),
    releaseAt: DataTypes.DATE(3),
    releasedAt: DataTypes.DATE(3),
    refundedPoisha: poisha('refundedPoisha', { dflt: 0 }),
    createdBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymPaymentLink', tableName: 'gym_payment_links' }
);

class GymReminder extends Model {}
GymReminder.init(
  {
    id,
    ownerId: req(DataTypes.UUID),
    gymId: DataTypes.UUID,
    kind: enumOf(['renewal_due', 'ends_today', 'overdue', 'expired', 'receipt', 'pay_link', 'plan', 'morning', 'monthly', 'tier_notice', 'invoice_due', 'sms_low', 'sms_empty', 'guests_today', 'visit_reminder']),
    subjectType: enumOf(['membership', 'due', 'fee_payment', 'link', 'assignment', 'gym', 'owner', 'invoice', 'visit']),
    subjectId: req(DataTypes.UUID),
    offsetKey: req(DataTypes.STRING(20)),
    memberId: DataTypes.UUID,
    channels: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    smsBillingRef: DataTypes.UUID,
    status: enumOf(['published', 'skipped']),
    skipReason: DataTypes.STRING(12),
  },
  { sequelize, modelName: 'GymReminder', tableName: 'gym_reminders', updatedAt: false }
);

/** M24 prompt 3b (M24-FR-96): the owner's SMS add-on; one live row per owner and add-on. */
class GymOwnerAddon extends Model {}
GymOwnerAddon.init(
  {
    id,
    subscriptionId: req(DataTypes.UUID),
    ownerId: req(DataTypes.UUID),
    addon: enumOf(['sms']),
    status: enumOf(['active', 'paused', 'ended']),
    pricePoisha: poisha('pricePoisha'),
    startedAt: req(DataTypes.DATE(3)),
    pausedAt: DataTypes.DATE(3),
    endedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'GymOwnerAddon', tableName: 'gym_owner_addons' }
);

/** M24 prompt 3b (§6.7): the owner's SMS units, append-only; balance = Σ units. */
class GymSmsEntry extends Model {}
GymSmsEntry.init(
  {
    id,
    ownerId: req(DataTypes.UUID),
    kind: enumOf(['grant', 'purchase', 'reserve', 'settle', 'expire', 'adjust']),
    units: req(DataTypes.INTEGER),
    expiresOn: DataTypes.DATEONLY,
    billingRef: DataTypes.UUID,
    invoiceId: DataTypes.UUID,
    gymId: DataTypes.UUID,
    reminderId: DataTypes.UUID,
    note: DataTypes.STRING(200),
    createdBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymSmsEntry', tableName: 'gym_sms_entries', updatedAt: false }
);

class GymActiveMemberCount extends Model {}
GymActiveMemberCount.init(
  {
    ownerId: { type: DataTypes.UUID, primaryKey: true },
    localDate: { type: DataTypes.DATEONLY, primaryKey: true },
    activeCount: req(DataTypes.INTEGER),
    gymsCount: req(DataTypes.INTEGER),
    chosenTier: enumOf(TIERS),
  },
  { sequelize, modelName: 'GymActiveMemberCount', tableName: 'gym_active_member_counts' }
);

class GymSubscriptionInvoice extends Model {}
GymSubscriptionInvoice.init(
  {
    id,
    number: req(DataTypes.STRING(24)),
    ownerId: req(DataTypes.UUID),
    subscriptionId: req(DataTypes.UUID),
    kind: enumOf(['monthly', 'sms_bundle']),
    periodStart: DataTypes.DATEONLY,
    periodEnd: DataTypes.DATEONLY,
    billedTier: { type: DataTypes.ENUM(...TIERS), allowNull: true },
    peakActive: DataTypes.INTEGER,
    subtotalPoisha: poisha('subtotalPoisha'),
    vatPoisha: poisha('vatPoisha', { dflt: 0 }),
    totalPoisha: poisha('totalPoisha'),
    status: enumOf(['issued', 'overdue', 'paid', 'void'], { defaultValue: 'issued' }),
    issuedAt: req(DataTypes.DATE(3)),
    dueAt: req(DataTypes.DATE(3)),
    paidAt: DataTypes.DATE(3),
    paymentId: DataTypes.UUID,
    voidedAt: DataTypes.DATE(3),
    voidedBy: DataTypes.UUID,
    voidReason: DataTypes.STRING(300),
    settingsSnapshot: { type: DataTypes.JSONB, allowNull: false },
  },
  { sequelize, modelName: 'GymSubscriptionInvoice', tableName: 'gym_subscription_invoices' }
);

class GymSubscriptionInvoiceLine extends Model {}
GymSubscriptionInvoiceLine.init(
  {
    id,
    invoiceId: req(DataTypes.UUID),
    kind: enumOf(['tier', 'proration', 'founding_free', 'founding_discount', 'referral', 'sms_addon', 'sms_bundle', 'vat', 'adjustment']),
    descriptionEn: req(DataTypes.STRING(200)),
    descriptionBn: req(DataTypes.STRING(200)),
    quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    unitPoisha: signed('unitPoisha'),
    amountPoisha: signed('amountPoisha'),
    refType: DataTypes.STRING(10),
    refId: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymSubscriptionInvoiceLine', tableName: 'gym_subscription_invoice_lines', updatedAt: false }
);

class GymFeeOverride extends Model {}
GymFeeOverride.init(
  {
    id,
    scopeType: enumOf(['owner', 'gym']),
    scopeId: req(DataTypes.UUID),
    ownerId: req(DataTypes.UUID),
    key: enumOf(['fees.gym_referral_poisha', 'fees.gym_pct']),
    value: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      get() {
        const v = this.getDataValue('value');
        return v === null || v === undefined ? null : Number(v);
      },
    },
    reason: req(DataTypes.STRING(300)),
    validFrom: req(DataTypes.DATE(3)),
    validTo: DataTypes.DATE(3),
    status: enumOf(['active', 'ended'], { defaultValue: 'active' }),
    setBy: req(DataTypes.UUID),
    endedBy: DataTypes.UUID,
    endedAt: DataTypes.DATE(3),
    endReason: DataTypes.STRING(300),
  },
  { sequelize, modelName: 'GymFeeOverride', tableName: 'gym_fee_overrides' }
);

class GymReferral extends Model {}
GymReferral.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    ownerId: req(DataTypes.UUID),
    memberId: req(DataTypes.UUID),
    linkRequestId: DataTypes.UUID,
    firstFeePaymentId: req(DataTypes.UUID),
    amountPoisha: poisha('amountPoisha'),
    source: enumOf(['setting', 'owner_override', 'gym_override']),
    overrideId: DataTypes.UUID,
    settingVersion: DataTypes.INTEGER,
    status: enumOf(['pending', 'invoiced', 'void'], { defaultValue: 'pending' }),
    invoiceId: DataTypes.UUID,
    voidedAt: DataTypes.DATE(3),
    voidReason: DataTypes.STRING(40),
  },
  { sequelize, modelName: 'GymReferral', tableName: 'gym_referrals' }
);

// ---------------- prompt 3: workout plans and diet charts (§5.8, §6.10)
class GymPlan extends Model {}
GymPlan.init(
  {
    id,
    gymId: DataTypes.UUID,
    memberUserId: DataTypes.UUID,
    kind: enumOf(['workout', 'diet']),
    title: req(DataTypes.STRING(120)),
    isTemplate: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    source: enumOf(['gym', 'ai', 'self'], { defaultValue: 'gym' }),
    currentVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    status: enumOf(['active', 'retired'], { defaultValue: 'active' }),
    retiredAt: DataTypes.DATE(3),
    ...by,
  },
  { sequelize, modelName: 'GymPlan', tableName: 'gym_plans' }
);

class GymPlanVersion extends Model {}
GymPlanVersion.init(
  { id, planId: req(DataTypes.UUID), version: req(DataTypes.INTEGER), content: req(DataTypes.JSONB), contentBytes: req(DataTypes.INTEGER), createdBy: req(DataTypes.UUID) },
  { sequelize, modelName: 'GymPlanVersion', tableName: 'gym_plan_versions', updatedAt: false }
);

class GymPlanAssignment extends Model {}
GymPlanAssignment.init(
  {
    id,
    planId: req(DataTypes.UUID),
    planVersionId: req(DataTypes.UUID),
    kind: enumOf(['workout', 'diet']),
    memberId: req(DataTypes.UUID),
    gymId: req(DataTypes.UUID),
    startsOn: req(DataTypes.DATEONLY),
    endsOn: DataTypes.DATEONLY,
    status: enumOf(['active', 'replaced', 'ended'], { defaultValue: 'active' }),
    assignedBy: req(DataTypes.UUID),
    endedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'GymPlanAssignment', tableName: 'gym_plan_assignments' }
);

class GymPlanLog extends Model {}
GymPlanLog.init(
  {
    id,
    assignmentId: req(DataTypes.UUID),
    planVersionId: req(DataTypes.UUID),
    localDate: req(DataTypes.DATEONLY),
    itemRef: req(DataTypes.STRING(20)),
    done: req(DataTypes.BOOLEAN),
    note: DataTypes.STRING(300),
    byUser: req(DataTypes.UUID),
  },
  { sequelize, modelName: 'GymPlanLog', tableName: 'gym_plan_logs', updatedAt: false }
);

module.exports = {
  GymOwnerAddon,
  GymSmsEntry,
  GymManageSettings,
  GymVisit,
  GymBodyEntry,
  GymDeskPin,
  GymDeskSession,
  GymDeskUnlock,
  GymMember,
  GymLinkRequest,
  GymMembership,
  GymFreeze,
  GymDue,
  GymFeePayment,
  GymAttendance, GymAttendanceExit,
  GymMemberNote,
  GymImport,
  GymOwnerSubscription,
  GymPaymentLink,
  GymReminder,
  GymActiveMemberCount,
  GymSubscriptionInvoice,
  GymSubscriptionInvoiceLine,
  GymFeeOverride,
  GymReferral,
  GymPlan,
  GymPlanVersion,
  GymPlanAssignment,
  GymPlanLog,
};
