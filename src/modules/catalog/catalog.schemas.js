'use strict';

const { z } = require('zod');

const dateTime = z.iso.datetime({ offset: true });
const TABLES = ['esports-games', 'esports-modes', 'esports-maps', 'esports-points-presets'];

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

/** PATCH bodies: everything optional; key and gameId may be sent but must not change. */
const patch = (schema) => schema.partial().refine((b) => Object.keys(b).length > 0, 'Nothing to change');

const CREATE = { 'esports-games': game, 'esports-modes': mode, 'esports-maps': map, 'esports-points-presets': preset };
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
const CatalogItem = z.union([EsportsGame, EsportsMode, EsportsMap, EsportsPointsPreset]);

module.exports = {
  TABLES,
  CREATE,
  UPDATE,
  tableParam: z.object({ table: z.enum(TABLES) }),
  tableIdParam: z.object({ table: z.enum(TABLES), id: z.uuid() }),
  listQuery: z.object({ gameId: z.uuid().optional() }),
  createBody: z.union(Object.values(CREATE)),
  updateBody: z.union(Object.values(UPDATE)),
  EsportsGame,
  EsportsMode,
  EsportsMap,
  EsportsPointsPreset,
  EsportsGameWithChildren,
  CatalogItem,
};
