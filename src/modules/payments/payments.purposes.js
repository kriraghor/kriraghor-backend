'use strict';

/**
 * Payment purposes (M06 §2.4, §7). A code registry instead of a database ENUM, so a module adds its
 * purpose when it is built, without a migration. Each purpose names its vertical (for the fee and
 * fee_revenue account), its escrow account, whether its holds are pooled (settled together by
 * group_ref, M21 §6.5) and the hook M06 calls when money is captured:
 *
 *   onCaptured({ payment, late, transaction }) → 'accept' | 'reject' (may be async; runs inside the
 *   capture transaction, so the purpose can confirm its own record atomically)
 *
 * 'reject' (for example a slot hold that expired and was taken, §12 #2) triggers an automatic full
 * `late_capture` refund (FR-05). Purpose modules register their hook with register(); until they
 * do, a late capture is rejected and an on-time one accepted.
 *
 * payoutSchedule (M07 §6.1) says which payout run sweeps the money released to payees: 'daily',
 * 'ground_weekly', 'shop_weekly', or 'withdraw' (esports prizes wait in the payable until the winner
 * withdraws them, M07 v3 note; never swept).
 */
const config = require('../../config');

const defaultOnCaptured = ({ late }) => (late ? 'reject' : 'accept');

const PURPOSES = {
  // M21 entry fees, held per registration and settled per tournament (pool).
  esports_entry: { vertical: 'esports', escrowAccount: 'escrow:esports_entry', pooled: true, testOnly: false, payoutSchedule: 'withdraw' },
  // M22 an organiser's prize fund: deposited before its tournament is submitted, held per deposit and
  // grouped by the fund (organiser_prize_funds.id). Prizes leave it at finalise; what is left goes to
  // the organisation owner, paid out daily (FR-05, FR-10).
  esports_prize_fund: { vertical: 'esports_saas', escrowAccount: 'escrow:esports_prize_fund', pooled: true, testOnly: false, payoutSchedule: 'daily' },
  // M22 SaaS fee invoices (flat contracts, FR-09): grouped by the invoice (no payee), captured, then
  // collected straight to fee revenue.
  fee_invoice: { vertical: 'esports_saas', escrowAccount: 'escrow:fee_invoice', pooled: true, testOnly: false, payoutSchedule: null },
  // M10 ground bookings: the advance or the full price, held per booking and released to the owner at
  // check-in (or auto-complete) with the fee on the full value (escrow feeBase, v3).
  ground_booking: { vertical: 'grounds', escrowAccount: 'escrow:ground_booking', pooled: false, testOnly: false, payoutSchedule: 'ground_weekly' },
  // M13 shop orders: one payment for a basket, split into one hold per shop sub-order (M06 splits),
  // each released to its shop at completion with the commission on the items subtotal (feeBase).
  market_order: { vertical: 'market', escrowAccount: 'escrow:market_order', pooled: false, testOnly: false, payoutSchedule: 'shop_weekly' },
  // M11 hire: one payment per request, split into one hold per job (payee: the pro), released when
  // the manager confirms (or automatically) with hire_pct on the job's quote; paid out daily.
  hire: { vertical: 'hire', escrowAccount: 'escrow:hire', pooled: false, testOnly: false, payoutSchedule: 'daily' },
  // M20 gym packages (day, month, quarter passes): held per pass, released to the gym owner at the
  // first admission or when an unused pass expires (Q110), with fees.gym_pct; paid out with the
  // venue owners' weekly run.
  gym_package: { vertical: 'gym', escrowAccount: 'escrow:gym_package', pooled: false, testOnly: false, payoutSchedule: 'ground_weekly' },
  // M20 trainer monthly subscriptions: one payment per month, released to the trainer after the
  // month (and the dispute window) with fees.gym_pct; paid out daily like other pros.
  trainer_subscription: { vertical: 'gym', escrowAccount: 'escrow:trainer_subscription', pooled: false, testOnly: false, payoutSchedule: 'daily' },
  // M14 physical-sport entry fees: held per registration (payee: the organisation owner), released in
  // two tranches (after the first result, at completion) with fees.tournament_pct; weekly payout run.
  tournament_entry: { vertical: 'tournaments', escrowAccount: 'escrow:tournament_entry', pooled: false, testOnly: false, payoutSchedule: 'ground_weekly' },
  // Master test charge (dev and staging only, PAYMENTS_TEST_CHARGES): the Phase 2 exit check.
  test_charge: { vertical: 'test', escrowAccount: 'escrow:test_charge', pooled: false, testOnly: true, payoutSchedule: 'daily' },
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
