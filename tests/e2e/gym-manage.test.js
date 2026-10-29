'use strict';

// M24 prompt 1 (Desk MVP) end to end: a private gym on a verified phone (FR-01, FR-09), members and
// account links by consent (FR-10 to FR-23), memberships (FR-24 to FR-31), dues, counter payments,
// reversals, waivers, receipts and cash closing (FR-32 to FR-39), check-ins and the entry policy
// (FR-47 to FR-52), imports (FR-75 to FR-80), the plan (FR-81 to FR-83), the staff route matrix
// (FR-03 to FR-08), the jobs run twice, and the privacy scans (FR-106 to FR-108).
const ExcelJS = require('exceljs');
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const f = require('../fixtures/market');
const gm = require('../fixtures/gym-manage');
const b = require('../fixtures/business');
const rules = require('../../src/modules/gym-manage/gym-manage.rules');
const bmRules = require('../../src/modules/business-members/business-members.rules');
const jobs = require('../../src/modules/gym-manage/gym-manage.jobs');
const s = require('../../src/modules/gym-manage/gym-manage.schemas');
const config = require('../../src/config');

const { api, P, models } = h;
jest.setTimeout(180000);

let master;
beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

/** The OpenAPI response schema accepts the answer as it is. */
const conforms = (schema, body) => expect(schema.safeParse(body).error?.issues ?? []).toEqual([]);
const PHONE = /(\+?880|\b0)1[3-9]\d{8}/;
const ledgerRows = () => models.LedgerEntry.count();

describe('private gym and onboarding (FR-01, FR-02, FR-09, FR-24, FR-81)', () => {
  it('a verified phone runs a private gym with only a month package; the subscription comes with the first gym', async () => {
    const noPhone = await h.signupUser({ name: 'No Phone' });
    await models.User.update({ phoneVerifiedAt: null }, { where: { id: noPhone.user.id } });
    await models.User.increment('authzVersion', { where: { id: noPhone.user.id } });
    await f.refresh(noPhone);
    const areaId = await f.areaId('banani');
    expect((await api().post(`${P}/me/gyms`).set(h.bearer(noPhone)).send({ name: 'Nope Gym', areaId, addressLine: 'House 1, Road 1, Banani' }).expect(403)).body.code).toBe('PHONE_REQUIRED');

    const { owner, gym, pkg } = await gm.privateGym({ shortCode: null });
    expect(gym).toMatchObject({ status: 'draft', limits: { maxCustomPackages: 10, kindDays: { half_year: 180, year: 365 } } });
    expect(pkg('custom')).toMatchObject({ days: 45, channel: 'desk', visitLimit: 3, admissionFee: 0 });
    expect(pkg('month')).toMatchObject({ admissionFee: 100000, channel: 'both' });
    // Private: not in the directory; submitting for review still needs the gym_owner role (FR-02).
    expect((await api().get(`${P}/gym/gyms`).expect(200)).body.items).toEqual([]);
    expect((await api().post(`${P}/me/gyms/${gym.id}/submit`).set(h.bearer(owner)).expect(403)).body.code).toBe('KYC_REQUIRED');
    // FR-81: one subscription, tier free; a second gym reuses it.
    expect(await models.GymOwnerSubscription.count({ where: { ownerId: owner.user.id } })).toBe(1);
    const second = await gm.privateGym({ owner, name: 'Iron Yard Gulshan', shortCode: 'IYG' });
    expect(await models.GymOwnerSubscription.count({ where: { ownerId: owner.user.id } })).toBe(1);
    expect((await models.GymOwnerSubscription.findOne({ where: { ownerId: owner.user.id } })).chosenTier).toBe('free');

    // Setup: nothing works before the short code; the short code is unique among the owner's gyms.
    const g = gm.manage(owner, gym.id);
    expect((await g.get('/settings').expect(200)).body).toMatchObject({ setupDone: false, shortCode: null, entryPolicy: 'warn' });
    expect((await g.post('/members', { displayName: 'Too Early', phone: h.nextPhone() }, true).expect(409)).body).toMatchObject({ code: 'GYM_SETUP_REQUIRED', step: 'short_code' });
    expect((await g.patch('/settings', { entryPolicy: 'block' }).expect(409)).body.code).toBe('GYM_SETUP_REQUIRED');
    expect((await g.patch('/settings', { shortCode: 'iyg' }).expect(409)).body.code).toBe('GYM_SHORT_CODE_TAKEN');
    expect((await g.patch('/settings', { shortCode: 'I' }).expect(422)).body.code).toBe('VALIDATION_FAILED');
    const set = (await g.patch('/settings', { shortCode: 'iy', tin: '123456789012', receiptFooter: 'Thank you' }).expect(200)).body;
    expect(set).toMatchObject({ setupDone: true, shortCode: 'IY', nextMemberCode: 'IY-0001', tin: '123456789012' });
    conforms(s.Settings, set);
    expect((await g.patch('/settings', { absentAlertDays: 2 }).expect(422)).body.code).toBe('VALIDATION_FAILED');
    expect(await models.AuditLog.count({ where: { action: 'gym_manage.settings_changed' } })).toBe(2);

    // My gyms: tier, features (Free: no check-ins), today's numbers.
    const mine = (await api().get(`${P}/manage/gyms`).set(h.bearer(owner)).expect(200)).body;
    conforms(s.ManageGyms, mine);
    expect(mine.items.map((x) => [x.name, x.role, x.shortCode])).toEqual([
      ['Iron Yard Banani', 'owner', 'IY'],
      ['Iron Yard Gulshan', 'owner', 'IYG'],
    ]);
    expect(mine.owner).toMatchObject({ tier: 'free', features: { attendance: false, plans: false }, restricted: false });
    expect(second.gym.id).toBeDefined();

    // The public pricing comes from settings.
    const pricing = (await api().get(`${P}/gym-manage/pricing`).expect(200)).body;
    conforms(s.Pricing, pricing);
    expect(pricing.tiers.map((t) => [t.key, t.maxMembers, t.pricePoisha])).toEqual([
      ['free', 30, 0],
      ['basic', 100, 79900],
      ['standard', 300, 150000],
      ['pro', null, 250000],
    ]);
    expect(pricing.tiers[1].features).toEqual(['attendance', 'reminders', 'online_fees']);

    // Billing: choose a tier (features unlock at once; the month keeps the highest).
    const bill = (await api().put(`${P}/manage/billing/tier`).set(h.bearer(owner)).send({ tier: 'standard' }).expect(200)).body;
    conforms(s.Billing, bill);
    expect(bill).toMatchObject({ subscription: { chosenTier: 'standard', monthMaxTier: 'standard' }, features: { attendance: true, plans: true, multi_gym: false }, activeMembers: { today: 0, limit: 300, fitTier: 'free' } });
    expect((await api().put(`${P}/manage/billing/tier`).set(h.bearer(owner)).send({ tier: 'basic' }).expect(200)).body.subscription).toMatchObject({ chosenTier: 'basic', monthMaxTier: 'standard' });
    expect(await models.AuditLog.count({ where: { action: 'gym_subscription.tier_changed' } })).toBe(2);
    expect(h.events.recorded().filter((e) => e.name === 'gym_subscription.tier_changed')).toHaveLength(2);
    // Someone with no gym has no plan.
    const stranger = await h.signupUser({ name: 'No Gym' });
    expect((await api().get(`${P}/manage/billing`).set(h.bearer(stranger)).expect(403)).body).toMatchObject({ code: 'PERMISSION_REQUIRED', permission: 'owner.only' });
    expect((await api().get(`${P}/manage/gyms`).set(h.bearer(stranger)).expect(200)).body).toEqual({ items: [], owner: null });
  });
});

describe('members (FR-10 to FR-13, FR-19 to FR-23, FR-25, FR-26, FR-32, FR-33)', () => {
  it('adds a member with a membership and the first payment in one call; replays; refuses a taken phone', async () => {
    const { owner, gym, pkg } = await gm.privateGym();
    const g = gm.manage(owner, gym.id);
    const phone = '01711000222';
    const ik = gm.key('add');
    const body = {
      displayName: 'Rafiq Hasan',
      phone,
      gender: 'male',
      email: 'rafiq@example.com',
      emergencyContact: { name: 'Salma Hasan', phone: '01811000333' },
      notes: 'Knee injury last year',
      membership: { packageId: pkg('month').id, startsOn: gm.today(), discountPoisha: 50000, discountReason: 'Opening offer' },
      payment: { amountPoisha: 100000, method: 'cash' },
    };
    const before = await ledgerRows();
    const r = (await g.post('/members', body, ik).expect(201)).body;
    conforms(s.AddMemberResult, r);
    // FR-32: ৳2,500 + ৳1,000 admission − ৳500 discount = ৳3,000.
    expect(r.member).toMatchObject({ memberCode: 'IY-0001', displayName: 'Rafiq Hasan', phoneLast4: '0222', status: 'active', source: 'desk', linked: false });
    expect(r.membership).toMatchObject({ title: 'Monthly', startsOn: gm.today(), endsOn: gm.inDays(29), status: 'active', admissionFeePoisha: 100000, discountPoisha: 50000, origin: 'new' });
    expect(r.due).toMatchObject({ amountPoisha: 300000, paidPoisha: 100000, outstandingPoisha: 200000, status: 'partial', dueOn: gm.today() });
    expect(r.payment.receiptNo).toMatch(/^IY-R\d{2}-000001$/);
    expect(r.payment.receiptUrl).toMatch(new RegExp(`^${config.apps.gym}/r/v1\\.`));
    // FR-34: counter money is bookkeeping only.
    expect(await ledgerRows()).toBe(before);
    // FR-10: replay with the same key → the same 201 body.
    const again = await g.post('/members', body, ik).expect(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(r);
    // Same phone twice → 409 with the member's id (any spelling of the number).
    expect((await g.post('/members', { displayName: 'Copy', phone: '+880 1711-000222' }, true).expect(409)).body).toMatchObject({ code: 'GYM_MEMBER_PHONE_TAKEN', memberId: r.member.id });
    // FR-11: no plaintext phone, email or contact at rest.
    const row = await models.GymMember.findByPk(r.member.id);
    expect(JSON.stringify(row.get({ plain: true }))).not.toMatch(PHONE);
    expect(row.emailEnc).not.toContain('rafiq');
    // A discount needs fees.adjust; the owner has it. A payment without a membership is refused.
    expect((await g.post('/members', { displayName: 'No Plan', phone: h.nextPhone(), payment: { amountPoisha: 100, method: 'cash' } }, true).expect(422)).body.code).toBe('VALIDATION_FAILED');
    // Notes are append-only.
    const notes = (await g.get(`/members/${r.member.id}/notes`).expect(200)).body.items;
    expect(notes.map((n) => n.body)).toEqual(['Knee injury last year']);
    await expect(models.sequelize.query(`UPDATE gym_member_notes SET body = 'x' WHERE id = '${notes[0].id}'`)).rejects.toThrow(/append-only/);
    // Events carry ids and amounts, never personal data.
    const names = h.events.recorded().map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['gym_member.added', 'gym_membership.started', 'gym_due.created', 'gym_fee.recorded']));
    for (const e of h.events.recorded().filter((x) => x.name.startsWith('gym_'))) expect(JSON.stringify(e.payload)).not.toMatch(PHONE);
  });

  it('20 parallel adds give continuous member codes (FR-10)', async () => {
    const { owner, gym } = await gm.privateGym();
    const g = gm.manage(owner, gym.id);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => g.post('/members', { displayName: `Member ${i}`, phone: h.nextPhone() }, true)));
    expect(results.map((x) => x.status)).toEqual(Array(20).fill(201));
    expect(results.map((x) => x.body.member.memberCode).sort()).toEqual(Array.from({ length: 20 }, (_, i) => rules.memberCode('IY', i + 1)));
    // Two adds of one phone at once: one wins.
    const phone = h.nextPhone();
    const race = await Promise.all([g.post('/members', { displayName: 'Ana', phone }, true), g.post('/members', { displayName: 'Bob', phone }, true)]);
    expect(race.map((x) => x.status).sort()).toEqual([201, 409]);
  });
});

describe('member list, profile, edit, phone reveal (FR-12, FR-13, FR-15, FR-23)', () => {
  it('lists with filters and search; the profile; edits with a version; the audited, rate-limited reveal', async () => {
    const { owner, gym, pkg } = await gm.privateGym();
    const g = gm.manage(owner, gym.id);
    const a = await gm.addMember(owner, gym.id, { displayName: 'Rafiq Hasan', phone: '01711000222', membership: { packageId: pkg('month').id, startsOn: gm.inDays(-10), admissionFee: false } });
    const b2 = await gm.addMember(owner, gym.id, { displayName: 'Nadia Islam', phone: '01811000444' });
    await gm.addMember(owner, gym.id, { displayName: 'Tanvir Ahmed', phone: '01911000555', membership: { packageId: pkg('month').id, startsOn: gm.inDays(-27) } });
    const list = (q = '') => g.get(`/members${q}`).expect(200).then((x) => x.body);
    const all = await list();
    conforms(s.MemberList, all);
    expect(all.items.map((x) => x.displayName)).toEqual(['Nadia Islam', 'Rafiq Hasan', 'Tanvir Ahmed']);
    expect(all.items.find((x) => x.displayName === 'Rafiq Hasan')).toMatchObject({ current: { title: 'Monthly', daysLeft: 20 }, flags: { due: true, overdue: true }, outstandingPoisha: 250000 });
    expect((await list('?q=01811000444')).items.map((x) => x.id)).toEqual([b2.member.id]);
    expect((await list('?q=iy-0001')).items.map((x) => x.id)).toEqual([a.member.id]);
    expect((await list('?q=nadia')).items.map((x) => x.id)).toEqual([b2.member.id]);
    expect((await list('?status=new')).items.map((x) => x.displayName)).toEqual(['Nadia Islam']);
    expect((await list('?expiring=true')).items.map((x) => x.displayName)).toEqual(['Tanvir Ahmed']);
    expect((await list('?due=true')).items).toHaveLength(2);
    expect((await list('?overdue=true')).items).toHaveLength(2);
    expect((await list('?linked=true')).items).toHaveLength(0);
    expect((await list(`?packageId=${pkg('month').id}`)).items).toHaveLength(2);
    expect((await list('?notSeen=5')).items).toHaveLength(2);
    const page = await list('?limit=2');
    expect(page.items).toHaveLength(2);
    expect((await list(`?limit=2&cursor=${page.nextCursor}`)).items.map((x) => x.displayName)).toEqual(['Tanvir Ahmed']);

    const prof = (await g.get(`/members/${a.member.id}`).expect(200)).body;
    conforms(s.MemberProfile, prof);
    expect(prof.member).toMatchObject({ memberCode: 'IY-0001', email: null, version: 1 });
    expect(prof.memberships).toHaveLength(1);
    expect(prof.dues[0]).toMatchObject({ amountPoisha: 250000, outstandingPoisha: 250000, overdue: true });
    expect(prof.can).toMatchObject({ edit: true, collect: true, remove: true });

    // FR-13: edit with the version; a stale version is refused; the audit never shows the phone.
    const edited = (await g.patch(`/members/${a.member.id}`, { version: 1, displayName: 'Rafiqul Hasan', phone: '01711000999' }).expect(200)).body;
    expect(edited.member).toMatchObject({ displayName: 'Rafiqul Hasan', phoneLast4: '0999', version: 2 });
    expect((await g.patch(`/members/${a.member.id}`, { version: 1, displayName: 'Old Name' }).expect(409)).body.code).toBe('VERSION_CONFLICT');
    expect((await g.patch(`/members/${a.member.id}`, { version: 2, phone: '01811000444' }).expect(409)).body.code).toBe('GYM_MEMBER_PHONE_TAKEN');
    const audit = await models.AuditLog.findOne({ where: { action: 'gym_member.updated' } });
    expect(audit.before.displayName).toBe('Rafiq Hasan');
    expect(audit.before.phone).toBeDefined(); // "changed", masked again by the M04 redactor
    expect(JSON.stringify([audit.before, audit.after])).not.toMatch(PHONE);

    // FR-12: reveal → the full number, no-store, one audit row each, limited per hour.
    await h.setSettingForTest('gym_manage.phone_reveals_per_hour', 2);
    const rv = await g.post(`/members/${a.member.id}/reveal-phone`).expect(200);
    expect(rv.body).toEqual({ memberId: a.member.id, phone: '+8801711000999' });
    expect(rv.headers['cache-control']).toBe('no-store');
    await g.post(`/members/${a.member.id}/reveal-phone`).expect(200);
    expect((await g.post(`/members/${a.member.id}/reveal-phone`).expect(429)).body.code).toBe('RATE_LIMITED');
    expect(await models.AuditLog.count({ where: { action: 'gym_member.phone_revealed' } })).toBe(2);

    // Photo: private, streamed back through the API.
    const photo = await g.put(`/members/${a.member.id}/photo`).set('Content-Type', 'image/jpeg').send(f.JPEG);
    expect(photo.status).toBe(200);
    expect(photo.body.photoPath).toBe(`/manage/gyms/${gym.id}/members/${a.member.id}/photo`);
    const got = await api().get(`${P}${photo.body.photoPath}`).set(h.bearer(owner)).expect(200);
    expect(got.headers['content-type']).toBe('image/jpeg');
    expect((await g.put(`/members/${a.member.id}/photo`).set('Content-Type', 'image/png').send(f.JPEG).expect(415)).body.code).toBe('FILE_TYPE_MISMATCH');

    // Calendar and notes.
    expect((await g.get(`/members/${a.member.id}/attendance?month=${gm.today().slice(0, 7)}`).expect(200)).body).toMatchObject({ count: 0, days: [] });
    expect((await g.post(`/members/${a.member.id}/notes`, { body: 'Prefers mornings' }).expect(201)).body).toMatchObject({ body: 'Prefers mornings', by: { id: owner.user.id } });
  });

  it('leave, re-join (keeps the code) and remove (refused while a due holds payments) (FR-19, FR-20)', async () => {
    const { owner, gym, pkg } = await gm.privateGym();
    const g = gm.manage(owner, gym.id);
    const a = await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.inDays(-5) }, payment: { amountPoisha: 100000, method: 'cash' } });
    const left = (await g.post(`/members/${a.member.id}/leave`, { reason: 'moved', note: 'Moved to Chattogram' }).expect(200)).body;
    expect(left.member).toMatchObject({ status: 'left', leftReason: 'moved', leftOn: gm.today() });
    expect(left.memberships[0]).toMatchObject({ status: 'cancelled', endsOn: gm.today() });
    // The open due stays (it can be waived).
    expect(left.dues[0]).toMatchObject({ status: 'partial', outstandingPoisha: 250000 });
    expect((await g.post(`/members/${a.member.id}/leave`, { reason: 'moved' }).expect(409)).body).toMatchObject({ code: 'GYM_MEMBER_STATE', reason: 'left' });
    const back = (await g.post(`/members/${a.member.id}/rejoin`).expect(200)).body;
    expect(back.member).toMatchObject({ status: 'new', memberCode: a.member.memberCode, leftOn: null });
    // After a re-join the admission fee applies again (FR-26) and the origin is rejoin.
    const again = (await g.post(`/members/${a.member.id}/memberships`, { packageId: pkg('month').id, startsOn: gm.today() }, true).expect(201)).body;
    expect(again.membership).toMatchObject({ origin: 'rejoin', admissionFeePoisha: 100000, status: 'active' });
    expect((await g.post(`/members/${a.member.id}/remove`, { reason: 'Typed twice' }).expect(409)).body).toMatchObject({ code: 'GYM_MEMBER_STATE', reason: 'has_payments' });
    const clean = await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.inDays(3) } });
    const removed = (await g.post(`/members/${clean.member.id}/remove`, { reason: 'Typed twice' }).expect(200)).body;
    expect(removed.member).toMatchObject({ status: 'removed', removedReason: 'Typed twice' });
    expect(removed.dues[0].status).toBe('void');
    expect(removed.memberships[0].status).toBe('cancelled');
    // Removed members leave every list except the owner's filter.
    expect((await g.get('/members').expect(200)).body.items.map((x) => x.id)).not.toContain(clean.member.id);
    expect((await g.get('/members?status=removed').expect(200)).body.items.map((x) => x.id)).toEqual([clean.member.id]);
    expect(h.events.recorded().map((e) => e.name)).toEqual(expect.arrayContaining(['gym_member.left', 'gym_member.rejoined', 'gym_member.removed', 'gym_membership.cancelled']));
  });
});

describe('memberships (FR-25 to FR-31)', () => {
  it('assign, overlap, renew continuously, freeze and unfreeze, change with credit, cancel', async () => {
    const { owner, gym, pkg } = await gm.privateGym();
    const g = gm.manage(owner, gym.id);
    const a = await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.inDays(-20) }, payment: { amountPoisha: 350000, method: 'cash' } });
    const msId = a.membership.id;
    // Overlap, out-of-range dates, an unknown package.
    expect((await g.post(`/members/${a.member.id}/memberships`, { packageId: pkg('month').id, startsOn: gm.today() }, true).expect(409)).body.code).toBe('GYM_MEMBERSHIP_OVERLAP');
    expect((await g.post(`/members/${a.member.id}/memberships`, { packageId: pkg('month').id, startsOn: gm.inDays(61) }, true).expect(422)).body.code).toBe('GYM_DATE_OUT_OF_RANGE');
    expect((await g.post(`/members/${a.member.id}/memberships`, { packageId: '00000000-0000-4000-8000-000000000000', startsOn: gm.today() }, true).expect(422)).body.code).toBe('GYM_PACKAGE_UNAVAILABLE');
    // Renew within the grace: continuous, upcoming, no admission fee (FR-27).
    const renewed = (await g.post(`/memberships/${msId}/renew`, {}, true).expect(201)).body;
    conforms(s.MembershipResult, renewed);
    expect(renewed.membership).toMatchObject({ origin: 'renewal', previousId: msId, startsOn: gm.inDays(10), status: 'upcoming', admissionFeePoisha: 0 });
    expect(renewed.due).toMatchObject({ amountPoisha: 250000, status: 'unpaid' });
    expect((await g.post(`/memberships/${msId}/renew`, {}, true).expect(409)).body.code).toBe('GYM_MEMBERSHIP_STATE');
    // Freeze today for 5 days: the end moves, the upcoming renewal moves with it; the member is frozen.
    const frozen = (await g.post(`/memberships/${msId}/freeze`, { fromOn: gm.today(), toOn: gm.inDays(4), reason: 'Fever' }).expect(200)).body;
    expect(frozen.membership).toMatchObject({ status: 'frozen', endsOn: gm.inDays(14), frozenDays: 5, freezesCount: 1 });
    expect((await models.GymMembership.findByPk(renewed.membership.id)).startsOn).toBe(gm.inDays(15));
    expect((await models.GymMember.findByPk(a.member.id)).status).toBe('frozen');
    // 31 frozen days with a 30-day limit → GYM_FREEZE_LIMIT (FR-28).
    expect((await g.post(`/memberships/${msId}/freeze`, { fromOn: gm.inDays(5), toOn: gm.inDays(30), reason: 'Travel' }).expect(422)).body).toMatchObject({ code: 'GYM_FREEZE_LIMIT', limit: 'days' });
    // Unfreeze early today: gives back all 5 days (today is not frozen).
    const thawed = (await g.post(`/memberships/${msId}/unfreeze`).expect(200)).body;
    expect(thawed.membership).toMatchObject({ status: 'active', endsOn: gm.inDays(9), frozenDays: 0 });
    expect(thawed.membership.freezes[0]).toMatchObject({ status: 'done' });
    expect((await models.GymMembership.findByPk(renewed.membership.id)).startsOn).toBe(gm.inDays(10));
    expect((await models.GymMember.findByPk(a.member.id)).status).toBe('active');
    // A scheduled freeze is cancelled whole by unfreeze.
    await g.post(`/memberships/${msId}/freeze`, { fromOn: gm.inDays(2), toOn: gm.inDays(3), reason: 'Exams' }).expect(200);
    expect((await g.post(`/memberships/${msId}/unfreeze`).expect(200)).body.membership).toMatchObject({ endsOn: gm.inDays(9), freezesCount: 1 });
    // Change refused while an upcoming membership exists; cancel the upcoming one first (its due voids).
    expect((await g.post(`/memberships/${msId}/change`, { packageId: pkg('quarter').id }, true).expect(409)).body).toMatchObject({ code: 'GYM_MEMBERSHIP_STATE', reason: 'upcoming_exists' });
    const cancelled = (await g.post(`/memberships/${renewed.membership.id}/cancel`, { reason: 'Changing package' }).expect(200)).body;
    expect(cancelled.membership.status).toBe('cancelled');
    expect(cancelled.due.status).toBe('void');
    // Change today to the quarterly: credit = round(paid × remaining ÷ total) (FR-29).
    const changed = (await g.post(`/memberships/${msId}/change`, { packageId: pkg('quarter').id }, true).expect(201)).body;
    const credit = rules.changeCredit({ days: 30, endsOn: gm.inDays(9), paid: 350000, changeOn: gm.today() });
    expect(changed.credit).toEqual({ remainingDays: 10, totalDays: 30, creditPoisha: credit.credit });
    expect(changed.previous).toMatchObject({ status: 'changed', endsOn: gm.inDays(-1) });
    expect(changed.membership).toMatchObject({ origin: 'change', startsOn: gm.today(), endsOn: gm.inDays(89), status: 'active' });
    expect(changed.due.amountPoisha).toBe(650000 - credit.credit);
    // Cancel after it started: it ends today.
    const ended = (await g.post(`/memberships/${changed.membership.id}/cancel`, { reason: 'Moving away' }).expect(200)).body;
    expect(ended.membership).toMatchObject({ status: 'cancelled', endsOn: gm.today() });
    expect((await models.GymMember.findByPk(a.member.id)).status).toBe('expired');
    expect((await g.post(`/memberships/${changed.membership.id}/cancel`, { reason: 'Again' }).expect(409)).body.code).toBe('GYM_MEMBERSHIP_STATE');
    expect(h.events.recorded().map((e) => e.name)).toEqual(expect.arrayContaining(['gym_membership.renewed', 'gym_membership.frozen', 'gym_membership.unfrozen', 'gym_membership.changed', 'gym_membership.cancelled']));
  });
});

describe('dues, payments, reversals, waivers, receipts, cash closing (FR-32 to FR-38)', () => {
  it('counter payments up to the outstanding, a reversal once, a waiver, the receipt and its public link', async () => {
    const { owner, gym, pkg } = await gm.privateGym();
    const g = gm.manage(owner, gym.id);
    const a = await gm.addMember(owner, gym.id, { displayName: 'Rafiq Hasan', membership: { packageId: pkg('month').id, startsOn: gm.today() } });
    const dueId = a.due.id;
    const before = await ledgerRows();
    expect((await g.post(`/dues/${dueId}/payments`, { amountPoisha: 350001, method: 'cash' }, true).expect(422)).body).toMatchObject({ code: 'GYM_PAYMENT_EXCEEDS_DUE', outstanding: 350000 });
    expect((await g.post(`/dues/${dueId}/payments`, { amountPoisha: 50, method: 'cash' }, true).expect(422)).body.code).toBe('GYM_PAYMENT_EXCEEDS_DUE');
    expect((await g.post(`/dues/${dueId}/payments`, { amountPoisha: 100, method: 'cash', paidOn: gm.inDays(1) }, true).expect(422)).body.code).toBe('GYM_DATE_OUT_OF_RANGE');
    const p1 = (await g.post(`/dues/${dueId}/payments`, { amountPoisha: 100000, method: 'owner_bkash', note: 'bKash to the owner' }, true).expect(201)).body;
    conforms(s.PaymentResult, p1);
    expect(p1.due).toMatchObject({ paidPoisha: 100000, outstandingPoisha: 250000, status: 'partial' });
    const p2 = (await g.post(`/dues/${dueId}/payments`, { amountPoisha: 250000, method: 'cash', paidOn: gm.inDays(-1) }, true).expect(201)).body;
    expect(p2.due.status).toBe('paid');
    expect([p1.payment.receiptNo, p2.payment.receiptNo]).toEqual([rules.receiptNo('IY', rules.yearOf(gm.today()), 1), rules.receiptNo('IY', rules.yearOf(gm.today()), 2)]);
    expect((await g.post(`/dues/${dueId}/payments`, { amountPoisha: 100, method: 'cash' }, true).expect(409)).body.code).toBe('GYM_DUE_STATE');
    expect(await ledgerRows()).toBe(before); // FR-34
    // Reverse once (FR-35); the original row never changes.
    const rev = (await g.post(`/fee-payments/${p1.payment.id}/reverse`, { reason: 'Recorded twice' }, true).expect(201)).body;
    conforms(s.ReverseResult, rev);
    expect(rev.reversal).toMatchObject({ amountPoisha: -100000, reversesId: p1.payment.id, receiptNo: null });
    expect(rev.due).toMatchObject({ status: 'partial', outstandingPoisha: 100000 });
    expect((await g.post(`/fee-payments/${p1.payment.id}/reverse`, { reason: 'Again' }, true).expect(409)).body.code).toBe('GYM_PAYMENT_NOT_REVERSIBLE');
    expect((await g.post(`/fee-payments/${rev.reversal.id}/reverse`, { reason: 'Reverse a reversal' }, true).expect(409)).body.code).toBe('GYM_PAYMENT_NOT_REVERSIBLE');
    await expect(models.sequelize.query(`UPDATE gym_fee_payments SET note = 'x' WHERE id = '${p1.payment.id}'`)).rejects.toThrow(/append-only/);
    // Waive the rest (FR-36): paid > 0 → the due is paid.
    const w = (await g.post(`/dues/${dueId}/waive`, { amountPoisha: 100000, reason: 'Loyal member' }).expect(200)).body;
    expect(w.due).toMatchObject({ status: 'paid', waivedPoisha: 100000, outstandingPoisha: 0, waiveReason: 'Loyal member' });
    expect((await g.post(`/dues/${dueId}/waive`, { amountPoisha: 1, reason: 'Nothing left' }).expect(409)).body.code).toBe('GYM_DUE_STATE');
    // The receipt (FR-37): TIN only when entered; "reversed" once reversed; the public token page.
    const receipt = (await g.get(`/fee-payments/${p1.payment.id}/receipt`).expect(200)).body;
    conforms(s.Receipt, receipt);
    expect(receipt).toMatchObject({ receiptNo: p1.payment.receiptNo, gym: { name: 'Iron Yard Banani', tin: null }, member: { memberCode: 'IY-0001', displayName: 'Rafiq Hasan' }, amountPoisha: 100000, method: 'owner_bkash', outstandingAfterPoisha: 250000, receivedBy: 'Karim Uddin', reversed: { on: gm.today() } });
    await g.patch('/settings', { tin: '123456789012' }).expect(200);
    const token = receipt.url.split('/r/')[1];
    const pub = await api().get(`${P}/gym-receipts/${token}`).expect(200);
    expect(pub.body).toMatchObject({ receiptNo: p1.payment.receiptNo, gym: { tin: '123456789012' } });
    expect(pub.headers['x-robots-tag']).toBe('noindex');
    const other = (await g.get(`/fee-payments/${p2.payment.id}/receipt`).expect(200)).body.url.split('/r/')[1];
    expect((await api().get(`${P}/gym-receipts/v1.${p1.payment.id}.${other.split('.')[2]}`).expect(404)).body.code).toBe('NOT_FOUND');
    expect((await g.get(`/fee-payments/${rev.reversal.id}/receipt`).expect(404)).body.code).toBe('NOT_FOUND');
    // Dues list.
    expect((await g.get('/dues?status=paid').expect(200)).body.items.map((d) => d.id)).toEqual([dueId]);
    expect((await g.get('/dues').expect(200)).body.items).toEqual([]);
    // Cash closing (FR-38): the day's counter money by staff and method; sums match the rows.
    const close = (await g.get('/cash-closing').expect(200)).body;
    conforms(s.CashClosing, close);
    expect(close).toMatchObject({ scope: 'all', totals: { counterPoisha: 0, receivedPoisha: 100000, reversedPoisha: 100000, byMethod: { owner_bkash: 0 } } });
    const yesterday = (await g.get(`/cash-closing?date=${gm.inDays(-1)}`).expect(200)).body;
    expect(yesterday.totals).toMatchObject({ counterPoisha: 250000, byMethod: { cash: 250000 } });
    expect(yesterday.byStaff).toEqual([expect.objectContaining({ userId: owner.user.id, totalPoisha: 250000, count: 1 })]);
    expect(h.events.recorded().map((e) => e.name)).toEqual(expect.arrayContaining(['gym_fee.recorded', 'gym_fee.reversed', 'gym_due.paid']));
  });

  it('parallel payments on one due never exceed it; receipt numbers stay continuous (FR-33)', async () => {
    const { owner, gym, pkg } = await gm.privateGym();
    const g = gm.manage(owner, gym.id);
    const a = await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.today(), admissionFee: false } });
    const results = await Promise.all(Array.from({ length: 20 }, () => g.post(`/dues/${a.due.id}/payments`, { amountPoisha: 20000, method: 'cash' }, true)));
    const ok = results.filter((x) => x.status === 201);
    expect(ok).toHaveLength(12); // ৳2,500 ÷ ৳200 = 12 full payments
    expect(results.filter((x) => x.status !== 201).every((x) => ['GYM_PAYMENT_EXCEEDS_DUE'].includes(x.body.code))).toBe(true);
    const due = await models.GymDue.findByPk(a.due.id);
    expect(due.paidPoisha).toBe(240000);
    const numbers = (await models.GymFeePayment.findAll({ where: { dueId: a.due.id } })).map((p) => Number(p.receiptNo.slice(-6))).sort((x, y) => x - y);
    expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });
});

describe('account links by consent and the member area (FR-14 to FR-18, FR-37, FR-50)', () => {
  it('invites, accepts, shows the member area and the rotating QR the desk scans; unlinks into "Past"', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'basic' });
    const g = gm.manage(owner, gym.id);
    const person = await h.signupUser({ name: 'Rafiq Hasan' });
    const a = await gm.addMember(owner, gym.id, { displayName: 'Rafiq (gym)', phone: person.phone, membership: { packageId: pkg('month').id, startsOn: gm.today() }, payment: { amountPoisha: 350000, method: 'cash' } });
    // Invite by the member's own phone: the account is known, GYM_LINK_INVITE goes to it.
    const inv = (await g.post(`/members/${a.member.id}/invite`, {}).expect(201)).body;
    expect(inv.request).toMatchObject({ direction: 'gym_invite', status: 'pending', accountKnown: true, memberId: a.member.id });
    expect((await g.post(`/members/${a.member.id}/invite`, {}).expect(409)).body.code).toBe('GYM_LINK_REQUEST_PENDING');
    await h.drainEvents();
    const note = await models.Notification.findOne({ where: { userId: person.user.id, code: 'GYM_LINK_INVITE' } });
    expect(note.link).toBe(`${config.apps.gym}/me/requests`);
    expect((await g.get('/requests').expect(200)).body.items.map((r) => r.id)).toEqual([inv.request.id]);
    // The invitee sees what the gym will see, then accepts (gate join_gym).
    const mine = (await api().get(`${P}/me/gym-requests`).set(h.bearer(person)).expect(200)).body;
    conforms(s.MyRequests, mine);
    expect(mine.items[0]).toMatchObject({ gym: { id: gym.id, name: 'Iron Yard Banani' }, memberCode: 'IY-0001', shares: ['name', 'phone', 'photo', 'checkins', 'payments'] });
    expect((await api().post(`${P}/me/gym-requests/${inv.request.id}/accept`).set(h.bearer(person)).expect(200)).body).toMatchObject({ request: { status: 'accepted' }, memberId: a.member.id });
    expect((await api().post(`${P}/me/gym-requests/${inv.request.id}/accept`).set(h.bearer(person)).expect(409)).body.code).toBe('GYM_LINK_REQUEST_STATE');
    await h.drainEvents();
    expect((await models.Notification.findOne({ where: { userId: owner.user.id, code: 'GYM_LINK_ACCEPTED' } })).link).toBe(`${config.apps.gym}/manage/${gym.id}/members/${a.member.id}`);
    // The member area.
    const list = (await api().get(`${P}/me/gym-memberships`).set(h.bearer(person)).expect(200)).body;
    conforms(s.MyMemberships, list);
    expect(list.items).toEqual([expect.objectContaining({ memberId: a.member.id, linked: true, memberCode: 'IY-0001', current: expect.objectContaining({ title: 'Monthly', daysLeft: 30 }), outstandingPoisha: 0 })]);
    const detail = (await api().get(`${P}/me/gym-memberships/${a.member.id}`).set(h.bearer(person)).expect(200)).body;
    conforms(s.MyMembership, detail);
    expect(detail.receipts).toHaveLength(1);
    expect(detail.dues[0].payments[0].note).toBeNull();
    const receipts = (await api().get(`${P}/me/gym-receipts`).set(h.bearer(person)).expect(200)).body;
    conforms(s.MyReceipts, receipts);
    expect((await api().get(`${P}/me/gym-receipts/${receipts.items[0].id}`).set(h.bearer(person)).expect(200)).body.receiptNo).toBe(receipts.items[0].receiptNo);
    await api().put(`${P}/me/gym-memberships/${a.member.id}/health-note`).set(h.bearer(person)).send({ text: 'Asthma: inhaler in my bag' }).expect(200);
    expect((await g.get(`/members/${a.member.id}`).expect(200)).body.member).toMatchObject({ linked: true, healthNote: 'Asthma: inhaler in my bag', healthNoteBy: 'member' });
    // FR-50: the rotating member QR (no-store); the desk checks the member in by it.
    const tok = await api().get(`${P}/me/gym-memberships/${a.member.id}/checkin-token`).set(h.bearer(person)).expect(200);
    expect(tok.headers['cache-control']).toBe('no-store');
    conforms(s.CheckinToken, tok.body);
    expect(tok.body.token).not.toMatch(PHONE);
    const found = (await g.get(`/desk/search?q=${encodeURIComponent(tok.body.token)}`).expect(200)).body;
    expect(found.items.map((x) => x.member.id)).toEqual([a.member.id]);
    const card = (await g.post('/checkins', { token: tok.body.token }).expect(201)).body;
    expect(card).toMatchObject({ counted: true, method: 'member_qr', decision: 'allow', member: { id: a.member.id, linked: true } });
    // A token from two windows ago is refused.
    const seconds = h.settings.get('gym_manage.member_qr_seconds');
    const old = rules.memberToken({ memberId: a.member.id, window: rules.windowOf(Date.now(), seconds) - 2 }, (t) => require('../../src/common/crypto').hmac(t));
    expect((await g.post('/checkins', { token: old }).expect(422)).body.code).toBe('GYM_CHECKIN_TOKEN_INVALID');
    expect((await api().get(`${P}/me/gym-memberships/${a.member.id}/attendance`).set(h.bearer(person)).expect(200)).body.count).toBe(1);
    // FR-18: the member unlinks; the gym's record stays; receipts stay readable under "Past".
    await api().post(`${P}/me/gym-memberships/${a.member.id}/unlink`).set(h.bearer(person)).expect(200);
    const past = (await api().get(`${P}/me/gym-memberships`).set(h.bearer(person)).expect(200)).body.items;
    expect(past).toEqual([expect.objectContaining({ memberId: a.member.id, linked: false, outstandingPoisha: 0 })]);
    expect((await api().get(`${P}/me/gym-memberships/${a.member.id}`).set(h.bearer(person)).expect(200)).body).toMatchObject({ memberships: [], dues: [], receipts: [expect.any(Object)] });
    expect((await api().get(`${P}/me/gym-memberships/${a.member.id}/checkin-token`).set(h.bearer(person)).expect(403)).body.code).toBe('GYM_NOT_A_MEMBER');
    expect((await g.get(`/members/${a.member.id}`).expect(200)).body.link).toMatchObject({ linked: false });
    // The gym can invite again, and unlink too.
    const inv2 = (await g.post(`/members/${a.member.id}/invite`, {}).expect(201)).body;
    await api().post(`${P}/me/gym-requests/${inv2.request.id}/accept`).set(h.bearer(person)).expect(200);
    await g.post(`/members/${a.member.id}/unlink`).expect(200);
    expect((await g.post(`/members/${a.member.id}/unlink`).expect(409)).body).toMatchObject({ code: 'GYM_MEMBER_STATE', reason: 'not_linked' });
    expect(await models.AuditLog.count({ where: { action: 'gym_member.unlinked' } })).toBe(2);
  });

  it('an invite to a phone with no account waits for that phone and appears after sign-up; decline and cancel', async () => {
    const { owner, gym } = await gm.privateGym();
    const g = gm.manage(owner, gym.id);
    const phone = h.nextPhone();
    const a = await gm.addMember(owner, gym.id, { displayName: 'Future User', phone });
    const inv = (await g.post(`/members/${a.member.id}/invite`, {}).expect(201)).body.request;
    expect(inv.accountKnown).toBe(false);
    const row = await models.GymLinkRequest.findByPk(inv.id);
    expect(row.userId).toBeNull();
    expect(row.phoneHash).toMatch(/^[0-9a-f]{64}$/);
    // The same number signs up (OTP-verified): the invite attaches (user.registered) and is announced.
    await api().post(`${P}/auth/otp/send`).send({ target: phone, purpose: 'signup' }).expect(202);
    const v = await api().post(`${P}/auth/otp/verify`).send({ target: phone, purpose: 'signup', code: h.lastCode(phone) }).expect(200);
    const su = await api().post(`${P}/auth/signup`).send({ signupToken: v.body.signupToken, displayName: 'Future User' }).expect(201);
    const person = { accessToken: su.body.accessToken, user: su.body.user };
    await h.drainEvents();
    expect((await models.GymLinkRequest.findByPk(inv.id)).userId).toBe(person.user.id);
    expect(await models.Notification.count({ where: { userId: person.user.id, code: 'GYM_LINK_INVITE' } })).toBe(1);
    expect((await api().post(`${P}/me/gym-requests/${inv.id}/decline`).set(h.bearer(person)).expect(200)).body.request.status).toBe('declined');
    expect((await models.GymMember.findByPk(a.member.id)).userId).toBeNull();
    // The gym cancels its own pending invite; an invite by username.
    const inv2 = (await g.post(`/members/${a.member.id}/invite`, {}).expect(201)).body.request;
    expect((await g.post(`/requests/${inv2.id}/cancel`).expect(200)).body.request.status).toBe('cancelled');
    expect((await g.post(`/requests/${inv2.id}/cancel`).expect(409)).body.code).toBe('GYM_LINK_REQUEST_STATE');
    expect((await g.post(`/members/${a.member.id}/invite`, { username: 'nobody_here' }).expect(404)).body.code).toBe('NOT_FOUND');
    expect(h.events.recorded().map((e) => e.name)).toEqual(expect.arrayContaining(['gym_link.requested', 'gym_link.declined', 'gym_link.cancelled']));
  });
});

describe('check-ins and the entry policy (FR-07, FR-47 to FR-49)', () => {
  it('needs Basic; one counted per Dhaka day; warn and block; the owner overrides with a reason', async () => {
    const { owner, gym, pkg } = await gm.privateGym();
    const g = gm.manage(owner, gym.id);
    const a = await gm.addMember(owner, gym.id, { displayName: 'Rafiq Hasan', membership: { packageId: pkg('month').id, startsOn: gm.today() }, payment: { amountPoisha: 350000, method: 'cash' } });
    // FR-07: the Free tier has no check-ins.
    expect((await g.post('/checkins', { memberId: a.member.id }).expect(403)).body).toMatchObject({ code: 'GYM_TIER_REQUIRED', feature: 'attendance', minTier: 'basic' });
    await api().put(`${P}/manage/billing/tier`).set(h.bearer(owner)).send({ tier: 'basic' }).expect(200);
    const first = (await g.post('/checkins', { memberId: a.member.id }).expect(201)).body;
    conforms(s.DeskCard, first);
    expect(first).toMatchObject({ counted: true, decision: 'allow', flags: [], membership: { title: 'Monthly', daysLeft: 30 }, outstandingPoisha: 0 });
    const repeat = (await g.post('/checkins', { memberId: a.member.id }).expect(200)).body;
    expect(repeat).toMatchObject({ counted: false, firstCheckInToday: first.checkedInAt });
    // Two scans at once of a new member: one counted (FR-48).
    const b2 = await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.today() }, payment: { amountPoisha: 350000, method: 'cash' } });
    const two = await Promise.all([g.post('/checkins', { memberId: b2.member.id }), g.post('/checkins', { memberId: b2.member.id })]);
    expect(two.map((x) => x.status).sort()).toEqual([200, 201]);
    expect(await models.GymAttendance.count({ where: { memberId: b2.member.id, counted: true } })).toBe(1);
    // A member without a membership: warn by default (G8), block when the gym says so.
    const none = await gm.addMember(owner, gym.id, { displayName: 'Walk In' });
    expect((await g.post('/checkins', { memberId: none.member.id }).expect(201)).body).toMatchObject({ decision: 'warn', reasons: ['none'] });
    const expired = await gm.addMember(owner, gym.id, { displayName: 'Old Timer', membership: { packageId: pkg('month').id, startsOn: gm.inDays(-30) } });
    await jobs.daily();
    await g.patch('/settings', { entryPolicy: 'block' }).expect(200);
    const staff = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Staff' }), ['attendance.mark', 'members.view']);
    const blocked = (await gm.manage(staff, gym.id).post('/checkins', { memberId: expired.member.id }).expect(409)).body;
    expect(blocked).toMatchObject({ code: 'GYM_ENTRY_BLOCKED', reasons: ['expired', 'unpaid'], canOverride: false });
    expect((await g.post('/checkins', { memberId: expired.member.id }).expect(409)).body.canOverride).toBe(true);
    expect((await g.post('/checkins', { memberId: expired.member.id, override: true }).expect(422)).body.code).toBe('VALIDATION_FAILED');
    const over = (await g.post('/checkins', { memberId: expired.member.id, override: true, reason: 'Paying tomorrow' }).expect(201)).body;
    expect(over).toMatchObject({ counted: true, override: true, flags: ['expired', 'unpaid'] });
    expect(await models.AuditLog.count({ where: { action: 'gym_attendance.override' } })).toBe(1);
    // The day's list.
    const day = (await g.get('/checkins').expect(200)).body;
    conforms(s.CheckinDay, day);
    expect(day.counted).toBe(4);
    expect(h.events.recorded().filter((e) => e.name === 'gym_attendance.recorded')).toHaveLength(4);
    // The desk search: name, phone, code; cards without amounts for a desk without fees.collect.
    const search = (await gm.manage(staff, gym.id).get('/desk/search?q=rafiq').expect(200)).body;
    conforms(s.DeskSearch, search);
    expect(search.items[0]).toMatchObject({ member: { memberCode: 'IY-0001' } });
    expect(search.items[0].outstandingPoisha).toBeUndefined();
    expect(JSON.stringify(search)).not.toMatch(PHONE);
  });
});

describe('the staff route matrix (FR-03 to FR-06, FR-106)', () => {
  it('owner, staff with and without each permission, another gym’s staff, removed staff, a suspended owner', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'basic' });
    const other = await gm.privateGym({ name: 'Gold Gym Gulshan', shortCode: 'GG' });
    const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Front Desk' }), ['attendance.mark', 'members.view']);
    const cashier = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Cashier' }), ['members.view', 'fees.collect']);
    const editor = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Manager' }), ['members.view', 'members.edit', 'fees.collect', 'fees.adjust', 'reports.view']);
    const none = await gm.hire(owner, gym.id, await h.signupUser({ name: 'No Rights' }), []);
    const foreign = await gm.hire(other.owner, other.gym.id, await h.signupUser({ name: 'Other Desk' }), bmRules.allowedFor('gym'));
    // FR-04: fees.adjust without fees.collect is refused by the team endpoint.
    const bad = await api().post(`${P}/me/team`).set(h.bearer(owner)).send({ businessType: 'gym', businessId: gym.id, phone: (await h.signupUser({ name: 'Bad Mix' })).phone, permissions: ['fees.adjust', 'members.view'] }).expect(422);
    expect(bad.body).toMatchObject({ code: 'PERMISSIONS_INVALID', missing: [{ permission: 'fees.adjust', needs: 'fees.collect' }] });
    const a = await gm.addMember(owner, gym.id, { displayName: 'Rafiq Hasan', membership: { packageId: pkg('month').id, startsOn: gm.today() } });
    const as = (who) => gm.manage(who, gym.id);

    // Packages for the desk (members.view): only desk and both channels (FR-25).
    expect((await as(none).get('/packages').expect(403)).body.permission).toBe('members.view');
    const deskPackages = (await as(desk).get('/packages').expect(200)).body;
    conforms(s.Packages, deskPackages);
    expect(deskPackages.items.map((x) => x.id)).toContain(pkg('month').id);
    expect(deskPackages.items.every((x) => x.channel !== 'online')).toBe(true);
    expect((await as(foreign).get('/packages').expect(404)).body.code).toBe('NOT_FOUND');
    // Members: list and profile (members.view); amounts only with fees.collect.
    expect((await as(none).get('/members').expect(403)).body).toMatchObject({ code: 'PERMISSION_REQUIRED', permission: 'members.view' });
    expect((await as(foreign).get('/members').expect(404)).body.code).toBe('NOT_FOUND');
    const deskList = (await as(desk).get('/members').expect(200)).body;
    expect(deskList.items[0].outstandingPoisha).toBeUndefined();
    expect((await as(cashier).get('/members').expect(200)).body.items[0].outstandingPoisha).toBe(350000);
    const deskProfile = (await as(desk).get(`/members/${a.member.id}`).expect(200)).body;
    expect(deskProfile.dues[0].amountPoisha).toBeUndefined();
    expect(deskProfile.member.email).toBeUndefined();
    expect(JSON.stringify(deskProfile)).not.toMatch(PHONE);
    expect(bmRules.hiddenKeysIn(deskProfile)).toEqual([]);
    // Editing needs members.edit; the reveal too.
    expect((await as(cashier).patch(`/members/${a.member.id}`, { version: 1, displayName: 'Changed Name' }).expect(403)).body.permission).toBe('members.edit');
    expect((await as(desk).post(`/members/${a.member.id}/reveal-phone`).expect(403)).body.permission).toBe('members.edit');
    await as(editor).patch(`/members/${a.member.id}`, { version: 1, displayName: 'Rafiq H.' }).expect(200);
    const added = (await as(editor).post('/members', { displayName: 'Staff Added', phone: h.nextPhone() }, true).expect(201)).body;
    const audit = await models.AuditLog.findOne({ where: { action: 'gym_member.added', entityId: added.member.id } });
    expect(audit).toMatchObject({ actorId: editor.user.id, actorRole: 'business_staff' });
    expect(audit.meta).toMatchObject({ onBehalfOf: owner.user.id });
    // FR-26: a discount needs fees.adjust.
    expect((await as(cashier).post(`/members/${added.member.id}/memberships`, { packageId: pkg('month').id, startsOn: gm.today() }, true).expect(403)).body.permission).toBe('members.edit');
    // Payments: fees.collect; back-dated: fees.adjust; reversals: fees.adjust.
    expect((await as(desk).post(`/dues/${a.due.id}/payments`, { amountPoisha: 100000, method: 'cash' }, true).expect(403)).body.permission).toBe('fees.collect');
    expect((await as(cashier).post(`/dues/${a.due.id}/payments`, { amountPoisha: 100000, method: 'cash', paidOn: gm.inDays(-1) }, true).expect(403)).body.permission).toBe('fees.adjust');
    const paid = (await as(cashier).post(`/dues/${a.due.id}/payments`, { amountPoisha: 100000, method: 'cash' }, true).expect(201)).body;
    expect((await as(cashier).post(`/fee-payments/${paid.payment.id}/reverse`, { reason: 'Mistake' }, true).expect(403)).body.permission).toBe('fees.adjust');
    // Cash closing: own for fees.collect, everyone for reports.view and the owner.
    await as(editor).post(`/dues/${a.due.id}/payments`, { amountPoisha: 50000, method: 'owner_nagad' }, true).expect(201);
    expect((await as(cashier).get('/cash-closing').expect(200)).body).toMatchObject({ scope: 'own', totals: { counterPoisha: 100000 } });
    expect((await as(editor).get('/cash-closing').expect(200)).body).toMatchObject({ scope: 'all', totals: { counterPoisha: 150000 } });
    // Overview: money tiles for the owner and reports.view only.
    const deskOverview = (await as(desk).get('/overview').expect(200)).body;
    conforms(s.Overview, deskOverview);
    expect(deskOverview.tiles.collectedTodayPoisha).toBeUndefined();
    expect((await as(editor).get('/overview').expect(200)).body.tiles.collectedTodayPoisha).toBe(150000);
    expect((await gm.manage(owner, gym.id).get('/overview').expect(200)).body.tiles).toMatchObject({ collectedTodayPoisha: 150000, members: 2, activeMembers: 1, newThisMonth: 2 });
    // FR-06: owner-only routes refuse every staff member with owner.only.
    for (const [method, path, body] of [
      ['get', '/settings'],
      ['patch', '/settings', { entryPolicy: 'block' }],
      ['post', `/members/${a.member.id}/remove`, { reason: 'Mistake here' }],
      ['get', '/imports'],
      ['put', '/import-consent', { grant: true }],
    ]) {
      const r = await as(editor)[method](path, body);
      expect([path, r.status, r.body.permission]).toEqual([path, 403, 'owner.only']);
    }
    // Staff of a gym see their workplace in /manage/gyms, with its plan.
    const ws = (await api().get(`${P}/manage/gyms`).set(h.bearer(desk)).expect(200)).body;
    expect(ws.items).toEqual([expect.objectContaining({ id: gym.id, role: 'staff', permissions: ['attendance.mark', 'members.view'], tier: 'basic' })]);
    expect(ws.owner).toBeNull();
    // Check-ins: attendance.mark.
    expect((await as(cashier).post('/checkins', { memberId: a.member.id }).expect(403)).body.permission).toBe('attendance.mark');
    await as(desk).post('/checkins', { memberId: a.member.id }).expect(201);
    // Removed staff lose access at once.
    const team = (await api().get(`${P}/me/team?businessType=gym&businessId=${gym.id}`).set(h.bearer(owner)).expect(200)).body.items;
    await api().post(`${P}/me/team/${team.find((x) => x.member.id === desk.user.id).id}/remove`).set(h.bearer(owner)).expect(200);
    await f.refresh(desk);
    expect((await as(desk).get('/members').expect(404)).body.code).toBe('NOT_FOUND');
    // FR-03: suspending the owner's gym_owner role takes their staff out on the next request.
    await models.UserRole.create({ userId: owner.user.id, role: 'gym_owner', status: 'suspended' });
    await f.refresh(cashier);
    expect((await as(cashier).get('/members').expect(404)).body.code).toBe('NOT_FOUND');
    await f.refresh(owner);
    expect((await as(owner).get('/members').expect(403)).body.code).toBe('ROLE_SUSPENDED');
  });
});

describe('imports (FR-75 to FR-80)', () => {
  const HEADER = 'Name,Phone,Gender,Date of birth,Package,Start,End,Last payment date,Last payment amount,Amount due,Member code';
  const upload = (who, gymId, body, type = 'text/csv', name = 'members.csv') =>
    api().post(`${P}/manage/gyms/${gymId}/imports?fileName=${encodeURIComponent(name)}`).set(h.bearer(who)).set('Content-Type', type).send(Buffer.isBuffer(body) ? body : Buffer.from(body));

  it('CSV: preview with row errors and nothing saved; apply (sends nothing); undo; blocked undo after a check-in; invites on request', async () => {
    const { owner, gym } = await gm.privateGym({ tier: 'basic' });
    const g = gm.manage(owner, gym.id);
    await gm.addMember(owner, gym.id, { displayName: 'Already Here', phone: '01711000100' });
    const start = gm.inDays(-10);
    const lines = [
      HEADER,
      `Rafiq Hasan,01711000201,male,1990-05-01,Monthly,${start},,${start},"2,500",500,`,
      `Nadia Islam,01811000202,F,,Quarterly,${gm.inDays(-100)},,,,,`,
      'Tanvir Ahmed,01911000203,,,,,,,,,IY-0500',
      'Duplicate In Gym,01711000100,,,,,,,,,',
      `Bad Package,01711000204,,,Yearly,${start},,,,,`,
      'Bad Phone,12345,,,,,,,,,',
      `Rafiq Copy,01711000201,,,,,,,,,`,
      `End Before,01711000205,,,Monthly,${start},${gm.inDays(-20)},,,,`,
    ];
    const members = await models.GymMember.count();
    // With a byte order mark, as Excel saves CSV.
    const prev = (await upload(owner, gym.id, String.fromCharCode(0xfeff) + lines.join('\n')).expect(201)).body;
    conforms(s.Import, prev);
    expect(prev).toMatchObject({ status: 'previewed', rowsTotal: 8, rowsOk: 3, rowsFailed: 5, uploadedAs: 'owner', can: { apply: true, undo: false } });
    expect(prev.report.map((r) => [r.n, r.status, r.errors.map((e) => e.code)])).toEqual([
      [2, 'ok', []],
      [3, 'ok', []],
      [4, 'ok', []],
      [5, 'error', ['duplicate_phone_in_gym']],
      [6, 'error', ['unknown_package', 'package_required']],
      [7, 'error', ['phone_invalid']],
      [8, 'error', ['duplicate_phone_in_file']],
      [9, 'error', ['end_before_start']],
    ]);
    expect(JSON.stringify(prev.report)).not.toMatch(PHONE);
    expect(await models.GymMember.count()).toBe(members);
    // Bad files.
    expect((await upload(owner, gym.id, 'Email,Note\nx,y').expect(422)).body).toMatchObject({ code: 'GYM_IMPORT_INVALID', reason: 'columns', missing: ['name', 'phone'] });
    expect((await upload(owner, gym.id, '').expect(422)).body.reason).toBe('empty');
    expect((await upload(owner, gym.id, Buffer.from([0, 1, 2, 3])).expect(422)).body.reason).toBe('not_csv_or_xlsx');
    await h.setSettingForTest('gym_manage.import_max_rows', 100);
    expect((await upload(owner, gym.id, [HEADER, ...Array.from({ length: 101 }, (_, i) => `Person ${i},0171${String(2000000 + i)}`)].join('\n')).expect(422)).body.reason).toBe('too_many_rows');
    expect(h.events.recorded().filter((e) => e.name === 'gym_import.previewed')).toHaveLength(1);

    // Apply (Idempotency-Key): members with source import, memberships by today, dues and opening payments.
    await h.drainEvents();
    const notesBefore = await models.Notification.count();
    const ik = gm.key('apply');
    const applied = (await g.post(`/imports/${prev.id}/apply`, {}, ik).expect(200)).body;
    expect(applied).toMatchObject({ status: 'applied', rowsOk: 3, can: { undo: true, sendInvites: true } });
    expect((await g.post(`/imports/${prev.id}/apply`, {}, ik).expect(200)).body).toEqual(applied);
    expect((await g.post(`/imports/${prev.id}/apply`, {}, true).expect(409)).body.code).toBe('GYM_IMPORT_STATE');
    const rafiq = await models.GymMember.findOne({ where: { importId: prev.id, phoneLast4: '0201' } });
    expect(rafiq).toMatchObject({ source: 'import', status: 'active', memberCode: 'IY-0002' });
    const rafiqDue = await models.GymDue.findOne({ where: { memberId: rafiq.id } });
    expect(rafiqDue).toMatchObject({ amountPoisha: 300000, paidPoisha: 250000, status: 'partial' });
    expect((await models.GymFeePayment.findOne({ where: { memberId: rafiq.id } })).method).toBe('opening');
    expect((await models.GymMember.findOne({ where: { importId: prev.id, phoneLast4: '0202' } })).status).toBe('expired');
    expect((await models.GymMember.findOne({ where: { importId: prev.id, phoneLast4: '0203' } })).memberCode).toBe('IY-0500');
    await h.drainEvents();
    expect(await models.Notification.count()).toBe(notesBefore); // FR-78: no contact until asked
    // Opening balances are not counter money.
    expect((await g.get(`/cash-closing?date=${start}`).expect(200)).body.totals.counterPoisha).toBe(0);

    // Undo is blocked once an imported member has a check-in (FR-77).
    await g.post('/checkins', { memberId: rafiq.id }).expect(201);
    expect((await g.post(`/imports/${prev.id}/undo`).expect(409)).body).toMatchObject({ code: 'GYM_IMPORT_UNDO_BLOCKED', members: ['IY-0002'] });

    // A second file: apply, then undo within the window → removed, cancelled, void, reversed.
    const second = (await upload(owner, gym.id, [HEADER, `Sakib Khan,01711000301,,,Monthly,${gm.today()},,${gm.today()},1000,1500,`].join('\n')).expect(201)).body;
    await g.post(`/imports/${second.id}/apply`, {}, true).expect(200);
    const sakib = await models.GymMember.findOne({ where: { importId: second.id } });
    const undone = (await g.post(`/imports/${second.id}/undo`).expect(200)).body;
    expect(undone.status).toBe('undone');
    expect((await models.GymMember.findByPk(sakib.id)).status).toBe('removed');
    expect((await models.GymDue.findOne({ where: { memberId: sakib.id } })).status).toBe('void');
    expect(await models.GymFeePayment.count({ where: { memberId: sakib.id, amountPoisha: -100000 } })).toBe(1);
    expect((await models.GymMembership.findOne({ where: { memberId: sakib.id } })).status).toBe('cancelled');
    expect((await g.post(`/imports/${second.id}/undo`).expect(409)).body.code).toBe('GYM_IMPORT_STATE');
    // The undo window closes.
    await models.GymImport.update({ undoUntil: new Date(Date.now() - 1000) }, { where: { id: prev.id } });
    expect((await g.post(`/imports/${prev.id}/undo`).expect(409)).body).toMatchObject({ code: 'GYM_IMPORT_STATE', reason: 'undo_window_closed' });

    // Send app invites (FR-78): link requests for every imported member with a phone, once.
    const sent = (await g.post(`/imports/${prev.id}/send-invites`).expect(200)).body;
    expect(sent.sent).toBe(3);
    expect((await g.post(`/imports/${prev.id}/send-invites`).expect(409)).body.code).toBe('GYM_IMPORT_STATE');
    // Discard a preview; its file is deleted.
    const third = (await upload(owner, gym.id, `${HEADER}\nMitu Akter,01711000401`).expect(201)).body;
    expect((await g.post(`/imports/${third.id}/discard`).expect(200)).body).toMatchObject({ status: 'discarded', filePurged: true });
    expect((await g.get('/imports').expect(200)).body.items).toHaveLength(3);
    expect(h.events.recorded().map((e) => e.name)).toEqual(expect.arrayContaining(['gym_import.applied', 'gym_import.undone']));
  });

  it('XLSX on the template; Kriraghor staff upload only with the owner’s consent (FR-79); housekeeping (FR-80)', async () => {
    const { owner, gym } = await gm.privateGym();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Members');
    ws.addRow(HEADER.split(','));
    ws.addRow(['Rafiq Hasan', 8801711000501, 'Male', new Date(Date.UTC(1990, 4, 1)), 'Monthly', new Date(`${gm.inDays(-3)}T00:00:00Z`), null, null, null, 2500, null]);
    ws.addRow([{ richText: [{ text: 'Nadia ' }, { text: 'Islam' }] }, '01811000502', null, null, null, null, null, null, null, null, null]);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    const XL = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const prev = (await upload(owner, gym.id, xlsx, XL, 'members.xlsx').expect(201)).body;
    expect(prev).toMatchObject({ rowsTotal: 2, rowsOk: 2, fileName: 'members.xlsx' });
    expect(prev.report[0]).toMatchObject({ displayName: 'Rafiq Hasan', phoneLast4: '0501', package: 'Monthly', amountDuePoisha: 250000 });
    expect(prev.report[1]).toMatchObject({ displayName: 'Nadia Islam', status: 'ok' });
    expect((await upload(owner, gym.id, Buffer.from('not a zip'), XL).expect(422)).body.code).toBe('GYM_IMPORT_INVALID');
    // Kriraghor staff with manage_gyms: refused until the owner consents, then preview only.
    const support = await f.staffWith(master, ['manage_gyms']);
    const staffUpload = () => api().post(`${P}/admin/gym-manage/gyms/${gym.id}/imports`).set(h.bearer(support)).set('Content-Type', 'text/csv').send(Buffer.from(`${HEADER}\nMitu Akter,01711000601`));
    expect((await staffUpload().expect(403)).body.code).toBe('GYM_IMPORT_CONSENT_REQUIRED');
    const consent = (await gm.manage(owner, gym.id).put('/import-consent', { grant: true }).expect(200)).body;
    expect(new Date(consent.importConsentUntil).getTime()).toBeGreaterThan(Date.now() + 6 * 86400000);
    const byStaff = (await staffUpload().expect(201)).body;
    expect(byStaff).toMatchObject({ uploadedAs: 'staff', status: 'previewed' });
    expect(await models.AuditLog.count({ where: { action: 'gym_import.previewed', actorId: support.userId } })).toBe(1);
    const noRight = await f.staffWith(master, ['approve_listings']);
    expect((await api().post(`${P}/admin/gym-manage/gyms/${gym.id}/imports`).set(h.bearer(noRight)).set('Content-Type', 'text/csv').send(Buffer.from('x')).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    await gm.manage(owner, gym.id).put('/import-consent', { grant: false }).expect(200);
    expect((await staffUpload().expect(403)).body.code).toBe('GYM_IMPORT_CONSENT_REQUIRED');
    // Housekeeping: stale previews are discarded, raw files past retention purged; a re-run changes nothing.
    await models.GymImport.update({ createdAt: new Date(Date.now() - 31 * 86400000) }, { where: { id: prev.id } });
    const first = await jobs.importHousekeeping();
    expect(first).toEqual({ discarded: 1, purged: 1 });
    expect(await models.GymImport.findByPk(prev.id)).toMatchObject({ status: 'discarded', fileKey: null });
    expect(await jobs.importHousekeeping()).toEqual({ discarded: 0, purged: 0 });
  });
});

describe('M20 pass admissions count for linked members (FR-52)', () => {
  it('a linked member admitted on a pass gets a pass check-in; a visitor gets none', async () => {
    const reviewer = await f.staffWith(master, ['approve_listings', 'approve_documents']);
    const { owner, gym } = await b.liveGym(reviewer, reviewer);
    await gm.manage(owner, gym.id).patch('/settings', { shortCode: 'IY' }).expect(200);
    const person = await h.signupUser({ name: 'Rafiq Hasan' });
    const visitor = await h.signupUser({ name: 'Visitor' });
    const m = await gm.addMember(owner, gym.id, { displayName: 'Rafiq Hasan', phone: person.phone });
    const inv = (await gm.manage(owner, gym.id).post(`/members/${m.member.id}/invite`, {}).expect(201)).body;
    await api().post(`${P}/me/gym-requests/${inv.request.id}/accept`).set(h.bearer(person)).expect(200);
    await b.admit(owner, gym, await b.paidPass(person, gym, 'day'));
    await b.admit(owner, gym, await b.paidPass(visitor, gym, 'day'));
    await h.drainEvents();
    const rows = await models.GymAttendance.findAll({ where: { gymId: gym.id } });
    expect(rows.map((r) => [r.memberId, r.method, r.counted])).toEqual([[m.member.id, 'pass', true]]);
    expect(rows[0].passRedemptionId).toBeTruthy();
    // Replaying the event changes nothing (one row per redemption).
    const e = h.events.recorded().find((x) => x.name === 'gym_pass.redeemed' && x.payload.holderId === person.user.id);
    await models.sequelize.transaction((transaction) => require('../../src/modules/gym-manage/checkins.service').onPassRedeemed(e.payload, { transaction }));
    expect(await models.GymAttendance.count({ where: { gymId: gym.id } })).toBe(1);
    // M20: desk packages never reach the public page.
    expect((await api().get(`${P}/gym/gyms/${gym.slug}`).expect(200)).body.packages.every((p) => p.channel !== 'desk')).toBe(true);
  });
});

describe('jobs, run twice (FR-31, FR-39, §10)', () => {
  it('daily: freezes start and end, upcoming → active, active → expired; dues overdue once; requests expire', async () => {
    const { owner, gym, pkg } = await gm.privateGym();
    const g = gm.manage(owner, gym.id);
    // An active membership that ended yesterday with a renewal waiting: the renewal starts.
    const a = await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.inDays(-25) } });
    const renewed = (await g.post(`/memberships/${a.membership.id}/renew`, {}, true).expect(201)).body.membership;
    // A frozen membership whose freeze ends; a scheduled freeze that starts today.
    const b2 = await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.inDays(-5) } });
    await g.post(`/memberships/${b2.membership.id}/freeze`, { fromOn: gm.today(), toOn: gm.inDays(2), reason: 'Fever' }).expect(200);
    const c3 = await gm.addMember(owner, gym.id, { membership: { packageId: pkg('month').id, startsOn: gm.inDays(-5) } });
    await g.post(`/memberships/${c3.membership.id}/freeze`, { fromOn: gm.inDays(1), toOn: gm.inDays(2), reason: 'Travel' }).expect(200);
    // Move time by editing dates: a's month ended yesterday; b2's freeze ended; c3's freeze starts today.
    await models.GymMembership.update({ endsOn: gm.inDays(-1) }, { where: { id: a.membership.id } });
    await models.GymMembership.update({ startsOn: gm.today(), endsOn: gm.inDays(29) }, { where: { id: renewed.id } });
    const bf = await models.GymFreeze.findOne({ where: { membershipId: b2.membership.id } });
    await bf.update({ fromOn: gm.inDays(-3), toOn: gm.inDays(-1) });
    await models.GymFreeze.update({ fromOn: gm.today() }, { where: { membershipId: c3.membership.id } });
    const first = await jobs.daily();
    expect(first).toEqual({ freezesStarted: 1, freezesEnded: 1, expired: 1, started: 1, plansEnded: 0 });
    expect(await jobs.daily()).toEqual({ freezesStarted: 0, freezesEnded: 0, expired: 0, started: 0, plansEnded: 0 });
    expect((await models.GymMembership.findByPk(a.membership.id)).status).toBe('expired');
    expect((await models.GymMembership.findByPk(renewed.id)).status).toBe('active');
    expect((await models.GymMember.findByPk(a.member.id)).status).toBe('active');
    expect((await models.GymMembership.findByPk(b2.membership.id)).status).toBe('active');
    expect((await models.GymMembership.findByPk(c3.membership.id)).status).toBe('frozen');
    expect((await models.GymMember.findByPk(c3.member.id)).status).toBe('frozen');
    // Dues overdue: overdue_at once, one event per due (FR-39).
    const first2 = await jobs.duesOverdue();
    expect(first2.marked).toBeGreaterThan(0);
    expect((await jobs.duesOverdue()).marked).toBe(0);
    expect(h.events.recorded().filter((e) => e.name === 'gym_due.overdue_marked')).toHaveLength(first2.marked);
    // Requests expire.
    const inv = (await g.post(`/members/${a.member.id}/invite`, {}).expect(201)).body.request;
    await models.GymLinkRequest.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { id: inv.id } });
    expect(await jobs.requestsExpire()).toEqual({ expired: 1 });
    expect(await jobs.requestsExpire()).toEqual({ expired: 0 });
    expect((await models.GymLinkRequest.findByPk(inv.id)).status).toBe('expired');
    // The job definitions are on the gym queue.
    const { byName } = require('../../src/jobs/definitions');
    for (const n of ['gym-manage.daily', 'gym-manage.dues-overdue', 'gym-manage.requests-expire', 'gym-manage.import-housekeeping']) expect(byName.get(n).queue).toBe('gym');
  });
});

describe('privacy (FR-11, FR-108)', () => {
  it('no phone, email or health note in any gym-manage outbox payload or audit row', async () => {
    const { owner, gym, pkg } = await gm.privateGym({ tier: 'basic' });
    const person = await h.signupUser({ name: 'Rafiq Hasan' });
    const a = await gm.addMember(owner, gym.id, { displayName: 'Rafiq Hasan', phone: person.phone, email: 'rafiq@example.com', emergencyContact: { name: 'Salma', phone: '01811000999' }, membership: { packageId: pkg('month').id, startsOn: gm.today() }, payment: { amountPoisha: 100000, method: 'cash' } });
    const inv = (await gm.manage(owner, gym.id).post(`/members/${a.member.id}/invite`, {}).expect(201)).body;
    await api().post(`${P}/me/gym-requests/${inv.request.id}/accept`).set(h.bearer(person)).expect(200);
    await api().put(`${P}/me/gym-memberships/${a.member.id}/health-note`).set(h.bearer(person)).send({ text: 'Diabetic' }).expect(200);
    await gm.manage(owner, gym.id).post('/checkins', { memberId: a.member.id }).expect(201);
    const rows = await models.OutboxEvent.findAll({ where: { name: { [require('sequelize').Op.like]: 'gym\\_%' } } });
    expect(rows.length).toBeGreaterThan(5);
    const text = JSON.stringify(rows.map((r) => r.payload));
    expect(text).not.toMatch(PHONE);
    expect(text).not.toMatch(/rafiq@|Diabetic|Salma/);
    const audits = JSON.stringify((await models.AuditLog.findAll({ where: { module: 'M24' } })).map((r) => [r.before, r.after, r.meta]));
    expect(audits).not.toMatch(PHONE);
    expect(audits).not.toMatch(/rafiq@|Diabetic/);
  });
});
