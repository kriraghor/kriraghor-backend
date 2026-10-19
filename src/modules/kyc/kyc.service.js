'use strict';

/**
 * M02 KYC lite: NID verification (§5, §8). The member uploads the NID front, back and a selfie
 * holding it (through the API, FR-03 lite), then submits the number, date of birth and legal name.
 * Each version goes to M05 as a `document` submission (FR-08). Staff with approve_documents claim and
 * decide it on the Moderation desk, and kyc.moderation applies the decision here (FR-09):
 *
 *   submit ─▶ in_review ─approved─▶ approved (verification.passed → M01 makes the member role active)
 *                       ─changes──▶ changes_requested ─resubmit─▶ in_review (new version)
 *                       ─rejected─▶ rejected ─resubmit─▶ in_review (new version)
 *   resubmit while in_review: the open version is withdrawn here and superseded in M05 (FR-11)
 *
 * The fields are encrypted (common/crypto); responses carry the masked number only. Every file view
 * and the NID reveal are audited (FR-12, FR-13). Images are purged after the retention period (FR-17).
 *
 * Business-role documents (M09 ground owners, M12 shop owners): each is a requirement row of the role
 * with its own fields (field_schema) and one file. A ground owner sends a trade licence, a deed or
 * lease and optionally a TIN; a shop owner a trade licence, a TIN and, when VAT registered, a BIN.
 * They are kept per role (subject_key = the role), so a ground's licence never counts for a shop.
 * They follow the same versions and M05 review; when every required one of the role is approved,
 * verification.passed {role} lets M01 activate the role. The member (NID) role must be active first.
 */
const crypto = require('crypto');
const { Op } = require('sequelize');
const { AppError, E } = require('../../common/errors');
const { encrypt, decrypt, hmac } = require('../../common/crypto');
const config = require('../../config');
const storage = require('../../common/storage');
const { uuid7 } = require('../../common/uuid7');
const { sequelize, DocumentRequirement, VerificationDocument, DocumentFile, DocumentRequest } = require('../../models');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const settings = require('../settings/settings.service');
const directory = require('../users/directory.service');
const rules = require('./kyc.rules');
const moderation = require('../moderation/moderation.service');
const { subjectIdFor } = require('./kyc.moderation');

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
  DOC_ALREADY_APPROVED: [409, 'This document is already verified'],
  SELF_REVIEW_FORBIDDEN: [403, 'You cannot review your own documents'],
  FILE_PURGED: [410, 'This file was deleted after the retention period'],
  MEMBER_NOT_ACTIVE: [409, 'Verify your NID first'],
  ROLE_NOT_APPLIED: [409, 'Apply for this business role first'],
  DOC_TYPE_NOT_REQUIRED: [422, 'This document is not needed for that role'],
  ROLE_AMBIGUOUS: [422, 'Say which business role this document is for'],
  REVEAL_NOT_AVAILABLE: [409, 'Only an NID number can be revealed'],
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

/** The active requirement of a document type: the NID for members; a business type (its file slots are the same for every role). */
async function requirementOf(docType, transaction) {
  if (docType === 'nid') return nidRequirement(transaction);
  const req = await DocumentRequirement.findOne({ where: { docType, isActive: true }, order: [['role', 'ASC']], transaction });
  if (!req) throw fail('DOC_TYPE_NOT_REQUIRED');
  return req;
}

/** M12: the requirement a business document is sent for (the role asked, or the only applied role needing the type). */
async function businessRequirement(principal, docType, asked, transaction) {
  const reqs = await DocumentRequirement.findAll({ where: { docType, isActive: true }, transaction });
  const appliedRoles = Object.entries(principal.roles ?? {})
    .filter(([r, status]) => r !== 'member' && !['withdrawn', 'suspended'].includes(status))
    .map(([r]) => r);
  const picked = rules.businessRoleFor({ asked, requirementRoles: reqs.map((r) => r.role), appliedRoles });
  if (picked.error) throw fail(picked.error);
  return reqs.find((r) => r.role === picked.role);
}

// Front, back, then selfie: the order a reviewer reads an NID in. Business documents have one file.
const SLOT_ORDER = ['front', 'back', 'selfie', 'document'];
const bySlot = (a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot);

function serialize(d, { files = [] } = {}) {
  return {
    id: d.id,
    docType: d.docType,
    version: d.version,
    status: d.status,
    numberMasked: d.fieldsPublic.numberMasked ?? null,
    birthYear: d.fieldsPublic.birthYear ?? null,
    expiresOn: d.fieldsPublic.expiresOn ?? null,
    reasonCode: d.reasonCode ?? null,
    reasonText: d.reasonText ?? null,
    decidedAt: d.decidedAt ?? null,
    submittedAt: d.createdAt,
    files: [...files].sort(bySlot).map((f) => ({ id: f.id, slot: f.slot, mime: f.mime, sizeBytes: f.sizeBytes, purged: Boolean(f.purgedAt) })),
  };
}

// ---------------------------------------------------------------- member: checklist (FR-18)

const UNLOCKS = {
  ground_owner: {
    en: ['List your venues and set prices', 'Take bookings with an advance', 'Get paid at check-in'],
    bn: ['আপনার ভেন্যু তালিকাভুক্ত করুন ও দাম ঠিক করুন', 'অগ্রিমসহ বুকিং নিন', 'চেক-ইনে টাকা পান'],
  },
  player: {
    en: ['Get listed in Hire as a player', 'Take paid matches and sessions', 'Get paid when the manager confirms'],
    bn: ['খেলোয়াড় হিসেবে হায়ারে তালিকাভুক্ত হন', 'টাকার বিনিময়ে ম্যাচ ও সেশন নিন', 'ম্যানেজার নিশ্চিত করলে টাকা পান'],
  },
  pro: {
    en: ['Get listed in Hire (coaches, officials, medical, media, team staff)', 'Set your own rates', 'Get paid when the manager confirms'],
    bn: ['হায়ারে তালিকাভুক্ত হন (কোচ, অফিসিয়াল, চিকিৎসা, মিডিয়া, দলের কর্মী)', 'নিজের রেট ঠিক করুন', 'ম্যানেজার নিশ্চিত করলে টাকা পান'],
  },
  organiser: {
    en: ['Register your esports organisation', 'Run PUBG Mobile and Free Fire events on Kriraghor under a contract', 'Paid entries, room reveal, results and prize payouts handled for you'],
    bn: ['আপনার ইস্পোর্টস প্রতিষ্ঠান নিবন্ধন করুন', 'চুক্তির অধীনে ক্রীড়াঘরে পাবজি মোবাইল ও ফ্রি ফায়ার ইভেন্ট চালান', 'পেইড এন্ট্রি, রুম রিভিল, ফলাফল ও পুরস্কার প্রদান আমরা সামলাই'],
  },
  gym_owner: {
    en: ['List your gym with hours and photos', 'Sell day, month and quarter passes online', 'Admit members by QR at the front desk and get paid'],
    bn: ['খোলার সময় ও ছবিসহ আপনার জিম তালিকাভুক্ত করুন', 'অনলাইনে দৈনিক, মাসিক ও ত্রৈমাসিক পাস বিক্রি করুন', 'ফ্রন্ট ডেস্কে কিউআর দিয়ে সদস্যদের ঢুকতে দিন ও টাকা পান'],
  },
  shop_owner: {
    en: ['Open your shop on Kriraghor', 'List new gear, supplements or gym equipment with sizes and stock', 'Sell to members across the platform'],
    bn: ['ক্রীড়াঘরে আপনার দোকান খুলুন', 'সাইজ ও স্টকসহ নতুন সরঞ্জাম, সাপ্লিমেন্ট বা জিমের জিনিস তালিকাভুক্ত করুন', 'প্ল্যাটফর্মজুড়ে সদস্যদের কাছে বিক্রি করুন'],
  },
};

/** GET /me/verification?role=: the checklist of a business role (the member checklist is below). */
async function roleVerification(principal, role, locale) {
  const { user } = principal;
  const bn = locale === 'bn';
  const reqs = await requirementsFor(role);
  const current = await VerificationDocument.findAll({ where: { userId: user.id, docType: reqs.map((r) => r.docType).filter(Boolean), subjectKey: role, isCurrent: true } });
  const files = current.length ? await DocumentFile.findAll({ where: { documentId: current.map((d) => d.id) } }) : [];
  const items = reqs.map((r) => {
    const doc = current.find((d) => d.docType === r.docType);
    return {
      key: r.docType,
      label: bn ? r.labelBn : r.labelEn,
      why: (bn ? r.whyBn : r.whyEn) ?? null,
      fileSlots: r.fileSlots,
      required: r.required,
      fields: r.fieldSchema.map((f) => ({ key: f.key, type: f.type, required: Boolean(f.required), options: f.options ?? null, label: (bn ? f.labelBn : f.labelEn) ?? f.key })),
      status: doc?.status ?? 'missing',
      document: doc ? serialize(doc, { files: files.filter((f) => f.documentId === doc.id) }) : null,
    };
  });
  const required = items.filter((i) => i.required !== 'optional');
  return {
    role,
    memberStatus: principal.roles?.member ?? null,
    roleStatus: principal.roles?.[role] ?? null,
    badge: rules.roleBadge(items),
    progress: { approved: required.filter((i) => i.status === 'approved').length, total: required.length },
    items,
    unlocks: UNLOCKS[role]?.[bn ? 'bn' : 'en'] ?? [],
    limits: [],
    ...(['player', 'pro'].includes(role) ? { credentials: await credentialsOf(user.id) } : {}),
  };
}

/** M11: the credentials a player or pro sent, one per hire role (the latest version of each). */
async function credentialsOf(userId) {
  const rows = await VerificationDocument.findAll({ where: { userId, docType: 'credential', isCurrent: true }, order: [['createdAt', 'DESC']] });
  return rows.map((d) => ({ hireRole: d.fieldsPublic.hireRole ?? null, level: d.fieldsPublic.level ?? null, issuer: d.fieldsPublic.issuer ?? null, status: d.status, expiresOn: d.fieldsPublic.expiresOn ?? null, documentId: d.id }));
}

/** GET /me/verification: the member checklist, badge, unlocks and limits (§6.4, §6.5). */
async function verification(principal, locale = 'en', role = 'member') {
  if (role !== 'member') return roleVerification(principal, role, locale);
  const { user } = principal;
  const reqs = await requirementsFor('member');
  const current = await VerificationDocument.findOne({ where: { userId: user.id, docType: 'nid', isCurrent: true } });
  const files = current ? await DocumentFile.findAll({ where: { documentId: current.id }, order: [['slot', 'ASC']] }) : [];
  const bn = locale === 'bn';
  const items = reqs.map((r) => {
    const base = { key: r.docType ?? r.derivedKey, label: bn ? r.labelBn : r.labelEn, why: (bn ? r.whyBn : r.whyEn) ?? null, fileSlots: r.fileSlots, required: r.required, fields: [] };
    if (r.derivedKey === 'phone_verified') return { ...base, status: user.phone && user.phoneVerifiedAt ? 'approved' : 'missing', document: null };
    return { ...base, status: current?.status ?? 'missing', document: current ? serialize(current, { files }) : null };
  });
  const memberStatus = principal.roles?.member ?? null;
  return {
    role: 'member',
    memberStatus,
    roleStatus: memberStatus,
    badge: rules.badge(items),
    progress: { approved: items.filter((i) => i.status === 'approved').length, total: items.length },
    items,
    unlocks: bn ? ['ভেন্যু বুকিং ও অগ্রিম', 'খেলোয়াড় ও স্টাফ হায়ার', 'পুরনো পণ্য বিক্রি', 'এস্পোর্টস পুরস্কার তোলা'] : ['Book venues and pay advances', 'Hire players and staff', 'Sell used gear', 'Withdraw esports winnings'],
    limits: bn ? ['একসাথে সর্বোচ্চ ৫টি পুরনো পণ্যের বিজ্ঞাপন'] : ['Up to 5 active used-gear listings'],
  };
}

// ---------------------------------------------------------------- member: upload and submit (FR-03 to FR-07, FR-11)

/** POST /me/documents/files?slot=&docType=: one file, checked by its first bytes, stored in the private bucket. */
async function uploadFile(principal, { slot, docType = 'nid', contentType, body }) {
  const requirement = await requirementOf(docType);
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

/** An open M18 document request lets a verified member send the document again (M18-FR-07). */
const requested = async (userId, docType, transaction) => (await DocumentRequest.count({ where: { userId, docType, status: ['open', 'overdue'] }, transaction })) > 0;

/** POST /me/documents: submit the NID or a business document for review (a new version). */
async function submit(principal, body, req) {
  if (body.docType !== 'nid') return submitBusiness(principal, body, req);
  const { docType, fields, files } = body;
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
    if (mine.some((d) => d.status === 'approved' && d.isCurrent) && !(await requested(user.id, docType, transaction))) throw fail('DOC_ALREADY_APPROVED');
    const fileIds = Object.values(files);
    const rows = await DocumentFile.findAll({ where: { id: fileIds, userId: user.id, documentId: null, purgedAt: null }, transaction, lock: transaction.LOCK.UPDATE });
    if (rows.length !== fileIds.length || rows.some((f) => files[f.slot] !== f.id)) throw fail('FILES_INCOMPLETE');

    // FR-11: the previous current version stops being current; an open one is withdrawn.
    for (const d of mine.filter((x) => x.isCurrent)) {
      await d.update({ isCurrent: false, ...(d.status === 'in_review' ? { status: 'withdrawn' } : {}) }, { transaction });
    }
    const { checks, duplicateUsers } = await computeChecks({ userId: user.id, hash, sha256s: rows.map((f) => f.sha256) }, { transaction });
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
    // FR-08: one M05 submission per version; one subject per user and document type.
    await moderation.submit(
      {
        kind: 'document',
        subjectId: subjectIdFor(user.id, docType),
        payload: { documentId: doc.id, docType, version: doc.version, numberMasked: doc.fieldsPublic.numberMasked, birthYear: doc.fieldsPublic.birthYear },
        title: `National ID · v${doc.version}`,
        submittedBy: user.id,
      },
      { transaction }
    );
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

/**
 * POST /me/documents for a business document (trade licence, deed or lease, TIN). The fields follow
 * the requirement's field_schema; the number is encrypted with the rest and shown masked.
 */
async function submitBusiness(principal, { docType, fields = {}, files = {}, role: asked }, req) {
  const { user } = principal;
  if (principal.roles?.member !== 'active') throw fail('MEMBER_NOT_ACTIVE');
  const today = rules.dhakaToday(new Date());
  return sequelize.transaction(async (transaction) => {
    const requirement = await businessRequirement(principal, docType, asked, transaction);
    const { role } = requirement;
    const errors = rules.fieldsBlock(requirement.fieldSchema, fields, today);
    if (errors) throw E.validation(errors);
    let subjectKey = role;
    if (requirement.scope === 'hire_role') {
      const hireRole = await require('../catalog/hire.reads').role(String(fields.hireRole ?? ''), { transaction });
      if (!hireRole || hireRole.forRole !== role) throw E.validation([{ field: 'fields.hireRole', message: 'Choose one of your hire roles' }]);
      if (!hireRole.levels.includes(String(fields.level ?? ''))) throw E.validation([{ field: 'fields.level', message: 'Choose a level of this role' }]);
      subjectKey = `hire:${hireRole.key}`;
    }
    if (rules.slotsBlock(requirement.fileSlots, files)) throw fail('FILES_INCOMPLETE');
    const mine = await VerificationDocument.findAll({ where: { userId: user.id, docType, subjectKey }, order: [['version', 'DESC']], transaction, lock: transaction.LOCK.UPDATE });
    if (mine.some((d) => d.status === 'approved' && d.isCurrent) && !(await requested(principal.user.id, docType, transaction))) throw fail('DOC_ALREADY_APPROVED');
    const fileIds = Object.values(files);
    const rows = await DocumentFile.findAll({ where: { id: fileIds, userId: user.id, documentId: null, purgedAt: null }, transaction, lock: transaction.LOCK.UPDATE });
    if (rows.length !== fileIds.length || rows.some((f) => files[f.slot] !== f.id)) throw fail('FILES_INCOMPLETE');

    for (const d of mine.filter((x) => x.isCurrent)) {
      await d.update({ isCurrent: false, ...(d.status === 'in_review' ? { status: 'withdrawn' } : {}) }, { transaction });
    }
    const clean = Object.fromEntries(
      Object.entries(fields)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => [k, String(v).trim().replace(/\s+/g, ' ')])
    );
    const reusedFiles = await DocumentFile.count({ where: { sha256: rows.map((f) => f.sha256), userId: { [Op.ne]: user.id } }, transaction });
    const doc = await VerificationDocument.create(
      {
        userId: user.id,
        docType,
        subjectKey,
        version: (mine[0]?.version ?? 0) + 1,
        status: 'in_review',
        isCurrent: true,
        fieldsEnc: encrypt(JSON.stringify(clean)),
        fieldsPublic: { numberMasked: clean.number ? rules.maskNid(clean.number) : null, expiresOn: clean.expiresOn ?? null, role, ...(docType === 'credential' ? { hireRole: clean.hireRole, level: clean.level, issuer: clean.issuer } : {}) },
        checks: rules.businessChecks({ reusedFiles, expiresOn: clean.expiresOn ?? null, today }),
      },
      { transaction }
    );
    await DocumentFile.update({ documentId: doc.id }, { where: { id: fileIds }, transaction });
    await moderation.submit(
      {
        kind: 'document',
        subjectId: subjectIdFor(user.id, docType, subjectKey),
        payload: { documentId: doc.id, docType, version: doc.version, role, numberMasked: doc.fieldsPublic.numberMasked, expiresOn: doc.fieldsPublic.expiresOn, ...(docType === 'credential' ? { hireRole: doc.fieldsPublic.hireRole, level: doc.fieldsPublic.level, issuer: doc.fieldsPublic.issuer } : {}) },
        title: `${requirement.labelEn} · v${doc.version}`,
        submittedBy: user.id,
      },
      { transaction }
    );
    await audit.record(
      { action: 'document.submitted', actor: principal, entityType: 'verification_document', entityId: doc.id, after: { docType, role, version: doc.version, status: doc.status }, req },
      { transaction }
    );
    await events.publish(transaction, {
      name: 'document.submitted',
      aggregateType: 'verification_document',
      aggregateId: doc.id,
      payload: { documentId: doc.id, userId: user.id, docType, role, version: doc.version },
      actor: principal,
      req,
    });
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

// ---------------------------------------------------------------- staff: the document panel on the Moderation desk (FR-12, FR-13)

/** GET /admin/kyc/documents/:id: fields for the reviewer (DOB and legal name; the number stays masked). */
async function adminGet(id) {
  const d = await VerificationDocument.findByPk(id);
  if (!d) throw E.notFound('Document');
  const raw = JSON.parse(decrypt(d.fieldsEnc));
  // NID: legal name and DOB (the number stays masked). Business: the typed fields, number masked.
  const typed = { ...raw };
  delete typed.number;
  const fields =
    d.docType === 'nid'
      ? { legalName: raw.legalName, dob: raw.dob, numberMasked: d.fieldsPublic.numberMasked }
      : { ...typed, numberMasked: d.fieldsPublic.numberMasked ?? null, role: d.fieldsPublic.role ?? null };
  const files = await DocumentFile.findAll({ where: { documentId: d.id }, order: [['slot', 'ASC']] });
  const history = await VerificationDocument.findAll({ where: { userId: d.userId, docType: d.docType, subjectKey: d.subjectKey }, order: [['version', 'DESC']] });
  const who = (await directory.identities([d.userId])).get(d.userId);
  const contact = (await directory.contactFor([d.userId])).get(d.userId);
  return {
    ...serialize(d, { files }),
    fields,
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
  if (d.docType !== 'nid') throw fail('REVEAL_NOT_AVAILABLE');
  const { numberAsTyped, number } = JSON.parse(decrypt(d.fieldsEnc));
  await audit.record({ action: 'document.nid_revealed', actor, entityType: 'verification_document', entityId: d.id, reason, meta: { last4: number.slice(-4) }, req });
  return { documentId: d.id, number: numberAsTyped, normalised: number, showForSeconds: 60 };
}

// ---------------------------------------------------------------- checks and decisions through M05 (FR-07 to FR-10)

/** The NID on other accounts (verified in M01 or approved; waiting for review) and reused images. */
async function computeChecks({ userId, hash, sha256s }, { transaction }) {
  const others = (status) => VerificationDocument.count({ where: { nidHash: hash, userId: { [Op.ne]: userId }, status }, distinct: true, col: 'user_id', transaction });
  const verifiedHolders = Math.max(await directory.nidHashHolders(hash, userId, { transaction }), await others('approved'));
  const pendingHolders = await others('in_review');
  const reusedFiles = await DocumentFile.count({ where: { sha256: sha256s, userId: { [Op.ne]: userId } }, transaction });
  return { checks: rules.checks({ verifiedHolders, pendingHolders, reusedFiles }), duplicateUsers: verifiedHolders + pendingHolders };
}

/** The M05 adapter's checks, re-run on every claim (a duplicate may appear while an item waits). */
async function checksFor(documentId, { transaction }) {
  const d = await VerificationDocument.findByPk(documentId, { transaction });
  if (!d) return [];
  const files = await DocumentFile.findAll({ where: { documentId }, attributes: ['sha256'], transaction });
  let checks;
  if (d.docType === 'nid') ({ checks } = await computeChecks({ userId: d.userId, hash: d.nidHash, sha256s: files.map((f) => f.sha256) }, { transaction }));
  else {
    const reusedFiles = await DocumentFile.count({ where: { sha256: files.map((f) => f.sha256), userId: { [Op.ne]: d.userId } }, transaction });
    checks = rules.businessChecks({ reusedFiles, expiresOn: d.fieldsPublic.expiresOn ?? null, today: rules.dhakaToday(new Date()) });
  }
  if (d.status === 'in_review') await d.update({ checks }, { transaction });
  return checks;
}

const EVENT_FOR = { approved: 'document.approved', changes_requested: 'document.changes_requested', rejected: 'document.rejected' };

/**
 * Apply an M05 decision to the document (kyc.moderation consumers, inside the inbox transaction).
 * Idempotent: a repeated or stale decision changes nothing. An approval is always acknowledged with
 * submission.applied, so the M05 watchdog stops (FR-13).
 */
async function applyDecision(submissionId, status, { transaction }) {
  const sub = await moderation.getById(submissionId, { transaction });
  if (!sub) return null;
  const ack = () =>
    events.publish(transaction, {
      name: 'submission.applied',
      aggregateType: 'submission',
      aggregateId: sub.id,
      payload: { submissionId: sub.id, kind: sub.kind, subjectId: sub.subjectId, version: sub.version, submittedBy: sub.submittedBy },
    });
  const d = await VerificationDocument.findByPk(sub.payload.documentId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!d || !d.isCurrent || d.status === status || (status === 'withdrawn' && d.status !== 'in_review')) {
    if (d && status === 'approved') await ack();
    return null;
  }
  const before = { status: d.status };
  if (status === 'withdrawn') {
    await d.update({ status: 'withdrawn', isCurrent: false }, { transaction });
    await audit.record({ action: 'document.withdrawn', actor: null, entityType: 'verification_document', entityId: d.id, before, after: { status }, meta: { submissionId: sub.id } }, { transaction });
    return status;
  }
  const approved = status === 'approved';
  await d.update(
    { status, decidedBy: sub.decidedBy, decidedAt: sub.decidedAt ?? new Date(), reasonCode: approved ? null : sub.reasonCode, reasonText: approved ? null : sub.reasonText ?? null },
    { transaction }
  );
  await audit.record(
    { action: EVENT_FOR[status], actor: null, entityType: 'verification_document', entityId: d.id, before, after: { status, reasonCode: d.reasonCode }, meta: { submissionId: sub.id, decidedBy: sub.decidedBy } },
    { transaction }
  );
  const role = d.fieldsPublic.role ?? 'member';
  const payload = { documentId: d.id, userId: d.userId, docType: d.docType, role, ...(approved ? {} : { reasonCode: sub.reasonCode }) };
  await events.publish(transaction, { name: EVENT_FOR[status], aggregateType: 'verification_document', aggregateId: d.id, payload });
  if (approved && role === 'member') {
    // FR-10: phone verified + NID approved satisfies the member requirements → M01 activates the role.
    const contact = (await directory.contactFor([d.userId], { transaction })).get(d.userId);
    if (contact?.phone) await events.publish(transaction, { name: 'verification.passed', aggregateType: 'user', aggregateId: d.userId, payload: { userId: d.userId, role: 'member' } });
  } else if (approved) {
    // A business role passes once every required document of the role is approved.
    const reqs = await requirementsFor(role, transaction);
    const approvedTypes = (await VerificationDocument.findAll({ where: { userId: d.userId, subjectKey: role, status: 'approved', isCurrent: true }, attributes: ['docType'], transaction })).map((x) => x.docType);
    if (rules.roleComplete(reqs, approvedTypes)) await events.publish(transaction, { name: 'verification.passed', aggregateType: 'user', aggregateId: d.userId, payload: { userId: d.userId, role } });
  }
  if (approved) await ack();
  return status;
}

// ---------------------------------------------------------------- for other modules (§2)

/** VerificationService.getVerifiedIdentity (M01-FR-14): only from an approved NID. */
async function getVerifiedIdentity(userId, { transaction } = {}) {
  const d = await VerificationDocument.findOne({ where: { userId, docType: 'nid', status: 'approved', isCurrent: true }, transaction });
  if (!d) return null;
  const f = JSON.parse(decrypt(d.fieldsEnc));
  return { legalName: f.legalName, dob: f.dob, nidHash: d.nidHash, nidLast4: f.number.slice(-4), documentId: d.id };
}

/**
 * M11: the approved, unexpired credential a person holds for a hire role on a day (null when none):
 * { level, issuer, expiresOn }. Levels are the M03 credential tiers (amateur → national).
 */
async function credentialFor(userId, roleKey, { on = new Date(), transaction } = {}) {
  const d = await VerificationDocument.findOne({ where: { userId, docType: 'credential', subjectKey: `hire:${roleKey}`, status: 'approved', isCurrent: true }, transaction });
  if (!d) return null;
  const until = d.fieldsPublic.expiresOn ?? null;
  if (until && until < rules.dhakaToday(on)) return null;
  return { level: d.fieldsPublic.level, issuer: d.fieldsPublic.issuer ?? null, expiresOn: until };
}

/** M11: the date an approved police clearance is valid until (null when there is none). */
async function policeClearedUntil(userId, { transaction } = {}) {
  const d = await VerificationDocument.findOne({ where: { userId, docType: 'police_clearance', status: 'approved', isCurrent: true }, order: [['decidedAt', 'DESC']], transaction });
  return d?.fieldsPublic.expiresOn ?? null;
}

/** Display facts for notifications (M08 reads them here). */
async function facts(id) {
  const d = await VerificationDocument.findByPk(id, { attributes: ['docType', 'reasonCode', 'reasonText', 'fieldsPublic'] });
  if (!d) throw E.notFound('Document');
  return { docType: d.docType, reasonCode: d.reasonCode ?? null, reasonText: d.reasonText ?? null, numberMasked: d.fieldsPublic.numberMasked ?? null, role: d.fieldsPublic.role ?? 'member' };
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

/**
 * M18 accounts_per_nid: how many accounts (this one included) submitted an NID with the same hash as
 * any of this user's NID submissions, whatever the review outcome. Counts only; never the number.
 */
async function nidAttempts(userId) {
  const mine = await VerificationDocument.findAll({ where: { userId, docType: 'nid', nidHash: { [Op.ne]: null } }, attributes: ['nidHash'] });
  const hashes = [...new Set(mine.map((d) => d.nidHash))];
  if (!hashes.length) return 0;
  const others = await VerificationDocument.count({ where: { nidHash: hashes, userId: { [Op.ne]: userId } }, distinct: true, col: 'user_id' });
  return others + 1;
}

module.exports = { nidAttempts, verification, uploadFile, submit, ownFile, adminGet, viewFile, revealNid, checksFor, applyDecision, getVerifiedIdentity, credentialFor, policeClearedUntil, facts, purgeDue, requirementsFor, nidHash };
