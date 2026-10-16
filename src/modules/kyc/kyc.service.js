'use strict';

/**
 * M02 KYC lite: NID verification (§5, §8). The member uploads the NID front, back and a selfie
 * holding it (through the API, FR-03 lite), then submits the number, date of birth and legal name.
 * Staff with approve_documents review it on the KYC desk until M05 exists:
 *
 *   submit ─▶ in_review ─approve─▶ approved (verification.passed → M01 makes the member role active)
 *                       ─changes─▶ changes_requested ─resubmit─▶ in_review (new version)
 *                       ─reject──▶ rejected ─resubmit─▶ in_review (new version)
 *   resubmit while in_review: the open version becomes withdrawn (FR-11)
 *
 * The fields are encrypted (common/crypto); responses carry the masked number only. Every file view
 * and the NID reveal are audited (FR-12, FR-13). Images are purged after the retention period (FR-17).
 */
const crypto = require('crypto');
const { Op } = require('sequelize');
const { AppError, E } = require('../../common/errors');
const { encrypt, decrypt, hmac } = require('../../common/crypto');
const config = require('../../config');
const storage = require('../../common/storage');
const { uuid7 } = require('../../common/uuid7');
const { sequelize, DocumentRequirement, VerificationDocument, DocumentFile } = require('../../models');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const settings = require('../settings/settings.service');
const directory = require('../users/directory.service');
const rules = require('./kyc.rules');

const ERRORS = {
  NID_FORMAT_INVALID: [422, 'Enter the NID number with 10, 13 or 17 digits'],
  DOB_INVALID: [422, 'Enter the date of birth as on the NID'],
  DOB_IN_FUTURE: [422, 'The date of birth cannot be in the future'],
  UNDER_MIN_AGE: [422, 'You are below the minimum age for verification'],
  FILE_EMPTY: [422, 'The file is empty'],
  FILE_TOO_LARGE: [413, 'The file is too large'],
  FILE_TYPE_NOT_ALLOWED: [415, 'Upload a JPEG, PNG or PDF'],
  FILE_TYPE_MISMATCH: [415, 'The file is not the type it says it is'],
  FILES_INCOMPLETE: [422, 'Add the NID front, the back and a selfie holding it'],
  PHONE_REQUIRED: [409, 'Add and verify your phone number first'],
  DOC_ALREADY_APPROVED: [409, 'Your NID is already verified'],
  DOC_NOT_IN_REVIEW: [409, 'This document is not waiting for review'],
  RUBRIC_INCOMPLETE: [422, 'Tick every review check before approving'],
  CHECKS_FAILED: [409, 'A blocking check failed (for example, the NID is on another account)'],
  REASON_REQUIRED: [422, 'Choose a reason'],
  SELF_REVIEW_FORBIDDEN: [403, 'You cannot review your own documents'],
  FILE_PURGED: [410, 'This file was deleted after the retention period'],
};
const fail = (code) => new AppError(ERRORS[code][0], code, ERRORS[code][1]);

const nidHash = (normalised) => hmac(`nid:${normalised}`, config.kyc.nidHashSecret);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Active requirements for a role, in display order. */
const requirementsFor = (role, transaction) => DocumentRequirement.findAll({ where: { role, isActive: true }, order: [['sort', 'ASC']], transaction });

async function nidRequirement(transaction) {
  const req = await DocumentRequirement.findOne({ where: { role: 'member', docType: 'nid', isActive: true }, transaction });
  if (!req) throw new Error('The member NID requirement is not seeded');
  return req;
}

// Front, back, then selfie: the order a reviewer reads an NID in.
const SLOT_ORDER = ['front', 'back', 'selfie'];
const bySlot = (a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot);

function serialize(d, { files = [] } = {}) {
  return {
    id: d.id,
    docType: d.docType,
    version: d.version,
    status: d.status,
    numberMasked: d.fieldsPublic.numberMasked,
    birthYear: d.fieldsPublic.birthYear,
    reasonCode: d.reasonCode ?? null,
    reasonText: d.reasonText ?? null,
    decidedAt: d.decidedAt ?? null,
    submittedAt: d.createdAt,
    files: [...files].sort(bySlot).map((f) => ({ id: f.id, slot: f.slot, mime: f.mime, sizeBytes: f.sizeBytes, purged: Boolean(f.purgedAt) })),
  };
}

// ---------------------------------------------------------------- member: checklist (FR-18)

/** GET /me/verification: the member checklist, badge, unlocks and limits (§6.4, §6.5). */
async function verification(principal, locale = 'en') {
  const { user } = principal;
  const reqs = await requirementsFor('member');
  const current = await VerificationDocument.findOne({ where: { userId: user.id, docType: 'nid', isCurrent: true } });
  const files = current ? await DocumentFile.findAll({ where: { documentId: current.id }, order: [['slot', 'ASC']] }) : [];
  const bn = locale === 'bn';
  const items = reqs.map((r) => {
    const base = { key: r.docType ?? r.derivedKey, label: bn ? r.labelBn : r.labelEn, why: (bn ? r.whyBn : r.whyEn) ?? null, fileSlots: r.fileSlots };
    if (r.derivedKey === 'phone_verified') return { ...base, status: user.phone && user.phoneVerifiedAt ? 'approved' : 'missing', document: null };
    return { ...base, status: current?.status ?? 'missing', document: current ? serialize(current, { files }) : null };
  });
  const memberStatus = principal.roles?.member ?? null;
  return {
    role: 'member',
    memberStatus,
    badge: rules.badge(items),
    progress: { approved: items.filter((i) => i.status === 'approved').length, total: items.length },
    items,
    unlocks: bn ? ['মাঠ বুকিং ও অগ্রিম', 'খেলোয়াড় ও স্টাফ হায়ার', 'পুরনো পণ্য বিক্রি', 'এস্পোর্টস পুরস্কার তোলা'] : ['Book grounds and pay advances', 'Hire players and staff', 'Sell used gear', 'Withdraw esports winnings'],
    limits: bn ? ['একসাথে সর্বোচ্চ ৫টি পুরনো পণ্যের বিজ্ঞাপন'] : ['Up to 5 active used-gear listings'],
  };
}

// ---------------------------------------------------------------- member: upload and submit (FR-03 to FR-07, FR-11)

/** POST /me/documents/files?slot=: one file, checked by its first bytes, stored in the private bucket. */
async function uploadFile(principal, { slot, contentType, body }) {
  const requirement = await nidRequirement();
  if (!requirement.fileSlots.includes(slot)) throw E.validation([{ field: 'slot', message: `One of ${requirement.fileSlots.join(', ')}` }]);
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const block = rules.fileBlock({ declared, sniffed: rules.sniffMime(buf), size: buf.length, max: settings.get('kyc.max_file_bytes') });
  if (block) throw fail(block);
  const id = uuid7();
  const storageKey = `kyc/${principal.user.id}/${id}`;
  await storage.putPrivate(storageKey, buf, declared);
  const file = await DocumentFile.create({ id, userId: principal.user.id, slot, storageKey, mime: declared, sizeBytes: buf.length, sha256: sha256(buf) });
  return { fileId: file.id, slot, mime: file.mime, sizeBytes: file.sizeBytes };
}

/** POST /me/documents: submit the NID for review (a new version). */
async function submit(principal, { docType, fields, files }, req) {
  const { user } = principal;
  if (!user.phone || !user.phoneVerifiedAt) throw fail('PHONE_REQUIRED');
  const birthYear = /^\d{4}/.test(fields.dob) ? fields.dob.slice(0, 4) : null;
  const dobBlock = rules.dobBlock(fields.dob, new Date(), settings.get('kyc.min_age_years'));
  if (dobBlock) throw fail(dobBlock);
  const nid = rules.normaliseNid(fields.number, birthYear);
  if (nid.error) throw fail(nid.error);
  const legalName = fields.legalName.trim().replace(/\s+/g, ' ');
  const hash = nidHash(nid.value);

  return sequelize.transaction(async (transaction) => {
    const requirement = await nidRequirement(transaction);
    if (rules.slotsBlock(requirement.fileSlots, files)) throw fail('FILES_INCOMPLETE');
    const mine = await VerificationDocument.findAll({ where: { userId: user.id, docType, subjectKey: '' }, order: [['version', 'DESC']], transaction, lock: transaction.LOCK.UPDATE });
    if (mine.some((d) => d.status === 'approved' && d.isCurrent)) throw fail('DOC_ALREADY_APPROVED');
    const fileIds = Object.values(files);
    const rows = await DocumentFile.findAll({ where: { id: fileIds, userId: user.id, documentId: null, purgedAt: null }, transaction, lock: transaction.LOCK.UPDATE });
    if (rows.length !== fileIds.length || rows.some((f) => files[f.slot] !== f.id)) throw fail('FILES_INCOMPLETE');

    // FR-11: the previous current version stops being current; an open one is withdrawn.
    for (const d of mine.filter((x) => x.isCurrent)) {
      await d.update({ isCurrent: false, ...(d.status === 'in_review' ? { status: 'withdrawn' } : {}) }, { transaction });
    }
    const duplicateUsers =
      (await directory.nidHashHolders(hash, user.id)) +
      (await VerificationDocument.count({ where: { nidHash: hash, userId: { [Op.ne]: user.id }, status: { [Op.in]: ['in_review', 'approved'] } }, distinct: true, col: 'user_id', transaction }));
    const reusedFiles = await DocumentFile.count({ where: { sha256: rows.map((f) => f.sha256), userId: { [Op.ne]: user.id } }, transaction });
    const checks = rules.checks({ duplicateUsers, reusedFiles });
    const doc = await VerificationDocument.create(
      {
        userId: user.id,
        docType,
        version: (mine[0]?.version ?? 0) + 1,
        status: 'in_review',
        isCurrent: true,
        fieldsEnc: encrypt(JSON.stringify({ number: nid.value, numberAsTyped: String(fields.number).trim(), dob: fields.dob, legalName })),
        fieldsPublic: { numberMasked: rules.maskNid(nid.value), numberLength: nid.value.length, birthYear: Number(birthYear) },
        nidHash: hash,
        checks,
      },
      { transaction }
    );
    await DocumentFile.update({ documentId: doc.id }, { where: { id: fileIds }, transaction });
    await audit.record(
      { action: 'document.submitted', actor: principal, entityType: 'verification_document', entityId: doc.id, after: { docType, version: doc.version, status: doc.status }, req },
      { transaction }
    );
    const payload = { documentId: doc.id, userId: user.id, docType, version: doc.version };
    await events.publish(transaction, { name: 'document.submitted', aggregateType: 'verification_document', aggregateId: doc.id, payload, actor: principal, req });
    if (duplicateUsers > 0) {
      await events.publish(transaction, {
        name: 'document.duplicate_nid_detected',
        aggregateType: 'verification_document',
        aggregateId: doc.id,
        payload: { documentId: doc.id, userId: user.id, otherAccounts: duplicateUsers },
      });
    }
    return serialize(doc, { files: rows });
  });
}

/** GET /me/documents/:id/files/:fileId: the member's own upload. */
async function ownFile(principal, documentId, fileId) {
  const file = await DocumentFile.findOne({ where: { id: fileId, documentId, userId: principal.user.id } });
  if (!file) throw E.notFound('File');
  if (file.purgedAt) throw fail('FILE_PURGED');
  const obj = await storage.getPrivate(file.storageKey);
  return { body: obj.body, mime: file.mime };
}

// ---------------------------------------------------------------- staff: the KYC desk (FR-09, FR-12, FR-13)

/** GET /admin/kyc/documents?status: the queue, masked, oldest first while waiting. */
async function adminList({ status = 'in_review', cursor, limit = 50 } = {}) {
  const asc = status === 'in_review';
  const where = { status, ...(cursor ? { id: { [asc ? Op.gt : Op.lt]: cursor } } : {}) };
  const rows = await VerificationDocument.findAll({ where, order: [['id', asc ? 'ASC' : 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const people = await directory.identities(page.map((d) => d.userId));
  const [counts] = await sequelize.query('SELECT status, COUNT(*) AS n FROM verification_documents GROUP BY status');
  return {
    items: page.map((d) => ({
      ...serialize(d),
      user: { id: d.userId, displayName: people.get(d.userId)?.displayName ?? null },
      failedChecks: d.checks.filter((c) => !c.ok).map((c) => c.key),
    })),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
  };
}

/** GET /admin/kyc/documents/:id: fields for the reviewer (DOB and legal name; the number stays masked). */
async function adminGet(id) {
  const d = await VerificationDocument.findByPk(id);
  if (!d) throw E.notFound('Document');
  const fields = JSON.parse(decrypt(d.fieldsEnc));
  const files = await DocumentFile.findAll({ where: { documentId: d.id }, order: [['slot', 'ASC']] });
  const history = await VerificationDocument.findAll({ where: { userId: d.userId, docType: d.docType }, order: [['version', 'DESC']] });
  const who = (await directory.identities([d.userId])).get(d.userId);
  const contact = (await directory.contactFor([d.userId])).get(d.userId);
  return {
    ...serialize(d, { files }),
    fields: { legalName: fields.legalName, dob: fields.dob, numberMasked: d.fieldsPublic.numberMasked },
    checks: d.checks,
    decidedBy: d.decidedBy ?? null,
    user: { id: d.userId, displayName: who?.displayName ?? null, kycStatus: who?.kycStatus ?? null, phoneVerified: Boolean(contact?.phone), accountStatus: contact?.status ?? null },
    history: history.map((h) => ({ id: h.id, version: h.version, status: h.status, reasonCode: h.reasonCode ?? null, submittedAt: h.createdAt, decidedAt: h.decidedAt ?? null })),
  };
}

/** GET /admin/kyc/documents/:id/files/:fileId: stream one file to a reviewer; every view is audited. */
async function viewFile(actor, documentId, fileId, req) {
  const file = await DocumentFile.findOne({ where: { id: fileId, documentId } });
  if (!file) throw E.notFound('File');
  if (file.purgedAt) throw fail('FILE_PURGED');
  const obj = await storage.getPrivate(file.storageKey);
  await audit.record({ action: 'document.file_viewed', actor, entityType: 'verification_document', entityId: documentId, meta: { fileId, slot: file.slot }, req });
  return { body: obj.body, mime: file.mime };
}

/** POST /admin/kyc/documents/:id/reveal-nid: the full number for 60 seconds, with a reason (critical audit). */
async function revealNid(actor, id, { reason }, req) {
  const d = await VerificationDocument.findByPk(id);
  if (!d) throw E.notFound('Document');
  if (d.userId === actor.id) throw fail('SELF_REVIEW_FORBIDDEN');
  const { numberAsTyped, number } = JSON.parse(decrypt(d.fieldsEnc));
  await audit.record({ action: 'document.nid_revealed', actor, entityType: 'verification_document', entityId: d.id, reason, meta: { last4: number.slice(-4) }, req });
  return { documentId: d.id, number: numberAsTyped, normalised: number, showForSeconds: 60 };
}

const EVENT_FOR = { approved: 'document.approved', changes_requested: 'document.changes_requested', rejected: 'document.rejected' };

/** POST /admin/kyc/documents/:id/decide: approve (full rubric), request changes or reject (reason). */
async function decide(actor, id, { decision, rubric, reasonCode, note }, req) {
  return sequelize.transaction(async (transaction) => {
    const d = await VerificationDocument.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!d) throw E.notFound('Document');
    if (d.userId === actor.id) throw fail('SELF_REVIEW_FORBIDDEN');
    const block = rules.decisionBlock({ decision, status: d.status, checks: d.checks, rubric, reasonCode });
    if (block) throw fail(block);
    const status = rules.DOC_STATUS[decision];
    const before = { status: d.status };
    await d.update(
      { status, decidedBy: actor.id, decidedAt: new Date(), reasonCode: decision === 'approve' ? null : reasonCode, reasonText: decision === 'approve' ? null : note ?? null },
      { transaction }
    );
    await audit.record(
      { action: EVENT_FOR[status], actor, entityType: 'verification_document', entityId: d.id, before, after: { status, reasonCode: d.reasonCode }, reason: note ?? null, meta: { rubric: decision === 'approve' ? rubric : null }, req },
      { transaction }
    );
    const payload = { documentId: d.id, userId: d.userId, docType: d.docType, ...(decision === 'approve' ? {} : { reasonCode }) };
    await events.publish(transaction, { name: EVENT_FOR[status], aggregateType: 'verification_document', aggregateId: d.id, payload, actor, req });
    // FR-10: the member requirements are all satisfied (phone verified + NID approved) → M01 activates the role.
    if (status === 'approved') {
      const contact = (await directory.contactFor([d.userId])).get(d.userId);
      if (contact?.phone) {
        await events.publish(transaction, { name: 'verification.passed', aggregateType: 'user', aggregateId: d.userId, payload: { userId: d.userId, role: 'member' }, actor, req });
      }
    }
    return adminGetInTx(d, transaction);
  });
}

async function adminGetInTx(d, transaction) {
  const files = await DocumentFile.findAll({ where: { documentId: d.id }, order: [['slot', 'ASC']], transaction });
  return { ...serialize(d, { files }), checks: d.checks };
}

// ---------------------------------------------------------------- for other modules (§2)

/** VerificationService.getVerifiedIdentity (M01-FR-14): only from an approved NID. */
async function getVerifiedIdentity(userId, { transaction } = {}) {
  const d = await VerificationDocument.findOne({ where: { userId, docType: 'nid', status: 'approved', isCurrent: true }, transaction });
  if (!d) return null;
  const f = JSON.parse(decrypt(d.fieldsEnc));
  return { legalName: f.legalName, dob: f.dob, nidHash: d.nidHash, nidLast4: f.number.slice(-4), documentId: d.id };
}

/** Display facts for notifications (M08 reads them here). */
async function facts(id) {
  const d = await VerificationDocument.findByPk(id, { attributes: ['docType', 'reasonCode', 'reasonText', 'fieldsPublic'] });
  if (!d) throw E.notFound('Document');
  return { docType: d.docType, reasonCode: d.reasonCode ?? null, reasonText: d.reasonText ?? null, numberMasked: d.fieldsPublic.numberMasked };
}

// ---------------------------------------------------------------- retention (FR-17, job kyc.retention-purge)

/**
 * Delete stored images of decided documents after kyc.raw_image_retention_days, and uploads never
 * submitted after kyc.orphan_upload_hours. The row keeps the hash, type and size. Idempotent.
 */
async function purgeDue(now = new Date()) {
  const decidedBefore = new Date(now.getTime() - settings.get('kyc.raw_image_retention_days') * 86400000);
  const orphanBefore = new Date(now.getTime() - settings.get('kyc.orphan_upload_hours') * 3600000);
  const decided = await DocumentFile.findAll({
    where: { purgedAt: null, documentId: { [Op.ne]: null } },
    include: [{ association: 'document', attributes: ['status', 'decidedAt', 'updatedAt'], where: { status: { [Op.ne]: 'in_review' } } }],
  });
  const due = decided.filter((f) => (f.document.decidedAt ?? f.document.updatedAt) < decidedBefore);
  const orphans = await DocumentFile.findAll({ where: { purgedAt: null, documentId: null, createdAt: { [Op.lt]: orphanBefore } } });
  for (const f of [...due, ...orphans]) {
    await storage.deletePrivate(f.storageKey);
    await f.update({ purgedAt: now });
  }
  if (due.length || orphans.length) {
    await audit.record({ action: 'document.files_purged', actor: null, entityType: 'document_file', entityId: 'retention', meta: { decided: due.length, orphans: orphans.length } });
  }
  return { decided: due.length, orphans: orphans.length };
}

module.exports = { verification, uploadFile, submit, ownFile, adminList, adminGet, viewFile, revealNid, decide, getVerifiedIdentity, facts, purgeDue, requirementsFor, nidHash };
