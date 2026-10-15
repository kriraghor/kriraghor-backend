'use strict';

/**
 * Audit tamper evidence (M04-FR-05), sealed after commit.
 *   row_hash = SHA-256(prev_hash ‖ "|" ‖ canonical_json(audit row))
 * audit.chain-seal appends unsealed audit rows to audit_chain in id order. Business transactions never
 * wait for it, and a row that commits late is simply sealed in a later batch. audit.chain-verify walks
 * the chain and reports the first row whose content or link no longer matches.
 */
const crypto = require('crypto');
const { sequelize, AuditLog, AuditChain } = require('../../models');

/** JSON with sorted keys at every level, so the same data always hashes the same. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** The audited content of a row, normalised so reads from MySQL always produce the same text. */
function rowContent(row) {
  const r = typeof row.get === 'function' ? row.get({ plain: true }) : row;
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  return {
    id: String(r.id),
    occurredAt: iso(r.createdAt),
    actorType: r.actorType,
    actorId: r.actorId ?? null,
    actorRole: r.actorRole ?? null,
    action: r.action,
    module: r.module,
    entityType: r.entityType ?? null,
    entityId: r.entityId ?? null,
    entityCode: r.entityCode ?? null,
    before: r.before ?? null,
    after: r.after ?? null,
    reason: r.reason ?? null,
    severity: r.severity,
    stepUp: Boolean(r.stepUp),
    meta: r.meta ?? null,
    ip: r.ip ?? null,
    userAgent: r.userAgent ?? null,
    requestId: r.requestId ?? null,
    sessionId: r.sessionId ?? null,
  };
}

const hashRow = (prevHash, row) => crypto.createHash('sha256').update(`${prevHash ?? ''}|${canonical(rowContent(row))}`).digest('hex');

// Late commits are looked for this many ids behind the newest sealed row.
const LATE_WINDOW = 5000;

/** Append unsealed rows to the chain. One sealer at a time (MySQL named lock). */
async function seal({ batch = 500 } = {}) {
  return sequelize.transaction(async (transaction) => {
    const q = (sql, replacements) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT, transaction });
    const [{ locked }] = await q("SELECT GET_LOCK('kg_audit_chain_seal', 0) AS locked");
    if (Number(locked) !== 1) return { sealed: 0, skipped: true };
    try {
      const [last] = await q('SELECT seq, audit_log_id AS auditLogId, row_hash AS rowHash FROM audit_chain ORDER BY seq DESC LIMIT 1');
      const low = Math.max(0, Number(last?.auditLogId ?? 0) - LATE_WINDOW);
      const ids = await q(
        'SELECT a.id FROM audit_logs a LEFT JOIN audit_chain c ON c.audit_log_id = a.id WHERE a.id >= ? AND c.audit_log_id IS NULL ORDER BY a.id LIMIT ?',
        [low, batch]
      );
      if (!ids.length) return { sealed: 0 };
      const rows = await AuditLog.findAll({ where: { id: ids.map((r) => r.id) }, order: [['id', 'ASC']], transaction });
      let seq = Number(last?.seq ?? 0);
      let prev = last?.rowHash ?? null;
      const chain = rows.map((row) => {
        seq += 1;
        const rowHash = hashRow(prev, row);
        const link = { seq, auditLogId: row.id, prevHash: prev, rowHash };
        prev = rowHash;
        return link;
      });
      await AuditChain.bulkCreate(chain, { transaction });
      return { sealed: chain.length, lastSeq: seq };
    } finally {
      await q("SELECT RELEASE_LOCK('kg_audit_chain_seal')");
    }
  });
}

/**
 * Walk the chain from `fromSeq`. Returns { checked, ok, firstBad?, unsealedOlderThanHour }.
 * A row fails when its stored prev_hash is not the previous row_hash, or its content no longer hashes
 * to row_hash (an edited audit row).
 */
async function verify({ fromSeq = 1, pageSize = 1000 } = {}) {
  let prev = null;
  if (fromSeq > 1) prev = (await AuditChain.findByPk(fromSeq - 1))?.rowHash ?? null;
  let seq = fromSeq;
  let checked = 0;
  for (;;) {
    const links = await AuditChain.findAll({ where: { seq: { [sequelize.Sequelize.Op.gte]: seq } }, order: [['seq', 'ASC']], limit: pageSize });
    if (!links.length) break;
    const rows = new Map((await AuditLog.findAll({ where: { id: links.map((l) => l.auditLogId) } })).map((r) => [String(r.id), r]));
    for (const link of links) {
      const row = rows.get(String(link.auditLogId));
      const bad = !row || (link.prevHash ?? null) !== prev || hashRow(link.prevHash, row) !== link.rowHash;
      if (bad) return { checked, ok: false, firstBad: { seq: Number(link.seq), auditLogId: String(link.auditLogId) } };
      prev = link.rowHash;
      checked += 1;
    }
    seq = Number(links[links.length - 1].seq) + 1;
  }
  const [{ n }] = await sequelize.query(
    'SELECT COUNT(*) AS n FROM audit_logs a LEFT JOIN audit_chain c ON c.audit_log_id = a.id WHERE c.audit_log_id IS NULL AND a.created_at < UTC_TIMESTAMP(3) - INTERVAL 1 HOUR',
    { type: sequelize.QueryTypes.SELECT }
  );
  return { checked, ok: true, unsealedOlderThanHour: Number(n) };
}

/** Chain status of one audit row, for the detail drawer. */
async function statusOf(row) {
  const link = await AuditChain.findOne({ where: { auditLogId: row.id } });
  if (!link) return { sealed: false, seq: null, intact: null };
  return { sealed: true, seq: Number(link.seq), intact: hashRow(link.prevHash, row) === link.rowHash };
}

module.exports = { canonical, rowContent, hashRow, seal, verify, statusOf, LATE_WINDOW };
