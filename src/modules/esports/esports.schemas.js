'use strict';

/** M21 request and response schemas (zod → validation and OpenAPI). Money is integer poisha. */
const { z } = require('zod');

const dateTime = z.iso.datetime({ offset: true });
const poisha = z.number().int().min(0).max(100_000_000_00);
const Money = z.object({ amount: z.number().int(), currency: z.literal('BDT') });
const limit = (max, def) => z.coerce.number().int().min(1).max(max).default(def);

const idParam = z.object({ id: z.uuid() });
const slugParam = z.object({ id: z.string().trim().min(1).max(80) });
const handleParam = z.object({ handle: z.string().trim().min(2).max(40) });
const disputeParam = z.object({ id: z.uuid() });
const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });

// ---------------- player
const profileBody = z.object({
  gameId: z.uuid(),
  uid: z.string().trim().min(3).max(32),
  ign: z.string().trim().min(1).max(40).meta({ description: 'In-game name, as shown in the game' }),
  screenshotKey: z.string().max(255).meta({ description: 'Key from POST /me/esports/uploads (a screenshot of your in-game profile)' }),
});
const squadBody = z.object({ gameId: z.uuid(), name: z.string().trim().min(2).max(40), tag: z.string().trim().min(2).max(8).regex(/^[A-Za-z0-9]+$/) });
const inviteBody = z.object({ username: z.string().trim().min(2).max(30) });
const joinBody = z.object({ code: z.string().trim().min(6).max(12) });
const captainBody = z.object({ userId: z.uuid() });
const registerBody = z.object({
  squadId: z.uuid().optional(),
  players: z.array(z.uuid()).min(1).max(8).meta({ description: 'Game profile ids of the playing members (the mode team size)' }),
  substitutes: z.array(z.uuid()).max(4).default([]),
});
const splitBody = z.object({ split: z.array(z.object({ userId: z.uuid(), pct: z.number().int().min(0).max(100) })).min(1).max(8) });
const evidenceBody = z
  .object({ kind: z.enum(['screenshot', 'video_link']), key: z.string().max(255).optional(), url: z.string().url().max(500).optional(), note: z.string().trim().max(500).optional() })
  .refine((b) => (b.kind === 'screenshot' ? Boolean(b.key) : Boolean(b.url)), { message: 'A screenshot needs key; a video link needs url' });
const disputeBody = z.object({ reason: z.string().trim().min(5).max(500), evidenceIds: z.array(z.uuid()).max(5).default([]) });

// ---------------- public
const listQuery = z.object({
  game: z.string().max(40).optional(),
  mode: z.uuid().optional(),
  tier: z.enum(['daily', 'weekly', 'monthly', 'major']).optional(),
  status: z.string().max(40).optional(),
  featured: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  cursor: z.string().max(80).optional(),
  limit: limit(50, 20),
});
const leaderboardQuery = z.object({ game: z.string().min(2).max(40), scope: z.enum(['rolling', 'season']).default('rolling'), season: z.string().regex(/^\d{4}-S[1-4]$/).optional(), limit: limit(100, 50) });

// ---------------- staff
const prize = z.object({ place: z.number().int().min(1).max(100), amount: poisha.min(1) });
const matchIn = z.object({ mapId: z.uuid(), startsAt: dateTime });
const tournamentFields = {
  gameId: z.uuid(),
  modeId: z.uuid(),
  titleEn: z.string().trim().min(3).max(120),
  titleBn: z.string().trim().min(2).max(160),
  tier: z.enum(['daily', 'weekly', 'monthly', 'major']),
  format: z.enum(['single_match', 'series']),
  entryFee: poisha.meta({ description: 'Per entry (a squad pays once), in poisha; 0 = free' }),
  maxSlots: z.number().int().min(2).max(200),
  minParticipants: z.number().int().min(1).max(200),
  prizes: z.array(prize).min(1).max(50),
  killReward: poisha.meta({ description: 'Per kill, per player, in poisha' }),
  maxPaidKills: z.number().int().min(1).max(10000).nullable().optional().meta({ description: 'M22: the most kills paid in the tournament (organisers with a per-kill reward must set it; the prize fund covers places + reward × this)' }),
  pointsPresetId: z.uuid().optional(),
  placementPoints: z.array(z.number().int().min(0).max(100)).min(1).max(100).optional(),
  killPoints: z.number().int().min(0).max(10).optional(),
  registrationOpensAt: dateTime,
  registrationClosesAt: dateTime.optional(),
  matches: z.array(matchIn).min(1).max(10),
  rulesMd: z.string().max(10000),
  featured: z.boolean(),
  entryPolicy: z.enum(['open', 'invite']).meta({ description: 'M23: invite = only qualified or invited entries (a big event final); locked after publish' }),
};
const tournamentBody = z.object({ ...tournamentFields, killReward: tournamentFields.killReward.default(0), rulesMd: tournamentFields.rulesMd.default(''), featured: tournamentFields.featured.default(false), entryPolicy: tournamentFields.entryPolicy.default('open') });
// No defaults: a patch carries only the fields it changes (locked ones are refused after publish).
const tournamentPatch = z.object(tournamentFields).partial();
const cancelBody = z.object({ reason: z.string().trim().min(5).max(255) });
const streamsBody = z.object({
  streams: z
    .array(z.object({ platform: z.enum(['youtube', 'facebook', 'tiktok', 'other']), url: z.string().max(500), title: z.string().trim().min(2).max(120), isLive: z.boolean().default(false), matchId: z.uuid().optional(), startsAt: dateTime.optional() }))
    .max(10),
});
const roomBody = z.object({ roomId: z.string().trim().min(3).max(40), password: z.string().trim().min(1).max(40), revealAt: dateTime.optional() });
const rotateBody = roomBody.omit({ revealAt: true }).extend({ reason: z.string().trim().max(255).optional() });
const resultRow = z.object({ registrationId: z.uuid(), placement: z.number().int().min(1).max(200).nullable(), kills: z.array(z.object({ userId: z.uuid(), kills: z.number().int().min(0).max(100) })).max(8).default([]) });
const resultsBody = z.object({ rows: z.array(resultRow).min(1).max(200) });
const resolveBody = z.object({ outcome: z.enum(['rejected', 'corrected']), rows: z.array(resultRow).max(200).default([]), note: z.string().trim().min(3).max(500) });
const dqBody = z.object({
  reasonCode: z.enum(['cheating', 'uid_mismatch', 'account_sharing', 'no_show_abuse', 'abuse', 'other']),
  note: z.string().trim().min(5).max(1000),
  userId: z.uuid().optional(),
  banUid: z.boolean().default(false),
  removeFromStandings: z.boolean().default(true),
});
const staffCheckinBody = z.object({ userId: z.uuid() });
const banBody = z.object({ gameId: z.uuid(), uid: z.string().trim().min(3).max(32), reasonCode: z.enum(['cheating', 'hacking', 'account_sharing', 'abuse', 'other']), note: z.string().trim().min(5).max(1000), expiresAt: dateTime.optional() });
const liftBody = z.object({ reason: z.string().trim().min(3).max(300) });
const bansQuery = z.object({ gameId: z.uuid().optional(), active: z.enum(['true', 'false']).transform((v) => v === 'true').default(true) });
const disputesQuery = z.object({ status: z.enum(['open', 'rejected', 'corrected']).default('open'), tournamentId: z.uuid().optional() });
const adminListQuery = listQuery.extend({ status: z.string().max(200).optional() });

// ---------------- responses (loose: the services shape them; the important fields are named)
const Named = z.object({ id: z.uuid(), key: z.string(), nameEn: z.string(), nameBn: z.string() }).loose();
const Card = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    titleEn: z.string(),
    titleBn: z.string(),
    game: Named.nullable(),
    mode: Named.nullable(),
    tier: z.string(),
    format: z.string(),
    entryUnit: z.enum(['player', 'squad']),
    entryFee: Money,
    prizePool: Money,
    killReward: Money,
    maxPaidKills: z.number().int().nullable().meta({ description: 'M22: the most kills paid (organiser tournaments with a per-kill reward)' }),
    organisationId: z.uuid().nullable(),
    organiser: z.object({ id: z.uuid(), slug: z.string(), name: z.string() }).nullable().meta({ description: 'M22: the organisation running it; null for Kriraghor\'s own' }),
    maxSlots: z.number().int(),
    minParticipants: z.number().int(),
    slotsTaken: z.number().int(),
    waitlist: z.number().int(),
    registrationOpensAt: dateTime,
    registrationClosesAt: dateTime,
    startsAt: dateTime,
    status: z.string(),
    featured: z.boolean(),
    entryPolicy: z.enum(['open', 'invite']),
  })
  .loose();
const TournamentList = z.object({ items: z.array(Card), nextCursor: z.string().nullable() }).meta({ id: 'EsportsTournamentList' });
const Tournament = Card.extend({
  rulesMd: z.string(),
  placementPoints: z.array(z.number().int()),
  killPoints: z.number().int(),
  prizes: z.array(z.object({ place: z.number().int(), amount: Money })),
  stages: z.array(z.object({ id: z.uuid(), seq: z.number().int(), checkinOpensAt: dateTime, checkinClosesAt: dateTime }).loose()),
  matches: z.array(z.object({ id: z.uuid(), seq: z.number().int(), map: Named.nullable(), startsAt: dateTime, status: z.string() }).loose()),
  streams: z.array(z.object({ id: z.uuid(), platform: z.string(), url: z.string(), title: z.string(), isLive: z.boolean(), embedUrl: z.string().nullable().meta({ description: 'The player URL built from the parsed video reference; null = show the link' }) }).loose()),
}).meta({ id: 'EsportsTournament' });
const Profile = z.object({ id: z.uuid(), gameId: z.uuid(), uid: z.string(), uidMasked: z.string(), ign: z.string(), status: z.string() }).loose().meta({ id: 'EsportsGameProfile' });
const ProfileList = z.object({ items: z.array(Profile) }).meta({ id: 'EsportsGameProfileList' });
const Upload = z.object({ key: z.string(), mime: z.string(), sizeBytes: z.number().int() }).meta({ id: 'EsportsUpload' });
const Squad = z.object({ id: z.uuid(), gameId: z.uuid(), name: z.string(), tag: z.string(), captainUserId: z.uuid(), members: z.array(z.object({ userId: z.uuid(), role: z.string(), status: z.string() }).loose()) }).loose().meta({ id: 'EsportsSquad' });
const SquadList = z.object({ items: z.array(Squad) }).meta({ id: 'EsportsSquadList' });
const Registration = z
  .object({ id: z.uuid(), tournamentId: z.uuid(), status: z.string(), slotNo: z.number().int().nullable(), amount: Money, players: z.array(z.object({ userId: z.uuid() }).loose()) })
  .loose()
  .meta({ id: 'EsportsRegistration' });
const Registered = z.object({ registration: Registration, payment: z.object({ id: z.uuid(), payUrl: z.string() }).nullable(), waitlisted: z.boolean() }).meta({ id: 'EsportsRegistered' });
const RegistrationList = z.object({ items: z.array(Registration) }).meta({ id: 'EsportsRegistrationList' });
const Room = z
  .object({ matchId: z.uuid(), version: z.number().int(), roomId: z.string(), password: z.string(), map: z.object({ key: z.string(), nameEn: z.string(), nameBn: z.string() }).nullable(), startsAt: dateTime, revealedAt: dateTime })
  .meta({ id: 'EsportsRoom', description: 'Room credentials: checked-in players only, from the reveal time. Every read is audited; do not cache.' });
const RoomPanel = z.object({ matchId: z.uuid(), matchStatus: z.string(), current: z.object({ version: z.number().int(), status: z.string(), revealAt: dateTime }).loose().nullable(), views: z.number().int() }).loose().meta({ id: 'EsportsRoomPanel' });
const StaffRoom = z.object({ matchId: z.uuid(), version: z.number().int(), roomId: z.string(), password: z.string() }).meta({ id: 'EsportsStaffRoom' });
const Views = z.object({ items: z.array(z.object({ userId: z.uuid(), version: z.number().int().nullable(), actorType: z.string(), channel: z.string(), createdAt: dateTime }).loose()) }).meta({ id: 'EsportsRoomViews' });
const Match = z.object({ id: z.uuid(), tournamentId: z.uuid(), seq: z.number().int(), status: z.string(), results: z.array(z.object({ registrationId: z.uuid(), placement: z.number().int().nullable(), kills: z.number().int(), totalPoints: z.number().int() }).loose()) }).loose().meta({ id: 'EsportsMatch' });
const Standings = z.object({ tournamentId: z.uuid(), items: z.array(z.object({ rank: z.number().int(), registrationId: z.uuid(), totalPoints: z.number().int(), wins: z.number().int(), kills: z.number().int() }).loose()) }).loose().meta({ id: 'EsportsStandings' });
const Dispute = z.object({ id: z.uuid(), matchId: z.uuid(), registrationId: z.uuid(), status: z.string(), reason: z.string() }).loose().meta({ id: 'EsportsDispute' });
const DisputeList = z.object({ items: z.array(Dispute) }).meta({ id: 'EsportsDisputeList' });
const Evidence = z.object({ id: z.uuid(), matchId: z.uuid(), kind: z.string(), createdAt: dateTime }).meta({ id: 'EsportsEvidence' });
const Preview = z.object({ tournamentId: z.uuid(), finalisable: z.boolean(), awards: z.array(z.object({ registrationId: z.uuid(), kind: z.string(), amount: Money }).loose()), totals: z.record(z.string(), Money) }).meta({ id: 'EsportsFinalisePreview' });
const Winnings = z.object({ available: Money, minimum: Money, dailyLimitLeft: Money, totalWon: Money, items: z.array(z.object({ id: z.uuid(), amount: Money, status: z.string() }).loose()) }).meta({ id: 'EsportsWinnings' });
const Leaderboard = z.object({ scope: z.string(), seasonKey: z.string(), items: z.array(z.object({ rank: z.number().int(), userId: z.uuid(), points: z.number() }).loose()) }).loose().meta({ id: 'EsportsLeaderboard' });
const Player = z.object({ userId: z.uuid(), username: z.string().nullable(), games: z.array(z.object({ ign: z.string(), uidMasked: z.string() }).loose()) }).loose().meta({ id: 'EsportsPlayer' });
const TopPlayers = z.object({ items: z.array(z.object({ rank: z.number().int(), userId: z.uuid(), points: z.number() }).loose()) }).meta({ id: 'EsportsTopPlayers' });
const Board = z.object({ tournamentId: z.uuid(), items: z.array(Registration) }).loose().meta({ id: 'EsportsCheckinBoard' });
const Ban = z.object({ id: z.uuid(), gameId: z.uuid(), uid: z.string(), reasonCode: z.string() }).loose().meta({ id: 'EsportsUidBan' });
const BanList = z.object({ items: z.array(Ban) }).meta({ id: 'EsportsUidBanList' });
const Disqualified = z.object({ id: z.uuid(), registrationId: z.uuid(), status: z.string(), reasonCode: z.string() }).loose().meta({ id: 'EsportsDisqualification' });
const Left = z.object({ left: z.boolean(), squadStatus: z.string() }).meta({ id: 'EsportsSquadLeft' });

module.exports = {
  resultRow,
  idParam,
  slugParam,
  handleParam,
  disputeParam,
  memberParams,
  profileBody,
  squadBody,
  inviteBody,
  joinBody,
  captainBody,
  registerBody,
  splitBody,
  evidenceBody,
  disputeBody,
  listQuery,
  adminListQuery,
  leaderboardQuery,
  tournamentBody,
  tournamentPatch,
  cancelBody,
  streamsBody,
  roomBody,
  rotateBody,
  resultsBody,
  resolveBody,
  dqBody,
  staffCheckinBody,
  banBody,
  liftBody,
  bansQuery,
  disputesQuery,
  TournamentList,
  Tournament,
  Profile,
  ProfileList,
  Upload,
  Squad,
  SquadList,
  Registration,
  Registered,
  RegistrationList,
  Room,
  RoomPanel,
  StaffRoom,
  Views,
  Match,
  Standings,
  Dispute,
  DisputeList,
  Evidence,
  Preview,
  Winnings,
  Leaderboard,
  Player,
  TopPlayers,
  Board,
  Ban,
  BanList,
  Disqualified,
  Left,
};
