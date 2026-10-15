'use strict';

/**
 * FeeService (M06-FR-07, §6.7): the platform fee of a vertical, snapshotted at obligation time
 * (booking created, order placed, registration approved). The snapshot is stored on the payment and
 * the escrow hold; later setting changes never re-price it (§12 #10).
 *
 * Esports has no percentage fee: platform revenue is the pool remainder after prizes (v3 rules), so
 * its snapshot is 0 bps.
 */
const settings = require('../settings/settings.service');
const { pctToBps } = require('../../common/money');

const FEE_KEYS = {
  grounds: 'fees.ground_booking_pct',
  market: 'fees.shop_commission_pct',
  used: 'fees.used_gear_pct',
  hire: 'fees.hire_pct',
  tournaments: 'fees.tournament_pct',
  gym: 'fees.gym_pct',
  test: 'payments.test_charge_fee_pct',
};
const NO_FEE = new Set(['esports']);

/** { feeBps, settingKey, settingsVersion } for a vertical, as of now. */
function snapshot(vertical) {
  if (NO_FEE.has(vertical)) return { feeBps: 0, settingKey: 'none', settingsVersion: 0 };
  const key = FEE_KEYS[vertical];
  if (!key) throw new Error(`No fee setting for vertical ${vertical}`);
  const snap = settings.snapshot([key])[key];
  return { feeBps: pctToBps(snap.value), settingKey: key, settingsVersion: snap.version };
}

module.exports = { snapshot, FEE_KEYS };
