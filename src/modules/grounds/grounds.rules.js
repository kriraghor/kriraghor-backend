'use strict';

/**
 * M09 pure rules: the ground state machine (§8), which edits of a live ground need review (FR-04),
 * the opening-hours grid (FR-07, §6.3), slugs and the review diff; step 2: closure periods (FR-15)
 * and the weeks of a series (FR-19). No I/O.
 */
const { dhakaInstant, dhakaParts } = require('./pricing.rules');

/** Owner and staff actions on a ground, by the statuses they may start from (§8). */
const TRANSITIONS = {
  submit: { from: ['draft', 'changes_requested', 'withdrawn'], to: 'pending_review' },
  approve: { from: ['pending_review'], to: 'live' },
  request_changes: { from: ['pending_review'], to: 'changes_requested' },
  reject: { from: ['pending_review'], to: 'rejected' },
  withdraw: { from: ['pending_review'], to: 'withdrawn' },
  pause: { from: ['live'], to: 'paused' },
  resume: { from: ['paused'], to: 'live' },
  suspend: { from: ['live', 'paused'], to: 'suspended' },
  restore: { from: ['suspended'], to: 'live' },
  remove: { from: ['live', 'paused', 'suspended', 'rejected', 'withdrawn', 'draft', 'changes_requested'], to: 'removed' },
};
const next = (action, from) => (TRANSITIONS[action].from.includes(from) ? TRANSITIONS[action].to : null);

/** A ground that has been approved at least once: edits run beside the public version. */
const isPublished = (status) => ['live', 'paused', 'suspended'].includes(status);
/** The owner may change the working copy (not while staff review it, not once it is closed). */
const isEditable = (status, editStatus) => !['pending_review', 'rejected', 'removed', 'suspended'].includes(status) && editStatus !== 'pending_review';

/** Edit sub-status of a published ground, after a decision on the edit submission. */
const EDIT_AFTER = { approved: null, changes_requested: 'changes_requested', rejected: 'rejected', withdrawn: 'draft' };

// FR-04: these changes go to review; everything else (description, rules, facilities, cutoff,
// hours, pricing) applies to the live listing at once.
const GROUND_REVIEW_FIELDS = ['name', 'areaId', 'addressLine', 'lat', 'lng', 'isIndoor'];
const COURT_REVIEW_FIELDS = ['name', 'sportIds', 'surfaceId', 'sizeText', 'capacityText', 'combinableGroup'];
const GROUND_LIVE_FIELDS = ['description', 'rulesText', 'facilityIds', 'bookingCutoffMin', 'requiresOfficial'];

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sorted = (a) => [...(a ?? [])].sort();

/** Which review fields a ground patch changes. */
const groundReviewChanges = (current, patch) => GROUND_REVIEW_FIELDS.filter((k) => k in patch && !same(current[k], patch[k]));
/** Which review fields a court patch changes (sports compare as sets). */
const courtReviewChanges = (current, patch) =>
  COURT_REVIEW_FIELDS.filter((k) => k in patch && !(k === 'sportIds' ? same(sorted(current[k]), sorted(patch[k])) : same(current[k], patch[k])));

/**
 * What changed between the public version (snapshot) and the working copy, for the reviewer:
 * ground fields, courts added / changed / removed, photos added / removed.
 */
function reviewDiff(snapshot, working) {
  if (!snapshot) return { first: true, fields: [], courts: [], photos: { added: working.photos.length, removed: 0 } };
  const fields = GROUND_REVIEW_FIELDS.filter((k) => !same(snapshot[k], working[k])).map((k) => ({ field: k, from: snapshot[k] ?? null, to: working[k] ?? null }));
  const oldCourts = new Map(snapshot.courts.map((c) => [c.id, c]));
  const courts = [];
  for (const c of working.courts) {
    const before = oldCourts.get(c.id);
    if (!before) courts.push({ id: c.id, name: c.name, change: 'added' });
    else {
      const changed = courtReviewChanges(before, c);
      if (changed.length) courts.push({ id: c.id, name: c.name, change: 'changed', fields: changed });
    }
  }
  const workingIds = new Set(working.courts.map((c) => c.id));
  for (const c of snapshot.courts) if (!workingIds.has(c.id)) courts.push({ id: c.id, name: c.name, change: 'retired' });
  const oldPhotos = new Set(snapshot.photos.map((p) => p.id));
  const newPhotos = new Set(working.photos.map((p) => p.id));
  return {
    first: false,
    fields,
    courts,
    photos: { added: [...newPhotos].filter((id) => !oldPhotos.has(id)).length, removed: [...oldPhotos].filter((id) => !newPhotos.has(id)).length },
  };
}

/** True when a diff has nothing for the reviewer (the owner changed only non-review fields). */
const diffIsEmpty = (d) => !d.first && !d.fields.length && !d.courts.length && !d.photos.added && !d.photos.removed;

// ---------------------------------------------------------------- hours (FR-07, §6.3)

const toMin = (hhmm) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * A court's weekly hours: one row per weekday (0 = Sunday), each closed or one interval on the
 * half-hour grid inside the bookable day (booking.grid_open–grid_close). Returns errors or null.
 */
function hoursBlock(rows, { open, close }) {
  const errors = [];
  const gridOpen = toMin(open);
  const gridClose = close === '24:00' ? 1440 : toMin(close);
  const seen = new Set();
  for (const [i, r] of rows.entries()) {
    const field = `hours.${i}`;
    if (!Number.isInteger(r.dow) || r.dow < 0 || r.dow > 6 || seen.has(r.dow)) {
      errors.push({ field, message: 'One row per weekday (0 = Sunday … 6 = Saturday)' });
      continue;
    }
    seen.add(r.dow);
    if (r.isClosed) continue;
    const a = toMin(r.openTime);
    const b = r.closeTime === '24:00' ? 1440 : toMin(r.closeTime);
    if (a === null || b === null || a % 30 || b % 30) errors.push({ field, message: 'Times are on the half hour' });
    else if (a < gridOpen || b > gridClose) errors.push({ field, message: `Between ${open} and ${close}` });
    else if (b <= a) errors.push({ field, message: 'Closing time must be after opening time' });
  }
  if (!errors.length && seen.size !== 7) errors.push({ field: 'hours', message: 'Give all seven weekdays (closed days too)' });
  return errors.length ? errors : null;
}

/** Is the half-hour starting at `minute` (Dhaka, minutes after midnight) inside a day's hours? */
function isOpenAt(row, minute) {
  if (!row || row.isClosed) return false;
  const close = row.closeTime === '24:00' ? 1440 : toMin(row.closeTime);
  return minute >= toMin(row.openTime) && minute + 30 <= close;
}

/** A court has hours on at least one day (an automatic check on submit, FR-02). */
const hasOpenDay = (rows) => rows.some((r) => !r.isClosed);

// ---------------------------------------------------------------- slugs

/** URL slug from a name and area: "Dhanmondi Turf Arena" → "dhanmondi-turf-arena". */
function slugify(name, area) {
  const base = `${name} ${area && !name.toLowerCase().includes(area.toLowerCase()) ? area : ''}`
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'ground';
}

/** Great-circle distance in metres (the duplicate check and "nearest" sort). */
function distanceM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

// ---- Step 2: closures and series (§4.2, §4.3) ----

const HALF_HOUR_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const t = (v) => new Date(v).getTime();

/** FR-15: a closure is half-hour aligned, ends in the future and starts within the horizon (Q63). */
function closureBlock({ start, end, now, maxDaysAhead }) {
  if (t(start) % HALF_HOUR_MS !== 0 || t(end) % HALF_HOUR_MS !== 0) return 'NOT_HALF_HOUR';
  if (t(end) <= t(start)) return 'CLOSURE_EMPTY';
  if (t(end) <= t(now)) return 'CLOSURE_IN_PAST';
  if (t(start) > t(now) + maxDaysAhead * DAY_MS) return 'OUT_OF_RANGE';
  return null;
}

/** Closure state for reopen (upcoming) and end now (in progress); past closures are read-only. */
function closurePhase({ start, end, now }) {
  if (t(now) < t(start)) return 'upcoming';
  return t(now) < t(end) ? 'in_progress' : 'past';
}

/** FR-19: the series shape. firstDate must fall on the chosen Dhaka weekday, today or later. */
function seriesBlock({ firstDate, dow, startTime, lengthMin, weeks, weeksOptions, minBookingMin, today }) {
  if (!weeksOptions.includes(weeks)) return 'SERIES_WEEKS_INVALID';
  if (![60, 90, 120, 180].includes(lengthMin) || lengthMin < minBookingMin) return 'LENGTH_INVALID';
  if (!/^([01][0-9]|2[0-3]):(00|30)$/.test(startTime)) return 'NOT_HALF_HOUR';
  if (firstDate < today) return 'OUT_OF_RANGE';
  if (dhakaParts(dhakaInstant(firstDate, 12 * 60)).dow !== dow) return 'SERIES_DAY_MISMATCH';
  return null;
}

/** The start and end of every week of a series, computed on the Dhaka wall clock. */
function seriesWeeks({ firstDate, startTime, lengthMin, weeks }) {
  return Array.from({ length: weeks }, (_, week) => {
    const date = new Date(Date.parse(`${firstDate}T00:00:00Z`) + week * 7 * DAY_MS).toISOString().slice(0, 10);
    const start = dhakaInstant(date, toMin(startTime));
    return { week, date, start, end: new Date(start.getTime() + lengthMin * 60 * 1000) };
  });
}

module.exports = {
  closureBlock,
  closurePhase,
  seriesBlock,
  seriesWeeks,
  TRANSITIONS,
  next,
  isPublished,
  isEditable,
  EDIT_AFTER,
  GROUND_REVIEW_FIELDS,
  COURT_REVIEW_FIELDS,
  GROUND_LIVE_FIELDS,
  groundReviewChanges,
  courtReviewChanges,
  reviewDiff,
  diffIsEmpty,
  toMin,
  toHHMM,
  hoursBlock,
  isOpenAt,
  hasOpenDay,
  slugify,
  distanceM,
};
