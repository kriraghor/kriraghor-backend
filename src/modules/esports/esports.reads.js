'use strict';

/**
 * M21 read-only views for other modules (M23 big events). Other modules never query M21's tables;
 * they call these. No status filtering: callers decide what is public.
 */
const models = require('../../models');

const { EsportsTournament, EsportsRegistration, EsportsRegistrationPlayer, EsportsStage, EsportsStanding, EsportsSquad, EsportsGameProfile, EsportsStream } = models;

const money = (poisha) => ({ amount: poisha, currency: 'BDT' });

/** Map tournamentId → the facts an event needs (status, schedule, game, mode, entry, prize pool). */
async function tournamentSummary(ids, { transaction } = {}) {
  const rows = ids.length ? await EsportsTournament.findAll({ where: { id: [...new Set(ids)] }, transaction }) : [];
  return new Map(
    rows.map((t) => [
      t.id,
      {
        id: t.id,
        slug: t.slug,
        titleEn: t.titleEn,
        titleBn: t.titleBn,
        status: t.status,
        gameId: t.gameId,
        modeId: t.modeId,
        entryUnit: t.entryUnit,
        entryPolicy: t.entryPolicy,
        organiserType: t.organiserType,
        maxSlots: t.maxSlots,
        minParticipants: t.minParticipants,
        prizePool: money(t.prizePoolPoisha),
        entryFee: money(t.entryFeePoisha),
        registrationOpensAt: t.registrationOpensAt,
        registrationClosesAt: t.registrationClosesAt,
        startsAt: t.startsAt,
        finalisedAt: t.finalisedAt ?? null,
      },
    ])
  );
}

/** Map registrationId → { registrationId, tournamentId, squadId, registrantUserId, status, playerUserIds }. */
async function entryIdentity(registrationIds, { transaction } = {}) {
  const ids = [...new Set(registrationIds)];
  if (!ids.length) return new Map();
  const regs = await EsportsRegistration.findAll({ where: { id: ids }, transaction });
  const players = await EsportsRegistrationPlayer.findAll({ where: { registrationId: ids, status: 'active' }, attributes: ['registrationId', 'userId', 'isSubstitute'], transaction });
  const by = new Map();
  for (const p of players) {
    if (!by.has(p.registrationId)) by.set(p.registrationId, []);
    by.get(p.registrationId).push(p.userId);
  }
  return new Map(regs.map((r) => [r.id, { registrationId: r.id, tournamentId: r.tournamentId, squadId: r.squadId ?? null, registrantUserId: r.registrantUserId, status: r.status, playerUserIds: by.get(r.id) ?? [] }]));
}

/** The first stage's standings with each entry's identity, best first (M21's unique rank). */
async function standingsWithEntries(tournamentId, { transaction } = {}) {
  const stage = await EsportsStage.findOne({ where: { tournamentId }, order: [['seq', 'ASC']], transaction });
  if (!stage) return [];
  const rows = await EsportsStanding.findAll({ where: { stageId: stage.id }, order: [['rank', 'ASC']], transaction });
  const who = await entryIdentity(
    rows.map((r) => r.registrationId),
    { transaction }
  );
  return rows.map((r) => ({ rank: r.rank, registrationId: r.registrationId, totalPoints: r.totalPoints, ...who.get(r.registrationId) }));
}

/** Display names for entries that may not have a registration yet (invites): squads and players. */
async function entryLabels({ squadIds = [], userIds = [] }, { transaction } = {}) {
  const squads = squadIds.length ? await EsportsSquad.findAll({ where: { id: [...new Set(squadIds)] }, attributes: ['id', 'name', 'tag', 'gameId', 'captainUserId'], transaction }) : [];
  const names = await require('../users/directory.service').publicNames([...new Set(userIds)], { transaction });
  return {
    squads: new Map(squads.map((s) => [s.id, { id: s.id, name: s.name, tag: s.tag, gameId: s.gameId, captainUserId: s.captainUserId }])),
    users: new Map([...names.entries()].map(([id, n]) => [id, { id, username: n?.username ?? null, displayName: n?.displayName ?? null }])),
  };
}

/** A squad's captain and game (staff invites check the squad plays the final's game). */
async function squadFacts(squadId, { transaction } = {}) {
  const s = await EsportsSquad.findByPk(squadId, { transaction });
  return s ? { id: s.id, gameId: s.gameId, captainUserId: s.captainUserId, status: s.status, name: s.name } : null;
}

/** Whether a user holds a verified UID for a game (staff invites of a solo player). */
async function hasVerifiedProfile(userId, gameId, { transaction } = {}) {
  return (await EsportsGameProfile.count({ where: { userId, gameId, status: 'verified' }, transaction })) > 0;
}

/** The active streams of public tournaments (an event page shows them with its own). */
async function streamsOf(tournamentIds, { transaction } = {}) {
  if (!tournamentIds.length) return [];
  const rows = await EsportsStream.findAll({ where: { tournamentId: [...new Set(tournamentIds)], status: 'active' }, order: [['tournamentId', 'ASC'], ['sort', 'ASC']], transaction });
  return rows.map((r) => ({ id: r.id, tournamentId: r.tournamentId, platform: r.platform, url: r.url, title: r.title, isLive: r.isLive, videoRef: r.videoRef ?? null }));
}

/** M16: whether a user has any verified game profile (their player page links the esports page). */
async function hasAnyVerifiedProfile(userId, { transaction } = {}) {
  return (await EsportsGameProfile.count({ where: { userId, status: 'verified' }, transaction })) > 0;
}

module.exports = { hasAnyVerifiedProfile, streamsOf, tournamentSummary, entryIdentity, standingsWithEntries, entryLabels, squadFacts, hasVerifiedProfile };
