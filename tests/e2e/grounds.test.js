'use strict';

// M09 Grounds step 1 end to end: owner onboarding through business documents (M02 lite → M01 role),
// the gate (FR-01), listing review through M05 (FR-02, FR-03), live edits (FR-04), pause / resume /
// withdraw (FR-05), courts and hours (FR-06 to FR-08), pricing drafts, publish and history (FR-09 to
// FR-14), quote and heatmap (FR-13), the public read side (FR-25, FR-27), staff actions, sanctions,
// and the M03 places catalogue.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const storage = require('../../src/common/storage');
const pr = require('../../src/modules/grounds/pricing.rules');
const { subjectIdFor } = require('../../src/modules/kyc/kyc.moderation');

const { api, P, models } = h;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('ground photo')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('ground photo')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

let master;
let reviewer;
let docsReviewer;
let seq = 0;
const key = (p) => `${p}-${Date.now()}-${(seq += 1)}`;
const future = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  reviewer = await staffWith(['approve_listings']);
  docsReviewer = await staffWith(['approve_documents']);
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

let emp = 0;
async function staffWith(permissions) {
  emp += 1;
  const s = await h.signupUser({ name: 'Rumana Akter' });
  await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'staff.write')).send({ userId: s.user.id, employeeId: `KG-G-${emp}`, permissions }).expect(201);
  return h.signInStaff(s.phone, s.user.id);
}

/** A fresh access token after a role or KYC change (authz version bumped). */
async function refresh(who) {
  const r = await h.refreshWeb(who.cookie).expect(200);
  who.accessToken = r.body.accessToken;
  who.cookie = r.headers['set-cookie'] ?? who.cookie; // refresh tokens rotate
  return who;
}

/** Claim, tick every rubric item and decide the open submission of a subject. */
async function review(by, kind, subjectId, decision = 'approve', extra = {}) {
  const sub = await models.Submission.findOne({ where: { kind, subjectId, status: 'pending_review' } });
  const claim = await api().post(`${P}/admin/submissions/${sub.id}/claim`).set(h.bearer(by)).expect(200);
  const rubric = await models.ReviewRubric.findByPk(sub.rubricId);
  await api().put(`${P}/admin/submissions/${sub.id}/ticks`).set(h.bearer(by)).send({ ticks: rubric.items.map((i) => i.key) }).expect(200);
  await api().post(`${P}/admin/submissions/${sub.id}/decide`).set(h.bearer(by)).set('Idempotency-Key', key('dec')).send({ decision, ...extra }).expect(200);
  await h.drainEvents();
  return claim.body;
}

async function sendDoc(who, docType, fields, status = 201) {
  const up = await api().post(`${P}/me/documents/files?slot=document&docType=${docType}`).set(h.bearer(who)).set('Content-Type', 'image/jpeg').send(Buffer.concat([JPEG, Buffer.from(docType + who.user.id)])).expect(201);
  return api().post(`${P}/me/documents`).set(h.bearer(who)).send({ docType, fields, files: { document: up.body.fileId }, consent: h.consent() }).expect(status);
}

/** A member who applied for ground_owner and whose trade licence and deed were approved. */
async function owner(name = 'Kamal Hossain') {
  const m = await h.signupUser({ name });
  await h.verifyMember(m.user.id);
  await refresh(m);
  await api().post(`${P}/me/roles`).set(h.bearer(m)).send({ role: 'ground_owner' }).expect(201);
  await refresh(m);
  await sendDoc(m, 'trade_license', { number: `TL-${(seq += 1)}-2026`, holderName: `${name} Sports`, expiresOn: future(300) }, 201);
  await sendDoc(m, 'deed_or_lease', { kind: 'lease', expiresOn: future(900) }, 201);
  await h.drainEvents();
  for (const t of ['trade_license', 'deed_or_lease']) await review(docsReviewer, 'document', subjectIdFor(m.user.id, t, 'ground_owner'));
  return refresh(m);
}

const areaId = async (k = 'dhanmondi') => (await models.Area.findOne({ where: { key: k } })).id;
const sportId = async (k = 'football') => (await models.Sport.findOne({ where: { key: k } })).id;
const surfaceId = async (k = 'artificial_turf') => (await models.Surface.findOne({ where: { key: k } })).id;
const facilityId = async (k) => (await models.Facility.findOne({ where: { key: k } })).id;

async function draftGround(who, over = {}) {
  const r = await api()
    .post(`${P}/me/grounds`)
    .set(h.bearer(who))
    .send({ name: 'Dhanmondi Turf Arena', areaId: await areaId(), addressLine: 'Road 8A, Dhanmondi', lat: 23.7465, lng: 90.376, basePricePoisha: 240000, facilityIds: [await facilityId('floodlights')], ...over })
    .expect(201);
  return r.body;
}

/** A ground with one court and three photos, ready for review. */
async function readyGround(who, over = {}) {
  const g = await draftGround(who, over);
  await api().post(`${P}/me/grounds/${g.id}/courts`).set(h.bearer(who)).send({ name: 'Court 1', sportIds: [await sportId(), await sportId('futsal')], surfaceId: await surfaceId(), sizeText: '40 x 20 m' }).expect(201);
  for (const buf of [JPEG, PNG, WEBP]) await api().post(`${P}/me/grounds/${g.id}/photos`).set(h.bearer(who)).set('Content-Type', buf === JPEG ? 'image/jpeg' : buf === PNG ? 'image/png' : 'image/webp').send(Buffer.concat([buf, Buffer.from(key('p'))])).expect(201);
  return g;
}

async function liveGround(who, over = {}) {
  const g = await readyGround(who, over);
  await api().post(`${P}/me/grounds/${g.id}/submit`).set(h.bearer(who)).expect(200);
  await review(reviewer, 'ground', g.id);
  return (await api().get(`${P}/me/grounds/${g.id}`).set(h.bearer(who)).expect(200)).body;
}

describe('M03 places catalogue', () => {
  it('serves sports, locations, areas (search, grounds service), facilities and surfaces', async () => {
    expect((await api().get(`${P}/catalog/sports`).expect(200)).body.items.map((s) => s.key)).toEqual(['cricket', 'football', 'futsal', 'badminton', 'basketball', 'kabaddi', 'volleyball', 'table_tennis', 'gym']);
    const loc = await api().get(`${P}/catalog/locations`).expect(200);
    expect(loc.body.items).toHaveLength(8);
    expect(loc.body.items.reduce((n, d) => n + d.districts.length, 0)).toBe(64);
    const dhaka = loc.body.items.find((d) => d.key === 'dhaka');
    expect((await api().get(`${P}/catalog/locations?divisionId=${dhaka.id}`).expect(200)).body.items).toHaveLength(1);
    expect((await api().get(`${P}/catalog/areas?service=grounds`).expect(200)).body.items.every((a) => a.isDhakaMetro)).toBe(true);
    expect((await api().get(`${P}/catalog/areas?q=mirpur%2010`).expect(200)).body.items.map((a) => a.key)).toEqual(['mirpur']);
    expect((await api().get(`${P}/catalog/areas?q=${encodeURIComponent('উত্তরা')}`).expect(200)).body.items.map((a) => a.key)).toEqual(['uttara']);
    const district = dhaka.districts.find((d) => d.key === 'dhaka');
    expect((await api().get(`${P}/catalog/areas?districtId=${district.id}`).expect(200)).body.items.length).toBe(18);
    expect((await api().get(`${P}/catalog/facilities`).expect(200)).body.items).toHaveLength(20); // 15 ground facilities + 5 gym facilities (M20)
    expect((await api().get(`${P}/catalog/surfaces`).expect(200)).body.items).toHaveLength(7);
  });

  it('staff with manage_catalog edit places; esports staff cannot', async () => {
    const esportsStaff = await staffWith(['manage_esports']);
    await api().get(`${P}/admin/catalog/areas`).set(h.bearer(esportsStaff)).expect(403);
    await api().get(`${P}/admin/catalog/esports-games`).set(h.bearer(esportsStaff)).expect(200);
    const district = await models.District.findOne({ where: { key: 'dhaka' } });
    const created = await api()
      .post(`${P}/admin/catalog/areas`)
      .set(h.bearer(master))
      .send({ key: 'shyamoli', nameEn: 'Shyamoli', nameBn: 'শ্যামলী', districtId: district.id, lat: 23.7746, lng: 90.3656, isDhakaMetro: true, dhakaZone: 'south', aliases: ['Shyamoli Square'], serviceFlags: 1 })
      .expect(201);
    expect(created.body).toMatchObject({ key: 'shyamoli', lat: 23.7746, aliases: ['Shyamoli Square'] });
    expect((await api().patch(`${P}/admin/catalog/areas/${created.body.id}`).set(h.bearer(master)).send({ districtId: (await models.District.findOne({ where: { key: 'sylhet' } })).id }).expect(422)).body.code).toBe('CATALOG_KEY_IMMUTABLE');
    expect((await api().post(`${P}/admin/catalog/areas`).set(h.bearer(master)).send({ key: 'xyz', nameEn: 'X', nameBn: 'X', districtId: district.id, lat: 23.7, lng: 90.3, isDhakaMetro: false, dhakaZone: 'north', serviceFlags: 0 }).expect(422)).body.code).toBe('VALIDATION_FAILED');
    expect((await api().get(`${P}/admin/catalog/districts?divisionId=${(await models.Division.findOne({ where: { key: 'sylhet' } })).id}`).set(h.bearer(master)).expect(200)).body.items).toHaveLength(4);
  });
});

describe('owner onboarding (M02 business documents lite → M01 ground_owner)', () => {
  it('needs an active member, an application and the two required documents; then the role is active', async () => {
    const m = await h.signupUser({ name: 'Farhana Akter' });
    expect((await api().post(`${P}/me/grounds`).set(h.bearer(m)).send({}).expect(403)).body.code).toBe('KYC_REQUIRED');
    expect((await sendDoc(m, 'trade_license', { number: 'TL-1', holderName: 'X Sports', expiresOn: future(30) }, 409)).body.code).toBe('MEMBER_NOT_ACTIVE');
    await h.verifyMember(m.user.id);
    await refresh(m);
    expect((await api().post(`${P}/me/grounds`).set(h.bearer(m)).send({}).expect(403)).body.code).toBe('ROLE_REQUIRED');
    expect((await sendDoc(m, 'trade_license', { number: 'TL-1234', holderName: 'X Sports', expiresOn: future(30) }, 409)).body.code).toBe('ROLE_NOT_APPLIED');
    await api().post(`${P}/me/roles`).set(h.bearer(m)).send({ role: 'ground_owner' }).expect(201);
    await refresh(m);

    const list = await api().get(`${P}/me/verification?role=ground_owner`).set(h.bearer(m)).expect(200);
    expect(list.body).toMatchObject({ role: 'ground_owner', roleStatus: 'applied', badge: 'verification_needed', progress: { approved: 0, total: 2 } });
    expect(list.body.items.map((i) => [i.key, i.required])).toEqual([['trade_license', 'always'], ['deed_or_lease', 'always'], ['tin', 'optional']]);
    expect(list.body.items[0].fields.map((f) => f.key)).toEqual(['number', 'holderName', 'expiresOn']);

    expect((await sendDoc(m, 'trade_license', { number: 'TL-1234', holderName: 'X Sports', expiresOn: '2020-01-01' }, 422)).body.code).toBe('VALIDATION_FAILED');
    expect((await api().post(`${P}/me/documents/files?slot=front&docType=trade_license`).set(h.bearer(m)).set('Content-Type', 'image/jpeg').send(JPEG).expect(422)).body.code).toBe('VALIDATION_FAILED');
    const tl = await sendDoc(m, 'trade_license', { number: 'TRAD/DNCC/123456', holderName: 'Farhana Sports', expiresOn: future(200) }, 201);
    expect(tl.body).toMatchObject({ docType: 'trade_license', status: 'in_review', numberMasked: '•••• 3456', birthYear: null });
    expect(JSON.stringify(tl.body)).not.toContain('123456');
    await h.drainEvents();
    expect((await models.UserRole.findOne({ where: { userId: m.user.id, role: 'ground_owner' } })).status).toBe('in_review');

    // The reviewer sees the typed fields (number masked), the checks, and no NID reveal.
    const sub = await models.Submission.findOne({ where: { kind: 'document', status: 'pending_review', submittedBy: m.user.id } });
    const claim = await api().post(`${P}/admin/submissions/${sub.id}/claim`).set(h.bearer(docsReviewer)).expect(200);
    expect(claim.body.checks.map((c) => c.key).sort()).toEqual(['file_reused', 'file_type', 'not_expired']);
    const panel = await api().get(`${P}/admin/kyc/documents/${tl.body.id}`).set(h.bearer(docsReviewer)).expect(200);
    expect(panel.body.fields).toMatchObject({ holderName: 'Farhana Sports', numberMasked: '•••• 3456', role: 'ground_owner' });
    expect(panel.body.fields.number).toBeUndefined();
    expect((await api().post(`${P}/admin/kyc/documents/${tl.body.id}/reveal-nid`).set(h.bearer(docsReviewer)).send({ reason: 'Checking it' }).expect(409)).body.code).toBe('REVEAL_NOT_AVAILABLE');
    await api().post(`${P}/admin/submissions/${sub.id}/release`).set(h.bearer(docsReviewer)).send({}).expect(200);

    await review(docsReviewer, 'document', sub.subjectId);
    expect((await models.UserRole.findOne({ where: { userId: m.user.id, role: 'ground_owner' } })).status).toBe('in_review');
    await refresh(m);
    await sendDoc(m, 'deed_or_lease', { kind: 'deed' }, 201);
    await h.drainEvents();
    const deed = await models.Submission.findOne({ where: { kind: 'document', status: 'pending_review', submittedBy: m.user.id } });
    await review(docsReviewer, 'document', deed.subjectId, 'request_changes', { reasonCode: 'unreadable' });
    expect((await models.UserRole.findOne({ where: { userId: m.user.id, role: 'ground_owner' } })).status).toBe('changes_requested');
    const sms = h.sms.lastTo(h.e164(m.phone));
    expect(sms.text).toContain('land deed or lease');
    await refresh(m);
    await sendDoc(m, 'deed_or_lease', { kind: 'deed' }, 201);
    await h.drainEvents();
    const deed2 = await models.Submission.findOne({ where: { kind: 'document', status: 'pending_review', submittedBy: m.user.id } });
    await review(docsReviewer, 'document', deed2.subjectId);
    expect((await models.UserRole.findOne({ where: { userId: m.user.id, role: 'ground_owner' } })).status).toBe('active');
    await refresh(m);
    const done = await api().get(`${P}/me/verification?role=ground_owner`).set(h.bearer(m)).expect(200);
    expect(done.body).toMatchObject({ roleStatus: 'active', badge: 'fully_verified', progress: { approved: 2, total: 2 } });
    expect((await models.Notification.findAll({ where: { userId: m.user.id } })).map((n) => n.code)).toEqual(expect.arrayContaining(['BUSINESS_DOC_SUBMITTED', 'BUSINESS_DOC_CHANGES_REQUESTED', 'ROLE_ACTIVATED']));
    // The NID flow is untouched: the member checklist still has two items.
    expect((await api().get(`${P}/me/verification`).set(h.bearer(m)).expect(200)).body.items.map((i) => i.key)).toEqual(['phone_verified', 'nid']);
  });
});

describe('listing and review (FR-01 to FR-05)', () => {
  it('a draft goes through review to live; the reviewer sees the checks and a first-version diff', async () => {
    const o = await owner();
    const g = await draftGround(o);
    expect(g).toMatchObject({ status: 'draft', slug: 'dhanmondi-turf-arena', pricing: { publishedVersion: null, basePricePoisha: 240000, hasDraft: true } });
    expect((await api().post(`${P}/me/grounds`).set(h.bearer(o)).send({ name: 'Bad', areaId: (await models.Area.findOne({ where: { key: 'agrabad' } })).id, addressLine: 'Somewhere far', lat: 22.3, lng: 91.8, basePricePoisha: 240000 }).expect(422)).body.code).toBe('AREA_NOT_SERVED');
    expect((await api().post(`${P}/me/grounds`).set(h.bearer(o)).send({ name: 'Cheap', areaId: await areaId(), addressLine: 'Road 1, Dhanmondi', lat: 23.7, lng: 90.37, basePricePoisha: 50000 }).expect(422)).body.code).toBe('VALIDATION_FAILED');

    const incomplete = await api().post(`${P}/me/grounds/${g.id}/submit`).set(h.bearer(o)).expect(422);
    expect(incomplete.body.code).toBe('GROUND_INCOMPLETE');
    expect(incomplete.body.errors.map((e) => e.field)).toEqual(['photos', 'courts']);

    await api().post(`${P}/me/grounds/${g.id}/courts`).set(h.bearer(o)).send({ name: 'Court 1', sportIds: [await sportId()], surfaceId: await surfaceId() }).expect(201);
    expect((await api().post(`${P}/me/grounds/${g.id}/courts`).set(h.bearer(o)).send({ name: 'court 1', sportIds: [await sportId()], surfaceId: await surfaceId() }).expect(409)).body.code).toBe('COURT_NAME_TAKEN');
    expect((await api().post(`${P}/me/grounds/${g.id}/courts`).set(h.bearer(o)).send({ name: 'Gym', sportIds: [await sportId('kabaddi')], surfaceId: await surfaceId() }).expect(422)).body.code).toBe('CATALOG_ITEM_UNKNOWN');
    expect((await api().post(`${P}/me/grounds/${g.id}/photos`).set(h.bearer(o)).set('Content-Type', 'image/png').send(JPEG).expect(415)).body.code).toBe('FILE_TYPE_MISMATCH');
    const photos = [];
    for (const buf of [JPEG, PNG, WEBP]) {
      const type = buf === JPEG ? 'image/jpeg' : buf === PNG ? 'image/png' : 'image/webp';
      photos.push((await api().post(`${P}/me/grounds/${g.id}/photos`).set(h.bearer(o)).set('Content-Type', type).send(Buffer.concat([buf, Buffer.from(key('x'))])).expect(201)).body);
    }
    expect(photos[0].url).toMatch(new RegExp(`/grounds/${g.id}/.+\\.jpg$`));
    expect(photos[2].url).toMatch(/\.webp$/);
    expect(storage._memory.has(`public:grounds/${g.id}/${photos[0].id}.jpg`)).toBe(true);

    const sent = await api().post(`${P}/me/grounds/${g.id}/submit`).set(h.bearer(o)).expect(200);
    expect(sent.body.status).toBe('pending_review');
    expect((await api().patch(`${P}/me/grounds/${g.id}`).set(h.bearer(o)).send({ name: 'New name' }).expect(409)).body.code).toBe('GROUND_IN_REVIEW');
    expect((await api().get(`${P}/grounds/${g.slug}`).expect(404)).body.code).toBe('NOT_FOUND');
    await h.drainEvents();
    expect((await models.Notification.findAll({ where: { userId: reviewer.user.id } })).map((n) => n.code)).toContain('GROUND_REVIEW_NEEDED');

    // The reviewer cannot be the owner; checks: owner documents, photos, hours and rules, price, duplicates.
    const claim = await review(reviewer, 'ground', g.id);
    expect(claim.checks.map((c) => [c.key, c.result]).sort()).toEqual([
      ['hours_and_rules_valid', 'pass'],
      ['name_unique_in_area', 'pass'],
      ['owner_kyc_approved', 'pass'],
      ['photos_min', 'pass'],
      ['price_in_range', 'pass'],
    ]);
    expect(claim.payload.diff).toMatchObject({ first: true, photos: { added: 3 } });
    const live = await api().get(`${P}/me/grounds/${g.id}`).set(h.bearer(o)).expect(200);
    expect(live.body).toMatchObject({ status: 'live', liveVersion: 1, editStatus: null, pricing: { publishedVersion: 1, hasDraft: false } });
    expect(live.body.courts[0].status).toBe('active');
    expect((await models.Notification.findAll({ where: { userId: o.user.id } })).map((n) => n.code)).toEqual(expect.arrayContaining(['GROUND_LIVE', 'GROUND_PRICING_PUBLISHED']));
    expect(h.sms.lastTo(h.e164(o.phone)).text).toContain('Dhanmondi Turf Arena is approved and live');

    // A replayed approval changes nothing.
    const sub = await models.Submission.findOne({ where: { kind: 'ground', subjectId: g.id } });
    const again = await models.sequelize.transaction((transaction) => require('../../src/modules/grounds/grounds.service').applyDecision(sub.id, 'approved', { transaction }));
    expect(again).toBeNull();
    expect((await models.Ground.findByPk(g.id)).liveVersion).toBe(1);
  });

  it('changes requested, resubmit; rejected is final; withdraw', async () => {
    const o = await owner();
    const g = await readyGround(o);
    await api().post(`${P}/me/grounds/${g.id}/submit`).set(h.bearer(o)).expect(200);
    await review(reviewer, 'ground', g.id, 'request_changes', { reasonCode: 'photos_unclear' });
    const back = await api().get(`${P}/me/grounds/${g.id}`).set(h.bearer(o)).expect(200);
    expect(back.body).toMatchObject({ status: 'changes_requested', reviewReason: { code: 'photos_unclear' } });
    expect(h.sms.lastTo(h.e164(o.phone)).text).toContain('please update Dhanmondi Turf Arena');
    await api().patch(`${P}/me/grounds/${g.id}`).set(h.bearer(o)).send({ description: 'Floodlit 5-a-side turf' }).expect(200);
    await api().post(`${P}/me/grounds/${g.id}/submit`).set(h.bearer(o)).expect(200);
    await api().post(`${P}/me/grounds/${g.id}/withdraw`).set(h.bearer(o)).expect(200);
    expect((await models.Ground.findByPk(g.id)).status).toBe('withdrawn');
    await h.drainEvents();
    expect(await models.Submission.count({ where: { kind: 'ground', subjectId: g.id, status: 'pending_review' } })).toBe(0);
    await api().post(`${P}/me/grounds/${g.id}/submit`).set(h.bearer(o)).expect(200);
    await review(reviewer, 'ground', g.id, 'reject', { reasonCode: 'not_a_venue' });
    expect((await models.Ground.findByPk(g.id)).status).toBe('rejected');
    expect((await api().post(`${P}/me/grounds/${g.id}/submit`).set(h.bearer(o)).expect(409)).body.code).toBe('GROUND_STATE');
    expect((await api().patch(`${P}/me/grounds/${g.id}`).set(h.bearer(o)).send({ description: 'x' }).expect(409)).body.code).toBe('GROUND_STATE');
  });

  it('an edit of a live ground runs beside the public version until it is approved (FR-03, FR-04)', async () => {
    const o = await owner();
    const g = await liveGround(o);
    // Not a review field: live at once.
    await api().patch(`${P}/me/grounds/${g.id}`).set(h.bearer(o)).send({ description: 'Now with a café' }).expect(200);
    expect((await api().get(`${P}/grounds/${g.slug}`).expect(200)).body.description).toBe('Now with a café');
    expect((await models.Ground.findByPk(g.id)).editStatus).toBeNull();
    expect((await api().post(`${P}/me/grounds/${g.id}/submit`).set(h.bearer(o)).expect(409)).body.code).toBe('NOTHING_TO_REVIEW');

    // Review fields: the public keeps the old name and courts until approved.
    await api().patch(`${P}/me/grounds/${g.id}`).set(h.bearer(o)).send({ name: 'Dhanmondi Turf Arena Pro' }).expect(200);
    const court2 = await api().post(`${P}/me/grounds/${g.id}/courts`).set(h.bearer(o)).send({ name: 'Court 2', sportIds: [await sportId('cricket')], surfaceId: await surfaceId('grass') }).expect(201);
    expect(court2.body).toMatchObject({ status: 'live', editStatus: 'draft' });
    let pub = await api().get(`${P}/grounds/${g.slug}`).expect(200);
    expect(pub.body.name).toBe('Dhanmondi Turf Arena');
    expect(pub.body.courts).toHaveLength(1);
    await api().post(`${P}/me/grounds/${g.id}/submit`).set(h.bearer(o)).expect(200);
    const claim = await review(reviewer, 'ground', g.id, 'request_changes', { reasonCode: 'info_incomplete' });
    expect(claim.payload).toMatchObject({ isEdit: true, version: 2 });
    expect(claim.payload.diff.fields).toEqual([{ field: 'name', from: 'Dhanmondi Turf Arena', to: 'Dhanmondi Turf Arena Pro' }]);
    expect(claim.payload.diff.courts).toEqual([{ id: expect.any(String), name: 'Court 2', change: 'added' }]);
    expect((await models.Ground.findByPk(g.id)).toJSON()).toMatchObject({ status: 'live', editStatus: 'changes_requested' });
    pub = await api().get(`${P}/grounds/${g.slug}`).expect(200);
    expect(pub.body.name).toBe('Dhanmondi Turf Arena');
    await api().post(`${P}/me/grounds/${g.id}/submit`).set(h.bearer(o)).expect(200);
    await review(reviewer, 'ground', g.id);
    pub = await api().get(`${P}/grounds/${g.slug}`).expect(200);
    expect(pub.body).toMatchObject({ name: 'Dhanmondi Turf Arena Pro', slug: g.slug, version: 2 });
    expect(pub.body.courts.map((c) => c.name)).toEqual(['Court 1', 'Court 2']);
  });

  it('pause, resume, courts, hours and photos (FR-05 to FR-08)', async () => {
    const o = await owner();
    const g = await liveGround(o);
    await api().post(`${P}/me/grounds/${g.id}/pause`).set(h.bearer(o)).expect(200);
    await api().get(`${P}/grounds/${g.slug}`).expect(404);
    expect((await api().post(`${P}/me/grounds/${g.id}/pause`).set(h.bearer(o)).expect(409)).body.code).toBe('GROUND_STATE');
    await api().post(`${P}/me/grounds/${g.id}/resume`).set(h.bearer(o)).expect(200);
    await api().get(`${P}/grounds/${g.slug}`).expect(200);

    // Hours: half-hour grid, the bookable day, all seven days; applied at once without review.
    const courtId = g.courts[0].id;
    const week = Array.from({ length: 7 }, (_, dow) => ({ dow, isClosed: dow === 5, openTime: dow === 5 ? null : '15:00', closeTime: dow === 5 ? null : '23:00' }));
    expect((await api().put(`${P}/me/courts/${courtId}/hours`).set(h.bearer(o)).send({ hours: week.map((d) => (d.dow === 0 ? { ...d, openTime: '05:00' } : d)) }).expect(422)).body.code).toBe('VALIDATION_FAILED');
    await api().put(`${P}/me/courts/${courtId}/hours`).set(h.bearer(o)).send({ hours: week }).expect(200);
    const pub = await api().get(`${P}/grounds/${g.slug}`).expect(200);
    expect(pub.body.courts[0].hours.find((x) => x.dow === 5)).toEqual({ dow: 5, isClosed: true, openTime: null, closeTime: null });
    expect((await models.Ground.findByPk(g.id)).editStatus).toBeNull();

    // A live ground keeps one court; photos reorder at once, removal is an edit.
    expect((await api().post(`${P}/me/courts/${courtId}/retire`).set(h.bearer(o)).expect(409)).body.code).toBe('LAST_COURT');
    const ids = g.photos.map((p) => p.id).reverse();
    await api().put(`${P}/me/grounds/${g.id}/photos/order`).set(h.bearer(o)).send({ ids }).expect(200);
    expect((await api().get(`${P}/grounds/${g.slug}`).expect(200)).body.photos.map((p) => p.id)).toEqual(ids);
    expect((await api().put(`${P}/me/grounds/${g.id}/photos/order`).set(h.bearer(o)).send({ ids: ids.slice(1) }).expect(422)).body.code).toBe('PHOTOS_MISMATCH');
    await api().post(`${P}/me/grounds/${g.id}/photos/${ids[0]}/remove`).set(h.bearer(o)).expect(200);
    expect((await models.Ground.findByPk(g.id)).editStatus).toBe('draft');
    expect((await api().post(`${P}/me/grounds/${g.id}/submit`).set(h.bearer(o)).expect(422)).body.errors[0].field).toBe('photos');
    expect(await models.GroundPhoto.count({ where: { id: ids[0] } })).toBe(1);

    // Another owner gets NOT_OWNER.
    const other = await owner('Rina Begum');
    expect((await api().get(`${P}/me/grounds/${g.id}`).set(h.bearer(other)).expect(403)).body.code).toBe('NOT_OWNER');
    expect((await api().patch(`${P}/me/courts/${courtId}`).set(h.bearer(other)).send({ name: 'Mine' }).expect(403)).body.code).toBe('NOT_OWNER');
    expect((await api().get(`${P}/me/grounds`).set(h.bearer(other)).expect(200)).body.items).toEqual([]);
  });

  it('staff suspend, masters restore and remove; a suspended owner role pauses every live ground', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const ops = await staffWith(['manage_users']);
    // Reviewers and ops see the list and the working copy; other staff do not.
    expect((await api().get(`${P}/admin/grounds?q=dhanmondi`).set(h.bearer(reviewer)).expect(200)).body.items.map((x) => x.id)).toEqual([g.id]);
    expect((await api().get(`${P}/admin/grounds/${g.id}`).set(h.bearer(ops)).expect(200)).body).toMatchObject({
      owner: { displayName: 'Kamal Hossain' },
      publicVersion: { version: 1, courts: 1, photos: 3 },
      rules: { version: 1, status: 'published' },
    });
    await api().get(`${P}/admin/grounds`).set(h.bearer(docsReviewer)).expect(403);
    await api().post(`${P}/admin/grounds/${g.id}/suspend`).set(h.bearer(reviewer)).send({ reason: 'Fake listing reported' }).expect(403);
    expect((await api().post(`${P}/admin/grounds/${g.id}/suspend`).set(h.bearer(ops)).send({ reason: 'Fake listing reported' }).expect(200)).body.status).toBe('suspended');
    await api().get(`${P}/grounds/${g.slug}`).expect(404);
    await api().post(`${P}/admin/grounds/${g.id}/restore`).set(h.bearer(ops)).send({ reason: 'Checked, it is real' }).expect(403);
    await api().post(`${P}/admin/grounds/${g.id}/restore`).set(h.bearer(master)).send({ reason: 'Checked, it is real' }).expect(200);
    expect((await models.AuditLog.findOne({ where: { action: 'ground.suspended' } })).severity).toBe('critical');

    await api().post(`${P}/admin/users/${o.user.id}/roles/ground_owner/status`).set(h.bearer(ops)).send({ status: 'suspended', reasonCode: 'fraud', note: 'Owner documents forged' }).expect(200);
    await h.drainEvents();
    expect((await models.Ground.findByPk(g.id)).status).toBe('paused');
    await api().post(`${P}/admin/grounds/${g.id}/remove`).set(h.bearer(master)).send({ reason: 'Owner banned for fraud' }).expect(200);
    expect((await models.Ground.findByPk(g.id)).status).toBe('removed');
    expect(await models.Ground.count({ where: { id: g.id } })).toBe(1);
  });
});

describe('pricing (FR-09 to FR-14) and the public read side (FR-25, FR-27)', () => {
  it('draft, publish, discard, history, apply to all; the base is locked in review', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const view = await api().get(`${P}/me/grounds/${g.id}/pricing`).set(h.bearer(o)).expect(200);
    expect(view.body).toMatchObject({ published: { version: 1, basePricePoisha: 240000, advancePct: 30, peakPct: 25 }, draft: null, upcomingBookings: 0, baseLocked: false, policy: { allowFullPayment: true, advanceRefundable: false, feePct: 5 } });

    const bad = await api().put(`${P}/me/grounds/${g.id}/pricing/draft`).set(h.bearer(o)).send({ advancePct: 55, peakPct: 61, halfRefundHours: 30 }).expect(422);
    expect(bad.body.errors.map((e) => e.field)).toEqual(['peakPct', 'advancePct', 'halfRefundHours']);
    await api().put(`${P}/me/grounds/${g.id}/pricing/draft`).set(h.bearer(o)).send({ peakPct: 30, advancePct: 25 }).expect(200);
    await api().post(`${P}/me/grounds/${g.id}/pricing/draft/discard`).set(h.bearer(o)).expect(200);
    expect((await api().post(`${P}/me/grounds/${g.id}/pricing/publish`).set(h.bearer(o)).send({}).expect(409)).body.code).toBe('PRICING_DRAFT_MISSING');
    await api().put(`${P}/me/grounds/${g.id}/pricing/draft`).set(h.bearer(o)).send({ basePricePoisha: 300000, peakPct: 30 }).expect(200);
    const pub = await api().post(`${P}/me/grounds/${g.id}/pricing/publish`).set(h.bearer(o)).send({}).expect(200);
    expect(pub.body.published).toMatchObject({ version: 3, status: 'published', summary: 'Updated pricing: base ৳3,000/h, peak +30% from 5pm', changedKeys: ['basePricePoisha', 'peakPct'] });
    const hist = await api().get(`${P}/me/grounds/${g.id}/pricing/history`).set(h.bearer(o)).expect(200);
    expect(hist.body.items.map((i) => [i.version, i.status])).toEqual([[3, 'published'], [1, 'superseded']]);
    expect(hist.body.items[0].publishedBy.id).toBe(o.user.id);
    expect((await models.AuditLog.findOne({ where: { action: 'ground_pricing.published', entityId: pub.body.published.id } })).toJSON()).toMatchObject({ before: expect.objectContaining({ basePricePoisha: 240000 }), after: expect.objectContaining({ basePricePoisha: 300000 }) });

    // A second ground: in review, the base price is locked; "apply to all" keeps each base.
    const g2 = await readyGround(o, { name: 'Uttara Futsal Club', areaId: await areaId('uttara'), lat: 23.8728, lng: 90.3984, basePricePoisha: 180000 });
    await api().post(`${P}/me/grounds/${g2.id}/submit`).set(h.bearer(o)).expect(200);
    expect((await api().put(`${P}/me/grounds/${g2.id}/pricing/draft`).set(h.bearer(o)).send({ basePricePoisha: 200000 }).expect(409)).body.code).toBe('GROUND_IN_REVIEW');
    await review(reviewer, 'ground', g2.id);
    await api().put(`${P}/me/grounds/${g.id}/pricing/draft`).set(h.bearer(o)).send({ weekendPct: 20, advancePct: 40 }).expect(200);
    const all = await api().post(`${P}/me/grounds/${g.id}/pricing/publish`).set(h.bearer(o)).send({ applyToAll: true }).expect(200);
    expect(all.body.alsoPublished).toEqual([{ groundId: g2.id, version: 2 }]);
    const p2 = await api().get(`${P}/me/grounds/${g2.id}/pricing`).set(h.bearer(o)).expect(200);
    expect(p2.body.published).toMatchObject({ basePricePoisha: 180000, weekendPct: 20, advancePct: 40, peakPct: 30 });
  });

  it('quote and heatmap: worked examples, draft prices, lengths and hours (FR-13)', async () => {
    const o = await owner();
    const g = await liveGround(o);
    const courtId = g.courts[0].id;
    const at = (date, hm) => pr.dhakaInstant(date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3))).toISOString();
    const q = await api().post(`${P}/grounds/${g.id}/quote`).send({ courtIds: [courtId], start: at('2026-11-02', '18:00'), minutes: 120 }).expect(200);
    expect(q.body).toMatchObject({ price: 600000, advance: 180000, balance: 420000, fee: 30000, rulesVersion: 1 });
    expect(q.body.options.map((x) => x.kind)).toEqual(['advance', 'full']);
    expect((await api().post(`${P}/grounds/${g.id}/quote`).send({ courtIds: [courtId], start: at('2026-11-02', '22:30'), minutes: 60 }).expect(422)).body.code).toBe('OUTSIDE_HOURS');
    expect((await api().post(`${P}/grounds/${g.id}/quote`).send({ courtIds: [courtId], start: at('2026-11-02', '18:00'), minutes: 30 }).expect(422)).body.code).toBe('LENGTH_INVALID');
    expect((await api().post(`${P}/grounds/${g.id}/quote`).send({ courtIds: [g.id], start: at('2026-11-02', '18:00'), minutes: 60 }).expect(422)).body.code).toBe('COURT_UNKNOWN');

    const draftQ = await api().post(`${P}/me/grounds/${g.id}/pricing/quote`).set(h.bearer(o)).send({ courtIds: [courtId], start: at('2026-11-06', '16:30'), minutes: 90, draft: { advancePct: 25 } }).expect(200);
    // ৳4,830 × 25% = ৳1,207.50 → ৳1,208 (nearest ৳1, half-up)
    expect(draftQ.body).toMatchObject({ price: 483000, advance: 120800, minBookingMin: 60 });
    expect((await api().post(`${P}/me/grounds/${g.id}/pricing/quote`).set(h.bearer(o)).send({ courtIds: [courtId], start: at('2026-11-06', '16:30'), minutes: 90, draft: { advancePct: 3 } }).expect(422)).body.code).toBe('VALIDATION_FAILED');

    const heat = await api().get(`${P}/me/grounds/${g.id}/pricing/heatmap`).set(h.bearer(o)).expect(200);
    expect(heat.body.rows).toHaveLength(7);
    expect(heat.body.rows[0].cells).toHaveLength(17);
    expect(heat.body.basePricePoisha).toBe(240000);
  });

  it('the public list: only live grounds, filters, facets and sorts', async () => {
    const o = await owner();
    const a = await liveGround(o);
    const b = await liveGround(o, { name: 'Uttara Futsal Club', areaId: await areaId('uttara'), lat: 23.8728, lng: 90.3984, basePricePoisha: 150000, isIndoor: true });
    await readyGround(o, { name: 'Still A Draft', basePricePoisha: 100000 });
    const list = await api().get(`${P}/grounds`).expect(200);
    expect(list.body.items.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(list.body).toMatchObject({ total: 2, sort: 'cheapest', nextCursor: null });
    expect(list.body.items[0]).toMatchObject({ name: 'Uttara Futsal Club', area: { key: 'uttara' }, courtsCount: 1, priceFromPoisha: 120000 });
    expect(list.body.items[0].coverUrl).toMatch(/^http.+\/grounds\//);
    expect(list.body.facets.sports.map((f) => [f.key, f.count]).sort()).toEqual([['football', 2], ['futsal', 2]]);
    expect(list.body.facets.indoor).toEqual({ indoor: 1, outdoor: 1 });

    // M09-FR-28: part of the name, any case; a wildcard is not a wildcard; one letter is refused.
    expect((await api().get(`${P}/grounds?q=uttara%20futsal`).expect(200)).body.items.map((x) => x.id)).toEqual([b.id]);
    expect((await api().get(`${P}/grounds?q=UTTARA`).expect(200)).body.total).toBe(1);
    expect((await api().get(`${P}/grounds?q=%25%25`).expect(200)).body.total).toBe(0);
    expect((await api().get(`${P}/grounds?q=__`).expect(200)).body.total).toBe(0);
    await api().get(`${P}/grounds?q=u`).expect(422);
    expect((await api().get(`${P}/grounds?indoor=true`).expect(200)).body.items.map((x) => x.id)).toEqual([b.id]);
    // Facets ignore their own filter: the indoor facet still counts both.
    expect((await api().get(`${P}/grounds?indoor=true`).expect(200)).body.facets.indoor).toEqual({ indoor: 1, outdoor: 1 });
    expect((await api().get(`${P}/grounds?areaId=${await areaId()}`).expect(200)).body.items.map((x) => x.id)).toEqual([a.id]);
    expect((await api().get(`${P}/grounds?sport=cricket`).expect(200)).body.total).toBe(0);
    expect((await api().get(`${P}/grounds?facilities=floodlights&surface=artificial_turf`).expect(200)).body.total).toBe(2);
    expect((await api().get(`${P}/grounds?facilities=cafe`).expect(200)).body.total).toBe(0);
    expect((await api().get(`${P}/grounds?priceMax=150000`).expect(200)).body.items.map((x) => x.id)).toEqual([b.id]);
    const near = await api().get(`${P}/grounds?lat=23.7465&lng=90.376&radiusKm=5`).expect(200);
    expect(near.body).toMatchObject({ sort: 'nearest', total: 1 });
    expect(near.body.items[0]).toMatchObject({ id: a.id, distanceM: 0 });
    const paged = await api().get(`${P}/grounds?limit=1`).expect(200);
    expect(paged.body.nextCursor).toBe('1');
    expect((await api().get(`${P}/grounds?limit=1&cursor=1`).expect(200)).body.items[0].id).toBe(a.id);
    expect((await api().get(`${P}/grounds?sort=newest`).expect(200)).body.items[0].id).toBe(b.id);

    const detail = await api().get(`${P}/grounds/${a.slug}`).expect(200);
    expect(detail.headers.etag).toBeDefined();
    expect(detail.body).toMatchObject({
      name: 'Dhanmondi Turf Arena',
      area: { key: 'dhanmondi', district: { key: 'dhaka' } },
      facilities: [expect.objectContaining({ key: 'floodlights' })],
      pricing: { basePricePoisha: 240000, fromPoisha: 192000, toPoisha: 345000, minBookingMin: 60, advancePct: 30 },
      payment: { allowFullPayment: true, advanceRefundable: false, fullRefundHours: null },
      owner: { displayName: 'Kamal Hossain' },
      bookingOpen: true, // M10: live grounds take bookings
    });
    expect(detail.body.courts[0].sports.map((s) => s.key)).toEqual(['football', 'futsal']);
    expect(detail.body.photos).toHaveLength(3);
    await api().get(`${P}/grounds/${a.slug}`).set('If-None-Match', detail.headers.etag).expect(304);
  });
});
