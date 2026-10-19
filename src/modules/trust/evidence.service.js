'use strict';

/**
 * M17 evidence files (FR-05): uploaded through the API as a raw body, typed by their first bytes
 * (JPEG, PNG, WebP, PDF; never the declared type), at most disputes.evidence_max_bytes each and
 * disputes.evidence_max_files per party, stored in the private bucket. Files are never served by a
 * public or signed URL: the parties and staff read them through the API, and every view is audited.
 */
const crypto = require('crypto');
const { uuid7 } = require('../../common/uuid7');
const { sniffMime } = require('../../common/filetype');
const storage = require('../../common/storage');
const settings = require('../settings').settings;
const audit = require('../audit').audit;
const { DisputeEvidence } = require('../../models');
const { fail } = require('./trust.errors');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Store one file for a party of a case (inside the caller's transaction, the case locked). */
async function store(d, party, actor, { body }, { transaction }) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const files = await DisputeEvidence.count({ where: { disputeId: d.id, party, kind: 'file' }, transaction });
  if (files >= settings.get('disputes.evidence_max_files')) throw fail('EVIDENCE_LIMIT');
  if (buf.length > settings.get('disputes.evidence_max_bytes')) throw fail('FILE_TOO_LARGE');
  const mime = sniffMime(buf);
  if (!mime || buf.length === 0) throw fail('FILE_TYPE');
  const id = uuid7();
  const key = `disputes/${d.id}/${id}`;
  await storage.putPrivate(key, buf, mime);
  return DisputeEvidence.create({ id, disputeId: d.id, party, kind: 'file', authorId: actor.id, fileKey: key, mime, sizeBytes: buf.length, sha256: sha256(buf) }, { transaction });
}

/** Read one file for someone allowed to see it; the view is audited (who, which case, which file). */
async function read(d, evidence, actor, req) {
  const obj = await storage.getPrivate(evidence.fileKey);
  await audit.record({ action: 'dispute.evidence_viewed', actor, entityType: 'dispute', entityId: d.id, entityCode: d.code, meta: { evidenceId: evidence.id, party: evidence.party }, req });
  return { body: obj.body, mime: evidence.mime };
}

module.exports = { store, read };
