'use strict';

/**
 * AuditService (M04-FR-01 to FR-03, FR-11). Append-only record of who did what to which entity, with
 * redacted before/after values, written in the caller's transaction: a rolled-back change leaves no
 * audit row, and a failed audit insert fails the change. Outside a transaction (reads such as a user
 * search) a failed write fails the request too (M04 §12).
 *
 * Module and severity come from the action registry (audit.actions.js). Critical actions also publish
 * audit.critical_recorded in the same transaction, which M08 turns into an alert for every master.
 */
const config = require('../../config');
const logger = require('../../common/logger');
const { AuditLog } = require('../../models');
const actions = require('./audit.actions');
const { redact } = require('./audit.redact');

function actorTypeOf(actor) {
  if (!actor) return 'system';
  if (actor.actorType) return actor.actorType;
  if (actor.role === 'system' || (!actor.id && !actor.user)) return 'system';
  if (actor.role === 'provider') return 'provider';
  if (actor.isMaster) return 'master';
  if (actor.isStaff) return 'staff';
  return 'user';
}

/**
 * @param {object} entry
 * @param {string} entry.action        registered in audit.actions.js, e.g. 'setting.changed'
 * @param {object} [entry.actor]       principal, { id }, or { id: null, role: 'system' }
 * @param {string} [entry.entityType]
 * @param {string} [entry.entityId]
 * @param {string} [entry.entityCode]  human code, e.g. 'BK-26-004812'
 * @param {object} [entry.before]
 * @param {object} [entry.after]
 * @param {string} [entry.reason]      required by the caller for decisions the design asks a reason for
 * @param {boolean} [entry.stepUp]     defaults to whether the request passed requireStepUp
 * @param {object} [entry.meta]
 * @param {import('express').Request} [entry.req]
 */
async function record(entry, { transaction } = {}) {
  const { action, actor, entityType, entityId, entityCode, before, after, reason, meta, req } = entry;
  const def = actions.get(action);
  if (!def) {
    // M04-FR-06: every action is registered. Tests fail loudly; production still records it.
    if (config.isTest) throw new Error(`Audit action ${action} is not in audit.actions.js`);
    logger.warn({ action }, 'unregistered audit action');
  }
  const severity = def?.severity ?? 'info';
  const row = await AuditLog.create(
    {
      action,
      module: def?.module ?? 'M00',
      severity,
      actorType: actorTypeOf(actor),
      actorId: actor?.id ?? actor?.user?.id ?? null,
      actorRole: actor?.actingRole ?? (actor?.isMaster ? 'master_admin' : actor?.isStaff ? 'staff' : actor?.role) ?? null,
      entityType: entityType ?? null,
      entityId: entityId != null ? String(entityId) : null,
      entityCode: entityCode ?? null,
      before: redact(before ?? null),
      after: redact(after ?? null),
      reason: reason ?? null,
      stepUp: Boolean(entry.stepUp ?? meta?.stepUp ?? req?.stepUp),
      // Round B3: a business's staff member acts for its owner; the row names the staff member as
      // the actor (actorRole business_staff) and the owner in meta.onBehalfOf.
      meta: redact(actor?.onBehalfOf ? { ...(meta ?? {}), onBehalfOf: actor.onBehalfOf } : meta ?? null),
      ip: req?.ip ?? null,
      userAgent: req?.get?.('user-agent')?.slice(0, 512) ?? null,
      requestId: req?.id ?? null,
      sessionId: req?.auth?.sessionId ?? null,
    },
    { transaction }
  );

  if (severity === 'critical') {
    // Required lazily: events.service → models only, but events.consumers → audit.service.
    const events = require('../events').events;
    await events.publish(transaction ?? null, {
      name: 'audit.critical_recorded',
      aggregateType: 'audit_log',
      aggregateId: row.id,
      payload: { auditLogId: String(row.id), action, actorId: row.actorId, entityType: row.entityType, entityId: row.entityId },
      actor,
      req,
    });
  }
  return row;
}

module.exports = { record, actorTypeOf };
