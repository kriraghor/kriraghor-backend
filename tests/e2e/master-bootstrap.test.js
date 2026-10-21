'use strict';

/**
 * M01-FR-12, M01-FR-40: the first master admin, by CLI or BOOTSTRAP_MASTER, from an account that
 * already exists with a verified phone or email. A demo master (no way to sign in) does not block it;
 * a master who can sign in does.
 */
const h = require('../helpers');
const { api, P, models } = h;
const { masterBootstrap } = require('../../src/modules/admin');

beforeEach(h.resetDb);
afterAll(() => models.sequelize.close());

/** What the demo seeder makes: a master with no phone, email, password or Google. */
async function demoMaster() {
  const user = await models.User.create({ displayName: 'Kriraghor Events', username: 'kriraghor.events' });
  for (const role of ['member', 'staff', 'master_admin']) await models.UserRole.create({ userId: user.id, role, status: 'active', activatedAt: new Date() });
  await models.StaffMember.create({ userId: user.id, employeeId: 'KG-0001', team: 'Events', isMaster: true });
  return user;
}

const roles = async (userId) => (await models.UserRole.findAll({ where: { userId, status: 'active' } })).map((r) => r.role).sort();

describe('first master admin (M01-FR-40)', () => {
  it('promotes a signed-up account by phone even when the demo master exists, and it signs in to the admin portal', async () => {
    await demoMaster();
    const member = await h.signupUser({ name: 'Badhon' });

    const result = await masterBootstrap.bootstrapMaster({ identifier: member.phone });
    expect(result).toMatchObject({ created: true, userId: member.user.id });
    expect(result.target).not.toContain(member.phone.slice(-6)); // masked
    expect(await roles(member.user.id)).toEqual(['master_admin', 'member', 'staff']);
    const staff = await models.StaffMember.findOne({ where: { userId: member.user.id } });
    expect(staff).toMatchObject({ isMaster: true, status: 'invited' });
    expect(staff.employeeId).not.toBe('KG-0001'); // the demo master holds the default id

    const audit = await models.AuditLog.findOne({ where: { action: 'staff.master_bootstrapped', entityId: member.user.id } });
    expect(audit).not.toBeNull();

    // Code, then the two-factor enrolment: the normal staff sign-in.
    const signedIn = await h.signInStaff(member.phone, member.user.id);
    expect(signedIn.user.isMaster).toBe(true);
    await api().get(`${P}/admin/me`).set(h.bearer(signedIn)).expect(200);
  });

  it('works with a verified email, and that email signs in with a code', async () => {
    const user = await models.User.create({ email: 'owner@kriraghor.test', emailVerifiedAt: new Date(), displayName: 'Owner' });
    await models.UserRole.create({ userId: user.id, role: 'member', status: 'applied' });

    expect(await masterBootstrap.bootstrapMaster({ identifier: ' Owner@Kriraghor.test ' })).toMatchObject({ created: true });

    await api().post(`${P}/auth/otp/send`).send({ target: 'owner@kriraghor.test', purpose: 'login' }).expect(202);
    const v = await h.adminPost('/auth/admin/login').send({ target: 'owner@kriraghor.test', code: h.lastEmailCode('owner@kriraghor.test') }).expect(200);
    expect(v.body.status).toBe('two_factor_setup_required');
  });

  it('refuses once a master who can sign in exists, so the variable cannot make a second one', async () => {
    await h.createSignedInMaster();
    const other = await h.signupUser({ name: 'Someone' });
    expect(await masterBootstrap.bootstrapMaster({ identifier: other.phone })).toMatchObject({ created: false, reason: 'MASTER_EXISTS' });
    expect(await roles(other.user.id)).not.toContain('master_admin');
  });

  it('runs once: the second start does nothing', async () => {
    const member = await h.signupUser();
    expect((await masterBootstrap.bootstrapMaster({ identifier: member.phone })).created).toBe(true);
    // The new master can sign in (verified phone), so a restart with the variable still set is a no-op.
    expect(await masterBootstrap.bootstrapMaster({ identifier: member.phone })).toMatchObject({ created: false, reason: 'MASTER_EXISTS' });
    expect(await models.StaffMember.count({ where: { isMaster: true } })).toBe(1);
  });

  it('refuses unknown, unverified, inactive and malformed identifiers', async () => {
    expect(await masterBootstrap.bootstrapMaster({ identifier: '01799999999' })).toMatchObject({ created: false, reason: 'ACCOUNT_NOT_FOUND' });

    await models.User.create({ email: 'unverified@kriraghor.test', displayName: 'U' });
    expect(await masterBootstrap.bootstrapMaster({ identifier: 'unverified@kriraghor.test' })).toMatchObject({ created: false, reason: 'ACCOUNT_NOT_FOUND' });

    await models.User.create({ email: 'banned@kriraghor.test', emailVerifiedAt: new Date(), displayName: 'B', status: 'banned' });
    expect(await masterBootstrap.bootstrapMaster({ identifier: 'banned@kriraghor.test' })).toMatchObject({ created: false, reason: 'ACCOUNT_NOT_ACTIVE' });

    expect(await masterBootstrap.bootstrapMaster({ identifier: 'not an identifier' })).toMatchObject({ created: false, reason: 'IDENTIFIER_INVALID' });
    expect(await models.StaffMember.count()).toBe(0);
  });
});
