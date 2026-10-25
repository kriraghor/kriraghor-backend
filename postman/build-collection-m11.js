'use strict';

/**
 * Builds postman/kriraghor-hire.postman_collection.json (M11 Hire step 1: the core hire loop, with the
 * M03 taxonomy, the M02 credential per hire role, M05 profile review, M06 split escrow and the M17
 * no-show dispute). node postman/build-collection-m11.js
 *
 * Variables: adminAccessToken (master A), docsToken / listingsToken / deskToken (staff), proToken (a
 * pro applicant), m1Token / m2Token (managers), areaDhanmondi / areaMirpur, start4 / start5 / start6 /
 * start8 (19:30 Dhaka in 4, 5, 6 and 8 days), day0 / day14 / day70 (00:00 Dhaka today and 14 or 70 days
 * on), block8Start / block8End (around the day-8 match), controlUrl (the runner: /refresh, /pay, /move,
 * /tick, /check). Folder 6 is Round B1: insights, stats, completeness, the availability calendar and the
 * M01 avatar.
 * Unattended: `node postman/run-m11.js` (kriraghor_test database; fixtures in postman/fixtures).
 */
const fs = require('fs');
const path = require('path');
const { req, CONSENT, consentVar } = require('./lib');

const out = path.join(__dirname, 'kriraghor-hire.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const pro = as('proToken');
const m1 = as('m1Token');
const m2 = as('m2Token');
const docs = as('docsToken');
const listings = as('listingsToken');
const desk = as('deskToken');
const idem = (item) => {
  item.request.header.push({ key: 'Idempotency-Key', value: 'pm-{{$guid}}' });
  return item;
};
const upload = (name, p, file, mime, opts) => {
  const r = pro(name, 'POST', p, opts);
  r.request.header.push({ key: 'Content-Type', value: mime });
  r.request.body = { mode: 'file', file: { src: file } };
  return r;
};
const control = (name, step, opts = {}) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 }, ...opts });
  const [p, qs] = step.split('?');
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [p], ...(qs ? { query: qs.split('&').map((kv) => ({ key: kv.split('=')[0], value: kv.split('=')[1] })) } : {}) };
  return r;
};
const numeric = (item, field, variable) => {
  item.request.body.raw = item.request.body.raw.replace(`"${field}": "{{${variable}}}"`, `"${field}": {{${variable}}}`);
  return item;
};
const setVar = (name, expr) => [`saves ${name}`, `(pm.collectionVariables.set('${name}', ${expr}), true)`];
const decide = (who, label, idVar, ticks) => [
  who(`${label}: claim`, 'POST', `/admin/submissions/{{${idVar}}}/claim`, { expect: { status: 200 }, checks: [['no failing check', "j.checks.every((c) => c.result !== 'fail')"]] }),
  who(`${label}: tick the rubric`, 'PUT', `/admin/submissions/{{${idVar}}}/ticks`, { body: { ticks }, expect: { status: 200 } }),
  idem(who(`${label}: approve`, 'POST', `/admin/submissions/{{${idVar}}}/decide`, { body: { decision: 'approve' }, expect: { status: 200 } })),
];
const engagement = (start) => ({ start: `{{${start}}}`, format: 'T20', venueText: 'Mirpur Turf 10', venueAreaId: '{{areaMirpur}}' });
const request = (who, name, starts, save) => idem(who(name, 'POST', '/hire/requests', { body: { profileId: '{{profileId}}', unit: 'match', engagements: starts.map(engagement), note: 'League match, white ball' }, expect: { status: 201 }, save }));
const CARD = { items: [{ unit: 'match', format: 'T20', rate: 350000 }, { unit: 'match', format: 'T10', rate: 250000 }], nightPct: 20, shortNoticePct: 15, shortNoticeHours: 48, travel: { north: 30000, south: 50000, outside: 150000 }, maxJobsPerDay: 2 };
const DOC_RUBRIC = ['name_matches', 'readable', 'not_edited', 'face_matches'];
const PROFILE_RUBRIC = ['identity_ok', 'role_ok', 'credential_ok', 'rates_ok', 'bio_ok'];

const collection = {
  info: {
    name: 'Kriraghor API: M11 Hire (step 1 and Round B1)',
    description: [
      'A pro (an active member who applied as a pro) sends a BCB Level 2 umpire credential (M02, kept per hire role); the documents desk approves it and the pro role turns active. The pro lists as a semi-pro cricket umpire based in Dhanmondi with the design rate card (T20 ৳3,500, night 20%, short notice 15%, travel north ৳300); the listings desk approves it (M05 kind hire_profile).',
      'Manager 1 asks for two T20 night matches in Mirpur; the server quotes ৳4,500 each. Manager 2 asks for the first evening too; once the pro accepts manager 1, manager 2 fails the clash check. Messages refuse phone numbers before payment. Manager 1 pays (one payment, a hold per job) and both phones show.',
      'Match day: check in (late), start, mark complete; the manager confirms and the pro gets ৳4,050 (10% fee). The second match is cancelled 30 h before: 25% to the pro less 10% (৳1,012.50), 75% back. Manager 2 hires again and the pro withdraws (100% back). A third hire is a no-show: an M17 dispute, the hold frozen, decided all back.',
      'Round B1: the pro reads their insights (earned from the ledger, net), stats and completeness, blocks an evening in the calendar (the public strip shows times only, a request over it is refused with PRO_UNAVAILABLE, the horizon is enforced), and sets and removes a profile photo (M01 avatar).',
      'Requests named "Runner" go to the local test runner (pay, move a job in time, refresh the pro token, read the ledger).',
      'Unattended: `node postman/run-m11.js` (kriraghor_test database).',
      'Rebuild this file with: node postman/build-collection-m11.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: ['baseUrl', 'controlUrl', 'fileId', 'credSubmissionId', 'profileId', 'profileSubmissionId', 'slug', 'r1', 'r1code', 'r2', 'r3', 'r4', 'payment1', 'payment3', 'payment4', 'job1', 'job2', 'job3', 'job4', 'disputeCode', 'version'].map((key) => ({
    key,
    value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '',
  })),
  item: [
    {
      name: '1. Taxonomy and the credential (M03, M02)',
      item: [
        req('The hire taxonomy', 'GET', '/hire/taxonomy', { as: false, expect: { status: 200 }, checks: [['6 categories, 24 roles', 'j.items.length === 6 && j.items.flatMap((c) => c.roles).length === 24'], ['umpires price formats', "j.items.find((c) => c.key === 'officials').roles.find((r) => r.key === 'cricket_umpire').formatPriced === true"]] }),
        upload('Upload the umpire certificate (PDF)', '/me/documents/files?slot=document&docType=credential', 'nid-selfie.pdf', 'application/pdf', { expect: { status: 201 }, save: { fileId: 'fileId' } }),
        pro('A level the role does not have (expect 422)', 'POST', '/me/documents', { body: { docType: 'credential', role: 'pro', fields: { hireRole: 'cricket_umpire', level: 'grandmaster', issuer: 'Bangladesh Cricket Board' }, files: { document: '{{fileId}}' }, consent: CONSENT }, expect: { status: 422 } }),
        pro('Send the BCB Level 2 credential', 'POST', '/me/documents', { body: { docType: 'credential', role: 'pro', fields: { hireRole: 'cricket_umpire', level: 'pro', issuer: 'Bangladesh Cricket Board', number: 'BCB-L2-1188' }, files: { document: '{{fileId}}' }, consent: CONSENT }, expect: { status: 201 } }),
        docs('The credential on the desk', 'GET', '/admin/submissions?status=pending_review&kind=document', { expect: { status: 200 }, checks: [setVar('credSubmissionId', 'j.items[0].id')] }),
        ...decide(docs, 'Credential', 'credSubmissionId', DOC_RUBRIC),
        control('drain events and refresh the pro token', 'refresh', { checks: [['fresh token', "(pm.environment.set('proToken', j.accessToken), typeof j.accessToken === 'string')"]] }),
        pro('The pro role is active, the credential approved', 'GET', '/me/verification?role=pro', { expect: { status: 200 }, checks: [['active', "j.roleStatus === 'active'"], ['credential', "j.credentials[0].hireRole === 'cricket_umpire' && j.credentials[0].status === 'approved'"]] }),
      ],
    },
    {
      name: '2. The profile and its review (FR-10 to FR-14)',
      item: [
        pro('A semi-pro umpire profile in Dhanmondi', 'POST', '/pro/profiles', {
          body: { roleKey: 'cricket_umpire', headline: 'BCB umpire for club and league cricket', experienceLevel: 'semi_pro', years: 6, baseAreaId: '{{areaDhanmondi}}', sportKeys: ['cricket'], bio: 'Six seasons in the Dhaka leagues.' },
          expect: { status: 201 },
          save: { profileId: 'id', slug: 'slug' },
          checks: [['draft with limits', "j.status === 'draft' && Boolean(j.limits['match:T20'])"]],
        }),
        pro('Sending without rates (expect 409)', 'POST', '/pro/profiles/{{profileId}}/submit', { expect: { status: 409, code: 'RATE_CARD_REQUIRED' } }),
        pro('A rate under the limit (expect 422)', 'PUT', '/pro/profiles/{{profileId}}/rate-card', { body: { ...CARD, items: [{ unit: 'match', format: 'T20', rate: 1000 }] }, expect: { status: 422 } }),
        pro('The design rate card', 'PUT', '/pro/profiles/{{profileId}}/rate-card', { body: CARD, expect: { status: 200 }, checks: [['version 1', 'j.rateCard.version === 1 && j.rateCard.items.length === 2']] }),
        pro('Send for review', 'POST', '/pro/profiles/{{profileId}}/submit', { expect: { status: 200 }, checks: [['in review', "j.status === 'pending_review'"]] }),
        listings('The profile on the desk', 'GET', '/admin/submissions?status=pending_review&kind=hire_profile', { expect: { status: 200 }, checks: [setVar('profileSubmissionId', 'j.items[0].id')] }),
        ...decide(listings, 'Profile', 'profileSubmissionId', PROFILE_RUBRIC),
        control('deliver the decision', 'settle'),
        pro('The profile is live', 'GET', '/pro/profiles/{{profileId}}', { expect: { status: 200 }, checks: [['live', "j.status === 'live' && j.liveVersion === 1"]] }),
        req('The directory lists it', 'GET', '/hire/profiles?category=officials&unit=match&sort=rate', { as: false, expect: { status: 200 }, checks: [['one, from ৳2,500', "j.items.length === 1 && j.items[0].rateFrom === 250000 && j.counts.officials === 1"]] }),
        req('The profile page', 'GET', '/hire/profiles/{{slug}}', { as: false, expect: { status: 200 }, checks: [['verified BCB Level 2', "j.credential.level === 'pro' && j.credential.labelEn === 'BCB Level 2'"]] }),
        req('A quote: T20 night in Mirpur', 'POST', '/hire/profiles/{{profileId}}/quote', { as: false, body: { unit: 'match', engagements: [engagement('start4')] }, expect: { status: 200 }, checks: [['৳4,500 (3,500 + 700 + 300)', "j.total === 450000 && j.lines[0].zone === 'north'"]] }),
      ],
    },
    {
      name: '3. Requests, accept and payment (FR-20 to FR-26)',
      item: [
        request(m1, 'Manager 1: two T20 nights', ['start4', 'start5'], { r1: 'request.id', r1code: 'request.code' }),
        request(m2, 'Manager 2: the first night', ['start4'], { r2: 'request.id' }),
        pro('Requests to answer, with the checks', 'GET', '/pro/requests?status=pending', { expect: { status: 200 }, checks: [['two, all checks pass', 'j.items.length === 2 && j.items.every((i) => i.checks.every((c) => c.ok))']] }),
        pro('Accept manager 1', 'POST', '/pro/requests/{{r1}}/accept', { expect: { status: 200 }, checks: [['reserved', "j.request.status === 'accepted_unpaid' && j.request.jobs.every((x) => x.status === 'reserved')"]] }),
        pro('Manager 2 now clashes (expect 422)', 'POST', '/pro/requests/{{r2}}/accept', { expect: { status: 422, code: 'CHECKS_FAILED' }, checks: [['the free check', "j.errors[0].field === 'free'"]] }),
        m1('A phone number before payment (expect 422)', 'POST', '/me/hire-requests/{{r1}}/messages', { body: { body: 'Call me on 01711 000 111' }, expect: { status: 422, code: 'CONTACT_NOT_ALLOWED' } }),
        m1('A message', 'POST', '/me/hire-requests/{{r1}}/messages', { body: { body: 'Toss at 7:15, please come 30 minutes early' }, expect: { status: 201 } }),
        pro('The pro sees it', 'GET', '/me/hire-requests/{{r1}}/messages', { expect: { status: 200 }, checks: [['one, not mine', 'j.items.length === 1 && j.items[0].mine === false && j.contactAllowed === false']] }),
        m1('Unpaid: the payment link', 'GET', '/me/hire-requests/{{r1code}}', { expect: { status: 200 }, save: { payment1: 'request.paymentId', job1: 'request.jobs.0.id', job2: 'request.jobs.1.id' }, checks: [['pay link, no phone', "Boolean(j.payment.payUrl) && j.request.other.phone === null"]] }),
        control('pay through the simulator', 'pay?paymentId={{payment1}}&who=m1'),
        m1('Confirmed; the phone shows', 'GET', '/me/hire-requests/{{r1code}}', { expect: { status: 200 }, checks: [['confirmed', "j.request.status === 'confirmed' && j.request.jobs.every((x) => x.status === 'scheduled')"], ['phone', "/^\\+8801/.test(j.request.other.phone)"]] }),
      ],
    },
    {
      name: '4. Match day and confirm (FR-30 to FR-34, v3)',
      item: [
        pro('Check in too early (expect 409)', 'POST', '/pro/jobs/{{job1}}/check-in', { expect: { status: 409, code: 'TOO_EARLY' } }),
        control('the match is in 20 minutes', 'move?jobId={{job1}}&minutes=20'),
        pro('Check in (late)', 'POST', '/pro/jobs/{{job1}}/check-in', { expect: { status: 200 }, checks: [['late', "j.status === 'checked_in' && j.late === true"]] }),
        control('the match is in 10 minutes', 'move?jobId={{job1}}&minutes=10'),
        pro('Start', 'POST', '/pro/jobs/{{job1}}/start', { expect: { status: 200 } }),
        pro('Mark complete', 'POST', '/pro/jobs/{{job1}}/complete', { body: { result: 'Dhanmondi XI won by 6 wickets' }, expect: { status: 200 }, checks: [['auto-release set', "j.status === 'completed_marked' && Boolean(j.releaseAt)"]] }),
        m1('The manager confirms', 'POST', '/me/hire-jobs/{{job1}}/confirm', { expect: { status: 200 }, checks: [['released', "j.status === 'released' && j.releasedBy === 'hirer'"]] }),
        control('ledger: the pro has ৳4,050, fee ৳450', 'check', { checks: [['balanced', 'j.invariantsOk === true'], ['payable', 'j.proPayable === 405000 && j.feeRevenue === 45000']] }),
      ],
    },
    {
      name: '5. Cancel, withdraw and a no-show (§6.6, FR-51, FR-35)',
      item: [
        control('the second match is in 30 hours', 'move?jobId={{job2}}&minutes=1800'),
        m1('Cancel preview: 25%', 'GET', '/me/hire-jobs/{{job2}}/cancel-preview', { expect: { status: 200 }, checks: [['tier', "j.tier === 'mid' && j.cancelFee === 112500 && j.refund === 337500 && j.proGets === 101250"]] }),
        m1('Cancel', 'POST', '/me/hire-jobs/{{job2}}/cancel', { expect: { status: 200 }, checks: [['cancelled', "j.job.status === 'cancelled' && j.job.money.cancelFee === 112500"]] }),
        control('ledger: + ৳1,012.50', 'check', { checks: [['payable', 'j.proPayable === 506250']] }),
        pro('Manager 2 is free again: accept', 'POST', '/pro/requests/{{r2}}/accept', { expect: { status: 200 } }),
        m2('Manager 2 pays', 'GET', '/me/hire-requests/{{r2}}', { expect: { status: 200 }, save: { payment4: 'request.paymentId', job4: 'request.jobs.0.id' } }),
        control('pay manager 2', 'pay?paymentId={{payment4}}&who=m2'),
        pro('The pro withdraws: 100% back', 'POST', '/pro/jobs/{{job4}}/withdraw', { body: { reason: 'injury' }, expect: { status: 200 }, checks: [['withdrawn', "j.status === 'withdrawn' && j.money.refunded === 450000"]] }),
        request(m1, 'Manager 1: one more night', ['start6'], { r3: 'request.id' }),
        pro('Accept it', 'POST', '/pro/requests/{{r3}}/accept', { expect: { status: 200 } }),
        m1('Pay link', 'GET', '/me/hire-requests/{{r3}}', { expect: { status: 200 }, save: { payment3: 'request.paymentId', job3: 'request.jobs.0.id' } }),
        control('pay it', 'pay?paymentId={{payment3}}&who=m1'),
        control('the match started 61 minutes ago', 'move?jobId={{job3}}&minutes=-61'),
        idem(
          m1('No-show: an M17 dispute', 'POST', '/me/hire-jobs/{{job3}}/no-show', {
            body: { statement: 'The umpire never came to the ground' },
            expect: { status: 201 },
            save: { disputeCode: 'dispute.code' },
            checks: [['held ৳4,500', "j.dispute.held === 450000 && j.dispute.policyKey === 'hire.no_show'"]],
          })
        ),
        pro('The pro answers', 'POST', '/me/disputes/{{disputeCode}}/respond', { body: { text: 'My bike broke down on the way, sorry' }, expect: { status: 200 } }),
        desk('The desk claims it', 'POST', '/admin/disputes/{{disputeCode}}/claim', { expect: { status: 200 }, save: { version: 'dispute.version' }, checks: [['a hire job', "j.source.kind === 'hire_job'"]] }),
        numeric(idem(desk('All back', 'POST', '/admin/disputes/{{disputeCode}}/decide', { body: { outcome: 'all', reason: 'No check-in and the pro agrees', version: '{{version}}' }, expect: { status: 200 }, checks: [['resolved', "j.dispute.status === 'resolved' && j.dispute.refund === 450000"]] })), 'version', 'version'),
        req('Staff: the first request with its holds', 'GET', '/admin/hire/requests/{{r1code}}', { expect: { status: 200 }, checks: [['two jobs, holds', 'j.jobs.length === 2 && j.jobs.every((x) => x.escrow !== null)'], ['no phone', "!JSON.stringify(j).includes('+8801')"]] }),
        control('ledger still balanced', 'check', { checks: [['balanced', 'j.invariantsOk === true'], ['payable unchanged', 'j.proPayable === 506250']] }),
      ],
    },
    {
      name: '6. Round B1: insights, calendar and photo (FR-05, FR-14, FR-52, M19 §6.3, M01)',
      item: [
        pro('Insights: earned this period from the ledger (net)', 'GET', '/pro/insights?period=7w', { expect: { status: 200 }, checks: [['৳5,062.50 earned', 'j.earned.total === 506250 && j.buckets.length === 7'], ['one job done', 'j.jobs.done === 1'], ['acceptance', "typeof j.acceptanceRate === 'number'"]] }),
        pro('Insights by month', 'GET', '/pro/insights?period=yr', { expect: { status: 200 }, checks: [['12 months', 'j.buckets.length === 12 && j.earned.total === 506250']] }),
        pro('A period that does not exist (expect 422)', 'GET', '/pro/insights?period=month', { expect: { status: 422 } }),
        pro('My profile: stats and completeness', 'GET', '/pro/profiles/{{profileId}}', { expect: { status: 200 }, checks: [['jobs done 1', 'j.stats.jobsDone === 1'], ['steps', "j.completeness.steps.some((s) => s.key === 'availability' && s.done === false)"]] }),
        pro('Block the evening of the day-8 match', 'PUT', '/pro/availability/blocks', { body: { from: '{{day0}}', to: '{{day14}}', blocks: [{ start: '{{block8Start}}', end: '{{block8End}}', reason: 'Family wedding' }], repeats: [] }, expect: { status: 200 }, checks: [['one block', "j.blocks.length === 1 && j.blocks[0].reason === 'Family wedding'"]] }),
        req('The public strip: times only', 'GET', '/hire/profiles/{{profileId}}/availability?from={{day0}}&to={{day14}}', { as: false, expect: { status: 200 }, checks: [['busy', 'j.busy.length >= 1'], ['no reason', "!JSON.stringify(j).includes('wedding')"]] }),
        idem(m2('A request over the block (expect 409)', 'POST', '/hire/requests', { body: { profileId: '{{profileId}}', unit: 'match', engagements: [engagement('start8')] }, expect: { status: 409, code: 'PRO_UNAVAILABLE' } })),
        pro('Beyond the horizon (expect 422)', 'PUT', '/pro/availability/blocks', { body: { from: '{{day0}}', to: '{{day70}}', blocks: [] }, expect: { status: 422 } }),
        pro('My calendar', 'GET', '/pro/availability?from={{day0}}&to={{day14}}', { expect: { status: 200 }, checks: [['the block, 60-day horizon', 'j.spans.length === 1 && j.horizonDays === 60']] }),
        pro('Clear the calendar', 'PUT', '/pro/availability/blocks', { body: { from: '{{day0}}', to: '{{day14}}', blocks: [], repeats: [] }, expect: { status: 200 }, checks: [['empty', 'j.blocks.length === 0']] }),
        upload('A profile photo (PNG)', '/me/avatar', 'nid-back.png', 'image/png', { expect: { status: 200 }, checks: [['avatar url', "typeof j.avatarUrl === 'string' && j.avatarUrl.includes('/avatars/')"]] }),
        upload('A PDF is not a photo (expect 415)', '/me/avatar', 'nid-selfie.pdf', 'application/pdf', { expect: { status: 415, code: 'FILE_TYPE_NOT_ALLOWED' } }),
        req('The directory card shows the photo', 'GET', '/hire/profiles?category=officials', { as: false, expect: { status: 200 }, checks: [['photo', "typeof j.items[0].avatarUrl === 'string'"], ['available today', "typeof j.items[0].availableToday === 'boolean'"], ['stats', 'j.items[0].jobsDone === 1']] }),
        pro('Remove the photo', 'DELETE', '/me/avatar', { expect: { status: 200 }, checks: [['gone', 'j.avatarUrl === null']] }),
      ],
    },
  ],
};

collection.variable.push(consentVar());
fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
