'use strict';

/** M23 request and response schemas (zod → validation and OpenAPI). Money in poisha. */
const { z } = require('zod');

const id = z.uuid();
const dateTime = z.iso.datetime({ offset: true });
const Money = z.object({ amount: z.number().int(), currency: z.literal('BDT') });
const hex = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, '#rrggbb');
const text = (min, max) => z.string().trim().min(min).max(max);

// ---------------- requests
const idParam = z.object({ id });
const pollParam = z.object({ id, pollId: id });
const sponsorParam = z.object({ id, sponsorId: id });
const qualParam = z.object({ id, qualificationId: id });
const slugParam = z.object({ slug: z.string().min(1).max(90) });
const listQuery = z.object({
  featured: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  tournamentId: id.optional().meta({ description: 'The published event a tournament belongs to (the tournament page links it)' }),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const adminListQuery = z.object({ status: z.enum(['draft', 'published', 'cancelled']).optional() });
const feedQuery = z.object({ before: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

const eventFields = {
  titleEn: text(3, 120),
  titleBn: text(2, 160),
  taglineEn: text(0, 160).nullable(),
  taglineBn: text(0, 200).nullable(),
  aboutMdEn: z.string().max(10000),
  aboutMdBn: z.string().max(10000),
  accentHex: hex,
  startsAt: dateTime,
  endsAt: dateTime,
  featured: z.boolean(),
};
const eventBody = z.object({
  ...eventFields,
  taglineEn: eventFields.taglineEn.optional(),
  taglineBn: eventFields.taglineBn.optional(),
  aboutMdEn: eventFields.aboutMdEn.default(''),
  aboutMdBn: eventFields.aboutMdBn.default(''),
  accentHex: eventFields.accentHex.default('#f2a33a'),
  featured: eventFields.featured.default(false),
});
const eventPatch = z.object(eventFields).partial();
const stage = z.object({
  tournamentId: id,
  role: z.enum(['qualifier', 'final']),
  labelEn: text(2, 80),
  labelBn: text(2, 120),
  qualifyCount: z.number().int().min(1).max(200).optional().meta({ description: 'Qualifiers: how many go through to the final (top N by M21 rank)' }),
  finalTournamentId: id.optional().meta({ description: 'Qualifiers: the final they feed (a final in this list)' }),
});
const stagesBody = z.object({ stages: z.array(stage).max(32) });
const streamsBody = z.object({
  streams: z.array(z.object({ platform: z.enum(['youtube', 'facebook', 'tiktok']), url: z.string().max(500), title: text(2, 120), isLive: z.boolean().default(false) })).max(10),
});
const sponsorBody = z.object({ name: text(2, 80), tier: z.enum(['title', 'gold', 'partner']), url: z.string().max(500).nullable().optional(), sort: z.number().int().min(0).max(100).optional() });
const sponsorPatch = sponsorBody.partial();
const pollBody = z.object({
  questionEn: text(5, 160),
  questionBn: text(3, 220),
  options: z.array(z.object({ labelEn: text(1, 80), labelBn: text(1, 120) })).min(2).max(10),
  closesAt: dateTime.optional(),
});
const voteBody = z.object({ optionId: id });
const announceBody = z.object({ textEn: text(3, 280), textBn: text(2, 400) });
const reasonBody = z.object({ reason: text(5, 255) });
const inviteBody = z.object({ finalTournamentId: id, squadId: id.optional(), userId: id.optional(), reason: text(5, 255) });

// ---------------- responses
const Phase = z.enum(['draft', 'upcoming', 'live', 'ended', 'cancelled']);
const EventCard = z
  .object({
    id,
    slug: z.string(),
    titleEn: z.string(),
    titleBn: z.string(),
    taglineEn: z.string().nullable(),
    taglineBn: z.string().nullable(),
    bannerUrl: z.string().nullable(),
    accentHex: z.string(),
    startsAt: dateTime,
    endsAt: dateTime,
    status: z.enum(['draft', 'published', 'cancelled']),
    phase: Phase,
    featured: z.boolean(),
    prizeTotal: Money.meta({ description: 'The linked tournaments\' prize pools (cancelled ones excluded)' }),
    followers: z.number().int(),
    cancelReason: z.string().nullable(),
  })
  .meta({ id: 'EsportsEventCard' });
const EventList = z.object({ items: z.array(EventCard) }).meta({ id: 'EsportsEventList' });
const EventTournament = z
  .object({ id, slug: z.string(), titleEn: z.string(), titleBn: z.string(), status: z.string(), entryUnit: z.string(), entryPolicy: z.string(), maxSlots: z.number().int(), prizePool: Money, entryFee: Money, registrationOpensAt: dateTime, registrationClosesAt: dateTime, startsAt: dateTime })
  .meta({ id: 'EsportsEventTournament' });
const Stage = z.object({ id, role: z.enum(['qualifier', 'final']), labelEn: z.string(), labelBn: z.string(), sort: z.number().int(), qualifyCount: z.number().int().nullable(), finalTournamentId: id.nullable(), tournament: EventTournament.nullable() }).meta({ id: 'EsportsEventStage' });
const Qualification = z
  .object({
    id,
    finalTournamentId: id,
    sourceTournamentId: id.nullable(),
    rank: z.number().int().nullable(),
    status: z.enum(['qualified', 'invited', 'entered', 'missed', 'revoked']),
    entry: z.object({ kind: z.enum(['squad', 'player']), id, name: z.string(), tag: z.string().nullable() }),
    createdAt: dateTime,
  })
  .loose()
  .meta({ id: 'EsportsEventQualification' });
const QualificationList = z.object({ items: z.array(Qualification) }).meta({ id: 'EsportsEventQualificationList' });
const Stream = z
  .object({ id, source: z.enum(['event', 'tournament']), tournamentId: id.nullable(), platform: z.string(), url: z.string(), title: z.string(), isLive: z.boolean(), embedUrl: z.string().nullable().meta({ description: 'Built from the parsed video reference; null = link only (TikTok live, unknown link forms)' }) })
  .meta({ id: 'EsportsEventStream' });
const StreamList = z.object({ items: z.array(Stream) }).meta({ id: 'EsportsEventStreamList' });
const Sponsor = z.object({ id, name: z.string(), tier: z.enum(['title', 'gold', 'partner']), logoUrl: z.string().nullable(), url: z.string().nullable(), sort: z.number().int() }).meta({ id: 'EsportsEventSponsor' });
const Poll = z
  .object({
    id,
    questionEn: z.string(),
    questionBn: z.string(),
    status: z.enum(['draft', 'open', 'closed']),
    closesAt: dateTime.nullable(),
    options: z.array(z.object({ id, labelEn: z.string(), labelBn: z.string() })),
    results: z.object({ total: z.number().int(), items: z.array(z.object({ optionId: id, votes: z.number().int(), pct: z.number().int() })) }),
    myVote: id.optional(),
  })
  .meta({ id: 'EsportsEventPoll' });
const FeedItem = z
  .object({
    id,
    kind: z.enum(['announcement', 'tournament_finalised', 'tournament_cancelled', 'qualified', 'final_live', 'stream_live', 'event_cancelled']),
    tournament: z.object({ id, slug: z.string(), titleEn: z.string(), titleBn: z.string() }).nullable(),
    textEn: z.string().nullable(),
    textBn: z.string().nullable(),
    data: z.record(z.string(), z.unknown()),
    createdAt: dateTime,
  })
  .meta({ id: 'EsportsEventFeedItem' });
const Feed = z.object({ items: z.array(FeedItem), nextCursor: z.string().nullable() }).meta({ id: 'EsportsEventFeed' });
const Bundle = z
  .object({
    event: EventCard.extend({ aboutMdEn: z.string(), aboutMdBn: z.string() }),
    stages: z.array(Stage),
    qualifications: z.array(Qualification),
    streams: z.array(Stream),
    sponsors: z.array(Sponsor),
    polls: z.array(Poll),
    feed: Feed,
  })
  .meta({ id: 'EsportsEventBundle' });
const AdminEvent = Bundle.extend({
  linkCheck: z.array(z.object({ finalTournamentId: id, block: z.string().nullable(), qualifying: z.number().int() })),
  lockVersion: z.number().int(),
  createdBy: id,
  publishedAt: dateTime.nullable(),
}).meta({ id: 'EsportsEventAdmin' });
const EventDraft = EventCard.extend({ aboutMdEn: z.string(), aboutMdBn: z.string(), lockVersion: z.number().int() }).meta({ id: 'EsportsEventDraft' });
const StageList = z.object({ items: z.array(z.object({ id, tournamentId: id, role: z.string(), labelEn: z.string(), labelBn: z.string(), sort: z.number().int(), qualifyCount: z.number().int().nullable(), finalTournamentId: id.nullable() })) }).meta({ id: 'EsportsEventStageList' });
const Me = z.object({ following: z.boolean(), votes: z.record(z.string(), id) }).meta({ id: 'EsportsEventMe' });
const Follow = z.object({ following: z.boolean(), followers: z.number().int() }).meta({ id: 'EsportsEventFollow' });
const Announcement = z.object({ id, kind: z.literal('announcement'), textEn: z.string(), textBn: z.string(), createdAt: dateTime }).meta({ id: 'EsportsEventAnnouncement' });
const Removed = z.object({ id, status: z.string() });

module.exports = {
  idParam,
  pollParam,
  sponsorParam,
  qualParam,
  slugParam,
  listQuery,
  adminListQuery,
  feedQuery,
  eventBody,
  eventPatch,
  stagesBody,
  streamsBody,
  sponsorBody,
  sponsorPatch,
  pollBody,
  voteBody,
  announceBody,
  reasonBody,
  inviteBody,
  EventCard,
  EventList,
  Bundle,
  AdminEvent,
  EventDraft,
  StageList,
  StreamList,
  Sponsor,
  Poll,
  Feed,
  QualificationList,
  Qualification,
  Me,
  Follow,
  Announcement,
  Removed,
};
