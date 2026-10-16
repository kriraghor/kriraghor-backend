'use strict';

// M02 KYC lite: the member checklist (FR-18), uploads through the API (FR-03, FR-04 lite), submitting
// the NID (FR-05 to FR-07, FR-11), the KYC desk with the audited viewer and reveal (FR-12, FR-13),
// decisions (FR-09), the member role and identity fields in M01 (FR-10, M01-FR-14), the
// withdraw_winnings gate, notifications, retention (FR-17) and no PII in events.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const storage = require('../../src/common/storage');
const kyc = require('../../src/modules/kyc/kyc.service');

const { api, P, models } = h;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg body for tests')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png')]);
const PDF = Buffer.from('%PDF-1.7\n% test document\n');
const NID = '1990 1234 5678 9012 3';
const NID_NORMALISED = '19901234567890123';

let master;
let member;

beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  member = await h.signupUser({ name: 'Nusrat Jahan' });
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const codesOf = async (userId) => (await models.Notification.findAll({ where: { userId }, order: [['createdAt', 'ASC']] })).map((n) => n.code);
const upload = (who, slot, buf = JPEG, type = 'image/jpeg') => api().post(`${P}/me/documents/files?slot=${slot}`).set(h.bearer(who)).set('Content-Type', type).send(buf);

async function uploadAll(who, salt = '') {
  const files = {};
  for (const [slot, buf, type] of [['front', JPEG, 'image/jpeg'], ['back', PNG, 'image/png'], ['selfie', PDF, 'application/pdf']]) {
    const r = await upload(who, slot, Buffer.concat([buf, Buffer.from(salt)]), type).expect(201);
    files[slot] = r.body.fileId;
  }
  return files;
}

const submit = async (who, { number = NID, dob = '1990-05-14', legalName = 'Nusrat  Jahan', salt = '' } = {}) =>
  api().post(`${P}/me/documents`).set(h.bearer(who)).send({ docType: 'nid', fields: { number, dob, legalName }, files: await uploadAll(who, salt), consent: true });

let emp = 0;
async function staffWith(permissions) {
  emp += 1;
  const s = await h.signupUser({ name: 'Rumana Akter' });
  await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'staff.write')).send({ userId: s.user.id, employeeId: `KG-K-${emp}`, permissions }).expect(201);
  return h.signInStaff(s.phone, s.user.id);
}

const decide = (who, id, body) => api().post(`${P}/admin/kyc/documents/${id}/decide`).set(h.bearer(who)).send(body);
const RUBRIC = { nameMatches: true, readable: true, notExpired: true };
/** M01 bumps the authz version when the member role moves: the client refreshes its access token (AUTHZ_STALE). */
async function settle() {
  await h.drainEvents();
  const r = await h.refreshWeb(member.cookie).expect(200);
  member.accessToken = r.body.accessToken;
  member.cookie = r.headers['set-cookie'];
}
const memberRole = async (userId) => (await models.UserRole.findOne({ where: { userId, role: 'member' } })).status;

describe('the member checklist and the gate (FR-18, §6.4)', () => {
  it('starts with the phone done and the NID missing; withdrawing winnings needs KYC', async () => {
    const v = await api().get(`${P}/me/verification`).set(h.bearer(member)).expect(200);
    expect(v.body).toMatchObject({ role: 'member', badge: 'verification_needed', progress: { approved: 1, total: 2 } });
    expect(v.body.items.map((i) => [i.key, i.status])).toEqual([['phone_verified', 'approved'], ['nid', 'missing']]);
    expect(v.body.items[1].fileSlots).toEqual(['front', 'back', 'selfie']);
    const bn = await api().get(`${P}/me/verification?locale=bn`).set(h.bearer(member)).expect(200);
    expect(bn.body.items[1].label).toBe('জাতীয় পরিচয়পত্র (NID)');
    const gate = await api().get(`${P}/me/gate?action=withdraw_winnings`).set(h.bearer(member)).expect(200);
    expect(gate.body).toMatchObject({ allowed: false, code: 'KYC_REQUIRED', next: '/account/verification' });
  });
});

describe('uploads (FR-03, FR-04 lite)', () => {
  it('accepts JPEG, PNG and PDF by their first bytes, and refuses everything else', async () => {
    const ok = await upload(member, 'front').expect(201);
    expect(ok.body).toMatchObject({ slot: 'front', mime: 'image/jpeg', sizeBytes: JPEG.length });
    const row = await models.DocumentFile.findByPk(ok.body.fileId);
    expect(row).toMatchObject({ documentId: null, scanStatus: 'type_checked', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(storage._memory.get(row.storageKey).body.equals(JPEG)).toBe(true);

    expect((await upload(member, 'front', Buffer.from('GIF89a....'), 'image/gif').expect(415)).body.code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect((await upload(member, 'front', JPEG, 'image/png').expect(415)).body.code).toBe('FILE_TYPE_MISMATCH');
    expect((await upload(member, 'front', Buffer.alloc(0), 'image/jpeg').expect(422)).body.code).toBe('FILE_EMPTY');
    expect((await upload(member, 'passport').expect(422)).body.code).toBe('VALIDATION_FAILED');
    await h.setSettingForTest('kyc.max_file_bytes', 10);
    expect((await upload(member, 'front').expect(413)).body.code).toBe('FILE_TOO_LARGE');
    await api().post(`${P}/me/documents/files?slot=front`).set('Content-Type', 'image/jpeg').send(JPEG).expect(401);
  });
});

describe('submitting the NID (FR-05 to FR-07, FR-11)', () => {
  it('validates the number, the date of birth and the files', async () => {
    expect((await submit(member, { number: '12345678901' })).body.code).toBe('NID_FORMAT_INVALID');
    expect((await submit(member, { dob: '2015-01-01' })).body.code).toBe('UNDER_MIN_AGE');
    expect((await submit(member, { dob: '2999-01-01' })).body.code).toBe('DOB_IN_FUTURE');
    const files = await uploadAll(member);
    const missing = await api().post(`${P}/me/documents`).set(h.bearer(member)).send({ docType: 'nid', fields: { number: NID, dob: '1990-05-14', legalName: 'Nusrat Jahan' }, files: { ...files, selfie: files.front }, consent: true });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('FILES_INCOMPLETE');
    // Someone else's file ids are not yours to submit.
    const other = await h.signupUser({ name: 'Fahim Rahman' });
    const theirs = await uploadAll(other);
    const stolen = await api().post(`${P}/me/documents`).set(h.bearer(member)).send({ docType: 'nid', fields: { number: NID, dob: '1990-05-14', legalName: 'Nusrat Jahan' }, files: theirs, consent: true });
    expect(stolen.body.code).toBe('FILES_INCOMPLETE');
    const noConsent = await api().post(`${P}/me/documents`).set(h.bearer(member)).send({ docType: 'nid', fields: { number: NID, dob: '1990-05-14', legalName: 'Nusrat Jahan' }, files, consent: false });
    expect(noConsent.body.code).toBe('VALIDATION_FAILED');
  });

  it('a verified phone comes first', async () => {
    await models.User.update({ phoneVerifiedAt: null }, { where: { id: member.user.id } });
    expect((await submit(member)).body.code).toBe('PHONE_REQUIRED');
  });

  it('stores the fields encrypted, shows only the masked number, and puts the member in review', async () => {
    const r = await submit(member);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ docType: 'nid', version: 1, status: 'in_review', numberMasked: '•••• 0123', birthYear: 1990 });
    expect(r.body.files.map((f) => f.slot).sort()).toEqual(['back', 'front', 'selfie']);
    const row = await models.VerificationDocument.findByPk(r.body.id);
    expect(row.fieldsEnc).not.toContain(NID_NORMALISED);
    expect(row.fieldsEnc).not.toContain('Nusrat');
    expect(row.checks.every((c) => c.ok)).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain(NID_NORMALISED);

    await settle();
    expect(await memberRole(member.user.id)).toBe('in_review');
    expect((await models.User.findByPk(member.user.id)).kycStatus).toBe('pending');
    expect(await codesOf(member.user.id)).toContain('DOCUMENT_SUBMITTED');
    expect(await codesOf(master.userId)).toContain('KYC_REVIEW_NEEDED');
    const gate = await api().get(`${P}/me/gate?action=withdraw_winnings`).set(h.bearer(member)).expect(200);
    expect(gate.body.code).toBe('KYC_PENDING');
    // Events carry ids only.
    const outbox = JSON.stringify(await models.OutboxEvent.findAll({ where: { name: 'document.submitted' } }));
    for (const pii of [NID_NORMALISED, 'Nusrat', '1990-05-14']) expect(outbox).not.toContain(pii);
  });

  it('a resubmission withdraws the open version (one open version at a time)', async () => {
    const first = await submit(member);
    const second = await submit(member, { salt: 'v2' });
    expect(second.body.version).toBe(2);
    expect(await models.VerificationDocument.findByPk(first.body.id)).toMatchObject({ status: 'withdrawn', isCurrent: false });
    const v = await api().get(`${P}/me/verification`).set(h.bearer(member)).expect(200);
    expect(v.body).toMatchObject({ badge: 'documents_in_review' });
    expect(v.body.items[1].document.id).toBe(second.body.id);
    const own = await api().get(`${P}/me/documents/${second.body.id}/files/${second.body.files.find((f) => f.slot === 'front').id}`).set(h.bearer(member)).expect(200);
    expect(own.headers['cache-control']).toBe('no-store');
  });
});

describe('the KYC desk (FR-09, FR-12, FR-13)', () => {
  it('needs approve_documents; shows masked data; every file view and the reveal are audited', async () => {
    const doc = (await submit(member)).body;
    const viewer = await staffWith(['view_payouts']);
    expect((await api().get(`${P}/admin/kyc/documents`).set(h.bearer(viewer)).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    const reviewer = await staffWith(['approve_documents']);
    const q = await api().get(`${P}/admin/kyc/documents`).set(h.bearer(reviewer)).expect(200);
    expect(q.body.items.map((d) => [d.id, d.user.displayName, d.numberMasked])).toEqual([[doc.id, 'Nusrat Jahan', '•••• 0123']]);
    expect(q.body.counts).toMatchObject({ in_review: 1 });
    expect(JSON.stringify(q.body)).not.toContain(NID_NORMALISED);

    const one = await api().get(`${P}/admin/kyc/documents/${doc.id}`).set(h.bearer(reviewer)).expect(200);
    expect(one.body).toMatchObject({ fields: { legalName: 'Nusrat Jahan', dob: '1990-05-14', numberMasked: '•••• 0123' }, user: { phoneVerified: true }, history: [{ version: 1, status: 'in_review' }] });
    expect(JSON.stringify(one.body)).not.toContain(NID_NORMALISED);

    const front = doc.files.find((f) => f.slot === 'front');
    for (let i = 0; i < 2; i += 1) {
      const f = await api().get(`${P}/admin/kyc/documents/${doc.id}/files/${front.id}`).set(h.bearer(reviewer)).buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(f.headers).toMatchObject({ 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      expect(f.body.equals(JPEG)).toBe(true);
    }
    expect(await models.AuditLog.count({ where: { action: 'document.file_viewed', actorId: reviewer.userId } })).toBe(2);

    await api().post(`${P}/admin/kyc/documents/${doc.id}/reveal-nid`).set(h.bearer(reviewer)).send({}).expect(422);
    const shown = await api().post(`${P}/admin/kyc/documents/${doc.id}/reveal-nid`).set(h.bearer(reviewer)).send({ reason: 'Number is hard to read on the photo' }).expect(200);
    expect(shown.headers['cache-control']).toBe('no-store');
    expect(shown.body).toMatchObject({ number: NID, normalised: NID_NORMALISED, showForSeconds: 60 });
    const audit = await models.AuditLog.findOne({ where: { action: 'document.nid_revealed' } });
    expect(audit).toMatchObject({ severity: 'critical', reason: 'Number is hard to read on the photo', actorId: reviewer.userId });
    expect(JSON.stringify(await models.AuditLog.findAll())).not.toContain(NID_NORMALISED);
  });

  it('approval needs the full rubric; it makes the member active and copies the verified identity', async () => {
    const doc = (await submit(member)).body;
    await settle();
    expect((await decide(master, doc.id, { decision: 'approve' }).expect(422)).body.code).toBe('RUBRIC_INCOMPLETE');
    expect((await decide(master, doc.id, { decision: 'approve', rubric: { ...RUBRIC, readable: false } }).expect(422)).body.code).toBe('RUBRIC_INCOMPLETE');
    const ok = await decide(master, doc.id, { decision: 'approve', rubric: RUBRIC }).expect(200);
    expect(ok.body.status).toBe('approved');
    expect((await decide(master, doc.id, { decision: 'approve', rubric: RUBRIC }).expect(409)).body.code).toBe('DOC_NOT_IN_REVIEW');

    await settle();
    expect(await memberRole(member.user.id)).toBe('active');
    const u = await models.User.findByPk(member.user.id);
    expect(u).toMatchObject({ kycStatus: 'verified', legalName: 'Nusrat Jahan', dob: '1990-05-14', nidLast4: '0123', nidHash: kyc.nidHash(NID_NORMALISED) });
    expect(await codesOf(member.user.id)).toContain('ROLE_ACTIVATED');
    const gate = await api().get(`${P}/me/gate?action=withdraw_winnings`).set(h.bearer(member)).expect(200);
    expect(gate.body).toMatchObject({ allowed: true });
    const v = await api().get(`${P}/me/verification`).set(h.bearer(member)).expect(200);
    expect(v.body).toMatchObject({ badge: 'fully_verified', memberStatus: 'active', progress: { approved: 2, total: 2 } });
    expect((await submit(member)).body.code).toBe('DOC_ALREADY_APPROVED');
    expect(await models.AuditLog.findOne({ where: { action: 'user_role.active', entityType: 'user_role' } })).toMatchObject({ actorType: 'system' });
  });

  it('changes requested: the member is told why and can resubmit', async () => {
    const doc = (await submit(member)).body;
    expect((await decide(master, doc.id, { decision: 'changes_requested' }).expect(422)).body.code).toBe('REASON_REQUIRED');
    await decide(master, doc.id, { decision: 'changes_requested', reasonCode: 'blurry', note: 'The back is out of focus' }).expect(200);
    await settle();
    expect(await memberRole(member.user.id)).toBe('changes_requested');
    expect(await codesOf(member.user.id)).toContain('DOCUMENT_CHANGES_REQUESTED');
    expect(h.sms.lastTo(h.e164(member.phone)).text).toContain('not clear enough');
    const v = await api().get(`${P}/me/verification`).set(h.bearer(member)).expect(200);
    expect(v.body.items[1]).toMatchObject({ status: 'changes_requested', document: { reasonCode: 'blurry', reasonText: 'The back is out of focus' } });
    const again = await submit(member, { salt: 'clearer' });
    expect(again.body).toMatchObject({ version: 2, status: 'in_review' });
    await settle();
    expect(await memberRole(member.user.id)).toBe('in_review');
  });

  it('a duplicate NID blocks approval; the reviewer rejects it (FR-07)', async () => {
    const first = (await submit(member)).body;
    await decide(master, first.id, { decision: 'approve', rubric: RUBRIC }).expect(200);
    await settle();
    const other = await h.signupUser({ name: 'Someone Else' });
    const dup = (await submit(other, { legalName: 'Someone Else', number: '19901234567890123', salt: 'x' })).body;
    const check = (await models.VerificationDocument.findByPk(dup.id)).checks.find((c) => c.key === 'nid_unique');
    expect(check).toMatchObject({ ok: false, blocks: true });
    expect(await models.OutboxEvent.count({ where: { name: 'document.duplicate_nid_detected' } })).toBe(1);
    expect((await decide(master, dup.id, { decision: 'approve', rubric: RUBRIC }).expect(409)).body.code).toBe('CHECKS_FAILED');
    await decide(master, dup.id, { decision: 'reject', reasonCode: 'duplicate_nid' }).expect(200);
    await settle();
    expect(await memberRole(other.user.id)).toBe('rejected');
    expect((await models.User.findByPk(other.user.id)).kycStatus).toBe('rejected');
    expect(await codesOf(other.user.id)).toContain('ROLE_REJECTED');
  });

  it('flags the same image on two accounts (warning only)', async () => {
    await submit(member);
    const other = await h.signupUser({ name: 'Copy Cat' });
    const r = await submit(other, { number: '1234567890', legalName: 'Copy Cat' });
    expect(r.status).toBe(201);
    const reused = (await models.VerificationDocument.findByPk(r.body.id)).checks.find((c) => c.key === 'file_reused');
    expect(reused).toMatchObject({ ok: false, blocks: false });
  });
});

describe('retention (FR-17)', () => {
  it('deletes images of decided documents after the retention period, and unused uploads after a day', async () => {
    const doc = (await submit(member)).body;
    await decide(master, doc.id, { decision: 'approve', rubric: RUBRIC }).expect(200);
    const orphan = (await upload(member, 'front', Buffer.concat([JPEG, Buffer.from('orphan')])).expect(201)).body;
    expect(await kyc.purgeDue(new Date())).toEqual({ decided: 0, orphans: 0 });
    expect(await kyc.purgeDue(new Date(Date.now() + 25 * 3600000))).toEqual({ decided: 0, orphans: 1 });
    expect(await kyc.purgeDue(new Date(Date.now() + 91 * 86400000))).toEqual({ decided: 3, orphans: 0 });
    const files = await models.DocumentFile.findAll({ where: { userId: member.user.id } });
    expect(files.every((f) => f.purgedAt)).toBe(true);
    expect(files.every((f) => !storage._memory.has(f.storageKey))).toBe(true);
    expect(files.every((f) => f.sha256.length === 64)).toBe(true);
    const front = doc.files.find((f) => f.slot === 'front');
    expect((await api().get(`${P}/admin/kyc/documents/${doc.id}/files/${front.id}`).set(h.bearer(master)).expect(410)).body.code).toBe('FILE_PURGED');
    expect(orphan.fileId).toBeTruthy();
    expect(await models.AuditLog.findOne({ where: { action: 'document.files_purged' } })).toBeTruthy();
  });
});
