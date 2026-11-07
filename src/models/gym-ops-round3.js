'use strict';

/**
 * M27 Gym operations, round 3a (migration 20261121000001), owned by the gym-ops module (gym group, ADR-007):
 * staff shifts and clock times (append-only), pay terms and the monthly payroll, the equipment register and
 * its log (append-only). index.js re-exports them.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const req = (type) => ({ type, allowNull: false });
const enumOf = (values, extra = {}) => ({ type: DataTypes.ENUM(...values), allowNull: false, ...extra });
const bigint = (name, allowNull = false) => ({
  type: DataTypes.BIGINT,
  allowNull,
  ...(allowNull ? {} : { defaultValue: 0 }),
  get() {
    const v = this.getDataValue(name);
    return v === null || v === undefined ? v : Number(v);
  },
});

const METHODS = ['cash', 'owner_bkash', 'owner_nagad', 'card_counter', 'bank', 'other'];
const ASSET_STATUS = ['working', 'needs_service', 'out_of_order', 'retired'];

class GymStaffShift extends Model {}
GymStaffShift.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    businessMemberId: req(DataTypes.UUID),
    dow: req(DataTypes.SMALLINT),
    startTime: req(DataTypes.STRING(5)),
    endTime: req(DataTypes.STRING(5)),
    status: enumOf(['active', 'retired'], { defaultValue: 'active' }),
    createdBy: req(DataTypes.UUID),
  },
  { sequelize, modelName: 'GymStaffShift', tableName: 'gym_staff_shifts' }
);

class GymStaffTime extends Model {}
GymStaffTime.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    businessMemberId: req(DataTypes.UUID),
    userId: req(DataTypes.UUID),
    kind: enumOf(['in', 'out']),
    at: req(DataTypes.DATE(3)),
    localDate: req(DataTypes.DATEONLY),
    method: enumOf(['desk', 'entrance_qr', 'auto']),
    byUser: DataTypes.UUID,
    note: DataTypes.STRING(200),
  },
  { sequelize, modelName: 'GymStaffTime', tableName: 'gym_staff_times', updatedAt: false }
);

class GymStaffPay extends Model {}
GymStaffPay.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    businessMemberId: req(DataTypes.UUID),
    basePoisha: bigint('basePoisha'),
    ptCommissionBps: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    salesCommissionBps: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    note: DataTypes.STRING(200),
    updatedBy: req(DataTypes.UUID),
  },
  { sequelize, modelName: 'GymStaffPay', tableName: 'gym_staff_pay' }
);

class GymPayrollRun extends Model {}
GymPayrollRun.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    period: req(DataTypes.STRING(7)),
    status: enumOf(['draft', 'approved', 'paid', 'void'], { defaultValue: 'draft' }),
    createdBy: req(DataTypes.UUID),
    approvedBy: DataTypes.UUID,
    approvedAt: DataTypes.DATE(3),
    paidAt: DataTypes.DATE(3),
    voidedBy: DataTypes.UUID,
    voidedAt: DataTypes.DATE(3),
    voidReason: DataTypes.STRING(300),
  },
  { sequelize, modelName: 'GymPayrollRun', tableName: 'gym_payroll_runs' }
);

class GymPayrollLine extends Model {}
GymPayrollLine.init(
  {
    id,
    runId: req(DataTypes.UUID),
    gymId: req(DataTypes.UUID),
    businessMemberId: req(DataTypes.UUID),
    userId: req(DataTypes.UUID),
    basePoisha: bigint('basePoisha'),
    ptBasePoisha: bigint('ptBasePoisha'),
    ptCommissionBps: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ptCommissionPoisha: bigint('ptCommissionPoisha'),
    salesBasePoisha: bigint('salesBasePoisha'),
    salesCommissionBps: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    salesCommissionPoisha: bigint('salesCommissionPoisha'),
    bonusPoisha: bigint('bonusPoisha'),
    deductionPoisha: bigint('deductionPoisha'),
    netPoisha: bigint('netPoisha'),
    workedMinutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lateCount: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    missedCount: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    note: DataTypes.STRING(200),
    status: enumOf(['unpaid', 'paid'], { defaultValue: 'unpaid' }),
    paidMethod: { type: DataTypes.ENUM(...METHODS), allowNull: true },
    paidOn: DataTypes.DATEONLY,
    expenseId: DataTypes.UUID,
    paidBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymPayrollLine', tableName: 'gym_payroll_lines' }
);

class GymAsset extends Model {}
GymAsset.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    name: req(DataTypes.STRING(80)),
    category: enumOf(['cardio', 'strength', 'free_weight', 'bench_rack', 'accessory', 'electrical', 'furniture', 'other']),
    brand: DataTypes.STRING(60),
    serial: DataTypes.STRING(60),
    location: DataTypes.STRING(60),
    boughtOn: DataTypes.DATEONLY,
    costPoisha: bigint('costPoisha', true),
    status: enumOf(ASSET_STATUS, { defaultValue: 'working' }),
    serviceEveryDays: DataTypes.INTEGER,
    lastServiceOn: DataTypes.DATEONLY,
    nextServiceOn: DataTypes.DATEONLY,
    serviceAlertedOn: DataTypes.DATEONLY,
    note: DataTypes.STRING(300),
    createdBy: req(DataTypes.UUID),
  },
  { sequelize, modelName: 'GymAsset', tableName: 'gym_assets' }
);

class GymAssetLog extends Model {}
GymAssetLog.init(
  {
    id,
    assetId: req(DataTypes.UUID),
    gymId: req(DataTypes.UUID),
    kind: enumOf(['service', 'repair', 'status', 'note']),
    doneOn: req(DataTypes.DATEONLY),
    costPoisha: bigint('costPoisha', true),
    statusAfter: { type: DataTypes.ENUM(...ASSET_STATUS), allowNull: true },
    note: DataTypes.STRING(300),
    expenseId: DataTypes.UUID,
    byUser: req(DataTypes.UUID),
  },
  { sequelize, modelName: 'GymAssetLog', tableName: 'gym_asset_logs', updatedAt: false }
);

module.exports = { GymStaffShift, GymStaffTime, GymStaffPay, GymPayrollRun, GymPayrollLine, GymAsset, GymAssetLog };
