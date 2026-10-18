'use strict';

/**
 * M14 lite and M22 organiser SaaS (migrations 20261102000002 and 20261102000003): organisations and
 * their members (owned by M14), and M22's contracts, invoices, invoice lines, prize funds and
 * branding. index.js re-exports them.
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

class Organisation extends Model {}
Organisation.init(
  {
    id,
    kind: { type: DataTypes.ENUM('esports'), allowNull: false, defaultValue: 'esports' },
    ownerUserId: req(DataTypes.UUID),
    name: req(DataTypes.STRING(120)),
    slug: req(DataTypes.STRING(140)),
    areaId: DataTypes.UUID,
    about: DataTypes.STRING(1000),
    contactEmail: DataTypes.STRING(160),
    status: { type: DataTypes.ENUM('draft', 'pending_review', 'changes_requested', 'verified', 'rejected', 'suspended'), allowNull: false, defaultValue: 'draft' },
    currentSubmissionId: DataTypes.UUID,
    reviewReasonCode: DataTypes.STRING(40),
    reviewReasonText: DataTypes.STRING(500),
    verifiedAt: DataTypes.DATE(3),
    statusChangedAt: DataTypes.DATE(3),
    ...by,
  },
  { sequelize, modelName: 'Organisation', tableName: 'organisations' }
);

class OrganisationMember extends Model {}
OrganisationMember.init(
  {
    id,
    organisationId: req(DataTypes.UUID),
    userId: req(DataTypes.UUID),
    role: req(DataTypes.ENUM('owner', 'admin', 'staff')),
    status: { type: DataTypes.ENUM('active', 'removed'), allowNull: false, defaultValue: 'active' },
    addedBy: DataTypes.UUID,
    removedBy: DataTypes.UUID,
    removedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'OrganisationMember', tableName: 'organisation_members' }
);

class OrganiserContract extends Model {}
OrganiserContract.init(
  {
    id,
    organisationId: req(DataTypes.UUID),
    model: req(DataTypes.ENUM('percentage', 'flat')),
    pct: {
      type: DataTypes.DECIMAL(5, 2),
      get() {
        const v = this.getDataValue('pct');
        return v === null || v === undefined ? null : Number(v);
      },
    },
    flatFeePoisha: poisha('flatFeePoisha', { allowNull: true }),
    billingCycle: req(DataTypes.ENUM('monthly', 'quarterly', 'per_tournament')),
    startsOn: req(DataTypes.DATEONLY),
    endsOn: DataTypes.DATEONLY,
    status: { type: DataTypes.ENUM('draft', 'active', 'suspended', 'ended'), allowNull: false, defaultValue: 'draft' },
    signedDocumentKey: DataTypes.STRING(255),
    notes: DataTypes.STRING(500),
    activatedAt: DataTypes.DATE(3),
    suspendedAt: DataTypes.DATE(3),
    suspendReason: DataTypes.STRING(300),
    endedAt: DataTypes.DATE(3),
    endReason: DataTypes.STRING(300),
    expiryNotifiedAt: DataTypes.DATE(3),
    ...by,
  },
  { sequelize, modelName: 'OrganiserContract', tableName: 'organiser_contracts' }
);

class OrganiserInvoice extends Model {}
OrganiserInvoice.init(
  {
    id,
    number: req(DataTypes.STRING(24)),
    organisationId: req(DataTypes.UUID),
    contractId: req(DataTypes.UUID),
    periodStart: req(DataTypes.DATEONLY),
    periodEnd: req(DataTypes.DATEONLY),
    subtotalPoisha: poisha('subtotalPoisha', { dflt: 0 }),
    vatPoisha: poisha('vatPoisha', { dflt: 0 }),
    totalPoisha: poisha('totalPoisha', { dflt: 0 }),
    status: { type: DataTypes.ENUM('draft', 'issued', 'paid', 'overdue', 'voided'), allowNull: false, defaultValue: 'issued' },
    dueAt: DataTypes.DATE(3),
    paymentId: DataTypes.UUID,
    issuedAt: DataTypes.DATE(3),
    paidAt: DataTypes.DATE(3),
    overdueAt: DataTypes.DATE(3),
    voidedAt: DataTypes.DATE(3),
    voidReason: DataTypes.STRING(255),
    idempotencyKey: req(DataTypes.STRING(120)),
    ...by,
  },
  { sequelize, modelName: 'OrganiserInvoice', tableName: 'organiser_invoices' }
);

class OrganiserInvoiceLine extends Model {}
OrganiserInvoiceLine.init(
  {
    id,
    invoiceId: req(DataTypes.UUID),
    kind: req(DataTypes.ENUM('flat_fee', 'percentage_fee', 'adjustment')),
    tournamentId: DataTypes.UUID,
    description: req(DataTypes.STRING(200)),
    amountPoisha: {
      type: DataTypes.BIGINT,
      allowNull: false,
      get() {
        return Number(this.getDataValue('amountPoisha'));
      },
    },
    payable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { sequelize, modelName: 'OrganiserInvoiceLine', tableName: 'organiser_invoice_lines', updatedAt: false }
);

class OrganiserPrizeFund extends Model {}
OrganiserPrizeFund.init(
  {
    id,
    tournamentId: req(DataTypes.UUID),
    organisationId: req(DataTypes.UUID),
    requiredPoisha: poisha('requiredPoisha', { dflt: 0 }),
    depositedPoisha: poisha('depositedPoisha', { dflt: 0 }),
    paidPoisha: poisha('paidPoisha', { dflt: 0 }),
    returnedPoisha: poisha('returnedPoisha', { dflt: 0 }),
    status: { type: DataTypes.ENUM('pending', 'funded', 'consumed', 'returned'), allowNull: false, defaultValue: 'pending' },
    paymentIds: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    fundedAt: DataTypes.DATE(3),
    settledAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'OrganiserPrizeFund', tableName: 'organiser_prize_funds' }
);

class OrganisationBranding extends Model {}
OrganisationBranding.init(
  {
    organisationId: { type: DataTypes.UUID, primaryKey: true },
    subdomain: DataTypes.STRING(30),
    logoKey: DataTypes.STRING(255),
    primaryHex: { type: DataTypes.STRING(7), allowNull: false, defaultValue: '#0b7a4b' },
    accentHex: { type: DataTypes.STRING(7), allowNull: false, defaultValue: '#f2a33a' },
    taglineEn: DataTypes.STRING(120),
    taglineBn: DataTypes.STRING(120),
    status: { type: DataTypes.ENUM('draft', 'live', 'suspended'), allowNull: false, defaultValue: 'draft' },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    updatedBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'OrganisationBranding', tableName: 'organisation_branding' }
);

Organisation.hasMany(OrganisationMember, { as: 'members', foreignKey: 'organisationId' });
OrganisationMember.belongsTo(Organisation, { as: 'organisation', foreignKey: 'organisationId' });
OrganiserInvoice.hasMany(OrganiserInvoiceLine, { as: 'lines', foreignKey: 'invoiceId' });

module.exports = { Organisation, OrganisationMember, OrganiserContract, OrganiserInvoice, OrganiserInvoiceLine, OrganiserPrizeFund, OrganisationBranding };
