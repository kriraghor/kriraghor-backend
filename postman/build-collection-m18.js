'use strict';

/**
 * Builds postman/kriraghor-risk.postman_collection.json (M18 Risk and Trust step 1).
 *   node postman/build-collection-m18.js
 *
 * Variables (set by the runner): adminAccessToken (master A), staffToken (manage_users), memberToken
 * (the second account on a shared NID, flagged critical), member1Token, userId (the flagged member),
 * stepUpQueueA (risk.manage ×3, settings.write) and controlUrl (/settle, /check).
 * Unattended: `node postman/run-m18.js` (kriraghor_test database).
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-risk.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const staff = as('staffToken');
const member = as('memberToken');
const member1 = as('member1Token');
const control = (name, step, opts = {}) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 }, ...opts });
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [step] };
  return r;
};
const setVar = (name, expr) => [`saves ${name}`, `(pm.collectionVariables.set('${name}', ${expr}), true)`];
const reason = 'Checking the shared NID with the member';

const collection = {
  info: {
    name: 'Kriraghor API: M18 Risk and Trust',
    description: [
      'Two accounts submit the same NID. The second one gets a critical accounts_per_nid flag on the risk desk, and nothing happens to it until a person acts (Q101).',
      'Staff with manage_users ask for documents, clear the flag and undo it, and suspend for up to 30 days. A master freezes payouts with a step-up code (an M07 risk_freeze hold) and undoes it. Every action is a new row with a reason.',
      'A master proposes a threshold change, which becomes an M03 change request. Reliability scores are read by the member and publicly.',
      'Requests named "Runner" go to the local test runner (deliver events and run the risk jobs; check the account).',
      'Unattended: `node postman/run-m18.js` (kriraghor_test database).',
      'Rebuild this file with: node postman/build-collection-m18.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: ['baseUrl', 'controlUrl', 'adminAccessToken', 'staffToken', 'memberToken', 'member1Token', 'userId', 'flagId', 'freezeId', 'clearId', 'suspendId'].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. The flag (FR-01 to FR-05)',
      item: [
        staff('Overview: one critical flag', 'GET', '/admin/risk/overview', { expect: { status: 200 }, checks: [['critical 1', 'j.counts.critical === 1'], ['NID rule threshold 1', "j.rules.find((r) => r.key === 'accounts_per_nid').threshold === 1"]] }),
        staff('Flags, critical first', 'GET', '/admin/risk/flags', { expect: { status: 200 }, checks: [setVar('flagId', 'j.items[0].id'), ['accounts_per_nid on the second holder', "j.items[0].ruleKey === 'accounts_per_nid' && j.items[0].user.displayName === 'Second Holder'"]] }),
        staff('The account', 'GET', '/admin/risk/accounts/{{userId}}', { expect: { status: 200 }, checks: [['critical, nothing frozen', "j.riskLevel === 'critical' && j.holds.length === 0"], ['no NID number', "!JSON.stringify(j).includes('1990')"]] }),
        member('A member cannot see the desk (expect 401)', 'GET', '/admin/risk/overview', { expect: { status: 401 } }),
      ],
    },
    {
      name: '2. Freeze and undo (FR-06, FR-09)',
      item: [
        staff('Staff freeze without a code (expect 403)', 'POST', '/admin/risk/accounts/{{userId}}/actions', { body: { action: 'freeze_payouts', flagId: '{{flagId}}', reason }, expect: { status: 403 } }),
        req('Master freezes payouts (step-up risk.manage)', 'POST', '/admin/risk/accounts/{{userId}}/actions', { stepUp: true, body: { action: 'freeze_payouts', flagId: '{{flagId}}', reason }, expect: { status: 201 }, checks: [setVar('freezeId', 'j.id'), ['freeze', "j.action === 'freeze_payouts' && j.actorRole === 'master'"]] }),
        req('Again (expect 409)', 'POST', '/admin/risk/accounts/{{userId}}/actions', { stepUp: true, body: { action: 'freeze_payouts', reason }, expect: { status: 409, code: 'ALREADY_FROZEN' } }),
        control('frozen', 'check', { checks: [['one risk_freeze hold', 'j.frozen === 1']] }),
        req('Undo the freeze (step-up risk.manage)', 'POST', '/admin/risk/actions/{{freezeId}}/undo', { stepUp: true, body: { reason: 'Identity confirmed on a call' }, expect: { status: 201 }, checks: [['unfreeze', "j.action === 'unfreeze_payouts'"]] }),
        control('unfrozen', 'check', { checks: [['no active hold', 'j.frozen === 0']] }),
      ],
    },
    {
      name: '3. Documents, clear and suspend (FR-07, FR-08, FR-10)',
      item: [
        staff('Ask for a new NID upload', 'POST', '/admin/risk/accounts/{{userId}}/actions', { body: { action: 'request_documents', flagId: '{{flagId}}', reason: 'Please upload your NID again', params: { docType: 'nid' } }, expect: { status: 201 } }),
        member('The member sees the request', 'GET', '/me/document-requests', { expect: { status: 200 }, checks: [['open NID request', "j.items[0].docType === 'nid' && j.items[0].status === 'open'"]] }),
        staff('Clear the flag', 'POST', '/admin/risk/accounts/{{userId}}/actions', { body: { action: 'clear', flagId: '{{flagId}}', reason: 'Siblings sharing a phone, explained' }, expect: { status: 201 }, checks: [setVar('clearId', 'j.id')] }),
        staff('Undo the clear: reopened', 'POST', '/admin/risk/actions/{{clearId}}/undo', { body: { reason: 'Cleared too early, reopening' }, expect: { status: 201 }, checks: [['reopen', "j.action === 'reopen'"]] }),
        staff('Suspend 31 days (expect 422)', 'POST', '/admin/risk/accounts/{{userId}}/actions', { body: { action: 'suspend', reason, params: { days: 31 } }, expect: { status: 422, code: 'SUSPENSION_TOO_LONG' } }),
        staff('Suspend 7 days', 'POST', '/admin/risk/accounts/{{userId}}/actions', { body: { action: 'suspend', reason, params: { days: 7 } }, expect: { status: 201 }, checks: [setVar('suspendId', 'j.id')] }),
        control('suspended', 'check', { checks: [['suspended', "j.status === 'suspended'"]] }),
        staff('Undo the suspension', 'POST', '/admin/risk/actions/{{suspendId}}/undo', { body: { reason: 'Documents received and fine' }, expect: { status: 201 }, checks: [['restore', "j.action === 'restore'"]] }),
        control('restored', 'check', { checks: [['active', "j.status === 'active'"]] }),
        staff('Undo twice (expect 409)', 'POST', '/admin/risk/actions/{{suspendId}}/undo', { body: { reason: 'Second try should fail' }, expect: { status: 409, code: 'ACTION_ALREADY_REVERSED' } }),
        staff('The timeline', 'GET', '/admin/risk/accounts/{{userId}}', { expect: { status: 200 }, checks: [['seven rows', 'j.actions.length === 7'], ['freeze undone', "j.actions.find((a) => a.action === 'freeze_payouts').undone === true"]] }),
      ],
    },
    {
      name: '4. Thresholds and reliability (FR-02, FR-14)',
      item: [
        staff('Staff cannot change thresholds (expect 403)', 'POST', '/admin/risk/thresholds', { body: { changes: [{ key: 'risk.reports_upheld_max', to: 5 }], reason: 'Too noisy at 3' }, expect: { status: 403 } }),
        req('Master proposes a threshold change (step-up settings.write)', 'POST', '/admin/risk/thresholds', { stepUp: true, body: { changes: [{ key: 'risk.reports_upheld_max', to: 5 }], reason: 'Too noisy at 3' }, expect: { status: 201 }, checks: [['risk desk change request', "j.source === 'risk_desk'"]] }),
        // The suspended member's sessions were revoked (M01); the other member reads their own scores.
        member1('My reliability', 'GET', '/me/trust', { expect: { status: 200 }, checks: [['a list', 'Array.isArray(j.items)']] }),
        req('Public reliability (shown scores only)', 'GET', '/trust/{{userId}}', { as: false, expect: { status: 200 }, checks: [['none shown yet', 'j.items.length === 0']] }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
