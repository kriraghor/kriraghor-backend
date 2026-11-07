'use strict';

/**
 * M27 Gym operations: pure rules (100% branch coverage, jest.config). Money is integer poisha; dates are
 * Dhaka calendar dates (YYYY-MM-DD). Codes are returned, never thrown.
 */

const EXPENSE_METHODS = Object.freeze(['cash', 'owner_bkash', 'owner_nagad', 'card_counter', 'bank', 'other']);
const SALE_METHODS = Object.freeze(['cash', 'owner_bkash', 'owner_nagad', 'card_counter', 'other']);
const PRODUCT_CATEGORIES = Object.freeze(['supplement', 'drink', 'snack', 'gear', 'apparel', 'accessory', 'other']);
const LOCKER_SIZES = Object.freeze(['small', 'medium', 'large']);

/** M27-FR-01: the categories every gym starts with (keys stay; names are the gym's own, editable). */
const DEFAULT_CATEGORIES = Object.freeze([
  { key: 'rent', name: 'Rent' },
  { key: 'electricity', name: 'Electricity' },
  { key: 'salaries', name: 'Salaries' },
  { key: 'equipment_repair', name: 'Equipment repair' },
  { key: 'internet', name: 'Internet' },
  { key: 'cleaning', name: 'Cleaning' },
  { key: 'marketing', name: 'Marketing' },
  { key: 'stock', name: 'Stock purchases' },
  { key: 'other', name: 'Other' },
]);

const DAY_MS = 86400000;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/** An amount in poisha within [min, max] (inclusive) → null, or the code. */
const amountBlock = (amount, { min = 1, max }) => (Number.isInteger(amount) && amount >= min && amount <= max ? null : 'GYM_AMOUNT_OUT_OF_RANGE');

/** A date no later than today and no earlier than `backdateDays` ago → null, or the code. */
const pastDateBlock = (date, { today, backdateDays }) => (date <= today && date >= addDays(today, -backdateDays) ? null : 'GYM_DATE_OUT_OF_RANGE');

/**
 * M27-FR-07: the cash that should be in the drawer at the end of the day.
 * expected = opening float + cash fees (net of reversals) + cash sales (recorded, not reversed) − cash expenses paid from the drawer.
 */
function drawerExpected({ opening, cashFees, cashSales, drawerExpenses }) {
  return opening + cashFees + cashSales - drawerExpenses;
}

/** M27-FR-08: closing the drawer: the difference (counted − expected; negative = short) and whether it balances. */
function drawerClose({ expected, counted }) {
  const difference = counted - expected;
  return { expected, counted, difference, balanced: difference === 0, short: difference < 0 };
}

/**
 * M27-FR-17: price a counter sale. Each line is { qty, unitPrice, unitCost } (unitCost null when unknown);
 * total = Σ qty × unitPrice; cost = Σ qty × unitCost over lines with a known cost.
 */
function saleTotals(lines) {
  let total = 0;
  let cost = 0;
  for (const l of lines) {
    total += l.qty * l.unitPrice;
    if (l.unitCost !== null && l.unitCost !== undefined) cost += l.qty * l.unitCost;
  }
  return { total, cost };
}

/**
 * M27-FR-18: can this product be sold now in this quantity? → null or the code.
 * Retired → unavailable; past its expiry date → expired (as the marketplace, M12); too little stock → short.
 */
function sellBlock(product, { qty, today }) {
  if (product.status !== 'active') return 'GYM_PRODUCT_UNAVAILABLE';
  if (product.expiresOn && product.expiresOn < today) return 'GYM_PRODUCT_EXPIRED';
  if (product.stockQty < qty) return 'GYM_STOCK_SHORT';
  return null;
}

/**
 * M27-FR-14: the low-stock alert fires once when stock falls to the reorder level or below, and is armed
 * again when stock rises above it. → 'alert' | 'rearm' | null.
 */
function lowStockChange({ before, after, reorderLevel, alerted }) {
  if (reorderLevel <= 0) return alerted ? 'rearm' : null;
  if (after <= reorderLevel && !alerted && before > after) return 'alert';
  if (after > reorderLevel && alerted) return 'rearm';
  return null;
}

/** M27-FR-15: the product expires within `alertDays` (or already did) and was not yet alerted for this date. */
function expiryAlertDue(product, { today, alertDays }) {
  if (!product.expiresOn || product.status !== 'active' || product.stockQty <= 0) return false;
  if (product.expiryAlertedOn === product.expiresOn) return false;
  return daysBetween(today, product.expiresOn) <= alertDays;
}

/** M27-FR-23: a locker rental's default fee: the monthly fee for each started 30 days. */
function rentalFee({ monthlyFee, startsOn, endsOn }) {
  const days = daysBetween(startsOn, endsOn) + 1;
  return monthlyFee * Math.ceil(days / 30);
}

/** M27-FR-23: rental dates: start today or later (up to backdate), end on or after the start, at most maxDays long. */
function rentalBlock({ startsOn, endsOn, today, backdateDays, maxDays }) {
  if (startsOn < addDays(today, -backdateDays)) return 'GYM_DATE_OUT_OF_RANGE';
  if (endsOn < startsOn || daysBetween(startsOn, endsOn) + 1 > maxDays) return 'GYM_DATE_OUT_OF_RANGE';
  return null;
}

/** M27-FR-22: what the locker grid shows for a locker and its active rental (if any). */
function lockerState(locker, rental, today) {
  if (locker.status === 'out_of_service') return 'out_of_service';
  if (!rental) return 'free';
  if (rental.endsOn < today) return 'overdue';
  return rental.paidSaleId ? 'taken' : 'unpaid';
}

/**
 * M27-FR-27: profit and loss of a period.
 * income   = counter fees + online fees − the provider charge passed through + counter sales + locker fees
 * gross    = income − the cost of the goods sold (where the cost is known)
 * net      = gross − expenses (by category)
 */
function profitAndLoss({ counterFees, onlineFees, providerCharge, posSales, lockerFees, goodsCost, expenses }) {
  const fees = counterFees + onlineFees - providerCharge;
  const income = fees + posSales + lockerFees;
  const gross = income - goodsCost;
  const spent = expenses.reduce((s, e) => s + e.amount, 0);
  return { income: { fees, posSales, lockerFees, total: income }, goodsCost, gross, expenses: { total: spent, byCategory: expenses }, net: gross - spent };
}

/**
 * M27-FR-28: the VAT inside a VAT-inclusive amount at a rate in basis points (15% = 1500), rounded half up to
 * the poisha: vat = round(amount × bps ÷ (10000 + bps)). Null when the gym shows no VAT.
 */
function vatPart(amount, bps) {
  if (!bps) return null;
  const vat = Math.round((amount * bps) / (10000 + bps));
  return { bps, vat, net: amount - vat };
}

const lastOfMonth = (day) => addDays(`${addDays(`${day.slice(0, 7)}-28`, 4).slice(0, 7)}-01`, -1);

/**
 * The period to compare with (M27-FR-27). Inside one calendar month starting on the 1st: the month before,
 * as far into it as `to` is (the whole month when `to` is the month's last day; 1–7 Oct for 1–7 Nov).
 * Otherwise the same length of time just before.
 */
function previousPeriod(from, to) {
  if (from.endsWith('-01') && from.slice(0, 7) === to.slice(0, 7)) {
    const prevFrom = `${addDays(from, -1).slice(0, 7)}-01`;
    const prevLast = lastOfMonth(prevFrom);
    const wanted = addDays(prevFrom, Number(to.slice(8)) - 1);
    return { from: prevFrom, to: to === lastOfMonth(from) || wanted > prevLast ? prevLast : wanted };
  }
  const len = daysBetween(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

module.exports = {
  EXPENSE_METHODS,
  SALE_METHODS,
  PRODUCT_CATEGORIES,
  LOCKER_SIZES,
  DEFAULT_CATEGORIES,
  addDays,
  daysBetween,
  amountBlock,
  pastDateBlock,
  drawerExpected,
  drawerClose,
  saleTotals,
  sellBlock,
  lowStockChange,
  expiryAlertDue,
  rentalFee,
  rentalBlock,
  lockerState,
  profitAndLoss,
  previousPeriod,
  vatPart,
};
