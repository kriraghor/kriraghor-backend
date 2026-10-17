'use strict';

/**
 * M11 reads for other modules: M19 "Needs your action" (pros: requests to answer, check-ins open;
 * managers: requests to pay, jobs to confirm) and M08 notification facts. Codes, names and amounts only.
 */
const { Op } = require('sequelize');
const { HireRequest, HireJob, HireProfile } = require('../../models');
const taxonomy = require('../catalog/hire.reads');
const c = require('./hire.common');

const earliest = (rows, key) => rows.reduce((m, r) => (r[key] && (!m || r[key] < m) ? r[key] : m), null);

async function pendingActions(principal, role) {
  const items = [];
  if (role === 'pro') {
    const toAnswer = await HireRequest.findAll({ where: { proUserId: principal.id, status: 'pending' }, attributes: ['replyBy'] });
    const today = await HireJob.findAll({ where: { proUserId: principal.id, status: 'scheduled', startAt: { [Op.lt]: new Date(Date.now() + 86400000) } }, attributes: ['startAt'] });
    if (toAnswer.length) items.push({ key: 'hire_requests_to_answer', count: toAnswer.length, severity: 'high', dueAt: c.iso(earliest(toAnswer, 'replyBy')), href: '/pro/requests' });
    if (today.length) items.push({ key: 'hire_jobs_today', count: today.length, severity: 'normal', dueAt: c.iso(earliest(today, 'startAt')), href: '/pro/jobs' });
  } else {
    const toPay = await HireRequest.findAll({ where: { hirerId: principal.id, status: 'accepted_unpaid' }, attributes: ['payBy'] });
    const toConfirm = await HireJob.findAll({ where: { hirerId: principal.id, status: 'completed_marked' }, attributes: ['releaseAt'] });
    if (toPay.length) items.push({ key: 'hire_requests_to_pay', count: toPay.length, severity: 'high', dueAt: c.iso(earliest(toPay, 'payBy')), href: '/me/hire' });
    if (toConfirm.length) items.push({ key: 'hire_jobs_to_confirm', count: toConfirm.length, severity: 'normal', dueAt: c.iso(earliest(toConfirm, 'releaseAt')), href: '/me/hire' });
  }
  return items;
}

/** What a notification needs about a request or a job. */
async function facts({ requestId = null, jobId = null }) {
  const j = jobId ? await HireJob.findByPk(jobId) : null;
  const r = await HireRequest.findByPk(requestId ?? j.requestId);
  if (!r) return null;
  const p = await HireProfile.findByPk(r.profileId, { attributes: ['roleId', 'headline'] });
  const role = await taxonomy.role(p.roleId);
  const first = r.quoteSnapshot.lines.map((l) => l.start).sort()[0];
  return { code: j?.code ?? r.code, requestCode: r.code, roleEn: role?.nameEn ?? '', roleBn: role?.nameBn ?? '', headline: p.headline, total: r.totalPoisha, start: j ? c.iso(j.startAt) : first, payBy: c.iso(r.payBy), replyBy: c.iso(r.replyBy), quote: j?.quotePoisha ?? null, net: j?.netPoisha ?? r.netPoisha };
}

module.exports = { pendingActions, facts };
