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

/**
 * The months of the P&L trend (dashboards, M27-FR-27a): `n` calendar months ending with the month of
 * `end`, oldest first; each runs to its last day, or to `today` in the current month.
 */
function trendMonths(end, today, n) {
  const out = [];
  let first = `${end.slice(0, 7)}-01`;
  for (let i = 0; i < n; i += 1) {
    const last = lastOfMonth(first);
    out.unshift({ month: first.slice(0, 7), from: first, to: last > today ? today : last });
    first = `${addDays(first, -1).slice(0, 7)}-01`;
  }
  return out.filter((m) => m.from <= today);
}

// ---------------------------------------------------------------- round 2: classes, points, notices

const DHAKA_OFFSET_MS = 6 * 3600000; // Asia/Dhaka is UTC+6 all year (no daylight saving)

/** M27-FR-47: a session's start and end as instants, from a Dhaka date, "HH:MM" and its length in minutes. */
function sessionWindow(localDate, startTime, minutes) {
  const startsAt = new Date(Date.parse(`${localDate}T${startTime}:00Z`) - DHAKA_OFFSET_MS);
  return { startsAt, endsAt: new Date(startsAt.getTime() + minutes * 60000) };
}

/** The Dhaka day of the week of a date (0 = Sunday … 6 = Saturday). */
const dowOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** M27-FR-47: the dates from today (inclusive) for `weeks` weeks that fall on `dow`. */
function datesAhead(today, weeks, dow) {
  const out = [];
  for (let i = 0; i < weeks * 7; i += 1) {
    const d = addDays(today, i);
    if (dowOf(d) === dow) out.push(d);
  }
  return out;
}

/**
 * M27-FR-48, FR-49: what a new booking becomes: a place while there is room, else a waitlist place while the
 * waitlist has room, else null (full).
 */
function bookingOutcome({ booked, waitlisted, capacity, waitlistMax }) {
  if (booked < capacity) return 'booked';
  if (waitlisted < waitlistMax) return 'waitlisted';
  return null;
}

/** M27-FR-48: a session takes bookings while scheduled and not started → null, or the code. */
function sessionBookBlock({ status, startsAt, now }) {
  if (status !== 'scheduled') return 'GYM_CLASS_SESSION_STATE';
  return now >= startsAt ? 'GYM_CLASS_STARTED' : null;
}

/** M27-FR-50: a member cancels up to cutoff minutes before the start; the desk until the start. */
function cancelBlock({ source, now, startsAt, cutoffMinutes }) {
  const limit = source === 'desk' ? startsAt.getTime() : startsAt.getTime() - cutoffMinutes * 60000;
  return now.getTime() > limit ? 'GYM_CLASS_CANCEL_CLOSED' : null;
}

/** M27-FR-53: the class reminder is due within `minutes` of the start, once. */
function classReminderDue({ startsAt, now, minutes, remindedAt }) {
  if (remindedAt) return false;
  const left = startsAt.getTime() - now.getTime();
  return left > 0 && left <= minutes * 60000;
}

/**
 * M27-FR-56: a streak bonus is due today when the member has checked in on each of the last `days` days
 * ending today, and the run of days in a row ending today is a whole number of streaks (one bonus per run).
 * `dates` are counted check-in dates, ascending, without duplicates.
 */
function streakBonusDue(dates, today, days) {
  const have = new Set(dates);
  let run = 0;
  for (let d = today; have.has(d); d = addDays(d, -1)) run += 1;
  return run >= days && run % days === 0;
}

/**
 * M27-FR-60: points that expire now, first in first out: points earned that are past their date, less
 * everything already taken (redeemed, expired, negative adjustments). Never negative.
 */
const pointsToExpire = ({ earnedDue, consumed }) => Math.max(0, earnedDue - consumed);

/** M27-FR-59: a reward can be redeemed → null or the code. */
function redeemBlock({ balance, reward }) {
  if (!reward || reward.status !== 'active') return 'GYM_REWARD_UNAVAILABLE';
  return balance < reward.points ? 'GYM_POINTS_SHORT' : null;
}

const NOTICE_SEGMENTS = Object.freeze(['active', 'expiring', 'expired', 'not_seen', 'package', 'class']);

/** M27-FR-62: a notice segment is complete and within the limits → null or the code. */
function segmentBlock(segment, { daysMax }) {
  if (!NOTICE_SEGMENTS.includes(segment.kind)) return 'GYM_NOTICE_SEGMENT';
  if (['expiring', 'expired', 'not_seen'].includes(segment.kind)) {
    return Number.isInteger(segment.days) && segment.days >= 1 && segment.days <= daysMax ? null : 'GYM_NOTICE_SEGMENT';
  }
  if (segment.kind === 'package') return segment.packageId ? null : 'GYM_NOTICE_SEGMENT';
  if (segment.kind === 'class') return segment.classId ? null : 'GYM_NOTICE_SEGMENT';
  return null;
}


// ---------------------------------------------------------------- round 3: staff attendance (M27-FR-72..75)

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** M27-FR-72: a shift is a day of the week and a start before its end (no overnight shifts in v1) → null or the code. */
function shiftBlock({ dow, startTime, endTime }) {
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) return 'GYM_SHIFT_TIMES';
  if (!HHMM.test(startTime ?? '') || !HHMM.test(endTime ?? '')) return 'GYM_SHIFT_TIMES';
  return minutesOf(endTime) > minutesOf(startTime) ? null : 'GYM_SHIFT_TIMES';
}

/** M27-FR-73: the next clock of a staff member: in after nothing or an out, out after an in. */
const nextClockKind = (last) => (last && last.kind === 'in' ? 'out' : 'in');

/**
 * M27-FR-75: clock rows of one staff member (oldest first) → intervals { inAt, outAt, auto }. An out with no
 * in before it is ignored; a last in with no out is open (outAt null).
 */
function clockIntervals(rows) {
  const out = [];
  let open = null;
  for (const r of rows) {
    if (r.kind === 'in') {
      if (open) out.push({ inAt: open.at, outAt: null, auto: false });
      open = r;
    } else if (open) {
      out.push({ inAt: open.at, outAt: r.at, auto: r.method === 'auto' });
      open = null;
    }
  }
  if (open) out.push({ inAt: open.at, outAt: null, auto: false });
  return out;
}

/** Minutes worked: closed intervals only; an auto-closed one counts nothing (nobody knows when they left). */
const workedMinutes = (intervals) => intervals.reduce((n, x) => (x.outAt && !x.auto ? n + Math.max(0, Math.floor((new Date(x.outAt) - new Date(x.inAt)) / 60000)) : n), 0);

/** Minutes after midnight in Dhaka of an instant. */
const dhakaMinutes = (at) => Math.floor(((new Date(at).getTime() + DHAKA_OFFSET_MS) % DAY_MS) / 60000);

// ---------------------------------------------------------------- holidays and special hours (M20-FR-20, FR-22)

const clockMin = (hhmm) => (hhmm === '24:00' ? 1440 : minutesOf(hhmm));
/** Is a Dhaka minute of the day outside what a special day leaves open? Closed: always; changed hours: outside its windows. */
const outsideSpecialDay = (day, minute) => day.kind === 'closed' || !day.windows.some((w) => minute >= clockMin(w.openTime) && minute < clockMin(w.closeTime));
/** The special day (of a list) that leaves a date and minute shut, or null. */
const shutBy = (specialDays, date, minute) => specialDays.find((d) => d.fromOn <= date && date <= d.toOn && outsideSpecialDay(d, minute)) ?? null;
/** The dates within [from, to] that holidays close for the whole day. */
function closedDates(specialDays, from, to) {
  const out = new Set();
  for (const d of specialDays) if (d.kind === 'closed') for (let x = d.fromOn < from ? from : d.fromOn; x <= d.toOn && x <= to; x = addDays(x, 1)) out.add(x);
  return out;
}
/** The reason everyone booked reads when a special day cancels a class session. */
const specialDayReason = (day) => `${day.kind === 'closed' ? 'The gym is closed' : 'The gym’s hours changed'}: ${day.title}`.slice(0, 300);

/**
 * M27-FR-74: late and missed shifts of one staff member over [from, to]. A shift is late when the first
 * clock-in of its date is more than graceMinutes after its start; missed when its date is before today and
 * there was no clock-in that date. Shifts on dates from today on are neither. One clock-in covers every
 * shift of its date. A date the gym was closed for a holiday (`closed`, M20-FR-22) has no late or missed shift.
 */
function shiftMarks({ shifts, times, from, to, today, graceMinutes, closed = new Set() }) {
  const firstIn = new Map();
  for (const t of times) if (t.kind === 'in' && (!firstIn.has(t.localDate) || new Date(t.at) < new Date(firstIn.get(t.localDate)))) firstIn.set(t.localDate, t.at);
  let late = 0;
  let missed = 0;
  for (let d = from; d <= to && d < today; d = addDays(d, 1)) {
    if (closed.has(d)) continue;
    const dow = dowOf(d);
    for (const sh of shifts) {
      if (sh.dow !== dow) continue;
      const first = firstIn.get(d);
      if (!first) missed += 1;
      else if (dhakaMinutes(first) > minutesOf(sh.startTime) + graceMinutes) late += 1;
    }
  }
  return { late, missed };
}

// ---------------------------------------------------------------- round 3: payroll (M27-FR-76..81)

/** "2026-11" → { from: '2026-11-01', to: '2026-11-30' }. */
const periodRange = (period) => ({ from: `${period}-01`, to: lastOfMonth(`${period}-01`) });

/** M27-FR-77: a payroll month is valid and not after the current one → null or the code. */
const periodBlock = (period, today) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(period ?? '') && period <= today.slice(0, 7) ? null : 'GYM_PAYROLL_PERIOD');

// ---------------------------------------------------------------- conversion report (M27-FR-87 to FR-91)

/** The month a conversion report covers: "YYYY-MM", today's month when missing, malformed or in the future. */
function conversionPeriod(month, today) {
  const m = /^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '') && month <= today.slice(0, 7) ? month : today.slice(0, 7);
  return { month: m, ...periodRange(m) };
}

/** A share in percent with one decimal, or null when there is nothing to divide by. */
const sharePct = (part, whole) => (whole > 0 ? Math.round((part * 1000) / whole) / 10 : null);

/**
 * M27-FR-88: the report from its counts. Each group is the people who came in during the month and what became
 * of them by today. Joined %: enquiries that joined of those received; visits that became members of those not
 * cancelled; join requests accepted of those received. A group the plan lacks is null.
 */
function conversionReport({ period, today, leads, visits, joinRequests, members }) {
  return {
    period,
    today,
    enquiries: leads ? { ...leads, joinedPct: sharePct(leads.joined, leads.received) } : null,
    visits: visits ? { ...visits, joinedPct: sharePct(visits.joined, visits.booked - visits.cancelled) } : null,
    joinRequests: { ...joinRequests, joinedPct: sharePct(joinRequests.accepted, joinRequests.received) },
    members,
  };
}

/** M27-FR-91: the report as CSV rows [group, stage, count]: counts only, no names and no phones. */
function conversionRows(r) {
  const rows = [];
  const group = (name, o, stages) => o && stages.forEach(([label, key]) => rows.push([name, label, o[key]]));
  group('Enquiries', r.enquiries, [['Received', 'received'], ['Still new', 'open'], ['Contacted', 'contacted'], ['Joined', 'joined'], ['Lost', 'lost']]);
  group('Trial visits', r.visits, [['Booked', 'booked'], ['Attended', 'attended'], ['Missed', 'missed'], ['Cancelled', 'cancelled'], ['Still to come', 'waiting'], ['Became members', 'joined']]);
  group('Join requests', r.joinRequests, [['Received', 'received'], ['Accepted', 'accepted'], ['Declined, expired or cancelled', 'closed'], ['Waiting', 'waiting']]);
  rows.push(['New members', 'All', r.members.total], ['New members', 'Added at the desk', r.members.bySource.desk], ['New members', 'From Kriraghor', r.members.bySource.platform], ['New members', 'Imported', r.members.bySource.import]);
  rows.push(['New members', 'Came from a trial visit', r.members.fromVisit], ['New members', 'Came from an enquiry', r.members.fromEnquiry]);
  return rows;
}

/** A commission: base × bps ÷ 10000, rounded half up to the poisha. */
const commissionOf = (base, bps) => Math.floor((base * bps + 5000) / 10000);

/** M27-FR-76: pay terms within the limits → null or the code. */
function payTermsBlock({ basePoisha, ptCommissionBps, salesCommissionBps }, { salaryMax, commissionMax }) {
  if (!Number.isInteger(basePoisha) || basePoisha < 0 || basePoisha > salaryMax) return 'GYM_AMOUNT_OUT_OF_RANGE';
  for (const bps of [ptCommissionBps, salesCommissionBps]) if (!Number.isInteger(bps) || bps < 0 || bps > commissionMax) return 'GYM_COMMISSION_OUT_OF_RANGE';
  return null;
}

/**
 * M27-FR-78: one payroll line from the terms and the month's facts → the amounts. Net = base + the two
 * commissions + bonus − deduction; a deduction larger than the rest is refused by lineBlock.
 */
function payrollLine({ basePoisha, ptCommissionBps, salesCommissionBps, ptBasePoisha, salesBasePoisha, bonusPoisha = 0, deductionPoisha = 0 }) {
  const ptCommissionPoisha = commissionOf(ptBasePoisha, ptCommissionBps);
  const salesCommissionPoisha = commissionOf(salesBasePoisha, salesCommissionBps);
  const netPoisha = basePoisha + ptCommissionPoisha + salesCommissionPoisha + bonusPoisha - deductionPoisha;
  return { basePoisha, ptBasePoisha, ptCommissionBps, ptCommissionPoisha, salesBasePoisha, salesCommissionBps, salesCommissionPoisha, bonusPoisha, deductionPoisha, netPoisha };
}

/** M27-FR-78: a bonus or deduction within the limit, and a net that is not negative → null or the code. */
function lineBlock({ bonusPoisha, deductionPoisha, netPoisha }, { adjustMax }) {
  for (const v of [bonusPoisha, deductionPoisha]) if (!Number.isInteger(v) || v < 0 || v > adjustMax) return 'GYM_AMOUNT_OUT_OF_RANGE';
  return netPoisha < 0 ? 'GYM_PAYROLL_NEGATIVE' : null;
}

/** M27-FR-80: the run's state once a line is paid: paid when every line with money is paid. */
const runPaid = (lines) => lines.every((l) => l.status === 'paid' || l.netPoisha === 0);

// ---------------------------------------------------------------- round 3: equipment (M27-FR-82..86)

const ASSET_CATEGORIES = Object.freeze(['cardio', 'strength', 'free_weight', 'bench_rack', 'accessory', 'electrical', 'furniture', 'other']);
const ASSET_STATUSES = Object.freeze(['working', 'needs_service', 'out_of_order', 'retired']);

/** M27-FR-83: the next service date from the last one (or the purchase, or today) and the interval; none without one. */
const nextServiceOn = ({ every, lastServiceOn, boughtOn, today }) => (every ? addDays(lastServiceOn ?? boughtOn ?? today, every) : null);

/** M27-FR-85: remind once per due date, alertDays ahead, for machines still in use. */
function serviceAlertDue({ status, nextServiceOn: next, serviceAlertedOn }, { today, alertDays }) {
  if (!next || status === 'retired') return false;
  if (serviceAlertedOn === next) return false;
  return next <= addDays(today, alertDays);
}

module.exports = {
  trendMonths,
  shiftBlock,
  nextClockKind,
  clockIntervals,
  workedMinutes,
  dhakaMinutes,
  minutesOf,
  outsideSpecialDay,
  shutBy,
  closedDates,
  specialDayReason,
  shiftMarks,
  periodRange,
  conversionPeriod,
  sharePct,
  conversionReport,
  conversionRows,
  periodBlock,
  commissionOf,
  payTermsBlock,
  payrollLine,
  lineBlock,
  runPaid,
  ASSET_CATEGORIES,
  ASSET_STATUSES,
  nextServiceOn,
  serviceAlertDue,
  sessionWindow,
  dowOf,
  datesAhead,
  bookingOutcome,
  sessionBookBlock,
  cancelBlock,
  classReminderDue,
  streakBonusDue,
  pointsToExpire,
  redeemBlock,
  NOTICE_SEGMENTS,
  segmentBlock,
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
