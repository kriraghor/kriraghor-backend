'use strict';

/**
 * Shared bits of M09: the error catalogue (§9 codes), the limits read from settings (§6.2, v3), the
 * default rules of a first pricing version, catalogue lookups (M03 rows, read-only) and serializers.
 */
const { Op } = require('sequelize');
const { AppError, E } = require('../../common/errors');
const storage = require('../../common/storage');
const { Ground, Court, CourtHours, GroundPhoto, PricingRule, Area, District, Sport, Surface, Facility, AREA_FLAGS } = require('../../models');
const settings = require('../settings/settings.service');

const ERRORS = {
  NOT_OWNER: [403, 'This venue belongs to another owner'],
  GROUND_STATE: [409, 'The venue cannot do that in its current state'],
  GROUND_IN_REVIEW: [409, 'Staff are reviewing this venue. Wait for the decision, or withdraw it'],
  GROUND_INCOMPLETE: [422, 'Finish the listing before sending it for review'],
  NOTHING_TO_REVIEW: [409, 'There are no changes that need review'],
  AREA_NOT_SERVED: [422, 'Choose a Dhaka area where venues are listed'],
  CATALOG_ITEM_UNKNOWN: [422, 'Choose items from the list'],
  COURT_HAS_BOOKINGS: [409, 'This court has upcoming bookings. Move or cancel them first'],
  LAST_COURT: [409, 'A live venue needs at least one court'],
  HOURS_CONFLICT: [409, 'Upcoming bookings fall outside these hours'],
  PHOTO_LIMIT: [409, 'This venue has the most photos allowed'],
  PHOTOS_MISMATCH: [422, 'Send every photo of the venue, in the new order'],
  FILE_EMPTY: [422, 'The file is empty'],
  FILE_TOO_LARGE: [413, 'The photo is too large'],
  FILE_TYPE_NOT_ALLOWED: [415, 'Upload a JPEG, PNG or WebP photo'],
  FILE_TYPE_MISMATCH: [415, 'The file is not the type it says it is'],
  PRICING_DRAFT_MISSING: [409, 'There is no draft to publish'],
  PRICING_MISSING: [409, 'This venue has no published prices yet'],
  LENGTH_INVALID: [422, 'Choose a length the venue allows'],
  OUTSIDE_HOURS: [422, 'The venue is closed for part of that time'],
  COURT_UNKNOWN: [422, 'Choose courts of this venue'],
  NOT_COMBINABLE: [422, 'These courts cannot be booked together'],
  // step 2: closures and series (§9)
  NOT_HALF_HOUR: [422, 'Times start on the hour or half-hour'],
  CLOSURE_EMPTY: [422, 'The closure must end after it starts'],
  CLOSURE_IN_PAST: [422, 'The closure has already ended'],
  OUT_OF_RANGE: [422, 'That date is too far ahead'],
  CLOSURE_CLASHES: [409, 'Bookings or closures already use some of this time. Move or cancel them first'],
  CLOSURE_STATE: [409, 'The closure cannot do that now'],
  REASON_NOT_ALLOWED: [403, 'Only Kriraghor staff can use this reason'],
  SERIES_WEEKS_INVALID: [422, 'Choose one of the series lengths offered'],
  SERIES_DAY_MISMATCH: [422, 'The first date must fall on the chosen weekday'],
  SERIES_CLASHES: [409, 'Some weeks are already taken. Skip them or choose another time'],
  SERIES_STATE: [409, 'The series cannot do that now'],
  GROUND_NOT_BOOKABLE: [409, 'The venue must be live to take series bookings'],
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta);

/** §6.2 limits that come from settings (M03), with the v3 rule advance ≥ fee. */
function limits() {
  return {
    baseMin: settings.get('ground.base_price_min_poisha'),
    baseMax: settings.get('ground.base_price_max_poisha'),
    peakMax: settings.get('ground.peak_pct_max'),
    weekendMax: settings.get('ground.weekend_pct_max'),
    earlyMax: settings.get('ground.early_pct_max'),
    advanceMin: settings.get('booking.advance_pct_min'),
    advanceMax: settings.get('booking.advance_pct_max'),
    feePct: settings.get('fees.ground_booking_pct'),
    seriesMax: settings.get('booking.series_discount_pct_max'),
    minLengthOptions: settings.get('booking.min_length_options_min'),
  };
}

/** Defaults of a first pricing version (§6.2 design defaults, the v3 advance default). */
function defaultRules(basePricePoisha) {
  return {
    basePricePoisha,
    courtBaseOverrides: {},
    peakFromHour: 17,
    peakPct: 25,
    weekendPct: Math.min(15, settings.get('ground.weekend_pct_max')),
    earlyToHour: 8,
    earlyPct: 20,
    advancePct: settings.get('booking.advance_pct_default'),
    seriesDiscountPct: Math.min(10, settings.get('booking.series_discount_pct_max')),
    minBookingMin: settings.get('booking.min_length_options_min')[0],
    fullRefundHours: settings.get('booking.refund_full_hours_default'),
    halfRefundHours: settings.get('booking.refund_half_hours_default'),
    checkinGraceMin: settings.get('booking.checkin_grace_min_default'),
  };
}

const RULE_FIELDS = [
  'basePricePoisha',
  'courtBaseOverrides',
  'peakFromHour',
  'peakPct',
  'weekendPct',
  'earlyToHour',
  'earlyPct',
  'advancePct',
  'seriesDiscountPct',
  'minBookingMin',
  'fullRefundHours',
  'halfRefundHours',
  'checkinGraceMin',
];
const rulesOf = (row) => Object.fromEntries(RULE_FIELDS.map((k) => [k, row[k]]));

/** The bookable day (booking.grid_open–grid_close, §6.3). */
const grid = () => ({ open: settings.get('booking.grid_open'), close: settings.get('booking.grid_close') });

// ---------------------------------------------------------------- catalogue lookups (M03)

/** An active area where grounds are listed (Dhaka metro, Q15). */
async function groundArea(areaId, { transaction } = {}) {
  const a = await Area.findByPk(areaId, { transaction });
  if (!a || !a.isActive || (a.serviceFlags & AREA_FLAGS.GROUNDS) === 0) throw fail('AREA_NOT_SERVED');
  return a;
}

/** All ids must be active rows of the model (sports must also be ground sports). */
async function activeIds(Model, ids, field, { transaction, flag } = {}) {
  const unique = [...new Set(ids)];
  if (!unique.length) return unique;
  const rows = await Model.findAll({ where: { id: unique, isActive: true }, transaction });
  if (rows.length !== unique.length || (flag && rows.some((r) => (r.verticalFlags & flag) === 0))) throw fail('CATALOG_ITEM_UNKNOWN', { errors: [{ field, message: 'Choose items from the list' }] });
  return unique;
}

/** Names for display: areas (with district), sports, surfaces, facilities, keyed by id. */
async function catalogueNames({ areaIds = [], sportIds = [], surfaceIds = [], facilityIds = [] }) {
  const named = (r) => ({ id: r.id, key: r.key, nameEn: r.nameEn, nameBn: r.nameBn });
  const [areas, sports, surfaces, facilities] = await Promise.all([
    areaIds.length ? Area.findAll({ where: { id: [...new Set(areaIds)] }, include: [{ model: District, as: 'district' }] }) : [],
    sportIds.length ? Sport.findAll({ where: { id: [...new Set(sportIds)] } }) : [],
    surfaceIds.length ? Surface.findAll({ where: { id: [...new Set(surfaceIds)] } }) : [],
    facilityIds.length ? Facility.findAll({ where: { id: [...new Set(facilityIds)] }, order: [['sort', 'ASC']] }) : [],
  ]);
  return {
    areas: new Map(areas.map((a) => [a.id, { ...named(a), lat: a.lat, lng: a.lng, district: a.district ? named(a.district) : null }])),
    sports: new Map(sports.map((s) => [s.id, { ...named(s), icon: s.icon }])),
    surfaces: new Map(surfaces.map((s) => [s.id, named(s)])),
    facilities: new Map(facilities.map((f) => [f.id, { ...named(f), icon: f.icon }])),
  };
}

// ---------------------------------------------------------------- loading and serializing

const ACTIVE_COURTS = { status: { [Op.ne]: 'retired' } };

/** The working copy: ground, active photos, non-retired courts with their hours. */
async function loadWorking(groundId, { transaction } = {}) {
  const ground = await Ground.findByPk(groundId, { transaction });
  if (!ground) return null;
  const [photos, courts] = await Promise.all([
    GroundPhoto.findAll({ where: { groundId, status: 'active' }, order: [['sort', 'ASC'], ['createdAt', 'ASC']], transaction }),
    Court.findAll({ where: { groundId, ...ACTIVE_COURTS }, order: [['sort', 'ASC'], ['createdAt', 'ASC']], transaction }),
  ]);
  const hours = courts.length ? await CourtHours.findAll({ where: { courtId: courts.map((c) => c.id) }, order: [['dow', 'ASC']], transaction }) : [];
  return { ground, photos, courts, hours };
}

const hoursOf = (hours, courtId) => hours.filter((h) => h.courtId === courtId).map((h) => ({ dow: h.dow, isClosed: h.isClosed, openTime: h.openTime, closeTime: h.closeTime }));
const photoView = (p) => ({ id: p.id, url: storage.publicUrl(p.storageKey), sort: p.sort });
const courtView = (c, hours) => ({
  id: c.id,
  name: c.name,
  sportIds: c.sportIds,
  surfaceId: c.surfaceId,
  sizeText: c.sizeText ?? null,
  capacityText: c.capacityText ?? null,
  combinableGroup: c.combinableGroup ?? null,
  sort: c.sort,
  status: c.status,
  hours: hoursOf(hours, c.id),
});

/** The fields of the public version (live_snapshot), built from the working copy at approval. */
function snapshotOf({ ground: g, photos, courts }, version) {
  return {
    version,
    name: g.name,
    areaId: g.areaId,
    addressLine: g.addressLine,
    lat: g.lat,
    lng: g.lng,
    isIndoor: g.isIndoor,
    description: g.description ?? null,
    rulesText: g.rulesText ?? null,
    facilityIds: g.facilityIds,
    bookingCutoffMin: g.bookingCutoffMin,
    requiresOfficial: g.requiresOfficial,
    photos: photos.map((p) => ({ id: p.id, key: p.storageKey })),
    courts: courts.map((c) => ({
      id: c.id,
      name: c.name,
      sportIds: c.sportIds,
      surfaceId: c.surfaceId,
      sizeText: c.sizeText ?? null,
      capacityText: c.capacityText ?? null,
      combinableGroup: c.combinableGroup ?? null,
      sort: c.sort,
    })),
  };
}

/** The working copy in the shape reviewDiff compares (ids for photos and courts). */
const workingShape = (w) => ({ ...snapshotOf(w, null), photos: w.photos.map((p) => ({ id: p.id })) });

/** The owner's view of their ground. */
function ownerView(w, { published = null, draft = null } = {}) {
  const g = w.ground;
  return {
    id: g.id,
    slug: g.slug,
    name: g.name,
    areaId: g.areaId,
    addressLine: g.addressLine,
    lat: g.lat,
    lng: g.lng,
    isIndoor: g.isIndoor,
    description: g.description ?? null,
    rulesText: g.rulesText ?? null,
    facilityIds: g.facilityIds,
    bookingCutoffMin: g.bookingCutoffMin,
    requiresOfficial: g.requiresOfficial,
    status: g.status,
    editStatus: g.editStatus ?? null,
    liveVersion: g.liveVersion,
    reviewReason: g.reviewReasonCode ? { code: g.reviewReasonCode, text: g.reviewReasonText ?? null } : null,
    firstLiveAt: g.firstLiveAt ?? null,
    photos: w.photos.map(photoView),
    courts: w.courts.map((c) => courtView(c, w.hours)),
    pricing: { publishedVersion: published?.version ?? null, basePricePoisha: (published ?? draft)?.basePricePoisha ?? null, hasDraft: Boolean(draft) },
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

/** The principal's own venue (removed venues are gone; another owner's is NOT_OWNER). */
async function owned(principal, groundId, { transaction, lock = false } = {}) {
  const g = await Ground.findByPk(groundId, { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!g || g.status === 'removed') throw E.notFound('Ground');
  if (g.ownerId !== principal.id) throw fail('NOT_OWNER');
  return g;
}

/** Published and draft pricing versions of a ground. */
async function pricingOf(groundId, { transaction } = {}) {
  const rows = await PricingRule.findAll({ where: { groundId, status: ['published', 'draft'] }, transaction });
  return { published: rows.find((r) => r.status === 'published') ?? null, draft: rows.find((r) => r.status === 'draft') ?? null };
}

module.exports = {
  ERRORS,
  fail,
  limits,
  defaultRules,
  RULE_FIELDS,
  rulesOf,
  grid,
  groundArea,
  activeIds,
  catalogueNames,
  ACTIVE_COURTS,
  loadWorking,
  hoursOf,
  photoView,
  courtView,
  snapshotOf,
  workingShape,
  ownerView,
  pricingOf,
  owned,
};
