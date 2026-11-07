'use strict';

// M27 gym operations, round 1, end to end: plan tiers and staff permissions, expenses (record, void, never
// deleted), the cash drawer (open, close, difference, closed day refuses cash), the counter shop (products,
// stock in, sale, low-stock alert once, expired stock, reversal with fees.adjust), lockers (grid, rent with
// and without the fee, collect, end, the daily job), profit and loss, VAT on receipts, the member's health
// fields and BMI, the dashboard's expiring list and mix, the absent filter. Bookkeeping only: no ledger.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const gm = require('../fixtures/gym-manage');
const lockersSvc = require('../../src/modules/gym-ops/lockers.service');

const { models } = h;

let master;
beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  void master;
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const outbox = (name) => models.OutboxEvent.count({ where: { name } });

describe('M27 tiers and permissions', () => {
  it('a feature below the plan is refused; staff need their permission; strangers get 404', async () => {
    const { owner, gym } = await gm.privateGym({ tier: null });
    const g = gm.manage(owner, gym.id);
    expect((await g.get('/expenses').expect(403)).body).toMatchObject({ code: 'GYM_TIER_REQUIRED', feature: 'expenses', minTier: 'basic' });
    await h.api().put(`${h.P}/manage/billing/tier`).set(h.bearer(owner)).send({ tier: 'basic' }).expect(200);
    await g.get('/expenses').expect(200);
    expect((await g.get('/products').expect(403)).body).toMatchObject({ feature: 'pos', minTier: 'standard' });
    const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rahim' }), ['attendance.mark', 'members.view']);
    expect((await gm.manage(desk, gym.id).get('/expenses').expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    const stranger = await h.signupUser({ name: 'Nobody' });
    await gm.manage(stranger, gym.id).get('/expenses').expect(404);
  });
});

describe('M27 expenses and the cash drawer', () => {
  it('records, lists and voids expenses; the drawer balances; a closed day refuses cash', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'standard' });
    const g = gm.manage(owner, gym.id);
    const cats = (await g.get('/expense-categories').expect(200)).body.items;
    expect(cats.map((c) => c.key)).toContain('rent');
    const rent = cats.find((c) => c.key === 'rent');
    const electricity = cats.find((c) => c.key === 'electricity');

    // Out of range and future dates are refused.
    expect((await g.post('/expenses', { categoryId: rent.id, amountPoisha: 999999999999, method: 'bank' }, true).expect(422)).body.code).toBe('GYM_AMOUNT_OUT_OF_RANGE');
    expect((await g.post('/expenses', { categoryId: rent.id, amountPoisha: 1000, method: 'bank', spentOn: gm.inDays(1) }, true).expect(422)).body.code).toBe('GYM_DATE_OUT_OF_RANGE');
    await g.post('/expenses', { categoryId: rent.id, amountPoisha: 1000, method: 'bank', fromDrawer: true }, true).expect(422);

    // The drawer: open, cash in from a fee and a sale, cash out for an expense, close balanced.
    await g.post('/cash-drawer/open', { openingPoisha: 50000 }).expect(201);
    expect((await g.post('/cash-drawer/open', { openingPoisha: 50000 }).expect(409)).body.code).toBe('GYM_DRAWER_OPEN');
    await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.today() }, payment: { amountPoisha: 100000, method: 'cash' } });
    const bulb = (await g.post('/expenses', { categoryId: electricity.id, amountPoisha: 20000, method: 'cash', fromDrawer: true, note: 'Bulbs' }, true).expect(201)).body;
    expect(bulb).toMatchObject({ amountPoisha: 20000, fromDrawer: true, status: 'recorded', category: { key: 'electricity' } });
    await g.post('/expenses', { categoryId: rent.id, amountPoisha: 2500000, method: 'bank' }, true).expect(201);
    const p = (await g.post('/products', { name: 'Water 500ml', category: 'drink', pricePoisha: 3000, costPoisha: 2000 }).expect(201)).body;
    await g.post(`/products/${p.id}/stock`, { kind: 'in', qty: 10 }, true).expect(201);
    await g.post('/sales', { lines: [{ productId: p.id, qty: 2 }], method: 'cash' }, true).expect(201);
    const drawer = (await g.get('/cash-drawer').expect(200)).body;
    expect(drawer).toMatchObject({ status: 'open', openingPoisha: 50000, cash: { feesPoisha: 100000, salesPoisha: 6000, expensesPoisha: 20000, expectedPoisha: 136000 } });

    const list = (await g.get('/expenses').expect(200)).body;
    expect(list.items).toHaveLength(2);
    expect(list.totalPoisha).toBe(2520000);

    const closed = (await g.post('/cash-drawer/close', { countedPoisha: 135000, note: 'Short by ৳10' }).expect(200)).body;
    expect(closed).toMatchObject({ status: 'closed', countedPoisha: 135000, differencePoisha: -1000, cash: { expectedPoisha: 136000 } });
    expect(await outbox('gym_cash.closed')).toBe(1);
    expect((await g.post('/cash-drawer/close', { countedPoisha: 1 }).expect(409)).body.code).toBe('GYM_DRAWER_CLOSED');

    // After closing: cash sales and drawer expenses are refused; other methods still work.
    expect((await g.post('/sales', { lines: [{ productId: p.id, qty: 1 }], method: 'cash' }, true).expect(409)).body.code).toBe('GYM_DRAWER_CLOSED');
    await g.post('/sales', { lines: [{ productId: p.id, qty: 1 }], method: 'owner_bkash' }, true).expect(201);
    expect((await g.post(`/expenses/${bulb.id}/void`, { reason: 'Entered twice' }).expect(409)).body.code).toBe('GYM_DRAWER_CLOSED');

    // Void (not delete) a bank expense; twice is refused.
    const bank = list.items.find((x) => x.method === 'bank');
    expect((await g.post(`/expenses/${bank.id}/void`, { reason: 'Wrong month' }).expect(200)).body).toMatchObject({ status: 'void', voidReason: 'Wrong month' });
    expect((await g.post(`/expenses/${bank.id}/void`, { reason: 'Again please' }).expect(409)).body.code).toBe('GYM_EXPENSE_STATE');
    expect(await models.GymExpense.count({ where: { gymId: gym.id } })).toBe(2);
  });

  it('a cashier with cash.drawer can open and close but not record expenses', async () => {
    const { owner, gym } = await gm.privateGym({ tier: 'basic' });
    const cashier = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Cashier Mitu' }), ['members.view', 'cash.drawer']);
    const g = gm.manage(cashier, gym.id);
    await g.post('/cash-drawer/open', { openingPoisha: 0 }).expect(201);
    expect((await g.post('/cash-drawer/close', { countedPoisha: 0 }).expect(200)).body.differencePoisha).toBe(0);
    expect(await outbox('gym_cash.closed')).toBe(1);
    const cat = (await gm.manage(owner, gym.id).get('/expense-categories').expect(200)).body.items[0];
    expect((await g.post('/expenses', { categoryId: cat.id, amountPoisha: 100, method: 'cash' }, true).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
  });
});

describe('M27 the counter shop', () => {
  it('products, stock, sales with receipts, low stock once, expired stock, reversal with fees.adjust', async () => {
    const { owner, gym } = await gm.privateGym({ tier: 'standard' });
    const g = gm.manage(owner, gym.id);
    const whey = (await g.post('/products', { name: 'Whey 1kg', barcode: '8901234567890', category: 'supplement', pricePoisha: 450000, costPoisha: 330000, reorderLevel: 2, importer: 'BSTI 123' }).expect(201)).body;
    expect((await g.post('/products', { name: 'Copy', barcode: '8901234567890', category: 'supplement', pricePoisha: 1000 }).expect(409)).body.code).toBe('GYM_PRODUCT_BARCODE_TAKEN');
    await g.post(`/products/${whey.id}/stock`, { kind: 'in', qty: 4, expiresOn: gm.inDays(200), batchNo: 'B-7' }, true).expect(201);
    expect((await g.get('/products?barcode=8901234567890').expect(200)).body.items[0]).toMatchObject({ stockQty: 4, batchNo: 'B-7', low: false });

    const seller = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Seller Ruma' }), ['members.view', 'pos.sell']);
    const s = gm.manage(seller, gym.id);
    // Staff without stock.manage never see the cost.
    expect((await s.get('/products').expect(200)).body.items[0].costPoisha).toBeUndefined();
    expect((await s.post('/sales', { lines: [{ productId: whey.id, qty: 5 }], method: 'cash' }, true).expect(409)).body.code).toBe('GYM_STOCK_SHORT');
    const sale = (await s.post('/sales', { lines: [{ productId: whey.id, qty: 1 }, { productId: whey.id, qty: 1 }], method: 'card_counter' }, true).expect(201)).body;
    expect(sale).toMatchObject({ kind: 'pos', totalPoisha: 900000, lines: [{ qty: 2, lineTotalPoisha: 900000 }], vat: null, gym: { name: gym.name } });
    expect(sale.receiptNo).toMatch(/^IY-R\d{2}-\d{6}$/);
    expect(await outbox('gym_stock.low_reached')).toBe(1);
    await s.post('/sales', { lines: [{ productId: whey.id, qty: 1 }], method: 'cash' }, true).expect(201);
    expect(await outbox('gym_stock.low_reached')).toBe(1); // once per crossing

    // A reversal needs fees.adjust; stock comes back; twice is refused.
    expect((await s.post(`/sales/${sale.id}/reverse`, { reason: 'Wrong flavour' }).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    expect((await g.post(`/sales/${sale.id}/reverse`, { reason: 'Wrong flavour' }).expect(200)).body).toMatchObject({ status: 'reversed', reverseReason: 'Wrong flavour' });
    expect((await g.get('/products').expect(200)).body.items[0].stockQty).toBe(3);
    expect((await g.post(`/sales/${sale.id}/reverse`, { reason: 'Again please' }).expect(409)).body.code).toBe('GYM_SALE_STATE');
    expect(await models.GymStockMove.count({ where: { productId: whey.id } })).toBe(4);

    // Stock past its date cannot be sold.
    const bar = (await g.post('/products', { name: 'Protein bar', category: 'snack', pricePoisha: 15000 }).expect(201)).body;
    await g.post(`/products/${bar.id}/stock`, { kind: 'in', qty: 5, expiresOn: gm.inDays(-1) }, true).expect(201);
    expect((await g.post('/sales', { lines: [{ productId: bar.id, qty: 1 }], method: 'cash' }, true).expect(422)).body.code).toBe('GYM_PRODUCT_EXPIRED');
    // A write-off takes stock away; too much is refused.
    expect((await g.post(`/products/${bar.id}/stock`, { kind: 'write_off', qty: 9 }, true).expect(409)).body.code).toBe('GYM_STOCK_SHORT');
    expect((await g.post(`/products/${bar.id}/stock`, { kind: 'write_off', qty: 5, note: 'Expired' }, true).expect(201)).body.stockQty).toBe(0);

    // The day's sales: the seller sees their own; the owner sees all.
    expect((await s.get('/sales').expect(200)).body.items).toHaveLength(2);
    expect((await g.get('/sales').expect(200)).body.items).toHaveLength(2);
    expect((await g.get(`/sales/${sale.id}/receipt`).expect(200)).body.receiptNo).toBe(sale.receiptNo);
  });
});

describe('M27 lockers', () => {
  it('a grid, rentals with and without the fee, collect, end, and the daily job', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'basic' });
    const g = gm.manage(owner, gym.id);
    const m = (await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.today() } })).member;
    const grid = (await g.post('/lockers', { numbers: ['1', '2', '3'], size: 'small', monthlyFeePoisha: 30000 }).expect(201)).body;
    expect(grid.counts).toMatchObject({ free: 3, taken: 0 });
    expect((await g.post('/lockers', { numbers: ['2'], monthlyFeePoisha: 30000 }).expect(409)).body.code).toBe('GYM_LOCKER_NUMBER_TAKEN');
    const [l1, l2, l3] = grid.items;

    const paid = (await g.post(`/lockers/${l1.id}/rent`, { memberId: m.id, endsOn: gm.inDays(29), collect: { method: 'cash' } }, true).expect(201)).body;
    expect(paid).toMatchObject({ lockerNumber: '1', feePoisha: 30000, paid: true, status: 'active' });
    expect((await g.post(`/lockers/${l1.id}/rent`, { memberId: m.id, endsOn: gm.inDays(10) }, true).expect(409)).body.code).toBe('GYM_LOCKER_UNAVAILABLE');
    const unpaid = (await g.post(`/lockers/${l2.id}/rent`, { memberId: m.id, endsOn: gm.inDays(40) }, true).expect(201)).body;
    expect(unpaid).toMatchObject({ feePoisha: 60000, paid: false });
    let now = (await g.get('/lockers').expect(200)).body;
    expect(now.counts).toMatchObject({ free: 1, taken: 1, unpaid: 1 });
    expect((await g.post(`/locker-rentals/${unpaid.id}/collect`, { method: 'owner_bkash' }, true).expect(201)).body.paid).toBe(true);
    expect((await g.post(`/locker-rentals/${unpaid.id}/collect`, { method: 'cash' }, true).expect(409)).body.code).toBe('GYM_LOCKER_FEE_PAID');
    expect(await models.GymSale.count({ where: { gymId: gym.id, kind: 'locker' } })).toBe(2);

    // Out of service while rented is refused; ending frees the locker.
    expect((await g.patch(`/lockers/${l1.id}`, { status: 'out_of_service' }).expect(409)).body.code).toBe('GYM_LOCKER_UNAVAILABLE');
    expect((await g.post(`/locker-rentals/${paid.id}/end`, { reason: 'Member left town' }).expect(200)).body.status).toBe('ended');
    expect((await g.post(`/locker-rentals/${paid.id}/end`, { reason: 'Again please' }).expect(409)).body.code).toBe('GYM_LOCKER_RENTAL_STATE');
    await g.patch(`/lockers/${l1.id}`, { status: 'out_of_service' }).expect(200);

    // The daily job: a reminder 3 days before the end (once), and a rental past its end is ended.
    const soon = (await g.post(`/lockers/${l3.id}/rent`, { memberId: m.id, endsOn: gm.inDays(3) }, true).expect(201)).body;
    await models.GymLockerRental.update({ startsOn: gm.inDays(-10), endsOn: gm.inDays(-1) }, { where: { id: unpaid.id } });
    expect(await lockersSvc.daily()).toEqual({ reminded: 1, ended: 1 });
    expect(await lockersSvc.daily()).toEqual({ reminded: 0, ended: 0 });
    expect(await outbox('gym_locker.end_reminded')).toBe(1);
    now = (await g.get('/lockers').expect(200)).body;
    expect(now.counts).toMatchObject({ free: 1, unpaid: 1, outOfService: 1 });
    expect((await g.get(`/locker-rentals?memberId=${m.id}`).expect(200)).body.items.map((r) => r.status).sort()).toEqual(['active', 'ended', 'ended']);
    void soon;
  });
});

describe('M27 profit and loss, VAT, health, the dashboard', () => {
  it('profit and loss adds fees, sales and lockers, less the cost of goods and expenses; owner and reports.view only', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'standard' });
    const g = gm.manage(owner, gym.id);
    await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.today() }, payment: { amountPoisha: 100000, method: 'cash' } });
    const p = (await g.post('/products', { name: 'Shaker', category: 'accessory', pricePoisha: 50000, costPoisha: 20000 }).expect(201)).body;
    await g.post(`/products/${p.id}/stock`, { kind: 'in', qty: 3 }, true).expect(201);
    await g.post('/sales', { lines: [{ productId: p.id, qty: 2 }], method: 'cash' }, true).expect(201);
    const cat = (await g.get('/expense-categories').expect(200)).body.items.find((c) => c.key === 'internet');
    await g.post('/expenses', { categoryId: cat.id, amountPoisha: 150000, method: 'owner_bkash' }, true).expect(201);
    const pnl = (await g.get('/pnl').expect(200)).body;
    expect(pnl.current).toMatchObject({ income: { fees: 100000, posSales: 100000, lockerFees: 0, total: 200000 }, goodsCost: 40000, gross: 160000, expenses: { total: 150000 }, net: 10000 });
    expect(pnl.previous.net).toBe(0);
    const viewer = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Viewer Nila' }), ['reports.view']);
    await gm.manage(viewer, gym.id).get('/pnl').expect(200);
    const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Kamal' }), ['members.view']);
    expect((await gm.manage(desk, gym.id).get('/pnl').expect(403)).body.code).toBe('PERMISSION_REQUIRED');
  });

  it('VAT on member receipts: off by default, within the cap, kept on each payment and sale', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'standard' });
    const g = gm.manage(owner, gym.id);
    expect((await g.get('/settings').expect(200)).body).toMatchObject({ vatEnabled: false, vatBps: null, vatMaxBps: 1500 });
    await g.patch('/settings', { vatBps: 1600 }).expect(422);
    await g.patch('/settings', { vatEnabled: true, vatBps: 1500 }).expect(200);
    const added = await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.today() }, payment: { amountPoisha: 115000, method: 'cash' } });
    const payment = await models.GymFeePayment.findOne({ where: { memberId: added.member.id } });
    expect(payment.vatBps).toBe(1500);
    const receipt = (await g.get(`/fee-payments/${payment.id}/receipt`).expect(200)).body;
    expect(receipt.vat).toEqual({ bps: 1500, vat: 15000, net: 100000 });
    const p = (await g.post('/products', { name: 'Towel', category: 'apparel', pricePoisha: 23000 }).expect(201)).body;
    await g.post(`/products/${p.id}/stock`, { kind: 'in', qty: 1 }, true).expect(201);
    expect((await g.post('/sales', { lines: [{ productId: p.id, qty: 1 }], method: 'cash' }, true).expect(201)).body.vat).toEqual({ bps: 1500, vat: 3000, net: 20000 });
  });

  it('health fields: blood group for members.edit, body and conditions for the owner; the member sets their own with BMI', async () => {
    const { owner, gym } = await gm.privateGym({ tier: 'basic' });
    const g = gm.manage(owner, gym.id);
    const added = await gm.addMember(owner, gym.id, { bloodGroup: 'B+', heightCm: 175, weightKg: 70, medical: 'Knee injury, 2025' });
    const full = (await g.get(`/members/${added.member.id}`).expect(200)).body.member;
    expect(full).toMatchObject({ bloodGroup: 'B+', heightCm: 175, weightKg: 70, bmi: { value: 22.9, band: 'normal' }, medical: 'Knee injury, 2025' });
    const editor = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Front Desk' }), ['members.view', 'members.edit']);
    const seen = (await gm.manage(editor, gym.id).get(`/members/${added.member.id}`).expect(200)).body.member;
    expect(seen.bloodGroup).toBe('B+');
    expect(seen.medical).toBeUndefined();
    expect(seen.bmi).toBeUndefined();
    const row = await models.GymMember.findByPk(added.member.id);
    expect(row.medicalEnc).not.toContain('Knee');
    // Desk staff may change the blood group, not what they cannot see.
    const ed = gm.manage(editor, gym.id);
    const v = (await g.get(`/members/${added.member.id}`).expect(200)).body.member.version;
    expect((await ed.patch(`/members/${added.member.id}`, { version: v, weightKg: 71 }).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    expect((await ed.patch(`/members/${added.member.id}`, { version: v, bloodGroup: 'A+' }).expect(200)).body.member.bloodGroup).toBe('A+');

    const who = await h.signupUser({ name: 'Linked Lima' });
    const m = await gm.addMember(owner, gym.id, { displayName: 'Linked Lima', phone: who.phone });
    await gm.linkMember(owner, gym.id, m.member.id, who);
    const mine = (await h.api().put(`${h.P}/me/gym-memberships/${m.member.id}/health`).set(h.bearer(who)).send({ heightCm: 160, weightKg: 90, bloodGroup: 'O-' }).expect(200)).body;
    expect(mine).toMatchObject({ bloodGroup: 'O-', bmi: { value: 35.2, band: 'obese' } });
    expect((await h.api().get(`${h.P}/me/gym-memberships/${m.member.id}`).set(h.bearer(who)).expect(200)).body.member.health).toMatchObject({ heightCm: 160, weightKg: 90, bmi: { band: 'obese' } });
  });

  it('the dashboard lists who ends soon and the membership mix; the absent list takes any number of days', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'basic' });
    const g = gm.manage(owner, gym.id);
    await gm.addMember(owner, gym.id, { displayName: 'Ends Soon', membership: { packageId: pkg('month').id, startsOn: gm.inDays(-27) } });
    await gm.addMember(owner, gym.id, { displayName: 'Plenty Left', membership: { packageId: pkg('quarter').id, startsOn: gm.today() } });
    const o = (await g.get('/overview').expect(200)).body;
    expect(o.expiring.map((x) => x.displayName)).toEqual(['Ends Soon']);
    expect(o.expiring[0].daysLeft).toBeGreaterThanOrEqual(0);
    expect(o.mix.active).toBe(2);
    expect((await g.get('/reports/absent?days=7').expect(200)).body).toBeDefined();
    await g.get('/reports/absent?days=0').expect(422);
  });
});
