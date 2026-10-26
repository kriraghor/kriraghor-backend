'use strict';

/**
 * M11 availability (Round B1: §4 Manage › Availability, §7 availability_blocks, §9, FR-05, FR-14).
 *
 * A person marks time they are not available: one-off blocks, and weekly repeats ("every Fri
 * 18:00–22:00 until 30 Nov"). Blocks are per person, like the jobs' clash guard: one calendar for all of
 * a person's profiles. Booked time is read from hire_jobs (locked in the calendar, never copied).
 *  - GET /pro/availability?from&to: the stored blocks, the spans they cover in the range (repeats
 *    expanded) and the booked jobs (locked).
 *  - PUT /pro/availability/blocks: the full set of one-off blocks starting in [from, to) (missing ones
 *    are removed, new ones added), and, when `repeats` is sent, the full set of weekly repeats. Up to
 *    hire.availability_horizon_days ahead; never over a booked job (BLOCK_OVER_JOB). Not moderated,
 *    audited (FR-14).
 *  - GET /hire/profiles/:id/availability: busy spans only (blocks and jobs merged; no reasons, no jobs).
 *  - Requests: a request over a blocked time is refused (PRO_UNAVAILABLE) and the `available` check
 *    shows on the pro's view and re-runs on accept; the directory's "available today" reads the same.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, AvailabilityBlock, HireJob, HireProfile } = require('../../models');
const audit = require('../audit').audit;
const rules = require('./hire.rules');
const c = require('./hire.common');

const { fail } = c;
const DAY = 86400000;
const DEFAULT_DAYS = 14;

/** A range bound as Sequelize reads it ({ value, inclusive } or a bare value); unbounded → null. */
function bound(b) {
  const v = b !== null && typeof b === 'object' && !(b instanceof Date) ? b.value : b;
  return v === null || v === undefined || v === Infinity || v === -Infinity ? null : new Date(v);
}

const blockView = (b) => ({ id: b.id, userId: b.userId, start: bound(b.period[0]), end: bound(b.period[1]), reason: b.reason ?? null, repeat: b.repeatRule ?? null });
const range = (from, to) => [
  { value: from, inclusive: true },
  { value: to, inclusive: false },
];
const todayStart = (now) => rules.dhakaMidnight(rules.dhakaDay(now));

/** The active blocks of some people touching [from, to) (repeats by their validity). */
async function blocksOf(userIds, { from, to }, { transaction } = {}) {
  const rows = await AvailabilityBlock.findAll({ where: { userId: userIds, status: 'active', period: { [Op.overlap]: range(from, to) } }, order: [['createdAt', 'ASC']], transaction });
  return rows.map(blockView);
}

/** The active jobs of some people touching [from, to). */
const jobsOf = (userIds, { from, to }, { transaction } = {}) =>
  HireJob.findAll({ where: { proUserId: userIds, status: rules.ACTIVE_JOB, startAt: { [Op.lt]: to }, endAt: { [Op.gt]: from } }, attributes: ['id', 'code', 'proUserId', 'startAt', 'endAt', 'status'], order: [['startAt', 'ASC']], transaction });

/** A person's blocked spans (repeats expanded) and booked jobs in a range. */
async function busyFor(userId, r, { transaction } = {}) {
  const [blocks, jobs] = [await blocksOf([userId], r, { transaction }), await jobsOf([userId], r, { transaction })];
  return { blocks, spans: rules.expandBlocks(blocks, r), jobs };
}

/** The blocked spans overlapping a request's engagements ([{ start, end }]), for the checks. */
async function blockedFor(userId, lines, { transaction } = {}) {
  if (!lines.length) return [];
  const r = { from: new Date(Math.min(...lines.map((l) => Date.parse(l.start)))), to: new Date(Math.max(...lines.map((l) => Date.parse(l.end)))) };
  const spans = rules.expandBlocks(await blocksOf([userId], r, { transaction }), r);
  return lines.filter((l) => rules.overlapping(spans, l.start, l.end).length);
}

/** FR-05: whether each person has any time left today (Dhaka) that is neither blocked nor booked. */
async function availableToday(userIds, now = new Date()) {
  const r = { from: now, to: rules.dhakaMidnight(rules.addDays(rules.dhakaDay(now), 1)) };
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map();
  const [blocks, jobs] = await Promise.all([blocksOf(ids, r), jobsOf(ids, r)]);
  return new Map(
    ids.map((id) => {
      const spans = [...rules.expandBlocks(blocks.filter((b) => b.userId === id), r), ...jobs.filter((j) => j.proUserId === id).map((j) => ({ start: j.startAt, end: j.endAt }))];
      return [id, rules.hasFreeTime(spans, r.from, r.to)];
    })
  );
}

/** The range a read asks for: from (default today 00:00 Dhaka), to (default 14 days on), at most the horizon long. */
function readRange({ from, to } = {}, now = new Date()) {
  const cfg = c.config();
  const f = from ? new Date(from) : todayStart(now);
  const t = to ? new Date(to) : new Date(f.getTime() + DEFAULT_DAYS * DAY);
  if (t <= f) throw E.validation([{ field: 'to', message: 'The range must end after it starts' }]);
  if (t.getTime() - f.getTime() > (cfg.horizonDays + 1) * DAY) throw E.validation([{ field: 'to', message: `At most ${cfg.horizonDays} days at a time` }]);
  return { from: f, to: t };
}

const iso = (d) => (d ? new Date(d).toISOString() : null);
const spanView = (s) => ({ start: iso(s.start), end: iso(s.end) });

/** GET /pro/availability?from&to: my calendar. */
async function mine(principal, query = {}) {
  const cfg = c.config();
  const now = new Date();
  const r = readRange(query, now);
  const { blocks, spans, jobs } = await busyFor(principal.id, r);
  return {
    from: iso(r.from),
    to: iso(r.to),
    horizonDays: cfg.horizonDays,
    horizonEnd: iso(rules.horizonEnd(now, cfg.horizonDays)),
    blocks: blocks.filter((b) => !b.repeat).map((b) => ({ id: b.id, start: iso(b.start), end: iso(b.end), reason: b.reason })),
    repeats: blocks.filter((b) => b.repeat).map((b) => ({ id: b.id, ...b.repeat, validFrom: iso(b.start), reason: b.reason })),
    spans: spans.map((s) => ({ ...spanView(s), reason: s.reason, blockId: s.blockId, repeat: s.repeat })),
    booked: jobs.map((j) => ({ ...spanView({ start: j.startAt, end: j.endAt }), jobId: j.id, code: j.code, status: j.status, locked: true })),
  };
}

const oneOffKey = (b) => `${new Date(b.start).getTime()}|${new Date(b.end).getTime()}|${b.reason ?? ''}`;
const repeatKey = (r) => JSON.stringify([[...r.weekdays].sort(), r.from, r.to, r.until ?? null, r.reason ?? null]);
const ruleOf = (r) => ({ weekdays: [...new Set(r.weekdays)].sort(), from: r.from, to: r.to, ...(r.until ? { until: r.until } : {}) });

/**
 * PUT /pro/availability/blocks { from, to, blocks: [{ start, end, reason? }], repeats?: [{ weekdays, from, to, until?, reason? }] }.
 * Replaces the one-off blocks starting in [from, to), and every weekly repeat when `repeats` is sent.
 */
async function save(principal, body, req) {
  const cfg = c.config();
  const now = new Date();
  const r = { from: new Date(body.from), to: new Date(body.to) };
  const repeats = body.repeats ?? [];
  const errors = rules.blockErrors({ range: r, blocks: body.blocks, repeats, now, horizonDays: cfg.horizonDays });
  if (errors.length) throw E.validation(errors);
  const today = todayStart(now);
  const horizon = { from: today, to: rules.horizonEnd(now, cfg.horizonDays) };
  await sequelize.transaction(async (transaction) => {
    // One save at a time per person (two tabs): the advisory lock ends with the transaction.
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(?))', { replacements: [`availability:${principal.id}`], transaction });
    const repeatSpans = rules.expandBlocks(
      repeats.map((x, i) => ({ id: `new-${i}`, start: today, end: x.until ? rules.dhakaMidnight(rules.addDays(x.until, 1)) : null, repeat: ruleOf(x) })),
      horizon
    );
    const jobs = await jobsOf([principal.id], horizon, { transaction });
    const over = jobs.filter((j) => rules.overlapping([...body.blocks, ...repeatSpans], j.startAt, j.endAt).length);
    if (over.length) throw fail('BLOCK_OVER_JOB', { jobs: over.map((j) => j.code) });

    const stored = await AvailabilityBlock.findAll({
      where: { userId: principal.id, status: 'active', repeatRule: null, [Op.and]: [sequelize.where(sequelize.fn('lower', sequelize.col('period')), { [Op.gte]: r.from }), sequelize.where(sequelize.fn('lower', sequelize.col('period')), { [Op.lt]: r.to })] },
      transaction,
    });
    const plan = rules.replacePlan(stored.map((b) => ({ row: b, ...blockView(b) })), body.blocks, oneOffKey);
    let removed = plan.remove.length;
    let added = plan.add.length;
    const removal = { status: 'removed', removedBy: principal.id, removedAt: now };
    for (const x of plan.remove) await x.row.update(removal, { transaction });
    for (const b of plan.add) await AvailabilityBlock.create({ userId: principal.id, period: range(new Date(b.start), new Date(b.end)), reason: b.reason ?? null, createdBy: principal.id }, { transaction });
    if (body.repeats !== undefined) {
      const current = await AvailabilityBlock.findAll({ where: { userId: principal.id, status: 'active', repeatRule: { [Op.ne]: null } }, transaction });
      const rp = rules.replacePlan(
        current.map((b) => ({ row: b, ...b.repeatRule, reason: b.reason ?? null })),
        repeats.map((x) => ({ ...ruleOf(x), reason: x.reason ?? null })),
        repeatKey
      );
      for (const x of rp.remove) await x.row.update(removal, { transaction });
      for (const x of rp.add) {
        const until = x.until ? rules.dhakaMidnight(rules.addDays(x.until, 1)) : null;
        await AvailabilityBlock.create({ userId: principal.id, period: range(today, until), reason: x.reason, repeatRule: ruleOf(x), createdBy: principal.id }, { transaction });
      }
      removed += rp.remove.length;
      added += rp.add.length;
    }
    await audit.record({ action: 'availability.updated', actor: principal, entityType: 'user', entityId: principal.id, after: { added, removed }, meta: { from: iso(r.from), to: iso(r.to) }, req }, { transaction });
  });
  return mine(principal, { from: body.from, to: body.to });
}

/** GET /hire/profiles/:id/availability?from&to: busy spans only, from today up to the horizon. */
async function publicBusy(profileId, query = {}) {
  const p = await HireProfile.findByPk(profileId, { attributes: ['id', 'userId', 'status', 'liveSnapshot'] });
  if (!p || !p.liveSnapshot || !['live', 'paused'].includes(p.status)) throw E.notFound('Profile');
  const now = new Date();
  const asked = readRange(query, now);
  const r = { from: new Date(Math.max(asked.from.getTime(), todayStart(now).getTime())), to: new Date(Math.min(asked.to.getTime(), rules.horizonEnd(now, c.config().horizonDays).getTime())) };
  if (r.from >= r.to) return { from: iso(r.from), to: iso(r.from), busy: [] };
  const { spans, jobs } = await busyFor(p.userId, r);
  return { from: iso(r.from), to: iso(r.to), busy: rules.mergeSpans([...spans, ...jobs.map((j) => ({ start: j.startAt, end: j.endAt }))]).map(spanView) };
}

/** Whether a person ever used the calendar (completeness: any block saved, kept or removed). */
const hasUsedCalendar = async (userId) => (await AvailabilityBlock.count({ where: { userId } })) > 0;

module.exports = { mine, save, publicBusy, busyFor, blockedFor, availableToday, hasUsedCalendar, readRange, bound };
