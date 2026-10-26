'use strict';

/**
 * M11 hire requests (FR-20 to FR-26, v3).
 *
 * POST /hire/requests (gate hire: a verified phone, Idempotency-Key): the server quotes each
 * engagement from the profile's current rate card and snapshots it. The pro sees the automatic
 * checks and accepts (re-run under the request lock; the jobs are reserved by an exclusion constraint
 * per person, so two accepts for the same time cannot both win: SCHEDULE_CLASH) or declines with a
 * reason, within hire.reply_hours and before the cut-off before the first start. Accepting starts one
 * M06 payment for the total, split into one escrow hold per job (payee: the pro); the manager pays
 * within hire.payment_window_min. Only payment.succeeded confirms (purpose hook); unpaid requests
 * lapse and free the time; a capture after that is refunded hold by hold (late_capture).
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { AppError, E } = require('../../common/errors');
const { nextCode } = require('../../common/sequences');
const { sequelize, HireProfile, HireRequest, HireJob } = require('../../models');
const settings = require('../settings').settings;
const audit = require('../audit').audit;
const payments = require('../payments').intents;
const purposes = require('../payments').purposes;
const fees = require('../payments').fees;
const directory = require('../users').directory;
const kyc = require('../kyc').kyc;
const taxonomy = require('../catalog').hireReads;
const { payUrl } = require('../payments').intents;
const dir = require('./directory.service');
const availability = require('./availability.service');
const rules = require('./hire.rules');
const c = require('./hire.common');

const { fail } = c;
const OPEN = ['pending', 'accepted_unpaid'];

// ---------------------------------------------------------------- views

async function view(r, viewer, { transaction } = {}) {
  const [jobs, profile] = [await HireJob.findAll({ where: { requestId: r.id }, order: [['startAt', 'ASC']], transaction }), await HireProfile.findByPk(r.profileId, { transaction })];
  const role = await taxonomy.role(profile.roleId);
  const otherId = viewer === r.hirerId ? r.proUserId : r.hirerId;
  const contact = (await directory.contactFor([otherId], { transaction })).get(otherId);
  return {
    request: c.requestView(r, jobs, {
      profile: { id: profile.id, slug: profile.slug, headline: profile.liveSnapshot?.headline ?? profile.headline, role: { key: role.key, nameEn: role.nameEn, nameBn: role.nameBn } },
      other: { name: contact?.displayName ?? null, phone: contact?.phone ?? null },
      viewer,
    }),
    payment: viewer === r.hirerId && r.status === 'accepted_unpaid' && r.paymentId ? { id: r.paymentId, payUrl: payUrl(r.paymentId) } : null,
  };
}

async function party(principal, idOrCode, { transaction, lock = false } = {}) {
  const where = /^[0-9a-f-]{36}$/i.test(idOrCode) ? { id: idOrCode } : { code: idOrCode };
  const r = await HireRequest.findOne({ where, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!r || (r.hirerId !== principal.id && r.proUserId !== principal.id)) throw fail('NOT_A_PARTY');
  return r;
}

// ---------------------------------------------------------------- hirer

/** POST /hire/requests { profileId, unit, engagements[], note }. */
async function create(principal, body, idempotencyKey, req) {
  const again = () => HireRequest.findOne({ where: { hirerId: principal.id, idempotencyKey } });
  const existing = await again();
  if (existing) return view(existing, principal.id);
  const p = await HireProfile.findByPk(body.profileId);
  if (!p || p.status !== 'live') throw fail('PROFILE_NOT_AVAILABLE');
  if (p.userId === principal.id) throw fail('OWN_PROFILE');
  const cfg = c.config();
  if (body.engagements.length > cfg.engagementsMax) throw E.validation([{ field: 'engagements', message: `At most ${cfg.engagementsMax}` }]);
  const now = new Date();
  const q = await dir.quoteFor(p, body, now);
  const firstStart = q.lines.map((l) => l.start).sort()[0];
  const replyBy = rules.replyBy({ now, firstStart, replyHours: cfg.replyHours, beforeStartMin: cfg.replyBeforeStartMin });
  if (replyBy <= now) throw E.validation([{ field: 'engagements', message: 'Too close to the start for the pro to reply' }]);
  // FR-20: one open request per person and time from the same manager.
  const open = await HireRequest.findAll({ where: { hirerId: principal.id, profileId: p.id, status: OPEN }, attributes: ['id'] });
  if (open.length) {
    const theirs = await HireJob.findAll({ where: { requestId: open.map((o) => o.id), status: rules.ACTIVE_JOB } });
    const pending = open.length > theirs.length ? await HireRequest.findAll({ where: { id: open.map((o) => o.id) }, attributes: ['quoteSnapshot'] }) : [];
    const spans = [...theirs.map((j) => [new Date(j.startAt).getTime(), new Date(j.endAt).getTime()]), ...pending.flatMap((x) => x.quoteSnapshot.lines.map((l) => [Date.parse(l.start), Date.parse(l.end)]))];
    if (q.lines.some((l) => spans.some(([s, e]) => Date.parse(l.start) < e && Date.parse(l.end) > s))) throw fail('DUPLICATE_REQUEST');
  }
  // Round B1 (FR-05): not over time the pro marked as not available.
  const blocked = await availability.blockedFor(p.userId, q.lines);
  if (blocked.length) throw fail('PRO_UNAVAILABLE', { starts: blocked.map((l) => l.start) });
  const feeBps = fees.snapshot('hire').feeBps;
  const jobMoney = q.lines.map((l) => rules.money([l.total], feeBps));
  const fee = jobMoney.reduce((n, m) => n + m.fee, 0);
  try {
    const r = await sequelize.transaction(async (transaction) => {
      const row = await HireRequest.create(
        {
          code: await nextCode('HR', transaction),
          hirerId: principal.id,
          profileId: p.id,
          proUserId: p.userId,
          unit: body.unit,
          note: body.note ?? null,
          rateCardId: q.rateCardId,
          quoteSnapshot: { rateCardVersion: q.rateCardVersion, maxJobsPerDay: q.maxJobsPerDay, lines: q.lines },
          totalPoisha: q.total,
          feeBps,
          feePoisha: fee,
          netPoisha: q.total - fee,
          status: 'pending',
          replyBy,
          idempotencyKey,
        },
        { transaction }
      );
      await c.publishRequest(transaction, 'hire_request.sent', row, { replyBy: replyBy.toISOString(), jobs: q.lines.length }, principal);
      await audit.record({ action: 'hire_request.sent', actor: principal, entityType: 'hire_request', entityId: row.id, entityCode: row.code, after: { total: q.total, jobs: q.lines.length }, req }, { transaction });
      return row;
    });
    return view(r, principal.id);
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const row = await again();
      if (row) return view(row, principal.id);
    }
    throw err;
  }
}

/** POST /me/hire-requests/:id/withdraw: free while pending or unpaid. */
async function withdraw(principal, id, req) {
  const r = await sequelize.transaction(async (transaction) => {
    const row = await party(principal, id, { transaction, lock: true });
    const to = rules.nextRequest('withdraw', row.status, row.hirerId === principal.id ? 'hirer' : 'pro');
    if (!to) throw fail('REQUEST_STATE', { status: row.status });
    await closeUnpaid(row, to, 'withdrawn', { transaction });
    await audit.record({ action: 'hire_request.withdrawn', actor: principal, entityType: 'hire_request', entityId: row.id, entityCode: row.code, req }, { transaction });
    return row;
  });
  return view(r, principal.id);
}

/** POST /me/hire-requests/:id/pay: the payment link of an accepted, unpaid request. */
async function payLink(principal, id) {
  const r = await party(principal, id);
  if (r.hirerId !== principal.id || r.status !== 'accepted_unpaid') throw fail('REQUEST_STATE');
  return view(r, principal.id);
}

// ---------------------------------------------------------------- pro

/** The automatic checks of a request now (§6.5), for the pro's view and inside accept. */
async function checksOf(r, { transaction } = {}) {
  const [profile, cfg] = [await HireProfile.findByPk(r.profileId, { transaction }), c.config()];
  const role = await taxonomy.role(profile.roleId, { transaction });
  const lines = r.quoteSnapshot.lines;
  const days = [...new Set(lines.map((l) => rules.dhakaDay(l.start)))];
  const [credential, policeUntil] = [await kyc.credentialFor(r.proUserId, role.key, { transaction }), await kyc.policeClearedUntil(r.proUserId, { transaction })];
  const clashes = [];
  const perDay = {};
  const mine = await HireJob.findAll({ where: { proUserId: r.proUserId, status: rules.ACTIVE_JOB, requestId: { [Op.ne]: r.id } }, attributes: ['code', 'startAt', 'endAt'], transaction });
  const blocked = await availability.blockedFor(r.proUserId, lines, { transaction });
  for (const j of mine) {
    const d = rules.dhakaDay(j.startAt);
    if (days.includes(d)) perDay[d] = (perDay[d] ?? 0) + 1;
    const busy = rules.busyOf({ start: j.startAt, end: j.endAt, bufferMin: cfg.bufferMin });
    if (lines.some((l) => { const b = rules.busyOf({ start: l.start, end: l.end, bufferMin: cfg.bufferMin }); return b.from < busy.to && b.to > busy.from; })) clashes.push(j.code);
  }
  return rules.checks({
    role,
    experienceLevel: profile.liveSnapshot?.experienceLevel ?? profile.experienceLevel,
    credential,
    policeUntil,
    jobs: lines.map((l) => ({ start: l.start, u16: l.u16 })),
    clashes,
    perDay,
    maxPerDay: r.quoteSnapshot.maxJobsPerDay,
    now: new Date(),
    leadMin: cfg.replyBeforeStartMin,
    blocked,
  });
}

/** GET /pro/requests?status: requests to my profiles, with the checks for the pending ones. */
async function listForPro(principal, { status } = {}) {
  const rows = await HireRequest.findAll({ where: { proUserId: principal.id, ...(status ? { status } : {}) }, order: [['createdAt', 'DESC']], limit: 100 });
  return { items: await Promise.all(rows.map(async (r) => ({ ...(await view(r, principal.id)), checks: r.status === 'pending' ? await checksOf(r) : null }))) };
}

/** POST /pro/requests/:id/accept: checks re-run, jobs reserved, the manager asked to pay. */
async function accept(principal, id, req) {
  const r = await sequelize.transaction(async (transaction) => {
    const row = await party(principal, id, { transaction, lock: true });
    if (row.proUserId !== principal.id) throw fail('NOT_A_PARTY');
    const to = rules.nextRequest('accept', row.status, 'pro');
    if (!to) throw fail('REQUEST_STATE', { status: row.status });
    const now = new Date();
    if (now >= row.replyBy) throw fail('REPLY_WINDOW_CLOSED');
    const failed = (await checksOf(row, { transaction })).filter((x) => !x.ok);
    if (failed.length) throw new AppError(422, 'CHECKS_FAILED', c.ERRORS.CHECKS_FAILED[1], { errors: failed.map((x) => ({ field: x.key, message: c.CHECK_TEXT[x.key] })) });
    const cfg = c.config();
    const jobs = [];
    await c.guarded(transaction, async (savepoint) => {
      for (const [i, l] of row.quoteSnapshot.lines.entries()) {
        const m = rules.money([l.total], row.feeBps);
        const busy = rules.busyOf({ start: l.start, end: l.end, bufferMin: cfg.bufferMin });
        jobs.push(
          await HireJob.create(
            {
              code: `${row.code}-${i + 1}`,
              requestId: row.id,
              profileId: row.profileId,
              proUserId: row.proUserId,
              hirerId: row.hirerId,
              startAt: l.start,
              endAt: l.end,
              busy: [{ value: busy.from, inclusive: true }, { value: busy.to, inclusive: false }],
              format: l.format,
              hours: l.hours,
              night: l.night,
              u16: l.u16,
              venueGroundId: l.venueGroundId,
              venueText: l.venueText,
              venueAreaId: l.venueAreaId,
              zone: l.zone,
              quotePoisha: l.total,
              feePoisha: m.fee,
              netPoisha: m.net,
              status: 'reserved',
            },
            { transaction: savepoint }
          )
        );
      }
    });
    const firstStart = row.quoteSnapshot.lines.map((l) => l.start).sort()[0];
    const payBy = rules.payBy({ now, firstStart, windowMin: cfg.paymentWindowMin, beforeStartMin: cfg.payBeforeStartMin });
    const p = await payments.createIntent(
      {
        purpose: 'hire',
        purposeId: row.id,
        payerId: row.hirerId,
        amount: row.totalPoisha,
        splits: jobs.map((j) => ({ ref: j.id, payeeId: j.proUserId, amount: j.quotePoisha })),
        title: `Hire ${row.code}`,
        expiresAt: payBy,
        idempotencyKey: `hire:${row.id}`,
      },
      { transaction }
    );
    await row.update({ status: to, decidedAt: now, payBy, paymentId: p.id }, { transaction });
    await c.publishRequest(transaction, 'hire_request.accepted', row, { payBy: payBy.toISOString() }, principal);
    await audit.record({ action: 'hire_request.accepted', actor: principal, entityType: 'hire_request', entityId: row.id, entityCode: row.code, after: { status: to, jobs: jobs.length }, req }, { transaction });
    return row;
  });
  return view(r, principal.id);
}

/** POST /pro/requests/:id/decline { reason, text? }. */
async function decline(principal, id, { reason, text = null }, req) {
  const r = await sequelize.transaction(async (transaction) => {
    const row = await party(principal, id, { transaction, lock: true });
    if (row.proUserId !== principal.id) throw fail('NOT_A_PARTY');
    const to = rules.nextRequest('decline', row.status, 'pro');
    if (!to) throw fail('REQUEST_STATE', { status: row.status });
    await row.update({ status: to, decidedAt: new Date(), closedAt: new Date(), declineReasonCode: reason, declineText: text }, { transaction });
    await c.publishRequest(transaction, 'hire_request.declined', row, { reason }, principal);
    await audit.record({ action: 'hire_request.declined', actor: principal, entityType: 'hire_request', entityId: row.id, entityCode: row.code, after: { reason }, req }, { transaction });
    return row;
  });
  return view(r, principal.id);
}

// ---------------------------------------------------------------- payment results (M06)

/** Close a request before payment (withdrawn, lapsed, expired): its reserved jobs are void, the intent cancelled. */
async function closeUnpaid(r, to, eventSuffix, { transaction }) {
  await HireJob.update({ status: 'void' }, { where: { requestId: r.id, status: 'reserved' }, transaction });
  if (r.paymentId) {
    try {
      await payments.cancelIntent(r.paymentId, { transaction });
    } catch {
      // A capture that lands later is rejected by onCaptured and refunded in full by M06.
    }
  }
  await r.update({ status: to, closedAt: new Date(), payBy: null }, { transaction });
  await c.publishRequest(transaction, `hire_request.${eventSuffix}`, r);
}

/** M06 purpose hook (inside the capture transaction). */
async function onCaptured({ payment, transaction }) {
  const r = await HireRequest.findOne({ where: { paymentId: payment.id }, transaction, lock: transaction.LOCK.UPDATE });
  if (!r) return 'reject';
  if (['confirmed', 'completed'].includes(r.status)) return 'accept';
  if (r.status !== 'accepted_unpaid') return 'reject';
  const now = new Date();
  await HireJob.update({ status: 'scheduled' }, { where: { requestId: r.id, status: 'reserved' }, transaction });
  await r.update({ status: rules.nextRequest('pay', r.status, 'system'), confirmedAt: now, payBy: null }, { transaction });
  await c.publishRequest(transaction, 'hire_request.paid', r, { paymentId: payment.id });
  return 'accept';
}

/** payment.failed / payment.expired (purpose hire): the unpaid request lapses and frees the time. */
async function onPaymentClosed(paymentId, { transaction }) {
  const r = await HireRequest.findOne({ where: { paymentId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!r || r.status !== 'accepted_unpaid') return null;
  await closeUnpaid(r, 'lapsed', 'lapsed', { transaction });
  return 'lapsed';
}

/** Tick: pending requests past reply_by expire; unpaid ones past pay_by (plus the M06 grace) lapse. */
async function sweep(now = new Date()) {
  const grace = settings.get('payments.unknown_grace_minutes') * 60000;
  const out = { expired: 0, lapsed: 0 };
  const pending = await HireRequest.findAll({ where: { status: 'pending', replyBy: { [Op.lte]: now } }, attributes: ['id'] });
  for (const { id } of pending) {
    await sequelize.transaction(async (transaction) => {
      const r = await c.lockRequest(id, transaction);
      if (r.status !== 'pending') return;
      await r.update({ status: 'expired', closedAt: now }, { transaction });
      await c.publishRequest(transaction, 'hire_request.expired', r);
      out.expired += 1;
    });
  }
  const unpaid = await HireRequest.findAll({ where: { status: 'accepted_unpaid', payBy: { [Op.lt]: new Date(now.getTime() - grace) } }, attributes: ['id'] });
  for (const { id } of unpaid) {
    await sequelize.transaction(async (transaction) => {
      const r = await c.lockRequest(id, transaction);
      if (r.status !== 'accepted_unpaid') return;
      await closeUnpaid(r, 'lapsed', 'lapsed', { transaction });
      out.lapsed += 1;
    });
  }
  return out;
}

/** After a job settles: a confirmed request whose jobs are all settled is completed (or cancelled). */
async function syncRequest(requestId, { transaction }) {
  const r = await c.lockRequest(requestId, transaction);
  if (r.status !== 'confirmed') return r;
  const jobs = await HireJob.findAll({ where: { requestId }, attributes: ['status'], transaction });
  const to = rules.requestAfterJobs(jobs.map((j) => j.status));
  if (!to) return r;
  await r.update({ status: rules.nextRequest(to === 'completed' ? 'complete' : 'cancel', r.status, 'system'), closedAt: new Date() }, { transaction });
  await c.publishRequest(transaction, to === 'completed' ? 'hire_request.completed' : 'hire_request.cancelled', r);
  return r;
}

/** GET /me/hire-requests: my requests as the manager. */
async function listMine(principal, { status } = {}) {
  const rows = await HireRequest.findAll({ where: { hirerId: principal.id, ...(status ? { status } : {}) }, order: [['createdAt', 'DESC']], limit: 100 });
  return { items: await Promise.all(rows.map((r) => view(r, principal.id))) };
}

async function getOne(principal, idOrCode) {
  const r = await party(principal, idOrCode);
  const v = await view(r, principal.id);
  return r.proUserId === principal.id && r.status === 'pending' ? { ...v, checks: await checksOf(r) } : v;
}

purposes.register('hire', { onCaptured });

module.exports = { create, withdraw, payLink, listForPro, accept, decline, onCaptured, onPaymentClosed, sweep, syncRequest, listMine, getOne, view, party, checksOf };
