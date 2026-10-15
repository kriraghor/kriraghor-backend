'use strict';

/**
 * Money helpers (CLAUDE.md: integer poisha, never floats; M06-FR-22). 1 taka = 100 poisha.
 * Amounts are JS numbers that must be safe integers; products that could pass 2^53 are computed
 * with BigInt. Rounding is half-up to the poisha, and residue always lands on the payee
 * (net = gross − fee), never lost (M06 §12 #12).
 */

const MAX_POISHA = Number.MAX_SAFE_INTEGER;

/** Throws unless `v` is a non-negative safe integer number of poisha. Returns it. */
function assertPoisha(v, what = 'amount') {
  if (!Number.isSafeInteger(v) || v < 0) throw new TypeError(`${what} must be a non-negative integer number of poisha`);
  return v;
}

/** BIGINT, NUMERIC and COUNT columns come back from pg as strings; convert and check. */
function toPoisha(v) {
  if (v === null || v === undefined) return 0;
  return assertPoisha(typeof v === 'string' ? Number(v) : v, 'stored amount');
}

/** Percent setting (e.g. 5 or 2.5) → basis points (500, 250). */
function pctToBps(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) throw new TypeError('percent must be between 0 and 100');
  return Math.round(pct * 100);
}

/** fee = round_half_up(base × bps / 10000) (M06-FR-13). */
function feeOf(base, bps) {
  assertPoisha(base, 'base');
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new TypeError('bps must be an integer between 0 and 10000');
  return Number((BigInt(base) * BigInt(bps) + 5000n) / 10000n);
}

/** { fee, net } for a gross amount; net + fee = gross. */
function splitFee(gross, bps) {
  const fee = feeOf(gross, bps);
  return { fee, net: gross - fee };
}

/**
 * Split `total` into `n` parts that differ by at most one poisha; the first parts take the
 * remainder (so a captain or booker absorbs rounding, M21-FR-24, M06 §6.6).
 */
function splitEven(total, n) {
  assertPoisha(total, 'total');
  if (!Number.isInteger(n) || n < 1) throw new TypeError('n must be a positive integer');
  const base = Math.floor(total / n);
  const rest = total - base * n;
  return Array.from({ length: n }, (_v, i) => base + (i < rest ? 1 : 0));
}

/** Split by percentages that sum to 100; the remainder goes to the first share. */
function splitByPct(total, pcts) {
  assertPoisha(total, 'total');
  if (!pcts.length || pcts.some((p) => !Number.isInteger(p) || p < 0) || pcts.reduce((a, b) => a + b, 0) !== 100) {
    throw new TypeError('percentages must be whole numbers that sum to 100');
  }
  const parts = pcts.map((p) => Number((BigInt(total) * BigInt(p)) / 100n));
  parts[0] += total - parts.reduce((a, b) => a + b, 0);
  return parts;
}

const sum = (values) => values.reduce((a, b) => a + b, 0);

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bnDigits = (s) => s.replace(/\d/g, (d) => BN_DIGITS[Number(d)]);

/** "৳1,23,456.50" (Indian grouping); Bangla digits for bn. Whole taka drop the decimals. */
function format(poisha, locale = 'en') {
  const negative = poisha < 0;
  const abs = Math.abs(poisha);
  const taka = Math.trunc(abs / 100).toLocaleString('en-IN');
  const rest = abs % 100;
  const text = `${negative ? '−' : ''}৳${taka}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
  return locale === 'bn' ? bnDigits(text) : text;
}

/** Poisha → "1234.50" (gateway APIs speak taka with two decimals). */
function toTakaString(poisha) {
  assertPoisha(poisha);
  return `${Math.trunc(poisha / 100)}.${String(poisha % 100).padStart(2, '0')}`;
}

/** "1234.5" / "1234.50" / "1234" / 1234.5 → poisha, by string parsing (no float maths). Throws on anything else. */
function fromTakaString(value) {
  const text = typeof value === 'number' ? String(value) : value;
  const m = typeof text === 'string' ? /^(\d{1,13})(?:\.(\d{1,2})\d*)?$/.exec(text.trim()) : null;
  if (!m) throw new TypeError(`Not a taka amount: ${value}`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** API shape for amounts (M06 §9 examples). */
const money = (amount) => ({ amount, currency: 'BDT' });

module.exports = { MAX_POISHA, assertPoisha, toPoisha, pctToBps, feeOf, splitFee, splitEven, splitByPct, sum, format, money, bnDigits, toTakaString, fromTakaString };
