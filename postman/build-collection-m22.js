'use strict';

/**
 * Builds postman/kriraghor-organisers.postman_collection.json (M14 lite organisations and M22 Esports
 * organiser SaaS step 1: an organisation reviewed on the Moderation desk, a contract, a console
 * tournament with its prize fund, organiser rooms and results, a phone-confirmed finalise with the
 * §6.2 postings and the kill cap, cancel returning the fund, a flat invoice paid, branding and the
 * subdomain page, tenant isolation, the staff desk). node postman/build-collection-m22.js
 *
 * Variables: adminAccessToken (master A), listingsToken (staff, approve_listings), mgrToken (staff,
 * manage_organisers), ownerToken (an organiser whose role and registration were approved), plainToken
 * (a member without the role), insiderToken / insiderProfileId / insiderPhone (a player who joins the
 * organisation's staff), otherToken / otherOrgId (another verified organisation's owner),
 * stepUpQueueA (esports.money), controlUrl (the runner: /settle, /body, /pay, /review, /fill, /start,
 * /close-disputes, /code, /check).
 * Unattended: `node postman/run-m22.js` (kriraghor_test database; fixtures in postman/fixtures).
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-organisers.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const owner = as('ownerToken');
const plain = as('plainToken');
const insider = as('insiderToken');
const other = as('otherToken');
const listings = as('listingsToken');
const mgr = as('mgrToken');
const master = (name, method, p, opts = {}) => req(name, method, p, { ...opts, as: 'A' });
const money = (name, method, p, opts = {}) => req(name, method, p, { ...opts, as: 'A', stepUp: true });
const idem = (item) => {
  item.request.header.push({ key: 'Idempotency-Key', value: 'pm-{{$guid}}' });
  return item;
};
/** The whole JSON body comes from a variable the runner filled (tournament bodies, result rows). */
const rawBody = (item, variable) => {
  item.request.header.push({ key: 'Content-Type', value: 'application/json' });
  item.request.body = { mode: 'raw', raw: `{{${variable}}}`, options: { raw: { language: 'json' } } };
  return item;
};
const pdf = (name, p, opts) => {
  const r = master(name, 'POST', p, opts);
  r.request.header.push({ key: 'Content-Type', value: 'application/pdf' });
  r.request.body = { mode: 'file', file: { src: 'nid-selfie.pdf' } };
  return r;
};
const control = (name, step, opts = {}) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 }, ...opts });
  const [p, qs] = step.split('?');
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [p], ...(qs ? { query: qs.split('&').map((kv) => ({ key: kv.split('=')[0], value: kv.split('=')[1] })) } : {}) };
  return r;
};
const setVar = (name, expr) => [`saves ${name}`, `(pm.collectionVariables.set('${name}', ${expr}), true)`];
const keepJson = (name, expr) => setVar(name, `JSON.stringify(${expr})`);
const ORG_RUBRIC = ['identity_matches', 'registration_valid', 'name_appropriate', 'no_contact_details'];
const con = (p) => `/org/{{orgId}}${p}`;

const collection = {
  info: {
    name: 'Kriraghor API: M22 Esports organisers (step 1)',
    description: [
      'An organiser (role and organisation registration approved on M02; set up by the runner) creates Dhaka Clutch League. A draft has no console (404); the listings desk sees the three automatic checks pass and approves it (M05 kind organisation). A player is added to its staff by phone.',
      'Master A enters a percentage contract (10%, the setting). Activating it without the signed PDF is refused; with it, and step-up esports.money, it is active.',
      'In the console a per-kill tournament without a kill cap is refused; with a cap of 5 the draft needs its prize fund first (places ৳1,500 + 5 kills × ৳100 = ৳2,000), paid by bKash on the simulator. Submitted, approved on the desk, it is published with the fee snapshotted. Branding with poor contrast or a reserved subdomain is refused; the public organiser page lists the tournament.',
      'The staff member cannot play in it (conflict of interest) but sets the room and enters the results (Q135). Finalise needs an org admin and a code sent to the phone: ৳1,600 collected, ৳160 fee, ৳1,440 to the owner, 6 kills over a cap of 5 paying ৳83.33 each, ৳0.02 back from the fund, no subsidy.',
      'Cancelling a funded draft returns the fund. The contract is ended and a flat ৳5,000 monthly contract issues its first invoice, which the owner pays. The other organisation sees nothing of this one (404). Staff: the list, a suspend (manage_organisers) and a restore (masters only).',
      'Requests named "Runner" go to the local test runner (drain events, build tournament bodies, pay through the simulator, review on the desk, move the clock, read the phone code, read the ledger).',
      'Unattended: `node postman/run-m22.js` (kriraghor_test database).',
      'Rebuild this file with: node postman/build-collection-m22.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: ['baseUrl', 'controlUrl', 'orgId', 'submissionId', 'contractId', 'flatId', 'bodyNoCap', 'bodyCap', 'bodySmall', 'tId', 't2Id', 'fundPayment', 'fund2Payment', 'matchId', 'resultsBody', 'finaliseCode', 'invoiceId', 'invoicePayment', 't3Id'].map((key) => ({
    key,
    value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '',
  })),
  item: [
    {
      name: '1. The organisation and its review (M14 lite)',
      item: [
        plain('Without the organiser role (expect 403)', 'POST', '/me/organisations', { body: { name: 'No Role Esports' }, expect: { status: 403, code: 'ORG_ROLE_REQUIRED' } }),
        owner('A draft', 'POST', '/me/organisations', { body: { name: 'Dhaka Clutch League', about: 'Weekly Free Fire scrims for Dhaka colleges.' }, expect: { status: 201 }, save: { orgId: 'id' }, checks: [['draft, owner', "j.status === 'draft' && j.role === 'owner' && j.slug === 'dhaka-clutch-league'"]] }),
        owner('A draft has no console (expect 404)', 'GET', con('/esports/dashboard'), { expect: { status: 404 } }),
        owner('Send for review', 'POST', '/me/organisations/{{orgId}}/submit', { expect: { status: 200 } }),
        control('drain events', 'settle'),
        listings('The organisation on the desk', 'GET', '/admin/submissions?status=pending_review&kind=organisation', { expect: { status: 200 }, checks: [setVar('submissionId', 'j.items[0].id')] }),
        listings('Claim: the three checks pass', 'POST', '/admin/submissions/{{submissionId}}/claim', { expect: { status: 200 }, checks: [['three, all pass', "j.checks.length === 3 && j.checks.every((c) => c.result === 'pass')"]] }),
        listings('Tick the rubric', 'PUT', '/admin/submissions/{{submissionId}}/ticks', { body: { ticks: ORG_RUBRIC }, expect: { status: 200 } }),
        idem(listings('Approve', 'POST', '/admin/submissions/{{submissionId}}/decide', { body: { decision: 'approve' }, expect: { status: 200 } })),
        control('deliver the decision', 'settle'),
        owner('Verified', 'GET', '/me/organisations/{{orgId}}', { expect: { status: 200 }, checks: [['verified', "j.status === 'verified'"]] }),
        owner('Add a player to the staff by phone', 'POST', con('/members'), { body: { phone: '{{insiderPhone}}', role: 'staff' }, expect: { status: 201 } }),
        owner('Twice (expect 409)', 'POST', con('/members'), { body: { phone: '{{insiderPhone}}', role: 'staff' }, expect: { status: 409, code: 'ORG_MEMBER_EXISTS' } }),
        insider('Staff see the console', 'GET', con('/esports/dashboard'), { expect: { status: 200 } }),
        insider('Staff cannot see billing (expect 404)', 'GET', con('/billing/invoices'), { expect: { status: 404 } }),
        plain('A stranger (expect 404)', 'GET', con('/esports/dashboard'), { expect: { status: 404 } }),
      ],
    },
    {
      name: '2. The contract (FR-01, FR-02)',
      item: [
        master('A flat fee under ৳1 a cycle is refused (expect 422)', 'POST', '/admin/organisers/{{orgId}}/contracts', { body: { model: 'flat', billingCycle: 'per_tournament', startsOn: '2026-10-01', flatFee: 1000 }, expect: { status: 422, code: 'CONTRACT_FIELDS_INVALID' } }),
        master('Percentage at the setting', 'POST', '/admin/organisers/{{orgId}}/contracts', { body: { model: 'percentage', billingCycle: 'per_tournament', startsOn: '2026-10-01' }, expect: { status: 201 }, save: { contractId: 'id' }, checks: [['draft', "j.status === 'draft'"]] }),
        money('Activate without the signed PDF (expect 409)', 'POST', '/admin/organisers/contracts/{{contractId}}/activate', { expect: { status: 409, code: 'CONTRACT_DOCUMENT_REQUIRED' } }),
        pdf('Attach the signed PDF', '/admin/organisers/contracts/{{contractId}}/document', { expect: { status: 200 } }),
        money('Activate (step-up)', 'POST', '/admin/organisers/contracts/{{contractId}}/activate', { expect: { status: 200 }, checks: [['active', "j.status === 'active'"]] }),
        control('drain events', 'settle'),
        owner('The contract in billing', 'GET', con('/billing/contracts'), { expect: { status: 200 }, checks: [['one active', "j.items.length === 1 && j.items[0].status === 'active'"]] }),
      ],
    },
    {
      name: '3. A console tournament and its prize fund (FR-04 to FR-06)',
      item: [
        control('tournament bodies', 'body', { checks: [keepJson('bodyNoCap', 'j.noCap'), keepJson('bodyCap', 'j.cap'), keepJson('bodySmall', 'j.small')] }),
        rawBody(owner('Per-kill rewards without a cap (expect 422)', 'POST', con('/esports/tournaments'), { expect: { status: 422, code: 'ESPORTS_KILL_CAP_REQUIRED' } }), 'bodyNoCap'),
        rawBody(owner('A draft with a cap of 5 kills', 'POST', con('/esports/tournaments'), { expect: { status: 201 }, save: { tId: 'id' }, checks: [['ours', "j.status === 'draft' && j.organisationId === pm.collectionVariables.get('orgId') && j.organiser.name === 'Dhaka Clutch League' && j.maxPaidKills === 5"]] }), 'bodyCap'),
        owner('Submit before funding (expect 409)', 'POST', con('/esports/tournaments/{{tId}}/submit'), { expect: { status: 409, code: 'PRIZE_FUND_REQUIRED' } }),
        idem(owner('Fund the pool', 'POST', con('/esports/tournaments/{{tId}}/prize-fund'), { expect: { status: 201 }, save: { fundPayment: 'payment.id' }, checks: [['৳2,000', 'j.payment.amount === 200000']] })),
        control('pay it by bKash on the simulator', 'pay?paymentId={{fundPayment}}'),
        owner('Funded', 'GET', con('/esports/tournaments/{{tId}}'), { expect: { status: 200 }, checks: [['funded', "j.fund.required === 200000 && j.fund.deposited === 200000 && j.fund.status === 'funded' && j.fund.block === null"]] }),
        idem(owner('Fund it again (expect 409)', 'POST', con('/esports/tournaments/{{tId}}/prize-fund'), { expect: { status: 409, code: 'PRIZE_FUND_LOCKED' } })),
        owner('Submit', 'POST', con('/esports/tournaments/{{tId}}/submit'), { expect: { status: 200 } }),
        control('approve it on the desk', 'review?kind=esports_tournament&id={{tId}}', { checks: [['published, fee snapshotted', "j.status === 'scheduled' && j.saasFeeModel === 'percentage' && j.saasFeeBps === 1000"]] }),
      ],
    },
    {
      name: '4. Branding and the organiser page (FR-11, FR-12)',
      item: [
        owner('A primary colour too light for white text (expect 422)', 'PUT', con('/branding'), { body: { primaryHex: '#c8f53c', accentHex: '#f2a33a' }, expect: { status: 422, code: 'BRAND_PRIMARY_CONTRAST' } }),
        owner('Colours and a tagline', 'PUT', con('/branding'), { body: { primaryHex: '#0B7A4B', accentHex: '#f2a33a', taglineEn: 'Weekly scrims' }, expect: { status: 200 } }),
        insider('Staff cannot change branding (expect 404)', 'PUT', con('/branding'), { body: { primaryHex: '#0B7A4B', accentHex: '#f2a33a' }, expect: { status: 404 } }),
        owner('A reserved subdomain (expect 422)', 'PUT', con('/branding/subdomain'), { body: { subdomain: 'admin' }, expect: { status: 422, code: 'SUBDOMAIN_RESERVED' } }),
        owner('Claim dhaka-clutch', 'PUT', con('/branding/subdomain'), { body: { subdomain: 'dhaka-clutch' }, expect: { status: 200 } }),
        other('Another organisation cannot take it (expect 409)', 'PUT', '/org/{{otherOrgId}}/branding/subdomain', { body: { subdomain: 'dhaka-clutch' }, expect: { status: 409, code: 'SUBDOMAIN_TAKEN' } }),
        req('The public organiser page', 'GET', '/esports/organisers/dhaka-clutch', { as: false, expect: { status: 200 }, checks: [['brand and the tournament', "j.organiser.name === 'Dhaka Clutch League' && j.organiser.primaryHex === '#0b7a4b' && j.tournaments.length === 1 && j.tournaments[0].id === pm.collectionVariables.get('tId')"]] }),
        req('An unknown subdomain (expect 404)', 'GET', '/esports/organisers/nobody-here', { as: false, expect: { status: 404 } }),
      ],
    },
    {
      name: '5. Rooms, results and the finalise (Q135, FR-07, FR-10)',
      item: [
        control('open registration', 'open?id={{tId}}'),
        idem(insider('An organisation member cannot play (expect 403)', 'POST', '/esports/tournaments/{{tId}}/registrations', { body: { players: ['{{insiderProfileId}}'] }, expect: { status: 403, code: 'ESPORTS_CONFLICT_OF_INTEREST' } })),
        control('four players pay and check in', 'fill?id={{tId}}', { save: { matchId: 'matchId' }, checks: [keepJson('resultsBody', '{ rows: j.rows }')] }),
        insider('Staff set the room', 'PUT', con('/esports/matches/{{matchId}}/room'), { body: { roomId: '55556666', password: 'clutch' }, expect: { status: 200 } }),
        other('Another organisation cannot (expect 404)', 'PUT', '/org/{{otherOrgId}}/esports/matches/{{matchId}}/room', { body: { roomId: '11112222', password: 'pw' }, expect: { status: 404 } }),
        control('the match starts', 'start?id={{tId}}'),
        rawBody(insider('Staff enter the results (6 kills)', 'PUT', con('/esports/matches/{{matchId}}/results'), { expect: { status: 200 } }), 'resultsBody'),
        insider('Post them', 'POST', con('/esports/matches/{{matchId}}/results/post'), { expect: { status: 200 } }),
        control('the dispute window closes', 'close-disputes?id={{tId}}'),
        owner('The finalise preview', 'GET', con('/esports/tournaments/{{tId}}/finalise-preview'), { expect: { status: 200 } }),
        insider('Staff cannot finalise (expect 404)', 'POST', con('/esports/tournaments/{{tId}}/finalise/code'), { expect: { status: 404 } }),
        owner('Send the code to the phone', 'POST', con('/esports/tournaments/{{tId}}/finalise/code'), { expect: { status: 200 } }),
        owner('A wrong code is refused', 'POST', con('/esports/tournaments/{{tId}}/finalise'), { body: { code: '000000' }, checks: [['4xx', 'pm.response.code >= 400 && pm.response.code < 500']] }),
        control('read the code', 'code', { save: { finaliseCode: 'code' } }),
        owner('Finalise', 'POST', con('/esports/tournaments/{{tId}}/finalise'), { body: { code: '{{finaliseCode}}' }, expect: { status: 200 }, checks: [['§6.2', "j.status === 'paid_out' && j.settlement.collected === 160000 && j.settlement.paid === 199998 && j.settlement.fee === 16000 && j.settlement.net === 144000 && j.settlement.fundReturn === 2 && j.settlement.subsidy === 0"]] }),
        control('ledger: owner ৳1,440.02, fee ৳160, escrows at zero', 'check', { checks: [['balanced', 'j.invariantsOk === true'], ['postings', 'j.ownerPayable === 144002 && j.feeRevenue === 16000 && j.entryEscrow === 0 && j.fundEscrow === 0 && j.subsidy === 0'], ['the kill cap', 'j.p1 === 100000 + 3 * 8333']] }),
      ],
    },
    {
      name: '6. Cancel returns the fund (FR-10)',
      item: [
        rawBody(owner('Another draft', 'POST', con('/esports/tournaments'), { expect: { status: 201 }, save: { t2Id: 'id' } }), 'bodySmall'),
        idem(owner('Fund it (৳1,500)', 'POST', con('/esports/tournaments/{{t2Id}}/prize-fund'), { expect: { status: 201 }, save: { fund2Payment: 'payment.id' }, checks: [['৳1,500', 'j.payment.amount === 150000']] })),
        control('pay it', 'pay?paymentId={{fund2Payment}}'),
        other('Another organisation cannot cancel it (expect 404)', 'POST', con('/esports/tournaments/{{t2Id}}/cancel'), { body: { reason: 'Not mine at all' }, expect: { status: 404 } }),
        other('Nor see it through its own console (expect 404)', 'GET', '/org/{{otherOrgId}}/esports/tournaments/{{t2Id}}', { expect: { status: 404 } }),
        owner('Cancel the funded draft', 'POST', con('/esports/tournaments/{{t2Id}}/cancel'), { body: { reason: 'Venue internet is down' }, expect: { status: 200 } }),
        control('drain events', 'settle'),
        control('ledger: the fund is back with the owner', 'check', { checks: [['balanced', 'j.invariantsOk === true'], ['+৳1,500', 'j.ownerPayable === 144002 + 150000 && j.fundEscrow === 0']] }),
      ],
    },
    {
      name: '7. A flat contract and its invoice (FR-08, FR-09)',
      item: [
        money('End the percentage contract (step-up)', 'POST', '/admin/organisers/contracts/{{contractId}}/end', { body: { reason: 'Moving to a monthly fee' }, expect: { status: 200 }, checks: [['ended', "j.status === 'ended'"]] }),
        master('৳5,000 a month', 'POST', '/admin/organisers/{{orgId}}/contracts', { body: { model: 'flat', billingCycle: 'monthly', startsOn: '2026-10-01', flatFee: 500000 }, expect: { status: 201 }, save: { flatId: 'id' } }),
        pdf('Attach the signed PDF', '/admin/organisers/contracts/{{flatId}}/document', { expect: { status: 200 } }),
        money('Activate (step-up): the first invoice', 'POST', '/admin/organisers/contracts/{{flatId}}/activate', { expect: { status: 200 } }),
        control('drain events', 'settle'),
        owner('The invoice', 'GET', con('/billing/invoices'), { expect: { status: 200 }, save: { invoiceId: 'items.0.id' }, checks: [['issued ৳5,000, no VAT', "j.items.length === 1 && /^KG-INV-\\d{2}-\\d{6}$/.test(j.items[0].number) && j.items[0].total === 500000 && j.items[0].vat === 0 && j.items[0].status === 'issued'"]] }),
        idem(owner('Pay it', 'POST', con('/billing/invoices/{{invoiceId}}/pay'), { expect: { status: 201 }, save: { invoicePayment: 'payment.id' } })),
        control('pay through the simulator', 'pay?paymentId={{invoicePayment}}'),
        owner('Paid', 'GET', con('/billing/invoices'), { expect: { status: 200 }, checks: [['paid', "j.items[0].status === 'paid'"]] }),
        mgr('Staff: the invoice list', 'GET', '/admin/organisers/invoices', { expect: { status: 200 }, checks: [['one, paid', "j.items.length === 1 && j.items[0].status === 'paid'"]] }),
        control('ledger: ৳5,000 more fee revenue', 'check', { checks: [['balanced', 'j.invariantsOk === true'], ['fee', 'j.feeRevenue === 16000 + 500000 && j.invoiceEscrow === 0']] }),
      ],
    },
    {
      name: '8. Staff (FR-13)',
      item: [
        mgr('The organisations', 'GET', '/admin/organisers', { expect: { status: 200 }, checks: [['both', 'j.items.length === 2']] }),
        mgr('One organisation with its members', 'GET', '/admin/organisers/{{orgId}}', { expect: { status: 200 }, checks: [['members', "j.status === 'verified' && j.members.length === 2"]] }),
        rawBody(owner('A draft before the suspension', 'POST', con('/esports/tournaments'), { expect: { status: 201 }, save: { t3Id: 'id' } }), 'bodySmall'),
        mgr('Suspend', 'POST', '/admin/organisers/{{orgId}}/suspend', { body: { reason: 'Fake prize screenshots' }, expect: { status: 200 } }),
        owner('Suspended: the console still opens', 'GET', con('/esports/dashboard'), { expect: { status: 200 } }),
        owner('but nothing new can be sent (expect 409)', 'POST', con('/esports/tournaments/{{t3Id}}/submit'), { expect: { status: 409, code: 'ORG_SUSPENDED' } }),
        req('and the organiser page is gone (expect 404)', 'GET', '/esports/organisers/dhaka-clutch', { as: false, expect: { status: 404 } }),
        mgr('Restoring needs a master (expect 403)', 'POST', '/admin/organisers/{{orgId}}/restore', { body: { reason: 'Checked' }, expect: { status: 403 } }),
        master('Master: restore', 'POST', '/admin/organisers/{{orgId}}/restore', { body: { reason: 'Checked with the club' }, expect: { status: 200 } }),
        req('The organiser page is back', 'GET', '/esports/organisers/dhaka-clutch', { as: false, expect: { status: 200 } }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
