'use strict';

/**
 * M24 Gym Management, prompt 1 (migration 20261113000002, §7.2): the gym's own books. Owned by the
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

module.exports = { GymManageSettings, GymMember, GymLinkRequest, GymMembership, GymFreeze, GymDue, GymFeePayment, GymAttendance, GymMemberNote, GymImport, GymOwnerSubscription };
