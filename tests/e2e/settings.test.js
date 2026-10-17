'use strict';

// M03 settings engine: public view, admin reads, change requests, four-eyes, scheduling,
// history, cache bust, boot check and seed. Requirement IDs in each describe.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const { processJob } = require('../../src/jobs/runtime');
const { seedReference } = require('../../src/db/seed');

const { api, P, models, settings } = h;

beforeEach(h.resetDb);
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

let empSeq = 0;
/** A staff member with the given permission flags, signed in to the admin portal. */
async function setupStaff(master, permissions) {
  empSeq += 1;
  const member = await h.signupUser({ name: 'Nusrat Jahan' });
  const token = await h.stepUp(master, 'staff.write');
  await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', token).send({ userId: member.user.id, employeeId: `KG-S-${empSeq}`, permissions }).expect(201);
  return h.signInStaff(member.phone, member.user.id);
}

/** POST with a fresh settings.write step-up token. */
async function write(session, path, body = {}) {
  const token = await h.stepUp(session, 'settings.write');
  return api().post(`${P}/admin/settings${path}`).set(h.bearer(session)).set('X-Step-Up', token).send(body);
}

const propose = (session, changes, extra = {}) => write(session, '/change-requests', { changes, reason: 'Testing the change flow', ...extra });
const later = (ms = 3600 * 1000) => new Date(Date.now() + ms).toISOString();
/** Make a scheduled request due now (instead of waiting for it). */
const makeDue = (id) => models.SettingsChangeRequest.update({ effectiveAt: new Date(Date.now() - 1000) }, { where: { id } });

describe('GET /settings/public (M03-FR-18, FR-02)', () => {
  it('exposes only public keys, nested and camelCase, with money as amount and currency', async () => {
    const r = await api().get(`${P}/settings/public`).expect(200);
    expect(r.headers['cache-control']).toBe('public, max-age=300');
    expect(r.body.booking).toMatchObject({ advancePctMin: 20, advancePctMax: 50, advancePctDefault: 30, allowFullPayment: true, advanceRefundable: false, windowDays: 7 });
    expect(r.body.market.deliveryFeeDhaka).toEqual({ amount: 8000, currency: 'BDT' });
    expect(r.body.fees).toEqual({ groundBookingPct: 5 });
    expect(r.body.esports).toMatchObject({ minWithdraw: { amount: 10000, currency: 'BDT' }, checkinOpenMinutes: 60 });
    // Not public: commissions, auth limits, risk thresholds, room reveal.
    expect(r.body.auth).toBeUndefined();
    expect(r.body.risk).toBeUndefined();
    expect(r.body.esports.roomRevealMinutes).toBeUndefined();
    expect(typeof r.body.version).toBe('string');

    const again = await api().get(`${P}/settings/public`).set('If-None-Match', r.headers.etag).expect(304);
    expect(again.text).toBe('');
  });
});

describe('admin reads (M03 §3)', () => {
  it('lets masters and manage_catalog staff read; others and customers cannot', async () => {
    const master = await h.createSignedInMaster();
    const list = await api().get(`${P}/admin/settings`).set(h.bearer(master)).expect(200);
    const fee = list.body.items.find((s) => s.key === 'fees.shop_commission_pct');
    expect(fee).toMatchObject({ value: 5, valueType: 'decimal', unit: '%', min: 0, max: 25, approval: 'four_eyes', isPublic: false, version: 1, label: { en: 'Shop commission on new gear' } });
    expect(fee.label.bn).toBeTruthy();

    const fees = await api().get(`${P}/admin/settings?category=fees`).set(h.bearer(master)).expect(200);
    expect(fees.body.items.map((s) => s.key)).toEqual(['fees.ground_booking_pct', 'fees.shop_commission_pct', 'fees.used_gear_pct', 'fees.hire_pct', 'fees.tournament_pct', 'fees.gym_pct', 'fees.esports_saas_pct']);

    const catalogStaff = await setupStaff(master, ['manage_catalog']);
    await api().get(`${P}/admin/settings`).set(h.bearer(catalogStaff)).expect(200);
    await api().get(`${P}/admin/settings/fees.hire_pct/history`).set(h.bearer(catalogStaff)).expect(200);
    // Read-only: proposing is master only (checked before step-up).
    const denied = await api().post(`${P}/admin/settings/change-requests`).set(h.bearer(catalogStaff)).send({ changes: [{ key: 'fees.hire_pct', to: 11 }], reason: 'Not allowed' }).expect(403);
    expect(denied.body.code).toBe('MASTER_REQUIRED');

    const other = await setupStaff(master, ['approve_documents']);
    const noPerm = await api().get(`${P}/admin/settings`).set(h.bearer(other)).expect(403);
    expect(noPerm.body.code).toBe('PERMISSION_REQUIRED');

    const member = await h.signupUser();
    const customer = await api().get(`${P}/admin/settings`).set(h.bearer(member)).expect(401);
    expect(customer.body.code).toBe('TOKEN_AUDIENCE_INVALID');
  });

  it('returns 422 SETTING_UNKNOWN for the history of an unknown key', async () => {
    const master = await h.createSignedInMaster();
    const r = await api().get(`${P}/admin/settings/fees.nope_pct/history`).set(h.bearer(master)).expect(422);
    expect(r.body.code).toBe('SETTING_UNKNOWN');
  });
});

describe('single-approval changes (M03-FR-11, FR-15)', () => {
  it('needs step-up settings.write', async () => {
    const master = await h.createSignedInMaster();
    const r = await api().post(`${P}/admin/settings/change-requests`).set(h.bearer(master)).send({ changes: [{ key: 'esports.room_reveal_minutes', to: 10 }], reason: 'Shorter reveal' }).expect(403);
    expect(r.body.code).toBe('STEP_UP_REQUIRED');
    const wrongScope = await h.stepUp(master, 'staff.write');
    await api().post(`${P}/admin/settings/change-requests`).set(h.bearer(master)).set('X-Step-Up', wrongScope).send({ changes: [{ key: 'esports.room_reveal_minutes', to: 10 }], reason: 'Shorter reveal' }).expect(403);
  });

  it('applies at once: version, history, audit, event and the cache all move together', async () => {
    const master = await h.createSignedInMaster();
    const r = await propose(master, [{ key: 'esports.room_reveal_minutes', to: 10 }]);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'applied', needsFourEyes: false, needsSecondApprover: false, changes: [{ key: 'esports.room_reveal_minutes', from: 15, to: 10 }] });
    expect(r.body.proposedBy).toEqual({ id: master.userId, displayName: 'Ayesha Siddiqua' });

    expect(settings.get('esports.room_reveal_minutes')).toBe(10);
    const row = await models.PlatformSetting.findByPk('esports.room_reveal_minutes');
    expect(row).toMatchObject({ value: 10, version: 2, updatedBy: master.userId });

    const history = await api().get(`${P}/admin/settings/esports.room_reveal_minutes/history`).set(h.bearer(master)).expect(200);
    expect(history.body.items.map((i) => [i.version, i.oldValue, i.newValue])).toEqual([[2, 15, 10], [1, null, 15]]);
    expect(history.body.items[0]).toMatchObject({ requestId: r.body.id, reason: 'Testing the change flow', changedBy: { id: master.userId } });

    const auditRow = await models.AuditLog.findOne({ where: { action: 'setting.changed', entityId: 'esports.room_reveal_minutes' } });
    expect(auditRow).toMatchObject({ actorId: master.userId, entityType: 'platform_setting', before: { value: 15, version: 1 }, after: { value: 10, version: 2 } });
    expect(auditRow.meta).toMatchObject({ severity: 'critical', stepUp: true, requestId: r.body.id });

    // setting.changed is critical (M04-FR-11), so the audit row also emits audit.critical_recorded.
    const names = h.events.recorded().map((e) => e.name);
    expect(names).toEqual(['setting.change_proposed', 'audit.critical_recorded', 'setting.changed']);
    expect(h.events.recorded()[1].payload).toMatchObject({ action: 'setting.changed', actorId: master.userId, entityId: 'esports.room_reveal_minutes' });
    expect(await models.OutboxEvent.count({ where: { status: 'pending' } })).toBe(3);
    expect(h.events.recorded()[2].payload).toMatchObject({ key: 'esports.room_reveal_minutes', version: 2, oldValue: 15, newValue: 10, requestId: r.body.id });
  });

  it('validates type, range, cross-key rules and no-op changes before consuming step-up', async () => {
    const master = await h.createSignedInMaster();
    const cases = [
      [[{ key: 'esports.room_reveal_minutes', to: 500 }], 'SETTING_OUT_OF_RANGE'],
      [[{ key: 'esports.room_reveal_minutes', to: 'soon' }], 'SETTING_TYPE_INVALID'],
      [[{ key: 'fees.made_up_pct', to: 5 }], 'SETTING_UNKNOWN'],
      [[{ key: 'fees.ground_booking_pct', to: 21 }], 'SETTING_OUT_OF_RANGE'],
      [[{ key: 'esports.checkin_close_minutes', to: 10 }], 'SETTING_CROSS_RULE'], // room reveal 15 > close 10
      [[{ key: 'esports.room_reveal_minutes', to: 15 }], 'SETTING_UNCHANGED'],
    ];
    for (const [changes, code] of cases) {
      const r = await propose(master, changes);
      expect([r.status, r.body.code]).toEqual([422, code]);
    }
    const cross = await propose(master, [{ key: 'esports.checkin_close_minutes', to: 10 }]);
    expect(cross.body.detail).toBe('esports.room_reveal_minutes ≤ esports.checkin_close_minutes');
    // Several keys at once can satisfy a rule together.
    const both = await propose(master, [{ key: 'esports.checkin_close_minutes', to: 10 }, { key: 'esports.room_reveal_minutes', to: 5 }]);
    expect(both.body.status).toBe('applied');

    const past = await propose(master, [{ key: 'esports.room_reveal_minutes', to: 6 }], { effectiveAt: new Date(Date.now() - 3600 * 1000).toISOString() });
    expect([past.status, past.body.code]).toEqual([400, 'EFFECTIVE_AT_PAST']);

    // A schema error is caught before the single-use step-up token is spent.
    const token = await h.stepUp(master, 'settings.write');
    const bad = await api().post(`${P}/admin/settings/change-requests`).set(h.bearer(master)).set('X-Step-Up', token).send({ changes: [], reason: 'x' }).expect(422);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    await api().post(`${P}/admin/settings/change-requests`).set(h.bearer(master)).set('X-Step-Up', token).send({ changes: [{ key: 'esports.room_reveal_minutes', to: 7 }], reason: 'Same token' }).expect(201);
    const dup = await propose(master, [{ key: 'fees.hire_pct', to: 11 }, { key: 'fees.hire_pct', to: 12 }]);
    expect(dup.status).toBe(422);
  });
});

describe('four-eyes changes (M03-FR-12)', () => {
  it('a fee change needs a second master; the proposer cannot approve or reject it', async () => {
    const a = await h.createSignedInMaster();
    const b = await h.createSecondMaster();

    const proposed = await propose(a, [{ key: 'fees.shop_commission_pct', to: 6 }]);
    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({ status: 'proposed', needsFourEyes: true, needsSecondApprover: true });
    expect(settings.get('fees.shop_commission_pct')).toBe(5);

    const self = await write(a, `/change-requests/${proposed.body.id}/approve`);
    expect([self.status, self.body.code]).toEqual([403, 'FOUR_EYES_REQUIRED']);
    const selfReject = await write(a, `/change-requests/${proposed.body.id}/reject`, { note: 'Changed my mind' });
    expect([selfReject.status, selfReject.body.code]).toEqual([403, 'FOUR_EYES_REQUIRED']);

    const approved = await write(b, `/change-requests/${proposed.body.id}/approve`, { note: 'Agreed at the Monday review' });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'applied', approvedBy: { id: b.userId }, decisionNote: 'Agreed at the Monday review', needsSecondApprover: false });
    expect(settings.get('fees.shop_commission_pct')).toBe(6);

    const hist = await models.SettingsHistory.findOne({ where: { key: 'fees.shop_commission_pct', version: 2 } });
    expect(hist).toMatchObject({ changedBy: a.userId, approvedBy: b.userId, oldValue: 5, newValue: 6 });
    expect(await models.AuditLog.count({ where: { action: ['setting.change_proposed', 'setting.change_approved', 'setting.changed'] } })).toBe(3);

    const again = await write(b, `/change-requests/${proposed.body.id}/approve`);
    expect([again.status, again.body.code]).toEqual([409, 'CHANGE_REQUEST_CLOSED']);
  });

  it('the database refuses an approver who is the proposer', async () => {
    const a = await h.createSignedInMaster();
    const proposed = await propose(a, [{ key: 'fees.hire_pct', to: 11 }]);
    await expect(models.sequelize.query('UPDATE settings_change_requests SET approved_by = proposed_by WHERE id = ?', { replacements: [proposed.body.id] })).rejects.toThrow(/chk_settings_cr_four_eyes/);
  });

  it('reject and withdraw', async () => {
    const a = await h.createSignedInMaster();
    const b = await h.createSecondMaster();
    const one = await propose(a, [{ key: 'fees.hire_pct', to: 12 }]);
    const noNote = await write(b, `/change-requests/${one.body.id}/reject`, {});
    expect(noNote.status).toBe(422);
    const rejected = await write(b, `/change-requests/${one.body.id}/reject`, { note: 'Too high for launch' });
    expect(rejected.body).toMatchObject({ status: 'rejected', decidedBy: { id: b.userId }, decisionNote: 'Too high for launch' });

    const two = await propose(a, [{ key: 'fees.hire_pct', to: 11 }]);
    const notMine = await write(b, `/change-requests/${two.body.id}/withdraw`);
    expect([notMine.status, notMine.body.code]).toEqual([403, 'NOT_PROPOSER']);
    const withdrawn = await write(a, `/change-requests/${two.body.id}/withdraw`, { note: 'Wrong number' });
    expect(withdrawn.body.status).toBe('withdrawn');
    const late = await write(b, `/change-requests/${two.body.id}/approve`);
    expect(late.body.code).toBe('CHANGE_REQUEST_CLOSED');

    expect(settings.get('fees.hire_pct')).toBe(10);
    expect(h.events.recorded().map((e) => e.name)).toEqual(expect.arrayContaining(['setting.change_rejected', 'setting.change_withdrawn']));
    const missing = await write(b, '/change-requests/00000000-0000-4000-8000-000000000000/approve');
    expect(missing.status).toBe(404);
  });

  it('applying one request supersedes other open requests for the same key (§12)', async () => {
    const a = await h.createSignedInMaster();
    const b = await h.createSecondMaster();
    const first = await propose(a, [{ key: 'fees.hire_pct', to: 11 }]);
    const second = await propose(b, [{ key: 'fees.hire_pct', to: 12 }, { key: 'fees.gym_pct', to: 6 }]);
    const unrelated = await propose(a, [{ key: 'fees.tournament_pct', to: 6 }]);
    await write(b, `/change-requests/${first.body.id}/approve`).then((r) => expect(r.body.status).toBe('applied'));

    const list = await api().get(`${P}/admin/settings/change-requests`).set(h.bearer(a)).expect(200);
    const status = Object.fromEntries(list.body.items.map((i) => [i.id, i.status]));
    expect(status).toEqual({ [first.body.id]: 'applied', [second.body.id]: 'superseded', [unrelated.body.id]: 'proposed' });
    const superseded = await api().get(`${P}/admin/settings/change-requests/${second.body.id}`).set(h.bearer(a)).expect(200);
    expect(superseded.body.decisionNote).toBe(`Superseded by request ${first.body.id}`);

    const proposedOnly = await api().get(`${P}/admin/settings/change-requests?status=proposed`).set(h.bearer(a)).expect(200);
    expect(proposedOnly.body.items.map((i) => i.id)).toEqual([unrelated.body.id]);
  });
});

describe('scheduled changes (M03-FR-13, settings.apply-scheduled)', () => {
  it('a single-approval change waits for its time, then the job applies it once', async () => {
    const master = await h.createSignedInMaster();
    const r = await propose(master, [{ key: 'booking.window_days', to: 14 }], { effectiveAt: later() });
    expect(r.body.status).toBe('approved');
    expect(settings.get('booking.window_days')).toBe(7);

    expect(await processJob({ name: 'settings.apply-scheduled', data: { requestId: r.body.id } })).toEqual({ applied: 0, failed: 0 });
    await makeDue(r.body.id);
    expect(await processJob({ name: 'settings.apply-scheduled', data: {} })).toEqual({ applied: 1, failed: 0 });
    expect(settings.get('booking.window_days')).toBe(14);
    // Idempotent: a second delivery finds nothing to do.
    expect(await processJob({ name: 'settings.apply-scheduled', data: { requestId: r.body.id } })).toEqual({ applied: 0, failed: 0 });
    const done = await models.SettingsChangeRequest.findByPk(r.body.id);
    expect(done.status).toBe('applied');
    expect(await models.AuditLog.findOne({ where: { action: 'setting.changed', entityId: 'booking.window_days' } })).toMatchObject({ actorId: null, actorRole: 'system' });
  });

  it('an approved four-eyes change with a future time is applied by the job; the proposer may withdraw it before then', async () => {
    const a = await h.createSignedInMaster();
    const b = await h.createSecondMaster();
    const r = await propose(a, [{ key: 'fees.gym_pct', to: 7 }], { effectiveAt: later() });
    const approved = await write(b, `/change-requests/${r.body.id}/approve`);
    expect(approved.body.status).toBe('approved');
    expect(settings.get('fees.gym_pct')).toBe(5);
    await makeDue(r.body.id);
    await processJob({ name: 'settings.apply-scheduled', data: { requestId: r.body.id } });
    expect(settings.get('fees.gym_pct')).toBe(7);

    const second = await propose(a, [{ key: 'fees.gym_pct', to: 8 }], { effectiveAt: later() });
    await write(b, `/change-requests/${second.body.id}/approve`);
    const w = await write(a, `/change-requests/${second.body.id}/withdraw`);
    expect(w.body.status).toBe('withdrawn');
  });

  it('a scheduled change that now breaks a rule is rejected with a note', async () => {
    const master = await h.createSignedInMaster();
    const scheduled = await propose(master, [{ key: 'esports.room_reveal_minutes', to: 18 }], { effectiveAt: later() });
    expect(scheduled.body.status).toBe('approved');
    await propose(master, [{ key: 'esports.checkin_close_minutes', to: 16 }]); // fine today: 15 ≤ 16
    await makeDue(scheduled.body.id);
    expect(await processJob({ name: 'settings.apply-scheduled', data: {} })).toEqual({ applied: 0, failed: 1 });
    const row = await models.SettingsChangeRequest.findByPk(scheduled.body.id);
    expect(row.status).toBe('rejected');
    expect(row.decisionNote).toBe('Could not apply: esports.room_reveal_minutes ≤ esports.checkin_close_minutes');
    expect(settings.get('esports.room_reveal_minutes')).toBe(15);
  });

  it('approving a future change that already breaks a rule fails at once', async () => {
    const a = await h.createSignedInMaster();
    const b = await h.createSecondMaster();
    const r = await propose(a, [{ key: 'fees.ground_booking_pct', to: 15 }], { effectiveAt: later() });
    await propose(a, [{ key: 'booking.advance_pct_min', to: 10 }]); // advance min 10 < fee 15 from now on
    const approve = await write(b, `/change-requests/${r.body.id}/approve`);
    expect([approve.status, approve.body.code]).toEqual([422, 'SETTING_CROSS_RULE']);
    expect((await models.SettingsChangeRequest.findByPk(r.body.id)).status).toBe('proposed');
  });
});

describe('history and reads (M03-FR-11, FR-13, FR-17)', () => {
  it('getAt returns the value effective at a time; snapshot carries the version', async () => {
    const master = await h.createSignedInMaster();
    const before = new Date();
    await new Promise((r) => setTimeout(r, 20));
    await propose(master, [{ key: 'esports.default_prize_places', to: 5 }]);
    expect(await settings.getAt('esports.default_prize_places', before)).toMatchObject({ value: 3, version: 1 });
    expect(await settings.getAt('esports.default_prize_places')).toMatchObject({ value: 5, version: 2 });
    expect(await settings.getAt('esports.default_prize_places', new Date('2020-01-01'))).toMatchObject({ value: 3, version: 1 });
    expect(settings.snapshot(['esports.default_prize_places', 'fees.ground_booking_pct'])).toEqual({
      'esports.default_prize_places': { value: 5, version: 2 },
      'fees.ground_booking_pct': { value: 5, version: 1 },
    });
    expect(() => settings.get('nope.key')).toThrow(expect.objectContaining({ code: 'SETTING_UNKNOWN' }));
  });

  it('settings_history is append-only, in the database and in the model', async () => {
    await expect(models.sequelize.query("UPDATE settings_history SET reason = 'x'")).rejects.toThrow(/append-only/);
    await expect(models.sequelize.query('DELETE FROM settings_history')).rejects.toThrow(/append-only/);
    const row = await models.SettingsHistory.findOne();
    await expect(row.update({ reason: 'x' })).rejects.toThrow(/append-only/);
    await expect(models.SettingsHistory.destroy({ where: {} })).rejects.toThrow(/append-only/);
  });
});

describe('cache bust across processes (M03-FR-16)', () => {
  it('another process sees the new value within 2 seconds', async () => {
    let other;
    let otherModels;
    let otherRedis;
    jest.isolateModules(() => {
      other = require('../../src/modules/settings/settings.service');
      otherModels = require('../../src/models');
      otherRedis = require('../../src/common/redis');
    });
    try {
      await other.load();
      await other.subscribe();
      expect(other.get('esports.max_uids_per_game')).toBe(1);
      const master = await h.createSignedInMaster();
      await propose(master, [{ key: 'esports.max_uids_per_game', to: 2 }]);
      const deadline = Date.now() + 2000;
      while (other.get('esports.max_uids_per_game') !== 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      expect(other.get('esports.max_uids_per_game')).toBe(2);
    } finally {
      await otherRedis.closeAllRedis();
      await otherModels.sequelize.close();
    }
  });
});

describe('boot check and seed (M03 §12, §15)', () => {
  it('the boot check fails when a key is missing', async () => {
    await settings.bootCheck();
    // Test-only removal to simulate a database the release step never seeded (history first: it references the key).
    await models.sequelize.query('ALTER TABLE settings_history DISABLE TRIGGER trg_settings_history_append_only');
    try {
      await models.sequelize.query("DELETE FROM settings_history WHERE \"key\" = 'fees.hire_pct'");
    } finally {
      await models.sequelize.query('ALTER TABLE settings_history ENABLE TRIGGER trg_settings_history_append_only');
    }
    await models.sequelize.query("DELETE FROM platform_settings WHERE \"key\" = 'fees.hire_pct'");
    await expect(settings.bootCheck()).rejects.toThrow(/missing 1 key\(s\), e\.g\. fees\.hire_pct/);
  });

  it('seeding twice is a no-op and never overwrites a changed value', async () => {
    const master = await h.createSignedInMaster();
    await propose(master, [{ key: 'esports.room_reveal_minutes', to: 12 }]);
    expect(await seedReference()).toEqual({ settings: 0, esports: 0, templates: 0, kycRequirements: 0, moderation: 0, places: 0 });
    expect((await models.PlatformSetting.findByPk('esports.room_reveal_minutes')).value).toBe(12);
    expect(await models.PlatformSetting.count()).toBe(175);
    expect(await models.EsportsGame.count()).toBe(2);
  });
});

describe('M01 reads its limits from settings (M03 DoD: used by another module)', () => {
  it('OTP attempts and the code lifetime follow the settings', async () => {
    await h.setSettingForTest('auth.otp_max_attempts', 2);
    await h.setSettingForTest('auth.otp_ttl_sec', 600);
    const phone = h.nextPhone();
    const sent = await api().post(`${P}/auth/otp/send`).send({ target: phone, purpose: 'signup' }).expect(202);
    expect(sent.body.expiresInSeconds).toBe(600);
    expect(h.sms.lastTo(h.e164(phone)).text).toContain('expires in 10 minutes');
    const wrong = (code) => api().post(`${P}/auth/otp/verify`).send({ target: phone, purpose: 'signup', code });
    const first = await wrong('000000').expect(400);
    expect(first.body.title).toBe('That code is not right. 1 attempt left.');
    const second = await wrong('000001').expect(400);
    expect(second.body.title).toBe('Too many wrong codes. Request a new one.');
  });
});
