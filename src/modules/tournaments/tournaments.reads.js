'use strict';

/**
 * M14 reads for M19 (Round B2), through the tournaments facade (ADR-007):
 *   organiserFacts(organisationId)   the organiser dashboard (M19 §6.3 "Organiser", M14 §4.1 KPIs):
 *                                    each event's live team counts and matches, and its entry-fee
 *                                    money from the M06 escrow holds (never a balance of our own)
 *   pendingActions(principal)        "Needs your action" for organisation members (M19-FR-11):
 *                                    registrations waiting for approval (admins) and unpaid holds
 * Names, counts and money only: no captain, player or payer ids leave M14.
 */
const { Op } = require('sequelize');
const { Tournament, Registration, Match } = require('../../models');
const escrow = require('../payments').escrow;
const organisations = require('../organisations').organisations;
const rules = require('./tournaments.rules');

/** Events an organiser sees on the dashboard: everything that passed review (drafts and reviews are not events yet). */
const SHOWN = { [Op.notIn]: ['draft', 'pending_review', 'changes_requested', 'rejected'] };
const RUNNING = ['registration_open', 'registration_closed', 'live'];
const ADMINS = ['owner', 'admin'];
const SPORTS_LIVE = (o) => o.kind === 'sports' && ['verified', 'suspended'].includes(o.status);

const countBy = (rows, status) => rows.filter((r) => r.status === status).length;

/** Entry-fee money of one event from its escrow holds (M06), plus when each fee was collected. */
async function moneyOf(t) {
  const items = [];
  for (let cursor; ; ) {
    const page = await escrow.list({ purpose: 'tournament_entry', groupRef: t.id, cursor, limit: 500 });
    items.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const money = { collected: 0, held: 0, released: 0, refunded: 0, fees: 0 };
  for (const h of items) {
    money.collected += h.held;
    money.released += h.released;
    money.refunded += h.refunded;
    money.fees += h.feeTaken;
    money.held += h.available;
  }
  return { money, collections: items.map((h) => ({ tournamentId: t.id, at: h.createdAt, amount: h.held })) };
}

/**
 * The organiser dashboard's facts for one organisation: events (oldest first) with live team counts,
 * matches and money; every registration's created and approved times (for registrations over time);
 * and each collected entry fee with its time (for fees by period).
 */
async function organiserFacts(organisationId) {
  const ts = await Tournament.findAll({ where: { organisationId, status: SHOWN }, order: [['createdAt', 'ASC']] });
  if (!ts.length) return { tournaments: [], registrations: [], collections: [] };
  const ids = ts.map((t) => t.id);
  const [regs, matches, money] = await Promise.all([
    Registration.findAll({ where: { tournamentId: { [Op.in]: ids } }, attributes: ['tournamentId', 'status', 'createdAt', 'approvedAt'] }),
    Match.findAll({ where: { tournamentId: { [Op.in]: ids }, status: { [Op.ne]: 'cancelled' } }, attributes: ['tournamentId', 'status'] }),
    Promise.all(ts.map((t) => moneyOf(t))),
  ]);
  return {
    tournaments: ts.map((t, i) => {
      const r = regs.filter((x) => x.tournamentId === t.id);
      const m = matches.filter((x) => x.tournamentId === t.id);
      return {
        id: t.id,
        name: t.name,
        status: t.status,
        running: RUNNING.includes(t.status),
        maxTeams: t.maxTeams,
        approved: countBy(r, 'approved'),
        waiting: countBy(r, 'pending_approval'),
        unpaid: countBy(r, 'pending_payment'),
        reserve: countBy(r, 'reserve'),
        matches: m.length,
        played: m.filter((x) => rules.TERMINAL_MATCH.includes(x.status)).length,
        money: money[i].money,
      };
    }),
    registrations: regs.map((r) => ({ tournamentId: r.tournamentId, status: r.status, createdAt: r.createdAt, approvedAt: r.approvedAt })),
    collections: money.flatMap((x) => x.collections),
  };
}

const earliest = (dates) => dates.filter(Boolean).reduce((m, d) => (!m || d < m ? d : m), null);

/** M19-FR-11 for organisation members: per sports organisation, teams to approve (admins) and unpaid holds. */
async function pendingActions(principal) {
  const orgs = (await organisations.listMine(principal)).items.filter(SPORTS_LIVE);
  const items = [];
  for (const o of orgs) {
    const ts = await Tournament.findAll({ where: { organisationId: o.id, status: { [Op.in]: RUNNING } }, attributes: ['id', 'registrationClosesAt'] });
    if (!ts.length) continue;
    const regs = await Registration.findAll({ where: { tournamentId: { [Op.in]: ts.map((t) => t.id) }, status: { [Op.in]: ['pending_approval', 'pending_payment'] } }, attributes: ['status', 'holdExpiresAt'] });
    const href = `/vendor/tournaments/${o.id}`;
    const waiting = countBy(regs, 'pending_approval');
    if (waiting && ADMINS.includes(o.role)) {
      items.push({ key: 'registrations_waiting', count: waiting, severity: 'high', dueAt: earliest(ts.map((t) => t.registrationClosesAt))?.toISOString() ?? null, href });
    }
    const unpaid = regs.filter((r) => r.status === 'pending_payment');
    if (unpaid.length) items.push({ key: 'registrations_unpaid', count: unpaid.length, severity: 'low', dueAt: earliest(unpaid.map((r) => r.holdExpiresAt))?.toISOString() ?? null, href });
  }
  return items;
}

module.exports = { organiserFacts, pendingActions };
