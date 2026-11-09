'use strict';

// M03-FR-14: per-type validation, bounds and §6.5 cross-key rules. 100% branch coverage (money).
const { validateValue, shapeError, crossRuleViolations, assertCrossRules, CROSS_RULES } = require('../../src/modules/settings/settings.validate');

const def = (valueType, extra = {}) => ({ key: 'x.test', valueType, minValue: null, maxValue: null, enumOptions: null, value: null, ...extra });
const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

describe('shapeError per value type (M03-FR-14)', () => {
  it.each([
    ['int', 5, null],
    ['int', 5.5, 'Must be a whole number'],
    ['int', '5', 'Must be a whole number'],
    ['decimal', 2.5, null],
    ['decimal', 7.25, null],
    ['decimal', 7.255, 'At most 2 decimal places'],
    ['decimal', '7', 'Must be a number'],
    ['decimal', Infinity, 'Must be a number'],
    ['money', 8000, null],
    ['money', 0, null],
    ['money', -1, 'Must be a whole amount in poisha'],
    ['money', 80.5, 'Must be a whole amount in poisha'],
    ['money', '8000', 'Must be a whole amount in poisha'],
    ['bool', true, null],
    ['bool', 'true', 'Must be true or false'],
    ['time', '06:00', null],
    ['time', '23:59', null],
    ['time', '24:00', 'Must be a time like 06:00'],
    ['time', 600, 'Must be a time like 06:00'],
    ['int_list', [60, 90], null],
    ['int_list', [], 'Must be a list of 1 to 20 numbers'],
    ['int_list', 'x', 'Must be a list of 1 to 20 numbers'],
    ['int_list', Array.from({ length: 21 }, (_, i) => i), 'Must be a list of 1 to 20 numbers'],
    ['int_list', [1, -1], 'Every item must be a whole number'],
    ['int_list', [1, 1], 'Items must be unique'],
    ['string_list', ['sports_gear'], null],
    ['string_list', [], 'Must be a list of 1 to 20 keys'],
    ['string_list', ['Sports Gear'], 'Every item must be a lowercase key like sports_gear'],
    ['string_list', [3], 'Every item must be a lowercase key like sports_gear'],
    ['string_list', ['a', 'a'], 'Items must be unique'],
  ])('%s %p → %p', (type, value, expected) => {
    expect(shapeError(def(type), value)).toBe(expected);
  });

  it('enum accepts only the listed options, and copes with a missing list', () => {
    expect(shapeError(def('enum', { enumOptions: ['pre', 'post'] }), 'post')).toBeNull();
    expect(shapeError(def('enum', { enumOptions: ['pre', 'post'] }), 'later')).toBe('Must be one of pre, post');
    expect(shapeError(def('enum'), 'post')).toBe('Must be one of ');
  });

  it('json keeps the same fields, all non-negative numbers', () => {
    const d = def('json', { value: { hourly: 1, match: 4 } });
    expect(shapeError(d, { match: 5, hourly: 1 })).toBeNull();
    expect(shapeError(d, [1])).toBe('Must be an object');
    expect(shapeError(d, null)).toBe('Must be an object');
    expect(shapeError(d, { hourly: 1 })).toBe('Must have exactly these fields: hourly, match');
    expect(shapeError(d, { hourly: 1, match: -1 })).toBe('Every field must be a number of 0 or more');
    expect(shapeError(d, { hourly: 1, match: 'x' })).toBe('Every field must be a number of 0 or more');
    expect(shapeError(def('json'), {})).toBeNull();
  });

  it('a json map of text keeps text values (M24 gym_saas.feature_min_tiers)', () => {
    const d = def('json', { value: { attendance: 'basic', plans: 'standard' } });
    expect(shapeError(d, { attendance: 'free', plans: 'pro' })).toBeNull();
    expect(shapeError(d, { attendance: 1, plans: 'pro' })).toBe('Every field must be a lowercase key like basic');
    expect(shapeError(d, { attendance: 'Basic', plans: 'pro' })).toBe('Every field must be a lowercase key like basic');
    expect(shapeError(d, { attendance: 'basic' })).toBe('Must have exactly these fields: attendance, plans');
  });

  it('the feature tiers rule tolerates a missing value', () => {
    const r = CROSS_RULES.find((x) => x.id === 'gym_saas.feature_tiers_known');
    expect(r.ok(() => undefined)).toBe(true);
  });

  it('the M24 provider charge rule tolerates a missing value; the overdue days rule refuses an empty list', () => {
    expect(CROSS_RULES.find((x) => x.id === 'gym_manage.provider_bps_range').ok(() => undefined)).toBe(true);
    expect(CROSS_RULES.find((x) => x.id === 'gym_manage.overdue_remind_days_range').ok(() => undefined)).toBe(false);
    expect(CROSS_RULES.find((x) => x.id === 'gym_manage.renewal_remind_days_range').ok(() => undefined)).toBe(false);
    expect(CROSS_RULES.find((x) => x.id === 'gym_manage.renewal_remind_days_range').ok(() => [7, 3, 1])).toBe(true);
    expect(CROSS_RULES.find((x) => x.id === 'gym_manage.renewal_remind_days_range').ok(() => [7, 3, 1, 14])).toBe(false);
  });

  it('rejects an unknown type', () => {
    expect(shapeError(def('blob'), 1)).toBe('Unknown value type blob');
  });
});

describe('validateValue bounds', () => {
  it('passes inside the range and returns the value', () => {
    expect(validateValue(def('decimal', { minValue: '0.00', maxValue: '20.00' }), 6)).toBe(6);
  });

  it('enforces min and max with a readable message', () => {
    const both = def('int', { minValue: 20, maxValue: 50 });
    let err;
    try {
      validateValue(both, 51);
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe('SETTING_OUT_OF_RANGE');
    expect(err.status).toBe(422);
    expect(err.errors[0]).toEqual({ field: 'x.test', message: 'Between 20 and 50' });
    expect(codeOf(() => validateValue(both, 19))).toBe('SETTING_OUT_OF_RANGE');
  });

  it('min only and max only', () => {
    try {
      validateValue(def('money', { minValue: 100 }), 50);
    } catch (e) {
      expect(e.errors[0].message).toBe('At least 100');
    }
    try {
      validateValue(def('money', { maxValue: 100 }), 150);
    } catch (e) {
      expect(e.errors[0].message).toBe('At most 100');
    }
    expect(validateValue(def('money', { maxValue: 100 }), 100)).toBe(100);
    expect(validateValue(def('money'), 10 ** 12)).toBe(10 ** 12);
  });

  it('types without ranges ignore min and max', () => {
    expect(validateValue(def('bool', { minValue: 1, maxValue: 2 }), false)).toBe(false);
  });

  it('a wrong shape is SETTING_TYPE_INVALID', () => {
    expect(codeOf(() => validateValue(def('int'), 'five'))).toBe('SETTING_TYPE_INVALID');
  });
});

describe('cross-key rules (§6.5)', () => {
  const defaults = {
    'booking.advance_pct_min': 20,
    'booking.advance_pct_default': 30,
    'booking.advance_pct_max': 50,
    'fees.ground_booking_pct': 5,
    'booking.refund_half_hours_default': 6,
    'booking.refund_full_hours_default': 24,
    'booking.grid_open': '06:00',
    'booking.grid_close': '23:00',
    'ground.base_price_min_poisha': 80000,
    'ground.base_price_max_poisha': 600000,
    'market.offer_min_pct': 50,
    'market.offer_floor_pct_default': 70,
    'market.return_window_days_min': 3,
    'market.return_window_days_max': 30,
    'market.product_min_photos': 3,
    'market.product_max_photos': 10,
    'market.mto_days_default': 5,
    'market.mto_days_max': 21,
    'market.max_qty_per_order_default': 10,
    'market.max_qty_per_order_max': 50,
    'esports.checkin_close_minutes': 20,
    'esports.checkin_open_minutes': 60,
    'esports.room_reveal_minutes': 15,
    'refunds.staff_limit_poisha': 1000000,
    'payouts.four_eyes_threshold_poisha': 5000000,
    'payouts.auto_release_max_poisha': 0,
    // M24 §6.12 gym plans.
    'gym_saas.tier_free_max_members': 30,
    'gym_saas.tier_basic_max_members': 100,
    'gym_saas.tier_standard_max_members': 300,
    'gym_saas.tier_basic_price_poisha': 79900,
    'gym_saas.tier_standard_price_poisha': 150000,
    'gym_saas.tier_pro_price_poisha': 250000,
    'gym_saas.feature_min_tiers': { attendance: 'basic', reminders: 'basic', online_fees: 'basic', reports: 'standard', trainers: 'standard', plans: 'standard', multi_gym: 'pro' },
    'gym_manage.online_fee_provider_bps': { bkash: 200, nagad: 200, card: 250 },
    'gym_manage.overdue_remind_days': [3],
    'gym_manage.renewal_remind_days': [7, 3, 1],
    // M24 prompt 3b, the SMS add-on (off, prices 0 until the gateway, G9).
    'notify.sms_max_segments': 3,
    'gym_saas.sms_reserve_units': 2,
    'gym_saas.sms_addon_enabled': false,
    'gym_saas.sms_addon_price_poisha': 0,
    'gym_saas.sms_bundle_size': 0,
    'gym_saas.sms_bundle_price_poisha': 0,
  };
  const lookupWith = (over = {}) => (k) => (k in over ? over[k] : defaults[k]);
  const broken = (over, changed) => crossRuleViolations(lookupWith(over), changed).map((r) => r.id);

  it('the seeded defaults break no rule', () => {
    expect(broken({})).toEqual([]);
  });

  it.each([
    ['booking.advance_order', { 'booking.advance_pct_default': 10 }],
    ['booking.advance_order', { 'booking.advance_pct_default': 60 }],
    ['booking.advance_covers_fee', { 'fees.ground_booking_pct': 25 }],
    ['booking.refund_tiers', { 'booking.refund_half_hours_default': 24 }],
    ['booking.grid_order', { 'booking.grid_close': '05:00' }],
    ['ground.price_band', { 'ground.base_price_min_poisha': 600000 }],
    ['market.offer_order', { 'market.offer_min_pct': 80 }],
    ['market.offer_order', { 'market.offer_floor_pct_default': 100, 'market.offer_min_pct': 50 }],
    ['market.return_window', { 'market.return_window_days_min': 31 }],
    ['market.photos_order', { 'market.product_min_photos': 11 }],
    ['market.mto_default', { 'market.mto_days_max': 4 }],
    ['market.qty_default', { 'market.max_qty_per_order_max': 9 }],
    ['esports.checkin_order', { 'esports.checkin_close_minutes': 60 }],
    ['esports.room_reveal', { 'esports.room_reveal_minutes': 21 }],
    ['money.refund_below_payout_threshold', { 'refunds.staff_limit_poisha': 5000001 }],
    ['money.auto_release_below_payout_threshold', { 'payouts.auto_release_max_poisha': 5000001 }],
    ['gym_saas.tier_limits_order', { 'gym_saas.tier_free_max_members': 100 }],
    ['gym_saas.tier_limits_order', { 'gym_saas.tier_standard_max_members': 100 }],
    ['gym_saas.tier_prices_order', { 'gym_saas.tier_basic_price_poisha': 150001 }],
    ['gym_saas.tier_prices_order', { 'gym_saas.tier_pro_price_poisha': 149999 }],
    ['gym_saas.feature_tiers_known', { 'gym_saas.feature_min_tiers': { attendance: 'gold' } }],
    // M24 prompt 3b: the SMS reserve fits the longest SMS; switching the add-on on needs its prices and bundle.
    ['gym_saas.sms_reserve_fits', { 'gym_saas.sms_reserve_units': 4 }],
    ['gym_saas.sms_addon_priced', { 'gym_saas.sms_addon_enabled': true }],
    ['gym_saas.sms_addon_priced', { 'gym_saas.sms_addon_enabled': true, 'gym_saas.sms_addon_price_poisha': 5000, 'gym_saas.sms_bundle_size': 100 }],
    ['gym_saas.sms_addon_priced', { 'gym_saas.sms_addon_enabled': true, 'gym_saas.sms_addon_price_poisha': 5000, 'gym_saas.sms_bundle_price_poisha': 5000 }],
    ['gym_saas.sms_addon_priced', { 'gym_saas.sms_addon_enabled': true, 'gym_saas.sms_bundle_size': 100, 'gym_saas.sms_bundle_price_poisha': 5000 }],
    // M24 §6.12: provider charge per method 0 to 500 bps; one to three overdue reminders of 1 to 30 days.
    ['gym_manage.provider_bps_range', { 'gym_manage.online_fee_provider_bps': { bkash: 501, nagad: 200, card: 250 } }],
    ['gym_manage.provider_bps_range', { 'gym_manage.online_fee_provider_bps': { bkash: 200, nagad: 2.5, card: 250 } }],
    ['gym_manage.overdue_remind_days_range', { 'gym_manage.overdue_remind_days': [3, 7, 14, 21] }],
    ['gym_manage.overdue_remind_days_range', { 'gym_manage.overdue_remind_days': [0] }],
    ['gym_manage.overdue_remind_days_range', { 'gym_manage.overdue_remind_days': [31] }],
  ])('%s is broken by %p', (id, over) => {
    expect(broken(over)).toContain(id);
  });

  it('every rule is covered by the cases above', () => {
    expect(CROSS_RULES.map((r) => r.id).sort()).toEqual(
      ['booking.advance_order', 'booking.advance_covers_fee', 'booking.refund_tiers', 'booking.grid_order', 'ground.price_band', 'market.offer_order', 'market.return_window', 'market.photos_order', 'market.mto_default', 'market.qty_default', 'esports.checkin_order', 'esports.room_reveal', 'money.refund_below_payout_threshold', 'money.auto_release_below_payout_threshold', 'gym_saas.tier_limits_order', 'gym_saas.tier_prices_order', 'gym_saas.feature_tiers_known', 'gym_saas.sms_reserve_fits', 'gym_saas.sms_addon_priced', 'gym_manage.provider_bps_range', 'gym_manage.overdue_remind_days_range', 'gym_manage.renewal_remind_days_range'].sort()
    );
  });

  it('the SMS add-on can be switched on once priced (M24 §6.12)', () => {
    expect(broken({ 'gym_saas.sms_addon_enabled': true, 'gym_saas.sms_addon_price_poisha': 5000, 'gym_saas.sms_bundle_size': 100, 'gym_saas.sms_bundle_price_poisha': 5000 })).toEqual([]);
  });

  it('only checks the rules a change can break', () => {
    // The fee rule is broken, but the change only touches market keys.
    expect(broken({ 'fees.ground_booking_pct': 25 }, ['market.offer_min_pct'])).toEqual([]);
    expect(broken({ 'fees.ground_booking_pct': 25 }, ['fees.ground_booking_pct'])).toEqual(['booking.advance_covers_fee']);
  });

  it('the v3 rule: advance minimum must cover the platform fee (worked example: 25% advance ≥ 5% fee)', () => {
    expect(broken({ 'booking.advance_pct_min': 5, 'fees.ground_booking_pct': 5 })).toEqual([]);
    expect(broken({ 'booking.advance_pct_min': 4.99, 'fees.ground_booking_pct': 5 })).toEqual(['booking.advance_covers_fee']);
  });

  it('assertCrossRules throws SETTING_CROSS_RULE with the rule text, or passes', () => {
    expect(() => assertCrossRules(lookupWith({}), ['fees.ground_booking_pct'])).not.toThrow();
    let err;
    try {
      assertCrossRules(lookupWith({ 'fees.ground_booking_pct': 25 }), ['fees.ground_booking_pct']);
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe('SETTING_CROSS_RULE');
    expect(err.detail).toBe('booking.advance_pct_min ≥ fees.ground_booking_pct');
    expect(err.meta.rules).toEqual(['booking.advance_covers_fee']);
  });
});
