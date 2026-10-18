'use strict';

/**
 * M22 rules (§6, §8): pure functions, no I/O, 100% branch coverage (CLAUDE.md: money code).
 * Dates are Dhaka calendar dates (YYYY-MM-DD); amounts are integer poisha.
 */
const { pctToBps } = require('../../common/money');

// ---------------------------------------------------------------- fees (FR-06, FR-07)

/** The SaaS fee in basis points a contract charges per tournament (flat contracts are invoiced instead). */
function feeBpsFor(contract, settingPct) {
  if (contract.model === 'flat') return 0;
  return pctToBps(contract.pct ?? settingPct);
}

/** The guaranteed prize pool an organiser must fund (FR-05): every place, plus the capped kill reward. */
function requiredFund({ prizes, killReward, maxPaidKills }) {
  return prizes.reduce((s, p) => s + p.amount, 0) + killReward * (maxPaidKills ?? 0);
}

/**
 * Why the fund blocks a submit, or null: nothing or not enough deposited (PRIZE_FUND_REQUIRED), or a
 * deposit larger than the pool (PRIZE_FUND_AMOUNT_MISMATCH: the deposit must equal the pool, §6.3).
 */
function fundBlock({ required, deposited }) {
  if (deposited < required) return 'PRIZE_FUND_REQUIRED';
  if (deposited > required) return 'PRIZE_FUND_AMOUNT_MISMATCH';
  return null;
}

// ---------------------------------------------------------------- contracts (§8)

const CONTRACT = {
  draft: ['active', 'ended'],
  active: ['suspended', 'ended'],
  suspended: ['active', 'ended'],
  ended: [],
};
const canContract = (from, to) => (CONTRACT[from] ?? []).includes(to);

/** Why an organisation cannot submit a tournament under its contract today, or null (FR-01, FR-13). */
function contractBlock(contract, today) {
  if (!contract) return 'ORG_CONTRACT_REQUIRED';
  if (contract.status === 'suspended') return 'ORG_CONTRACT_SUSPENDED';
  if (contract.status !== 'active' || contract.startsOn > today || (contract.endsOn && contract.endsOn < today)) return 'ORG_CONTRACT_REQUIRED';
  return null;
}

/** A contract to end on this date (its last day has passed). */
const expired = (contract, today) => Boolean(contract.endsOn && contract.endsOn < today);

/** The day the expiry reminder is due (noticeDays before the end), or null without an end. */
const noticeDue = (contract, today, noticeDays) => Boolean(contract.endsOn && !contract.expiryNotifiedAt && addDays(contract.endsOn, -noticeDays) <= today && contract.endsOn >= today);

// ---------------------------------------------------------------- invoices (FR-08, FR-09)

function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
const lastOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // m is 1-based

/** The billing period (calendar month or quarter, Dhaka) containing a date; null for per-tournament cycles. */
function periodOf(cycle, date) {
  const [y, m] = date.split('-').map(Number);
  if (cycle === 'monthly') return { start: `${date.slice(0, 7)}-01`, end: lastOfMonth(y, m) };
  if (cycle === 'quarterly') {
    const first = Math.floor((m - 1) / 3) * 3 + 1;
    return { start: `${y}-${String(first).padStart(2, '0')}-01`, end: lastOfMonth(y, first + 2) };
  }
  return null;
}

/** The flat-fee invoice a contract owes for today's period, or null (not flat, not started, or ended). */
function invoiceDue(contract, today) {
  if (contract.model !== 'flat' || contract.status !== 'active' || contract.startsOn > today || expired(contract, today)) return null;
  const p = periodOf(contract.billingCycle, today);
  return p ? { periodStart: p.start, periodEnd: p.end, subtotal: contract.flatFeePoisha } : null;
}

/** Subtotal, VAT and total (VAT off until the accountant confirms it, Q136). */
function invoiceAmounts(subtotal, { vatEnabled, vatPct }) {
  const vat = vatEnabled ? Math.round((subtotal * pctToBps(vatPct)) / 10000) : 0;
  return { subtotal, vat, total: subtotal + vat };
}

/** Is an issued invoice past its due date (it turns overdue)? */
const overdue = (invoice, now) => invoice.status === 'issued' && invoice.dueAt <= now;

/** Does an unpaid invoice now block new tournaments (due date + grace days passed, FR-09, Q134)? */
const publishBlocked = (invoices, now, graceDays) => invoices.some((i) => ['issued', 'overdue'].includes(i.status) && i.dueAt.getTime() + graceDays * 86400000 <= now.getTime());

// ---------------------------------------------------------------- branding (FR-11, FR-12)

const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

/** Why a subdomain cannot be claimed, or null (3–30 of a-z, 0-9 and inner dashes; not reserved). */
function subdomainBlock(sub, reserved) {
  if (typeof sub !== 'string' || !SUBDOMAIN.test(sub) || sub.includes('--')) return 'SUBDOMAIN_INVALID';
  if (reserved.includes(sub)) return 'SUBDOMAIN_RESERVED';
  return null;
}

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (1 to 21). */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Why the colours cannot go live, or null: the primary colour carries white text (buttons, headers)
 * and the accent sits on the dark page; both need WCAG AA 4.5:1.
 */
function brandingBlock({ primaryHex, accentHex }) {
  if (contrast(primaryHex, '#ffffff') < 4.5) return 'BRAND_PRIMARY_CONTRAST';
  if (contrast(accentHex, '#111210') < 4.5) return 'BRAND_ACCENT_CONTRAST';
  return null;
}

module.exports = {
  feeBpsFor,
  requiredFund,
  fundBlock,
  CONTRACT,
  canContract,
  contractBlock,
  expired,
  noticeDue,
  addDays,
  periodOf,
  invoiceDue,
  invoiceAmounts,
  overdue,
  publishBlocked,
  subdomainBlock,
  contrast,
  brandingBlock,
};
