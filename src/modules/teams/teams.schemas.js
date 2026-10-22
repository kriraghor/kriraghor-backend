'use strict';

/** M16 request and response schemas (zod → validation and OpenAPI). */
const { z } = require('zod');

const id = z.uuid();
const dateTime = z.iso.datetime({ offset: true });

// ---------------- requests
const idParam = z.object({ id });
const memberParam = z.object({ id, userId: id });
const inviteParam = z.object({ id, inviteId: id });
const tokenParam = z.object({ token: z.string().min(16).max(64) });
const handleParam = z.object({ handle: z.string().min(3).max(31) });
const createBody = z.object({
  sportKey: z.string().min(2).max(40),
  name: z.string().trim().min(2).max(40),
  shortCode: z.string().trim().max(4).optional(),
  homeAreaId: id.nullable().optional(),
});
const updateBody = z.object({ name: z.string().trim().min(2).max(40), shortCode: z.string().trim().max(4).nullable(), homeAreaId: id.nullable() }).partial();
const inviteBody = z.object({ phone: z.string().trim().min(10).max(20), role: z.enum(['player', 'vice_captain']).default('player') });
const captainBody = z.object({ userId: id });
const memberBody = z.object({ role: z.enum(['vice_captain', 'player']), jerseyNo: z.number().int().min(0).max(999).nullable() }).partial();
const profileBody = z.object({
  sports: z
    .array(
      z.object({
        sportKey: z.string().min(2).max(40),
        positions: z.array(z.string().max(40)).max(8).default([]),
        battingHand: z.enum(['right', 'left']).optional(),
        bowlingStyle: z.string().max(40).optional(),
        foot: z.enum(['right', 'left', 'both']).optional(),
      })
    )
    .max(10),
  bio: z.string().trim().max(500).nullable().optional(),
  visibility: z.enum(['public', 'members']).default('public'),
});
const eligibilityQuery = z.object({
  ageMin: z.coerce.number().int().min(5).max(100).optional(),
  ageMax: z.coerce.number().int().min(5).max(100).optional(),
  ageCutoff: z.iso.date().optional(),
  gender: z.enum(['open', 'men', 'women', 'mixed']).optional(),
});
const adminQuery = z.object({ q: z.string().max(60).optional(), status: z.enum(['active', 'archived']).optional(), sport: z.string().max(40).optional() });
const reasonBody = z.object({ reason: z.string().trim().min(5).max(255) });

// ---------------- responses
const Named = z.object({ id, key: z.string(), nameEn: z.string(), nameBn: z.string() });
const TeamCard = z
  .object({
    id,
    name: z.string(),
    shortCode: z.string().nullable(),
    sport: Named.nullable(),
    homeArea: Named.nullable(),
    logoUrl: z.string().nullable(),
    status: z.enum(['active', 'archived']),
    createdAt: dateTime,
    myRole: z.enum(['captain', 'vice_captain', 'player']).optional(),
    members: z.number().int().optional(),
  })
  .meta({ id: 'TeamCard' });
const TeamList = z.object({ items: z.array(TeamCard) }).meta({ id: 'TeamList' });
const Member = z
  .object({
    userId: id,
    displayName: z.string(),
    username: z.string().nullable(),
    role: z.enum(['captain', 'vice_captain', 'player']),
    jerseyNo: z.number().int().nullable(),
    joinedAt: dateTime,
    nidVerified: z.boolean().meta({ description: 'The only identity fact captains see (never DOB, gender or phone)' }),
  })
  .meta({ id: 'TeamMember' });
const Invite = z
  .object({ id, phoneMasked: z.string(), role: z.enum(['player', 'vice_captain']), status: z.string(), expiresAt: dateTime, resendCount: z.number().int(), createdAt: dateTime })
  .meta({ id: 'TeamInvite', description: 'The same whether or not the number has an account' });
const Team = TeamCard.extend({
  members: z.array(Member),
  invites: z.array(Invite),
  myRole: z.enum(['captain', 'vice_captain', 'player']),
  can: z.object({ invite: z.boolean(), manage: z.boolean(), leave: z.boolean() }),
}).meta({ id: 'Team' });
const Invited = z.object({ invite: Invite, shareUrl: z.string().meta({ description: 'kriraghor.com/teams/join/{token}: the captain shares it (no SMS goes to numbers without an account)' }) }).meta({ id: 'TeamInvited' });
const MyInvite = z
  .object({
    id,
    role: z.string(),
    status: z.string(),
    expiresAt: dateTime,
    expired: z.boolean(),
    team: z.object({ id, name: z.string(), shortCode: z.string().nullable(), sport: Named.nullable(), status: z.string() }).nullable(),
    invitedBy: z.string().nullable().meta({ description: 'The inviter\'s first name' }),
  })
  .meta({ id: 'MyTeamInvite' });
const MyInvites = z.object({ items: z.array(MyInvite) }).meta({ id: 'MyTeamInvites' });
const InviteLink = MyInvite.extend({ phoneMasked: z.string() }).meta({ id: 'TeamInviteLink' });
const Accepted = z.object({ teamId: id, role: z.string() }).meta({ id: 'TeamInviteAccepted' });
const Left = z.object({ left: z.boolean(), teamStatus: z.string() }).meta({ id: 'TeamLeft' });
const Profile = z
  .object({
    sports: z.array(z.object({ sportKey: z.string(), positions: z.array(z.string()) }).loose()),
    bio: z.string().nullable(),
    visibility: z.enum(['public', 'members']),
    updatedAt: dateTime.nullable(),
    username: z.string().nullable(),
    completeness: z
      .object({ score: z.number().int().min(0).max(100), steps: z.array(z.object({ key: z.enum(['sports', 'bio', 'team', 'esportsUid', 'nid']), done: z.boolean() })) })
      .meta({ description: 'Round B1: steps left to a complete player profile' }),
  })
  .meta({ id: 'PlayerProfile' });
const PublicPlayer = z
  .object({
    handle: z.string(),
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
    bio: z.string().nullable(),
    sports: z.array(z.object({ sportKey: z.string(), nameEn: z.string(), nameBn: z.string(), positions: z.array(z.object({ key: z.string(), en: z.string(), bn: z.string() })) })),
    teams: z.array(z.object({ id, name: z.string(), role: z.string(), sport: Named.nullable() })),
    hireProfiles: z.array(z.object({ slug: z.string(), specialisation: z.string().nullable() })),
    esports: z.object({ handle: z.string() }).nullable(),
  })
  .meta({ id: 'PublicPlayer', description: 'Never DOB, age, gender or phone' });
const Check = z.object({ key: z.string(), status: z.enum(['pass', 'fail', 'pending', 'missing', 'n_a']), fix: z.string().nullable() });
const Eligibility = z.object({ readiness: z.array(Check), preview: z.object({ eligible: z.boolean(), checks: z.array(Check) }).nullable() }).meta({ id: 'MyEligibility' });
const AdminTeam = TeamCard.extend({ archiveReason: z.string().nullable(), members: z.array(Member), invites: z.array(Invite) }).meta({ id: 'AdminTeam' });
const Archived = z.object({ id, status: z.string() });

module.exports = {
  idParam,
  memberParam,
  inviteParam,
  tokenParam,
  handleParam,
  createBody,
  updateBody,
  inviteBody,
  captainBody,
  memberBody,
  profileBody,
  eligibilityQuery,
  adminQuery,
  reasonBody,
  TeamCard,
  TeamList,
  Team,
  Invite,
  Invited,
  MyInvites,
  InviteLink,
  Accepted,
  Left,
  Profile,
  PublicPlayer,
  Eligibility,
  AdminTeam,
  Archived,
};
