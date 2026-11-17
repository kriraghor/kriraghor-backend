'use strict';

/**
 * Builds postman/kriraghor-gym-offline.postman_collection.json ("M24 · The desk through a lost connection",
 * product owner, 11 Nov 2026; M24 §22, M24-FR-144..152): the desk copy and who gets the dues in it; items
 * taken offline sent once (the same key replays, another sign-in reads the same item), applied at the time
 * taken, a cash fee with its receipt and slip, flagged (would block), parked (due already paid), malformed
 * ones refused, a sender without the permission refused; the owner's list and its resolutions.
 * node postman/build-collection-m24-offline.js
 *
 * Variables (set by the runner, postman/run-m24-offline.js): ownerToken (a Basic gym), gymId, deskToken
 * (attendance.mark, fees.collect, members.view), doorToken (attendance.mark), coachToken (plans.manage),
 * rafiqMember + rafiqDue (Monthly from today, ৳1,000 of ৳3,500 paid), tanvirMember (his month ended, the
 * due is overdue), c1..c7 (client ids). The copy's stamp and server time are saved from the first request;
 * each item's elapsedMs is set before it is sent. Unattended: `node postman/run-m24-offline.js`.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-gym-offline.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const owner = as('ownerToken');
const desk = as('deskToken');
const door = as('doorToken');
const coach = as('coachToken');
const G = '/manage/gyms/{{gymId}}';
const v = (name) => `pm.variables.get('${name}')`;

/** An item sent offline: the Idempotency-Key is its client id; elapsedMs is the time since the copy arrived. */
const item = (who, name, clientVar, body, opts) => {
  const r = who(name, 'POST', `${G}/desk/offline-items`, { body: { clientId: `{{${clientVar}}}`, stamp: '{{stamp}}', elapsedMs: '{{elapsedMs}}', ...body }, ...opts });
  r.request.body.raw = r.request.body.raw.replace('"{{elapsedMs}}"', '{{elapsedMs}}');
  r.request.header.push({ key: 'Idempotency-Key', value: `{{${clientVar}}}` });
  // The device keeps the body it took, so a resend is byte for byte the same: the time is fixed per client id.
  r.event.unshift({
    listen: 'prerequest',
    script: {
      type: 'text/javascript',
      exec: [
        `const k = 'elapsed_${clientVar}';`,
        "if (!pm.collectionVariables.get(k)) pm.collectionVariables.set(k, String(Math.max(0, Date.now() - Date.parse(pm.collectionVariables.get('serverTime')))));",
        "pm.variables.set('elapsedMs', pm.collectionVariables.get(k));",
      ],
    },
  });
  return r;
};

const collection = {
  info: {
    name: 'Kriraghor API: M24 · The desk through a lost connection',
    description: [
      'M24 §22 (product owner, 11 Nov 2026): while online the front desk keeps a copy of the members (and, with fees.collect, the open dues), stamped and signed by the server. Without a connection it checks members in and takes cash with a temporary slip; each item waits on the device and is sent once when the connection is back.',
      'Nothing well formed is refused: applied, flagged (would block, time adjusted, late, drawer closed, PIN checked on the device, person not confirmed) or parked (due already paid or voided, member removed). The owner and fees.adjust staff resolve flagged and parked items.',
      'Unattended: `node postman/run-m24-offline.js`. Rebuild this file with: node postman/build-collection-m24-offline.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: ['baseUrl', 'ownerToken', 'deskToken', 'doorToken', 'coachToken', 'gymId', 'rafiqMember', 'rafiqDue', 'tanvirMember', 'tanvirDue', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'stamp', 'serverTime', 'elapsedMs', 'item1', 'flaggedItem', 'parkedItem'].map((key) => ({
    key,
    value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '',
  })),
  item: [
    {
      name: '1. The desk copy (M24-FR-144)',
      item: [
        desk('The copy, with the open dues (fees.collect)', 'GET', `${G}/desk/snapshot`, {
          expect: { status: 200 },
          save: { stamp: 'stamp', serverTime: 'serverTime' },
          checks: [
            ['today, refreshed every 10 minutes', 'j.refreshMinutes === 10 && j.maxHours === 24 && /^v1\\.gso\\./.test(j.stamp)'],
            ['Rafiq may come in; Tanvir with a warning (expired, unpaid)', `j.members.find((m) => m.id === ${v('rafiqMember')}).decision === 'allow' && j.members.find((m) => m.id === ${v('tanvirMember')}).reasons.join() === 'expired,unpaid'`],
            ['the dues with what is still owed', `j.dues.find((d) => d.id === ${v('rafiqDue')}).outstandingPoisha === 250000`],
            ['no full phone number', "!/01\\d{9}/.test(pm.response.text())"],
          ],
        }),
        door('Check-ins only: no dues in the copy', 'GET', `${G}/desk/snapshot`, { expect: { status: 200 }, checks: [['dues null', 'j.dues === null']] }),
        coach('No attendance.mark (expect 403)', 'GET', `${G}/desk/snapshot`, { expect: { status: 403 } }),
      ],
    },
    {
      name: '2. Sending what was taken offline (M24-FR-146 to FR-149)',
      item: [
        item(desk, 'A check-in: applied, counted, at the time taken', 'c1', { kind: 'checkin', memberId: '{{rafiqMember}}', takenBy: '{{deskUser}}' }, {
          expect: { status: 201 },
          save: { item1: 'item.id' },
          checks: [['applied for the clerk', "j.item.outcome === 'applied' && j.item.flags.length === 0 && j.item.kind === 'checkin' && j.item.attendanceId !== null"]],
        }),
        item(desk, 'Sent again: the same answer', 'c1', { kind: 'checkin', memberId: '{{rafiqMember}}', takenBy: '{{deskUser}}' }, { expect: { status: 201 }, checks: [['the same item', `j.item.id === ${v('item1')}`]] }),
        item(owner, 'From another sign-in: the same item (200)', 'c1', { kind: 'checkin', memberId: '{{rafiqMember}}', takenBy: '{{deskUser}}' }, { expect: { status: 200 }, checks: [['the same item', `j.item.id === ${v('item1')}`]] }),
        item(desk, 'Cash with a slip: a receipt now, dated the day taken', 'c2', { kind: 'cash_fee', memberId: '{{rafiqMember}}', dueId: '{{rafiqDue}}', amountPoisha: 150000, slipNo: 'T-PM7Q2X', takenBy: '{{deskUser}}' }, {
          expect: { status: 201 },
          checks: [['applied, with a receipt number', "j.item.outcome === 'applied' && j.item.slipNo === 'T-PM7Q2X' && /-R\\d{2}-\\d{6}$/.test(j.item.receipt.receiptNo)"]],
        }),
        owner('The gym now blocks expired members', 'PATCH', `${G}/settings`, { body: { entryPolicy: 'block' }, expect: { status: 200 } }),
        item(desk, 'Tanvir, let in offline: flagged would_block', 'c3', { kind: 'checkin', memberId: '{{tanvirMember}}', takenBy: '{{deskUser}}' }, {
          expect: { status: 201 },
          save: { flaggedItem: 'item.id' },
          checks: [['recorded, to check', "j.item.outcome === 'flagged' && j.item.flags.join() === 'would_block'"]],
        }),
        (() => {
          const r = owner('Rafiq pays the rest at the counter', 'POST', `${G}/dues/{{rafiqDue}}/payments`, { body: { amountPoisha: 100000, method: 'cash' }, expect: { status: 201 } });
          r.request.header.push({ key: 'Idempotency-Key', value: 'off-{{$guid}}' });
          return r;
        })(),
        item(desk, 'More cash for the paid due: parked', 'c4', { kind: 'cash_fee', memberId: '{{rafiqMember}}', dueId: '{{rafiqDue}}', amountPoisha: 50000, slipNo: 'T-9KD3LA', takenBy: '{{deskUser}}' }, {
          expect: { status: 201 },
          save: { parkedItem: 'item.id' },
          checks: [['not recorded: the due was paid', "j.item.outcome === 'parked' && j.item.parkReason === 'due_paid' && j.item.receipt === null"]],
        }),
        (() => {
          const r = item(desk, 'A stamp the server did not make (expect 422)', 'c5', { kind: 'checkin', memberId: '{{rafiqMember}}', takenBy: '{{deskUser}}' }, { expect: { status: 422, code: 'GYM_OFFLINE_STAMP_INVALID' } });
          r.request.body.raw = r.request.body.raw.replace('"{{stamp}}"', '"v1.gso.{{gymId}}.1763370000000.00000000000000000000000000000000"');
          return r;
        })(),
        item(desk, 'Cash without a slip (expect 422)', 'c6', { kind: 'cash_fee', memberId: '{{rafiqMember}}', dueId: '{{rafiqDue}}', amountPoisha: 10000, takenBy: '{{deskUser}}' }, { expect: { status: 422, code: 'VALIDATION_FAILED' } }),
        item(door, 'Cash from someone without fees.collect (expect 403)', 'c7', { kind: 'cash_fee', memberId: '{{tanvirMember}}', dueId: '{{tanvirDue}}', amountPoisha: 10000, slipNo: 'T-DOOR42', takenBy: '{{deskUser}}' }, { expect: { status: 403 } }),
      ],
    },
    {
      name: '3. The owner’s list (M24-FR-150)',
      item: [
        desk('Not for fees.collect alone (expect 403)', 'GET', `${G}/desk/offline-items`, { expect: { status: 403 } }),
        owner('To check: the flagged and the parked item', 'GET', `${G}/desk/offline-items`, {
          expect: { status: 200 },
          checks: [['two, oldest first', `j.toCheck === 2 && j.items.map((x) => x.id).join() === [${v('flaggedItem')}, ${v('parkedItem')}].join()`]],
        }),
        owner('An applied item needs nothing (expect 409)', 'POST', `${G}/desk/offline-items/{{item1}}/resolve`, { body: { action: 'checked' }, expect: { status: 409, code: 'GYM_OFFLINE_ITEM_STATE' } }),
        owner('Parked cash is not just "checked" (expect 409)', 'POST', `${G}/desk/offline-items/{{parkedItem}}/resolve`, { body: { action: 'checked' }, expect: { status: 409, code: 'GYM_OFFLINE_ITEM_STATE' } }),
        owner('Given back needs a note (expect 422)', 'POST', `${G}/desk/offline-items/{{parkedItem}}/resolve`, { body: { action: 'returned' }, expect: { status: 422 } }),
        owner('The cash went back', 'POST', `${G}/desk/offline-items/{{parkedItem}}/resolve`, {
          body: { action: 'returned', note: 'Handed back to Rafiq' },
          expect: { status: 200 },
          checks: [['returned, with the note', "j.item.resolution === 'returned' && j.item.resolutionNote === 'Handed back to Rafiq'"]],
        }),
        owner('Tanvir’s check-in: checked', 'POST', `${G}/desk/offline-items/{{flaggedItem}}/resolve`, { body: { action: 'checked', note: 'He renewed at the counter' }, expect: { status: 200 }, checks: [['checked', "j.item.resolution === 'checked'"]] }),
        owner('Nothing left to check', 'GET', `${G}/desk/offline-items`, { expect: { status: 200 }, checks: [['empty', 'j.toCheck === 0 && j.items.length === 0']] }),
        owner('All: every item', 'GET', `${G}/desk/offline-items?state=all`, { expect: { status: 200 }, checks: [['four kept', 'j.items.length === 4']] }),
      ],
    },
  ],
};
collection.variable.push({ key: 'deskUser', value: '' });

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
