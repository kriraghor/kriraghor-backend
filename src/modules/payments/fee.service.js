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
const ledger = require('./ledger.service');
const lrules = require('./ledger.rules');

const FEE_KEYS = {
  grounds: 'fees.ground_booking_pct',
  market: 'fees.shop_commission_pct',
  used: 'fees.used_gear_pct',
  hire: 'fees.hire_pct',
  tournaments: 'fees.tournament_pct',
  gym: 'fees.gym_pct',
  // M22: organiser tournaments (the contract may override it; snapshotted on the tournament at publish).
  esports_saas: 'fees.esports_saas_pct',
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

/**
 * A fee the payee owes on money collected off-platform (M06 §6.4): posted as a receivable and netted
 * at the next payout (M07). Idempotent by `key`; a zero amount posts nothing. Runs in the caller's
 * transaction.
 */
async function accrueReceivable({ payeeId, vertical, amount, refType, refId, key, memo = null, actor = null }, { transaction }) {
  if (amount === 0) return null;
  return ledger.post(
    {
      kind: 'fee.receivable',
      refType,
      refId,
      idempotencyKey: `fee.receivable:${key}`,
      lines: lrules.feeReceivableLines({ payeeId, vertical, amount }),
      memo: memo ?? `Fee owed on ${refType} ${refId}`,
      postedBy: actor?.id ?? null,
    },
    { transaction }
  );
}

/** Undo a receivable (the venue sale was entered by mistake and cancelled). Idempotent; null when none was posted. */
async function reverseReceivable({ key, actor = null }, { transaction }) {
  const posted = await ledger.findByKey(`fee.receivable:${key}`, transaction);
  if (!posted) return null;
  return ledger.reverse(posted.id, { idempotencyKey: `fee.receivable.reverse:${key}`, memo: 'Fee owed cancelled', postedBy: actor?.id ?? null, kind: 'fee.receivable_reversed' }, { transaction });
}

module.exports = { snapshot, accrueReceivable, reverseReceivable, FEE_KEYS };
