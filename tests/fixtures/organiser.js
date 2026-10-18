'use strict';

/**
 * M14 lite and M22 test fixtures (jest and the Postman runner): an organiser whose role and
 * organisation registration were approved (M02), a verified organisation (M05 kind organisation), and
 * an active contract (created, signed PDF attached and activated by a master with step-up).
 */
const h = require('../helpers');
const f = require('./market');
const { subjectIdFor } = require('../../src/modules/kyc/kyc.moderation');

const { api, P } = h;
const PDF = Buffer.from('%PDF-1.4\n% signed contract\n');

/** A member who applied for the organiser role and whose organisation registration was approved. */
async function organiserOwner(docsReviewer, name = 'Rafsan Chowdhury') {
  const m = await h.signupUser({ name });
  await h.verifyMember(m.user.id);
  await f.refresh(m);
  await api().post(`${P}/me/roles`).set(h.bearer(m)).send({ role: 'organiser' }).expect(201);
  await f.refresh(m);
  await f.sendDoc(m, 'org_registration', { kind: 'society', number: `SOC-${f.uniq('o')}`.slice(0, 40), holderName: 'Dhaka Clutch League' });
  await h.drainEvents();
  await f.review(docsReviewer, 'document', subjectIdFor(m.user.id, 'org_registration', 'organiser'));
  return f.refresh(m);
}

/** A verified organisation owned by `owner` (draft, submitted, approved by `reviewer`). */
async function verifiedOrg(owner, reviewer, name = 'Dhaka Clutch League') {
  const o = await api().post(`${P}/me/organisations`).set(h.bearer(owner)).send({ name, about: 'Weekly Free Fire scrims for Dhaka colleges.' }).expect(201);
  await api().post(`${P}/me/organisations/${o.body.id}/submit`).set(h.bearer(owner)).expect(200);
  await h.drainEvents();
  await f.review(reviewer, 'organisation', o.body.id);
  return (await api().get(`${P}/me/organisations/${o.body.id}`).set(h.bearer(owner)).expect(200)).body;
}

/** An active contract (percentage at the setting by default) entered by a master. */
async function activeContract(master, organisationId, terms = {}) {
  const today = new Date(Date.now() + 6 * 3600000).toISOString().slice(0, 10);
  const k = await api()
    .post(`${P}/admin/organisers/${organisationId}/contracts`)
    .set(h.bearer(master))
    .send({ model: 'percentage', billingCycle: 'per_tournament', startsOn: today, ...terms })
    .expect(201);
  await api().post(`${P}/admin/organisers/contracts/${k.body.id}/document`).set(h.bearer(master)).set('Content-Type', 'application/pdf').send(PDF).expect(200);
  const a = await api().post(`${P}/admin/organisers/contracts/${k.body.id}/activate`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'esports.money')).expect(200);
  await h.drainEvents();
  return a.body;
}

module.exports = { PDF, organiserOwner, verifiedOrg, activeContract };
