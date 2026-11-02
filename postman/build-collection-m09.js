'use strict';

/**
 * Builds postman/kriraghor-grounds.postman_collection.json (M09 Grounds step 1, with the M02 business
 * documents and the M03 places catalogue it needs). node postman/build-collection-m09.js
 *
 * Variables: adminAccessToken / adminAccessToken2 (masters A and B; B reviews), accessToken (the
 * owner: an active member who applied for ground_owner), controlUrl (the runner: /refresh hands back a
 * fresh owner token after the role changes, /settle drains events).
 * Unattended: `node postman/run-m09.js` (kriraghor_test database; fixtures in postman/fixtures).
 */
const fs = require('fs');
const path = require('path');
const { req, CONSENT, consentVar } = require('./lib');

const out = path.join(__dirname, 'kriraghor-grounds.postman_collection.json');

const owner = (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: 'Bearer {{accessToken}}' });
  return r;
};
const upload = (name, p, file, mime, opts) => {
  const r = owner(name, 'POST', p, opts);
  r.request.header.push({ key: 'Content-Type', value: mime });
  r.request.body = { mode: 'file', file: { src: file } };
  return r;
};
const idem = (item) => {
  item.request.header.push({ key: 'Idempotency-Key', value: 'pm-{{$guid}}' });
  return item;
};
/** A call to the runner (never part of the API). */
const control = (name, step, opts = {}) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 }, ...opts });
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [step] };
  return r;
};
/** Set a collection variable from the response with a JS expression (the lib saves paths only). */
const setVar = (name, expr) => [`saves ${name}`, `(pm.collectionVariables.set('${name}', ${expr}), true)`];
/** Claim, tick and approve the submission in `idVar` as master B. */
const decide = (label, idVar, ticks) => [
  req(`${label}: claim`, 'POST', `/admin/submissions/{{${idVar}}}/claim`, { as: 'B', expect: { status: 200 }, checks: [['no failing check', "j.checks.every((c) => c.result !== 'fail')"]] }),
  req(`${label}: tick the rubric`, 'PUT', `/admin/submissions/{{${idVar}}}/ticks`, { as: 'B', body: { ticks }, expect: { status: 200 } }),
  idem(req(`${label}: approve`, 'POST', `/admin/submissions/{{${idVar}}}/decide`, { as: 'B', body: { decision: 'approve' }, expect: { status: 200 } })),
];
const DOC_RUBRIC = ['name_matches', 'readable', 'not_edited', 'face_matches'];
const GROUND_RUBRIC = ['photos_real', 'location_ok', 'courts_ok', 'price_ok', 'rules_ok'];
const MON_18 = '2026-11-02T12:00:00.000Z'; // Monday 18:00 Asia/Dhaka

const collection = {
  info: {
    name: 'Kriraghor API: M09 Grounds',
    description: [
      'A member who applied as a ground owner sends a trade licence and a lease (M02 business documents lite); master B approves both and the ground_owner role becomes active. The owner lists a ground in Dhanmondi with a court and three photos (JPEG, PNG, WebP to the public bucket), sends it for review, and master B approves it: it is live on /grounds and the public quote for Monday 18:00, 120 min is ৳6,000 (§6.1 example 1). The owner publishes a ৳3,000 base and the quote becomes ৳7,500. A live edit keeps the public version until reviewed; pause and resume; staff list and suspend.',
      'Requests named "Runner" go to the local test runner (a fresh owner token after a role change; draining events).',
      'Unattended: `node postman/run-m09.js` (kriraghor_test database; fixtures in postman/fixtures).',
      'Rebuild this file with: node postman/build-collection-m09.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    'baseUrl', 'controlUrl', 'adminAccessToken', 'adminAccessToken2', 'accessToken', 'stepUpToken', 'stepUpTokenB',
    'areaId', 'sportId', 'surfaceId', 'fileId', 'tlSubmissionId', 'leaseSubmissionId', 'groundId', 'slug', 'courtId', 'groundSubmissionId', 'editSubmissionId',
  ].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '0. Catalogue and guards (M03, FR-01)',
      item: [
        req('Areas where grounds are listed', 'GET', '/catalog/areas?service=grounds', {
          as: false,
          expect: { status: 200 },
          checks: [['Dhaka metro only', 'j.items.length === 18 && j.items.every((a) => a.isDhakaMetro)'], setVar('areaId', "j.items.find((a) => a.key === 'dhanmondi').id")],
        }),
        req('Sports', 'GET', '/catalog/sports', { as: false, expect: { status: 200 }, checks: [setVar('sportId', "j.items.find((s) => s.key === 'football').id")] }),
        req('Surfaces', 'GET', '/catalog/surfaces', { as: false, expect: { status: 200 }, checks: [setVar('surfaceId', "j.items.find((s) => s.key === 'artificial_turf').id")] }),
        req('Divisions and districts', 'GET', '/catalog/locations', { as: false, expect: { status: 200 }, checks: [['8 divisions, 64 districts', 'j.items.length === 8 && j.items.reduce((n, d) => n + d.districts.length, 0) === 64']] }),
        req('No grounds yet', 'GET', '/grounds', { as: false, expect: { status: 200 }, checks: [['empty', 'j.total === 0']] }),
        owner('Applied but not active: the desk is closed (expect 403)', 'GET', '/me/grounds', { expect: { status: 403, code: 'ROLE_PENDING' } }),
      ],
    },
    {
      name: '1. Business documents (M02 lite → M01 ground_owner)',
      item: [
        owner('The checklist', 'GET', '/me/verification?role=ground_owner', {
          expect: { status: 200 },
          checks: [['two required, one optional', "j.roleStatus === 'applied' && j.progress.total === 2 && j.items.map((i) => i.key).join() === 'trade_license,deed_or_lease,tin'"]],
        }),
        upload('Upload the trade licence (PDF)', '/me/documents/files?slot=document&docType=trade_license', 'nid-selfie.pdf', 'application/pdf', { expect: { status: 201 }, save: { fileId: 'fileId' } }),
        owner('Expired licence (expect 422)', 'POST', '/me/documents', {
          body: { docType: 'trade_license', fields: { number: 'TRAD/DNCC/889912', holderName: 'Kamal Sports', expiresOn: '2020-01-01' }, files: { document: '{{fileId}}' }, consent: CONSENT },
          expect: { status: 422, code: 'VALIDATION_FAILED' },
        }),
        owner('Send the trade licence', 'POST', '/me/documents', {
          body: { docType: 'trade_license', fields: { number: 'TRAD/DNCC/889912', holderName: 'Kamal Sports', expiresOn: '2028-06-30' }, files: { document: '{{fileId}}' }, consent: CONSENT },
          expect: { status: 201 },
          checks: [['in review, number masked', "j.status === 'in_review' && j.numberMasked === '•••• 9912' && !JSON.stringify(j).includes('889912')"]],
        }),
        // The role moved to in_review (authz version bumped): the owner needs a fresh token.
        control('drain events and refresh the owner token', 'refresh', { checks: [['fresh owner token', "(pm.environment.set('accessToken', j.accessToken), typeof j.accessToken === 'string')"]] }),
        upload('Upload the lease (PNG)', '/me/documents/files?slot=document&docType=deed_or_lease', 'nid-back.png', 'image/png', { expect: { status: 201 }, save: { fileId: 'fileId' } }),
        owner('Send the lease', 'POST', '/me/documents', { body: { docType: 'deed_or_lease', fields: { kind: 'lease', expiresOn: '2030-12-31' }, files: { document: '{{fileId}}' }, consent: CONSENT }, expect: { status: 201 } }),
        control('drain events', 'settle'),
        req('Both are on the Moderation desk', 'GET', '/admin/submissions?status=pending_review&kind=document', {
          as: 'B',
          expect: { status: 200 },
          checks: [['two documents', 'j.items.length === 2'], setVar('tlSubmissionId', "j.items.find((s) => s.title.startsWith('Trade licence')).id"), setVar('leaseSubmissionId', "j.items.find((s) => s.title.startsWith('Land deed')).id")],
        }),
        ...decide('Trade licence', 'tlSubmissionId', DOC_RUBRIC),
        ...decide('Lease', 'leaseSubmissionId', DOC_RUBRIC),
        control('drain events and refresh the owner token', 'refresh', { checks: [['fresh owner token', "(pm.environment.set('accessToken', j.accessToken), typeof j.accessToken === 'string')"]] }),
        owner('The ground_owner role is active', 'GET', '/me/verification?role=ground_owner', {
          expect: { status: 200 },
          checks: [['active, fully verified', "j.roleStatus === 'active' && j.badge === 'fully_verified'"]],
        }),
      ],
    },
    {
      name: '2. Listing and review (FR-01 to FR-04, FR-07)',
      item: [
        owner('Create a draft ground', 'POST', '/me/grounds', {
          body: { name: 'Postman Turf Arena', areaId: '{{areaId}}', addressLine: 'Road 8A, Dhanmondi', lat: 23.7465, lng: 90.376, basePricePoisha: 240000 },
          expect: { status: 201 },
          save: { groundId: 'id', slug: 'slug' },
          checks: [['draft with a pricing draft', "j.status === 'draft' && j.pricing.hasDraft && j.pricing.basePricePoisha === 240000"]],
        }),
        owner('Send it incomplete (expect 422)', 'POST', '/me/grounds/{{groundId}}/submit', { expect: { status: 422, code: 'GROUND_INCOMPLETE' } }),
        owner('Add a court (default hours: the whole bookable day)', 'POST', '/me/grounds/{{groundId}}/courts', {
          body: { name: 'Court 1', sportIds: ['{{sportId}}'], surfaceId: '{{surfaceId}}', sizeText: '40 x 20 m' },
          expect: { status: 201 },
          save: { courtId: 'courts.0.id' },
          checks: [['pending, open every day', "j.courts[0].status === 'pending' && j.courts[0].hours.length === 7 && j.courts[0].hours.every((h) => !h.isClosed && h.openTime === '06:00')"]],
        }),
        upload('Photo 1 (JPEG)', '/me/grounds/{{groundId}}/photos', 'nid-front.jpg', 'image/jpeg', { expect: { status: 201 }, checks: [['public URL', "j.url.includes('/grounds/') && j.url.endsWith('.jpg')"]] }),
        upload('Photo 2 (PNG)', '/me/grounds/{{groundId}}/photos', 'nid-back.png', 'image/png', { expect: { status: 201 } }),
        upload('Photo 3 (WebP)', '/me/grounds/{{groundId}}/photos', 'ground.webp', 'image/webp', { expect: { status: 201 } }),
        upload('A GIF is refused (expect 415)', '/me/grounds/{{groundId}}/photos', 'not-allowed.gif', 'image/gif', { expect: { status: 415, code: 'FILE_TYPE_NOT_ALLOWED' } }),
        owner('Send for review', 'POST', '/me/grounds/{{groundId}}/submit', { expect: { status: 200 }, checks: [['in review', "j.status === 'pending_review'"]] }),
        req('Not public while in review (expect 404)', 'GET', '/grounds/{{slug}}', { as: false, expect: { status: 404 } }),
        control('drain events', 'settle'),
        req('On the desk with a first-version diff', 'GET', '/admin/submissions?status=pending_review&kind=ground', {
          as: 'B',
          expect: { status: 200 },
          save: { groundSubmissionId: 'items.0.id' },
          checks: [['one ground', "j.items.length === 1 && j.items[0].kind === 'ground'"]],
        }),
        ...decide('Ground', 'groundSubmissionId', GROUND_RUBRIC),
        control('drain events', 'settle'),
        owner('Live, version 1, prices published', 'GET', '/me/grounds/{{groundId}}', {
          expect: { status: 200 },
          checks: [['live', "j.status === 'live' && j.liveVersion === 1 && j.pricing.publishedVersion === 1 && j.courts[0].status === 'active'"]],
        }),
      ],
    },
    {
      name: '3. Public read side and quote (FR-13, FR-25, FR-27, §6.1)',
      item: [
        req('Listed with facets', 'GET', '/grounds?sport=football', {
          as: false,
          expect: { status: 200 },
          checks: [['one card from ৳1,920/h', "j.total === 1 && j.items[0].name === 'Postman Turf Arena' && j.items[0].priceFromPoisha === 192000 && j.facets.sports.some((f) => f.key === 'football')"]],
        }),
        req('Search by part of the name (FR-28)', 'GET', '/grounds?q=postman%20turf', {
          as: false,
          expect: { status: 200 },
          checks: [['finds it', "j.total === 1 && j.items[0].name === 'Postman Turf Arena'"]],
        }),
        req('A search that matches nothing (FR-28)', 'GET', '/grounds?q=no-such-venue', {
          as: false,
          expect: { status: 200 },
          checks: [['empty', 'j.total === 0']],
        }),
        req('Detail with the v3 payment line', 'GET', '/grounds/{{slug}}', {
          as: false,
          expect: { status: 200 },
          checks: [['public version', "j.photos.length === 3 && j.courts.length === 1 && j.payment.advanceRefundable === false && j.payment.allowFullPayment === true && j.pricing.week.length === 7"]],
        }),
        req('Quote: Monday 18:00, 120 min = ৳6,000', 'POST', '/grounds/{{groundId}}/quote', {
          as: false,
          body: { courtIds: ['{{courtId}}'], start: MON_18, minutes: 120 },
          expect: { status: 200 },
          checks: [['§6.1 example 1 and both options', "j.price === 600000 && j.advance === 180000 && j.fee === 30000 && j.options.length === 2 && j.options[1].ownerGetsOnline === 570000"]],
        }),
        req('After closing (expect 422)', 'POST', '/grounds/{{groundId}}/quote', { as: false, body: { courtIds: ['{{courtId}}'], start: '2026-11-02T16:30:00.000Z', minutes: 60 }, expect: { status: 422, code: 'OUTSIDE_HOURS' } }),
      ],
    },
    {
      name: '4. Pricing (FR-09 to FR-14)',
      item: [
        owner('Pricing view', 'GET', '/me/grounds/{{groundId}}/pricing', {
          expect: { status: 200 },
          checks: [['published v1, policy', "j.published.version === 1 && j.draft === null && j.upcomingBookings === 0 && j.policy.feePct === 5 && j.limits.advanceMax === 50"]],
        }),
        owner('Advance above 50% (expect 422)', 'PUT', '/me/grounds/{{groundId}}/pricing/draft', { body: { advancePct: 55 }, expect: { status: 422, code: 'VALIDATION_FAILED' } }),
        owner('Save a ৳3,000 draft', 'PUT', '/me/grounds/{{groundId}}/pricing/draft', { body: { basePricePoisha: 300000 }, expect: { status: 200 }, checks: [['draft v2', "j.status === 'draft' && j.version === 2"]] }),
        owner('Quote with an unsaved advance', 'POST', '/me/grounds/{{groundId}}/pricing/quote', {
          body: { courtIds: ['{{courtId}}'], start: MON_18, minutes: 120, draft: { advancePct: 40 } },
          expect: { status: 200 },
          checks: [['the draft price', 'j.price === 750000 && j.advance === 300000']],
        }),
        owner('Publish', 'POST', '/me/grounds/{{groundId}}/pricing/publish', {
          body: { applyToAll: false },
          expect: { status: 200 },
          checks: [['v2 with a summary', "j.published.version === 2 && j.published.summary === 'Updated pricing: base ৳3,000/h'"]],
        }),
        owner('History', 'GET', '/me/grounds/{{groundId}}/pricing/history', { expect: { status: 200 }, checks: [['v2 then v1', "j.items.map((i) => i.version + i.status).join() === '2published,1superseded'"]] }),
        owner('Heatmap', 'GET', '/me/grounds/{{groundId}}/pricing/heatmap', { expect: { status: 200 }, checks: [['7 × 17', 'j.rows.length === 7 && j.rows[0].cells.length === 17 && j.basePricePoisha === 300000']] }),
        req('The public quote follows: ৳7,500', 'POST', '/grounds/{{groundId}}/quote', { as: false, body: { courtIds: ['{{courtId}}'], start: MON_18, minutes: 120 }, expect: { status: 200 }, checks: [['new price', 'j.price === 750000 && j.rulesVersion === 2']] }),
      ],
    },
    {
      name: '5. Live edits, pause and staff (FR-03 to FR-05)',
      item: [
        owner('Rename (a review field)', 'PATCH', '/me/grounds/{{groundId}}', { body: { name: 'Postman Turf Arena Pro', description: 'Floodlit 5-a-side' }, expect: { status: 200 }, checks: [['unsent edit', "j.status === 'live' && j.editStatus === 'draft'"]] }),
        req('The public keeps the approved name; the description is live at once', 'GET', '/grounds/{{slug}}', { as: false, expect: { status: 200 }, checks: [['old name, new text', "j.name === 'Postman Turf Arena' && j.description === 'Floodlit 5-a-side'"]] }),
        owner('Send the edit', 'POST', '/me/grounds/{{groundId}}/submit', { expect: { status: 200 }, checks: [['edit in review', "j.editStatus === 'pending_review'"]] }),
        control('drain events', 'settle'),
        req('The edit on the desk', 'GET', '/admin/submissions?status=pending_review&kind=ground', {
          as: 'B',
          expect: { status: 200 },
          save: { editSubmissionId: 'items.0.id' },
          checks: [['an edit with a diff', "j.items.length === 1 && j.items[0].isEdit === true"]],
        }),
        ...decide('Edit', 'editSubmissionId', GROUND_RUBRIC),
        control('drain events', 'settle'),
        req('The new name is public, the slug stays', 'GET', '/grounds/{{slug}}', { as: false, expect: { status: 200 }, checks: [['v2', "j.name === 'Postman Turf Arena Pro' && j.version === 2"]] }),
        owner('Pause', 'POST', '/me/grounds/{{groundId}}/pause', { expect: { status: 200 }, checks: [['paused', "j.status === 'paused'"]] }),
        req('Hidden while paused (expect 404)', 'GET', '/grounds/{{slug}}', { as: false, expect: { status: 404 } }),
        owner('Show again', 'POST', '/me/grounds/{{groundId}}/resume', { expect: { status: 200 }, checks: [['live', "j.status === 'live'"]] }),
        req('Staff list', 'GET', '/admin/grounds?q=postman', { expect: { status: 200 }, checks: [['one', "j.items.length === 1 && j.items[0].status === 'live'"]] }),
        req('Staff view of the working copy', 'GET', '/admin/grounds/{{groundId}}', { expect: { status: 200 }, checks: [['rules and public version', 'j.publicVersion.version === 2 && j.rules.version === 2']] }),
        req('Suspend', 'POST', '/admin/grounds/{{groundId}}/suspend', { body: { reason: 'Postman acceptance check' }, expect: { status: 200 }, checks: [['suspended', "j.status === 'suspended'"]] }),
        req('Restore', 'POST', '/admin/grounds/{{groundId}}/restore', { body: { reason: 'Postman acceptance check' }, expect: { status: 200 }, checks: [['live', "j.status === 'live'"]] }),
        req('Audit log has the suspension (critical)', 'GET', '/admin/audit-logs?action=ground.suspended', { expect: { status: 200 }, checks: [['critical', "j.items.length === 1 && j.items[0].severity === 'critical'"]] }),
      ],
    },
  ],
};

collection.variable.push(consentVar());
fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
const count = collection.item.reduce((n, f) => n + f.item.length, 0);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)} (${count} requests)`);
