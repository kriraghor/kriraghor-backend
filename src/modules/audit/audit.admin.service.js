'use strict';

/**
 * Audit log reads and exports for the admin portal (M04 §4, §9, FR-07, FR-08, FR-10).
 *  - search: master only, newest first, cursor = last id, range capped by audit.query_max_days;
 *  - entity history: masters see everything, other staff only rows where they are the actor;
 *  - exports: master + step-up audit.export, CSV built by the audit.export job into the private
 *    bucket, streamed back to the master who asked until audit.export_link_hours pass.
 */
const { Op } = require('sequelize');
const config = require('../../config');
const logger = require('../../common/logger');
const { AppError, E } = require('../../common/errors');
const { sequelize, AuditLog, AuditExport, User } = require('../../models');
const storage = require('../../common/storage');
const settings = require('../settings/settings.service');
const events = require('../events/events.service');
const audit = require('./audit.service');
const chain = require('./audit.chain');
const { summarize } = require('./audit.actions');

const DAY = 24 * 3600 * 1000;
const EXPORT_JOB = 'audit.export';
const EXPORT_PAGE = 1000;

const encodeCursor = (id) => Buffer.from(String(id)).toString('base64url');
function decodeCursor(cursor) {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d+$/.test(id)) throw E.validation([{ field: 'cursor', message: 'Invalid cursor' }]);
  return id;
}

/** Keep the first and last octet of an IPv4 address, or the first group of an IPv6 one. */
function maskIp(ip) {
  if (!ip) return null;
  const v4 = /^(\d+)\.\d+\.\d+\.(\d+)$/.exec(ip.replace(/^::ffff:/, ''));
  if (v4) return `${v4[1]}.***.***.${v4[2]}`;
  return `${ip.split(':')[0]}:****`;
}

/** Turn filters into a where clause; the range defaults to the last 7 days and is capped. */
function whereFrom(filters, { maxDays }) {
  const to = filters.to ? new Date(filters.to) : new Date();
  const from = filters.from ? new Date(filters.from) : new Date(to.getTime() - 7 * DAY);
  if (from > to) throw E.validation([{ field: 'from', message: 'Must be before "to"' }]);
  if (to.getTime() - from.getTime() > maxDays * DAY) {
    throw new AppError(422, 'RANGE_TOO_LARGE', `Pick at most ${maxDays} days`, { meta: { maxDays } });
  }
  const where = { createdAt: { [Op.gte]: from, [Op.lte]: to } };
  for (const k of ['actorId', 'actorType', 'module', 'entityType', 'entityId', 'severity']) if (filters[k]) where[k] = filters[k];
  if (filters.action?.length) where.action = filters.action;
  if (filters.stepUp !== undefined) where.stepUp = filters.stepUp;
  return { where, from, to };
}

async function namesFor(rows) {
  const ids = [...new Set(rows.map((r) => r.actorId).filter(Boolean))];
  if (!ids.length) return new Map();
  return new Map((await User.findAll({ where: { id: ids }, attributes: ['id', 'displayName'] })).map((u) => [u.id, u.displayName]));
}

function serialize(row, names, { fullIp = false } = {}) {
  const r = row.get({ plain: true });
  return {
    id: String(r.id),
    occurredAt: new Date(r.createdAt).toISOString(),
    actor: { type: r.actorType, id: r.actorId ?? null, name: r.actorId ? (names.get(r.actorId) ?? null) : null, role: r.actorRole ?? null },
    action: r.action,
    module: r.module,
    summary: { en: summarize(r, 'en'), bn: summarize(r, 'bn') },
    entity: { type: r.entityType ?? null, id: r.entityId ?? null, code: r.entityCode ?? null },
    before: r.before ?? null,
    after: r.after ?? null,
    reason: r.reason ?? null,
    severity: r.severity,
    stepUp: Boolean(r.stepUp),
    ip: fullIp ? (r.ip ?? null) : maskIp(r.ip),
  };
}

/** GET /admin/audit-logs */
async function search(filters) {
  const { where } = whereFrom(filters, { maxDays: settings.get('audit.query_max_days') });
  if (filters.cursor) where.id = { [Op.lt]: decodeCursor(filters.cursor) };
  const limit = filters.limit ?? 50;
  const rows = await AuditLog.findAll({ where, order: [['id', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const names = await namesFor(page);
  return { items: page.map((r) => serialize(r, names)), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1].id) : null };
}

/** GET /admin/audit-logs/:id with full IP, request metadata and chain status. */
async function getOne(id) {
  const row = await AuditLog.findByPk(id);
  if (!row) throw E.notFound('Audit entry');
  const names = await namesFor([row]);
  return {
    ...serialize(row, names, { fullIp: true }),
    meta: row.meta ?? null,
    requestId: row.requestId ?? null,
    sessionId: row.sessionId ?? null,
    userAgent: row.userAgent ?? null,
    chain: await chain.statusOf(row),
  };
}

/** GET /admin/entities/:entityType/:entityId/history (FR-07). */
async function entityHistory(principal, entityType, entityId, { cursor, limit = 50 } = {}) {
  const where = { entityType, entityId: String(entityId) };
  if (!principal.isMaster) where.actorId = principal.id;
  if (cursor) where.id = { [Op.lt]: decodeCursor(cursor) };
  const rows = await AuditLog.findAll({ where, order: [['id', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const names = await namesFor(page);
  return { items: page.map((r) => serialize(r, names)), nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1].id) : null };
}

// ---------------------------------------------------------------- exports (FR-10)

function serializeExport(row) {
  const ready = row.status === 'ready' && row.expiresAt && new Date(row.expiresAt) > new Date();
  return {
    id: row.id,
    status: row.status === 'ready' && !ready ? 'expired' : row.status,
    rowCount: row.rowCount ?? null,
    filters: row.filters,
    createdAt: new Date(row.createdAt).toISOString(),
    completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
    downloadPath: ready ? `${config.apiPrefix}/admin/audit-logs/exports/${row.id}/download` : null,
  };
}

/** POST /admin/audit-logs/exports → 202 */
async function requestExport(principal, filters) {
  whereFrom(filters, { maxDays: settings.get('audit.export_max_days') }); // validates the range now
  const row = await AuditExport.create({ requestedBy: principal.id, filters, status: 'queued' });
  if (!config.isTest) {
    const { getQueue, QUEUES } = require('../../jobs/queues');
    await getQueue(QUEUES.AUDIT).add(EXPORT_JOB, { exportId: row.id }, { jobId: `export-${row.id}`, attempts: 3, removeOnComplete: 100, removeOnFail: 500 });
  }
  return serializeExport(row);
}

async function ownExport(principal, id) {
  const row = await AuditExport.findByPk(id);
  if (!row || row.requestedBy !== principal.id) throw E.notFound('Export');
  return row;
}

/** GET /admin/audit-logs/exports/:id */
async function getExport(principal, id) {
  return serializeExport(await ownExport(principal, id));
}

/** GET /admin/audit-logs/exports/:id/download → { stream, filename } */
async function downloadExport(principal, id) {
  const row = await ownExport(principal, id);
  const view = serializeExport(row);
  if (view.status === 'expired') throw new AppError(410, 'EXPORT_EXPIRED', 'This export link has expired. Export again.');
  if (view.status !== 'ready') throw new AppError(409, 'EXPORT_NOT_READY', 'The export is still being prepared');
  const obj = await storage.getPrivate(row.objectKey);
  return { body: obj.body, filename: `kriraghor-audit-${row.id}.csv` };
}

/** CSV cell: quoted, with formula-looking values neutralised (CSV injection). */
function cell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const CSV_COLUMNS = ['id', 'occurredAt', 'actorType', 'actorId', 'actorName', 'actorRole', 'action', 'summary', 'module', 'entityType', 'entityId', 'entityCode', 'severity', 'stepUp', 'reason', 'before', 'after', 'ip', 'requestId'];

/** Job audit.export: build the CSV, store it, mark ready and audit the export itself. Idempotent. */
async function runExport({ exportId }) {
  const row = await AuditExport.findByPk(exportId);
  if (!row || ['ready', 'expired'].includes(row.status)) return { skipped: true };
  await row.update({ status: 'running', error: null });
  try {
    const { where } = whereFrom(row.filters, { maxDays: settings.get('audit.export_max_days') });
    const lines = [CSV_COLUMNS.join(',')];
    let cursor = null;
    let count = 0;
    for (;;) {
      const page = await AuditLog.findAll({ where: cursor ? { ...where, id: { [Op.lt]: cursor } } : where, order: [['id', 'DESC']], limit: EXPORT_PAGE });
      if (!page.length) break;
      const names = await namesFor(page);
      for (const r of page) {
        const s = serialize(r, names, { fullIp: true });
        lines.push(
          [s.id, s.occurredAt, s.actor.type, s.actor.id, s.actor.name, s.actor.role, s.action, s.summary.en, s.module, s.entity.type, s.entity.id, s.entity.code, s.severity, s.stepUp, s.reason, s.before, s.after, s.ip, r.requestId]
            .map(cell)
            .join(',')
        );
      }
      count += page.length;
      cursor = page[page.length - 1].id;
      if (page.length < EXPORT_PAGE) break;
    }
    const objectKey = `audit-exports/${row.id}.csv`;
    await storage.putPrivate(objectKey, `${lines.join('\r\n')}\r\n`, 'text/csv; charset=utf-8');
    const requester = await User.findByPk(row.requestedBy);
    await sequelize.transaction(async (transaction) => {
      await row.update({ status: 'ready', rowCount: count, objectKey, completedAt: new Date(), expiresAt: new Date(Date.now() + settings.get('audit.export_link_hours') * 3600 * 1000) }, { transaction });
      await audit.record(
        { action: 'audit_log.exported', actor: { id: requester.id, actorType: 'master', role: 'master_admin' }, entityType: 'audit_export', entityId: row.id, after: { rowCount: count, filters: row.filters }, stepUp: true },
        { transaction }
      );
      await events.publish(transaction, { name: 'audit_log.exported', aggregateType: 'audit_export', aggregateId: row.id, payload: { exportId: row.id, requestedBy: requester.id, rowCount: count } });
    });
    return { rows: count };
  } catch (err) {
    logger.error({ err, exportId }, 'audit export failed');
    await row.update({ status: 'failed', error: String(err?.message ?? err).slice(0, 2000) });
    throw err;
  }
}

module.exports = { search, getOne, entityHistory, requestExport, getExport, downloadExport, runExport, maskIp, cell, EXPORT_JOB };
