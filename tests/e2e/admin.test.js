'use strict';

const h = require('../helpers');
const { api, P, models } = h;

beforeEach(h.resetDb);
afterAll(() => models.sequelize.close());

describe('staff two-factor', () => {
  it('forces a master to enrol TOTP before getting a session', async () => {
    const master = await h.createSignedInMaster();
    expect(master.user.isMaster).toBe(true);
    expect(master.user.twoFactor).toEqual({ required: true, enabled: true });
    const me = await api().get(`${P}/me`).set(h.bearer(master)).expect(200);
    expect(me.body.permissions).toEqual(expect.arrayContaining(['edit_fees', 'manage_staff', 'manage_users']));
  });

  it('rejects a wrong TOTP code', async () => {
    const master = await h.createSignedInMaster();
    await h.allowResend(master.phone);
    await api().post(`${P}/auth/otp/send`).send({ target: master.phone, purpose: 'login' }).expect(202);
    const v = await api().post(`${P}/auth/otp/verify`).send({ target: master.phone, purpose: 'login', code: h.lastCode(master.phone) }).expect(200);
    expect(v.body.status).toBe('two_factor_required');
    const r = await api().post(`${P}/auth/2fa/totp/verify`).send({ challengeToken: v.body.challengeToken, code: '000000' }).expect(400);
    expect(['TOTP_INVALID', 'TOTP_REPLAYED']).toContain(r.body.code);
  });
});

describe('step-up', () => {
  it('is required, scoped and single-use', async () => {
    const master = await h.createSignedInMaster();
    const member = await h.signupUser();

    const noStep = await api().post(`${P}/admin/staff`).set(h.bearer(master)).send({ userId: member.user.id, employeeId: 'KG-0101' }).expect(403);
    expect(noStep.body).toMatchObject({ code: 'STEP_UP_REQUIRED', scope: 'staff.write' });

    const wrongScope = await h.stepUp(master, 'user.ban');
    await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', wrongScope).send({ userId: member.user.id, employeeId: 'KG-0101' }).expect(403);

    const token = await h.stepUp(master, 'staff.write');
    await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', token).send({ userId: member.user.id, employeeId: 'KG-0101', team: 'Verification', permissions: ['approve_documents'] }).expect(201);

    const member2 = await h.signupUser();
    const reuse = await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', token).send({ userId: member2.user.id, employeeId: 'KG-0102' }).expect(403);
    expect(reuse.body.code).toBe('STEP_UP_REQUIRED');
  });
});

describe('staff permissions', () => {
  async function setupStaff(permissions) {
    const master = await h.createSignedInMaster();
    const member = await h.signupUser({ name: 'Rafiq Hasan' });
    const token = await h.stepUp(master, 'staff.write');
    await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', token).send({ userId: member.user.id, employeeId: 'KG-0201', team: 'Verification', permissions }).expect(201);
    const staff = await h.signInStaff(member.phone, member.user.id);
    return { master, staff, member };
  }

  it('cannot grant master-only permissions', async () => {
    const master = await h.createSignedInMaster();
    const member = await h.signupUser();
    const token = await h.stepUp(master, 'staff.write');
    const r = await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', token).send({ userId: member.user.id, employeeId: 'KG-0301', permissions: ['edit_fees'] }).expect(422);
    expect(r.body.code).toBe('PERMISSION_NOT_GRANTABLE');
  });

  it('enforces flags and revokes sessions when they change', async () => {
    const { master, staff } = await setupStaff(['approve_documents']);

    const denied = await api().get(`${P}/admin/users`).set(h.bearer(staff)).expect(403);
    expect(denied.body).toMatchObject({ code: 'PERMISSION_REQUIRED', missing: ['manage_users'] });

    const token = await h.stepUp(master, 'staff.write');
    const res = await api()
      .put(`${P}/admin/staff/permissions`)
      .set(h.bearer(master))
      .set('X-Step-Up', token)
      .send({ changes: [{ userId: staff.userId, grant: ['manage_users'], revoke: ['approve_documents'] }], reason: 'Moves to support rota' })
      .expect(200);
    expect(res.body).toMatchObject({ applied: 2 });
    expect(res.body.sessionsRevoked).toBeGreaterThanOrEqual(1);

    await api().get(`${P}/admin/users`).set(h.bearer(staff)).expect(401);
    const again = await h.signInStaff(staff.phone, staff.userId);
    await api().get(`${P}/admin/users`).set(h.bearer(again)).expect(200);
    expect(await models.AuditLog.count({ where: { action: ['staff.permission_granted', 'staff.permission_revoked'] } })).toBe(2);
  });

  it('keeps non-staff out of /admin', async () => {
    const member = await h.signupUser();
    const r = await api().get(`${P}/admin/users`).set(h.bearer(member)).expect(403);
    expect(r.body.code).toBe('PERMISSION_REQUIRED');
  });

  it('lets only masters see the staff list', async () => {
    const { staff, master } = await setupStaff(['manage_users']);
    await api().get(`${P}/admin/staff`).set(h.bearer(staff)).expect(403);
    const list = await api().get(`${P}/admin/staff`).set(h.bearer(master)).expect(200);
    expect(list.body.locked).toEqual(['edit_fees', 'manage_staff']);
    expect(list.body.data).toHaveLength(2);
  });
});

describe('user management', () => {
  async function adminAndTarget() {
    const master = await h.createSignedInMaster();
    const target = await h.signupUser({ name: 'Mallory', password: 'Correct-Horse-91' });
    return { master, target };
  }

  it('searches with masked identifiers and audits the query', async () => {
    const { master, target } = await adminAndTarget();
    const r = await api().get(`${P}/admin/users?q=Mallory`).set(h.bearer(master)).expect(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].phone).toMatch(/•••/);
    expect(r.body.data[0].phone).not.toBe(h.e164(target.phone));
    expect(await models.AuditLog.count({ where: { action: 'user.searched' } })).toBe(1);
  });

  it('suspends (revoking sessions), blocks sign-in, then restores', async () => {
    const { master, target } = await adminAndTarget();
    const s = await api()
      .post(`${P}/admin/users/${target.user.id}/suspend`)
      .set(h.bearer(master))
      .send({ reasonCode: 'abuse', note: 'Abusive messages to ground owners', until: new Date(Date.now() + 7 * 864e5).toISOString() })
      .expect(200);
    expect(s.body.status).toBe('suspended');

    await api().get(`${P}/me`).set(h.bearer(target)).expect(401);
    const login = await api().post(`${P}/auth/login`).send({ identifier: target.phone, password: 'Correct-Horse-91' }).expect(403);
    expect(login.body.code).toBe('ACCOUNT_SUSPENDED');

    await api().post(`${P}/admin/users/${target.user.id}/restore`).set(h.bearer(master)).send({ note: 'Appeal accepted' }).expect(200);
    await api().post(`${P}/auth/login`).send({ identifier: target.phone, password: 'Correct-Horse-91' }).expect(200);
  });

  it('requires step-up to ban, and only a master can unban', async () => {
    const { master, target } = await adminAndTarget();
    await api().post(`${P}/admin/users/${target.user.id}/ban`).set(h.bearer(master)).send({ reasonCode: 'fraud', note: 'Fake NID documents' }).expect(403);
    const token = await h.stepUp(master, 'user.ban');
    await api().post(`${P}/admin/users/${target.user.id}/ban`).set(h.bearer(master)).set('X-Step-Up', token).send({ reasonCode: 'fraud', note: 'Fake NID documents' }).expect(200);

    const restore = await api().post(`${P}/admin/users/${target.user.id}/restore`).set(h.bearer(master)).send({}).expect(403);
    expect(restore.body.code).toBe('MASTER_REQUIRED');
  });

  it('lifts expired suspensions automatically', async () => {
    const { master, target } = await adminAndTarget();
    await api()
      .post(`${P}/admin/users/${target.user.id}/suspend`)
      .set(h.bearer(master))
      .send({ reasonCode: 'policy_breach', note: 'Short cooling-off period', until: new Date(Date.now() + 60_000).toISOString() })
      .expect(200);
    await models.UserSanction.update({ endsAt: new Date(Date.now() - 1000) }, { where: { userId: target.user.id } });
    const { liftExpiredSuspensions } = require('../../src/modules/admin/admin-users.service');
    expect(await liftExpiredSuspensions()).toBe(1);
    expect((await models.User.findByPk(target.user.id)).status).toBe('active');
  });

  it('activates roles only after member verification', async () => {
    const { master, target } = await adminAndTarget();
    await api().post(`${P}/me/roles`).set(h.bearer(target)).send({ role: 'ground_owner' }).expect(201);

    const early = await api().post(`${P}/admin/users/${target.user.id}/roles/ground_owner/status`).set(h.bearer(master)).send({ status: 'active' }).expect(409);
    expect(early.body.code).toBe('MEMBER_NOT_ACTIVE');

    await api().post(`${P}/admin/users/${target.user.id}/roles/member/status`).set(h.bearer(master)).send({ status: 'active' }).expect(200);
    await api().post(`${P}/admin/users/${target.user.id}/roles/ground_owner/status`).set(h.bearer(master)).send({ status: 'active' }).expect(200);
    expect((await models.User.findByPk(target.user.id)).kycStatus).toBe('verified');
  });

  it('protects staff accounts from non-master staff', async () => {
    const master = await h.createSignedInMaster();
    const a = await h.signupUser({ name: 'Support A' });
    const token = await h.stepUp(master, 'staff.write');
    await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', token).send({ userId: a.user.id, employeeId: 'KG-0401', permissions: ['manage_users'] }).expect(201);
    const staffA = await h.signInStaff(a.phone, a.user.id);
    const r = await api().post(`${P}/admin/users/${master.user.id}/suspend`).set(h.bearer(staffA)).send({ reasonCode: 'other', note: 'Testing guard rails' }).expect(403);
    expect(r.body.code).toBe('MASTER_REQUIRED');
  });
});
