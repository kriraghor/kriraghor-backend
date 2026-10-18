'use strict';

/**
 * M16 player profiles and eligibility (step 1).
 *
 * A profile lists the sports a member plays with positions from each sport's M03 list, a short bio and
 * whether the page is public. The public page (/players/:handle, the username) shows the name, sports,
 * positions, active teams and links to a live hire profile and the esports page: never DOB, age,
 * gender or phone (M16-FR-05).
 *
 * Eligibility (M16-FR-08) is evaluated from M01's internal identity. A member previews their own
 * readiness, optionally against an event's age and gender rules; M14 calls checkMany() with a
 * competition's rules. No one else can run a check against another member, so DOB and gender cannot be
 * probed; captains see only the NID-verified boolean.
 */
const { E } = require('../../common/errors');
const models = require('../../models');
const audit = require('../audit/audit.service');
const directory = require('../users/directory.service');
const rules = require('./teams.rules');
const c = require('./teams.common');

const { sequelize, PlayerProfile, Sport } = models;

async function positionsBySport() {
  const sports = await Sport.findAll({ where: { isActive: true } });
  return new Map(sports.filter((s) => (s.positions ?? []).length).map((s) => [s.key, s.positions.map((p) => p.key)]));
}

const profileView = (p) => ({ sports: p?.sports ?? [], bio: p?.bio ?? null, visibility: p?.visibility ?? 'public', updatedAt: p?.updatedAt ?? null });

/** GET /me/player-profile */
async function getMine(principal) {
  const p = await PlayerProfile.findByPk(principal.user.id);
  return { ...profileView(p), username: principal.user.username ?? null };
}

/** PUT /me/player-profile {sports, bio, visibility} */
async function putMine(principal, { sports, bio = null, visibility = 'public' }, req) {
  const clean = sports.map((s) => ({ sportKey: s.sportKey, positions: [...new Set(s.positions ?? [])], ...(s.battingHand ? { battingHand: s.battingHand } : {}), ...(s.bowlingStyle ? { bowlingStyle: s.bowlingStyle } : {}), ...(s.foot ? { foot: s.foot } : {}) }));
  const block = rules.sportsBlock(clean, await positionsBySport());
  if (block) throw c.fail(block);
  return sequelize.transaction(async (transaction) => {
    const [p] = await PlayerProfile.findOrCreate({ where: { userId: principal.user.id }, defaults: { sports: clean, bio, visibility }, transaction });
    await p.update({ sports: clean, bio: bio?.trim() || null, visibility }, { transaction });
    await audit.record({ action: 'player_profile.updated', actor: principal, entityType: 'user', entityId: principal.user.id, after: { sports: clean.length, visibility }, req }, { transaction });
    return { ...profileView(p), username: principal.user.username ?? null };
  });
}

/** GET /players/:handle (public): a public profile, or 404. */
async function publicPage(handle) {
  const who = await directory.byUsername(handle);
  if (!who || who.status !== 'active') throw E.notFound('Player');
  const userId = who.id;
  const p = await PlayerProfile.findByPk(userId);
  if (!p || p.visibility !== 'public') throw E.notFound('Player');
  const names = await directory.publicNames([userId]);
  const teamsSvc = require('./teams.service');
  const teams = await teamsSvc.teamsOf(userId);
  const sports = await teamsSvc.sportsById(teams.map((t) => t.sportId));
  const catalog = await Sport.findAll({ where: { key: (p.sports ?? []).map((s) => s.sportKey) } });
  const byKey = new Map(catalog.map((s) => [s.key, s]));
  const [hire, esports] = await Promise.all([require('../hire/profiles.service').liveFor(userId), require('../esports/esports.reads').hasAnyVerifiedProfile(userId)]);
  return {
    handle: names.get(userId)?.username ?? handle,
    displayName: names.get(userId)?.displayName ?? '—',
    bio: p.bio ?? null,
    sports: (p.sports ?? []).map((s) => {
      const sport = byKey.get(s.sportKey);
      const labels = new Map((sport?.positions ?? []).map((x) => [x.key, x]));
      return { sportKey: s.sportKey, nameEn: sport?.nameEn ?? s.sportKey, nameBn: sport?.nameBn ?? s.sportKey, positions: s.positions.map((k) => ({ key: k, en: labels.get(k)?.en ?? k, bn: labels.get(k)?.bn ?? k })) };
    }),
    teams: teams.map((t) => ({ id: t.id, name: t.name, role: t.role, sport: sports.get(t.sportId) ?? null })),
    hireProfiles: hire,
    esports: esports ? { handle: names.get(userId)?.username ?? handle } : null,
  };
}

/** A member's base readiness lines (phone, NID, DOB on file, gender recorded), with how to fix. */
function readiness(identity) {
  return [
    { key: 'phone_verified', status: identity.phoneVerified ? 'pass' : 'missing', fix: identity.phoneVerified ? null : 'add_phone' },
    { key: 'nid_verified', status: identity.kycStatus === 'verified' && identity.memberActive ? 'pass' : identity.kycStatus === 'pending' ? 'pending' : 'missing', fix: identity.kycStatus === 'verified' || identity.kycStatus === 'pending' ? null : 'verify_nid' },
    { key: 'gender_recorded', status: identity.gender ? 'pass' : 'missing', fix: identity.gender ? null : 'set_gender' },
  ];
}

/**
 * GET /me/eligibility?ageMin&ageMax&ageCutoff&gender — the caller only. Without rules it shows the
 * base readiness; with rules it also previews an event (age is shown only to the member themselves).
 */
async function mine(principal, query = {}) {
  const identity = (await directory.eligibilityIdentity([principal.user.id])).get(principal.user.id);
  const configGiven = query.ageMin !== undefined || query.ageMax !== undefined || query.gender !== undefined;
  const preview = configGiven ? rules.evaluate(identity, query, c.today()) : null;
  return { readiness: readiness(identity), preview };
}

/** For M14: each user's eligibility under a competition's rules ({ on } = the date to judge age on). */
async function checkMany(userIds, config, { on, transaction } = {}) {
  const identities = await directory.eligibilityIdentity(userIds, { transaction });
  const day = on ?? c.today();
  return new Map(userIds.map((id) => [id, rules.evaluate(identities.get(id) ?? { kycStatus: 'unverified', memberActive: false, dob: null, gender: null }, config, day)]));
}

module.exports = { getMine, putMine, publicPage, mine, checkMany };
