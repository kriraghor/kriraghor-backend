'use strict';

/**
 * Builds postman/kriraghor-gym-whatsapp.postman_collection.json ("M24 · WhatsApp", tester feedback item 5;
 * M24 §25, M24-FR-157..170, ADR-012): chat numbers and the gym page button; a member's consents from the desk
 * and from the member; then, with sending switched on for the run, units, connecting a number (memory
 * driver), Meta's webhook (the check, the signature, template approvals), the estimate, a notice, history,
 * the automatic kinds, refusals (no consent, no permission) and disconnecting.
 * node postman/build-collection-m24-whatsapp.js
 *
 * Variables (set by the runner, postman/run-m24-whatsapp.js): ownerToken (a Standard gym), gymId, slug,
 * deskToken (members.view, members.edit), aminToken + aminMember (linked; agrees to everything at the desk),
 * bithiMember (agreed to nothing), appSecret (the test Meta app secret), k1..k4 (Idempotency-Keys).
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-gym-whatsapp.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  if (token) r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  if (opts.key) r.request.header.push({ key: 'Idempotency-Key', value: `{{${opts.key}}}` });
  return r;
};
const owner = as('ownerToken');
const desk = as('deskToken');
const amin = as('aminToken');
const pub = as(null);
const G = '/manage/gyms/{{gymId}}';
const v = (name) => `pm.variables.get('${name}')`;

/** Meta's webhook, signed in a pre-request script with the run's app secret (or a wrong one). */
const hook = (name, body, opts = {}) => {
  const r = pub(name, 'POST', '/webhooks/whatsapp', { body, ...opts });
  r.event.unshift({
    listen: 'prerequest',
    script: {
      type: 'text/javascript',
      exec: [
        "const raw = pm.variables.replaceIn(pm.request.body.raw);",
        `const secret = ${opts.badSignature ? "'wrong-secret'" : "pm.variables.get('appSecret')"};`,
        "pm.request.headers.upsert({ key: 'X-Hub-Signature-256', value: 'sha256=' + CryptoJS.HmacSHA256(raw, secret).toString() });",
      ],
    },
  });
  return r;
};

const CODES = ['kg_receipt', 'kg_renewal_due', 'kg_ends_today', 'kg_overdue', 'kg_pay_link', 'kg_update', 'kg_notice', 'kg_greeting'];
const approvals = {
  object: 'whatsapp_business_account',
  entry: [{ id: '1110001', changes: CODES.flatMap((code) => ['en', 'bn'].map((lang) => ({ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_name: code, message_template_language: lang } }))) }],
};
const segment = { kind: 'active' };

const collection = {
  info: {
    name: 'Kriraghor API: M24 · WhatsApp',
    description: [
      'M24 §25 (tester feedback item 5; product owner 19 and 21 Nov 2026; ADR-012). Step 1 works today: the owner’s WhatsApp number for every branch, a branch’s own number, the gym page button, and members’ consents (receipts and reminders; news and offers).',
      'Step 2 is built and switched off (gym_whatsapp.api_enabled); this run switches it on against the memory driver: each gym’s own WhatsApp Business number, Kriraghor’s templates, units resold by Kriraghor, Meta’s webhook.',
      'Unattended: `node postman/run-m24-whatsapp.js`. Rebuild this file with: node postman/build-collection-m24-whatsapp.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: ['baseUrl', 'ownerToken', 'deskToken', 'aminToken', 'gymId', 'slug', 'aminMember', 'bithiMember', 'appSecret', 'k1', 'k2', 'k3', 'k4', 'senderId'].map((key) => ({
    key,
    value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '',
  })),
  item: [
    {
      name: '1. Chat numbers and the gym page (M24-FR-157, FR-158)',
      item: [
        owner('A number that is not a Bangladesh mobile', 'PUT', '/manage/whatsapp/number', { body: { number: '01212345678' }, expect: { status: 422, code: 'VALIDATION_FAILED' } }),
        owner('The owner’s number for every branch', 'PUT', '/manage/whatsapp/number', {
          body: { number: '01712345678' },
          expect: { status: 200 },
          checks: [['stored as E.164 and used by the branch', "j.number === '+8801712345678' && j.gyms[0].source === 'owner' && j.gyms[0].shown === '+8801712345678'"]],
        }),
        pub('The gym page shows it', 'GET', '/gym/gyms/{{slug}}', { expect: { status: 200 }, checks: [['whatsapp', "j.whatsapp === '+8801712345678'"]] }),
        owner('The branch’s own number wins', 'PATCH', `${G}/whatsapp`, {
          body: { number: '01812345678' },
          expect: { status: 200 },
          checks: [['own', "j.source === 'own' && j.shown === '+8801812345678' && j.ownerNumber === '+8801712345678'"]],
        }),
        pub('The gym page shows the branch’s number', 'GET', '/gym/gyms/{{slug}}', { expect: { status: 200 }, checks: [['whatsapp', "j.whatsapp === '+8801812345678'"]] }),
        desk('Staff may not change it', 'PATCH', `${G}/whatsapp`, { body: { showOnPage: false }, expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
      ],
    },
    {
      name: '2. A member’s WhatsApp consents (M24-FR-159, FR-160)',
      item: [
        desk('The desk records Amin’s answer (his phone, both)', 'PUT', `${G}/members/{{aminMember}}/whatsapp`, {
          body: { service: true, news: true },
          expect: { status: 200 },
          checks: [['desk, last 4 only', "j.source === 'desk' && j.service && j.news && /^\\d{4}$/.test(j.numberLast4) && !/01\\d{9}/.test(pm.response.text())"]],
        }),
        amin('Amin reads his own', 'GET', '/me/gym-whatsapp/{{aminMember}}', { expect: { status: 200 }, checks: [['his number and the gym', "/^\\+8801\\d{9}$/.test(j.number) && j.gymName.length > 0 && j.currentVersion === 1"]] }),
        amin('Amin keeps receipts, stops news (and back on)', 'PUT', '/me/gym-whatsapp/{{aminMember}}', { body: { number: null, service: true, news: true }, expect: { status: 200 }, checks: [['member', "j.service === true && j.news === true"]] }),
        amin('Somebody else’s membership is not found', 'GET', '/me/gym-whatsapp/{{bithiMember}}', { expect: { status: 404 } }),
      ],
    },
    {
      name: '3. Units and connecting a number (M24-FR-161 to FR-163, FR-166)',
      item: [
        owner('Switch WhatsApp on (the month’s allowance)', 'PUT', '/manage/billing/whatsapp-addon', { body: { enabled: true }, expect: { status: 200 }, checks: [['on with 20 units', "j.status === 'active' && j.balance === 20"]] }),
        owner('Connect without an Idempotency-Key', 'POST', '/manage/whatsapp/senders', { body: { code: 'code-123', wabaId: '1110001', phoneNumberId: '2220002' }, expect: { status: 400 } }),
        owner('Connect the number from the embedded sign-up', 'POST', '/manage/whatsapp/senders', {
          key: 'k1',
          body: { code: 'code-123', wabaId: '1110001', phoneNumberId: '2220002' },
          expect: { status: 201 },
          save: { senderId: '0.id' },
          checks: [['16 templates pending, no token', "j.length === 1 && j[0].templates.pending === 16 && !/token/i.test(pm.response.text())"]],
        }),
        owner('The branch sends from it', 'GET', `${G}/whatsapp`, { expect: { status: 200 }, checks: [['sender', `j.senderId === ${v('senderId')} && j.sender.status === 'connected'`]] }),
      ],
    },
    {
      name: '4. Meta’s webhook (M24-FR-169)',
      item: [
        pub('Meta’s check with the right token', 'GET', '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=42', { expect: { status: 200 }, checks: [['the challenge', "pm.response.text() === '42'"]] }),
        pub('Meta’s check with a wrong token', 'GET', '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42', { expect: { status: 403 } }),
        hook('A wrong signature', approvals, { badSignature: true, expect: { status: 401, code: 'WEBHOOK_SIGNATURE_INVALID' } }),
        hook('Meta approves the 16 templates', approvals, { expect: { status: 200 }, checks: [['16 changes', 'j.handled === 16']] }),
      ],
    },
    {
      name: '5. Sending (M24-FR-164 to FR-168, FR-170)',
      item: [
        owner('Estimate a notice to active members', 'POST', `${G}/whatsapp/estimate`, {
          body: { kind: 'notice', segment },
          expect: { status: 200 },
          checks: [['Amin only; 4 units of 20', 'j.members === 2 && j.reachable === 1 && j.no_consent === 1 && j.unitsNeeded === 4 && j.balance === 20']],
        }),
        desk('Staff without whatsapp.send', 'POST', `${G}/whatsapp/estimate`, { body: { kind: 'notice', segment }, expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        owner('Send the notice', 'POST', `${G}/whatsapp/sends`, {
          key: 'k2',
          body: { kind: 'notice', segment, title: 'New Zumba class', message: 'From Monday at 7 pm.' },
          expect: { status: 201 },
          checks: [['queued to Amin, 4 units held', "j.kind === 'notice' && j.targetCount === 2 && j.queuedCount === 1 && j.unitsHeld === 4"]],
        }),
        owner('History', 'GET', `${G}/whatsapp/sends`, { expect: { status: 200 }, checks: [['one send, one left today', "j.items.length === 1 && j.bulkLeft === 1"]] }),
        owner('Amin’s messages', 'GET', `${G}/whatsapp/messages?memberId={{aminMember}}`, { expect: { status: 200 }, checks: [['the notice text, no number', "j.items[0].text.includes('New Zumba class') && !/\\+880/.test(pm.response.text())"]] }),
        owner('A single update to Bithi, who agreed to nothing', 'POST', `${G}/whatsapp/sends`, { key: 'k3', body: { kind: 'single', memberId: '{{bithiMember}}', message: 'Hi' }, expect: { status: 409, code: 'GYM_WHATSAPP_BLOCKED' }, checks: [['no consent', "j.reason === 'no_consent'"]] }),
        owner('Receipts go on WhatsApp automatically', 'PATCH', `${G}/whatsapp`, { body: { autoKinds: ['receipt', 'overdue'] }, expect: { status: 200 }, checks: [['kinds', "j.autoKinds.join() === 'receipt,overdue'"]] }),
      ],
    },
    {
      name: '6. Disconnecting (M24-FR-161)',
      item: [
        owner('Disconnect the number', 'POST', '/manage/whatsapp/senders/{{senderId}}/disconnect', { expect: { status: 200 }, checks: [['none left', 'j.length === 0']] }),
        owner('Sending now needs a number', 'POST', `${G}/whatsapp/sends`, { key: 'k4', body: { kind: 'notice', segment, title: 'Again', message: 'Again' }, expect: { status: 409, code: 'GYM_WHATSAPP_NO_SENDER' } }),
        owner('Twice is refused', 'POST', '/manage/whatsapp/senders/{{senderId}}/disconnect', { expect: { status: 409, code: 'GYM_WHATSAPP_SENDER_STATE' } }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
