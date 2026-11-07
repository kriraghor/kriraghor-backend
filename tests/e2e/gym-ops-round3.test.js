'use strict';

// M27 gym operations, round 3, end to end: staff shifts and clocking (the entrance QR on the staff member's
// phone, the desk, the auto-close job), the day's board and the month's report; pay terms and the monthly
// payroll (draft, bonus and deduction, approve, pay as a salary expense, payslips, the plan tier); the
// equipment register (service interval, the reminder, a service with its cost as an expense, retiring).
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const gm = require('../fixtures/gym-manage');
const staffSvc = require('../../src/modules/gym-ops/staff.service');
const assetsSvc = require('../../src/modules/gym-ops/assets.service');

const { models } = h;

beforeEach(async () => {
  await h.resetDb();
  await h.createSignedInMaster();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const outbox = (name) => models.OutboxEvent.count({ where: { name } });
const me = (who) => ({
  get: (p) => h.api().get(`${h.P}${p}`).set(h.bearer(who)),
  post: (p, body = {}) => h.api().post(`${h.P}${p}`).set(h.bearer(who)).send(body),
});
const staffIdOf = async (gymId, who) => (await models.BusinessMember.findOne({ where: { businessId: gymId, memberId: who.user.id } })).id;
/** Move clock rows back in time (the table is append-only; tests only). */
async function backdateClocks(staffId, ms) {
  await models.sequelize.query('ALTER TABLE gym_staff_times DISABLE TRIGGER trg_gym_staff_times_append_only');
  await models.sequelize.query("UPDATE gym_staff_times SET at = at - (:ms || ' milliseconds')::interval WHERE business_member_id = :id", { replacements: { id: staffId, ms: String(ms) } });
  await models.sequelize.query('ALTER TABLE gym_staff_times ENABLE TRIGGER trg_gym_staff_times_append_only');
}

describe('M27 staff attendance', () => {
  it('shifts, clocking by the entrance QR and at the desk, the board, the auto-close job and the report', async () => {
    const { owner, gym } = await gm.privateGym({ tier: 'standard' });
    const g = gm.manage(owner, gym.id);
    const rumi = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rumi' }), ['attendance.mark', 'members.view', 'clock.in']);
    const noClock = await gm.hire(owner, gym.id, await h.signupUser({ name: 'No Clock' }), ['members.view']);
    const rumiId = await staffIdOf(gym.id, rumi);

    // Shifts (M27-FR-72): the owner sets them; a bad one is refused.
    expect((await g.put(`/staff/${rumiId}/shifts`, { shifts: [{ dow: 1, startTime: '14:00', endTime: '06:00' }] }).expect(422)).body.code).toBe('GYM_SHIFT_TIMES');
    const set = (await g.put(`/staff/${rumiId}/shifts`, { shifts: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, startTime: '06:00', endTime: '14:00' })) }).expect(200)).body;
    expect(set.shifts).toHaveLength(7);
    expect((await g.get('/staff-shifts').expect(200)).body.items.find((x) => x.staff.id === rumiId).shifts).toHaveLength(7);
    await gm.manage(rumi, gym.id).put(`/staff/${rumiId}/shifts`, { shifts: [] }).expect(403);

    // Clocking by the entrance QR (M27-FR-73): in, then out; the owner and staff without clock.in cannot.
    const token = (await g.get('/entrance-token').expect(200)).body.token;
    const first = (await me(rumi).post('/me/gym-staff-clock', { token }).expect(201)).body;
    expect(first).toMatchObject({ kind: 'in', method: 'entrance_qr', gym: { id: gym.id } });
    expect((await gm.manage(rumi, gym.id).get('/staff-clock/me').expect(200)).body).toMatchObject({ clockedIn: true, todayShifts: [{ startTime: '06:00' }] });
    await backdateClocks(rumiId, 2 * 3600000);
    expect((await me(rumi).post('/me/gym-staff-clock', { token }).expect(201)).body).toMatchObject({ kind: 'out', minutes: 120 });
    expect((await me(owner).post('/me/gym-staff-clock', { token }).expect(403)).body.code).toBe('GYM_NOT_STAFF');
    expect((await me(noClock).post('/me/gym-staff-clock', { token }).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    expect((await me(rumi).post('/me/gym-staff-clock', { token: 'v1.ge.nonsense.token.here' }).expect(422)).body.code).toBe('GYM_CLOCK_TOKEN_INVALID');
    expect(await outbox('gym_staff_time.recorded')).toBe(2);

    // At the desk: the owner clocks Rumi in; twice is refused; staff without shifts.manage cannot.
    expect((await g.post('/staff-times', { staffId: rumiId, kind: 'in' }).expect(201)).body.kind).toBe('in');
    expect((await g.post('/staff-times', { staffId: rumiId, kind: 'in' }).expect(409)).body.code).toBe('GYM_STAFF_ALREADY_IN');
    await gm.manage(rumi, gym.id).post('/staff-times', { staffId: rumiId, kind: 'out' }).expect(403);
    const board = (await g.get('/staff-attendance').expect(200)).body;
    expect(board.inNow).toBe(1);
    expect(board.items.find((x) => x.staff.id === rumiId)).toMatchObject({ clockedIn: true, minutes: 120 });

    // Left open: the job closes it after the window, with no hours.
    await backdateClocks(rumiId, 15 * 3600000);
    expect(await staffSvc.autoClockOut()).toEqual({ closed: 1 });
    expect(await staffSvc.autoClockOut()).toEqual({ closed: 0 });
    const report = (await g.get('/staff-report').expect(200)).body;
    expect(report.items.find((x) => x.staff.id === rumiId)).toMatchObject({ workedMinutes: 120 });

    // The plan: Basic has no staff attendance.
    const basic = await gm.privateGym({ tier: 'basic', name: 'Basic Gym', shortCode: 'BG' });
    expect((await gm.manage(basic.owner, basic.gym.id).get('/staff-attendance').expect(403)).body).toMatchObject({ code: 'GYM_TIER_REQUIRED', feature: 'staff_attendance', minTier: 'standard' });
  });
});

describe('M27 payroll', () => {
  it('pay terms, a month drafted from fees and sales, bonus and deduction, approve, pay as a salary expense, payslips', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'pro' });
    const g = gm.manage(owner, gym.id);
    const tania = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Coach Tania' }), ['members.view', 'members.trainer', 'pos.sell']);
    const other = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Other Staff' }), ['members.view']);
    const taniaId = await staffIdOf(gym.id, tania);
    const otherId = await staffIdOf(gym.id, other);

    // Terms (M27-FR-76): limits; the owner only.
    expect((await g.put(`/staff/${taniaId}/pay`, { basePoisha: 1500000, ptCommissionBps: 6000, salesCommissionBps: 0 }).expect(422)).body.code).toBe('GYM_COMMISSION_OUT_OF_RANGE');
    await g.put(`/staff/${taniaId}/pay`, { basePoisha: 1500000, ptCommissionBps: 1000, salesCommissionBps: 500 }).expect(200);
    await g.put(`/staff/${otherId}/pay`, { basePoisha: 1000000, ptCommissionBps: 0, salesCommissionBps: 0 }).expect(200);
    await gm.manage(tania, gym.id).get('/staff-pay').expect(403);
    expect((await g.get('/staff-pay').expect(200)).body.items.find((x) => x.staff.id === taniaId)).toMatchObject({ staff: { trainer: true, seller: true }, terms: { basePoisha: 1500000, set: true } });

    // The month's facts: a member assigned to Tania pays ৳2,000; Tania sells ৳900 at the counter.
    const m = await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.today() } });
    await models.GymMember.update({ trainerBusinessMemberId: taniaId }, { where: { id: m.member.id } });
    await g.post(`/dues/${m.due.id}/payments`, { amountPoisha: 200000, method: 'cash' }, true).expect(201);
    const p = (await g.post('/products', { name: 'Whey sachet', category: 'supplement', pricePoisha: 90000, costPoisha: 60000 }).expect(201)).body;
    await g.post(`/products/${p.id}/stock`, { kind: 'in', qty: 5 }, true).expect(201);
    await gm.manage(tania, gym.id).post('/sales', { lines: [{ productId: p.id, qty: 1 }], method: 'card_counter' }, true).expect(201);

    const period = gm.today().slice(0, 7);
    expect((await g.post('/payroll', { period: '2099-01' }).expect(422)).body.code).toBe('GYM_PAYROLL_PERIOD');
    const run = (await g.post('/payroll', { period }).expect(201)).body;
    expect(run).toMatchObject({ status: 'draft', staffCount: 2 });
    const line = run.lines.find((l) => l.staff.id === taniaId);
    // ৳15,000 + 10% of ৳2,000 + 5% of ৳900 = ৳15,245.
    expect(line).toMatchObject({ ptBasePoisha: 200000, ptCommissionPoisha: 20000, salesBasePoisha: 90000, salesCommissionPoisha: 4500, netPoisha: 1524500 });
    expect((await g.post('/payroll', { period }).expect(409)).body.code).toBe('GYM_PAYROLL_EXISTS');

    // Bonus and deduction on the draft (M27-FR-78); a deduction larger than the pay is refused.
    expect((await g.patch(`/payroll/${run.id}/lines/${line.id}`, { deductionPoisha: 2000000 }).expect(422)).body.code).toBe('GYM_PAYROLL_NEGATIVE');
    const changed = (await g.patch(`/payroll/${run.id}/lines/${line.id}`, { bonusPoisha: 50000, deductionPoisha: 20000, note: 'Late twice' }).expect(200)).body;
    expect(changed.lines.find((l) => l.id === line.id).netPoisha).toBe(1554500);
    const recalc = (await g.post(`/payroll/${run.id}/recalculate`).expect(200)).body;
    expect(recalc.lines.find((l) => l.id === line.id)).toMatchObject({ bonusPoisha: 50000, netPoisha: 1554500 });

    // Payslips before approval are the owner's only; approve freezes it.
    await gm.manage(tania, gym.id).get(`/payroll/${run.id}/lines/${line.id}/payslip`).expect(404);
    expect((await g.post(`/payroll/${run.id}/approve`).expect(200)).body.status).toBe('approved');
    expect((await g.patch(`/payroll/${run.id}/lines/${line.id}`, { bonusPoisha: 1 }).expect(409)).body.code).toBe('GYM_PAYROLL_STATE');
    expect(await outbox('gym_payroll.approved')).toBe(1);

    // Paying a line records a salary expense (M27-FR-80); the run is paid when every line is.
    const paid = (await g.post(`/payroll/${run.id}/lines/${line.id}/pay`, { method: 'bank' }, true).expect(200)).body;
    expect(paid).toMatchObject({ status: 'approved', paidPoisha: 1554500 });
    expect((await g.post(`/payroll/${run.id}/lines/${line.id}/pay`, { method: 'bank' }, true).expect(409)).body.code).toBe('GYM_PAYROLL_LINE_STATE');
    const expense = await models.GymExpense.findOne({ where: { gymId: gym.id, source: 'payroll' } });
    expect(expense).toMatchObject({ amountPoisha: 1554500, method: 'bank', sourceId: line.id });
    const otherLine = paid.lines.find((l) => l.staff.id === otherId);
    expect((await g.post(`/payroll/${run.id}/lines/${otherLine.id}/pay`, { method: 'cash' }, true).expect(200)).body.status).toBe('paid');
    expect((await g.post(`/payroll/${run.id}/void`, { reason: 'Wrong month' }).expect(409)).body.code).toBe('GYM_PAYROLL_STATE');
    expect(await outbox('gym_payroll_line.paid')).toBe(2);

    // Payslips (M27-FR-81): Tania sees hers, not the other one.
    const mine = (await gm.manage(tania, gym.id).get('/my-payslips').expect(200)).body.items;
    expect(mine).toEqual([expect.objectContaining({ lineId: line.id, period, netPoisha: 1554500, status: 'paid' })]);
    expect((await gm.manage(tania, gym.id).get(`/payroll/${run.id}/lines/${line.id}/payslip`).expect(200)).body).toMatchObject({ period, gym: { name: gym.name }, line: { note: 'Late twice' } });
    await gm.manage(tania, gym.id).get(`/payroll/${run.id}/lines/${otherLine.id}/payslip`).expect(404);

    // The plan: payroll is Pro.
    const std = await gm.privateGym({ tier: 'standard', name: 'Std Gym', shortCode: 'SG' });
    expect((await gm.manage(std.owner, std.gym.id).get('/payroll').expect(403)).body).toMatchObject({ code: 'GYM_TIER_REQUIRED', feature: 'payroll', minTier: 'pro' });
  });

  it('a draft can be voided and the month drafted again; nobody with pay terms → 422', async () => {
    const { owner, gym } = await gm.privateGym({ tier: 'pro' });
    const g = gm.manage(owner, gym.id);
    const period = gm.today().slice(0, 7);
    expect((await g.post('/payroll', { period }).expect(422)).body.code).toBe('GYM_PAYROLL_EMPTY');
    const s = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Solo Staff' }), ['members.view']);
    await g.put(`/staff/${await staffIdOf(gym.id, s)}/pay`, { basePoisha: 500000, ptCommissionBps: 0, salesCommissionBps: 0 }).expect(200);
    const run = (await g.post('/payroll', { period }).expect(201)).body;
    expect((await g.post(`/payroll/${run.id}/void`, { reason: 'Started too early' }).expect(200)).body.status).toBe('void');
    expect((await g.post('/payroll', { period }).expect(201)).body.status).toBe('draft');
    expect((await g.get('/payroll').expect(200)).body.items.map((x) => x.status)).toEqual(['draft', 'void']);
  });
});

describe('M27 equipment', () => {
  it('a machine with a service interval, the reminder once, a service with its cost as an expense, retiring', async () => {
    const { owner, gym } = await gm.privateGym({ tier: 'standard' });
    const g = gm.manage(owner, gym.id);
    const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk No Assets' }), ['members.view']);
    const tech = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Tech Rafi' }), ['assets.manage']);
    await gm.manage(desk, gym.id).get('/assets').expect(403);

    const t = (await gm.manage(tech, gym.id).post('/assets', { name: 'Treadmill T1', category: 'cardio', serial: 'TM-001', boughtOn: gm.inDays(-29), costPoisha: 15000000, serviceEveryDays: 30 }).expect(201)).body;
    expect(t).toMatchObject({ status: 'working', nextServiceOn: gm.inDays(1), serviceDue: false });
    expect((await g.post('/assets', { name: 'Future', category: 'other', boughtOn: gm.inDays(3) }).expect(422)).body.code).toBe('GYM_DATE_OUT_OF_RANGE');

    // The reminder (M27-FR-85): once per due date, to the owner and assets.manage staff.
    expect(await assetsSvc.serviceReminders()).toEqual({ sent: 1 });
    expect(await assetsSvc.serviceReminders()).toEqual({ sent: 0 });
    await h.drainEvents();
    expect(await models.Notification.count({ where: { code: 'GYM_ASSET_SERVICE_DUE' } })).toBe(2);

    // A service with its cost as an expense (M27-FR-84): the next date moves on.
    const after = (await gm.manage(tech, gym.id).post(`/assets/${t.id}/logs`, { kind: 'service', costPoisha: 150000, note: 'Belt oiled', expense: { method: 'cash' } }, true).expect(201)).body;
    expect(after.asset).toMatchObject({ lastServiceOn: gm.today(), nextServiceOn: gm.inDays(30), status: 'working' });
    expect(after.items[0]).toMatchObject({ kind: 'service', costPoisha: 150000, expenseId: expect.any(String) });
    expect(await models.GymExpense.count({ where: { gymId: gym.id, source: 'asset', amountPoisha: 150000 } })).toBe(1);
    expect((await g.post(`/assets/${t.id}/logs`, { kind: 'repair', expense: { method: 'cash' } }, true).expect(422)).body.code).toBe('VALIDATION_FAILED');

    // A status change is logged; retiring is final.
    await g.patch(`/assets/${t.id}`, { status: 'out_of_order', statusNote: 'Motor noise' }).expect(200);
    const list = (await g.get('/assets').expect(200)).body;
    expect(list.counts).toMatchObject({ out_of_order: 1, working: 0 });
    await g.patch(`/assets/${t.id}`, { status: 'retired' }).expect(200);
    expect((await g.post(`/assets/${t.id}/logs`, { kind: 'note', note: 'Gone' }, true).expect(409)).body.code).toBe('GYM_ASSET_STATE');
    expect((await g.get(`/assets/${t.id}/logs`).expect(200)).body.items.map((x) => x.kind)).toEqual(['status', 'status', 'service']);
  });
});
