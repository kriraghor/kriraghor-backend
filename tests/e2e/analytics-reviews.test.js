'use strict';

// M19-FR-32 and FR-33 (§6.4): the staff review figures. Decisions become review facts from M05's events
// (a reopen keeps the earlier fact, replays and the backfill never double count); GET
// /admin/analytics/reviews counts "me" or "team" in the kinds the person may review.
const { randomUUID } = require('node:crypto');
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const facts = require('../../src/modules/analytics/facts.service');

const { api, P, models } = h;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg body for tests')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png')]);
const PDF = Buffer.from('%PDF-1.7\n% test document\n');
const RUBRIC = ['name_matches', 'readable', 'not_edited', 'face_matches'];
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

let master;
beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

let emp = 0;
async function staffWith(permissions, name = 'Rumana Akter') {
  emp += 1;
  const s = await h.signupUser({ name });
  await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'staff.write')).send({ userId: s.user.id, employeeId: `KG-RV-${emp}`, permissions }).expect(201);
  return h.signInStaff(s.phone, s.user.id);
}
async function submitNid(who) {
  const files = {};
  for (const [slot, buf, type] of [['front', JPEG, 'image/jpeg'], ['back', PNG, 'image/png'], ['selfie', PDF, 'application/pdf']]) {
    const r = await api().post(`${P}/me/documents/files?slot=${slot}`).set(h.bearer(who)).set('Content-Type', type).send(Buffer.concat([buf, Buffer.from(who.user.id)])).expect(201);
    files[slot] = r.body.fileId;
  }
  const r = await api().post(`${P}/me/documents`).set(h.bearer(who)).send({ docType: 'nid', fields: { number: '19901234567890123', dob: '1990-05-14', legalName: 'Nusrat Jahan' }, files, consent: h.consent() }).expect(201);
  return models.Submission.findOne({ where: { kind: 'document', payload: { documentId: r.body.id } } });
}
const sub = (id, path) => `${P}/admin/submissions/${id}${path}`;
let idem = 0;
async function decide(who, id, body) {
  idem += 1;
  await api().post(sub(id, '/claim')).set(h.bearer(who)).expect(200);
  if (body.decision === 'approve') await api().put(sub(id, '/ticks')).set(h.bearer(who)).send({ ticks: RUBRIC }).expect(200);
  return api().post(sub(id, '/decide')).set(h.bearer(who)).set('Idempotency-Key', `review-figures-${idem}`).send(body).expect(200);
}
const figures = (who, query = '') => api().get(`${P}/admin/analytics/reviews${query}`).set(h.bearer(who));
const fact = (row) => models.KpiFactReview.create({ submissionId: randomUUID(), reasonCode: null, ...row });

describe('review facts from decisions (M19-FR-32)', () => {
  it('a decision is a fact; a reopen keeps it; replays and the backfill never count twice', async () => {
    const member = await h.signupUser({ name: 'Nusrat Jahan' });
    const reviewer = await staffWith(['approve_documents']);
    const s = await submitNid(member);
    await decide(reviewer, s.id, { decision: 'reject', reasonCode: 'other', reasonText: 'Not a National ID card' });
    await h.drainEvents();
    expect(await models.KpiFactReview.findAll({ raw: true })).toEqual([
      expect.objectContaining({ submissionId: s.id, kind: 'document', decision: 'rejected', reasonCode: 'other', decidedBy: reviewer.userId }),
    ]);

    await api().post(sub(s.id, '/reopen')).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'moderation.override')).send({ reason: 'It is a National ID' }).expect(200);
    await decide(reviewer, s.id, { decision: 'approve' });
    await h.drainEvents();
    const rows = await models.KpiFactReview.findAll({ order: [['decidedAt', 'ASC']], raw: true });
    expect(rows.map((r) => r.decision)).toEqual(['rejected', 'approved']);
    expect(rows[1].reasonCode).toBeNull();

    // The backfill finds only the approval on the row, already stored: nothing added.
    expect(await facts.backfillReviews()).toEqual({ reviews: 0 });
    // Without the facts it recovers the decision still on the row; the reopened rejection is gone from M05.
    await models.KpiFactReview.destroy({ where: {} });
    expect(await facts.backfillReviews()).toEqual({ reviews: 1 });
    expect((await models.KpiFactReview.findOne({ raw: true })).decision).toBe('approved');

    const r = await figures(reviewer).expect(200);
    expect(r.body).toMatchObject({ scope: 'me', window: { days: 30 }, tiles: { waiting: { value: 0, note: { overdue: 0 } }, reviewedToday: { value: 1 }, approvalRate: { value: 1 } } });
    expect(r.body.recent).toEqual([expect.objectContaining({ submissionId: s.id, kind: 'document', decision: 'approved', reason: null })]);
    expect(r.body.perDay).toHaveLength(30);
    expect(r.body.perDay[29]).toMatchObject({ approved: 1, changesRequested: 0, rejected: 0 });
    expect(r.body.definitions.median_decision).toMatch(/middle time/);
  });
});

describe('GET /admin/analytics/reviews (M19-FR-33)', () => {
  it('counts me or the team, only in the kinds the person may review, with the windows and comparisons', async () => {
    const docs = await staffWith(['approve_documents'], 'Docs Reviewer');
    const both = await staffWith(['approve_documents', 'approve_listings'], 'Listings Reviewer');
    const now = Date.now();
    const at = (ms, minutes) => ({ submittedAt: new Date(now - ms - minutes * MIN), decidedAt: new Date(now - ms) });
    // docs: one approval today (60 min), one change asked 40 days ago (30 min, the window before).
    await fact({ kind: 'document', decision: 'approved', decidedBy: docs.userId, ...at(MIN, 60) });
    await fact({ kind: 'document', decision: 'changes_requested', reasonCode: 'unreadable', decidedBy: docs.userId, ...at(40 * DAY, 30) });
    // both: a ground rejected today (unseen by docs), a document approved this weekday last week (120 min).
    await fact({ kind: 'ground', decision: 'rejected', reasonCode: 'photos_unclear', decidedBy: both.userId, ...at(2 * MIN, 10) });
    await fact({ kind: 'document', decision: 'approved', decidedBy: both.userId, ...at(7 * DAY + MIN, 120) });

    const me = (await figures(docs, '?scope=me').expect(200)).body;
    expect(me.tiles).toMatchObject({ reviewedToday: { value: 1, delta: null, note: { lastWeek: 0 } }, medianMinutes: { value: 60, delta: 100 }, approvalRate: { value: 1, delta: 100 } });
    expect(me.whyNo).toEqual([]);

    const team = (await figures(docs, '?scope=team').expect(200)).body;
    expect(team.tiles).toMatchObject({ reviewedToday: { value: 1, delta: 0, note: { lastWeek: 1 } }, medianMinutes: { value: 90 }, approvalRate: { value: 1 } });
    expect(team.recent).toEqual([]);
    expect(team.perDay.reduce((n, d) => n + d.approved + d.rejected + d.changesRequested, 0)).toBe(2);

    const all = (await figures(master, '?scope=team&locale=bn').expect(200)).body;
    expect(all.tiles.reviewedToday.value).toBe(2);
    expect(all.tiles.approvalRate.value).toBe(0.667);
    expect(all.whyNo).toEqual([{ code: 'photos_unclear', label: expect.not.stringMatching(/^photos_unclear$/), count: 1 }]);
    expect(all.definitions.why_no).toMatch(/[ঀ-৿]/);

    const mine = (await figures(both).expect(200)).body;
    expect(mine.recent.map((x) => x.kind)).toEqual(['ground', 'document']);
    expect(mine.recent[0]).toMatchObject({ decision: 'rejected', reasonCode: 'photos_unclear', reason: 'Photos unclear or not of the item' });
  });

  it('is for masters and reviewers only; a bad scope is 422', async () => {
    const other = await staffWith(['manage_users'], 'Users Desk');
    expect((await figures(other).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    const listings = await staffWith(['approve_listings'], 'Listings Only');
    await figures(listings).expect(200);
    await figures(master).expect(200);
    expect((await figures(master, '?scope=everyone').expect(422)).body.code).toBe('VALIDATION_FAILED');
  });
});
