'use strict';

/**
 * M24 reads for other modules (§2.1, M19): the gym owner's to-dos and a gym's staff to-dos. Counts
 * only, never member data or money.
 *  - pendingActions (M19 PROVIDERS.gym_owner): overdue dues across the owner's gyms, invoices to pay,
 *    the restricted panel, link requests waiting.
 *  - staffActions (M20's business adapter, M01 Round B3): dues due today and overdue, for fees.collect;
 *    join requests waiting, for members.edit (prompt 3).
 */
const { QueryTypes } = require('sequelize');
const config = require('../../config');
const { sequelize, GymSubscriptionInvoice, GymOwnerSubscription } = require('../../models');
const gymFacade = require('../gym').gyms;
const c = require('./gym-manage.common');

const gymUrl = (p) => `${config.apps.gym}${p}`;

/** The gym owner's to-dos (M19 GET /me/dashboard/actions?role=gym_owner). */
async function pendingActions(principal) {
  const gyms = await gymFacade.ofOwner(principal.id);
  if (!gyms.length) return [];
  const ids = gyms.map((g) => g.id);
  const today = c.today();
  const [row] = await sequelize.query(
    `SELECT (SELECT COUNT(*) FROM gym_dues WHERE gym_id IN (:ids) AND status IN ('unpaid', 'partial') AND due_on < :today)::int AS overdue,
            (SELECT COUNT(*) FROM gym_link_requests WHERE gym_id IN (:ids) AND status = 'pending' AND direction = 'join_request')::int AS requests`,
    { replacements: { ids, today }, type: QueryTypes.SELECT }
  );
  const invoices = await GymSubscriptionInvoice.findAll({ where: { ownerId: principal.id, status: ['issued', 'overdue'] }, attributes: ['status', 'dueAt'], order: [['dueAt', 'ASC']] });
  const sub = await GymOwnerSubscription.findOne({ where: { ownerId: principal.id }, attributes: ['status'] });
  const items = [];
  if (sub?.status === 'restricted') items.push({ key: 'gym_panel_restricted', count: 1, severity: 'high', dueAt: null, href: gymUrl('/manage/billing') });
  if (invoices.length) items.push({ key: 'gym_invoices_to_pay', count: invoices.length, severity: invoices.some((i) => i.status === 'overdue') ? 'high' : 'normal', dueAt: new Date(invoices[0].dueAt).toISOString(), href: gymUrl('/manage/billing') });
  if (row.overdue) items.push({ key: 'gym_dues_overdue', count: row.overdue, severity: 'normal', dueAt: null, href: gyms.length === 1 ? gymUrl(`/manage/${gyms[0].id}/fees`) : gymUrl('/manage') });
  if (row.requests) items.push({ key: 'gym_requests_waiting', count: row.requests, severity: 'normal', dueAt: null, href: gyms.length === 1 ? gymUrl(`/manage/${gyms[0].id}/requests`) : gymUrl('/manage') });
  return items;
}

/**
 * A gym's to-dos for one staff member (Round B3 business adapter): dues due today and overdue with
 * fees.collect; join requests waiting with members.edit (prompt 3, M24-FR-16).
 */
async function staffActions(gymId, permissions, now = new Date()) {
  const has = (p) => (permissions instanceof Set ? permissions.has(p) : (permissions ?? []).includes(p));
  const items = [];
  if (has('fees.collect')) {
    const today = c.today(now);
    const [row] = await sequelize.query(
      `SELECT COUNT(*) FILTER (WHERE due_on = :today)::int AS "dueToday", COUNT(*) FILTER (WHERE due_on < :today)::int AS overdue
         FROM gym_dues WHERE gym_id = :gymId AND status IN ('unpaid', 'partial') AND due_on <= :today`,
      { replacements: { gymId, today }, type: QueryTypes.SELECT }
    );
    const href = gymUrl(`/manage/${gymId}/fees`);
    if (row.dueToday) items.push({ key: 'gym_dues_due_today', count: row.dueToday, severity: 'normal', dueAt: null, href });
    if (row.overdue) items.push({ key: 'gym_dues_overdue', count: row.overdue, severity: 'normal', dueAt: null, href });
  }
  if (has('members.edit')) {
    const [row] = await sequelize.query(
      `SELECT COUNT(*)::int AS n FROM gym_link_requests WHERE gym_id = :gymId AND status = 'pending' AND direction = 'join_request' AND expires_at > :now`,
      { replacements: { gymId, now }, type: QueryTypes.SELECT }
    );
    if (row.n) items.push({ key: 'gym_requests_waiting', count: row.n, severity: 'normal', dueAt: null, href: gymUrl(`/manage/${gymId}/requests`) });
  }
  return items;
}

module.exports = { pendingActions, staffActions };
