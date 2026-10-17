'use strict';

/**
 * What M10 Bookings reads from M09 (it never queries M09 tables directly):
 *   ground(groundId)                 status, owner, cutoff, officials, area, public courts
 *   isOpen(courtIds, start, minutes) every half-hour inside the courts' hours (§6.3)
 *   closesAt(courtId, day)           the closing time, for "The ground closes at 11pm."
 *   publishedVersionAt(groundId, t)  the pricing version in force at t (M10-FR-04)
 *   versionById(id)                  any version, for extensions priced on the booking's snapshot
 *   hoursFor(courtIds)               the weekly hours rows (availability grid, conflicts)
 *   courts(courtIds)                 ground, status, sports and group of courts (moves)
 *   liveGroundsOf(ownerId)           an owner's live grounds with public courts (move targets)
 *   price / quote                    the shared calculator (pricing.rules)
 *   pendingActions(principal)        M19 "Needs your action": grounds with changes requested or unfinished drafts
 */
const { Op } = require('sequelize');
const { Ground, Court, CourtHours, PricingRule } = require('../../models');
const pr = require('./pricing.rules');
const rules = require('./grounds.rules');
const c = require('./grounds.common');

async function ground(groundId, { transaction } = {}) {
  const g = await Ground.findByPk(groundId, { transaction });
  if (!g) return null;
  const s = g.liveSnapshot;
  return {
    id: g.id,
    ownerId: g.ownerId,
    status: g.status,
    bookable: g.status === 'live',
    areaId: s?.areaId ?? g.areaId,
    bookingCutoffMin: s?.bookingCutoffMin ?? g.bookingCutoffMin,
    requiresOfficial: s?.requiresOfficial ?? [],
    courts: (s?.courts ?? []).map((k) => ({ id: k.id, name: k.name, sportIds: k.sportIds, combinableGroup: k.combinableGroup, sort: k.sort })),
  };
}

async function isOpen(courtIds, start, minutes, { transaction } = {}) {
  const hours = await CourtHours.findAll({ where: { courtId: courtIds }, transaction });
  const t0 = new Date(start).getTime();
  for (let i = 0; i < minutes; i += 30) {
    const { hour, minute, dow } = pr.dhakaParts(t0 + i * 60000);
    if (!courtIds.every((id) => rules.isOpenAt(hours.find((h) => h.courtId === id && h.dow === dow), hour * 60 + minute))) return false;
  }
  return true;
}

async function closesAt(courtId, day) {
  const dow = pr.dhakaParts(pr.dhakaInstant(day, 0)).dow;
  const row = await CourtHours.findOne({ where: { courtId, dow } });
  return row && !row.isClosed ? row.closeTime : null;
}

const asRules = (row) => (row ? { id: row.id, version: row.version, ...c.rulesOf(row) } : null);

async function publishedVersionAt(groundId, at = new Date(), { transaction } = {}) {
  const row = await PricingRule.findOne({
    where: {
      groundId,
      status: ['published', 'superseded'],
      effectiveFrom: { [Op.lte]: at },
      [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gt]: at } }],
    },
    order: [['version', 'DESC']],
    transaction,
  });
  return asRules(row);
}

const versionById = async (id, { transaction } = {}) => asRules(await PricingRule.findByPk(id, { transaction }));

async function hoursFor(courtIds, { transaction } = {}) {
  const rows = await CourtHours.findAll({ where: { courtId: courtIds }, transaction });
  return rows.map((h) => ({ courtId: h.courtId, dow: h.dow, isClosed: h.isClosed, openTime: h.openTime, closeTime: h.closeTime }));
}

async function courts(courtIds, { transaction } = {}) {
  const rows = await Court.findAll({ where: { id: courtIds }, transaction });
  return rows.map((k) => ({ id: k.id, groundId: k.groundId, name: k.name, status: k.status, sportIds: k.sportIds, combinableGroup: k.combinableGroup }));
}

async function liveGroundsOf(ownerId, { transaction } = {}) {
  const rows = await Ground.findAll({ where: { ownerId, status: 'live' }, transaction });
  return rows.map((g) => ({ id: g.id, name: g.liveSnapshot?.name ?? g.name, areaId: g.liveSnapshot?.areaId ?? g.areaId, courts: (g.liveSnapshot?.courts ?? []).map((k) => ({ id: k.id, name: k.name, sportIds: k.sportIds })) }));
}

async function pendingActions(principal) {
  const rows = await Ground.findAll({ where: { ownerId: principal.id }, attributes: ['id', 'status', 'editStatus'] });
  const changes = rows.filter((g) => g.status === 'changes_requested' || g.editStatus === 'changes_requested');
  const drafts = rows.filter((g) => g.status === 'draft');
  return [
    ...changes.map((g) => ({ key: 'ground_changes_requested', count: 1, severity: 'high', dueAt: null, href: `/vendor/grounds/${g.id}` })),
    ...(drafts.length ? [{ key: 'ground_draft', count: drafts.length, severity: 'normal', dueAt: null, href: '/vendor/grounds' }] : []),
  ];
}

module.exports = { pendingActions, ground, isOpen, hoursFor, courts, liveGroundsOf, closesAt, publishedVersionAt, versionById, price: pr.price, quote: pr.quote, advanceOf: pr.advanceOf, seriesPrice: pr.seriesPrice };
