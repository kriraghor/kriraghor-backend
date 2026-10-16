'use strict';

/**
 * Builds postman/kriraghor-kyc.postman_collection.json (M02 KYC lite: "A KYC document is approved",
 * the last part of the Phase 2 exit check). node postman/build-collection-m02.js
 *
 * Variables: adminAccessToken (master), accessToken (the member), memberId.
 * Unattended: `node postman/run-m02.js` signs them in and runs the collection with
 * --working-dir postman/fixtures (the test images it uploads) and a worker loop next to the API.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-kyc.postman_collection.json');

/** Requests as the member (customer token). */
const member = (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: 'Bearer {{accessToken}}' });
  return r;
};
/** A raw file upload (the body is the file itself, from the working directory). */
const upload = (name, slot, file, mime, opts) => {
  const r = member(name, 'POST', `/me/documents/files?slot=${slot}`, opts);
  r.request.header.push({ key: 'Content-Type', value: mime });
  r.request.body = { mode: 'file', file: { src: file } };
  return r;
};

const RUBRIC = { nameMatches: true, readable: true, notExpired: true };

const collection = {
  info: {
    name: 'Kriraghor API: M02 KYC',
    description: [
      'A member uploads the NID front, back and a selfie, then submits the number, date of birth and legal name; the master reviews it on the KYC desk (masked data, an audited file view, an audited 60-second reveal) and approves it with the full rubric; the member role becomes active and the identity fields are copied to the account.',
      'Unattended: `node postman/run-m02.js` (kriraghor_test database; fixtures in postman/fixtures).',
      'Rebuild this file with: node postman/build-collection-m02.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    ['baseUrl', 'http://localhost:4000/api/v1'],
    ['adminAccessToken', ''],
    ['accessToken', ''],
    ['memberId', ''],
    ['frontId', ''],
    ['backId', ''],
    ['selfieId', ''],
    ['documentId', ''],
  ].map(([key, value]) => ({ key, value })),
  item: [
    {
      name: '0. Guards',
      item: [
        req('Checklist without a token (expect 401)', 'GET', '/me/verification', { as: false, expect: { status: 401 } }),
        upload('Upload a GIF (expect 415)', 'front', 'not-allowed.gif', 'image/gif', { expect: { status: 415, code: 'FILE_TYPE_NOT_ALLOWED' } }),
        upload('Upload a PNG labelled JPEG (expect 415)', 'front', 'nid-back.png', 'image/jpeg', { expect: { status: 415, code: 'FILE_TYPE_MISMATCH' } }),
        member('Gate: withdraw winnings before KYC', 'GET', '/me/gate?action=withdraw_winnings', {
          expect: { status: 200 },
          checks: [['needs KYC', "j.allowed === false && j.code === 'KYC_REQUIRED' && j.next === '/account/verification'"]],
        }),
      ],
    },
    {
      name: '1. Member submits the NID',
      item: [
        member('Member checklist', 'GET', '/me/verification', {
          expect: { status: 200 },
          checks: [['phone done, NID missing', "j.badge === 'verification_needed' && j.items[0].status === 'approved' && j.items[1].status === 'missing'"]],
        }),
        upload('Upload the NID front (JPEG)', 'front', 'nid-front.jpg', 'image/jpeg', { expect: { status: 201 }, save: { frontId: 'fileId' } }),
        upload('Upload the NID back (PNG)', 'back', 'nid-back.png', 'image/png', { expect: { status: 201 }, save: { backId: 'fileId' } }),
        upload('Upload the selfie (PDF)', 'selfie', 'nid-selfie.pdf', 'application/pdf', { expect: { status: 201 }, save: { selfieId: 'fileId' } }),
        member('Submit with a wrong NID number (expect 422)', 'POST', '/me/documents', {
          body: { docType: 'nid', fields: { legalName: 'Nusrat Jahan', number: '12345678901', dob: '1990-05-14' }, files: { front: '{{frontId}}', back: '{{backId}}', selfie: '{{selfieId}}' }, consent: true },
          expect: { status: 422, code: 'NID_FORMAT_INVALID' },
        }),
        member('Submit the NID', 'POST', '/me/documents', {
          body: { docType: 'nid', fields: { legalName: 'Nusrat Jahan', number: '1990 1234 5678 9012 3', dob: '1990-05-14' }, files: { front: '{{frontId}}', back: '{{backId}}', selfie: '{{selfieId}}' }, consent: true },
          expect: { status: 201 },
          save: { documentId: 'id' },
          checks: [['in review, masked', "j.status === 'in_review' && j.numberMasked === '•••• 0123' && !JSON.stringify(j).includes('19901234567890123')"]],
        }),
      ],
    },
    {
      name: '2. KYC desk',
      item: [
        req('Queue', 'GET', '/admin/kyc/documents', {
          expect: { status: 200 },
          checks: [['one waiting, masked, checks passed', "j.items.length === 1 && j.items[0].id === pm.collectionVariables.get('documentId') && j.items[0].failedChecks.length === 0 && !JSON.stringify(j).includes('19901234567890123')"]],
        }),
        req('Review panel', 'GET', '/admin/kyc/documents/{{documentId}}', {
          expect: { status: 200 },
          checks: [['legal name and DOB, number masked', "j.fields.legalName === 'Nusrat Jahan' && j.fields.dob === '1990-05-14' && j.fields.numberMasked === '•••• 0123' && j.files.length === 3"]],
        }),
        req('View the front (audited)', 'GET', '/admin/kyc/documents/{{documentId}}/files/{{frontId}}', {
          expect: { status: 200 },
          checks: [['inline JPEG, no-store', "pm.response.headers.get('Content-Type') === 'image/jpeg' && pm.response.headers.get('Cache-Control') === 'no-store'"]],
        }),
        req('Reveal without a reason (expect 422)', 'POST', '/admin/kyc/documents/{{documentId}}/reveal-nid', { body: {}, expect: { status: 422, code: 'VALIDATION_FAILED' } }),
        req('Reveal the number with a reason', 'POST', '/admin/kyc/documents/{{documentId}}/reveal-nid', {
          body: { reason: 'Postman: number partly hidden by glare' },
          expect: { status: 200 },
          checks: [['full number for 60 s', "j.normalised === '19901234567890123' && j.showForSeconds === 60"]],
        }),
        req('Approve without the rubric (expect 422)', 'POST', '/admin/kyc/documents/{{documentId}}/decide', { body: { decision: 'approve' }, expect: { status: 422, code: 'RUBRIC_INCOMPLETE' } }),
        req('Approve with the full rubric', 'POST', '/admin/kyc/documents/{{documentId}}/decide', {
          body: { decision: 'approve', rubric: RUBRIC },
          expect: { status: 200 },
          checks: [['approved', "j.status === 'approved'"]],
        }),
        req('Audit: one file view and the critical reveal', 'GET', '/admin/audit-logs?action=document.file_viewed,document.nid_revealed', {
          expect: { status: 200 },
          checks: [['two rows, reveal critical', "j.items.length === 2 && j.items.some((i) => i.action === 'document.nid_revealed' && i.severity === 'critical')"]],
        }),
      ],
    },
    {
      name: '3. The member is verified',
      item: [
        req('Member role active, identity copied (M01)', 'GET', '/admin/users/{{memberId}}', {
          waitMs: 2500,
          expect: { status: 200 },
          checks: [['KYC verified, member active, NID last 4', "j.kycStatus === 'verified' && j.roles.some((r) => r.role === 'member' && r.status === 'active') && j.nidLast4 === '0123'"]],
        }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
const count = collection.item.reduce((n, f) => n + f.item.length, 0);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)} (${count} requests)`);
