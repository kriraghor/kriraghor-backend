'use strict';

/**
 * M11 test fixtures (jest and the Postman runner): a pro onboarded through M01 (role) and M02 (a
 * credential per hire role), a hire profile reviewed on the Moderation desk with its rate card, and
 * engagement times on the Dhaka clock.
 */
const h = require('../helpers');
const f = require('./market');
const { subjectIdFor } = require('../../src/modules/kyc/kyc.moderation');

const { api, P, models } = h;

/** The design umpire: T20 ৳3,500, T10 ৳2,500; night 20%, short notice 15% under 48 h; travel ৳300 / ৳500 / ৳1,500. */
const UMPIRE_CARD = {
  items: [
    { unit: 'match', format: 'T20', rate: 350000 },
    { unit: 'match', format: 'T10', rate: 250000 },
  ],
  nightPct: 20,
  shortNoticePct: 15,
  shortNoticeHours: 48,
  travel: { north: 30000, south: 50000, outside: 150000 },
  maxJobsPerDay: 2,
};

/** 19:30 Dhaka (13:30 UTC) `days` days from today. */
function at1930(days) {
  const d = new Date(Date.now() + days * 86400000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 13, 30)).toISOString();
}

/** A member with an active member role who applied as a pro (or player). */
async function applicant(platformRole = 'pro', name = 'Kamrul Hasan') {
  const m = await h.signupUser({ name });
  await h.verifyMember(m.user.id);
  await f.refresh(m);
  await api().post(`${P}/me/roles`).set(h.bearer(m)).send({ role: platformRole }).expect(201);
  return f.refresh(m);
}

/** Send and approve a credential for a hire role (M02, kept under hire:<role>). */
async function credential(who, docsReviewer, { roleKey, level, platformRole = 'pro' }) {
  await f.sendDoc(who, 'credential', { hireRole: roleKey, level, issuer: 'Bangladesh Cricket Board', number: `BCB-${Date.now()}` }, { role: platformRole });
  await h.drainEvents();
  await f.review(docsReviewer, 'document', subjectIdFor(who.user.id, 'credential', `hire:${roleKey}`));
  return f.refresh(who);
}

/** A live hire profile with a rate card; returns { pro, profile }. */
async function liveProfile({ docsReviewer, reviewer, roleKey = 'cricket_umpire', level = 'semi_pro', credentialLevel = 'pro', baseArea = 'dhanmondi', card = UMPIRE_CARD, name = 'Kamrul Hasan', platformRole = 'pro' }) {
  const pro = await applicant(platformRole, name);
  if (credentialLevel) await credential(pro, docsReviewer, { roleKey, level: credentialLevel, platformRole });
  const created = await api()
    .post(`${P}/pro/profiles`)
    .set(h.bearer(pro))
    .send({ roleKey, headline: 'BCB umpire for club and league cricket', experienceLevel: level, years: 6, baseAreaId: await f.areaId(baseArea), sportKeys: ['cricket'], bio: 'Six seasons in the Dhaka leagues, white and red ball.' })
    .expect(201);
  await api().put(`${P}/pro/profiles/${created.body.id}/rate-card`).set(h.bearer(pro)).send(card).expect(200);
  await api().post(`${P}/pro/profiles/${created.body.id}/submit`).set(h.bearer(pro)).expect(200);
  await h.drainEvents();
  await f.review(reviewer, 'hire_profile', created.body.id);
  await f.refresh(pro);
  return { pro, profile: (await api().get(`${P}/pro/profiles/${created.body.id}`).set(h.bearer(pro)).expect(200)).body };
}

/** A request for T20 matches at 19:30 Dhaka in Mirpur (Dhaka north). */
const matchRequest = async (profileId, starts) => ({
  profileId,
  unit: 'match',
  engagements: await Promise.all(starts.map(async (start) => ({ start, format: 'T20', venueText: 'Mirpur Turf 10', venueAreaId: await f.areaId('mirpur') }))),
  note: 'League match, white ball',
});

/** Move a job (and its busy guard) to start `minutes` from now, keeping its length. */
async function moveJob(jobId, minutes) {
  const j = await models.HireJob.findByPk(jobId);
  const len = new Date(j.endAt).getTime() - new Date(j.startAt).getTime();
  const start = new Date(Date.now() + minutes * 60000);
  const end = new Date(start.getTime() + len);
  await j.update({ startAt: start, endAt: end, busy: [{ value: new Date(start.getTime() - 1800000), inclusive: true }, { value: new Date(end.getTime() + 1800000), inclusive: false }] });
  return j.reload();
}

module.exports = { UMPIRE_CARD, at1930, applicant, credential, liveProfile, matchRequest, moveJob };
