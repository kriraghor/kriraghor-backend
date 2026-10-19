'use strict';

/**
 * Demo accounts: two staff (a master who drafts Kriraghor's own events and a reviewer for the
 * four-eyes Moderation desk), and members who sign up with a phone, pass NID verification and get
 * their business roles through the real M01/M02/M05 flow.
 *
 * The staff accounts have no phone, email, password or Google link, so nobody can ever sign in as
 * them; the seeder acts for them with sessions it mints in-process.
 */
const crypto = require('crypto');
const rt = require('../runtime');
const { subjectIdFor } = require('../../../src/modules/kyc/kyc.moderation');
const tokens = require('../../../src/modules/auth/token.service');

const { models } = rt;
const REVIEWER_PERMISSIONS = ['approve_listings', 'approve_documents', 'manage_esports', 'enter_results', 'manage_organisers', 'resolve_reports'];

/** +8801300000001 … the demo phone block. */
const phoneOf = (n) => `+8801300${String(n).padStart(6, '0')}`;
/** A 17-digit NID with district code 99 (no real NID has it). */
const nidOf = (n) => ({ year: 1985 + (n % 15), number: `${1985 + (n % 15)}99${String(n).padStart(11, '0')}` });
/** A tiny JPEG stand-in for an ID scan (magic bytes plus a unique tail, as the tests do). */
const scan = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`demo ${tag} ${crypto.randomUUID()}`)]);

// ---------------------------------------------------------------- staff

async function staffUser(label, username, displayName) {
  const id = await rt.marked('staff', label);
  if (id) return models.User.findByPk(id);
  const user = await models.User.create({ username, displayName });
  await rt.mark('staff', user.id, label);
  return user;
}

async function staff() {
  const masterUser = await staffUser('master', 'kriraghor.events', 'Kriraghor Events');
  for (const role of ['member', 'staff', 'master_admin']) {
    const row = await models.UserRole.findOne({ where: { userId: masterUser.id, role } });
    if (!row) await models.UserRole.create({ userId: masterUser.id, role, status: 'active', activatedAt: new Date() });
  }
  if (!(await models.StaffMember.findOne({ where: { userId: masterUser.id } }))) {
    await models.StaffMember.create({ userId: masterUser.id, employeeId: 'KG-DEMO-M', team: 'Events', isMaster: true });
  }
  const master = await rt.actor(masterUser, { staff: true });

  const reviewerUser = await staffUser('reviewer', 'kriraghor.review', 'Kriraghor Review Desk');
  if (!(await models.StaffMember.findOne({ where: { userId: reviewerUser.id } }))) {
    await rt.post(master, '/admin/staff', { userId: reviewerUser.id, employeeId: 'KG-DEMO-R', team: 'Moderation', permissions: REVIEWER_PERMISSIONS }, { headers: { 'X-Step-Up': await rt.stepUp(master, 'staff.write') } });
  }
  const reviewer = await rt.actor(reviewerUser, { staff: true });
  return { master, reviewer };
}

// ---------------------------------------------------------------- moderation

/** Claim, tick every rubric item and approve the open submission of a subject (M05). */
async function review(reviewer, kind, subjectId) {
  await rt.drain();
  const sub = await models.Submission.findOne({ where: { kind, subjectId, status: 'pending_review' } });
  if (!sub) {
    // Approved by an earlier run that stopped before the decision was applied: applying it is enough.
    if (await models.Submission.findOne({ where: { kind, subjectId, status: 'approved' } })) return rt.drain();
    throw new Error(`no open ${kind} submission for ${subjectId}`);
  }
  await rt.post(reviewer, `/admin/submissions/${sub.id}/claim`);
  const rubric = await models.ReviewRubric.findByPk(sub.rubricId);
  await rt.put(reviewer, `/admin/submissions/${sub.id}/ticks`, { ticks: rubric.items.map((i) => i.key) });
  await rt.post(reviewer, `/admin/submissions/${sub.id}/decide`, { decision: 'approve' }, { idem: true });
  await rt.drain();
}

// ---------------------------------------------------------------- members

/** A member signed up with a demo phone (and username), or the one from an earlier run. */
async function member(n, displayName, { username } = {}) {
  const phone = phoneOf(n);
  let user = await models.User.findOne({ where: { phone } });
  if (!user) {
    // The signup service itself (the route adds a per-IP limit meant for the public internet).
    const { token } = tokens.signSpecial('signup', { idt: 'phone', idv: phone }, 'signup');
    await require('../../../src/modules/auth/auth.service').signup({ signupToken: token, displayName, ...(username ? { username } : {}) });
    user = await models.User.findOne({ where: { phone } });
  }
  await rt.mark('user', user.id, `p${n}`);
  const a = await rt.actor(user);
  a.n = n;
  a.name = displayName;
  return a;
}

/** NID verification (M02): front, back and selfie, approved on the document desk. Makes the member role active. */
async function verifyNid(a, reviewer) {
  const user = await models.User.findByPk(a.userId);
  if (user.kycStatus === 'verified') return a;
  const pending = await models.VerificationDocument.findOne({ where: { userId: a.userId, docType: 'nid', status: 'in_review' } });
  if (!pending) {
    const files = {};
    for (const slot of ['front', 'back', 'selfie']) {
      files[slot] = (await rt.post(a, `/me/documents/files?slot=${slot}&docType=nid`, undefined, { raw: scan(`${slot} ${a.n}`), contentType: 'image/jpeg' })).fileId;
    }
    const nid = nidOf(a.n);
    await rt.post(a, '/me/documents', { docType: 'nid', fields: { number: nid.number, dob: `${nid.year}-03-14`, legalName: a.name }, files, consent: true });
  }
  await review(reviewer, 'document', subjectIdFor(a.userId, 'nid'));
  return a;
}

const future = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const DOCS = {
  ground_owner: (a) => [
    ['trade_license', { number: `TL-DEMO-${a.n}-2026`, holderName: a.name, expiresOn: future(400) }],
    ['deed_or_lease', { kind: 'lease', expiresOn: future(900) }],
  ],
  gym_owner: (a) => [
    ['trade_license', { number: `TL-DEMO-${a.n}-2026`, holderName: a.name, expiresOn: future(400) }],
    ['deed_or_lease', { kind: 'lease', expiresOn: future(900) }],
  ],
  shop_owner: (a) => [
    ['trade_license', { number: `TL-DEMO-${a.n}-2026`, holderName: a.name, expiresOn: future(400) }],
    ['tin', { number: String(990000000000 + a.n) }],
  ],
  organiser: (a) => [['org_registration', { kind: 'society', number: `SOC-DEMO-${a.n}`, holderName: 'Mirpur Sports Club' }]],
};

async function sendDoc(a, docType, fields, role) {
  const up = await rt.post(a, `/me/documents/files?slot=document&docType=${docType}`, undefined, { raw: scan(`${docType} ${a.n}`), contentType: 'image/jpeg' });
  await rt.post(a, '/me/documents', { docType, fields, files: { document: up.fileId }, consent: true, ...(role ? { role } : {}) });
}

const roleStatus = async (userId, role) => (await models.UserRole.findOne({ where: { userId, role } }))?.status ?? null;

/** Apply for a business role and get its documents approved (M01 role, M02 documents). */
async function businessRole(a, role, reviewer) {
  if ((await roleStatus(a.userId, role)) === 'active') return a;
  if (!(await roleStatus(a.userId, role))) await rt.post(a, '/me/roles', { role });
  for (const [docType, fields] of DOCS[role](a)) {
    const subject = subjectIdFor(a.userId, docType, role);
    const open = await models.Submission.findOne({ where: { kind: 'document', subjectId: subject, status: 'pending_review' } });
    const done = await models.Submission.findOne({ where: { kind: 'document', subjectId: subject, status: 'approved' } });
    if (done) continue;
    if (!open) await sendDoc(a, docType, fields);
    await review(reviewer, 'document', subject);
  }
  return a;
}

/** A player or pro with a credential for a hire role, where the role needs one (M11). */
async function hireRole(a, { platformRole = 'pro', roleKey, credential }, reviewer) {
  if (!(await roleStatus(a.userId, platformRole))) await rt.post(a, '/me/roles', { role: platformRole });
  if (!credential) return a;
  const subject = subjectIdFor(a.userId, 'credential', `hire:${roleKey}`);
  if (await models.Submission.findOne({ where: { kind: 'document', subjectId: subject, status: 'approved' } })) return a;
  if (!(await models.Submission.findOne({ where: { kind: 'document', subjectId: subject, status: 'pending_review' } }))) {
    const issuer = roleKey.startsWith('cricket') ? 'Bangladesh Cricket Board' : roleKey.startsWith('football') ? 'Bangladesh Football Federation' : 'Bangladesh Sports Medicine Society';
    const up = await rt.post(a, '/me/documents/files?slot=document&docType=credential', undefined, { raw: scan(`credential ${a.n}`), contentType: 'image/jpeg' });
    await rt.post(a, '/me/documents', { docType: 'credential', fields: { hireRole: roleKey, level: credential, issuer, number: `DEMO-${a.n}-${roleKey}`.slice(0, 40) }, files: { document: up.fileId }, consent: true, role: platformRole });
  }
  await review(reviewer, 'document', subject);
  return a;
}

module.exports = { phoneOf, staff, review, member, verifyNid, businessRole, hireRole, REVIEWER_PERMISSIONS };
