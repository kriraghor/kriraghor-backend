'use strict';

/**
 * M12 test fixtures (jest and the Postman runner): staff, a shop owner onboarded through M02
 * (trade licence and TIN, per role), a live shop and products of the seeded item types.
 */
const h = require('../helpers');
const { subjectIdFor } = require('../../src/modules/kyc/kyc.moderation');

const { api, P, models } = h;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('product photo')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('product photo')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

let seq = 0;
const uniq = (p) => `${p}-${Date.now()}-${(seq += 1)}`;
const future = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

async function staffWith(master, permissions) {
  seq += 1;
  const s = await h.signupUser({ name: 'Rumana Akter' });
  const r = await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'staff.write')).send({ userId: s.user.id, employeeId: `KG-MKT-${seq}`, permissions });
  if (r.status !== 201) throw new Error(`staff: ${r.status} ${JSON.stringify(r.body)}`);
  return h.signInStaff(s.phone, s.user.id);
}

/** A fresh access token after a role or KYC change (authz version bumped). */
async function refresh(who) {
  const r = await h.refreshWeb(who.cookie).expect(200);
  who.accessToken = r.body.accessToken;
  who.cookie = r.headers['set-cookie'] ?? who.cookie;
  return who;
}

/** Claim, tick every rubric item and decide the open submission of a subject. */
async function review(by, kind, subjectId, decision = 'approve', extra = {}) {
  const sub = await models.Submission.findOne({ where: { kind, subjectId, status: 'pending_review' } });
  if (!sub) throw new Error(`no open ${kind} submission for ${subjectId}`);
  await api().post(`${P}/admin/submissions/${sub.id}/claim`).set(h.bearer(by)).expect(200);
  const rubric = await models.ReviewRubric.findByPk(sub.rubricId);
  await api().put(`${P}/admin/submissions/${sub.id}/ticks`).set(h.bearer(by)).send({ ticks: rubric.items.map((i) => i.key) }).expect(200);
  await api().post(`${P}/admin/submissions/${sub.id}/decide`).set(h.bearer(by)).set('Idempotency-Key', uniq('dec')).send({ decision, ...extra }).expect(200);
  await h.drainEvents();
  return sub;
}

async function sendDoc(who, docType, fields, { role, status = 201 } = {}) {
  const up = await api().post(`${P}/me/documents/files?slot=document&docType=${docType}`).set(h.bearer(who)).set('Content-Type', 'image/jpeg').send(Buffer.concat([JPEG, Buffer.from(uniq(docType))])).expect(201);
  return api().post(`${P}/me/documents`).set(h.bearer(who)).send({ docType, fields, files: { document: up.body.fileId }, consent: h.consent(), ...(role ? { role } : {}) }).expect(status);
}

/** A member who applied for shop_owner and whose trade licence and TIN were approved (role active). */
async function shopOwner(docsReviewer, name = 'Nayeem Sports') {
  const m = await h.signupUser({ name });
  await h.verifyMember(m.user.id);
  await refresh(m);
  await api().post(`${P}/me/roles`).set(h.bearer(m)).send({ role: 'shop_owner' }).expect(201);
  await refresh(m);
  await sendDoc(m, 'trade_license', { number: `TL-${(seq += 1)}-2026`, holderName: name, expiresOn: future(300) });
  await sendDoc(m, 'tin', { number: String(100000000000 + (seq += 1)) });
  await h.drainEvents();
  for (const t of ['trade_license', 'tin']) await review(docsReviewer, 'document', subjectIdFor(m.user.id, t, 'shop_owner'));
  return refresh(m);
}

const areaId = async (k = 'dhanmondi') => (await models.Area.findOne({ where: { key: k } })).id;
const typeId = async (k) => (await models.ItemType.findOne({ where: { key: k } })).id;

/** A shop approved on the Moderation desk. */
async function liveShop(owner, reviewer, over = {}) {
  const r = await api().post(`${P}/shop/profile`).set(h.bearer(owner)).send({ shopType: 'sports_gear', name: 'Elephant Road Sports', areaId: await areaId(), addressLine: '12 Elephant Road, Dhaka', ...over }).expect(201);
  await api().post(`${P}/shop/profile/submit`).set(h.bearer(owner)).expect(200);
  await review(reviewer, 'shop', r.body.id);
  return (await api().get(`${P}/shop/profile`).set(h.bearer(owner)).expect(200)).body;
}

async function addPhotos(owner, productId, n = 3) {
  const bufs = [JPEG, PNG, WEBP];
  for (let i = 0; i < n; i += 1) {
    const buf = bufs[i % 3];
    await api().post(`${P}/shop/products/${productId}/photos`).set(h.bearer(owner)).set('Content-Type', buf === JPEG ? 'image/jpeg' : buf === PNG ? 'image/png' : 'image/webp').send(Buffer.concat([buf, Buffer.from(uniq('p'))])).expect(201);
  }
}

/** Turf boots in six EU sizes with opening stock, three photos, ready for review. */
async function readyBoots(owner, { sizes = ['40', '41', '42', '43', '44', '45'], stock = 2, over = {} } = {}) {
  const r = await api()
    .post(`${P}/shop/products`)
    .set(h.bearer(owner))
    .send({ itemTypeId: await typeId('football_boots'), title: 'Adidas Predator Turf Boots', brand: 'Adidas', specs: { stud_type: 'tf' }, basePricePoisha: 650000, variants: sizes.map((s) => ({ attributes: { eu_size: s }, openingStock: stock })), ...over })
    .expect(201);
  await addPhotos(owner, r.body.id);
  return r.body;
}

async function liveProduct(owner, reviewer, ready) {
  await api().post(`${P}/shop/products/${ready.id}/submit`).set(h.bearer(owner)).expect(200);
  await review(reviewer, 'product', ready.id);
  return (await api().get(`${P}/shop/products/${ready.id}`).set(h.bearer(owner)).expect(200)).body;
}

module.exports = { JPEG, PNG, WEBP, uniq, future, staffWith, refresh, review, sendDoc, shopOwner, areaId, typeId, liveShop, addPhotos, readyBoots, liveProduct };
