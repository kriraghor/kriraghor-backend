'use strict';

/**
 * Builds postman/kriraghor-moderation.postman_collection.json (M05 Moderation lite on the `document`
 * kind). node postman/build-collection-m05.js
 *
 * Variables: adminAccessToken (master A), adminAccessToken2 (reviewer B: approve_documents only),
 * stepUpQueueA (moderation.override), member1Id, member2Id. The runner submits both members' NIDs.
 * Unattended: `node postman/run-m05.js` (kriraghor_test database, worker loop next to the API).
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-moderation.postman_collection.json');

const RUBRIC = ['name_matches', 'readable', 'not_edited', 'face_matches'];
const idem = (item) => {
  item.request.header.push({ key: 'Idempotency-Key', value: 'pm-{{$guid}}' });
  return item;
};
const reviewer = (name, method, p, opts = {}) => req(name, method, p, { ...opts, as: 'B' });

const collection = {
  info: {
    name: 'Kriraghor API: M05 Moderation',
    description: [
      'Two members have submitted their NID. Reviewer B (approve_documents) works the queue: claims the first (master A is told who holds it), keeps the lock with a heartbeat, ticks the rubric on the server and approves; claims the second and rejects it with a reason. Master A reopens the rejection with step-up moderation.override (critical audit) and approves it. Both members end up active.',
      'Unattended: `node postman/run-m05.js` (uses the kriraghor_test database).',
      'Rebuild this file with: node postman/build-collection-m05.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    ['baseUrl', 'http://localhost:4000/api/v1'],
    ['adminAccessToken', ''],
    ['adminAccessToken2', ''],
    ['stepUpQueueA', ''],
    ['member1Id', ''],
    ['member2Id', ''],
    ['sub1', ''],
    ['sub2', ''],
  ].map(([key, value]) => ({ key, value })),
  item: [
    {
      name: '0. Guards',
      item: [
        req('Queue without a token (expect 401)', 'GET', '/admin/submissions', { as: false, expect: { status: 401 } }),
        req('My submissions without a token (expect 401)', 'GET', '/me/submissions', { as: false, expect: { status: 401 } }),
      ],
    },
    {
      name: '1. Queue and claim',
      item: [
        reviewer('Queue (oldest deadline first)', 'GET', '/admin/submissions', {
          expect: { status: 200 },
          save: { sub1: 'items.0.id', sub2: 'items.1.id' },
          checks: [
            ['two documents waiting', "j.items.length === 2 && j.items.every((i) => i.kind === 'document' && i.status === 'pending_review' && i.sla === 'ok' && i.claim === null)"],
            ['member 1 first', "j.items[0].submittedBy.id === pm.variables.get('member1Id')"],
          ],
        }),
        reviewer('Desk KPIs', 'GET', '/admin/submissions/stats', { expect: { status: 200 }, checks: [['2 in the queue', 'j.inQueue === 2 && j.overdue === 0 && j.claimedByYou === 0']] }),
        reviewer('Detail', 'GET', '/admin/submissions/{{sub1}}', {
          expect: { status: 200 },
          checks: [
            ['masked payload, checks, rubric, reasons', "j.payload.numberMasked.startsWith('•••• ') && j.checks.length === 6 && j.rubric.items.length === 4 && j.reasons.every((r) => r.code !== 'price_wrong')"],
            ['no lock yet, no ticks', 'j.claim === null && j.ticks.length === 0'],
          ],
        }),
        reviewer('Claim', 'POST', '/admin/submissions/{{sub1}}/claim', {
          expect: { status: 200 },
          checks: [['mine, 30 min lock, 2 h cap', 'j.claim.mine === true && (new Date(j.claim.hardExpiresAt) - new Date(j.claim.expiresAt)) === 90 * 60000']],
        }),
        req('Master claims the same item (expect 409)', 'POST', '/admin/submissions/{{sub1}}/claim', {
          expect: { status: 409, code: 'ALREADY_CLAIMED' },
          checks: [['names the holder', "j.holder && j.holder.name === 'Rumana Akter'"]],
        }),
        reviewer('Heartbeat', 'POST', '/admin/submissions/{{sub1}}/heartbeat', { expect: { status: 200 }, checks: [['extended, capped', 'new Date(j.expiresAt) <= new Date(j.hardExpiresAt)']] }),
      ],
    },
    {
      name: '2. Rubric and approve',
      item: [
        reviewer('Tick two items', 'PUT', '/admin/submissions/{{sub1}}/ticks', {
          body: { ticks: ['name_matches', 'readable', 'not_a_rubric_item'] },
          expect: { status: 200 },
          checks: [['unknown keys dropped, two missing', "j.ticks.length === 2 && j.missing.join() === 'not_edited,face_matches'"]],
        }),
        idem(reviewer('Approve with ticks missing (expect 422)', 'POST', '/admin/submissions/{{sub1}}/decide', { body: { decision: 'approve' }, expect: { status: 422, code: 'RUBRIC_INCOMPLETE' } })),
        reviewer('Tick the whole rubric', 'PUT', '/admin/submissions/{{sub1}}/ticks', { body: { ticks: RUBRIC }, expect: { status: 200 }, checks: [['nothing missing', 'j.missing.length === 0']] }),
        idem(
          reviewer('Approve', 'POST', '/admin/submissions/{{sub1}}/decide', {
            body: { decision: 'approve' },
            expect: { status: 200 },
            checks: [['approved, lock released, rubric recorded', "j.status === 'approved' && j.claim === null && j.rubricResult.length === 4 && j.decidedBy.name === 'Rumana Akter'"]],
          })
        ),
      ],
    },
    {
      name: '3. Reasons and reject',
      item: [
        reviewer('Claim the second', 'POST', '/admin/submissions/{{sub2}}/claim', { expect: { status: 200 } }),
        idem(reviewer('Reject without a reason (expect 422)', 'POST', '/admin/submissions/{{sub2}}/decide', { body: { decision: 'reject' }, expect: { status: 422, code: 'REASON_REQUIRED' } })),
        idem(
          reviewer('Reject with a listing reason (expect 422)', 'POST', '/admin/submissions/{{sub2}}/decide', {
            body: { decision: 'reject', reasonCode: 'price_wrong' },
            expect: { status: 422, code: 'REASON_NOT_ALLOWED_FOR_KIND' },
          })
        ),
        idem(reviewer('Reject as "other" without text (expect 422)', 'POST', '/admin/submissions/{{sub2}}/decide', { body: { decision: 'reject', reasonCode: 'other' }, expect: { status: 422, code: 'REASON_REQUIRED' } })),
        idem(
          reviewer('Reject', 'POST', '/admin/submissions/{{sub2}}/decide', {
            body: { decision: 'reject', reasonCode: 'other', reasonText: 'Postman: not a National ID card' },
            expect: { status: 200 },
            checks: [['rejected with the reason', "j.status === 'rejected' && j.reasonCode === 'other' && j.reasonText === 'Postman: not a National ID card'"]],
          })
        ),
      ],
    },
    {
      name: '4. Master reopens (FR-21) and approves',
      item: [
        reviewer('Reviewer reopens (expect 403)', 'POST', '/admin/submissions/{{sub2}}/reopen', { body: { reason: 'Second look' }, expect: { status: 403, code: 'MASTER_REQUIRED' } }),
        req('Reopen without step-up (expect 403)', 'POST', '/admin/submissions/{{sub2}}/reopen', { body: { reason: 'Second look' }, expect: { status: 403, code: 'STEP_UP_REQUIRED' } }),
        req('Reopen with step-up', 'POST', '/admin/submissions/{{sub2}}/reopen', {
          stepUp: true,
          body: { reason: 'Postman: it is a National ID, the photo was dark' },
          expect: { status: 200 },
          checks: [['back in the queue', "j.status === 'pending_review' && j.reasonCode === null && j.decidedAt === null"]],
        }),
        req('Claim', 'POST', '/admin/submissions/{{sub2}}/claim', { expect: { status: 200 } }),
        req('Tick the whole rubric', 'PUT', '/admin/submissions/{{sub2}}/ticks', { body: { ticks: RUBRIC }, expect: { status: 200 } }),
        idem(req('Approve', 'POST', '/admin/submissions/{{sub2}}/decide', { body: { decision: 'approve' }, expect: { status: 200 }, checks: [['approved', "j.status === 'approved'"]] })),
      ],
    },
    {
      name: '5. Applied by M02 and M01; audited',
      item: [
        req('Member 1 is active', 'GET', '/admin/users/{{member1Id}}', {
          waitMs: 2500,
          expect: { status: 200 },
          checks: [['KYC verified, member active', "j.kycStatus === 'verified' && j.roles.some((r) => r.role === 'member' && r.status === 'active')"]],
        }),
        req('Member 2 is active after the reopened approval', 'GET', '/admin/users/{{member2Id}}', {
          expect: { status: 200 },
          checks: [['KYC verified, member active', "j.kycStatus === 'verified' && j.roles.some((r) => r.role === 'member' && r.status === 'active')"]],
        }),
        req('Applied (submission.applied)', 'GET', '/admin/submissions/{{sub2}}', {
          expect: { status: 200 },
          checks: [['applied, one version', "j.appliedAt !== null && j.history.length === 1 && j.history[0].status === 'approved'"]],
        }),
        req('Desk KPIs', 'GET', '/admin/submissions/stats', { expect: { status: 200 }, checks: [['queue empty, both decided today', 'j.inQueue === 0 && j.decidedToday === 2']] }),
        req('Audit: decisions, the critical reopen', 'GET', '/admin/audit-logs?action=submission.decided,submission.reopened', {
          expect: { status: 200 },
          checks: [['3 decisions, reopen critical', "j.items.filter((i) => i.action === 'submission.decided').length === 3 && j.items.some((i) => i.action === 'submission.reopened' && i.severity === 'critical')"]],
        }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
const count = collection.item.reduce((n, f) => n + f.item.length, 0);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)} (${count} requests)`);
