'use strict';

// ADR-004 cross-subdomain auth: CORS allowlist, cookies, CSRF, SSO and separate admin sessions.
const h = require('../helpers');
const { api, P, models } = h;

beforeEach(h.resetDb);
afterAll(() => models.sequelize.close());

const setCookieLine = (res, name) => (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));

describe('CORS allowlist', () => {
  it.each([
    ['http://localhost:3000', true],
    ['http://localhost:3002', true], // admin origin
    ['http://esports.kriraghor.localhost', true], // one-label wildcard
    ['http://a.b.kriraghor.localhost', false], // two labels never match
    ['http://kriraghor.localhost.evil.com', false],
    ['https://evil.example', false],
  ])('origin %s allowed=%s', async (origin, allowed) => {
    const r = await api().options(`${P}/auth/refresh`).set('Origin', origin).set('Access-Control-Request-Method', 'POST');
    if (allowed) {
      expect(r.headers['access-control-allow-origin']).toBe(origin);
      expect(r.headers['access-control-allow-credentials']).toBe('true');
      expect(r.headers['access-control-allow-headers']).toMatch(/X-CSRF-Token/i);
      expect(r.headers['access-control-max-age']).toBe('600');
    } else {
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
});

describe('customer cookies and CSRF', () => {
  it('sets the refresh, hint and CSRF cookies with the ADR-004 flags', async () => {
    const s = await h.signupUser();
    const res = await h.refreshWeb(s.cookie).expect(200);
    expect(setCookieLine(res, 'kg_rt')).toMatch(/HttpOnly/i);
    expect(setCookieLine(res, 'kg_rt')).toMatch(/SameSite=Lax/i);
    expect(setCookieLine(res, 'kg_rt')).toMatch(/Path=\/api\/v1\/auth/i);
    expect(setCookieLine(res, 'kg_si')).not.toMatch(/HttpOnly/i);
    expect(setCookieLine(res, 'kg_si')).toMatch(/^kg_si=1;/);
    expect(setCookieLine(res, 'kg_csrf')).not.toMatch(/HttpOnly/i);
  });

  it('rejects a refresh without the CSRF header, or from an unknown origin', async () => {
    const s = await h.signupUser();
    const noHeader = await api().post(`${P}/auth/refresh`).set('Origin', h.WEB_ORIGIN).set('Cookie', h.cookieHeader(s.cookie)).expect(403);
    expect(noHeader.body.code).toBe('CSRF_TOKEN_INVALID');

    const badOrigin = await h.refreshWeb(s.cookie, { origin: 'https://evil.example' }).expect(403);
    expect(badOrigin.body.code).toBe('CSRF_ORIGIN_REJECTED');

    const noOrigin = await api().post(`${P}/auth/refresh`).set('Cookie', h.cookieHeader(s.cookie)).set('X-CSRF-Token', h.cookieValue(s.cookie, 'kg_csrf')).expect(403);
    expect(noOrigin.body.code).toBe('CSRF_ORIGIN_REJECTED');
  });

  it('rejects a CSRF token minted for another session', async () => {
    const a = await h.signupUser();
    const b = await h.signupUser();
    const forged = await api()
      .post(`${P}/auth/refresh`)
      .set('Origin', h.WEB_ORIGIN)
      .set('Cookie', `${h.cookieHeader(a.cookie).replace(/kg_csrf=[^;]+/, `kg_csrf=${encodeURIComponent(h.cookieValue(b.cookie, 'kg_csrf'))}`)}`)
      .set('X-CSRF-Token', h.cookieValue(b.cookie, 'kg_csrf'))
      .expect(403);
    expect(forged.body.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('keeps one session across kriraghor.com and esports (SSO through the shared API host)', async () => {
    const s = await h.signupUser();
    const web = await h.refreshWeb(s.cookie, { origin: 'http://localhost:3000' }).expect(200);
    const esports = await h.refreshWeb(web.headers['set-cookie'], { origin: 'http://esports.kriraghor.localhost' }).expect(200);
    const me = await api().get(`${P}/me`).set('Authorization', `Bearer ${esports.body.accessToken}`).expect(200);
    expect(me.body.id).toBe(s.user.id);
  });

  it('lets mobile refresh with a body token and no cookies or CSRF header', async () => {
    const phone = h.nextPhone();
    await api().post(`${P}/auth/otp/send`).send({ target: phone, purpose: 'signup' }).expect(202);
    const v = await api().post(`${P}/auth/otp/verify`).send({ target: phone, purpose: 'signup', code: h.lastCode(phone) }).expect(200);
    const signup = await api().post(`${P}/auth/signup`).set('X-Client-Type', 'mobile').send({ signupToken: v.body.signupToken, displayName: 'Mobile Player' }).expect(201);
    expect(signup.headers['set-cookie']).toBeUndefined();
    const r = await api().post(`${P}/auth/refresh`).set('X-Client-Type', 'mobile').send({ refreshToken: signup.body.refreshToken }).expect(200);
    expect(r.body.refreshToken).toBeDefined();
    expect(r.body.refreshToken).not.toBe(signup.body.refreshToken);
  });
});

describe('separate admin sessions (Q33)', () => {
  it('refuses staff on every customer sign-in', async () => {
    const master = await h.createSignedInMaster();
    await h.allowResend(master.phone);
    await api().post(`${P}/auth/otp/send`).send({ target: master.phone, purpose: 'login' }).expect(202);
    const otp = await api().post(`${P}/auth/otp/verify`).send({ target: master.phone, purpose: 'login', code: h.lastCode(master.phone) }).expect(403);
    expect(otp.body.code).toBe('STAFF_USE_ADMIN_PORTAL');
  });

  it('refuses non-staff on the admin sign-in', async () => {
    const member = await h.signupUser({ password: 'Member-Pass-42' });
    const r = await h.adminPost('/auth/admin/login').send({ identifier: member.phone, password: 'Member-Pass-42' }).expect(403);
    expect(r.body.code).toBe('NOT_STAFF');
  });

  it('only accepts admin sign-in from the admin portal origin', async () => {
    const r = await api().post(`${P}/auth/admin/login`).set('Origin', h.WEB_ORIGIN).send({ identifier: 'someone', password: 'x' }).expect(403);
    expect(r.body.code).toBe('CSRF_ORIGIN_REJECTED');
  });

  it('issues admin cookies that only the admin refresh accepts', async () => {
    const master = await h.createSignedInMaster();
    expect(setCookieLine({ headers: { 'set-cookie': master.cookie } }, 'kg_art')).toMatch(/SameSite=Strict/i);
    expect(h.cookieValue(master.cookie, 'kg_rt')).toBeUndefined();

    const admin = await h.refreshWeb(master.cookie, { admin: true }).expect(200);
    await api().get(`${P}/admin/me`).set('Authorization', `Bearer ${admin.body.accessToken}`).expect(200);

    // The customer refresh does not see an admin cookie at all.
    await h.refreshWeb(master.cookie).expect(403); // no kg_csrf cookie, so CSRF fails first
  });

  it('never lets an admin cookie refresh a customer session, or the reverse', async () => {
    const member = await h.signupUser();
    // Rename the customer cookies to the admin names and try the admin refresh.
    const forged = member.cookie.map((c) => c.replace(/^kg_rt=/, 'kg_art=').replace(/^kg_csrf=/, 'kg_acsrf='));
    const r = await h.refreshWeb(forged, { admin: true }).expect(403);
    expect(['CSRF_TOKEN_INVALID', 'SESSION_REVOKED']).toContain(r.body.code);
    // The customer session is untouched.
    await h.refreshWeb(member.cookie).expect(200);
  });

  it('drops the customer session of a member who becomes staff', async () => {
    const master = await h.createSignedInMaster();
    const member = await h.signupUser({ name: 'Rafiq Hasan' });
    const token = await h.stepUp(master, 'staff.write');
    await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', token).send({ userId: member.user.id, employeeId: 'KG-0401' }).expect(201);
    // Becoming staff revokes every existing session (permission_change); the member signs in at the admin portal.
    const r = await h.refreshWeb(member.cookie).expect(401);
    expect(r.body.code).toBe('SESSION_REVOKED');
    const otp = await (async () => {
      await h.allowResend(member.phone);
      await api().post(`${P}/auth/otp/send`).send({ target: member.phone, purpose: 'login' }).expect(202);
      return api().post(`${P}/auth/otp/verify`).send({ target: member.phone, purpose: 'login', code: h.lastCode(member.phone) });
    })();
    expect(otp.status).toBe(403);
    expect(otp.body.code).toBe('STAFF_USE_ADMIN_PORTAL');
  });

  it('accepts the esports.money step-up scope (Q128)', async () => {
    const master = await h.createSignedInMaster();
    const token = await h.stepUp(master, 'esports.money');
    expect(token).toEqual(expect.any(String));
  });

  it('signs out of the admin portal and clears the admin cookies', async () => {
    const master = await h.createSignedInMaster();
    const r = await h.adminPost('/auth/admin/logout').set(h.bearer(master)).expect(204);
    expect(setCookieLine(r, 'kg_art')).toMatch(/kg_art=;/);
    expect(setCookieLine(r, 'kg_asi')).toMatch(/kg_asi=;/);
    await api().get(`${P}/admin/me`).set(h.bearer(master)).expect(401);
  });
});
