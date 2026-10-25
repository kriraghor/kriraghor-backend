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
const { req, CONSENT, consentVar } = require('./lib');

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

const RUBRIC = ['name_matches', 'readable', 'not_edited', 'face_matches'];
const idem = (item) => {
  item.request.header.push({ key: 'Idempotency-Key', value: 'pm-{{$guid}}' });
  return item;
};

/**
 * Pre-request: under18Dob = today's Dhaka date 18 years ago plus one day, so the member turns 18
 * tomorrow (§6.3 age_ok, 18 and over since 25 Oct 2026).
 */
const under18 = (item) => {
  item.event.unshift({
    listen: 'prerequest',
    script: {
      type: 'text/javascript',
      exec: [
        'const d = new Date(Date.now() + 6 * 3600000);',
        'const b = new Date(Date.UTC(d.getUTCFullYear() - 18, d.getUTCMonth(), d.getUTCDate() + 1));',
        "pm.collectionVariables.set('under18Dob', b.toISOString().slice(0, 10));",
      ],
    },
  });
  return item;
};

const collection = {
  info: {
    name: 'Kriraghor API: M02 KYC',
    description: [
      'A member uploads the NID front, back and a selfie, then submits the number, date of birth and legal name; the master claims it on the M05 Moderation desk, reads the document panel (masked data, an audited file view, an audited 60-second reveal), ticks the rubric and approves it; the member role becomes active and the identity fields are copied to the account.',
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
    ['submissionId', ''],
    ['under18Dob', ''],
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
          save: { consentVersion: 'consent.version' },
          checks: [
            ['phone done, NID missing', "j.badge === 'verification_needed' && j.items[0].status === 'approved' && j.items[1].status === 'missing'"],
            // M02-FR-05, FR-17, FR-18 (25 Oct 2026): the consent text with the retention days and the minimum age filled in.
            ['consent text and minimum age', "Number.isInteger(j.consent.version) && j.consent.draft === true && j.consent.text.startsWith('I agree that Kriraghor uses these documents') && j.consent.text.includes('90 days') && j.consent.text.includes('aged 18 and over') && j.minAgeYears === 18"],
          ],
        }),
        member('Member checklist in Bangla', 'GET', '/me/verification?locale=bn', {
          expect: { status: 200 },
          checks: [['Bangla consent with Bangla digits', "j.consent.text.includes('৯০ দিন') && j.consent.text.includes('১৮ বছর') && j.consent.version === Number(pm.collectionVariables.get('consentVersion'))"]],
        }),
        upload('Upload the NID front (JPEG)', 'front', 'nid-front.jpg', 'image/jpeg', { expect: { status: 201 }, save: { frontId: 'fileId' } }),
        upload('Upload the NID back (PNG)', 'back', 'nid-back.png', 'image/png', { expect: { status: 201 }, save: { backId: 'fileId' } }),
        upload('Upload the selfie (PDF)', 'selfie', 'nid-selfie.pdf', 'application/pdf', { expect: { status: 201 }, save: { selfieId: 'fileId' } }),
        member('Submit with the old consent: true (expect 422)', 'POST', '/me/documents', {
          body: { docType: 'nid', fields: { legalName: 'Nusrat Jahan', number: '1990 1234 5678 9012 3', dob: '1990-05-14' }, files: { front: '{{frontId}}', back: '{{backId}}', selfie: '{{selfieId}}' }, consent: true },
          expect: { status: 422, code: 'CONSENT_REQUIRED' },
        }),
        member('Submit with an old consent version (expect 422)', 'POST', '/me/documents', {
          body: { docType: 'nid', fields: { legalName: 'Nusrat Jahan', number: '1990 1234 5678 9012 3', dob: '1990-05-14' }, files: { front: '{{frontId}}', back: '{{backId}}', selfie: '{{selfieId}}' }, consent: { accepted: true, version: 0 } },
          expect: { status: 422, code: 'CONSENT_VERSION_STALE' },
          checks: [['the current version is in the problem', "j.currentVersion === Number(pm.collectionVariables.get('consentVersion'))"]],
        }),
        under18(member('Submit a date of birth one day short of 18 (expect 422)', 'POST', '/me/documents', {
          body: { docType: 'nid', fields: { legalName: 'Nusrat Jahan', number: '1990 1234 5678 9012 3', dob: '{{under18Dob}}' }, files: { front: '{{frontId}}', back: '{{backId}}', selfie: '{{selfieId}}' }, consent: CONSENT },
          expect: { status: 422, code: 'UNDER_MIN_AGE' },
          checks: [['18 and over', "j.minAge === 18 && j.title === 'NID verification is for people aged 18 and over'"]],
        })),
        member('Submit with a wrong NID number (expect 422)', 'POST', '/me/documents', {
          body: { docType: 'nid', fields: { legalName: 'Nusrat Jahan', number: '12345678901', dob: '1990-05-14' }, files: { front: '{{frontId}}', back: '{{backId}}', selfie: '{{selfieId}}' }, consent: CONSENT },
          expect: { status: 422, code: 'NID_FORMAT_INVALID' },
        }),
        member('Submit the NID', 'POST', '/me/documents', {
          body: { docType: 'nid', fields: { legalName: 'Nusrat Jahan', number: '1990 1234 5678 9012 3', dob: '1990-05-14' }, files: { front: '{{frontId}}', back: '{{backId}}', selfie: '{{selfieId}}' }, consent: CONSENT },
          expect: { status: 201 },
          save: { documentId: 'id' },
          checks: [['in review, masked', "j.status === 'in_review' && j.numberMasked === '•••• 0123' && !JSON.stringify(j).includes('19901234567890123')"]],
        }),
      ],
    },
    {
      name: '2. Moderation desk (M05) with the document panel',
      item: [
        req('Queue (documents)', 'GET', '/admin/submissions?kind=document', {
          expect: { status: 200 },
          save: { submissionId: 'items.0.id' },
          checks: [['one waiting', "j.items.length === 1 && j.items[0].kind === 'document' && j.items[0].status === 'pending_review' && !JSON.stringify(j).includes('19901234567890123')"]],
        }),
        req('Claim it', 'POST', '/admin/submissions/{{submissionId}}/claim', {
          expect: { status: 200 },
          checks: [['mine, checks passed, masked payload', "j.claim.mine === true && j.checks.every((c) => c.result !== 'fail') && j.payload.documentId === pm.collectionVariables.get('documentId') && j.payload.numberMasked === '•••• 0123'"]],
        }),
        req('Review panel', 'GET', '/admin/kyc/documents/{{documentId}}', {
          expect: { status: 200 },
          checks: [
            ['legal name and DOB, number masked', "j.fields.legalName === 'Nusrat Jahan' && j.fields.dob === '1990-05-14' && j.fields.numberMasked === '•••• 0123' && j.files.length === 3"],
            ['consent recorded', "j.consent && j.consent.version === Number(pm.collectionVariables.get('consentVersion')) && !Number.isNaN(Date.parse(j.consent.at))"],
          ],
        }),
        req('NID holders under the minimum age (audited)', 'GET', '/admin/kyc/under-min-age', {
          expect: { status: 200 },
          checks: [['none: the member was born in 1990', "j.minAgeYears === 18 && j.count === 0 && j.items.length === 0 && pm.response.headers.get('Cache-Control') === 'no-store'"]],
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
        idem(req('Approve without the rubric (expect 422)', 'POST', '/admin/submissions/{{submissionId}}/decide', { body: { decision: 'approve' }, expect: { status: 422, code: 'RUBRIC_INCOMPLETE' } })),
        req('Tick the rubric', 'PUT', '/admin/submissions/{{submissionId}}/ticks', { body: { ticks: RUBRIC }, expect: { status: 200 }, checks: [['nothing missing', 'j.missing.length === 0']] }),
        idem(req('Approve', 'POST', '/admin/submissions/{{submissionId}}/decide', {
          body: { decision: 'approve' },
          expect: { status: 200 },
          checks: [['approved', "j.status === 'approved'"]],
        })),
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

collection.variable.push(consentVar());
fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
const count = collection.item.reduce((n, f) => n + f.item.length, 0);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)} (${count} requests)`);
