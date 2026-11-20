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
  // round 2
  GYM_CLASS_LIMIT: [422, 'This gym has the most classes allowed'],
  GYM_CLASS_UNKNOWN: [404, 'Class not found'],
  GYM_CLASS_TRAINER: [422, 'Choose a trainer who works at this gym'],
  GYM_CLASS_SESSION_STATE: [409, 'This class session is not taking bookings'],
  GYM_CLASS_STARTED: [409, 'This class has already started'],
  GYM_CLASS_FULL: [409, 'This class and its waitlist are full'],
  GYM_CLASS_BOOKED: [409, 'This member already has a place in this class'],
  GYM_CLASS_CANCEL_CLOSED: [409, 'It is too late to cancel this booking'],
  GYM_CLASS_BOOKING_STATE: [409, 'This booking cannot be changed now'],
  GYM_MEMBERSHIP_NEEDED: [409, 'A running membership is needed for this'],
  GYM_REWARD_UNAVAILABLE: [409, 'This reward is not available'],
  GYM_REWARD_LIMIT: [422, 'This gym has the most rewards allowed'],
  GYM_POINTS_SHORT: [409, 'Not enough points for this reward'],
  GYM_REWARD_NOTHING: [409, 'This reward cannot be used now'],
  GYM_REFERRAL_EXISTS: [409, 'This member was already referred'],
  GYM_NOTICE_SEGMENT: [422, 'Choose who the notice is for'],
  GYM_NOTICE_CAP: [429, 'This gym has sent the most notices allowed today'],
  GYM_NOTICE_NOBODY: [422, 'No member in this group can be reached'],
  GYM_LEAD_STATE: [409, 'This enquiry cannot change that way'],
  GYM_LEADS_CLOSED: [404, 'Gym not found'],
  // round 3
  GYM_SHIFT_TIMES: [422, 'Choose a day and a start time before the end time'],
  GYM_SHIFT_LIMIT: [422, 'This staff member has the most shifts allowed'],
  GYM_STAFF_UNKNOWN: [422, 'Choose a staff member of this gym'],
  GYM_CLOCK_TOKEN_INVALID: [422, 'This code is not the gym’s entrance code, or it has expired. Scan it again'],
  GYM_NOT_STAFF: [403, 'You do not work at this gym'],
  GYM_STAFF_ALREADY_IN: [409, 'This staff member is already clocked in'],
  GYM_STAFF_NOT_IN: [409, 'This staff member is not clocked in'],
  GYM_COMMISSION_OUT_OF_RANGE: [422, 'The commission rate is outside the allowed range'],
  GYM_PAYROLL_PERIOD: [422, 'Choose this month or an earlier one'],
  GYM_PAYROLL_EXISTS: [409, 'This month already has a payroll'],
  GYM_PAYROLL_EMPTY: [422, 'Set the pay of at least one staff member first'],
  GYM_PAYROLL_STATE: [409, 'This payroll cannot change that way'],
  GYM_PAYROLL_LINE_STATE: [409, 'This payroll line cannot change now'],
  GYM_PAYROLL_NEGATIVE: [422, 'The deduction is larger than the pay'],
  GYM_ASSET_LIMIT: [422, 'This gym has the most machines allowed'],
  GYM_ASSET_STATE: [409, 'This machine is retired'],
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
  pnlTrendMonths: settings.get('gym_ops.pnl_trend_months'),
  lockerFeeMax: settings.get('gym_ops.locker_fee_max_poisha'),
  rentalMaxDays: settings.get('gym_ops.locker_rental_max_days'),
  lockerRemindDays: settings.get('gym_ops.locker_remind_days'),
  lockersMax: settings.get('gym_ops.lockers_max'),
  backdateDays: settings.get('gym_manage.backdate_days'),
  // round 2
  classWeeksAhead: settings.get('gym_ops.class_weeks_ahead'),
  classReminderMinutes: settings.get('gym_ops.class_reminder_minutes'),
  classCancelCutoffMinutes: settings.get('gym_ops.class_cancel_cutoff_minutes'),
  waitlistMax: settings.get('gym_ops.waitlist_max'),
  classesMax: settings.get('gym_ops.classes_max'),
  classSlotsMax: settings.get('gym_ops.class_slots_max'),
  pointsPerCheckin: settings.get('gym_ops.points_per_checkin'),
  pointsStreakDays: settings.get('gym_ops.points_streak_days'),
  pointsStreakBonus: settings.get('gym_ops.points_streak_bonus'),
  pointsReferral: settings.get('gym_ops.points_referral'),
  pointsExpireDays: settings.get('gym_ops.points_expire_days'),
  rewardsMax: settings.get('gym_ops.rewards_max'),
  rewardDiscountMax: settings.get('gym_ops.reward_discount_max_poisha'),
  noticeDailyCap: settings.get('gym_ops.notice_daily_cap'),
  noticeDaysMax: settings.get('gym_ops.notice_days_max'),
  leadPerIpHour: settings.get('gym_ops.lead_per_ip_hour'),
  leadPerPhoneDay: settings.get('gym_ops.lead_per_phone_day'),
  // round 3
  staffLateGraceMinutes: settings.get('gym_ops.staff_late_grace_minutes'),
  staffAutoClockoutHours: settings.get('gym_ops.staff_auto_clockout_hours'),
  shiftsPerStaffMax: settings.get('gym_ops.shifts_per_staff_max'),
  salaryMax: settings.get('gym_ops.salary_max_poisha'),
  commissionMax: settings.get('gym_ops.commission_bps_max'),
  payrollAdjustMax: settings.get('gym_ops.payroll_adjust_max_poisha'),
  assetsMax: settings.get('gym_ops.assets_max'),
  assetServiceAlertDays: settings.get('gym_ops.asset_service_alert_days'),
  assetCostMax: settings.get('gym_ops.asset_cost_max_poisha'),
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
