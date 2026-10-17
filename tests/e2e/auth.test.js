'use strict';

const h = require('../helpers');
const { api, P, models } = h;

beforeEach(h.resetDb);
afterAll(() => models.sequelize.close());

describe('OTP signup and sign-in', () => {
  it('signs up a new member through OTP and returns the profile', async () => {
    const s = await h.signupUser({ name: 'Fahim Rahman', role: 'ground_owner', roleMeta: { businessName: 'Mirpur Turf 10' } });
    expect(s.user.displayName).toBe('Fahim Rahman');
    expect(s.user.roles.map((r) => [r.role, r.status])).toEqual([
      ['ground_owner', 'applied'],
      ['member', 'applied'],
    ]);
    expect(s.cookie.join(';')).toMatch(/kg_rt=.+HttpOnly/i);

    const me = await api().get(`${P}/me`).set(h.bearer(s)).expect(200);
    expect(me.body.phone).toBe(h.e164(s.phone));
    expect(me.body).not.toHaveProperty('passwordHash');
  });

  it('does not reveal existing accounts: verifying a signup code for a known number signs in', async () => {
    const s = await h.signupUser();
    await h.allowResend(s.phone);
    await api().post(`${P}/auth/otp/send`).send({ target: s.phone, purpose: 'signup' }).expect(202);
    const res = await api().post(`${P}/auth/otp/verify`).send({ target: s.phone, purpose: 'signup', code: h.lastCode(s.phone) }).expect(200);
    expect(res.body.status).toBe('signed_in');
    expect(res.body.user.id).toBe(s.user.id);
  });

  it('rejects invalid Bangladeshi numbers', async () => {
    const res = await api().post(`${P}/auth/otp/send`).send({ target: '01212345678', purpose: 'signup' }).expect(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('enforces the resend cooldown', async () => {
    const phone = h.nextPhone();
    await api().post(`${P}/auth/otp/send`).send({ target: phone, purpose: 'signup' }).expect(202);
    const res = await api().post(`${P}/auth/otp/send`).send({ target: phone, purpose: 'signup' }).expect(429);
    expect(res.body.code).toBe('OTP_RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('burns the code after 5 wrong attempts', async () => {
    const phone = h.nextPhone();
    await api().post(`${P}/auth/otp/send`).send({ target: phone, purpose: 'signup' }).expect(202);
    const good = h.lastCode(phone);
    const bad = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      await api().post(`${P}/auth/otp/verify`).send({ target: phone, purpose: 'signup', code: bad }).expect(400);
    }
    const res = await api().post(`${P}/auth/otp/verify`).send({ target: phone, purpose: 'signup', code: good }).expect(400);
    expect(res.body.code).toBe('OTP_INVALID');
  });

  it('rejects a tampered signup token', async () => {
    const res = await api().post(`${P}/auth/signup`).send({ signupToken: 'x'.repeat(40), displayName: 'Mallory' }).expect(400);
    expect(res.body.code).toBe('SIGNUP_TOKEN_INVALID');
  });
});

describe('password sign-in', () => {
  it('signs in with a password and locks after 5 failures', async () => {
    const s = await h.signupUser({ password: 'Turf-Booking-2026' });
    await api().post(`${P}/auth/login`).send({ identifier: s.phone, password: 'Turf-Booking-2026' }).expect(200);

    for (let i = 0; i < 5; i += 1) {
      const r = await api().post(`${P}/auth/login`).send({ identifier: s.phone, password: 'wrong-password' }).expect(401);
      expect(r.body.code).toBe('INVALID_CREDENTIALS');
    }
    const locked = await api().post(`${P}/auth/login`).send({ identifier: s.phone, password: 'Turf-Booking-2026' }).expect(429);
    expect(locked.body.code).toBe('AUTH_LOCKED');
  });

  it('gives the same answer for unknown accounts', async () => {
    const r = await api().post(`${P}/auth/login`).send({ identifier: h.nextPhone(), password: 'whatever-123' }).expect(401);
    expect(r.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects weak passwords at signup', async () => {
    const phone = h.nextPhone();
    await api().post(`${P}/auth/otp/send`).send({ target: phone, purpose: 'signup' }).expect(202);
    const v = await api().post(`${P}/auth/otp/verify`).send({ target: phone, purpose: 'signup', code: h.lastCode(phone) });
    const r = await api().post(`${P}/auth/signup`).send({ signupToken: v.body.signupToken, displayName: 'Weak', password: 'password123' }).expect(400);
    expect(r.body.code).toBe('PASSWORD_WEAK');
  });

  it('resets the password with an OTP and signs out every session', async () => {
    const s = await h.signupUser({ password: 'Old-Password-99' });
    await api().post(`${P}/auth/otp/send`).send({ target: s.phone, purpose: 'reset' }).expect(202);
    await api().post(`${P}/auth/password/reset`).send({ target: s.phone, code: h.lastCode(s.phone), newPassword: 'New-Password-77' }).expect(200);

    const r = await api().get(`${P}/me`).set(h.bearer(s)).expect(401);
    expect(r.body.code).toBe('SESSION_REVOKED');
    await api().post(`${P}/auth/login`).send({ identifier: s.phone, password: 'New-Password-77' }).expect(200);
  });
});

describe('sessions and refresh rotation', () => {
  const refreshCookie = (cookies) => cookies.find((c) => c.startsWith('kg_rt=')).split(';')[0];

  it('rotates the refresh token and detects reuse', async () => {
    const s = await h.signupUser();
    const first = refreshCookie(s.cookie);

    const r1 = await h.refreshWeb(s.cookie).expect(200);
    const second = refreshCookie(r1.headers['set-cookie']);
    expect(second).not.toBe(first);
    await api().get(`${P}/me`).set('Authorization', `Bearer ${r1.body.accessToken}`).expect(200);

    // Replaying the old token revokes the whole family, including the new session.
    const replay = await h.refreshWeb(s.cookie).expect(401);
    expect(replay.body.code).toBe('SESSION_REVOKED');
    await h.refreshWeb(r1.headers['set-cookie']).expect(401);
    await api().get(`${P}/me`).set('Authorization', `Bearer ${r1.body.accessToken}`).expect(401);
    expect(await models.AuditLog.count({ where: { action: 'session.reuse_detected' } })).toBe(1);
  });

  it('returns the refresh token in the body only for mobile clients', async () => {
    const s = await h.signupUser();
    const web = await h.refreshWeb(s.cookie).expect(200);
    expect(web.body.refreshToken).toBeUndefined();
    const mobile = await api().post(`${P}/auth/refresh`).set('X-Client-Type', 'mobile').send({ refreshToken: refreshCookie(web.headers['set-cookie']).slice(6) }).expect(200);
    expect(mobile.body.refreshToken).toBeDefined();
  });

  it('logs out and lists/revokes other sessions', async () => {
    const a = await h.signupUser({ password: 'Session-Test-55' });
    const b = await api().post(`${P}/auth/login`).send({ identifier: a.phone, password: 'Session-Test-55' }).expect(200);

    const list = await api().get(`${P}/me/sessions`).set(h.bearer(a)).expect(200);
    expect(list.body.data).toHaveLength(2);
    const other = list.body.data.find((x) => !x.current);
    await api().delete(`${P}/me/sessions/${other.id}`).set(h.bearer(a)).expect(204);
    await api().get(`${P}/me`).set('Authorization', `Bearer ${b.body.accessToken}`).expect(401);

    await api().post(`${P}/auth/logout`).set(h.bearer(a)).expect(204);
    await api().get(`${P}/me`).set(h.bearer(a)).expect(401);
  });

  it('rejects requests without a token', async () => {
    const r = await api().get(`${P}/me`).expect(401);
    expect(r.body.code).toBe('AUTH_REQUIRED');
    expect(r.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});

describe('roles and the gate', () => {
  it('applies for a role, which makes older access tokens stale', async () => {
    const s = await h.signupUser();
    await api().post(`${P}/me/roles`).set(h.bearer(s)).send({ role: 'shop_owner', meta: { shopName: 'Elephant Road Sports' } }).expect(201);

    const stale = await api().get(`${P}/me`).set(h.bearer(s)).expect(401);
    expect(stale.body.code).toBe('AUTHZ_STALE');

    const refreshed = await h.refreshWeb(s.cookie).expect(200);
    const me = await api().get(`${P}/me`).set('Authorization', `Bearer ${refreshed.body.accessToken}`).expect(200);
    expect(me.body.roles.find((r) => r.role === 'shop_owner').status).toBe('applied');

    await api().post(`${P}/me/roles`).set('Authorization', `Bearer ${refreshed.body.accessToken}`).send({ role: 'shop_owner' }).expect(409);
  });

  it('cannot self-apply for staff roles', async () => {
    const s = await h.signupUser();
    await api().post(`${P}/me/roles`).set(h.bearer(s)).send({ role: 'master_admin' }).expect(422);
  });

  it('previews the gate before and after NID verification', async () => {
    const s = await h.signupUser();
    const before = await api().get(`${P}/me/gate?action=hire`).set(h.bearer(s)).expect(200);
    expect(before.body).toMatchObject({ allowed: false, code: 'KYC_REQUIRED', next: '/account/verification' });

    await h.verifyMember(s.user.id);
    const login = await h.refreshWeb(s.cookie).expect(200);
    const after = await api().get(`${P}/me/gate?action=hire`).set('Authorization', `Bearer ${login.body.accessToken}`).expect(200);
    expect(after.body.allowed).toBe(true);
  });

  it('updates the profile and audits it', async () => {
    const s = await h.signupUser();
    const r = await api().patch(`${P}/me`).set(h.bearer(s)).send({ displayName: 'Tanvir Ahmed', locale: 'bn' }).expect(200);
    expect(r.body).toMatchObject({ displayName: 'Tanvir Ahmed', locale: 'bn' });
    expect(await models.AuditLog.count({ where: { action: 'user.profile_updated', actorId: s.user.id } })).toBe(1);
  });
});
