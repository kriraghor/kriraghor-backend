'use strict';

/**
 * M27 profit and loss (M27-FR-27): a gym's income (fees, counter sales, locker fees), the cost of the goods
 * sold, expenses by category and the net, for a period and the same length just before it. The owner and
 * reports.view; plan feature `pnl`. Fees come from gym-manage (net of reversals; online fees less the
 * provider charge passed through).
 */
const { E } = require('../../common/errors');
const rules = require('./gym-ops.rules');
const c = require('./gym-ops.common');
const expenses = require('./expenses.service');
const shop = require('./shop.service');

async function totals(gymId, from, to) {
  const [fees, sales, spent] = await Promise.all([c.ops.collected(gymId, from, to), shop.totals(gymId, from, to), expenses.totals(gymId, from, to)]);
  return rules.profitAndLoss({
    counterFees: fees.counterPoisha,
    onlineFees: fees.onlinePoisha,
    providerCharge: fees.providerChargePoisha,
    posSales: sales.posSales,
    lockerFees: sales.lockerFees,
    goodsCost: sales.goodsCost,
    expenses: spent,
  });
}

/** GET …/pnl?from&to (owner, reports.view): default this month so far. */
async function get(principal, gymId, { from, to } = {}) {
  await c.access(principal, gymId, null, { anyOf: ['reports.view'], feature: 'pnl' });
  const today = c.today();
  const end = to ?? today;
  const start = from ?? `${end.slice(0, 7)}-01`;
  if (rules.daysBetween(start, end) > 366) throw E.validation([{ field: 'from', message: 'At most one year' }]);
  const before = rules.previousPeriod(start, end);
  const [current, previous] = await Promise.all([totals(gymId, start, end), totals(gymId, before.from, before.to)]);
  // Dashboards (M27-FR-27a): income, costs and net per month for the trend chart.
  const months = rules.trendMonths(end, today, c.cfg().pnlTrendMonths);
  const trend = await Promise.all(
    months.map(async (m) => {
      const t = await totals(gymId, m.from, m.to);
      return { month: m.month, from: m.from, to: m.to, income: t.income.total, costs: t.goodsCost + t.expenses.total, net: t.net };
    })
  );
  return { from: start, to: end, current, previous: { ...previous, ...before }, trend };
}

module.exports = { get, totals };
