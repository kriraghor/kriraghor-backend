'use strict';

/** M14 facts for notifications (M08 catalogue): names, captains and money, never personal data. */
const { Op } = require('sequelize');
const { Tournament, Registration, Match } = require('../../models');
const teamsSvc = require('../teams/teams.service');

async function tournament(id) {
  const t = await Tournament.findByPk(id, { attributes: ['id', 'name', 'slug', 'organisationId'] });
  return t ? { id: t.id, name: t.name, slug: t.slug, organisationId: t.organisationId } : { id, name: '', slug: '', organisationId: null };
}

async function registration(id) {
  const r = await Registration.findByPk(id);
  if (!r) return { team: '', tournament: '', refund: 0 };
  const [t, team] = await Promise.all([tournament(r.tournamentId), teamsSvc.getTeam(r.teamId)]);
  return { team: team?.name ?? '', tournament: t.name, slug: t.slug, refund: r.refundedPoisha, offerExpiresAt: r.offerExpiresAt };
}

/** Captains (who registered) of the approved teams. */
async function captains(tournamentId) {
  const rows = await Registration.findAll({ where: { tournamentId, status: 'approved' }, attributes: ['captainId'] });
  return [...new Set(rows.map((r) => r.captainId))];
}

/** Captains of the two teams in a match (from their registrations). */
async function matchCaptains(matchId) {
  const m = await Match.findByPk(matchId, { attributes: ['tournamentId', 'teamAId', 'teamBId'] });
  const teams = m ? [m.teamAId, m.teamBId].filter(Boolean) : [];
  if (!teams.length) return [];
  const rows = await Registration.findAll({ where: { tournamentId: m.tournamentId, teamId: { [Op.in]: teams }, status: 'approved' }, attributes: ['captainId'] });
  return [...new Set(rows.map((r) => r.captainId))];
}

module.exports = { tournament, registration, captains, matchCaptains };
