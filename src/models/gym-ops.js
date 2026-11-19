'use strict';

/**
 * M27 Gym operations, round 1 (migration 20261119000001): the gym's own books beyond fees, owned by the
 * gym-ops module (gym group, ADR-007): expenses, the cash drawer, the counter shop (products, stock moves,
 * sales) and lockers. Bookkeeping only, like M24 counter money (M24-FR-34); index.js re-exports them.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');
const { toPoisha } = require('../common/money');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const req = (type) => ({ type, allowNull: false });
const enumOf = (values, extra = {}) => ({ type: DataTypes.ENUM(...values), allowNull: false, ...extra });
const poisha = (field, { allowNull = false, dflt } = {}) => ({
  type: DataTypes.BIGINT,
  allowNull,
  ...(dflt === undefined ? {} : { defaultValue: dflt }),
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : toPoisha(v);
  },
});
/** A signed BIGINT poisha amount (a drawer can be short). */
const signed = (field) => ({
  type: DataTypes.BIGINT,
  allowNull: true,
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : Number(v);
  },
});
const EXPENSE_METHODS = ['cash', 'owner_bkash', 'owner_nagad', 'card_counter', 'bank', 'other'];
const SALE_METHODS = ['cash', 'owner_bkash', 'owner_nagad', 'card_counter', 'other'];

class GymExpenseCategory extends Model {}
GymExpenseCategory.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    key: DataTypes.STRING(30),
    name: req(DataTypes.STRING(60)),
    sort: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    status: enumOf(['active', 'retired'], { defaultValue: 'active' }),
  },
  { sequelize, modelName: 'GymExpenseCategory', tableName: 'gym_expense_categories' }
);

class GymExpense extends Model {}
GymExpense.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    categoryId: req(DataTypes.UUID),
    amountPoisha: poisha('amountPoisha'),
    spentOn: req(DataTypes.DATEONLY),
    method: enumOf(EXPENSE_METHODS),
    fromDrawer: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    payee: DataTypes.STRING(80),
    note: DataTypes.STRING(300),
    source: enumOf(['manual', 'payroll', 'asset'], { defaultValue: 'manual' }),
    sourceId: DataTypes.UUID,
    status: enumOf(['recorded', 'void'], { defaultValue: 'recorded' }),
    voidReason: DataTypes.STRING(300),
    voidedBy: DataTypes.UUID,
    voidedAt: DataTypes.DATE(3),
    createdBy: req(DataTypes.UUID),
  },
  { sequelize, modelName: 'GymExpense', tableName: 'gym_expenses' }
);

class GymCashSession extends Model {}
GymCashSession.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    businessDate: req(DataTypes.DATEONLY),
    openingPoisha: poisha('openingPoisha'),
    openedBy: req(DataTypes.UUID),
    openedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    status: enumOf(['open', 'closed'], { defaultValue: 'open' }),
    countedPoisha: poisha('countedPoisha', { allowNull: true }),
    expectedPoisha: signed('expectedPoisha'),
    differencePoisha: signed('differencePoisha'),
    closeNote: DataTypes.STRING(300),
    closedBy: DataTypes.UUID,
    closedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'GymCashSession', tableName: 'gym_cash_sessions' }
);

class GymProduct extends Model {}
GymProduct.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    name: req(DataTypes.STRING(80)),
    barcode: DataTypes.STRING(40),
    category: enumOf(['supplement', 'drink', 'snack', 'gear', 'apparel', 'accessory', 'other']),
    pricePoisha: poisha('pricePoisha'),
    costPoisha: poisha('costPoisha', { allowNull: true }),
    stockQty: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    reorderLevel: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    batchNo: DataTypes.STRING(40),
    expiresOn: DataTypes.DATEONLY,
    importer: DataTypes.STRING(120),
    // Tester feedback (19 Nov 2026): one photo in the public bucket (migration 20261129000001).
    photoKey: DataTypes.STRING(200),
    photoMime: DataTypes.STRING(20),
    photoBytes: DataTypes.INTEGER,
    lowAlertedAt: DataTypes.DATE(3),
    expiryAlertedOn: DataTypes.DATEONLY,
    status: enumOf(['active', 'retired'], { defaultValue: 'active' }),
    createdBy: DataTypes.UUID,
    updatedBy: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymProduct', tableName: 'gym_products' }
);

class GymStockMove extends Model {}
GymStockMove.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    productId: req(DataTypes.UUID),
    kind: enumOf(['in', 'sale', 'sale_reversal', 'adjust', 'write_off']),
    qty: req(DataTypes.INTEGER),
    qtyAfter: req(DataTypes.INTEGER),
    unitCostPoisha: poisha('unitCostPoisha', { allowNull: true }),
    saleId: DataTypes.UUID,
    note: DataTypes.STRING(200),
    byUser: DataTypes.UUID,
  },
  { sequelize, modelName: 'GymStockMove', tableName: 'gym_stock_moves', updatedAt: false }
);

class GymSale extends Model {}
GymSale.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    receiptNo: req(DataTypes.STRING(24)),
    kind: enumOf(['pos', 'locker']),
    memberId: DataTypes.UUID,
    totalPoisha: poisha('totalPoisha'),
    costPoisha: poisha('costPoisha', { dflt: 0 }),
    method: enumOf(SALE_METHODS),
    vatBps: DataTypes.INTEGER,
    soldOn: req(DataTypes.DATEONLY),
    soldBy: req(DataTypes.UUID),
    status: enumOf(['recorded', 'reversed'], { defaultValue: 'recorded' }),
    reverseReason: DataTypes.STRING(300),
    reversedOn: DataTypes.DATEONLY,
    reversedBy: DataTypes.UUID,
    reversedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'GymSale', tableName: 'gym_sales' }
);

class GymSaleLine extends Model {}
GymSaleLine.init(
  {
    id,
    saleId: req(DataTypes.UUID),
    productId: DataTypes.UUID,
    lockerRentalId: DataTypes.UUID,
    description: req(DataTypes.STRING(120)),
    qty: req(DataTypes.INTEGER),
    unitPricePoisha: poisha('unitPricePoisha'),
    unitCostPoisha: poisha('unitCostPoisha', { allowNull: true }),
    lineTotalPoisha: poisha('lineTotalPoisha'),
  },
  { sequelize, modelName: 'GymSaleLine', tableName: 'gym_sale_lines', updatedAt: false }
);

class GymLocker extends Model {}
GymLocker.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    number: req(DataTypes.STRING(10)),
    zone: DataTypes.STRING(30),
    size: enumOf(['small', 'medium', 'large'], { defaultValue: 'medium' }),
    monthlyFeePoisha: poisha('monthlyFeePoisha'),
    status: enumOf(['available', 'out_of_service', 'retired'], { defaultValue: 'available' }),
    note: DataTypes.STRING(200),
  },
  { sequelize, modelName: 'GymLocker', tableName: 'gym_lockers' }
);

class GymLockerRental extends Model {}
GymLockerRental.init(
  {
    id,
    gymId: req(DataTypes.UUID),
    lockerId: req(DataTypes.UUID),
    memberId: req(DataTypes.UUID),
    startsOn: req(DataTypes.DATEONLY),
    endsOn: req(DataTypes.DATEONLY),
    feePoisha: poisha('feePoisha'),
    paidSaleId: DataTypes.UUID,
    status: enumOf(['active', 'ended', 'cancelled'], { defaultValue: 'active' }),
    endReason: DataTypes.STRING(200),
    endedAt: DataTypes.DATE(3),
    endedBy: DataTypes.UUID,
    remindedOn: DataTypes.DATEONLY,
    createdBy: req(DataTypes.UUID),
  },
  { sequelize, modelName: 'GymLockerRental', tableName: 'gym_locker_rentals' }
);

module.exports = { GymExpenseCategory, GymExpense, GymCashSession, GymProduct, GymStockMove, GymSale, GymSaleLine, GymLocker, GymLockerRental };
