'use strict';

/** M14 and M15 lite request and response schemas (zod → validation and OpenAPI). */
const { z } = require('zod');

const id = z.uuid();
const dateTime = z.iso.datetime({ offset: true });
const date = z.iso.date();
const money = z.number().int().min(0);
const nul = (s) => s.nullable();

// ---------------------------------------------------------------- requests
const orgTournamentParam = z.object({ orgId: id, id });
const orgMatchParam = z.object({ orgId: id, matchId: id });
const orgRegParam = z.object({ orgId: id, regId: id });
const idParam = z.object({ id });
const slugParam = z.object({ slug: z.string().min(1).max(100) });
const sportKeyParam = z.object({ sportKey: z.string().min(2).max(40) });

const venue = z.object({ id: id.optional(), groundId: id.nullable().optional(), venueText: z.string().trim().min(2).max(160).nullable().optional(), areaId: id.nullable().optional(), courts: z.array(z.string().trim().min(1).max(40)).max(12).optional() });
const formatConfig = z
  .object({
    groupCount: z.number().int().min(2).max(16),
    qualifiersPerGroup: z.number().int().min(1).max(4),
    bestExtra: z.number().int().min(0).max(15),
    knockoutTopN: z.union([z.literal(0), z.literal(2), z.literal(4), z.literal(8)]),
    thirdPlace: z.boolean(),
    seeding: z.enum(['registration_order', 'manual', 'random']),
    schedule: z.record(z.string(), z.unknown()),
  })
  .partial();
const eligibility = z
  .object({ ageMin: z.number().int().min(5).max(100), ageMax: z.number().int().min(5).max(100), ageCutoff: date, gender: z.enum(['open', 'men', 'women', 'mixed']) })
  .partial();
const basics = {
  name: z.string().trim().min(3).max(80),
  description: z.string().trim().max(2000).nullable(),
  format: z.enum(['league', 'double_league', 'groups_knockout', 'knockout']),
  category: z.string().max(20).nullable(),
  minTeams: z.number().int().min(2).max(256),
  maxTeams: z.number().int().min(2).max(256),
  squadMin: z.number().int().min(1).max(30),
  squadMax: z.number().int().min(1).max(30),
  entryFeePoisha: money,
  prizePoolPoisha: money.nullable(),
  prizeSplit: z.array(z.object({ label: z.string().trim().min(1).max(40), pct: z.number().int().min(1).max(100) })).max(10),
  prizeText: z.string().trim().max(200).nullable(),
  eligibility,
  contactUserId: id.nullable(),
  registrationOpensAt: dateTime.nullable(),
  registrationClosesAt: dateTime.nullable(),
  startDate: date.nullable(),
  endDate: date.nullable(),
};
const rulesPart = {
  presetKey: z.string().max(30).nullable(),
  rules: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
  tiebreakers: z.array(z.string().max(30)).max(10),
  formatConfig,
  venues: z.array(venue).max(10),
};
const createBody = z.object({ sportKey: z.string().min(2).max(40), ...basics, ...rulesPart }).partial().required({ sportKey: true, name: true, format: true });
const updateBody = z
  .object({ ...basics, ...rulesPart, version: z.number().int() })
  .partial()
  .refine((b) => Object.keys(b).filter((k) => k !== 'version').length > 0, 'Nothing to change');
const reasonBody = z.object({ reason: z.string().trim().min(5).max(255) });
const unlockBody = z.object({ reason: z.string().trim().min(10).max(255) });
const extendBody = z.object({ closesAt: dateTime });
const listQuery = z.object({ status: z.string().max(30).optional() });
const regQuery = z.object({ status: z.string().max(30).optional() });
const drawBody = z.object({ seeding: z.enum(['registration_order', 'manual', 'random']), manualOrder: z.array(id).max(256).optional() });
const generateBody = z.object({
  dryRun: z.boolean().default(false),
  schedule: z
    .object({
      startDate: date,
      endDate: date,
      weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      slots: z.array(z.string().regex(/^\d{2}:\d{2}$/)).min(1).max(8),
      durationMin: z.number().int().min(15).max(600),
      bufferMin: z.number().int().min(0).max(120),
      matchesPerDay: z.number().int().min(1).max(50).nullable(),
      minRestHours: z.number().int().min(0).max(168),
      maxPerTeamPerDay: z.number().int().min(1).max(5),
      restDates: z.array(date).max(60),
    })
    .partial()
    .nullable()
    .optional(),
});
const moveBody = z.object({ scheduledStart: dateTime.nullable().optional(), venueId: id.nullable().optional(), court: z.string().max(40).nullable().optional(), version: z.number().int().optional() });
const postponeBody = z.object({ reason: z.string().trim().min(5).max(255), newStart: dateTime.optional() });
const walkoverBody = z.object({ winnerTeamId: id, reason: z.string().trim().min(5).max(255) });
const lotsBody = z.object({ stageId: id, group: z.string().max(2).nullable().optional(), order: z.array(id).min(2).max(16) });
const side = z.object({ runs: z.number().int().min(0).max(1000), wickets: z.number().int().min(0).max(10), balls: z.number().int().min(0).max(600) }).partial().extend({ score: z.number().int().min(0).max(500).optional() });
const resultBody = z
  .object({
    outcome: z.enum(['no_result', 'walkover']).optional(),
    walkoverTo: z.enum(['a', 'b']).optional(),
    a: side.optional(),
    b: side.optional(),
    pens: z.object({ a: z.number().int().min(0).max(50), b: z.number().int().min(0).max(50) }).optional(),
    decider: z.enum(['a', 'b']).optional(),
    sets: z.array(z.tuple([z.number().int().min(0).max(99), z.number().int().min(0).max(99)])).max(7).optional(),
  })
  .meta({ description: 'Cricket {a:{runs,wickets,balls}, b, decider?}; football and other clock sports {a:{score}, b:{score}, pens?}; rally sports {sets:[[a,b],…]}; or {outcome:no_result} | {outcome:walkover, walkoverTo}' });
const amendBody = resultBody.extend({ reason: z.string().trim().min(5).max(255) });
const registerBody = z.object({ teamId: id, rosterUserIds: z.array(id).min(1).max(30), acceptRules: z.literal(true) });
const rosterBody = z.object({ rosterUserIds: z.array(id).min(1).max(30) });
const publicQuery = z.object({ sport: z.string().max(40).optional(), status: z.enum(['open', 'live', 'completed']).optional(), q: z.string().trim().max(60).optional(), limit: z.coerce.number().int().min(1).max(48).optional(), offset: z.coerce.number().int().min(0).max(5000).optional() });
const adminQuery = z.object({ status: z.string().max(30).optional(), q: z.string().trim().max(60).optional() });

// ---------------------------------------------------------------- responses
const SportRef = z.object({ key: z.string(), nameEn: z.string(), nameBn: z.string(), engine: z.string().optional() });
const OrgRef = z.object({ id, slug: z.string(), name: z.string() }).nullable();
const Field = z.object({ key: z.string(), type: z.enum(['int', 'enum', 'bool']), min: z.number().optional(), max: z.number().optional(), options: z.array(z.object({ key: z.string(), en: z.string(), bn: z.string() })).optional(), default: z.union([z.number(), z.string(), z.boolean()]), group: z.string(), en: z.string(), bn: z.string() });
const SportRules = z
  .object({
    sport: z.object({ id, key: z.string(), nameEn: z.string(), nameBn: z.string(), engine: z.string(), defaultTiebreakers: z.array(z.string()) }),
    version: z.number().int(),
    fields: z.array(Field),
    presets: z.array(z.object({ key: z.string(), en: z.string(), bn: z.string(), values: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])) })),
    tiebreakers: z.array(z.string()),
  })
  .meta({ id: 'SportRules' });
const Venue = z.object({ id, groundId: nul(id), venueText: nul(z.string()), areaId: nul(id), courts: z.array(z.string()), sort: z.number().int().optional() });
const Rules = z.object({ schemaVersion: z.number().int(), presetKey: z.string(), values: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])), formatConfig: z.record(z.string(), z.unknown()), tiebreakers: z.array(z.string()), summaryEn: nul(z.string()), summaryBn: nul(z.string()), allowedTiebreakers: z.array(z.string()) });
const base = {
  id,
  slug: z.string(),
  name: z.string(),
  description: nul(z.string()),
  sport: SportRef,
  format: z.enum(['league', 'double_league', 'groups_knockout', 'knockout']),
  category: nul(z.string()),
  status: z.string(),
  minTeams: z.number().int(),
  maxTeams: z.number().int(),
  squadMin: z.number().int(),
  squadMax: z.number().int(),
  entryFeePoisha: money,
  prizePoolPoisha: nul(money),
  prizeSplit: z.array(z.object({ label: z.string(), pct: z.number() })),
  prizeText: nul(z.string()),
  eligibility: z.record(z.string(), z.unknown()),
  registrationOpensAt: nul(dateTime),
  registrationClosesAt: nul(dateTime),
  startDate: nul(date),
  endDate: nul(date),
  rulesLockedAt: nul(dateTime),
  firstResultAt: nul(dateTime),
  cancelReason: nul(z.string()),
  rules: Rules,
  venues: z.array(Venue),
  matches: z.number().int(),
  createdAt: dateTime,
};
const Tournament = z
  .object({
    ...base,
    organisationId: id,
    contactUserId: nul(id),
    feeBps: nul(z.number().int()),
    releasePct: nul(z.number().int()),
    rulesUnlockedUntil: nul(dateTime),
    reviewReason: nul(z.object({ code: nul(z.string()), text: nul(z.string()) })),
    version: z.number().int(),
    registrations: z.record(z.string(), z.number().int()),
  })
  .meta({ id: 'Tournament' });
const TournamentCard = z
  .object({ id, slug: z.string(), name: z.string(), sport: SportRef, format: z.string(), status: z.string(), startDate: nul(date), endDate: nul(date), registrationClosesAt: nul(dateTime), entryFeePoisha: money, prizePoolPoisha: nul(money), approved: z.number().int(), maxTeams: z.number().int(), organisation: OrgRef })
  .meta({ id: 'TournamentCard' });
const TournamentList = z.object({ items: z.array(TournamentCard) }).meta({ id: 'TournamentList' });
const Ref = z.object({ type: z.string() }).loose();
const TeamRef = z.object({ id, name: z.string().optional(), shortCode: nul(z.string()).optional() });
const Result = z.object({ outcome: z.string(), winnerTeamId: nul(id), margin: z.number().int(), score: z.record(z.string(), z.unknown()), version: z.number().int(), reason: nul(z.string()), at: nul(z.string()) }).meta({ id: 'MatchResult' });
const Match = z
  .object({
    id,
    matchNo: z.number().int(),
    stageId: id,
    groupId: nul(id),
    round: z.number().int(),
    roundName: nul(z.string()),
    teamA: z.object({ ref: Ref, team: nul(TeamRef) }),
    teamB: z.object({ ref: Ref, team: nul(TeamRef) }),
    scheduledStart: nul(dateTime),
    scheduledEnd: nul(dateTime),
    venueId: nul(id),
    court: nul(z.string()),
    status: z.string(),
    statusReason: nul(z.string()),
    published: z.boolean(),
    version: z.number().int(),
    result: nul(Result),
  })
  .meta({ id: 'Match' });
const Draw = z
  .object({
    seeding: nul(z.string()),
    seed: nul(z.string()).meta({ description: 'A random draw replays from this seed (published)' }),
    confirmedAt: nul(dateTime),
    stages: z.array(z.object({ id, key: z.string(), kind: z.string(), status: z.string(), groups: z.array(z.object({ id, name: z.string(), teams: z.array(nul(TeamRef)) })) })),
  })
  .nullable()
  .meta({ id: 'Draw' });
const Fixtures = z.object({ matches: z.array(Match), venues: z.array(Venue), draw: Draw }).meta({ id: 'Fixtures' });
const StandingRow = z.object({ teamId: id, team: nul(TeamRef), played: z.number().int(), won: z.number().int(), drawn: z.number().int(), lost: z.number().int(), noResult: z.number().int(), points: z.number().int(), for: z.number().int(), against: z.number().int(), setsFor: z.number().int(), setsAgainst: z.number().int(), nrr: z.number(), position: z.number().int(), needsLots: z.boolean() });
const Table = z.object({ stageId: id, kind: z.string(), group: nul(z.string()), rows: z.array(StandingRow) }).meta({ id: 'StandingsTable' });
const PublicTeam = z.object({ teamId: id, name: z.string(), shortCode: nul(z.string()), players: z.number().int(), verified: z.number().int(), roster: z.array(z.object({ displayName: z.string(), username: nul(z.string()), nidVerified: z.boolean() })) });
const Hub = z
  .object({ ...base, organisation: OrgRef, window: z.enum(['not_yet', 'open', 'closed']), approved: z.number().int(), fixtures: Fixtures, standings: z.array(Table), teams: z.array(PublicTeam) })
  .meta({ id: 'TournamentHub', description: 'Public: no DOB, gender or phone; players show names and an NID-verified boolean' });
const Overview = z
  .object({
    kpis: z.object({ approved: z.number().int(), maxTeams: z.number().int(), waiting: z.number().int(), reserve: z.number().int(), matches: z.number().int(), completed: z.number().int(), nextMatchNo: nul(z.number().int()), nextAt: nul(dateTime) }),
    money: z.object({ collected: money, held: money, released: money, refunded: money, fees: money }),
    checklist: z.array(z.object({ key: z.string(), done: z.boolean() })),
  })
  .meta({ id: 'TournamentOverview' });
const Readiness = z.object({ total: z.number().int(), eligible: z.number().int(), ready: z.boolean(), players: z.array(z.object({ userId: id, displayName: z.string(), nidVerified: z.boolean(), eligible: z.boolean() })) });
const OrgRegistration = z.object({ id, status: z.string(), team: nul(TeamRef), reservePosition: nul(z.number().int()), feePoisha: money, feeWaived: z.boolean(), refundedPoisha: money, reason: nul(z.string()), roster: nul(Readiness), createdAt: dateTime }).meta({ id: 'OrgRegistration' });
const OrgRegistrations = z.object({ items: z.array(OrgRegistration) }).meta({ id: 'OrgRegistrations' });
const Decision = z.object({ id, status: z.string(), refunded: money.optional() });
const MyRegistration = z
  .object({
    id,
    status: z.string(),
    tournament: z.object({ id, slug: z.string(), name: z.string(), status: z.string(), startDate: nul(date) }),
    team: nul(TeamRef),
    reservePosition: nul(z.number().int()),
    holdExpiresAt: nul(dateTime),
    offerExpiresAt: nul(dateTime),
    feePoisha: money,
    feeWaived: z.boolean(),
    refundedPoisha: money,
    reason: nul(z.string()),
    payment: nul(z.object({ id, payUrl: z.string() })),
    createdAt: dateTime,
  })
  .meta({ id: 'MyRegistration' });
const MyRegistrations = z.object({ items: z.array(MyRegistration) }).meta({ id: 'MyRegistrations' });
const DrawPreview = z.object({ seeding: z.string(), teams: z.number().int(), order: nul(z.array(nul(TeamRef))), groups: nul(z.array(z.object({ name: z.string(), teams: z.array(nul(TeamRef)) }))), matchCount: z.number().int() }).meta({ id: 'DrawPreview' });
const Generated = z
  .object({
    dryRun: z.boolean(),
    matchCount: z.number().int(),
    matches: z.array(z.object({ matchNo: z.number().int(), stageKey: z.string(), group: nul(z.string()), round: z.number().int(), roundName: nul(z.string()), teamA: Ref, teamB: Ref, scheduledStart: nul(z.string()), venueId: nul(id), court: nul(z.string()) })),
    unscheduled: z.array(z.object({ matchNo: z.number().int(), reason: z.string() })),
  })
  .meta({ id: 'FixturesGenerated' });
const MatchResultView = z.object({ matchId: id, status: z.string(), result: nul(Result) }).meta({ id: 'MatchResultView' });
const AdminTournament = Tournament.extend({
  registrationList: z.array(z.object({ id, status: z.string(), team: z.string(), feePoisha: money, feeWaived: z.boolean(), refundedPoisha: money, paymentId: nul(id), reason: nul(z.string()) })),
  money: Overview.shape.money,
}).meta({ id: 'AdminTournament' });

module.exports = {
  orgTournamentParam,
  orgMatchParam,
  orgRegParam,
  idParam,
  slugParam,
  sportKeyParam,
  createBody,
  updateBody,
  reasonBody,
  unlockBody,
  extendBody,
  listQuery,
  regQuery,
  drawBody,
  generateBody,
  moveBody,
  postponeBody,
  walkoverBody,
  lotsBody,
  resultBody,
  amendBody,
  registerBody,
  rosterBody,
  publicQuery,
  adminQuery,
  SportRules,
  Tournament,
  TournamentCard,
  TournamentList,
  Match,
  Fixtures,
  Draw,
  Table,
  Hub,
  Overview,
  OrgRegistrations,
  Decision,
  MyRegistration,
  MyRegistrations,
  DrawPreview,
  Generated,
  MatchResultView,
  AdminTournament,
};
