'use strict';

// M05 Moderation lite on its first kind, `document` (M02 NID): versions and supersede (FR-01 to FR-03),
// the claim lock with TTL, heartbeat and hard cap (FR-07, FR-08), kinds by permission (FR-17), the
// rubric, reasons and self-review (FR-09 to FR-11), the master override with step-up (Q46), reopen
// (FR-21), the apply watchdog (FR-13), SLA breaches (FR-18), sanctions (edge case 6) and no PII in events.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const moderation = require('../../src/modules/moderation/moderation.service');

const { api, P, models } = h;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg body for tests')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png')]);
const PDF = Buffer.from('%PDF-1.7\n% test document\n');
const NID = '19901234567890123';
const RUBRIC = ['name_matches', 'readable', 'not_edited', 'face_matches'];

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

async function submit(who, { number = NID, legalName = 'Nusrat Jahan', salt = '' } = {}) {
  const files = {};
  for (const [slot, buf, type] of [['front', JPEG, 'image/jpeg'], ['back', PNG, 'image/png'], ['selfie', PDF, 'application/pdf']]) {
    const r = await api().post(`${P}/me/documents/files?slot=${slot}`).set(h.bearer(who)).set('Content-Type', type).send(Buffer.concat([buf, Buffer.from(`${salt}${who.user.id}`)])).expect(201);
    files[slot] = r.body.fileId;
  }
  const r = await api().post(`${P}/me/documents`).set(h.bearer(who)).send({ docType: 'nid', fields: { number, dob: '1990-05-14', legalName }, files, consent: true }).expect(201);
  return r.body;
}
const submissionOf = (documentId) => models.Submission.findOne({ where: { kind: 'document', payload: { documentId } } });

let emp = 0;
async function staffWith(permissions, name = 'Rumana Akter') {
  emp += 1;
  const s = await h.signupUser({ name });
  await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'staff.write')).send({ userId: s.user.id, employeeId: `KG-R-${emp}`, permissions }).expect(201);
  return h.signInStaff(s.phone, s.user.id);
}

const sub = (id, path = '') => `${P}/admin/submissions/${id}${path}`;
const claim = (who, id) => api().post(sub(id, '/claim')).set(h.bearer(who));
const tick = (who, id, ticks = RUBRIC) => api().put(sub(id, '/ticks')).set(h.bearer(who)).send({ ticks });
let idem = 0;
const decide = (who, id, body, extra = {}) => {
  idem += 1;
  const r = api().post(sub(id, '/decide')).set(h.bearer(who)).set('Idempotency-Key', `mod-test-${idem}`);
  if (extra.stepUp) r.set('X-Step-Up', extra.stepUp);
  return r.send(body);
};
const codesOf = async (userId) => (await models.Notification.findAll({ where: { userId } })).map((n) => n.code);
/** M01 bumps the authz version when the member role moves: refresh the member's access token. */
async function settle(who = member) {
  await h.drainEvents();
  const r = await h.refreshWeb(who.cookie).expect(200);
  who.accessToken = r.body.accessToken;
  who.cookie = r.headers['set-cookie'];
}

describe('submissions and versions (FR-01 to FR-03, FR-14)', () => {
  it('each NID version is one submission; a resubmission supersedes the open one and tells its reviewer', async () => {
    const reviewer = await staffWith(['approve_documents']);
    const first = await submissionOf((await submit(member)).id);
    expect(first).toMatchObject({ kind: 'document', version: 1, status: 'pending_review', submittedBy: member.user.id, mode: 'pre' });
    expect(first.slaDueAt - first.submittedAt).toBe(24 * 3600000);
    await claim(reviewer, first.id).expect(200);

    const second = await submissionOf((await submit(member, { salt: 'v2' })).id);
    expect(second).toMatchObject({ version: 2, previousSubmissionId: first.id, subjectId: first.subjectId });
    await first.reload();
    expect(first.status).toBe('superseded');
    expect(await models.ReviewClaim.findOne({ where: { submissionId: first.id } })).toMatchObject({ releasedReason: 'superseded' });
    expect((await claim(reviewer, first.id).expect(409)).body.code).toBe('INVALID_STATE');
    await settle();
    expect(await codesOf(reviewer.userId)).toContain('MOD_CLAIM_LOST');
    // The superseded M05 item does not withdraw the M02 document twice: M02 already moved it.
    expect(await models.VerificationDocument.count({ where: { userId: member.user.id, status: 'withdrawn' } })).toBe(1);

    const mine = await api().get(`${P}/me/submissions`).set(h.bearer(member)).expect(200);
    expect(mine.body.items.map((s) => [s.version, s.status])).toEqual([[2, 'pending_review'], [1, 'superseded']]);
    // Documents are replaced by resubmitting, not withdrawn here.
    expect((await api().post(`${P}/me/submissions/${second.id}/withdraw`).set(h.bearer(member)).expect(409)).body.code).toBe('WITHDRAW_NOT_ALLOWED');
    const other = await h.signupUser({ name: 'Fahim Rahman' });
    await api().post(`${P}/me/submissions/${second.id}/withdraw`).set(h.bearer(other)).expect(404);
  });
});

describe('the claim lock (FR-07, FR-08)', () => {
  it('exactly one reviewer wins a 20-way claim race', async () => {
    const s = await submissionOf((await submit(member)).id);
    const reviewers = [];
    for (let i = 0; i < 4; i += 1) reviewers.push(await staffWith(['approve_documents'], `Reviewer ${i}`));
    const results = await Promise.all(reviewers.flatMap((r) => Array.from({ length: 5 }, () => claim(r, s.id))));
    const winners = new Set(results.filter((r) => r.status === 200).map((r) => r.body.claim.staffId));
    expect(winners.size).toBe(1);
    expect(results.filter((r) => r.status !== 200).every((r) => r.status === 409 && r.body.code === 'ALREADY_CLAIMED')).toBe(true);
    expect(await models.ReviewClaim.count({ where: { submissionId: s.id, releasedAt: null } })).toBe(1);
    const loser = reviewers.find((r) => !winners.has(r.userId));
    const again = await claim(loser, s.id).expect(409);
    expect(again.body.holder.name).toMatch(/^Reviewer \d$/);
  }, 120000);

  it('expires after its TTL; heartbeats extend it, never past the hard cap; masters can force a release', async () => {
    const s = await submissionOf((await submit(member)).id);
    const reviewer = await staffWith(['approve_documents']);
    const c = await claim(reviewer, s.id).expect(200);
    expect(c.body.claim).toMatchObject({ mine: true });
    expect(new Date(c.body.claim.hardExpiresAt) - new Date(c.body.claim.expiresAt)).toBe(90 * 60000);
    expect(await models.AuditLog.count({ where: { action: 'submission.claimed', actorId: reviewer.userId } })).toBe(1);

    const row = await models.ReviewClaim.findOne({ where: { submissionId: s.id, releasedAt: null } });
    await row.update({ hardExpiresAt: new Date(Date.now() + 5 * 60000) });
    const hb = await api().post(sub(s.id, '/heartbeat')).set(h.bearer(reviewer)).expect(200);
    expect(hb.body.expiresAt).toBe(hb.body.hardExpiresAt);
    expect((await api().post(sub(s.id, '/heartbeat')).set(h.bearer(master)).expect(403)).body.code).toBe('CLAIM_REQUIRED');

    // Ticks are stored on the server, unknown keys dropped.
    const t = await tick(reviewer, s.id, ['readable', 'readable', 'made_up']).expect(200);
    expect(t.body).toEqual({ ticks: ['readable'], missing: ['name_matches', 'not_edited', 'face_matches'] });
    expect((await api().get(sub(s.id)).set(h.bearer(reviewer)).expect(200)).body.ticks).toEqual(['readable']);

    expect(await moderation.expireClaims(new Date(Date.now() + 6 * 60000))).toEqual({ released: 1 });
    expect((await decide(reviewer, s.id, { decision: 'approve' }).expect(403)).body.code).toBe('CLAIM_REQUIRED');

    await claim(reviewer, s.id).expect(200);
    expect((await api().post(sub(s.id, '/release')).set(h.bearer(master)).send({}).expect(403)).body.code).toBe('CLAIM_REQUIRED');
    expect((await api().post(sub(s.id, '/release')).set(h.bearer(master)).send({ force: true }).expect(200)).body).toEqual({ released: true });
    expect(await models.AuditLog.findOne({ where: { action: 'submission.released_forced' } })).toMatchObject({ actorId: master.userId });
    await claim(reviewer, s.id).expect(200);
    expect((await api().post(sub(s.id, '/release')).set(h.bearer(reviewer)).send({}).expect(200)).body).toEqual({ released: true });
    expect((await api().post(sub(s.id, '/release')).set(h.bearer(reviewer)).send({}).expect(200)).body).toEqual({ released: false });
  });
});

describe('who reviews what (FR-11, FR-17)', () => {
  it('lists only permitted kinds; a forbidden kind looks absent; nobody reviews their own submission', async () => {
    const s = await submissionOf((await submit(member)).id);
    const listings = await staffWith(['approve_listings']);
    expect((await api().get(`${P}/admin/submissions`).set(h.bearer(listings)).expect(200)).body.items).toEqual([]);
    expect((await api().get(`${P}/admin/submissions/stats`).set(h.bearer(listings)).expect(200)).body).toEqual({ inQueue: 0, overdue: 0, claimedByYou: 0, decidedToday: 0 });
    await api().get(sub(s.id)).set(h.bearer(listings)).expect(404);
    await claim(listings, s.id).expect(404);
    const nobody = await staffWith(['view_payouts']);
    expect((await api().get(`${P}/admin/submissions`).set(h.bearer(nobody)).expect(403)).body.code).toBe('PERMISSION_REQUIRED');

    // A staff member's own submission (staff accounts cannot use the customer apps, so through the service).
    const reviewer = await staffWith(['approve_documents']);
    const own = await models.sequelize.transaction((transaction) =>
      moderation.submit({ kind: 'document', subjectId: '0190f3a2-0000-7000-8000-00000000abcd', payload: { documentId: '0190f3a2-0000-7000-8000-00000000abce' }, title: 'Own', submittedBy: reviewer.userId }, { transaction })
    );
    expect((await claim(reviewer, own.id).expect(403)).body.code).toBe('SELF_REVIEW_FORBIDDEN');
    const q = await api().get(`${P}/admin/submissions?claimed=none&q=national`).set(h.bearer(reviewer)).expect(200);
    expect(q.body.items.map((i) => i.id)).toEqual([s.id]);
    await claim(reviewer, s.id).expect(200);
    expect((await api().post(sub(s.id, '/decide')).set(h.bearer(reviewer)).send({ decision: 'approve' }).expect(400)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await api().get(`${P}/admin/submissions?claimed=me`).set(h.bearer(reviewer)).expect(200)).body.items.map((i) => i.id)).toEqual([s.id]);
    expect((await api().get(`${P}/admin/submissions?claimed=others`).set(h.bearer(master)).expect(200)).body.items.map((i) => i.id)).toEqual([s.id]);
    expect((await api().get(`${P}/admin/submissions/stats`).set(h.bearer(reviewer)).expect(200)).body).toMatchObject({ inQueue: 2, claimedByYou: 1 });
  });
});

describe('the master override (Q46) and reopen (FR-21)', () => {
  it('a master with step-up approves over a pending duplicate; a verified duplicate is locked', async () => {
    const other = await h.signupUser({ name: 'Someone Else' });
    const firstDoc = await submit(other, { legalName: 'Someone Else' });
    const doc = await submit(member, { salt: 'mine' });
    const s = await submissionOf(doc.id);
    const reviewer = await staffWith(['approve_documents']);
    const c = await claim(reviewer, s.id).expect(200);
    expect(c.body.checks.find((k) => k.key === 'nid_pending_elsewhere')).toMatchObject({ severity: 'hard', result: 'fail' });
    await tick(reviewer, s.id).expect(200);
    expect((await decide(reviewer, s.id, { decision: 'approve' }).expect(422)).body).toMatchObject({ code: 'CHECK_FAILED', failing: ['nid_pending_elsewhere'] });
    expect((await decide(reviewer, s.id, { decision: 'approve', override: 'Holder confirmed by phone' }).expect(403)).body.code).toBe('STEP_UP_REQUIRED');
    expect((await decide(reviewer, s.id, { decision: 'approve', override: 'Holder confirmed by phone' }, { stepUp: await h.stepUp(reviewer, 'moderation.override') }).expect(403)).body.code).toBe(
      'MASTER_REQUIRED'
    );
    await api().post(sub(s.id, '/release')).set(h.bearer(reviewer)).send({}).expect(200);

    await claim(master, s.id).expect(200);
    await tick(master, s.id).expect(200);
    const ok = await decide(master, s.id, { decision: 'approve', override: 'Holder confirmed by phone' }, { stepUp: await h.stepUp(master, 'moderation.override') }).expect(200);
    expect(ok.body).toMatchObject({ status: 'approved', override: { by: 'Ayesha Siddiqua', reason: 'Holder confirmed by phone' }, rubricResult: RUBRIC.map((k) => ({ itemKey: k, ticked: true })) });
    expect(await models.AuditLog.findOne({ where: { action: 'submission.check_overridden' } })).toMatchObject({ severity: 'critical', reason: 'Holder confirmed by phone', actorId: master.userId });
    expect((await models.OutboxEvent.findOne({ where: { name: 'submission.approved' } })).payload).toMatchObject({ overridden: true, decidedBy: master.userId });
    await settle();
    expect((await models.UserRole.findOne({ where: { userId: member.user.id, role: 'member' } })).status).toBe('active');
    expect((await models.Submission.findByPk(s.id)).appliedAt).toBeTruthy();

    // The other account's NID is now verified elsewhere: nid_unique fails on the re-run and cannot be overridden.
    const theirs = await submissionOf(firstDoc.id);
    const again = await claim(master, theirs.id).expect(200);
    expect(again.body.checks.find((k) => k.key === 'nid_unique')).toMatchObject({ result: 'fail', detail: 'Verified on 1 other account(s)' });
    await tick(master, theirs.id).expect(200);
    expect((await decide(master, theirs.id, { decision: 'approve', override: 'Try anyway' }, { stepUp: await h.stepUp(master, 'moderation.override') }).expect(422)).body).toMatchObject({
      code: 'CHECK_LOCKED',
      failing: ['nid_unique'],
    });
    await decide(master, theirs.id, { decision: 'reject', reasonCode: 'duplicate' }).expect(200);
  });

  it('a master with step-up reopens a decision; it goes back to the queue and can be decided again', async () => {
    const doc = await submit(member);
    const s = await submissionOf(doc.id);
    await claim(master, s.id).expect(200);
    await decide(master, s.id, { decision: 'reject', reasonCode: 'other' }).expect(422);
    await decide(master, s.id, { decision: 'reject', reasonCode: 'other', reasonText: 'Not a National ID card' }).expect(200);
    await settle();
    expect(await models.VerificationDocument.findByPk(doc.id)).toMatchObject({ status: 'rejected', reasonCode: 'other', reasonText: 'Not a National ID card' });
    expect((await models.UserRole.findOne({ where: { userId: member.user.id, role: 'member' } })).status).toBe('rejected');
    expect((await api().get(`${P}/me/submissions`).set(h.bearer(member)).expect(200)).body.items[0]).toMatchObject({ status: 'rejected', reasonText: 'Not a National ID card' });

    const reviewer = await staffWith(['approve_documents']);
    await api().post(sub(s.id, '/reopen')).set(h.bearer(reviewer)).send({ reason: 'Wrong call' }).expect(403);
    await api().post(sub(s.id, '/reopen')).set(h.bearer(master)).send({ reason: 'Wrong call' }).expect(403);
    const re = await api().post(sub(s.id, '/reopen')).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'moderation.override')).send({ reason: 'It is a National ID' }).expect(200);
    expect(re.body).toMatchObject({ status: 'pending_review', reasonCode: null, decidedAt: null });
    expect(await models.AuditLog.findOne({ where: { action: 'submission.reopened' } })).toMatchObject({ severity: 'critical', reason: 'It is a National ID' });
    expect((await api().post(sub(s.id, '/reopen')).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'moderation.override')).send({ reason: 'Again' }).expect(409)).body.code).toBe('INVALID_STATE');

    await claim(reviewer, s.id).expect(200);
    await tick(reviewer, s.id).expect(200);
    await decide(reviewer, s.id, { decision: 'approve' }).expect(200);
    await settle();
    expect(await models.VerificationDocument.findByPk(doc.id)).toMatchObject({ status: 'approved', reasonCode: null, reasonText: null });
    expect((await models.UserRole.findOne({ where: { userId: member.user.id, role: 'member' } })).status).toBe('active');
    expect((await api().get(`${P}/admin/submissions/stats`).set(h.bearer(reviewer)).expect(200)).body).toMatchObject({ inQueue: 0, decidedToday: 1 });
    const decided = await api().get(`${P}/admin/submissions?status=approved`).set(h.bearer(reviewer)).expect(200);
    expect(decided.body.items[0]).toMatchObject({ id: s.id, decidedBy: { id: reviewer.userId }, sla: null });
  });
});

describe('jobs (FR-13, FR-18) and sanctions', () => {
  it('the watchdog republishes an unapplied approval, then alerts the masters', async () => {
    const s = await submissionOf((await submit(member)).id);
    await claim(master, s.id).expect(200);
    await tick(master, s.id).expect(200);
    await decide(master, s.id, { decision: 'approve' }).expect(200);
    // The subject module has not applied it yet (the consumers have not run).
    const later = (min) => new Date(Date.now() + min * 60000);
    expect(await moderation.watchApplies(later(1))).toEqual({ resent: 0, failed: 0 });
    let t = 6;
    for (let i = 1; i <= 5; i += 1) {
      expect(await moderation.watchApplies(later(t))).toEqual({ resent: 1, failed: 0 });
      t += 6;
    }
    expect(await moderation.watchApplies(later(t))).toEqual({ resent: 0, failed: 1 });
    expect(await moderation.watchApplies(later(t + 6))).toEqual({ resent: 0, failed: 0 });
    expect(await models.OutboxEvent.count({ where: { name: 'submission.approved' } })).toBe(6);
    await h.drainEvents();
    expect(await codesOf(master.userId)).toContain('MOD_APPLY_FAILED');
    // Every redelivery was applied idempotently: one approval, one acknowledgement recorded.
    expect(await models.AuditLog.count({ where: { action: 'document.approved' } })).toBe(1);
    expect((await models.Submission.findByPk(s.id)).appliedAt).toBeTruthy();
  });

  it('reports an overdue item once, to its reviewers and the masters', async () => {
    const s = await submissionOf((await submit(member)).id);
    const reviewer = await staffWith(['approve_documents']);
    const listings = await staffWith(['approve_listings']);
    await claim(reviewer, s.id).expect(200);
    const late = new Date(s.slaDueAt.getTime() + 2 * 3600000);
    expect(await moderation.reportBreaches(new Date())).toEqual({ breached: 0 });
    expect(await moderation.reportBreaches(late)).toEqual({ breached: 1 });
    expect(await moderation.reportBreaches(late)).toEqual({ breached: 0 });
    expect((await models.OutboxEvent.findOne({ where: { name: 'submission.sla_breached' } })).payload).toMatchObject({ overdueMinutes: 120, claimedBy: reviewer.userId });
    await h.drainEvents();
    expect(await codesOf(reviewer.userId)).toContain('MOD_SLA_BREACH');
    expect(await codesOf(master.userId)).toContain('MOD_SLA_BREACH');
    expect(await codesOf(listings.userId)).not.toContain('MOD_SLA_BREACH');
  });

  it('suspending a member withdraws their open submissions and the document', async () => {
    const doc = await submit(member);
    const s = await submissionOf(doc.id);
    await api()
      .post(`${P}/admin/users/${member.user.id}/suspend`)
      .set(h.bearer(master))
      .send({ reasonCode: 'abuse', note: 'Abusive messages to ground owners' })
      .expect(200);
    await h.drainEvents();
    expect(await models.Submission.findByPk(s.id)).toMatchObject({ status: 'withdrawn' });
    expect(await models.VerificationDocument.findByPk(doc.id)).toMatchObject({ status: 'withdrawn', isCurrent: false });
    expect(await models.AuditLog.findOne({ where: { action: 'submission.withdrawn' } })).toMatchObject({ actorType: 'system' });
  });

  it('M05 events carry ids and codes only', async () => {
    const s = await submissionOf((await submit(member)).id);
    await claim(master, s.id).expect(200);
    await decide(master, s.id, { decision: 'reject', reasonCode: 'breaks_rules' }).expect(200);
    const rows = await models.OutboxEvent.findAll({ where: { aggregateType: 'submission' } });
    expect(rows.map((r) => r.name).sort()).toEqual(['submission.created', 'submission.rejected']);
    const text = JSON.stringify(rows.map((r) => r.payload));
    for (const pii of [NID, 'Nusrat', '1990-05-14']) expect(text).not.toContain(pii);
  });
});
