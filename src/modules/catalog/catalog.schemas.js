'use strict';

const { z } = require('zod');

const dateTime = z.iso.datetime({ offset: true });
const TABLES = ['esports-games', 'esports-modes', 'esports-maps', 'esports-points-presets', 'sports', 'divisions', 'districts', 'areas', 'facilities', 'surfaces', 'item-categories', 'item-types', 'item-type-fields', 'hire-categories', 'hire-roles'];

const key = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Lowercase letters, digits and _ (like squad)');
const names = {
  nameEn: z.string().trim().min(1).max(80),
  nameBn: z.string().trim().min(1).max(80),
  sort: z.number().int().min(-1000).max(1000).optional(),
};

const platform = z.enum(['mobile', 'pc', 'console']);
const game = z.object({
  key,
  ...names,
  publisher: z.string().trim().max(80).nullable().optional(),
  platform,
  uidLabelEn: z.string().trim().min(1).max(40),
  uidLabelBn: z.string().trim().min(1).max(40),
  uidRegex: z.string().min(3).max(120),
  ignMaxLen: z.number().int().min(3).max(40),
  icon: z.string().trim().max(255).nullable().optional(),
});

const mode = z.object({
  gameId: z.uuid(),
  key,
  ...names,
  teamSize: z.number().int().min(1).max(10),
  maxTeams: z.number().int().min(1).max(200),
  maxPlayers: z.number().int().min(1).max(1000),
  maxSubs: z.number().int().min(0).max(5),
});

const map = z.object({ gameId: z.uuid(), key, ...names });

const preset = z.object({
  gameId: z.uuid(),
  key,
  ...names,
  placementPoints: z.array(z.number().int().min(0).max(1000)).min(1).max(200).meta({ description: 'Index 0 is 1st place' }),
  killPoints: z.number().int().min(0).max(100),
});

// ---- M03 §6.1, §6.3: sports and places ----
const lat = z.number().min(20).max(27);
const lng = z.number().min(88).max(93);
const sport = z.object({
  key,
  ...names,
  engine: z.enum(['ball_by_ball', 'clock', 'rally', 'none']),
  officialLabelEn: z.string().trim().max(40).nullable().optional(),
  officialLabelBn: z.string().trim().max(40).nullable().optional(),
  defaultTiebreakers: z.array(z.string().regex(/^[a-z_]{2,40}$/)).max(10).optional(),
  verticalFlags: z.number().int().min(0).max(1023).meta({ description: 'Bits: 1 grounds, 2 hire, 4 market, 8 tournaments, 16 gyms' }),
  icon: z.string().trim().max(40).nullable().optional(),
  tint: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
});
const division = z.object({ key, ...names, bbsCode: z.string().regex(/^[0-9]{2}$/) });
const district = z.object({ key, ...names, divisionId: z.uuid(), bbsCode: z.string().regex(/^[0-9]{4}$/), lat: lat.nullable().optional(), lng: lng.nullable().optional() });
const area = z.object({
  key,
  ...names,
  districtId: z.uuid(),
  parentAreaId: z.uuid().nullable().optional(),
  lat,
  lng,
  isDhakaMetro: z.boolean(),
  dhakaZone: z.enum(['north', 'south']).nullable().optional(),
  aliases: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  serviceFlags: z.number().int().min(0).max(1023).meta({ description: 'Bits: 1 grounds listing, 2 delivery' }),
});
const facility = z.object({ key, ...names, icon: z.string().trim().max(40).nullable().optional() });
const surface = z.object({ key, ...names, indoorTypical: z.boolean() });

// ---- M03 §7 item catalogue (M12; Q77) ----
const label = z.string().trim().min(1).max(80);
const itemCategory = z.object({
  key,
  ...names,
  sportKey: z.string().regex(/^[a-z_]{2,40}$/).nullable().optional(),
  shopTypes: z.array(z.string().regex(/^[a-z_]{2,40}$/)).min(1).max(10).meta({ description: 'Shop types that may sell in this category (market.shop_types)' }),
  isSupplement: z.boolean().optional().meta({ description: 'Products need importer or BSTI details and per-variant expiry (v3)' }),
  icon: z.string().trim().max(40).nullable().optional(),
});
const itemType = z.object({
  key,
  ...names,
  categoryId: z.uuid(),
  priceFloorPoisha: z.number().int().positive(),
  priceCeilingPoisha: z.number().int().positive(),
  placeholderEn: z.string().trim().max(120).nullable().optional(),
  placeholderBn: z.string().trim().max(120).nullable().optional(),
});
const itemTypeField = z.object({
  itemTypeId: z.uuid(),
  key,
  labelEn: label,
  labelBn: label,
  kind: z.enum(['select', 'number', 'text', 'date']),
  options: z.array(z.object({ value: z.string().trim().min(1).max(40), labelEn: label, labelBn: label })).max(60).optional(),
  unit: z.string().trim().max(16).nullable().optional(),
  minValue: z.number().nullable().optional(),
  maxValue: z.number().nullable().optional(),
  required: z.boolean().optional(),
  isVariantAxis: z.boolean().optional().meta({ description: 'Each variant of a product picks one option (size, flavour)' }),
  sort: z.number().int().min(-1000).max(1000).optional(),
});

const hireCategory = z.object({
  key,
  ...names,
  code: z.string().regex(/^\d{2}$/, 'Two digits, like 03'),
  forRole: z.enum(['player', 'pro']).meta({ description: 'Who lists in it: players (category 01) or pros' }),
  tint: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
});
const hireRole = z.object({
  key,
  ...names,
  categoryId: z.uuid(),
  sportKeys: z.array(z.string().regex(/^[a-z_]{2,40}$/)).max(10).optional(),
  allowedUnits: z.array(z.enum(['hourly', 'match'])).min(1).max(2),
  formatPriced: z.boolean().optional(),
  formats: z.array(z.enum(['T10', 'T20', 'OD', 'TAPE'])).max(4).optional(),
  baseHourlyPoisha: z.number().int().positive().meta({ description: 'The base the rate limits come from (hire.rate_band, Q74)' }),
  specialisations: z.array(z.object({ key, labelEn: label, labelBn: label })).max(20).optional(),
  credentialTiers: z.array(z.object({ level: z.enum(['amateur', 'semi_pro', 'pro', 'national']), labelEn: label, labelBn: label })).max(4).optional(),
  requiresCredential: z.boolean().optional(),
  policeCheckForU16: z.boolean().optional(),
  isOfficial: z.boolean().optional().meta({ description: 'A match official (umpire, referee, scorer)' }),
});

/** PATCH bodies: everything optional; key and gameId may be sent but must not change. */
const patch = (schema) => schema.partial().refine((b) => Object.keys(b).length > 0, 'Nothing to change');

const CREATE = { 'esports-games': game, 'esports-modes': mode, 'esports-maps': map, 'esports-points-presets': preset, sports: sport, divisions: division, districts: district, areas: area, facilities: facility, surfaces: surface, 'item-categories': itemCategory, 'item-types': itemType, 'item-type-fields': itemTypeField, 'hire-categories': hireCategory, 'hire-roles': hireRole };
const UPDATE = Object.fromEntries(Object.entries(CREATE).map(([t, sch]) => [t, patch(sch)]));

// ---------------- responses ----------------
const base = { id: z.uuid(), key: z.string(), nameEn: z.string(), nameBn: z.string(), sort: z.number().int(), isActive: z.boolean(), updatedAt: dateTime.nullable() };
const EsportsMode = z.object({ ...base, gameId: z.uuid(), teamSize: z.number().int(), maxTeams: z.number().int(), maxPlayers: z.number().int(), maxSubs: z.number().int() }).meta({ id: 'EsportsMode' });
const EsportsMap = z.object({ ...base, gameId: z.uuid() }).meta({ id: 'EsportsMap' });
const EsportsPointsPreset = z
  .object({ ...base, gameId: z.uuid(), placementPoints: z.array(z.number().int()), killPoints: z.number().int(), version: z.number().int(), isLatest: z.boolean() })
  .meta({ id: 'EsportsPointsPreset' });
const EsportsGame = z
  .object({
    ...base,
    publisher: z.string().nullable(),
    platform: z.enum(['mobile', 'pc', 'console']),
    uidLabelEn: z.string(),
    uidLabelBn: z.string(),
    uidRegex: z.string(),
    ignMaxLen: z.number().int(),
    icon: z.string().nullable(),
  })
  .meta({ id: 'EsportsGame' });
const EsportsGameWithChildren = EsportsGame.extend({ modes: z.array(EsportsMode), maps: z.array(EsportsMap), presets: z.array(EsportsPointsPreset) }).meta({ id: 'EsportsGameCatalog' });
const placeBase = { id: z.uuid(), key: z.string(), nameEn: z.string(), nameBn: z.string(), sort: z.number().int() };
const Sport = z
  .object({ ...placeBase, engine: z.string(), officialLabelEn: z.string().nullable(), officialLabelBn: z.string().nullable(), defaultTiebreakers: z.array(z.string()), verticalFlags: z.number().int(), icon: z.string().nullable(), tint: z.string().nullable() })
  .meta({ id: 'Sport' });
const District = z.object({ ...placeBase, divisionId: z.uuid(), bbsCode: z.string(), lat: z.number().nullable(), lng: z.number().nullable() }).meta({ id: 'District' });
const Division = z.object({ ...placeBase, bbsCode: z.string(), districts: z.array(District) }).meta({ id: 'DivisionWithDistricts' });
const Area = z
  .object({ ...placeBase, districtId: z.uuid(), parentAreaId: z.uuid().nullable(), lat: z.number(), lng: z.number(), isDhakaMetro: z.boolean(), dhakaZone: z.enum(['north', 'south']).nullable(), aliases: z.array(z.string()), serviceFlags: z.number().int() })
  .meta({ id: 'Area' });
const Facility = z.object({ ...placeBase, icon: z.string().nullable() }).meta({ id: 'Facility' });
const Surface = z.object({ ...placeBase, indoorTypical: z.boolean() }).meta({ id: 'Surface' });
const list = (item, id) => z.object({ items: z.array(item) }).meta({ id });
const CatalogItem = z.union([EsportsGame, EsportsMode, EsportsMap, EsportsPointsPreset, z.looseObject({ ...base })]);

module.exports = {
  TABLES,
  CREATE,
  UPDATE,
  tableParam: z.object({ table: z.enum(TABLES) }),
  tableIdParam: z.object({ table: z.enum(TABLES), id: z.uuid() }),
  listQuery: z.object({ gameId: z.uuid().optional(), divisionId: z.uuid().optional(), districtId: z.uuid().optional(), categoryId: z.uuid().optional(), itemTypeId: z.uuid().optional() }),
  locationsQuery: z.object({ divisionId: z.uuid().optional() }),
  areasQuery: z.object({ districtId: z.uuid().optional(), service: z.enum(['grounds', 'delivery']).optional(), q: z.string().trim().min(1).max(60).optional() }),
  SportList: list(Sport, 'SportList'),
  LocationList: list(Division, 'LocationList'),
  AreaList: list(Area, 'AreaList'),
  FacilityList: list(Facility, 'FacilityList'),
  SurfaceList: list(Surface, 'SurfaceList'),
  createBody: z.union(Object.values(CREATE)),
  updateBody: z.union(Object.values(UPDATE)),
  EsportsGame,
  EsportsMode,
  EsportsMap,
  EsportsPointsPreset,
  EsportsGameWithChildren,
  CatalogItem,
};
