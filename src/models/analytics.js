'use strict';

/**
 * M19 read-model tables (migration 20261026000002-create-analytics). The materialised views
 * (kpi_mv_*) are read with SQL in dashboards.service.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { toPoisha } = require('../common/money');

const req = (type) => ({ type, allowNull: false });
const poisha = (field) => ({
  type: DataTypes.BIGINT,
  allowNull: false,
  defaultValue: 0,
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? v : toPoisha(v);
  },
});
const opts = (tableName, modelName) => ({ sequelize, modelName, tableName, createdAt: false, updatedAt: false });

class KpiFactBooking extends Model {}
KpiFactBooking.init(
  {
    bookingId: { type: DataTypes.UUID, primaryKey: true },
    sourceVersion: { type: DataTypes.BIGINT, allowNull: false, get() { return Number(this.getDataValue('sourceVersion')); } },
    code: req(DataTypes.STRING(16)),
    ownerId: req(DataTypes.UUID),
    groundId: req(DataTypes.UUID),
    courtIds: req(DataTypes.ARRAY(DataTypes.UUID)),
    areaId: DataTypes.UUID,
    source: req(DataTypes.STRING(16)),
    status: req(DataTypes.STRING(30)),
    bookerUserId: DataTypes.UUID,
    bookerKey: req(DataTypes.STRING(80)),
    startAt: req(DataTypes.DATE(3)),
    endAt: req(DataTypes.DATE(3)),
    halfHours: req(DataTypes.SMALLINT),
    totalPoisha: poisha('totalPoisha'),
    onlinePoisha: poisha('onlinePoisha'),
    refundPoisha: poisha('refundPoisha'),
    retainedPoisha: poisha('retainedPoisha'),
    feePoisha: poisha('feePoisha'),
    earnedPoisha: poisha('earnedPoisha'),
    venueCollectedPoisha: poisha('venueCollectedPoisha'),
    confirmedAt: DataTypes.DATE(3),
    cancelledAt: DataTypes.DATE(3),
    updatedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  },
  opts('kpi_fact_booking', 'KpiFactBooking')
);

class KpiFactCourtDay extends Model {}
KpiFactCourtDay.init(
  {
    courtId: { type: DataTypes.UUID, primaryKey: true },
    day: { type: DataTypes.DATEONLY, primaryKey: true },
    ownerId: req(DataTypes.UUID),
    groundId: req(DataTypes.UUID),
    openHh: req(DataTypes.SMALLINT),
    bookedHh: req(DataTypes.SMALLINT),
    updatedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  },
  opts('kpi_fact_court_day', 'KpiFactCourtDay')
);

class KpiFactPayment extends Model {}
KpiFactPayment.init(
  {
    paymentId: { type: DataTypes.UUID, primaryKey: true },
    purpose: req(DataTypes.STRING(30)),
    vertical: req(DataTypes.STRING(20)),
    payerId: req(DataTypes.UUID),
    amountPoisha: poisha('amountPoisha'),
    refundedPoisha: poisha('refundedPoisha'),
    capturedAt: req(DataTypes.DATE(3)),
    updatedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  },
  opts('kpi_fact_payment', 'KpiFactPayment')
);

class KpiFactLedgerTxn extends Model {}
KpiFactLedgerTxn.init(
  {
    txnId: { type: DataTypes.UUID, primaryKey: true },
    postedAt: req(DataTypes.DATE(3)),
    kind: req(DataTypes.STRING(40)),
    vertical: req(DataTypes.STRING(20)),
    feeRevenuePoisha: poisha('feeRevenuePoisha'),
    feeReversalPoisha: poisha('feeReversalPoisha'),
  },
  opts('kpi_fact_ledger_txn', 'KpiFactLedgerTxn')
);

class KpiFactEsportsEntry extends Model {}
KpiFactEsportsEntry.init(
  {
    registrationId: { type: DataTypes.UUID, primaryKey: true },
    tournamentId: req(DataTypes.UUID),
    userId: req(DataTypes.UUID),
    confirmedAt: req(DataTypes.DATE(3)),
    paid: req(DataTypes.BOOLEAN),
  },
  opts('kpi_fact_esports_entry', 'KpiFactEsportsEntry')
);

class KpiFactEsportsTournament extends Model {}
KpiFactEsportsTournament.init(
  {
    tournamentId: { type: DataTypes.UUID, primaryKey: true },
    gameId: req(DataTypes.UUID),
    finalisedAt: req(DataTypes.DATE(3)),
    awards: req(DataTypes.INTEGER),
    paidPoisha: poisha('paidPoisha'),
    subsidyPoisha: poisha('subsidyPoisha'),
    revenuePoisha: poisha('revenuePoisha'),
  },
  opts('kpi_fact_esports_tournament', 'KpiFactEsportsTournament')
);

class KpiProcessedEvent extends Model {}
KpiProcessedEvent.init(
  {
    eventId: { type: DataTypes.UUID, primaryKey: true },
    consumer: { type: DataTypes.STRING(80), primaryKey: true },
    processedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  },
  opts('kpi_processed_events', 'KpiProcessedEvent')
);

class KpiDrift extends Model {}
KpiDrift.init(
  {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    runAt: req(DataTypes.DATE(3)),
    dataset: req(DataTypes.STRING(30)),
    recordId: req(DataTypes.STRING(64)),
    vertical: DataTypes.STRING(20),
    expectedPoisha: DataTypes.BIGINT,
    actualPoisha: DataTypes.BIGINT,
    note: DataTypes.STRING(200),
  },
  opts('kpi_drift', 'KpiDrift')
);

// ---- Round B2 (migration 20261110000001-create-business-kpis): shop and gym facts.
const version = { type: DataTypes.BIGINT, allowNull: false, get() { return Number(this.getDataValue('sourceVersion')); } };
const updatedAt = { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW };

class KpiFactSubOrder extends Model {}
KpiFactSubOrder.init(
  {
    subOrderId: { type: DataTypes.UUID, primaryKey: true },
    sourceVersion: version,
    code: req(DataTypes.STRING(24)),
    orderId: req(DataTypes.UUID),
    shopId: req(DataTypes.UUID),
    sellerId: req(DataTypes.UUID),
    buyerId: req(DataTypes.UUID),
    status: req(DataTypes.STRING(20)),
    units: req(DataTypes.INTEGER),
    itemsPoisha: poisha('itemsPoisha'),
    deliveryPoisha: poisha('deliveryPoisha'),
    commissionPoisha: poisha('commissionPoisha'),
    refundedPoisha: poisha('refundedPoisha'),
    placedAt: DataTypes.DATE(3),
    completedAt: DataTypes.DATE(3),
    cancelledAt: DataTypes.DATE(3),
    updatedAt,
  },
  opts('kpi_fact_sub_order', 'KpiFactSubOrder')
);

class KpiFactOrderLine extends Model {}
KpiFactOrderLine.init(
  {
    orderItemId: { type: DataTypes.UUID, primaryKey: true },
    subOrderId: req(DataTypes.UUID),
    shopId: req(DataTypes.UUID),
    sellerId: req(DataTypes.UUID),
    productId: req(DataTypes.UUID),
    categoryId: DataTypes.UUID,
    title: req(DataTypes.STRING(120)),
    status: req(DataTypes.STRING(20)),
    placedAt: DataTypes.DATE(3),
    qty: req(DataTypes.INTEGER),
    amountPoisha: poisha('amountPoisha'),
    updatedAt,
  },
  opts('kpi_fact_order_line', 'KpiFactOrderLine')
);

class KpiFactGymPass extends Model {}
KpiFactGymPass.init(
  {
    passId: { type: DataTypes.UUID, primaryKey: true },
    sourceVersion: version,
    code: req(DataTypes.STRING(20)),
    gymId: req(DataTypes.UUID),
    ownerId: req(DataTypes.UUID),
    packageId: req(DataTypes.UUID),
    kind: req(DataTypes.STRING(10)),
    title: req(DataTypes.STRING(80)),
    status: req(DataTypes.STRING(20)),
    pricePoisha: poisha('pricePoisha'),
    feePoisha: poisha('feePoisha'),
    refundedPoisha: poisha('refundedPoisha'),
    releasedPoisha: poisha('releasedPoisha'),
    paidAt: DataTypes.DATE(3),
    validFrom: req(DataTypes.DATEONLY),
    validTo: req(DataTypes.DATEONLY),
    firstRedeemedAt: DataTypes.DATE(3),
    admissions: req(DataTypes.INTEGER),
    updatedAt,
  },
  opts('kpi_fact_gym_pass', 'KpiFactGymPass')
);

class KpiFactGymAdmission extends Model {}
KpiFactGymAdmission.init(
  {
    redemptionId: { type: DataTypes.UUID, primaryKey: true },
    passId: req(DataTypes.UUID),
    gymId: req(DataTypes.UUID),
    ownerId: req(DataTypes.UUID),
    kind: req(DataTypes.STRING(10)),
    method: req(DataTypes.STRING(8)),
    redeemedAt: req(DataTypes.DATE(3)),
    updatedAt,
  },
  opts('kpi_fact_gym_admission', 'KpiFactGymAdmission')
);

module.exports = {
  KpiFactBooking,
  KpiFactCourtDay,
  KpiFactPayment,
  KpiFactLedgerTxn,
  KpiFactEsportsEntry,
  KpiFactEsportsTournament,
  KpiProcessedEvent,
  KpiDrift,
  KpiFactSubOrder,
  KpiFactOrderLine,
  KpiFactGymPass,
  KpiFactGymAdmission,
};
