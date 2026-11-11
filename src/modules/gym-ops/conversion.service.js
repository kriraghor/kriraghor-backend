'use strict';

/**
 * M27 conversion report (M27-FR-87 to FR-91; product owner, 11 Nov 2026): where a gym's members come from.
 * For the people who came in during a month, what became of them by today:
 *  - enquiries from the gym page ("Ask the gym", this module's gym_leads);
 *  - free trial visits and join requests (gym-manage, read through its `ops` facade);
 *  - the month's new members by source, and how many of them came from a visit or an enquiry.
 * Counts only: no names, no phones. The owner and reports.view; plan feature `reports`. A part whose feature
 * the plan lacks (leads, visits) is left out (null).
 */
const { Op, QueryTypes } = require('sequelize');
const { sequelize, GymLead } = require('../../models');
const { csv, withBom } = require('../../common/csv');
const rules = require('./gym-ops.rules');
const c = require('./gym-ops.common');

const FEATURE = 'reports';

/** Enquiries received in [from, to] (Dhaka dates of created_at) by what became of them. */
async function leadCounts(gymId, { from, to }) {
  const [row] = await sequelize.query(
    `SELECT COUNT(*)::int AS received,
            COUNT(*) FILTER (WHERE status = 'new')::int AS open,
            COUNT(*) FILTER (WHERE status = 'contacted')::int AS contacted,
            COUNT(*) FILTER (WHERE status = 'joined')::int AS joined,
            COUNT(*) FILTER (WHERE status = 'lost')::int AS lost
       FROM gym_leads
      WHERE gym_id = :gymId AND (created_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN :from AND :to`,
    { replacements: { gymId, from, to }, type: QueryTypes.SELECT }
  );
  return row;
}

/** The report's numbers for one gym and month (no access check: `get` and `exportCsv` do that). */
async function figures(gymId, month, today) {
  const period = rules.conversionPeriod(month, today);
  const [hasLeads, hasVisits, facts] = await Promise.all([c.ops.featureOn(gymId, 'leads'), c.ops.featureOn(gymId, 'visits'), c.ops.conversionFacts(gymId, period)]);
  const leads = hasLeads ? await leadCounts(gymId, period) : null;
  const fromEnquiry = hasLeads && facts.newMemberIds.length ? await GymLead.count({ where: { gymId, memberId: { [Op.in]: facts.newMemberIds } }, distinct: true, col: 'member_id' }) : 0;
  return rules.conversionReport({ period, today, leads, visits: hasVisits ? facts.visits : null, joinRequests: facts.joinRequests, members: { ...facts.members, fromEnquiry } });
}

/** GET …/reports/conversion?month=YYYY-MM (owner, reports.view; feature reports): default this month. */
async function get(principal, gymId, { month } = {}) {
  await c.access(principal, gymId, null, { anyOf: ['reports.view'], feature: FEATURE });
  return figures(gymId, month, c.today());
}

/** GET …/reports/conversion/export?month= (owner; feature reports): the same numbers as a CSV, audited. */
async function exportCsv(principal, gymId, { month } = {}, req) {
  const a = await c.access(principal, gymId, 'owner.only', { feature: FEATURE });
  const r = await figures(gymId, month, c.today());
  const rows = rules.conversionRows(r);
  const guard = require('../analytics').exportsGuard;
  guard.checkSize(rows.length);
  await guard.take(principal.id);
  await c.record({ action: 'gym_ops.conversion_exported', actor: a.actor, entityType: 'gym', entityId: gymId, meta: { month: r.period.month, rows: rows.length }, req });
  return { filename: `conversion-${r.period.month}.csv`, body: withBom(csv([['Group', 'Stage', 'Count'], ...rows])) };
}

module.exports = { get, exportCsv };
