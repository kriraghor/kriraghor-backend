'use strict';

/** M26 request and response schemas (zod → validation and OpenAPI). Money in poisha; dates are Dhaka calendar dates. */
const { z } = require('zod');
const rules = require('./tournament-posts.rules');

const id = z.uuid();
const poisha = z.number().int().nonnegative();
const date = z.iso.date();
const dateTime = z.iso.datetime({ offset: true });
const text = (min, max) => z.string().trim().min(min).max(max);
const nullable = (schema) => schema.nullable();
const page = { cursor: z.string().regex(/^\d+$/).optional(), limit: z.coerce.number().int().min(1).max(50).optional() };

// ---------------- params and queries
const idParam = z.object({ id });
const slugParam = z.object({ slug: z.string().min(1).max(110) });
const commentParam = z.object({ id, commentId: id });
const photoParam = z.object({ id, photoId: id });
const pageQuery = z.object(page);
const flag = z.enum(['true', 'false']).optional().transform((v) => v === 'true');
const listQuery = z.object({
  sport: z.string().max(40).optional(),
  divisionId: id.optional(),
  districtId: id.optional(),
  areaId: id.optional(),
  from: date.optional().meta({ description: 'Starting on or after' }),
  to: date.optional().meta({ description: 'Starting on or before' }),
  fee: z.enum(['free', 'paid']).optional(),
  format: z.enum(rules.FORMATS).optional(),
  gender: z.enum(rules.GENDERS).optional(),
  skill: z.enum(rules.SKILLS).optional(),
  registrationOpen: flag.meta({ description: 'Only tournaments still taking registrations' }),
  q: z.string().trim().min(1).max(60).optional(),
  sort: z.enum(rules.SORTS).default('newest'),
  ...page,
});
const adminListQuery = z.object({ status: z.enum(rules.STATUSES).optional(), q: z.string().trim().min(1).max(60).optional(), ...page });
const messagesQuery = z.object({ after: dateTime.optional().meta({ description: 'Only messages after this time, for polling' }) });

// ---------------- bodies
const postBody = z.object({
  title: text(5, 120),
  sport: z.string().min(1).max(40).meta({ description: 'A sport key from the catalogue' }),
  format: z.enum(rules.FORMATS),
  districtId: id,
  areaId: id.nullable().optional(),
  venueName: text(2, 120),
  address: text(2, 240).nullable().optional(),
  mapLink: z.string().trim().max(300).nullable().optional().meta({ description: 'A Google Maps link' }),
  startDate: date,
  endDate: date.nullable().optional(),
  registrationDeadline: date,
  entryFee: poisha.meta({ description: 'What the organiser charges, for information; 0 is free. Kriraghor does not collect it' }),
  prizePool: poisha.nullable().optional(),
  prizeDetails: text(2, 500).nullable().optional(),
  teamLimit: z.number().int().min(2).max(1000).nullable().optional(),
  playersPerTeam: z.number().int().min(1).max(100).nullable().optional(),
  gender: z.enum(rules.GENDERS).optional(),
  ageGroup: text(2, 40).nullable().optional(),
  skillLevel: z.enum(rules.SKILLS).nullable().optional(),
  organiserName: text(2, 120),
  description: text(20, 5000),
  rules: text(2, 5000).nullable().optional(),
});
const commentBody = z.object({ body: text(1, 4000) });
const messageBody = z.object({ body: text(1, 4000) });
const reasonBody = z.object({ reason: text(5, 300) });

// ---------------- responses
const Label = z.object({ id, en: z.string(), bn: z.string() });
const Person = z.object({ displayName: z.string(), username: nullable(z.string()), avatarUrl: nullable(z.string()) });
const Card = z
  .object({
    id,
    slug: z.string(),
    title: z.string(),
    sport: z.object({ key: z.string(), en: z.string(), bn: z.string() }),
    format: z.enum(rules.FORMATS),
    division: nullable(Label),
    district: nullable(Label),
    area: nullable(Label),
    venueName: z.string(),
    startDate: date,
    endDate: nullable(date),
    registrationDeadline: date,
    registrationOpen: z.boolean(),
    entryFee: poisha,
    prizePool: nullable(poisha),
    gender: z.enum(rules.GENDERS),
    ageGroup: nullable(z.string()),
    skillLevel: nullable(z.enum(rules.SKILLS)),
    organiserName: z.string(),
    cover: nullable(z.string()),
    commentCount: z.number().int(),
    status: z.enum(rules.STATUSES),
    author: Person,
    createdAt: dateTime,
  })
  .meta({ id: 'TournamentPostCard' });
const Saved = z.object({ id, slug: z.string() });
const Paged = (schema) => z.object({ items: z.array(schema), total: z.number().int(), nextCursor: nullable(z.string()) });
const Feed = Paged(Card);
const MineCard = Card.extend({ removedReason: nullable(z.string()) });
const Mine = Paged(MineCard);
const Photo = z.object({ id, url: z.string() });
const Page = Card.extend({
  address: nullable(z.string()),
  mapLink: nullable(z.string()),
  prizeDetails: nullable(z.string()),
  teamLimit: nullable(z.number().int()),
  playersPerTeam: nullable(z.number().int()),
  description: z.string(),
  rules: nullable(z.string()),
  photos: z.array(Photo),
  removedReason: nullable(z.string()),
  mine: z.boolean(),
  threadId: nullable(id),
  can: z.object({ edit: z.boolean(), close: z.boolean(), comment: z.boolean(), message: z.boolean() }),
}).meta({ id: 'TournamentPostPage' });
const Comment = z.object({ id, body: z.string(), at: dateTime, author: Person, mine: z.boolean(), canRemove: z.boolean() });
const Comments = Paged(Comment);
const NewComment = z.object({ id, body: z.string(), at: dateTime, mine: z.boolean(), canRemove: z.boolean() });
const Thread = z
  .object({
    id,
    post: z.object({ id, slug: z.string(), title: z.string(), status: z.enum(rules.STATUSES) }),
    other: Person,
    role: z.enum(['organiser', 'player']),
    lastMessage: nullable(z.object({ body: z.string(), at: dateTime, mine: z.boolean() })),
    unread: z.number().int(),
  })
  .meta({ id: 'TournamentThread' });
const Threads = Paged(Thread);
const Message = z.object({ id, mine: z.boolean(), body: z.string(), at: dateTime });
const Messages = z.object({ thread: Thread, items: z.array(Message), canSend: z.boolean() });

module.exports = {
  idParam,
  slugParam,
  commentParam,
  photoParam,
  pageQuery,
  listQuery,
  adminListQuery,
  messagesQuery,
  postBody,
  commentBody,
  messageBody,
  reasonBody,
  Card,
  Saved,
  Feed,
  Mine,
  Photo,
  Page,
  Comments,
  NewComment,
  Thread,
  Threads,
  Message,
  Messages,
};
