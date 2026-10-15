'use strict';

/**
 * Payment purposes (M06 §2.4, §7). A code registry instead of a database ENUM, so a module adds its
 * purpose when it is built, without a migration. Each purpose names its vertical (for the fee and
 * fee_revenue account), its escrow account, whether its holds are pooled (settled together by
 * group_ref, M21 §6.5) and the hook M06 calls when money is captured:
 *
 *   onCaptured({ payment, late }) → 'accept' | 'reject'
 *
 * 'reject' (for example a slot hold that expired and was taken, §12 #2) triggers an automatic full
 * `late_capture` refund (FR-05). Purpose modules register their hook with register(); until they
 * do, a late capture is rejected and an on-time one accepted.
 */
const config = require('../../config');

const defaultOnCaptured = ({ late }) => (late ? 'reject' : 'accept');

const PURPOSES = {
  // M21 entry fees, held per registration and settled per tournament (pool).
  esports_entry: { vertical: 'esports', escrowAccount: 'escrow:esports_entry', pooled: true, testOnly: false },
  // Master test charge (dev and staging only, PAYMENTS_TEST_CHARGES): the Phase 2 exit check.
  test_charge: { vertical: 'test', escrowAccount: 'escrow:test_charge', pooled: false, testOnly: true },
};

const hooks = new Map();

function get(purpose) {
  const def = PURPOSES[purpose];
  if (!def) throw new Error(`Unknown payment purpose: ${purpose}`);
  if (def.testOnly && !config.payments.testCharges) throw new Error(`Payment purpose ${purpose} is disabled`);
  return { ...def, onCaptured: hooks.get(purpose) ?? defaultOnCaptured };
}

/** Called by a purpose module at load time. */
function register(purpose, { onCaptured }) {
  if (!PURPOSES[purpose]) throw new Error(`Unknown payment purpose: ${purpose}`);
  hooks.set(purpose, onCaptured);
}

const list = () => Object.keys(PURPOSES);

module.exports = { get, register, list, PURPOSES };
