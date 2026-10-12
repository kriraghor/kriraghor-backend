'use strict';

const { AuditLog } = require('../../models');
const logger = require('../../common/logger');

/**
 * Append-only audit trail (minimal M04). Call inside the same transaction as the
 * change it describes so a rolled-back change leaves no audit row.
 *
 * @param {object} entry
 * @param {string} entry.action        e.g. 'auth.signed_in', 'user.suspended'
 * @param {object} [entry.actor]       principal or { id, role }
 * @param {string} [entry.entityType]
 * @param {string} [entry.entityId]
 * @param {object} [entry.before]
 * @param {object} [entry.after]
 * @param {object} [entry.meta]
 * @param {import('express').Request} [entry.req]
 */
async function record({ action, actor, entityType, entityId, before, after, meta, req }, { transaction } = {}) {
  try {
    await AuditLog.create(
      {
        action,
        actorId: actor?.id ?? actor?.user?.id ?? null,
        actorRole: actor?.actingRole ?? actor?.role ?? null,
        entityType: entityType ?? null,
        entityId: entityId != null ? String(entityId) : null,
        before: before ?? null,
        after: after ?? null,
        meta: meta ?? null,
        ip: req?.ip ?? null,
        userAgent: req?.get?.('user-agent')?.slice(0, 512) ?? null,
        requestId: req?.id ?? null,
      },
      { transaction }
    );
  } catch (err) {
    // Inside a transaction the caller must fail too; outside, never break the request path.
    if (transaction) throw err;
    logger.error({ err, action }, 'audit write failed');
  }
}

module.exports = { record };
