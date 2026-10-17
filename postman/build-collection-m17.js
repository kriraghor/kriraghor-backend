'use strict';

/**
 * Builds postman/kriraghor-disputes.postman_collection.json (M17 Disputes, Reports and Reviews step 1).
 *   node postman/build-collection-m17.js
 *
 * Variables (set by the runner): adminAccessToken (master A), ownerToken (a live ground at ৳2,000/h,
 * 25% advance), memberToken / member2Token, staffToken (resolve_reports + refund_small), staff2Token
 * (resolve_reports), opsToken (resolve_reports + manage_users), r1Token…r3Token (eligible reporters),
 * targetUserId, the bookings b1 (a no-show, ৳500 retained), b2 and b3 (played), stepUpQueueA
 * (refund.large) and controlUrl (the runner: /noshow, /tick, /dtick, /check, /settle).
 * Unattended: `node postman/run-m17.js` (kriraghor_test database; fixtures in postman/fixtures).
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-disputes.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const member = as('memberToken');
const member2 = as('member2Token');
const owner = as('ownerToken');
const staff = as('staffToken');
const staff2 = as('staff2Token');
const ops = as('opsToken');
const reporter = (n) => as(`r${n}Token`);
const idem = (item) => {
  item.request.header.push({ key: 'Idempotency-Key', value: 'pm-{{$guid}}' });
  return item;
};
const control = (name, step, opts = {}) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 }, ...opts });
  const [p, qs] = step.split('?');
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [p], ...(qs ? { query: qs.split('&').map((kv) => ({ key: kv.split('=')[0], value: kv.split('=')[1] })) } : {}) };
  return r;
};
const setVar = (name, expr) => [`saves ${name}`, `(pm.collectionVariables.set('${name}', ${expr}), true)`];
const upload = (who, name, file, mime, opts) => {
  const r = who(name, 'POST', '/me/disputes/{{code1}}/evidence', opts);
  r.request.header.push({ key: 'Content-Type', value: mime });
  r.request.body = { mode: 'file', file: { src: file } };
  return r;
};
const open = (who, name, booking, opts) =>
  idem(who(name, 'POST', '/disputes', { body: { sourceType: 'booking', sourceId: `{{${booking}}}`, category: 'no_show_contest', statement: 'We were at the gate at 6 and it was locked' }, ...opts }));

const collection = {
  info: {
    name: 'Kriraghor API: M17 Disputes, Reports and Reviews',
    description: [
      'A ৳2,000 booking with a 25% advance is marked a no-show: the ৳500 advance waits in escrow for the dispute window. The member contests it with a photo; the hold is frozen, so the tick cannot release it. The owner answers; staff claim the case (one reviewer at a time), see what each outcome moves, and decide half: ৳250 back to the member, ৳237.50 to the owner, ৳12.50 fee.',
      'A second no-show goes unanswered (the respondent window ends). The staff refund limit is ৳300, so a full refund is escalated with a recommendation and a master decides it with step-up. A third case is withdrawn and the tick then releases ৳475 / ৳25.',
      'Played bookings are rated; links send a review to staff; the owner replies. Three eligible reporters hide a review at once and staff restore it; suspending a reported member needs manage_users and goes through M01.',
      'Requests named "Runner" go to the local test runner (a new no-show, the minute ticks as if hours later, ledger balances).',
      'Unattended: `node postman/run-m17.js` (kriraghor_test database).',
      'Rebuild this file with: node postman/build-collection-m17.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    'baseUrl', 'controlUrl', 'adminAccessToken', 'ownerToken', 'memberToken', 'member2Token', 'staffToken', 'staff2Token', 'opsToken', 'r1Token', 'r2Token', 'r3Token',
    'targetUserId', 'groundId', 'groundSlug', 'b1', 'b2', 'b3', 'b4', 'b5', 'code1', 'code2', 'code3', 'ev1', 'version1', 'review1', 'review2',
  ].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. A contested no-show, decided by staff (FR-01 to FR-13)',
      item: [
        member('What I can dispute', 'GET', '/me/disputes/options?sourceId={{b1}}', { expect: { status: 200 }, checks: [['no-show contest, ৳500 held', "j.items.length === 1 && j.items[0].category === 'no_show_contest' && j.items[0].held === 50000"]] }),
        open(owner, 'The owner cannot dispute (expect 403)', 'b1', { expect: { status: 403, code: 'NOT_YOUR_BOOKING' } }),
        open(member, 'Open: the advance is frozen', 'b1', { expect: { status: 201 }, checks: [setVar('code1', 'j.dispute.code'), ['awaiting the owner', "j.dispute.status === 'awaiting_response' && j.dispute.held === 50000 && j.dispute.money === true"]] }),
        open(member, 'Again (expect 409)', 'b1', { expect: { status: 409, code: 'DISPUTE_ALREADY_OPEN' } }),
        upload(member, 'A photo (typed by its bytes)', 'nid-back.png', 'image/png', { expect: { status: 201 }, checks: [setVar('ev1', 'j.evidence.id'), ['png', "j.evidence.file.mime === 'image/png'"]] }),
        upload(member, 'A GIF (expect 415)', 'not-allowed.gif', 'image/gif', { expect: { status: 415, code: 'FILE_TYPE' } }),
        control('the window passes: a frozen advance waits', 'tick?plusHours=49', { checks: [['nothing settled', 'j.tick.noShowsSettled === 0']] }),
        owner('My cases as the respondent', 'GET', '/me/disputes?role=respondent', { expect: { status: 200 }, checks: [['one', "j.items.length === 1 && j.items[0].code === pm.collectionVariables.get('code1')"]] }),
        owner('Answer', 'POST', '/me/disputes/{{code1}}/respond', { body: { text: 'Nobody came; the CCTV shows an empty court' }, expect: { status: 200 }, checks: [['under review', "j.dispute.status === 'under_review'"]] }),
        owner('Read the photo', 'GET', '/me/disputes/{{code1}}/evidence/{{ev1}}/file', { expect: { status: 200 }, checks: [['no-store', "pm.response.headers.get('Cache-Control') === 'no-store'"]] }),
        staff2('The queue', 'GET', '/admin/disputes', { expect: { status: 200 }, checks: [['listed', "j.items.some((d) => d.code === pm.collectionVariables.get('code1'))"]] }),
        idem(staff('Decide unclaimed (expect 403)', 'POST', '/admin/disputes/{{code1}}/decide', { body: { outcome: 'half', reason: 'Half back' }, expect: { status: 403, code: 'CLAIM_REQUIRED' } })),
        staff('Claim: what each outcome moves', 'POST', '/admin/disputes/{{code1}}/claim', {
          expect: { status: 200 },
          checks: [setVar('version1', 'j.dispute.version'), ['previews', 'j.previews.all.refund === 50000 && j.previews.half.refund === 25000 && j.previews.half.net === 23750 && j.previews.none.net === 47500 && j.previews.none.fee === 2500']],
        }),
        staff2('Another reviewer (expect 409)', 'POST', '/admin/disputes/{{code1}}/claim', { expect: { status: 409, code: 'CLAIMED_BY_OTHER' } }),
        staff('Staff note (never shown to the parties)', 'POST', '/admin/disputes/{{code1}}/notes', { body: { text: 'Owner has not shared the CCTV' }, expect: { status: 200 } }),
        staff('Read the photo (audited)', 'GET', '/admin/disputes/{{code1}}/evidence/{{ev1}}/file', { expect: { status: 200 } }),
        member('The member never sees staff notes', 'GET', '/me/disputes/{{code1}}', { expect: { status: 200 }, checks: [['no staff party', "!j.evidence.some((e) => e.party === 'staff') && j.role === 'claimant'"]] }),
        idem(staff('A custom refund above what is held (expect 422)', 'POST', '/admin/disputes/{{code1}}/decide', { body: { outcome: 'custom', refund: 60000, reason: 'Too much' }, expect: { status: 422, code: 'REFUND_INVALID' } })),
        idem(
          staff('Decide half: ৳250 back, owner ৳237.50, fee ৳12.50', 'POST', '/admin/disputes/{{code1}}/decide', {
            body: { outcome: 'half', reason: 'The gate was locked for part of the hour' },
            expect: { status: 200 },
            checks: [['resolved', "j.dispute.status === 'resolved' && j.dispute.refund === 25000 && j.dispute.released === 25000 && j.dispute.fee === 1250"]],
          })
        ),
        member('My booking after the decision', 'GET', '/me/bookings/{{b1}}', { expect: { status: 200 }, checks: [['money', 'j.booking.money.refund === 25000 && j.booking.money.retained === 25000 && j.booking.money.released === 25000']] }),
        control('ledger', 'check', { checks: [['owner ৳800 for two played bookings + ৳237.50', 'j.ownerPayable === 103750'], ['invariants', 'j.invariantsOk === true']] }),
      ],
    },
    {
      name: '2. No answer, above the staff limit, a master decides (§6.3)',
      item: [
        control('a second no-show', 'noshow?who=member2', { checks: [setVar('b4', 'j.bookingId')] }),
        open(member2, 'Open', 'b4', { expect: { status: 201 }, checks: [setVar('code2', 'j.dispute.code')] }),
        control('the respondent window ends', 'dtick?plusHours=49', { checks: [['timed out', 'j.tick.timedOut === 1']] }),
        staff('Claim', 'POST', '/admin/disputes/{{code2}}/claim', { expect: { status: 200 }, checks: [['under review', "j.dispute.status === 'under_review'"]] }),
        idem(staff('Full refund above the ৳300 limit (expect 403)', 'POST', '/admin/disputes/{{code2}}/decide', { body: { outcome: 'all', reason: 'No answer from the venue' }, expect: { status: 403, code: 'ESCALATION_REQUIRED' } })),
        staff('Escalate with a recommendation', 'POST', '/admin/disputes/{{code2}}/escalate', { body: { outcome: 'all', note: 'Recommend a full refund' }, expect: { status: 200 }, checks: [['escalated', "j.dispute.status === 'escalated' && j.dispute.recommendedRefund === 50000"]] }),
        req('The master inbox', 'GET', '/admin/disputes?status=escalated', { expect: { status: 200 }, checks: [['listed', "j.items.some((d) => d.code === pm.collectionVariables.get('code2'))"]] }),
        idem(req('Master decide without step-up (expect 403)', 'POST', '/admin/disputes/{{code2}}/master-decide', { body: { outcome: 'all', reason: 'Full refund' }, expect: { status: 403 } })),
        idem(
          req('Master decide all (step-up refund.large)', 'POST', '/admin/disputes/{{code2}}/master-decide', {
            stepUp: true,
            body: { outcome: 'all', reason: 'The venue never answered' },
            expect: { status: 200 },
            checks: [['resolved by a master', "j.dispute.status === 'resolved' && j.dispute.refund === 50000 && j.dispute.decidedRole === 'master'"]],
          })
        ),
        control('ledger', 'check', { checks: [['owner unchanged', 'j.ownerPayable === 103750']] }),
      ],
    },
    {
      name: '3. Withdraw: the hold settles as usual (FR-07)',
      item: [
        control('a third no-show', 'noshow?who=member', { checks: [setVar('b5', 'j.bookingId')] }),
        open(member, 'Open', 'b5', { expect: { status: 201 }, checks: [setVar('code3', 'j.dispute.code')] }),
        member('Withdraw', 'POST', '/me/disputes/{{code3}}/withdraw', { body: { reason: 'Sorted it out with the owner' }, expect: { status: 200 }, checks: [['withdrawn', "j.dispute.status === 'withdrawn'"]] }),
        control('the window closes: ৳475 / ৳25', 'tick?plusHours=49', { checks: [['settled', 'j.tick.noShowsSettled === 1']] }),
        control('ledger', 'check', { checks: [['owner + ৳475', 'j.ownerPayable === 151250'], ['invariants', 'j.invariantsOk === true']] }),
        member('My cases', 'GET', '/me/disputes', { expect: { status: 200 }, checks: [['two', 'j.items.length === 2']] }),
      ],
    },
    {
      name: '4. Reviews (FR-20 to FR-26, Q98)',
      item: [
        member('Waiting for a rating', 'GET', '/me/reviewable', { expect: { status: 200 }, checks: [['b2', "j.items.some((x) => x.bookingId === pm.variables.get('b2'))"]] }),
        member('Rate a no-show (expect 409)', 'POST', '/reviews', { body: { bookingId: '{{b1}}', stars: 5 }, expect: { status: 409, code: 'NOT_PLAYED' } }),
        member('Rate b2: 4 stars', 'POST', '/reviews', { body: { bookingId: '{{b2}}', stars: 4, text: 'Good turf, friendly staff' }, expect: { status: 201 }, checks: [setVar('review1', 'j.review.id'), ['published', "j.review.status === 'published'"]] }),
        member('Twice (expect 409)', 'POST', '/reviews', { body: { bookingId: '{{b2}}', stars: 4 }, expect: { status: 409, code: 'REVIEW_EXISTS' } }),
        member2('Rate b3 with a link: held for staff', 'POST', '/reviews', { body: { bookingId: '{{b3}}', stars: 5, text: 'Cheaper at turfdeals.bd' }, expect: { status: 201 }, checks: [setVar('review2', 'j.review.id'), ['held', "j.review.status === 'held' && j.review.heldReason === 'content'"]] }),
        staff('Held reviews', 'GET', '/admin/reviews?status=held', { expect: { status: 200 }, checks: [['one', "j.items.length === 1 && j.items[0].id === pm.collectionVariables.get('review2')"]] }),
        staff('Publish it', 'POST', '/admin/reviews/{{review2}}/publish', { expect: { status: 200 }, checks: [['published', "j.review.status === 'published'"]] }),
        owner('Reviews of my grounds', 'GET', '/me/ground-reviews', { expect: { status: 200 }, checks: [['two', 'j.items.length === 2']] }),
        owner('Reply', 'POST', '/me/ground-reviews/{{review1}}/reply', { body: { text: 'Thank you, see you again' }, expect: { status: 200 }, checks: [['reply', "j.review.reply.text === 'Thank you, see you again'"]] }),
        req('Public reviews: the average shows from 3', 'GET', '/grounds/{{groundId}}/reviews', { as: false, expect: { status: 200 }, checks: [['two, no average yet', 'j.summary.count === 2 && j.summary.avg === null && j.items.length === 2']] }),
      ],
    },
    {
      name: '5. Reports (FR-15 to FR-19, Q99)',
      item: [
        member('Report my own review (expect 422)', 'POST', '/reports', { body: { subjectType: 'review', subjectId: '{{review1}}', reasonCode: 'offensive' }, expect: { status: 422, code: 'REPORT_SELF' } }),
        reporter(1)('Report 1 of 3', 'POST', '/reports', { body: { subjectType: 'review', subjectId: '{{review1}}', reasonCode: 'offensive' }, expect: { status: 201 } }),
        reporter(1)('Again (expect 409)', 'POST', '/reports', { body: { subjectType: 'review', subjectId: '{{review1}}', reasonCode: 'spam' }, expect: { status: 409, code: 'REPORT_DUPLICATE' } }),
        reporter(2)('Report 2 of 3', 'POST', '/reports', { body: { subjectType: 'review', subjectId: '{{review1}}', reasonCode: 'offensive' }, expect: { status: 201 } }),
        reporter(3)('Report 3 of 3: hidden at once', 'POST', '/reports', { body: { subjectType: 'review', subjectId: '{{review1}}', reasonCode: 'offensive' }, expect: { status: 201 } }),
        req('Hidden from the public', 'GET', '/grounds/{{groundId}}/reviews', { as: false, expect: { status: 200 }, checks: [['one left', "j.items.length === 1 && !j.items.some((x) => x.id === pm.collectionVariables.get('review1'))"]] }),
        staff('The reports queue: flagged first', 'GET', '/admin/reports', { expect: { status: 200 }, checks: [['flagged', "j.items[0].subjectType === 'review' && j.items[0].eligible === 3 && j.items[0].flagged === true"]] }),
        staff('The subject', 'GET', '/admin/reports/subjects/review/{{review1}}', { expect: { status: 200 }, checks: [['three reports', 'j.items.length === 3']] }),
        staff('No violation: restored', 'POST', '/admin/reports/resolve', { body: { subjectType: 'review', subjectId: '{{review1}}', action: 'no_violation', note: 'Fair comment' }, expect: { status: 200 }, checks: [['resolved', 'j.resolved === 3']] }),
        reporter(1)('Report a member', 'POST', '/reports', { body: { subjectType: 'user', subjectId: '{{targetUserId}}', reasonCode: 'fraud', note: 'Asked me to pay outside the app' }, expect: { status: 201 } }),
        staff('Suspend without manage_users (expect 403)', 'POST', '/admin/reports/resolve', { body: { subjectType: 'user', subjectId: '{{targetUserId}}', action: 'user_suspended', note: 'Off-platform payments' }, expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        ops('Suspend through M01', 'POST', '/admin/reports/resolve', { body: { subjectType: 'user', subjectId: '{{targetUserId}}', action: 'user_suspended', note: 'Off-platform payments' }, expect: { status: 200 }, checks: [['one', "j.resolved === 1 && j.action === 'user_suspended'"]] }),
        reporter(1)('My reports and their outcomes', 'GET', '/me/reports', { expect: { status: 200 }, checks: [['both resolved', "j.items.length === 2 && j.items.every((x) => x.status === 'resolved')"]] }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
