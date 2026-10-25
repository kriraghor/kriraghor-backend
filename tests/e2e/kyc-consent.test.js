'use strict';

// M02, product owner 25 Oct 2026: explicit, versioned consent with every NID and business document
// (M02-FR-05), the consent text and minimum age in the checklist (FR-18, FR-17 retention days), the
// consent on the document panel, NID verification for people aged 18 and over (§6.3 age_ok) and the
// read-only list of NID holders now under the minimum age.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const kyc = require('../../src/modules/kyc/kyc.service');
const { subjectIdFor } = require('../../src/modules/kyc/kyc.moderation');
const mk = require('../fixtures/market');

const { api, P, models } = h;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('consent test jpeg')]);
const CURRENT = h.consent().version;

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

let salt = 0;
async function uploadAll(who) {
  const files = {};
  for (const slot of ['front', 'back', 'selfie']) {
    salt += 1;
    const r = await api().post(`${P}/me/documents/files?slot=${slot}`).set(h.bearer(who)).set('Content-Type', 'image/jpeg').send(Buffer.concat([JPEG, Buffer.from(`${slot}-${salt}`)])).expect(201);
    files[slot] = r.body.fileId;
  }
  return files;
}

let nidSeq = 0;
/** Submit an NID; `consent` is sent as given (omitted when undefined; the current one when not passed). */
async function submitNid(who, opts = {}) {
  const { dob = '1990-05-14', number } = opts;
  const consent = 'consent' in opts ? opts.consent : h.consent();
  nidSeq += 1;
  const body = { docType: 'nid', fields: { number: number ?? `1990${String(nidSeq).padStart(13, '0')}`, dob, legalName: 'Nusrat Jahan' }, files: await uploadAll(who) };
  if (consent !== undefined) body.consent = consent;
  return api().post(`${P}/me/documents`).set(h.bearer(who)).send(body);
}

/** A business document (one file); `consent` as given. */
async function submitBusiness(who, docType, fields, consent) {
  salt += 1;
  const up = await api().post(`${P}/me/documents/files?slot=document&docType=${docType}`).set(h.bearer(who)).set('Content-Type', 'image/jpeg').send(Buffer.concat([JPEG, Buffer.from(`doc-${salt}`)])).expect(201);
  const body = { docType, fields, files: { document: up.body.fileId } };
  if (consent !== undefined) body.consent = consent;
  return api().post(`${P}/me/documents`).set(h.bearer(who)).send(body);
}

/** A member with an active member role who applied for shop_owner. */
async function shopApplicant() {
  const m = await h.signupUser({ name: 'Nayeem Sports' });
  await h.verifyMember(m.user.id);
  await mk.refresh(m);
  await api().post(`${P}/me/roles`).set(h.bearer(m)).send({ role: 'shop_owner' }).expect(201);
  return mk.refresh(m);
}

// Dates of birth from today's Dhaka calendar day (UTC+6), so the tests hold on any day they run.
const dhakaToday = () => new Date(Date.now() + 6 * 3600000).toISOString().slice(0, 10);
/** Born exactly n years ago today in Dhaka (on 29 February, the 28th: that birthday has passed). */
function bornYearsAgo(n) {
  const t = dhakaToday();
  const md = t.slice(5) === '02-29' ? '02-28' : t.slice(5);
  return `${Number(t.slice(0, 4)) - n}-${md}`;
}
/** The day after: one day short of n years old. */
function dayAfter(dob) {
  const [y, m, d] = dob.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
const ageFrom = (dob) => {
  const [y, m, d] = dob.split('-').map(Number);
  const [ty, tm, td] = dhakaToday().split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
};

describe('the consent in the checklist (M02-FR-05, FR-17, FR-18)', () => {
  it('shows the NID text for members and the business text for business roles, with the numbers filled in', async () => {
    const v = await api().get(`${P}/me/verification`).set(h.bearer(member)).expect(200);
    expect(v.body.minAgeYears).toBe(18);
    expect(v.body.consent).toMatchObject({ version: CURRENT, draft: true });
    expect(v.body.consent.text).toMatch(/^I agree that Kriraghor uses these documents/);
    expect(v.body.consent.text).toContain('deleted 90 days after the review decision');
    expect(v.body.consent.text).toContain('for people aged 18 and over');
    expect(v.body.consent.text).not.toMatch(/\{\w+\}/);

    const bn = await api().get(`${P}/me/verification?locale=bn`).set(h.bearer(member)).expect(200);
    expect(bn.body.consent.text).toContain('৯০ দিন পর');
    expect(bn.body.consent.text).toContain('১৮ বছর বা তার বেশি');

    const shop = await shopApplicant();
    const biz = await api().get(`${P}/me/verification?role=shop_owner`).set(h.bearer(shop)).expect(200);
    expect(biz.body).toMatchObject({ role: 'shop_owner', minAgeYears: 18, consent: { version: CURRENT, draft: true } });
    expect(biz.body.consent.text).toMatch(/^I agree that Kriraghor uses these documents to approve my business/);
    expect(biz.body.consent.text).toContain('trade licence, TIN, BIN');

    // The retention days come from the setting at read time.
    await h.setSettingForTest('kyc.raw_image_retention_days', 30);
    const later = await api().get(`${P}/me/verification`).set(h.bearer(member)).expect(200);
    expect(later.body.consent.text).toContain('deleted 30 days after');
  });
});

describe('consent is required (M02-FR-05)', () => {
  it('refuses an NID without the current consent, before any other check', async () => {
    for (const consent of [undefined, true, false, { accepted: false, version: CURRENT }, { version: CURRENT }]) {
      const r = await submitNid(member, { consent });
      expect({ status: r.status, code: r.body.code }).toEqual({ status: 422, code: 'CONSENT_REQUIRED' });
    }
    const stale = await submitNid(member, { consent: { accepted: true, version: CURRENT - 1 } });
    expect(stale.status).toBe(422);
    expect(stale.body).toMatchObject({ code: 'CONSENT_VERSION_STALE', currentVersion: CURRENT });
    expect((await submitNid(member, { consent: { accepted: true, version: String(CURRENT) } })).body.code).toBe('CONSENT_VERSION_STALE');
    // Checked first: no verified phone and an under-age date still answer CONSENT_REQUIRED.
    await models.User.update({ phoneVerifiedAt: null }, { where: { id: member.user.id } });
    expect((await submitNid(member, { consent: true, dob: '2015-01-01' })).body.code).toBe('CONSENT_REQUIRED');
    // Nothing was stored and no upload was used.
    expect(await models.VerificationDocument.count()).toBe(0);
    expect(await models.DocumentFile.count({ where: { documentId: { [require('sequelize').Op.ne]: null } } })).toBe(0);
  });

  it('refuses a business document without the current consent', async () => {
    const shop = await shopApplicant();
    const fields = { number: 'TL-CONSENT-2026', holderName: 'Nayeem Sports', expiresOn: mk.future(300) };
    expect((await submitBusiness(shop, 'trade_license', fields, undefined)).body.code).toBe('CONSENT_REQUIRED');
    expect((await submitBusiness(shop, 'trade_license', fields, true)).body.code).toBe('CONSENT_REQUIRED');
    const stale = await submitBusiness(shop, 'trade_license', fields, { accepted: true, version: CURRENT + 1 });
    expect(stale.body).toMatchObject({ status: 422, code: 'CONSENT_VERSION_STALE', currentVersion: CURRENT });
    // Before the member check too: a member without an active NID gets the consent code first.
    expect((await submitBusiness(member, 'trade_license', fields, true)).body.code).toBe('CONSENT_REQUIRED');
    expect(await models.VerificationDocument.count()).toBe(0);
  });
});

describe('the consent is stored, audited and in the event (M02-FR-05)', () => {
  it('NID: consent_version and consented_at on the row, the audit row and the event; nothing personal in the event', async () => {
    const before = Date.now();
    const r = await submitNid(member, { number: '1990 1234 5678 9012 3' });
    expect(r.status).toBe(201);
    const row = await models.VerificationDocument.findByPk(r.body.id);
    expect(row.consentVersion).toBe(CURRENT);
    expect(row.consentedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.consentedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const audit = await models.AuditLog.findOne({ where: { action: 'document.submitted', entityId: r.body.id } });
    expect(audit.after).toMatchObject({ docType: 'nid', version: 1, consentVersion: CURRENT, consentedAt: row.consentedAt.toISOString() });

    const event = await models.OutboxEvent.findOne({ where: { name: 'document.submitted', aggregateId: r.body.id } });
    expect(event.payload).toEqual({ documentId: r.body.id, userId: member.user.id, docType: 'nid', version: 1, consentVersion: CURRENT });
    for (const pii of ['19901234567890123', 'Nusrat', '1990-05-14']) expect(JSON.stringify(event)).not.toContain(pii);
  });

  it('business document: the same columns, audit and event', async () => {
    const shop = await shopApplicant();
    const r = await submitBusiness(shop, 'trade_license', { number: 'TL-STORED-2026', holderName: 'Nayeem Sports', expiresOn: mk.future(300) }, h.consent());
    expect(r.status).toBe(201);
    expect(await models.VerificationDocument.findByPk(r.body.id)).toMatchObject({ consentVersion: CURRENT, consentedAt: expect.any(Date) });
    expect((await models.AuditLog.findOne({ where: { action: 'document.submitted', entityId: r.body.id } })).after).toMatchObject({ role: 'shop_owner', consentVersion: CURRENT });
    expect((await models.OutboxEvent.findOne({ where: { name: 'document.submitted', aggregateId: r.body.id } })).payload).toMatchObject({ role: 'shop_owner', consentVersion: CURRENT });
  });

  it('the document panel shows the consent, and null for a document sent before 25 Oct 2026', async () => {
    const r = await submitNid(member);
    const panel = await api().get(`${P}/admin/kyc/documents/${r.body.id}`).set(h.bearer(master)).expect(200);
    const row = await models.VerificationDocument.findByPk(r.body.id);
    expect(panel.body.consent).toEqual({ version: CURRENT, at: row.consentedAt.toISOString() });
    await row.update({ consentVersion: null, consentedAt: null });
    const legacy = await api().get(`${P}/admin/kyc/documents/${r.body.id}`).set(h.bearer(master)).expect(200);
    expect(legacy.body.consent).toBeNull();
  });
});

describe('NID verification is for people aged 18 and over (§6.3 age_ok)', () => {
  it('refuses one day short of 18 and accepts the 18th birthday (Dhaka calendar)', async () => {
    const eighteen = bornYearsAgo(18);
    const young = await submitNid(member, { dob: dayAfter(eighteen) });
    expect(young.status).toBe(422);
    expect(young.body).toMatchObject({ code: 'UNDER_MIN_AGE', minAge: 18, title: 'NID verification is for people aged 18 and over' });
    const ok = await submitNid(member, { dob: eighteen });
    expect(ok.status).toBe(201);
    expect(ok.body.birthYear).toBe(Number(eighteen.slice(0, 4)));
  });
});

describe('NID holders now under the minimum age (read-only)', () => {
  it('lists current NID documents of people under 18 with their age only; every view is audited', async () => {
    const reviewer = await mk.staffWith(master, ['approve_documents']);
    // Under the old rule (16): an approved 17-year-old and a 16-year-old waiting for review.
    await h.setSettingForTest('kyc.min_age_years', 16);
    const approvedMinor = await h.signupUser({ name: 'Legacy Minor' });
    const seventeen = bornYearsAgo(17);
    const a = await submitNid(approvedMinor, { dob: seventeen });
    expect(a.status).toBe(201);
    await mk.review(master, 'document', subjectIdFor(approvedMinor.user.id, 'nid'));
    expect(await models.VerificationDocument.findByPk(a.body.id)).toMatchObject({ status: 'approved' });
    expect((await models.User.findByPk(approvedMinor.user.id)).dob).toBe(seventeen); // M01 copied the verified identity

    const waitingMinor = await h.signupUser({ name: 'Waiting Minor' });
    const sixteen = bornYearsAgo(16);
    const w = await submitNid(waitingMinor, { dob: sixteen });
    expect(w.status).toBe(201);
    // An adult (not listed) and a minor whose only document was withdrawn by a resubmission as an adult.
    const adult = await submitNid(member, { dob: '1990-05-14' });
    expect(adult.status).toBe(201);
    const changed = await h.signupUser({ name: 'Changed Mind' });
    await submitNid(changed, { dob: sixteen });
    await submitNid(changed, { dob: '1995-01-01' });
    await h.setSettingForTest('kyc.min_age_years', 18);

    const viewer = await mk.staffWith(master, ['view_payouts']);
    expect((await api().get(`${P}/admin/kyc/under-min-age`).set(h.bearer(viewer)).expect(403)).body.code).toBe('PERMISSION_REQUIRED');

    const list = await api().get(`${P}/admin/kyc/under-min-age`).set(h.bearer(reviewer)).expect(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body).toMatchObject({ minAgeYears: 18, count: 2 });
    expect(list.body.items).toEqual([
      { userId: waitingMinor.user.id, displayName: 'Waiting Minor', documentId: w.body.id, status: 'in_review', age: ageFrom(sixteen), decidedAt: null },
      { userId: approvedMinor.user.id, displayName: 'Legacy Minor', documentId: a.body.id, status: 'approved', age: ageFrom(seventeen), decidedAt: expect.any(String) },
    ]);
    const text = JSON.stringify(list.body);
    for (const leak of [seventeen, sixteen, 'dob', 'number']) expect(text).not.toContain(leak);
    expect(await models.AuditLog.findOne({ where: { action: 'kyc.under_min_age_listed', actorId: reviewer.userId } })).toMatchObject({ module: 'M02', meta: { count: 2, minAge: 18, source: 'admin' } });

    // users.dob (from the approved NID) comes first; the document's date of birth is the fallback.
    const fifteen = bornYearsAgo(15);
    await models.User.update({ dob: fifteen }, { where: { id: approvedMinor.user.id } });
    const again = await kyc.listUnderMinAge(null, undefined, { source: 'script' });
    expect(again.items.find((i) => i.userId === approvedMinor.user.id).age).toBe(ageFrom(fifteen));
    expect(again.items.find((i) => i.userId === waitingMinor.user.id).age).toBe(ageFrom(sixteen));
    expect(await models.AuditLog.count({ where: { action: 'kyc.under_min_age_listed' } })).toBe(2);
    expect(await models.AuditLog.findOne({ where: { action: 'kyc.under_min_age_listed', actorId: null } })).toMatchObject({ meta: { count: 2, minAge: 18, source: 'script' } });

    // At 16 nobody here is under the minimum (the 15 above is users.dob only for the approved one).
    await h.setSettingForTest('kyc.min_age_years', 16);
    expect((await kyc.underMinAge()).items.map((i) => i.userId)).toEqual([approvedMinor.user.id]);
  });
});
