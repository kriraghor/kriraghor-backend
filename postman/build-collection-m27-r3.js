'use strict';

/**
 * Builds postman/kriraghor-gym-ops-r3.postman_collection.json ("M27 round 3 · Staff and equipment"): weekly
 * shifts, clocking in and out by the entrance QR and at the desk, the day's board, the auto-close job and the
 * month's report; pay terms, a month's payroll drafted from a trainer's member fees and counter sales, bonus
 * and deduction, approve, pay as salary expenses, payslips; the equipment register with the service reminder,
 * a service with its cost as an expense, status changes and retiring. node postman/build-collection-m27-r3.js
 *
 * Variables (set by the runner, postman/run-m27-r3.js): ownerToken (a Pro gym), gymId, rumiToken + rumiId
 * (desk staff with clock.in), taniaToken + taniaId (a trainer who sells, with clock.in), techToken (assets.manage),
 * otherToken + otherId (members.view only), memberDueId (a member assigned to Tania with a due), period (this
 * month), boughtOn (29 days ago), tomorrow, in30, today, controlUrl (the runner: /backdate, /clockout,
 * /service, /drain). Unattended: `node postman/run-m27-r3.js`.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-gym-ops-r3.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const owner = as('ownerToken');
const rumi = as('rumiToken');
const tania = as('taniaToken');
const tech = as('techToken');
const other = as('otherToken');
const idem = (item, value = 'go3-{{$guid}}') => {
  item.request.header.push({ key: 'Idempotency-Key', value });
  return item;
};
const control = (name, step) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 } });
  const [pathname, qs] = step.split('?');
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [pathname], ...(qs ? { query: qs.split('&').map((kv) => ({ key: kv.split('=')[0], value: kv.split('=')[1] })) } : {}) };
  return r;
};
const G = '/manage/gyms/{{gymId}}';
const week = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, startTime: '06:00', endTime: '14:00' }));

const collection = {
  info: {
    name: 'Kriraghor API: M27 round 3 · Staff and equipment',
    description: [
      'M27 Gym operations, round 3, on a Pro gym. Staff attendance (Standard): the owner sets weekly shifts; a staff member with clock.in scans the gym’s entrance QR on their phone to clock in, and again to clock out; the owner or shifts.manage can clock someone at the desk; clock-ins left open close on their own and count no hours; the board shows who is in and the month report shows hours, late and missed shifts. Clock rows are append-only.',
      'Payroll (Pro, the owner only): pay terms per staff member (base, a trainer’s commission on the fees of their members, a commission on their counter sales); a month is drafted from the terms and the month’s facts, takes bonuses and deductions, is approved (frozen) and paid line by line, each payment a salary expense in the gym’s books; each staff member sees their own payslips once approved. Kriraghor never pays staff.',
      'Equipment (Standard, assets.manage): machines with a service interval; a reminder once per due date to the owner and assets.manage staff; a service moves the next date on and its cost can be an equipment-repair expense; a status change is logged; retiring is final.',
      'Requests named "Runner" go to the local test runner (moving clock times back, the auto-close job, the service reminder job, delivering events).',
      'Unattended: `node postman/run-m27-r3.js`. Rebuild this file with: node postman/build-collection-m27-r3.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    'baseUrl', 'controlUrl', 'ownerToken', 'rumiToken', 'taniaToken', 'techToken', 'otherToken', 'gymId', 'rumiId', 'taniaId', 'otherId', 'memberDueId',
    'period', 'boughtOn', 'tomorrow', 'in30', 'today', 'entranceToken', 'productId', 'runId', 'taniaLine', 'otherLine', 'assetId',
  ].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. Shifts (M27-FR-72)',
      item: [
        owner('An overnight shift (expect 422)', 'PUT', `${G}/staff/{{rumiId}}/shifts`, { body: { shifts: [{ dow: 1, startTime: '22:00', endTime: '06:00' }] }, expect: { status: 422, code: 'GYM_SHIFT_TIMES' } }),
        owner('Rumi works 06:00 to 14:00 every day', 'PUT', `${G}/staff/{{rumiId}}/shifts`, { body: { shifts: week }, expect: { status: 200 }, checks: [['seven shifts', 'j.shifts.length === 7']] }),
        rumi('Staff without shifts.manage (expect 403)', 'PUT', `${G}/staff/{{rumiId}}/shifts`, { body: { shifts: [] }, expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        owner('Everyone’s shifts', 'GET', `${G}/staff-shifts`, { expect: { status: 200 }, checks: [['Rumi has 7', "j.items.find((x) => x.staff.id === pm.variables.get('rumiId')).shifts.length === 7"]] }),
      ],
    },
    {
      name: '2. Clocking in and out (M27-FR-73 to FR-75)',
      item: [
        owner('The entrance QR', 'GET', `${G}/entrance-token`, { expect: { status: 200 }, save: { entranceToken: 'token' } }),
        rumi('Rumi scans in', 'POST', '/me/gym-staff-clock', { body: { token: '{{entranceToken}}' }, expect: { status: 201 }, checks: [['in by the QR', "j.kind === 'in' && j.method === 'entrance_qr'"]] }),
        rumi('My clock', 'GET', `${G}/staff-clock/me`, { expect: { status: 200 }, checks: [['in, today’s shift', "j.clockedIn === true && j.todayShifts[0].startTime === '06:00'"]] }),
        control('Rumi clocked in 2 hours ago', 'backdate?staffId={{rumiId}}&minutes=120'),
        rumi('Rumi scans out', 'POST', '/me/gym-staff-clock', { body: { token: '{{entranceToken}}' }, expect: { status: 201 }, checks: [['out after 120 minutes', "j.kind === 'out' && j.minutes === 120"]] }),
        owner('The owner is not staff (expect 403)', 'POST', '/me/gym-staff-clock', { body: { token: '{{entranceToken}}' }, expect: { status: 403, code: 'GYM_NOT_STAFF' } }),
        other('Staff without clock.in (expect 403)', 'POST', '/me/gym-staff-clock', { body: { token: '{{entranceToken}}' }, expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        rumi('Not the entrance code (expect 422)', 'POST', '/me/gym-staff-clock', { body: { token: 'v1.ge.not-a-real-token' }, expect: { status: 422, code: 'GYM_CLOCK_TOKEN_INVALID' } }),
        owner('The owner clocks Rumi in at the desk', 'POST', `${G}/staff-times`, { body: { staffId: '{{rumiId}}', kind: 'in' }, expect: { status: 201 }, checks: [['at the desk', "j.method === 'desk'"]] }),
        owner('Again (expect 409)', 'POST', `${G}/staff-times`, { body: { staffId: '{{rumiId}}', kind: 'in' }, expect: { status: 409, code: 'GYM_STAFF_ALREADY_IN' } }),
        owner('The board', 'GET', `${G}/staff-attendance`, { expect: { status: 200 }, checks: [['one in, 120 minutes worked', "j.inNow === 1 && j.items.find((x) => x.staff.id === pm.variables.get('rumiId')).minutes === 120"]] }),
        control('the clock-in is 15 hours old', 'backdate?staffId={{rumiId}}&minutes=900'),
        control('the auto-close job', 'clockout'),
        owner('The month', 'GET', `${G}/staff-report?period={{period}}`, { expect: { status: 200 }, checks: [['120 minutes (the auto-closed time counts nothing)', "j.items.find((x) => x.staff.id === pm.variables.get('rumiId')).workedMinutes === 120"]] }),
      ],
    },
    {
      name: '3. Pay terms and the month’s facts (M27-FR-76)',
      item: [
        owner('A commission above the cap (expect 422)', 'PUT', `${G}/staff/{{taniaId}}/pay`, { body: { basePoisha: 1500000, ptCommissionBps: 6000, salesCommissionBps: 0 }, expect: { status: 422, code: 'GYM_COMMISSION_OUT_OF_RANGE' } }),
        owner('Tania: ৳15,000, 10% of her members’ fees, 5% of her sales', 'PUT', `${G}/staff/{{taniaId}}/pay`, { body: { basePoisha: 1500000, ptCommissionBps: 1000, salesCommissionBps: 500 }, expect: { status: 200 } }),
        owner('Other: ৳10,000', 'PUT', `${G}/staff/{{otherId}}/pay`, { body: { basePoisha: 1000000, ptCommissionBps: 0, salesCommissionBps: 0 }, expect: { status: 200 } }),
        tania('Staff cannot see pay (expect 403)', 'GET', `${G}/staff-pay`, { expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        idem(owner('Tania’s member pays ৳2,000 cash', 'POST', `${G}/dues/{{memberDueId}}/payments`, { body: { amountPoisha: 200000, method: 'cash' }, expect: { status: 201 } })),
        owner('A product to sell', 'POST', `${G}/products`, { body: { name: 'Whey sachet', category: 'supplement', pricePoisha: 90000, costPoisha: 60000 }, expect: { status: 201 }, save: { productId: 'id' } }),
        idem(owner('Stock in 5', 'POST', `${G}/products/{{productId}}/stock`, { body: { kind: 'in', qty: 5 }, expect: { status: 201 } })),
        idem(tania('Tania sells one for ৳900 by card', 'POST', `${G}/sales`, { body: { lines: [{ productId: '{{productId}}', qty: 1 }], method: 'card_counter' }, expect: { status: 201 } })),
      ],
    },
    {
      name: '4. The month’s payroll (M27-FR-77 to FR-81)',
      item: [
        owner('A future month (expect 422)', 'POST', `${G}/payroll`, { body: { period: '2099-01' }, expect: { status: 422, code: 'GYM_PAYROLL_PERIOD' } }),
        owner('Draft this month', 'POST', `${G}/payroll`, {
          body: { period: '{{period}}' },
          expect: { status: 201 },
          save: { runId: 'id' },
          checks: [
            ['two lines', "j.status === 'draft' && j.staffCount === 2"],
            [
              'Tania: ৳15,000 + 10% of ৳2,000 + 5% of ৳900 = ৳15,245; saves line ids',
              "(() => { const t = j.lines.find((l) => l.staff.id === pm.variables.get('taniaId')); const o = j.lines.find((l) => l.staff.id === pm.variables.get('otherId')); pm.collectionVariables.set('taniaLine', t.id); pm.collectionVariables.set('otherLine', o.id); return t.ptCommissionPoisha === 20000 && t.salesCommissionPoisha === 4500 && t.netPoisha === 1524500; })()",
            ],
          ],
        }),
        owner('The same month again (expect 409)', 'POST', `${G}/payroll`, { body: { period: '{{period}}' }, expect: { status: 409, code: 'GYM_PAYROLL_EXISTS' } }),
        owner('A deduction larger than the pay (expect 422)', 'PATCH', `${G}/payroll/{{runId}}/lines/{{taniaLine}}`, { body: { deductionPoisha: 2000000 }, expect: { status: 422, code: 'GYM_PAYROLL_NEGATIVE' } }),
        owner('Bonus ৳500, deduction ৳200, a note', 'PATCH', `${G}/payroll/{{runId}}/lines/{{taniaLine}}`, { body: { bonusPoisha: 50000, deductionPoisha: 20000, note: 'Late twice' }, expect: { status: 200 }, checks: [['net ৳15,545', "j.lines.find((l) => l.id === pm.variables.get('taniaLine')).netPoisha === 1554500"]] }),
        owner('Recalculate keeps the bonus', 'POST', `${G}/payroll/{{runId}}/recalculate`, { expect: { status: 200 }, checks: [['still ৳15,545', "j.lines.find((l) => l.id === pm.variables.get('taniaLine')).netPoisha === 1554500"]] }),
        tania('A draft payslip is the owner’s only (expect 404)', 'GET', `${G}/payroll/{{runId}}/lines/{{taniaLine}}/payslip`, { expect: { status: 404 } }),
        owner('Approve', 'POST', `${G}/payroll/{{runId}}/approve`, { expect: { status: 200 }, checks: [['approved', "j.status === 'approved'"]] }),
        owner('Change after approval (expect 409)', 'PATCH', `${G}/payroll/{{runId}}/lines/{{taniaLine}}`, { body: { bonusPoisha: 1 }, expect: { status: 409, code: 'GYM_PAYROLL_STATE' } }),
        idem(owner('Pay Tania by bank', 'POST', `${G}/payroll/{{runId}}/lines/{{taniaLine}}/pay`, { body: { method: 'bank' }, expect: { status: 200 }, checks: [['paid ৳15,545 so far', "j.status === 'approved' && j.paidPoisha === 1554500"]] })),
        idem(owner('Pay her again (expect 409)', 'POST', `${G}/payroll/{{runId}}/lines/{{taniaLine}}/pay`, { body: { method: 'bank' }, expect: { status: 409, code: 'GYM_PAYROLL_LINE_STATE' } })),
        idem(owner('Pay Other in cash: the month is paid', 'POST', `${G}/payroll/{{runId}}/lines/{{otherLine}}/pay`, { body: { method: 'cash' }, expect: { status: 200 }, checks: [['paid', "j.status === 'paid'"]] })),
        owner('Salaries are in the expenses', 'GET', `${G}/expenses`, { expect: { status: 200 }, checks: [['two salary expenses, ৳25,545', "j.items.filter((x) => x.category.key === 'salaries').reduce((n, x) => n + x.amountPoisha, 0) === 2554500"]] }),
        owner('Void a paid month (expect 409)', 'POST', `${G}/payroll/{{runId}}/void`, { body: { reason: 'Wrong month' }, expect: { status: 409, code: 'GYM_PAYROLL_STATE' } }),
        tania('Tania’s payslips', 'GET', `${G}/my-payslips`, { expect: { status: 200 }, checks: [['one, paid', "j.items.length === 1 && j.items[0].status === 'paid' && j.items[0].netPoisha === 1554500"]] }),
        tania('Her payslip', 'GET', `${G}/payroll/{{runId}}/lines/{{taniaLine}}/payslip`, { expect: { status: 200 }, checks: [['with the note', "j.line.note === 'Late twice' && j.line.paidMethod === 'bank'"]] }),
        tania('Not someone else’s (expect 404)', 'GET', `${G}/payroll/{{runId}}/lines/{{otherLine}}/payslip`, { expect: { status: 404 } }),
        control('deliver events (the payslip notices)', 'drain'),
      ],
    },
    {
      name: '5. Equipment (M27-FR-82 to FR-86)',
      item: [
        other('Staff without assets.manage (expect 403)', 'GET', `${G}/assets`, { expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        tech('A treadmill, serviced every 30 days, bought 29 days ago', 'POST', `${G}/assets`, {
          body: { name: 'Treadmill T1', category: 'cardio', serial: 'TM-001', boughtOn: '{{boughtOn}}', costPoisha: 15000000, serviceEveryDays: 30 },
          expect: { status: 201 },
          save: { assetId: 'id' },
          checks: [['next service tomorrow', "j.status === 'working' && j.nextServiceOn === pm.variables.get('tomorrow')"]],
        }),
        control('the service reminder job', 'service'),
        control('deliver events (the reminder)', 'drain'),
        idem(tech('A service with its cost as a cash expense', 'POST', `${G}/assets/{{assetId}}/logs`, {
          body: { kind: 'service', costPoisha: 150000, note: 'Belt oiled', expense: { method: 'cash' } },
          expect: { status: 201 },
          checks: [['next service in 30 days, in the expenses', "j.asset.lastServiceOn === pm.variables.get('today') && j.asset.nextServiceOn === pm.variables.get('in30') && j.items[0].expenseId !== null"]],
        })),
        owner('Out of order, with a note', 'PATCH', `${G}/assets/{{assetId}}`, { body: { status: 'out_of_order', statusNote: 'Motor noise' }, expect: { status: 200 } }),
        owner('The counts', 'GET', `${G}/assets`, { expect: { status: 200 }, checks: [['1 out of order', 'j.counts.out_of_order === 1 && j.counts.working === 0']] }),
        owner('Retire it', 'PATCH', `${G}/assets/{{assetId}}`, { body: { status: 'retired' }, expect: { status: 200 } }),
        idem(owner('Log on a retired machine (expect 409)', 'POST', `${G}/assets/{{assetId}}/logs`, { body: { kind: 'note', note: 'Gone' }, expect: { status: 409, code: 'GYM_ASSET_STATE' } })),
        owner('The history', 'GET', `${G}/assets/{{assetId}}/logs`, { expect: { status: 200 }, checks: [['status, status, service', "j.items.map((x) => x.kind).join() === 'status,status,service'"]] }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)} (${collection.item.reduce((n, f) => n + f.item.length, 0)} requests)`);
