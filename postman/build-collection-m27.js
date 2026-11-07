'use strict';

/**
 * Builds postman/kriraghor-gym-ops.postman_collection.json ("M27 round 1 · Front desk and money"):
 * expenses (record, list, void, never deleted), the cash drawer (open, close with a difference), the
 * counter shop (products, stock in, a sale with a receipt from the gym's series, low stock, a reversal),
 * lockers (grid, rent with the fee, end), profit and loss, VAT on receipts, the member's health fields
 * and BMI, the dashboard's expiring list and mix, the absent filter. Bookkeeping only (M24-FR-34): no
 * ledger. node postman/build-collection-m27.js
 *
 * Variables (set by the runner, postman/run-m27.js): ownerToken (a Standard gym, short code IY), gymId,
 * memberId (an active member), memberToken (the member's own linked account), cashierToken (staff with
 * members.view, cash.drawer and pos.sell), keeperToken (staff with stock.manage), deskToken (staff with
 * members.view only), controlUrl (the runner: /drain, /lockers).
 * Unattended: `node postman/run-m27.js`.
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-gym-ops.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const owner = as('ownerToken');
const cashier = as('cashierToken');
const keeper = as('keeperToken');
const desk = as('deskToken');
const member = as('memberToken');
const idem = (item, value = 'go-{{$guid}}') => {
  item.request.header.push({ key: 'Idempotency-Key', value });
  return item;
};
const control = (name, step) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 } });
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [step] };
  return r;
};
const G = '/manage/gyms/{{gymId}}';

const collection = {
  info: {
    name: 'Kriraghor API: M27 round 1 · Front desk and money',
    description: [
      'M27 Gym operations, round 1, on a Standard gym. The owner records expenses in the gym’s categories (rent, electricity …) and voids one with a reason (never deleted). The cashier opens the day’s cash drawer with a float, sells at the counter and closes with the counted cash; the difference is kept. A store keeper adds a product with its batch and expiry and stocks it; staff without stock.manage never see the cost. A sale takes its receipt number from the gym’s receipt series; a reversal needs fees.adjust and puts the stock back.',
      'Lockers: a grid of numbers, a rental with the monthly fee collected at once (a locker sale), the daily job reminds before the end and ends rentals past it. Profit and loss: fees, counter sales and locker fees, less the cost of goods and expenses, against the period before. VAT is off by default; within the cap it is kept on each payment and sale and shown on the receipt. The member sets height and weight and sees the BMI; the owner sees the conditions, staff with members.edit only the blood group.',
      'Requests named "Runner" go to the local test runner (delivering events, the daily lockers job).',
      'Unattended: `node postman/run-m27.js`. Rebuild this file with: node postman/build-collection-m27.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    'baseUrl', 'controlUrl', 'ownerToken', 'cashierToken', 'keeperToken', 'deskToken', 'memberToken', 'gymId', 'memberId',
    'lockerEnds', 'rentId', 'internetId', 'expenseId', 'productId', 'saleId', 'receiptNo', 'locker1', 'locker2', 'rentalId',
  ].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. Plan and permissions (M27-FR-34)',
      item: [
        desk('Staff without expenses.manage (expect 403)', 'GET', `${G}/expenses`, { expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        desk('Staff without reports.view: no profit and loss (expect 403)', 'GET', `${G}/pnl`, { expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        member('A member is not staff (expect 404)', 'GET', `${G}/lockers`, { expect: { status: 404 } }),
      ],
    },
    {
      name: '2. Expenses (M27-FR-01 to FR-05)',
      item: [
        owner('The categories, made on first use', 'GET', `${G}/expense-categories`, {
          expect: { status: 200 },
          checks: [['nine defaults', "j.items.length === 9 && j.items.some((c) => c.key === 'rent')"], ['saves ids', "(pm.collectionVariables.set('rentId', j.items.find((c) => c.key === 'rent').id), pm.collectionVariables.set('internetId', j.items.find((c) => c.key === 'internet').id), true)"]],
        }),
        idem(owner('A date in the future (expect 422)', 'POST', `${G}/expenses`, { body: { categoryId: '{{rentId}}', amountPoisha: 1000, method: 'bank', spentOn: '2999-01-01' }, expect: { status: 422 } })),
        idem(owner('Rent ৳25,000 by bank', 'POST', `${G}/expenses`, { body: { categoryId: '{{rentId}}', amountPoisha: 2500000, method: 'bank', note: 'November rent' }, expect: { status: 201 }, save: { expenseId: 'id' }, checks: [['recorded', "j.status === 'recorded' && j.category.key === 'rent' && j.fromDrawer === false"]] })),
        idem(owner('Internet ৳1,500 by bKash', 'POST', `${G}/expenses`, { body: { categoryId: '{{internetId}}', amountPoisha: 150000, method: 'owner_bkash' }, expect: { status: 201 } })),
        owner('The list and its total', 'GET', `${G}/expenses`, { expect: { status: 200 }, checks: [['two, ৳26,500', 'j.items.length === 2 && j.totalPoisha === 2650000']] }),
        owner('Void the rent with a reason', 'POST', `${G}/expenses/{{expenseId}}/void`, { body: { reason: 'Entered for the wrong month' }, expect: { status: 200 }, checks: [['void, kept', "j.status === 'void' && j.voidReason === 'Entered for the wrong month'"]] }),
        owner('Void it again (expect 409)', 'POST', `${G}/expenses/{{expenseId}}/void`, { body: { reason: 'Second time' }, expect: { status: 409, code: 'GYM_EXPENSE_STATE' } }),
      ],
    },
    {
      name: '3. The cash drawer opens (M27-FR-06)',
      item: [
        cashier('The cashier opens the day with ৳500', 'POST', `${G}/cash-drawer/open`, { body: { openingPoisha: 50000 }, expect: { status: 201 }, checks: [['open', "j.status === 'open' && j.openingPoisha === 50000"]] }),
        cashier('Open twice (expect 409)', 'POST', `${G}/cash-drawer/open`, { body: { openingPoisha: 50000 }, expect: { status: 409, code: 'GYM_DRAWER_OPEN' } }),
      ],
    },
    {
      name: '4. The counter shop (M27-FR-12 to FR-20)',
      item: [
        keeper('A product: whey 1 kg, reorder at 2', 'POST', `${G}/products`, { body: { name: 'Whey 1kg', barcode: '8901234567890', category: 'supplement', pricePoisha: 450000, costPoisha: 330000, reorderLevel: 2, importer: 'BSTI 123' }, expect: { status: 201 }, save: { productId: 'id' } }),
        keeper('The same barcode again (expect 409)', 'POST', `${G}/products`, { body: { name: 'Copy', barcode: '8901234567890', category: 'supplement', pricePoisha: 1000 }, expect: { status: 409, code: 'GYM_PRODUCT_BARCODE_TAKEN' } }),
        idem(keeper('Stock in: 4 with batch and expiry', 'POST', `${G}/products/{{productId}}/stock`, { body: { kind: 'in', qty: 4, batchNo: 'B-7', expiresOn: '2027-06-30' }, expect: { status: 201 }, checks: [['4 in stock', 'j.stockQty === 4']] })),
        cashier('The cashier finds it by barcode, without the cost', 'GET', `${G}/products?barcode=8901234567890`, { expect: { status: 200 }, checks: [['no cost for pos.sell', "j.items.length === 1 && j.items[0].costPoisha === undefined && j.items[0].batchNo === 'B-7'"]] }),
        idem(cashier('Too many (expect 409)', 'POST', `${G}/sales`, { body: { lines: [{ productId: '{{productId}}', qty: 9 }], method: 'cash' }, expect: { status: 409, code: 'GYM_STOCK_SHORT' } })),
        idem(cashier('Sell 2 for cash, to the member', 'POST', `${G}/sales`, {
          body: { lines: [{ productId: '{{productId}}', qty: 2 }], method: 'cash', memberId: '{{memberId}}' },
          expect: { status: 201 },
          save: { saleId: 'id', receiptNo: 'receiptNo' },
          checks: [['৳9,000, a receipt from the gym series, no VAT', "j.totalPoisha === 900000 && /^IY-R\\d{2}-\\d{6}$/.test(j.receiptNo) && j.vat === null && j.member && j.member.memberCode.startsWith('IY-')"]],
        })),
        control('deliver events', 'drain'),
        owner('The receipt', 'GET', `${G}/sales/{{saleId}}/receipt`, { expect: { status: 200 }, checks: [['same number, gym header', "j.receiptNo === pm.collectionVariables.get('receiptNo') && j.gym.name.length > 0 && j.lines[0].qty === 2"]] }),
        cashier('A reversal without fees.adjust (expect 403)', 'POST', `${G}/sales/{{saleId}}/reverse`, { body: { reason: 'Wrong flavour' }, expect: { status: 403, code: 'PERMISSION_REQUIRED' } }),
        owner('The owner reverses it; the stock comes back', 'POST', `${G}/sales/{{saleId}}/reverse`, { body: { reason: 'Wrong flavour' }, expect: { status: 200 }, checks: [['reversed, kept', "j.status === 'reversed' && j.reverseReason === 'Wrong flavour'"]] }),
        keeper('Stock is 4 again', 'GET', `${G}/products`, { expect: { status: 200 }, checks: [['4, cost visible to stock.manage', 'j.items[0].stockQty === 4 && j.items[0].costPoisha === 330000']] }),
        idem(cashier('Sell 3 by card at the counter (stock falls to the reorder level)', 'POST', `${G}/sales`, { body: { lines: [{ productId: '{{productId}}', qty: 3 }], method: 'card_counter' }, expect: { status: 201 } })),
        keeper('Low stock is flagged', 'GET', `${G}/products`, { expect: { status: 200 }, checks: [['1 left, low', 'j.items[0].stockQty === 1 && j.items[0].low === true']] }),
      ],
    },
    {
      name: '5. Lockers (M27-FR-21 to FR-26)',
      item: [
        owner('Add lockers 1 to 3 at ৳300 a month', 'POST', `${G}/lockers`, {
          body: { numbers: ['1', '2', '3'], size: 'small', monthlyFeePoisha: 30000 },
          expect: { status: 201 },
          save: { locker1: 'items.0.id', locker2: 'items.1.id' },
          checks: [['three free', 'j.counts.free === 3']],
        }),
        owner('Locker 2 again (expect 409)', 'POST', `${G}/lockers`, { body: { numbers: ['2'], monthlyFeePoisha: 30000 }, expect: { status: 409, code: 'GYM_LOCKER_NUMBER_TAKEN' } }),
        idem(owner('Rent locker 1 to the member, fee taken in cash', 'POST', `${G}/lockers/{{locker1}}/rent`, { body: { memberId: '{{memberId}}', endsOn: '{{lockerEnds}}', collect: { method: 'cash' } }, expect: { status: 201 }, save: { rentalId: 'id' }, checks: [['paid, active', "j.paid === true && j.status === 'active' && j.feePoisha === 30000"]] })),
        idem(owner('Locker 1 is taken (expect 409)', 'POST', `${G}/lockers/{{locker1}}/rent`, { body: { memberId: '{{memberId}}', endsOn: '{{lockerEnds}}' }, expect: { status: 409, code: 'GYM_LOCKER_UNAVAILABLE' } })),
        owner('Locker 2 out of service', 'PATCH', `${G}/lockers/{{locker2}}`, { body: { status: 'out_of_service' }, expect: { status: 200 } }),
        owner('The grid', 'GET', `${G}/lockers`, { expect: { status: 200 }, checks: [['1 taken, 1 out of service, 1 free', 'j.counts.taken === 1 && j.counts.outOfService === 1 && j.counts.free === 1']] }),
        control('the daily lockers job', 'lockers'),
        owner('End the rental early', 'POST', `${G}/locker-rentals/{{rentalId}}/end`, { body: { reason: 'Member moved away' }, expect: { status: 200 }, checks: [['ended', "j.status === 'ended'"]] }),
        owner('The member’s rentals', 'GET', `${G}/locker-rentals?memberId={{memberId}}`, { expect: { status: 200 }, checks: [['one ended', "j.items.length === 1 && j.items[0].status === 'ended'"]] }),
      ],
    },
    {
      name: '6. The drawer closes (M27-FR-07, FR-08)',
      item: [
        cashier('The drawer: float + cash fee + locker fee', 'GET', `${G}/cash-drawer`, { expect: { status: 200 }, checks: [['expected ৳1,800 (500 + 1,000 + 300; the cash sale was reversed)', 'j.status === "open" && j.cash.expectedPoisha === 180000']] }),
        cashier('Close with ৳1,790 counted', 'POST', `${G}/cash-drawer/close`, { body: { countedPoisha: 179000, note: 'Short by ৳10' }, expect: { status: 200 }, checks: [['short ৳10', "j.status === 'closed' && j.differencePoisha === -1000"]] }),
        idem(cashier('A cash sale after closing (expect 409)', 'POST', `${G}/sales`, { body: { lines: [{ productId: '{{productId}}', qty: 1 }], method: 'cash' }, expect: { status: 409, code: 'GYM_DRAWER_CLOSED' } })),
      ],
    },
    {
      name: '7. Profit and loss, VAT (M27-FR-27, FR-28)',
      item: [
        owner('This month', 'GET', `${G}/pnl`, {
          expect: { status: 200 },
          checks: [['fees ৳1,000 + sales ৳13,500 + lockers ৳300 − goods ৳9,900 − expenses ৳1,500', 'j.current.income.fees === 100000 && j.current.income.posSales === 1350000 && j.current.income.lockerFees === 30000 && j.current.goodsCost === 990000 && j.current.expenses.total === 150000 && j.current.net === 340000']],
        }),
        owner('VAT above the cap (expect 422)', 'PATCH', `${G}/settings`, { body: { vatEnabled: true, vatBps: 1600 }, expect: { status: 422 } }),
        owner('VAT 15% on', 'PATCH', `${G}/settings`, { body: { vatEnabled: true, vatBps: 1500 }, expect: { status: 200 }, checks: [['on', 'j.vatEnabled === true && j.vatBps === 1500 && j.vatMaxBps === 1500']] }),
        idem(cashier('A card sale shows the VAT inside', 'POST', `${G}/sales`, { body: { lines: [{ productId: '{{productId}}', qty: 1 }], method: 'card_counter' }, expect: { status: 201 }, checks: [['৳4,500 incl. ৳587 VAT', 'j.vat.bps === 1500 && j.vat.vat === 58696 && j.vat.net === 391304']] })),
        owner('VAT off again', 'PATCH', `${G}/settings`, { body: { vatEnabled: false }, expect: { status: 200 } }),
      ],
    },
    {
      name: '8. Health, dashboard, absent (M27-FR-30 to FR-33)',
      item: [
        member('The member sets height and weight', 'PUT', '/me/gym-memberships/{{memberId}}/health', { body: { heightCm: 175, weightKg: 70, bloodGroup: 'B+' }, expect: { status: 200 }, checks: [['BMI 22.9, normal', "j.bmi.value === 22.9 && j.bmi.band === 'normal'"]] }),
        owner('The owner sees the body fields', 'GET', `${G}/members/{{memberId}}`, { expect: { status: 200 }, checks: [['blood group and BMI', "j.member.bloodGroup === 'B+' && j.member.bmi.value === 22.9"]] }),
        desk('Staff with members.view only: no health fields', 'GET', `${G}/members/{{memberId}}`, { expect: { status: 200 }, checks: [['hidden', 'j.member.bloodGroup === undefined && j.member.bmi === undefined && j.member.medical === undefined']] }),
        owner('The dashboard: who ends soon and the mix', 'GET', `${G}/overview`, { expect: { status: 200 }, checks: [['lists', 'Array.isArray(j.expiring) && j.mix.active >= 1']] }),
        owner('Absent for 7 days', 'GET', `${G}/reports/absent?days=7`, { expect: { status: 200 } }),
        owner('0 days (expect 422)', 'GET', `${G}/reports/absent?days=0`, { expect: { status: 422 } }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)} (${collection.item.reduce((n, f) => n + f.item.length, 0)} requests)`);
