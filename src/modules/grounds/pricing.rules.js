'use strict';

/**
 * M09 §6.1 price formula and §6.2 rule limits, pure (no I/O), shared with M10.
 *
 *   rate(t)  = base × (h ≥ peakFrom ? 1 + peak : 1) × (h < earlyTo ? 1 − early : 1) × (Fri/Sat ? 1 + weekend : 1)
 *   price    = round10( Σ over 30-minute blocks of rate(block start) / 2 )      whole taka, nearest ৳10
 *   advance  = round1( price × advance% )                                      nearest ৳1
 *   balance  = price − advance
 *   series   = round10( price × (1 − series%) )
 *
 * Money is poisha. Percentages may have two decimals, so they are basis points and every product is
 * exact (BigInt); only the final amount is rounded, half-up. Hours and weekdays are Asia/Dhaka
 * (UTC+6, no daylight saving). Combinable courts are priced as the sum of their courts (Q62).
 */
const { feeOf, pctToBps } = require('../../common/money');

const D = 10000n; // 100% in basis points
const DHAKA_MS = 6 * 3600 * 1000;
const FRI = 5;
const SAT = 6;

const bp = (pct) => BigInt(Math.round(Number(pct) * 100));
/** round_half_up(x / y) for non-negative BigInts. */
const roundDiv = (x, y) => (2n * x + y) / (2n * y);

/** Asia/Dhaka wall-clock parts of an instant: hour, minute, weekday (0 = Sunday), date. */
function dhakaParts(at) {
  const d = new Date(new Date(at).getTime() + DHAKA_MS);
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), dow: d.getUTCDay(), date: d.toISOString().slice(0, 10) };
}

/** The instant of a Dhaka wall-clock date (YYYY-MM-DD) and minutes after midnight. */
const dhakaInstant = (date, minutes) => new Date(Date.parse(`${date}T00:00:00Z`) - DHAKA_MS + minutes * 60000);

/** Which multipliers apply to an hour on a weekday. */
function multipliers(rules, hour, dow) {
  return { peak: hour >= rules.peakFromHour, early: hour < rules.earlyToHour, weekend: dow === FRI || dow === SAT };
}

/** The base price per hour for a court: its override, or the ground's base. */
const courtBase = (rules, courtId) => Number(rules.courtBaseOverrides?.[courtId] ?? rules.basePricePoisha);

/** Hourly rate as an exact fraction: numerator over D³. */
function rateNum(base, rules, hour, dow) {
  const m = multipliers(rules, hour, dow);
  return BigInt(base) * (m.peak ? D + bp(rules.peakPct) : D) * (m.early ? D - bp(rules.earlyPct) : D) * (m.weekend ? D + bp(rules.weekendPct) : D);
}

/** Hourly rate in poisha (rounded half-up), for the heatmap and "rate at start". */
const hourlyRate = (base, rules, hour, dow) => Number(roundDiv(rateNum(base, rules, hour, dow), D * D * D));

/**
 * Price of `minutes` from `start` on the given courts (one court, or a combinable group: the sum).
 * Each 30-minute block is priced by its own start hour, so a slot crossing peakFrom is part-peak.
 */
function price(rules, courtIds, start, minutes) {
  const t0 = new Date(start).getTime();
  let sum = 0n;
  for (const courtId of courtIds) {
    const base = courtBase(rules, courtId);
    for (let i = 0; i < minutes; i += 30) {
      const { hour, dow } = dhakaParts(t0 + i * 60000);
      sum += rateNum(base, rules, hour, dow);
    }
  }
  // Σ rate / 2, in poisha, rounded half-up to ৳10 (1,000 poisha).
  return Number(roundDiv(sum, D * D * D * 2n * 1000n) * 1000n);
}

/** Advance at booking: price × advance%, rounded half-up to ৳1. */
const advanceOf = (amount, advancePct) => Number(roundDiv(BigInt(amount) * bp(advancePct), D * 100n) * 100n);

/** A regular-booking (series) session: price less the series discount, rounded half-up to ৳10. */
const seriesPrice = (amount, seriesPct) => Number(roundDiv(BigInt(amount) * (D - bp(seriesPct)), D * 1000n) * 1000n);

/**
 * A quote with both v3 payment options. The platform fee is taken on the full value at check-in
 * (fees.ground_booking_pct); the owner gets the online part less the fee, plus cash at the venue.
 */
function quote({ rules, courtIds, start, minutes, feePct, allowFull }) {
  const amount = price(rules, courtIds, start, minutes);
  const advance = advanceOf(amount, rules.advancePct);
  const { hour, dow } = dhakaParts(start);
  const fee = feeOf(amount, pctToBps(Number(feePct)));
  const options = [{ kind: 'advance', payNow: advance, atVenue: amount - advance, ownerGetsOnline: advance - fee }];
  if (allowFull) options.push({ kind: 'full', payNow: amount, atVenue: 0, ownerGetsOnline: amount - fee });
  return {
    price: amount,
    advance,
    balance: amount - advance,
    rateAtStart: courtIds.reduce((s, c) => s + hourlyRate(courtBase(rules, c), rules, hour, dow), 0),
    fee,
    options,
    applied: multipliers(rules, hour, dow),
  };
}

/** Tone of a heatmap cell by its ratio to the base price (M09 §4.1). */
function tone(rate, base) {
  const r = rate / base;
  if (r < 0.99) return 'low';
  if (r <= 1.01) return 'base';
  if (r < 1.3) return 'high';
  return 'peak';
}

/** 7 × 17 heatmap: rows are days from `fromDate` (Dhaka), columns hours 06…22. */
function heatmap(rules, { fromDate, days = 7, firstHour = 6, lastHour = 22, courtId = null }) {
  const base = courtId ? courtBase(rules, courtId) : Number(rules.basePricePoisha);
  const rows = [];
  for (let d = 0; d < days; d += 1) {
    const { date, dow } = dhakaParts(dhakaInstant(fromDate, d * 1440));
    const cells = [];
    for (let h = firstHour; h <= lastHour; h += 1) {
      const rate = hourlyRate(base, rules, h, dow);
      cells.push({ hour: h, rate, tone: tone(rate, base) });
    }
    rows.push({ date, dow, cells });
  }
  return rows;
}

// ---------------------------------------------------------------- §6.2 validation

/**
 * Field limits. Fixed by the design: peak from 15–20, early to 7–10, full refund 1–72, half < full,
 * grace 5–30. From settings (`limits`): base range, peak/weekend/early caps, advance range (and the
 * v3 rule advance ≥ the platform fee), series discount cap and the minimum-length options.
 * Returns a VALIDATION_FAILED errors list, or null.
 */
function validate(r, limits) {
  const errors = [];
  const bad = (field, message) => errors.push({ field, message });
  const between = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const taka = (p) => `৳${(p / 100).toLocaleString('en-IN')}`;

  if (!Number.isInteger(r.basePricePoisha) || !between(r.basePricePoisha, limits.baseMin, limits.baseMax)) bad('basePricePoisha', `Base price must be ${taka(limits.baseMin)} to ${taka(limits.baseMax)}`);
  for (const [courtId, v] of Object.entries(r.courtBaseOverrides ?? {})) {
    if (!Number.isInteger(v) || !between(v, limits.baseMin, limits.baseMax)) bad(`courtBaseOverrides.${courtId}`, `Court price must be ${taka(limits.baseMin)} to ${taka(limits.baseMax)}`);
  }
  if (!Number.isInteger(r.peakFromHour) || !between(r.peakFromHour, 15, 20)) bad('peakFromHour', 'Peak starts between 3pm and 8pm');
  if (!Number.isInteger(r.earlyToHour) || !between(r.earlyToHour, 7, 10)) bad('earlyToHour', 'Early bird ends between 7am and 10am');
  if (!between(r.peakPct, 0, limits.peakMax)) bad('peakPct', `Peak surcharge is capped at ${limits.peakMax}%`);
  if (!between(r.weekendPct, 0, limits.weekendMax)) bad('weekendPct', `Weekend surcharge is capped at ${limits.weekendMax}%`);
  if (!between(r.earlyPct, 0, limits.earlyMax)) bad('earlyPct', `Early-bird discount is capped at ${limits.earlyMax}%`);
  if (!between(r.advancePct, limits.advanceMin, limits.advanceMax)) bad('advancePct', `Kriraghor allows ${limits.advanceMin}% to ${limits.advanceMax}%`);
  else if (r.advancePct < limits.feePct) bad('advancePct', `The advance must cover the ${limits.feePct}% platform fee`);
  if (!limits.minLengthOptions.includes(r.minBookingMin)) bad('minBookingMin', `One of ${limits.minLengthOptions.join(', ')} minutes`);
  if (!Number.isInteger(r.fullRefundHours) || !between(r.fullRefundHours, 1, 72)) bad('fullRefundHours', 'Full refund window is 1 to 72 hours');
  if (!Number.isInteger(r.halfRefundHours) || !between(r.halfRefundHours, 0, 71)) bad('halfRefundHours', 'Half refund window is 0 to 71 hours');
  else if (r.halfRefundHours >= r.fullRefundHours) bad('halfRefundHours', 'Must be less than the full-refund window');
  if (!Number.isInteger(r.checkinGraceMin) || !between(r.checkinGraceMin, 5, 30)) bad('checkinGraceMin', 'Check-in grace is 5 to 30 minutes');
  if (!between(r.seriesDiscountPct, 0, limits.seriesMax)) bad('seriesDiscountPct', `Regular booking discount is capped at ${limits.seriesMax}%`);
  return errors.length ? errors : null;
}

// ---------------------------------------------------------------- change history (FR-14)

const FIELDS = ['basePricePoisha', 'courtBaseOverrides', 'peakFromHour', 'peakPct', 'weekendPct', 'earlyToHour', 'earlyPct', 'advancePct', 'minBookingMin', 'fullRefundHours', 'halfRefundHours', 'checkinGraceMin', 'seriesDiscountPct'];

/** The rule fields that differ between two versions (all of them for a first version). */
function changedKeys(prev, next) {
  if (!prev) return [...FIELDS];
  return FIELDS.filter((k) => JSON.stringify(prev[k] ?? null) !== JSON.stringify(next[k] ?? null));
}

const clock = (h) => (h === 12 ? '12pm' : h > 12 ? `${h - 12}pm` : `${h}am`);

/** A human summary of a published version ("Updated pricing: base ৳2,400, peak +25% from 5pm, …"). */
function summary(prev, next) {
  const keys = new Set(changedKeys(prev, next));
  const parts = [];
  if (keys.has('basePricePoisha')) parts.push(`base ৳${(next.basePricePoisha / 100).toLocaleString('en-IN')}/h`);
  if (keys.has('courtBaseOverrides')) parts.push('court prices');
  if (keys.has('peakPct') || keys.has('peakFromHour')) parts.push(`peak +${Number(next.peakPct)}% from ${clock(next.peakFromHour)}`);
  if (keys.has('weekendPct')) parts.push(`weekend +${Number(next.weekendPct)}%`);
  if (keys.has('earlyPct') || keys.has('earlyToHour')) parts.push(`early bird −${Number(next.earlyPct)}% before ${clock(next.earlyToHour)}`);
  if (keys.has('advancePct')) parts.push(`advance ${Number(next.advancePct)}%`);
  if (keys.has('minBookingMin')) parts.push(`minimum ${next.minBookingMin} min`);
  if (keys.has('fullRefundHours') || keys.has('halfRefundHours')) parts.push(`refunds ${next.fullRefundHours}h/${next.halfRefundHours}h`);
  if (keys.has('checkinGraceMin')) parts.push(`grace ${next.checkinGraceMin} min`);
  if (keys.has('seriesDiscountPct')) parts.push(`regular booking −${Number(next.seriesDiscountPct)}%`);
  return `${prev ? 'Updated pricing' : 'First pricing'}: ${parts.length ? parts.join(', ') : 'no changes'}`.slice(0, 300);
}

module.exports = { dhakaParts, dhakaInstant, multipliers, courtBase, hourlyRate, price, advanceOf, seriesPrice, quote, tone, heatmap, validate, changedKeys, summary, FIELDS };
