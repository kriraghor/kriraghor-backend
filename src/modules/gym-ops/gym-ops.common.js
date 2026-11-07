'use strict';

/**
 * Shared bits of M27 Gym operations: the error catalogue, every number from M03 (read per call), access
 * to one gym through gym-manage (which owns the gym's access rules, the plan tiers and the receipt
 * numbers), today's Dhaka date, events and audit. Bookkeeping only: the gym's own money, never the M06
 * ledger (as M24-FR-34).
 */
const { AppError } = require('../../common/errors');
const settings = require('../settings').settings;
const events = require('../events').events;
const audit = require('../audit').audit;
const ops = require('../gym-manage').ops;

const ERRORS = {
  GYM_EXPENSE_STATE: [409, 'This expense is already void'],
  GYM_EXPENSE_CATEGORY_UNKNOWN: [422, 'Choose one of the gym’s expense categories'],
  GYM_AMOUNT_OUT_OF_RANGE: [422, 'The amount is outside the allowed range'],
  GYM_DRAWER_OPEN: [409, 'Today’s cash drawer is already open'],
  GYM_DRAWER_NOT_OPEN: [409, 'Open today’s cash drawer first'],
  GYM_DRAWER_CLOSED: [409, 'Today’s cash drawer is already closed'],
  GYM_PRODUCT_BARCODE_TAKEN: [409, 'Another product of this gym has this barcode'],
  GYM_PRODUCT_UNAVAILABLE: [422, 'This product cannot be sold'],
  GYM_PRODUCT_EXPIRED: [422, 'This product is past its expiry date and cannot be sold'],
  GYM_STOCK_SHORT: [409, 'There is not enough stock for this sale'],
  GYM_SALE_STATE: [409, 'This sale is already reversed'],
  GYM_LOCKER_NUMBER_TAKEN: [409, 'Another locker of this gym has this number'],
  GYM_LOCKER_UNAVAILABLE: [409, 'This locker is not free'],
  GYM_LOCKER_RENTAL_STATE: [409, 'This rental has already ended'],
  GYM_LOCKER_FEE_PAID: [409, 'The fee of this rental is already paid'],
  GYM_LOCKER_LIMIT: [422, 'This gym has the most lockers allowed'],
  GYM_MEMBER_UNKNOWN: [422, 'Choose a member of this gym'],
  GYM_DATE_OUT_OF_RANGE: [422, 'Choose a date in the allowed range'],
};

function fail(code, meta) {
  const [status, title] = ERRORS[code];
  return new AppError(status, code, title, meta ? { meta } : {});
}

/** Every number of the module, read per call (M03; no magic numbers). */
const cfg = () => ({
  expenseMax: settings.get('gym_ops.expense_max_poisha'),
  floatMax: settings.get('gym_ops.drawer_float_max_poisha'),
  priceMax: settings.get('gym_ops.product_price_max_poisha'),
  saleMaxLines: settings.get('gym_ops.sale_max_lines'),
  expiryAlertDays: settings.get('gym_ops.stock_expiry_alert_days'),
  lockerFeeMax: settings.get('gym_ops.locker_fee_max_poisha'),
  rentalMaxDays: settings.get('gym_ops.locker_rental_max_days'),
  lockerRemindDays: settings.get('gym_ops.locker_remind_days'),
  lockersMax: settings.get('gym_ops.lockers_max'),
  backdateDays: settings.get('gym_manage.backdate_days'),
});

/**
 * One gym for this caller, through gym-manage: 404 for anyone unrelated, 403 PERMISSION_REQUIRED for staff
 * without `permission` (or any of `anyOf`), 403 GYM_TIER_REQUIRED below the feature's tier, 403
 * GYM_ACCOUNT_RESTRICTED for writes while the owner's account is restricted.
 */
const access = (principal, gymId, permission, opts = {}) => ops.access(principal, gymId, permission, opts);
const needs = (a, permission) => ops.needs(a, permission);
const shown = (a, body) => ops.shown(a, body);
const today = (now = new Date()) => ops.today(now);
const iso = (d) => (d ? new Date(d).toISOString() : null);

const publish = (transaction, name, aggregateType, aggregateId, payload, actor = null) => events.publish(transaction, { name, aggregateType, aggregateId, payload, actor });
const record = (entry, transaction) => audit.record(entry, { transaction });

module.exports = { ERRORS, fail, cfg, access, needs, shown, today, iso, publish, record, ops };
