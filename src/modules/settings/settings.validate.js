'use strict';

/**
 * M03-FR-14 validation: per-type checks, bounds and the §6.5 cross-key rules.
 * Pure functions with no I/O, so every branch is unit-tested (money: 100% branch coverage).
 */
const { AppError } = require('../../common/errors');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SNAKE_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_LIST = 20;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** At most 2 decimal places (M03 §6.5: percentages are numeric(5,2)). */
const hasTwoDecimalsAtMost = (v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-9;

const typeInvalid = (key, message) => new AppError(422, 'SETTING_TYPE_INVALID', 'That value has the wrong type', { errors: [{ field: key, message }] });
const outOfRange = (key, min, max) => {
  const message = min != null && max != null ? `Between ${min} and ${max}` : min != null ? `At least ${min}` : `At most ${max}`;
  return new AppError(422, 'SETTING_OUT_OF_RANGE', 'That value is out of range', { errors: [{ field: key, message }], meta: { min, max } });
};

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** Shape check per value type. Returns an error message, or null when the shape is right. */
function shapeError(def, value) {
  switch (def.valueType) {
    case 'int':
      return Number.isSafeInteger(value) ? null : 'Must be a whole number';
    case 'decimal':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'Must be a number';
      return hasTwoDecimalsAtMost(value) ? null : 'At most 2 decimal places';
    case 'money':
      // Poisha: whole, non-negative, never a float (CLAUDE.md money rule).
      return Number.isSafeInteger(value) && value >= 0 ? null : 'Must be a whole amount in poisha';
    case 'bool':
      return typeof value === 'boolean' ? null : 'Must be true or false';
    case 'enum':
      return (def.enumOptions || []).includes(value) ? null : `Must be one of ${(def.enumOptions || []).join(', ')}`;
    case 'time':
      return typeof value === 'string' && TIME_RE.test(value) ? null : 'Must be a time like 06:00';
    case 'int_list':
      if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST) return `Must be a list of 1 to ${MAX_LIST} numbers`;
      if (!value.every((x) => Number.isSafeInteger(x) && x >= 0)) return 'Every item must be a whole number';
      return new Set(value).size === value.length ? null : 'Items must be unique';
    case 'string_list':
      if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST) return `Must be a list of 1 to ${MAX_LIST} keys`;
      if (!value.every((x) => typeof x === 'string' && SNAKE_RE.test(x))) return 'Every item must be a lowercase key like sports_gear';
      return new Set(value).size === value.length ? null : 'Items must be unique';
    case 'json': {
      // JSON settings are flat maps of numbers; the keys must stay the same as the current value.
      if (!isPlainObject(value)) return 'Must be an object';
      const want = Object.keys(def.value || {}).sort();
      const got = Object.keys(value).sort();
      if (want.join(',') !== got.join(',')) return `Must have exactly these fields: ${want.join(', ')}`;
      return Object.values(value).every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0) ? null : 'Every field must be a number of 0 or more';
    }
    default:
      return `Unknown value type ${def.valueType}`;
  }
}

const RANGED = new Set(['int', 'decimal', 'money']);

/**
 * Validate one value against its definition (a PlatformSetting row or plain object with
 * valueType, minValue, maxValue, enumOptions and the current value). Throws on failure.
 */
function validateValue(def, value) {
  const message = shapeError(def, value);
  if (message) throw typeInvalid(def.key, message);
  if (RANGED.has(def.valueType)) {
    const min = num(def.minValue);
    const max = num(def.maxValue);
    if ((min !== null && value < min) || (max !== null && value > max)) throw outOfRange(def.key, min, max);
  }
  return value;
}

/**
 * §6.5 cross-key rules (plus the booking grid order). Each rule names the keys it reads,
 * so a change is only checked against the rules it can break.
 */
const CROSS_RULES = [
  {
    id: 'booking.advance_order',
    text: 'booking.advance_pct_min ≤ booking.advance_pct_default ≤ booking.advance_pct_max',
    keys: ['booking.advance_pct_min', 'booking.advance_pct_default', 'booking.advance_pct_max'],
    ok: (v) => v('booking.advance_pct_min') <= v('booking.advance_pct_default') && v('booking.advance_pct_default') <= v('booking.advance_pct_max'),
  },
  {
    id: 'booking.advance_covers_fee',
    text: 'booking.advance_pct_min ≥ fees.ground_booking_pct',
    keys: ['booking.advance_pct_min', 'fees.ground_booking_pct'],
    ok: (v) => v('booking.advance_pct_min') >= v('fees.ground_booking_pct'),
  },
  {
    id: 'booking.refund_tiers',
    text: 'booking.refund_half_hours_default < booking.refund_full_hours_default',
    keys: ['booking.refund_half_hours_default', 'booking.refund_full_hours_default'],
    ok: (v) => v('booking.refund_half_hours_default') < v('booking.refund_full_hours_default'),
  },
  {
    id: 'booking.grid_order',
    text: 'booking.grid_open < booking.grid_close',
    keys: ['booking.grid_open', 'booking.grid_close'],
    ok: (v) => v('booking.grid_open') < v('booking.grid_close'),
  },
  {
    id: 'ground.price_band',
    text: 'ground.base_price_min_poisha < ground.base_price_max_poisha',
    keys: ['ground.base_price_min_poisha', 'ground.base_price_max_poisha'],
    ok: (v) => v('ground.base_price_min_poisha') < v('ground.base_price_max_poisha'),
  },
  {
    id: 'market.offer_order',
    text: 'market.offer_min_pct ≤ market.offer_floor_pct_default < 100',
    keys: ['market.offer_min_pct', 'market.offer_floor_pct_default'],
    ok: (v) => v('market.offer_min_pct') <= v('market.offer_floor_pct_default') && v('market.offer_floor_pct_default') < 100,
  },
  {
    id: 'market.photos_order',
    text: 'market.product_min_photos ≤ market.product_max_photos',
    keys: ['market.product_min_photos', 'market.product_max_photos'],
    ok: (v) => v('market.product_min_photos') <= v('market.product_max_photos'),
  },
  {
    id: 'market.mto_default',
    text: 'market.mto_days_default ≤ market.mto_days_max',
    keys: ['market.mto_days_default', 'market.mto_days_max'],
    ok: (v) => v('market.mto_days_default') <= v('market.mto_days_max'),
  },
  {
    id: 'market.qty_default',
    text: 'market.max_qty_per_order_default ≤ market.max_qty_per_order_max',
    keys: ['market.max_qty_per_order_default', 'market.max_qty_per_order_max'],
    ok: (v) => v('market.max_qty_per_order_default') <= v('market.max_qty_per_order_max'),
  },
  {
    id: 'market.return_window',
    text: 'market.return_window_days_min ≤ market.return_window_days_max',
    keys: ['market.return_window_days_min', 'market.return_window_days_max'],
    ok: (v) => v('market.return_window_days_min') <= v('market.return_window_days_max'),
  },
  {
    id: 'esports.checkin_order',
    text: 'esports.checkin_close_minutes < esports.checkin_open_minutes',
    keys: ['esports.checkin_close_minutes', 'esports.checkin_open_minutes'],
    ok: (v) => v('esports.checkin_close_minutes') < v('esports.checkin_open_minutes'),
  },
  {
    id: 'esports.room_reveal',
    text: 'esports.room_reveal_minutes ≤ esports.checkin_close_minutes',
    keys: ['esports.room_reveal_minutes', 'esports.checkin_close_minutes'],
    ok: (v) => v('esports.room_reveal_minutes') <= v('esports.checkin_close_minutes'),
  },
  {
    id: 'money.refund_below_payout_threshold',
    text: 'refunds.staff_limit_poisha ≤ payouts.four_eyes_threshold_poisha',
    keys: ['refunds.staff_limit_poisha', 'payouts.four_eyes_threshold_poisha'],
    ok: (v) => v('refunds.staff_limit_poisha') <= v('payouts.four_eyes_threshold_poisha'),
  },
  {
    // M07 §6.3: an automatic release never skips the two-master approval.
    id: 'money.auto_release_below_payout_threshold',
    text: 'payouts.auto_release_max_poisha ≤ payouts.four_eyes_threshold_poisha',
    keys: ['payouts.auto_release_max_poisha', 'payouts.four_eyes_threshold_poisha'],
    ok: (v) => v('payouts.auto_release_max_poisha') <= v('payouts.four_eyes_threshold_poisha'),
  },
];

/**
 * Rules broken by the merged state. `lookup(key)` returns the value after the proposed
 * changes; only rules that read a changed key are checked (all rules when changedKeys is omitted).
 */
function crossRuleViolations(lookup, changedKeys) {
  const changed = changedKeys ? new Set(changedKeys) : null;
  return CROSS_RULES.filter((r) => !changed || r.keys.some((k) => changed.has(k))).filter((r) => !r.ok(lookup));
}

function assertCrossRules(lookup, changedKeys) {
  const broken = crossRuleViolations(lookup, changedKeys);
  if (broken.length) {
    throw new AppError(422, 'SETTING_CROSS_RULE', 'These values break a rule', {
      detail: broken.map((r) => r.text).join('; '),
      errors: broken.map((r) => ({ field: r.keys[0], message: r.text })),
      meta: { rules: broken.map((r) => r.id) },
    });
  }
}

module.exports = { validateValue, shapeError, crossRuleViolations, assertCrossRules, CROSS_RULES };
