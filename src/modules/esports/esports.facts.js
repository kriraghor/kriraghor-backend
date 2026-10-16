'use strict';

/**
 * Read-only facts M08 needs for M21 notifications: who gets a message and the display values
 * (titles, amounts). Never credentials or UIDs.
 */
const models = require('../../models');

const { EsportsTournament, EsportsRegistration, EsportsRegistrationPlayer, EsportsMatch, EsportsSquad, EsportsCheckin } = models;

async function tournament(id) {
  const t = await EsportsTournament.findByPk(id, { attributes: ['id', 'slug', 'titleEn', 'titleBn', 'startsAt'] });
  return t ? { id: t.id, slug: t.slug, titleEn: t.titleEn, titleBn: t.titleBn, startsAt: t.startsAt } : null;
}

const title = (t, locale) => (t ? (locale === 'bn' ? t.titleBn : t.titleEn) : '');

/** Everyone in an entry: the registrant and its listed players (removed ones included when asked). */
async function entryPeople(registrationId, { includeRemoved = false } = {}) {
  const r = await EsportsRegistration.findByPk(registrationId, { attributes: ['registrantUserId'] });
  const players = await EsportsRegistrationPlayer.findAll({ where: { registrationId, ...(includeRemoved ? {} : { status: 'active' }) }, attributes: ['userId'] });
  return [...new Set([r?.registrantUserId, ...players.map((p) => p.userId)].filter(Boolean))];
}

/** Players of the tournament's confirmed or checked-in entries (check-in reminders). */
async function confirmedPlayers(tournamentId) {
  const regs = await EsportsRegistration.findAll({ where: { tournamentId, status: ['confirmed', 'checked_in'] }, attributes: ['id'] });
  const players = await EsportsRegistrationPlayer.findAll({ where: { registrationId: regs.map((r) => r.id), status: 'active' }, attributes: ['userId'] });
  return [...new Set(players.map((p) => p.userId))];
}

/** Everyone who had an entry (a cancelled tournament reaches all of them). */
async function allEntrants(tournamentId) {
  const regs = await EsportsRegistration.findAll({ where: { tournamentId }, attributes: ['id', 'registrantUserId'] });
  const players = await EsportsRegistrationPlayer.findAll({ where: { registrationId: regs.map((r) => r.id) }, attributes: ['userId'] });
  return [...new Set([...regs.map((r) => r.registrantUserId), ...players.map((p) => p.userId)])];
}

/** Players checked in for a match's stage (room ready, results posted). */
async function matchPlayers(matchId) {
  const m = await EsportsMatch.findByPk(matchId, { attributes: ['stageId', 'seq', 'tournamentId'] });
  if (!m) return { users: [], seq: null, tournamentId: null };
  const checkins = await EsportsCheckin.findAll({ where: { stageId: m.stageId }, attributes: ['userId'] });
  return { users: [...new Set(checkins.map((c) => c.userId))], seq: m.seq, tournamentId: m.tournamentId };
}

async function squadName(squadId) {
  const s = await EsportsSquad.findByPk(squadId, { attributes: ['name'] });
  return s?.name ?? '';
}

module.exports = { tournament, title, entryPeople, confirmedPlayers, allEntrants, matchPlayers, squadName };
