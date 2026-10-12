'use strict';

const h = require('../helpers');
const google = require('../../src/providers/google');
const { api, P, models } = h;

// A syntactically plausible ID token; verification itself is stubbed per test.
const ID_TOKEN = `eyJhbGciOiJSUzI1NiJ9.${'x'.repeat(120)}.sig`;

function mockGoogle(profile) {
  return jest.spyOn(google, 'verifyIdToken').mockResolvedValue({
    subject: 'google-sub-1',
    email: 'fahim@gmail.com',
    emailVerified: true,
    name: 'Fahim Rahman',
    picture: 'https://lh3.googleusercontent.com/a/photo',
    locale: 'en',
    ...profile,
  });
}

beforeEach(h.resetDb);
afterEach(() => jest.restoreAllMocks());
afterAll(() => models.sequelize.close());

describe('email OTP', () => {
  it('signs up with an emailed code', async () => {
    await api().post(`${P}/auth/otp/send`).send({ target: 'Nusrat.Jahan@Example.com', purpose: 'signup' }).expect(202);
    const msg = h.mail.lastTo('nusrat.jahan@example.com');
    expect(msg.subject).toBe('Your Kriraghor code');
    expect(msg.html).toContain(h.lastEmailCode('nusrat.jahan@example.com'));

    const v = await api().post(`${P}/auth/otp/verify`).send({ target: 'nusrat.jahan@example.com', purpose: 'signup', code: h.lastEmailCode('nusrat.jahan@example.com') }).expect(200);
    const s = await api().post(`${P}/auth/signup`).send({ signupToken: v.body.signupToken, displayName: 'Nusrat Jahan' }).expect(201);
    expect(s.body.user).toMatchObject({ email: 'nusrat.jahan@example.com', emailVerified: true, phone: null });
    expect(s.body.user.signInMethods).toMatchObject({ emailOtp: true, phoneOtp: false });
  });

  it('adds a verified email to a phone account, which can then sign in by email', async () => {
    const s = await h.signupUser();
    await api().post(`${P}/me/email`).set(h.bearer(s)).send({ email: 'shahana@example.com' }).expect(202);
    await api().post(`${P}/me/email/verify`).set(h.bearer(s)).send({ email: 'shahana@example.com', code: h.lastEmailCode('shahana@example.com') }).expect(200);

    await api().post(`${P}/auth/otp/send`).send({ target: 'shahana@example.com', purpose: 'login' }).expect(202);
    const login = await api().post(`${P}/auth/otp/verify`).send({ target: 'shahana@example.com', purpose: 'login', code: h.lastEmailCode('shahana@example.com') }).expect(200);
    expect(login.body.status).toBe('signed_in');
    expect(login.body.user.id).toBe(s.user.id);
  });

  it('refuses an email that belongs to someone else', async () => {
    const a = await h.signupUser();
    const b = await h.signupUser();
    await api().post(`${P}/me/email`).set(h.bearer(a)).send({ email: 'taken@example.com' }).expect(202);
    await api().post(`${P}/me/email/verify`).set(h.bearer(a)).send({ email: 'taken@example.com', code: h.lastEmailCode('taken@example.com') }).expect(200);
    const r = await api().post(`${P}/me/email`).set(h.bearer(b)).send({ email: 'taken@example.com' }).expect(409);
    expect(r.body.code).toBe('EMAIL_IN_USE');
  });
});

describe('username', () => {
  it('signs up with a username and signs in with username + password', async () => {
    const s = await h.signupUser({ password: 'Turf-Booking-2026', username: 'Tanvir_Ahmed' });
    expect(s.user.username).toBe('tanvir_ahmed');
    const r = await api().post(`${P}/auth/login`).send({ identifier: '@Tanvir_Ahmed', password: 'Turf-Booking-2026' }).expect(200);
    expect(r.body.user.id).toBe(s.user.id);
  });

  it('checks availability and blocks taken or reserved names', async () => {
    const s = await h.signupUser();
    await api().put(`${P}/me/username`).set(h.bearer(s)).send({ username: 'mirpur.turf' }).expect(200);

    const avail = await api().get(`${P}/auth/username-available?username=Mirpur.Turf`).expect(200);
    expect(avail.body).toEqual({ username: 'mirpur.turf', available: false });

    const other = await h.signupUser();
    const taken = await api().put(`${P}/me/username`).set(h.bearer(other)).send({ username: 'mirpur.turf' }).expect(409);
    expect(taken.body.code).toBe('USERNAME_TAKEN');
    await api().put(`${P}/me/username`).set(h.bearer(other)).send({ username: 'admin' }).expect(422);
    await api().put(`${P}/me/username`).set(h.bearer(other)).send({ username: '9lives' }).expect(422);
  });
});

describe('Sign in with Google', () => {
  it('creates a new account through the signup step, then signs straight in next time', async () => {
    mockGoogle();
    const first = await api().post(`${P}/auth/google`).send({ idToken: ID_TOKEN }).expect(200);
    expect(first.body).toMatchObject({ status: 'signup', suggested: { displayName: 'Fahim Rahman', email: 'fahim@gmail.com', needsUsername: false } });

    const s = await api().post(`${P}/auth/signup`).send({ signupToken: first.body.signupToken, displayName: 'Fahim Rahman', role: 'player' }).expect(201);
    expect(s.body.user).toMatchObject({ email: 'fahim@gmail.com', emailVerified: true });
    expect(s.body.user.signInMethods.google).toBe(true);

    const again = await api().post(`${P}/auth/google`).send({ idToken: ID_TOKEN }).expect(200);
    expect(again.body.status).toBe('signed_in');
    expect(again.body.user.id).toBe(s.body.user.id);
  });

  it('links to an existing account with the same verified email', async () => {
    await api().post(`${P}/auth/otp/send`).send({ target: 'fahim@gmail.com', purpose: 'signup' }).expect(202);
    const v = await api().post(`${P}/auth/otp/verify`).send({ target: 'fahim@gmail.com', purpose: 'signup', code: h.lastEmailCode('fahim@gmail.com') });
    const s = await api().post(`${P}/auth/signup`).send({ signupToken: v.body.signupToken, displayName: 'Fahim' }).expect(201);

    mockGoogle();
    const g = await api().post(`${P}/auth/google`).send({ idToken: ID_TOKEN }).expect(200);
    expect(g.body.status).toBe('signed_in');
    expect(g.body.user.id).toBe(s.body.user.id);
    expect(await models.AuditLog.count({ where: { action: 'user.identity_linked' } })).toBe(1);
  });

  it('refuses to auto-link when the existing email is not verified (takeover protection)', async () => {
    await models.User.create({ email: 'fahim@gmail.com', displayName: 'Someone' });
    mockGoogle();
    const r = await api().post(`${P}/auth/google`).send({ idToken: ID_TOKEN }).expect(409);
    expect(r.body.code).toBe('ACCOUNT_EXISTS_UNVERIFIED');
  });

  it('requires a username when Google gives no verified email', async () => {
    mockGoogle({ subject: 'google-sub-2', email: null, emailVerified: false });
    const g = await api().post(`${P}/auth/google`).send({ idToken: ID_TOKEN }).expect(200);
    expect(g.body.suggested.needsUsername).toBe(true);
    await api().post(`${P}/auth/signup`).send({ signupToken: g.body.signupToken, displayName: 'No Email' }).expect(422);
    const s = await api().post(`${P}/auth/signup`).send({ signupToken: g.body.signupToken, displayName: 'No Email', username: 'no_email_player' }).expect(201);
    expect(s.body.user).toMatchObject({ username: 'no_email_player', email: null, phone: null });
  });

  it('still requires two-factor for staff', async () => {
    const master = await h.createSignedInMaster();
    await models.User.update({ email: 'ayesha@kriraghor.com', emailVerifiedAt: new Date() }, { where: { id: master.userId } });
    mockGoogle({ subject: 'google-master', email: 'ayesha@kriraghor.com' });
    const r = await api().post(`${P}/auth/google`).send({ idToken: ID_TOKEN }).expect(200);
    expect(r.body.status).toBe('two_factor_required');
    expect(r.body.accessToken).toBeUndefined();
  });

  it('connects and disconnects Google from settings, keeping one sign-in method', async () => {
    const s = await h.signupUser();
    mockGoogle({ subject: 'google-sub-3', email: 'linked@gmail.com' });
    await api().post(`${P}/me/identities/google`).set(h.bearer(s)).send({ idToken: ID_TOKEN }).expect(201);
    const me = await api().get(`${P}/me`).set(h.bearer(s)).expect(200);
    expect(me.body).toMatchObject({ email: 'linked@gmail.com', emailVerified: true });
    expect(me.body.signInMethods.google).toBe(true);

    const other = await h.signupUser();
    const clash = await api().post(`${P}/me/identities/google`).set(h.bearer(other)).send({ idToken: ID_TOKEN }).expect(409);
    expect(clash.body.code).toBe('GOOGLE_ALREADY_LINKED');

    await api().delete(`${P}/me/identities/google`).set(h.bearer(s)).expect(204);
  });

  it('will not remove Google when it is the only way to sign in', async () => {
    mockGoogle({ subject: 'google-sub-4', email: null, emailVerified: false });
    const g = await api().post(`${P}/auth/google`).send({ idToken: ID_TOKEN });
    const s = await api().post(`${P}/auth/signup`).send({ signupToken: g.body.signupToken, displayName: 'Only Google', username: 'only_google' }).expect(201);
    const r = await api().delete(`${P}/me/identities/google`).set('Authorization', `Bearer ${s.body.accessToken}`).expect(409);
    expect(r.body.code).toBe('LAST_SIGN_IN_METHOD');
  });

  it('rejects an invalid Google token', async () => {
    jest.spyOn(google, 'verifyIdToken').mockRejectedValue(Object.assign(new (require('../../src/common/errors').AppError)(401, 'GOOGLE_TOKEN_INVALID', 'Google sign-in failed. Try again.')));
    const r = await api().post(`${P}/auth/google`).send({ idToken: ID_TOKEN }).expect(401);
    expect(r.body.code).toBe('GOOGLE_TOKEN_INVALID');
  });
});
