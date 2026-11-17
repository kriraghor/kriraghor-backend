'use strict';

// M24 §22 the desk through a lost connection (product owner, 11 Nov 2026; ADR-010 amendment; M24-FR-144 to
// FR-152), end to end: the desk copy (members with today's decision, dues only with fees.collect); each item
// taken offline arrives once and is applied at the time it was taken (the stamp's server time plus the time
// that passed on the device); nothing well formed is refused: flagged when the server would have blocked
// the member, the time was adjusted or late, the day's drawer was closed, the PIN was checked on the device
// or the person named is not confirmed; parked when the due was already settled or the member removed; the
// owner's list and its three resolutions; and desk mode (the unlock id confirms the person).
const crypto = require('crypto');
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const gm = require('../fixtures/gym-manage');
const s = require('../../src/modules/gym-manage/gym-manage.schemas');
const rules = require('../../src/modules/gym-manage/gym-manage.rules');
const { hmac } = require('../../src/common/crypto');

const { api, P, models } = h;
jest.setTimeout(300000);

beforeEach(async () => {
  await h.resetDb();
  await h.createSignedInMaster();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const conforms = (schema, body) => expect(schema.safeParse(body).error?.issues ?? []).toEqual([]);
const PASSWORD = 'Front-Desk-2026';
const uuid = () => crypto.randomUUID();
const snapshot = (who, gymId) => gm.manage(who, gymId).get('/desk/snapshot');
const send = (who, gymId, item, key = item.clientId) => api().post(`${P}/manage/gyms/${gymId}/desk/offline-items`).set(h.bearer(who)).set('Idempotency-Key', key).send(item);
const review = (who, gymId, q = '') => gm.manage(who, gymId).get(`/desk/offline-items${q}`);
const resolve = (who, gymId, itemId, body) => gm.manage(who, gymId).post(`/desk/offline-items/${itemId}/resolve`, body);
/** A stamp the server would have made for this gym `hoursAgo` hours ago. */
const stampAt = (gymId, ms) => rules.snapshotStamp({ gymId, ms }, hmac);

/** An item taken offline now under a copy made at `copy` (the device counts the time since). */
const checkin = (copy, memberId, takenBy, extra = {}) => ({ clientId: uuid(), kind: 'checkin', memberId, stamp: copy.stamp, elapsedMs: Math.max(0, Date.now() - Date.parse(copy.serverTime)), takenBy, ...extra });
const cash = (copy, memberId, dueId, amountPoisha, takenBy, extra = {}) => ({ ...checkin(copy, memberId, takenBy), kind: 'cash_fee', dueId, amountPoisha, slipNo: `T-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, ...extra });

/** A Basic gym, its owner, a desk clerk (check-ins and fees), a door keeper (check-ins only) and a coach. */
async function setup() {
  const owner = await h.signupUser({ name: 'Karim Uddin', password: PASSWORD });
  const { gym, pkg } = await gm.privateGym({ owner, tier: 'basic' });
  const clerk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rumi', password: PASSWORD }), ['attendance.mark', 'fees.collect', 'members.view']);
  const door = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Door Sumon' }), ['attendance.mark']);
  const coach = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Coach Tania' }), ['plans.manage', 'members.view']);
  // Rafiq: a running monthly package, ৳1,000 paid of ৳3,500. Tanvir: his month ended, the due is overdue.
  const rafiq = await gm.addMember(owner, gym.id, { displayName: 'Rafiq Hasan', membership: { packageId: pkg('month').id, startsOn: gm.today() }, payment: { amountPoisha: 100000, method: 'cash' } });
  const tanvir = await gm.addMember(owner, gym.id, { displayName: 'Tanvir Ahmed', membership: { packageId: pkg('month').id, startsOn: gm.inDays(-30) } });
  const nasrin = await gm.addMember(owner, gym.id, { displayName: 'Nasrin Akter' });
  return { owner, gym, pkg, clerk, door, coach, rafiq, tanvir, nasrin };
}

describe('M24 the desk through a lost connection', () => {
  it('the desk copy, items sent once, applied at the time taken, flagged and parked, never refused', async () => {
    const { owner, gym, clerk, door, coach, rafiq, tanvir, nasrin } = await setup();

    // FR-144: the copy. The clerk (fees.collect) gets the open dues; the door keeper does not; the coach none.
    const copy = (await snapshot(clerk, gym.id).expect(200)).body;
    conforms(s.DeskSnapshot, copy);
    expect(copy).toMatchObject({ gymId: gym.id, date: gm.today(), refreshMinutes: 10, maxHours: 24, policy: 'warn' });
    const byName = Object.fromEntries(copy.members.map((m) => [m.displayName, m]));
    expect(byName['Rafiq Hasan']).toMatchObject({ id: rafiq.member.id, decision: 'allow', reasons: [], inToday: false, package: { title: 'Monthly', status: 'active' } });
    expect(byName['Tanvir Ahmed']).toMatchObject({ decision: 'warn', reasons: ['expired', 'unpaid'], package: null });
    expect(byName['Nasrin Akter']).toMatchObject({ decision: 'warn', reasons: ['none'] });
    expect(JSON.stringify(copy)).not.toContain(rafiq.member.phone ?? '0171');
    expect(copy.dues.map((d) => [d.memberId, d.outstandingPoisha]).sort()).toEqual([[rafiq.member.id, 250000], [tanvir.member.id, 350000]].sort());
    expect((await snapshot(door, gym.id).expect(200)).body.dues).toBeNull();
    await snapshot(coach, gym.id).expect(403);

    // FR-146: a check-in taken offline is applied once, counted, at the time it was taken, for the clerk.
    const first = checkin(copy, rafiq.member.id, clerk.user.id);
    const sent = await send(clerk, gym.id, first).expect(201);
    conforms(s.OfflineItemResult, sent.body);
    expect(sent.body.item).toMatchObject({ kind: 'checkin', outcome: 'applied', flags: [], recordedAs: { userId: clerk.user.id }, sentBy: { userId: clerk.user.id } });
    expect(Date.parse(sent.body.item.takenAt)).toBe(Date.parse(copy.serverTime) + first.elapsedMs);
    const att = await models.GymAttendance.findByPk(sent.body.item.attendanceId);
    expect(att).toMatchObject({ counted: true, decision: 'allow', method: 'desk', byUser: clerk.user.id, localDate: gm.today() });
    expect(new Date(att.checkedInAt).getTime()).toBe(Date.parse(copy.serverTime) + first.elapsedMs);
    // Sent again (a lost answer): the same item, never a second check-in; also from another sign-in.
    expect((await send(clerk, gym.id, first).expect(201)).body.item.id).toBe(sent.body.item.id);
    expect((await send(owner, gym.id, first).expect(200)).body.item.id).toBe(sent.body.item.id);
    expect(await models.GymAttendance.count({ where: { memberId: rafiq.member.id } })).toBe(1);
    // A second one the same day is kept, not counted.
    const again = (await send(clerk, gym.id, checkin(copy, rafiq.member.id, clerk.user.id, { method: 'member_qr' })).expect(201)).body.item;
    expect(await models.GymAttendance.findByPk(again.attendanceId)).toMatchObject({ counted: false, method: 'member_qr' });

    // FR-148: cash taken offline gets its real receipt number now, keeps the day it was taken, names the slip.
    const fee = cash(copy, rafiq.member.id, copy.dues.find((d) => d.memberId === rafiq.member.id).id, 150000, clerk.user.id);
    const paid = (await send(clerk, gym.id, fee).expect(201)).body.item;
    expect(paid).toMatchObject({ kind: 'cash_fee', outcome: 'applied', amountPoisha: 150000, slipNo: fee.slipNo, receipt: { receiptNo: expect.stringMatching(/^IY-R\d{2}-\d{6}$/) } });
    const payment = await models.GymFeePayment.findByPk(paid.receipt.feePaymentId);
    expect(payment).toMatchObject({ method: 'cash', amountPoisha: 150000, paidOn: gm.today(), receivedBy: clerk.user.id, note: `Offline slip ${fee.slipNo}` });
    expect((await models.GymDue.findByPk(fee.dueId)).paidPoisha).toBe(250000);
    const audit = await models.AuditLog.findOne({ where: { action: 'gym_fee.recorded', entityId: payment.id } });
    expect(audit.meta).toMatchObject({ gymId: gym.id, offline: { clientId: fee.clientId, slipNo: fee.slipNo } });

    // FR-149, flagged: the gym now blocks Tanvir; he is already inside, so it is recorded as a warning.
    await gm.manage(owner, gym.id).patch('/settings', { entryPolicy: 'block' }).expect(200);
    const blocked = (await send(clerk, gym.id, checkin(copy, tanvir.member.id, clerk.user.id)).expect(201)).body.item;
    expect(blocked).toMatchObject({ outcome: 'flagged', flags: ['would_block'] });
    expect(await models.GymAttendance.findByPk(blocked.attendanceId)).toMatchObject({ counted: true, decision: 'warn', reasons: ['expired', 'unpaid'] });
    // A time after the server's clock becomes the time it arrived.
    const ahead = (await send(clerk, gym.id, checkin(copy, nasrin.member.id, clerk.user.id, { elapsedMs: Date.now() - Date.parse(copy.serverTime) + 3600000 })).expect(201)).body.item;
    expect(ahead.flags).toEqual(expect.arrayContaining(['time_adjusted', 'would_block']));
    expect(Math.abs(Date.parse(ahead.takenAt) - Date.now())).toBeLessThan(60000);
    // A copy from 30 hours ago, sent now: late, dated the day it was taken.
    const old = Date.now() - 30 * 3600000;
    const late = (await send(clerk, gym.id, cash({ stamp: stampAt(gym.id, old), serverTime: new Date(old).toISOString() }, tanvir.member.id, copy.dues.find((d) => d.memberId === tanvir.member.id).id, 50000, clerk.user.id, { elapsedMs: 0 })).expect(201)).body.item;
    expect(late).toMatchObject({ outcome: 'flagged', flags: ['late'], takenOn: rules.dhakaDate(new Date(old)) });
    expect((await models.GymFeePayment.findByPk(late.receipt.feePaymentId)).paidOn).toBe(rules.dhakaDate(new Date(old)));
    // Today's cash drawer is already closed.
    await models.GymCashSession.create({ gymId: gym.id, businessDate: gm.today(), openingPoisha: 0, openedBy: owner.user.id, status: 'closed', countedPoisha: 0, expectedPoisha: 0, differencePoisha: 0, closedBy: owner.user.id, closedAt: new Date() });
    const drawer = (await send(clerk, gym.id, cash(copy, tanvir.member.id, late.dueId, 50000, clerk.user.id)).expect(201)).body.item;
    expect(drawer).toMatchObject({ outcome: 'flagged', flags: ['drawer_closed'] });
    // The person named is not confirmed: the owner without an unlock (recorded for the owner), or the coach,
    // who may not take fees (recorded for the clerk who sent it).
    const forOwner = (await send(clerk, gym.id, checkin(copy, rafiq.member.id, owner.user.id)).expect(201)).body.item;
    expect(forOwner).toMatchObject({ outcome: 'flagged', flags: ['unverified_taker'], takenBy: { userId: owner.user.id }, recordedAs: { userId: owner.user.id } });
    const forCoach = (await send(clerk, gym.id, cash(copy, tanvir.member.id, late.dueId, 10000, coach.user.id)).expect(201)).body.item;
    expect(forCoach).toMatchObject({ flags: expect.arrayContaining(['unverified_taker', 'drawer_closed']), takenBy: { userId: coach.user.id }, recordedAs: { userId: clerk.user.id } });
    expect((await models.GymFeePayment.findByPk(forCoach.receipt.feePaymentId)).receivedBy).toBe(clerk.user.id);

    // Parked: the due is settled now; the member was removed. Nothing is applied.
    const settle = copy.dues.find((d) => d.memberId === rafiq.member.id);
    await gm.manage(owner, gym.id).post(`/dues/${settle.id}/payments`, { amountPoisha: 100000, method: 'cash' }, true).expect(201);
    const parked = (await send(clerk, gym.id, cash(copy, rafiq.member.id, settle.id, 50000, clerk.user.id)).expect(201)).body.item;
    expect(parked).toMatchObject({ outcome: 'parked', parkReason: 'due_paid', receipt: null });
    await gm.manage(owner, gym.id).post(`/members/${nasrin.member.id}/remove`, { reason: 'Moved away' }).expect(200);
    const gone = (await send(clerk, gym.id, checkin(copy, nasrin.member.id, clerk.user.id)).expect(201)).body.item;
    expect(gone).toMatchObject({ outcome: 'parked', parkReason: 'member_removed', attendanceId: null });

    // Malformed: refused (422). A stamp of another gym, a due of another member, a cash fee without a slip,
    // a client id that is not the key. A sender without the permission: 403.
    const other = await gm.privateGym({ name: 'Other Gym', shortCode: 'OG' });
    expect((await send(clerk, gym.id, checkin({ ...copy, stamp: stampAt(other.gym.id, Date.now()) }, rafiq.member.id, clerk.user.id)).expect(422)).body.code).toBe('GYM_OFFLINE_STAMP_INVALID');
    expect((await send(clerk, gym.id, checkin({ ...copy, stamp: `${copy.stamp.slice(0, -1)}0` }, rafiq.member.id, clerk.user.id)).expect(422)).body.code).toBe('GYM_OFFLINE_STAMP_INVALID');
    expect((await send(clerk, gym.id, cash(copy, rafiq.member.id, late.dueId, 10000, clerk.user.id)).expect(422)).body.code).toBe('GYM_OFFLINE_ITEM_INVALID');
    const noSlip = cash(copy, tanvir.member.id, late.dueId, 10000, clerk.user.id);
    delete noSlip.slipNo;
    await send(clerk, gym.id, noSlip).expect(422);
    await send(clerk, gym.id, checkin(copy, rafiq.member.id, clerk.user.id), gm.key('other')).expect(422);
    await send(door, gym.id, cash(copy, tanvir.member.id, late.dueId, 10000, door.user.id)).expect(403);
    await send(coach, gym.id, checkin(copy, rafiq.member.id, coach.user.id)).expect(403);
  });

  it('the owner’s list: who may see it, checked, cash applied to another due, cash returned (FR-150)', async () => {
    const { owner, gym, pkg, clerk, rafiq, tanvir } = await setup();
    const copy = (await snapshot(clerk, gym.id).expect(200)).body;
    const due = copy.dues.find((d) => d.memberId === rafiq.member.id);
    // Rafiq pays in full at the counter; two cash fees taken offline for that due are parked.
    await gm.manage(owner, gym.id).post(`/dues/${due.id}/payments`, { amountPoisha: 250000, method: 'cash' }, true).expect(201);
    const parkedA = (await send(clerk, gym.id, cash(copy, rafiq.member.id, due.id, 120000, clerk.user.id)).expect(201)).body.item;
    const parkedB = (await send(clerk, gym.id, cash(copy, rafiq.member.id, due.id, 30000, clerk.user.id)).expect(201)).body.item;
    await gm.manage(owner, gym.id).patch('/settings', { entryPolicy: 'block' }).expect(200);
    const flagged = (await send(clerk, gym.id, checkin(copy, tanvir.member.id, clerk.user.id)).expect(201)).body.item;
    const applied = (await send(clerk, gym.id, checkin(copy, rafiq.member.id, clerk.user.id)).expect(201)).body.item;

    // The owner and fees.adjust staff only.
    await review(clerk, gym.id).expect(403);
    const list = (await review(owner, gym.id).expect(200)).body;
    conforms(s.OfflineItems, list);
    expect(list.toCheck).toBe(3);
    expect(list.items.map((x) => x.id)).toEqual([parkedA.id, parkedB.id, flagged.id]);
    expect((await review(owner, gym.id, '?state=all').expect(200)).body.items).toHaveLength(4);

    // Only waiting items, and the right action for each.
    expect((await resolve(owner, gym.id, applied.id, { action: 'checked' }).expect(409)).body.code).toBe('GYM_OFFLINE_ITEM_STATE');
    await resolve(owner, gym.id, parkedA.id, { action: 'checked' }).expect(409);
    await resolve(owner, gym.id, flagged.id, { action: 'returned', note: 'Gave it back' }).expect(409);
    const checked = (await resolve(owner, gym.id, flagged.id, { action: 'checked', note: 'He paid at the counter' }).expect(200)).body;
    conforms(s.OfflineItemResult, checked);
    expect(checked.item).toMatchObject({ resolution: 'checked', resolvedBy: { userId: owner.user.id }, resolutionNote: 'He paid at the counter' });
    await resolve(owner, gym.id, flagged.id, { action: 'checked' }).expect(409);

    // Parked cash onto Rafiq's next month (a receipt now, dated the day it was taken); not onto another member's due.
    const next = (await gm.manage(owner, gym.id).post(`/members/${rafiq.member.id}/memberships`, { packageId: pkg('month').id, startsOn: gm.inDays(30) }, true).expect(201)).body;
    const tanvirDue = copy.dues.find((d) => d.memberId === tanvir.member.id);
    await resolve(owner, gym.id, parkedA.id, { action: 'apply' }).expect(422);
    await resolve(owner, gym.id, parkedA.id, { action: 'apply', dueId: tanvirDue.id }).expect(404);
    const moved = (await resolve(owner, gym.id, parkedA.id, { action: 'apply', dueId: next.due.id }).expect(200)).body.item;
    expect(moved).toMatchObject({ resolution: 'applied_to_due', resolutionReceipt: { receiptNo: expect.any(String) } });
    const p = await models.GymFeePayment.findByPk(moved.resolutionReceipt.feePaymentId);
    expect(p).toMatchObject({ dueId: next.due.id, amountPoisha: 120000, paidOn: parkedA.takenOn, receivedBy: clerk.user.id, method: 'cash' });

    // Returned: a note says how.
    await resolve(owner, gym.id, parkedB.id, { action: 'returned' }).expect(422);
    expect((await resolve(owner, gym.id, parkedB.id, { action: 'returned', note: 'Handed back to Rafiq' }).expect(200)).body.item.resolution).toBe('returned');
    expect((await review(owner, gym.id).expect(200)).body).toMatchObject({ toCheck: 0, items: [] });

    // fees.adjust staff may resolve; the audit has every step.
    const audits = await models.AuditLog.findAll({ where: { action: ['gym_offline.received', 'gym_offline.resolved'] } });
    expect(audits.filter((a) => a.action === 'gym_offline.received')).toHaveLength(4);
    expect(audits.filter((a) => a.action === 'gym_offline.resolved')).toHaveLength(3);
  });

  it('desk mode: the copy needs an unlock; an unlock confirms the person; a PIN checked on the device is flagged', async () => {
    const { owner, gym, clerk, rafiq, tanvir } = await setup();
    await api().put(`${P}/me/gym-desk-pins`).set(h.bearer(owner)).send({ gymId: gym.id, pin: '4826' }).expect(200);
    await api().put(`${P}/me/gym-desk-pins`).set(h.bearer(clerk)).send({ gymId: gym.id, pin: '5937' }).expect(200);
    await api().post(`${P}/manage/gyms/${gym.id}/desk-mode/open`).set(h.bearer(clerk)).expect(201);
    const device = clerk;
    expect((await snapshot(device, gym.id).expect(423)).body.code).toBe('GYM_DESK_LOCKED');

    // The owner unlocks, the copy arrives; the owner's unlock id comes with the desk state.
    const asOwner = (await api().post(`${P}/manage/desk-mode/unlock`).set(h.bearer(device)).send({ userId: owner.user.id, pin: '4826' }).expect(200)).body;
    expect(asOwner.unlocked.unlockId).toEqual(expect.any(String));
    const copy = (await snapshot(device, gym.id).expect(200)).body;
    // The clerk unlocks later and sends what the owner took offline: the owner's unlock confirms the owner.
    const deskState = (await api().post(`${P}/manage/desk-mode/unlock`).set(h.bearer(device)).send({ userId: clerk.user.id, pin: '5937' }).expect(200)).body;
    const owners = (await send(device, gym.id, checkin(copy, rafiq.member.id, owner.user.id, { unlockId: asOwner.unlocked.unlockId })).expect(201)).body.item;
    expect(owners).toMatchObject({ outcome: 'applied', flags: [], takenBy: { userId: owner.user.id }, recordedAs: { userId: owner.user.id }, sentBy: { userId: clerk.user.id } });
    const row = await models.GymDeskOfflineItem.findByPk(owners.id);
    expect(row).toMatchObject({ deskSessionId: deskState.deskId, unlockId: asOwner.unlocked.unlockId });
    // Another person's unlock does not confirm the owner.
    const wrong = (await send(device, gym.id, checkin(copy, tanvir.member.id, owner.user.id, { unlockId: deskState.unlocked.unlockId })).expect(201)).body.item;
    expect(wrong.flags).toContain('unverified_taker');
    // A PIN checked on the device, without a connection: always flagged for the owner.
    const onDevice = (await send(device, gym.id, cash(copy, rafiq.member.id, copy.dues.find((d) => d.memberId === rafiq.member.id).id, 50000, clerk.user.id, { pinOnDevice: true })).expect(201)).body.item;
    expect(onDevice).toMatchObject({ outcome: 'flagged', flags: ['pin_on_device'], pinOnDevice: true, recordedAs: { userId: clerk.user.id } });
    // Locked again: nothing is sent until someone unlocks.
    await api().post(`${P}/manage/desk-mode/lock`).set(h.bearer(device)).expect(200);
    expect((await send(device, gym.id, checkin(copy, rafiq.member.id, clerk.user.id)).expect(423)).body.code).toBe('GYM_DESK_LOCKED');
  });
});
