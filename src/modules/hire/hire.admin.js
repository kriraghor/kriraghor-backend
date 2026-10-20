'use strict';

/**
 * M11 staff desk (admin.kriraghor.com/admin/hire): requests by code or status with each job's
 * timeline and escrow hold (no phone numbers), profiles (suspend with manage_users, restore as a
 * master), and a master's platform cancel of a job (full refund, step-up escrow.manage).
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { HireRequest, HireJob, HireProfile } = require('../../models');
const escrow = require('../payments').escrow;
const c = require('./hire.common');

async function requestView(r) {
  const jobs = await HireJob.findAll({ where: { requestId: r.id }, order: [['startAt', 'ASC']] });
  const p = await HireProfile.findByPk(r.profileId, { attributes: ['id', 'slug', 'headline'] });
  const holds = new Map();
  for (const j of jobs) {
    const id = r.paymentId ? await escrow.holdIdForPayment(r.paymentId, { splitRef: j.id }) : null;
    holds.set(j.id, id ? await escrow.getOne(id) : null);
  }
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    hirerId: r.hirerId,
    proUserId: r.proUserId,
    profile: { id: p.id, slug: p.slug, headline: p.headline },
    unit: r.unit,
    money: { total: r.totalPoisha, fee: r.feePoisha, net: r.netPoisha, feeBps: r.feeBps },
    replyBy: c.iso(r.replyBy),
    payBy: c.iso(r.payBy),
    paymentId: r.paymentId ?? null,
    createdAt: c.iso(r.createdAt),
    confirmedAt: c.iso(r.confirmedAt),
    jobs: jobs.map((j) => ({ ...c.jobView(j), escrow: holds.get(j.id) })),
  };
}

/** A job code (HR-26-000123-2) names its request (HR-26-000123); a request code stays as it is. */
const requestCodeOf = (code) => code.trim().toUpperCase().replace(/^(HR-\d{2}-\d{6,})-\d+$/, '$1');

/** GET /admin/hire/requests?code&status&cursor&limit (a job code finds its request). */
async function list({ code, status, cursor, limit = 50 } = {}) {
  const where = {};
  if (code) where.code = requestCodeOf(code);
  if (status) where.status = status;
  if (cursor) where.createdAt = { [Op.lt]: new Date(cursor) };
  const rows = await HireRequest.findAll({ where, order: [['createdAt', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => ({ id: r.id, code: r.code, status: r.status, total: r.totalPoisha, jobs: r.quoteSnapshot.lines.length, createdAt: c.iso(r.createdAt) })),
    nextCursor: rows.length > limit ? c.iso(page[page.length - 1].createdAt) : null,
  };
}

async function get(code) {
  const r = await HireRequest.findOne({ where: { code: requestCodeOf(code) } });
  if (!r) throw E.notFound('Request');
  return requestView(r);
}

module.exports = { list, get, requestView };
