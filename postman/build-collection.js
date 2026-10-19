'use strict';

/**
 * Builds postman/kriraghor-auth.postman_collection.json (M01 + ADR-004).
 *   node postman/build-collection.js
 * Folder "0. Smoke" needs no OTP or authenticator codes, so CI and the Postman CLI can run it:
 *   postman collection run postman/kriraghor-auth.postman_collection.json -i "0. Smoke (no codes needed)"
 */
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'kriraghor-auth.postman_collection.json');
const json = (o) => ({ mode: 'raw', raw: JSON.stringify(o, null, 2), options: { raw: { language: 'json' } } });

/** Test script: assertions plus saving values from 2xx responses into collection variables (never throws). */
function tests({ save = {}, expect, cookies = {} } = {}) {
  const exec = [
    'let j = null; try { j = pm.response.json(); } catch (e) {}',
    "const get = (o, p) => p.split('.').filter(Boolean).reduce((a, k) => (a == null ? undefined : a[k]), o);",
    'const ok = pm.response.code >= 200 && pm.response.code < 300;',
  ];
  for (const [k, p] of Object.entries(save)) {
    exec.push(`if (ok && j) { const v = get(j, '${p}'); if (v !== undefined && v !== null && v !== '') pm.collectionVariables.set('${k}', v); }`);
  }
  // ADR-004: copy the readable CSRF cookie into a variable for the X-CSRF-Token header.
  for (const [k, cookie] of Object.entries(cookies)) {
    exec.push(`if (ok && pm.cookies.has('${cookie}')) pm.collectionVariables.set('${k}', pm.cookies.get('${cookie}'));`);
  }
  if (expect) {
    exec.push(`pm.test('status ${expect.status}${expect.code ? ` ${expect.code}` : ''}', () => {`);
    exec.push(`  pm.response.to.have.status(${expect.status});`);
    if (expect.code) exec.push(`  pm.expect(j && j.code).to.eql('${expect.code}');`);
    exec.push('});');
  }
  return { listen: 'test', script: { type: 'text/javascript', exec } };
}

function url(p, base = '{{baseUrl}}') {
  const [pathname, qs] = p.split('?');
  const u = { raw: `${base}${p}`, host: [base], path: pathname.split('/').filter(Boolean) };
  if (qs) u.query = qs.split('&').map((kv) => { const [key, value] = kv.split('='); return { key, value }; });
  return u;
}

/**
 * auth: 'user' (customer token), 'admin' (staff token) or false.
 * origin: 'web' | 'admin' sends Origin, which ADR-004 requires on admin auth and refresh endpoints.
 */
/** Unattended runs only: ask the runner's control server (run-m01.js) for a step before the request. */
const control = (item, step, setVar) => {
  const exec = [
    "const c = pm.variables.get('controlUrl');",
    'if (c) {',
    `  pm.sendRequest({ url: pm.variables.replaceIn(c + '/${step}'), method: 'POST' }, (err, res) => {`,
    ...(setVar ? [`    if (!err) pm.variables.set('${setVar}', res.json().code);`] : []),
    '  });',
    '}',
  ];
  item.event.unshift({ listen: 'prerequest', script: { type: 'text/javascript', exec } });
  return item;
};

/** An extra assertion on the response body (j is the parsed JSON). */
const check = (item, title, expr) => {
  item.event.push({ listen: 'test', script: { type: 'text/javascript', exec: ['let j = null; try { j = pm.response.json(); } catch (e) {}', `pm.test(${JSON.stringify(title)}, () => pm.expect(${expr}).to.eql(true));`] } });
  return item;
};

const req = (name, method, p, { body, auth = 'user', origin, csrf, stepUp = false, desc, save, cookies, expect, base, headers = [] } = {}) => ({
  name,
  event: [tests({ save, expect, cookies })],
  request: {
    method,
    header: [
      ...(body ? [{ key: 'Content-Type', value: 'application/json' }] : []),
      ...(auth === 'user' ? [{ key: 'Authorization', value: 'Bearer {{accessToken}}' }] : []),
      ...(auth === 'admin' ? [{ key: 'Authorization', value: 'Bearer {{adminAccessToken}}' }] : []),
      ...(origin ? [{ key: 'Origin', value: origin === 'admin' ? '{{adminOrigin}}' : '{{webOrigin}}' }] : []),
      ...(csrf ? [{ key: 'X-CSRF-Token', value: csrf === 'admin' ? '{{adminCsrfToken}}' : '{{csrfToken}}' }] : []),
      ...(stepUp ? [{ key: 'X-Step-Up', value: '{{stepUpToken}}' }] : []),
      ...headers,
    ],
    ...(body ? { body: json(body) } : {}),
    url: url(p, base),
    ...(desc ? { description: desc } : {}),
  },
});

const signedIn = { accessToken: 'accessToken', challengeToken: 'challengeToken', signupToken: 'signupToken' };
const csrfCookie = { csrfToken: 'kg_csrf' };
const adminSignedIn = { adminAccessToken: 'accessToken', challengeToken: 'challengeToken' };
const adminCsrfCookie = { adminCsrfToken: 'kg_acsrf' };

const collection = {
  info: {
    name: 'Kriraghor API: M01 Auth & RBAC',
    description: [
      'Start the stack: `docker compose up -d`, then `npm run dev` in kriraghor-backend.',
      'OTP codes print in the API console (SMS_DRIVER=console); email codes are in Mailpit at http://localhost:8025. Paste them into the `otp` variable, and authenticator codes into `totp`.',
      'Customer and staff sign-in are separate (ADR-004): staff use folder 3 (admin login with Origin = adminOrigin) and get `adminAccessToken`.',
      'Refresh needs the Origin header and X-CSRF-Token; both are filled from variables captured after sign-in. Postman keeps the httpOnly refresh cookies for you.',
      'Rebuild this file with: node postman/build-collection.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    ['apiRoot', 'http://localhost:4000'],
    ['baseUrl', 'http://localhost:4000/api/v1'],
    ['webOrigin', 'http://localhost:3000'],
    ['adminOrigin', 'http://localhost:3002'],
    ['phone', '01812345678'],
    ['email', 'fahim@example.com'],
    ['username', 'fahim_r'],
    ['googleIdToken', ''],
    ['masterPhone', '01711000001'],
    ['otp', ''],
    ['totp', ''],
    ['accessToken', ''],
    ['adminAccessToken', ''],
    ['csrfToken', ''],
    ['adminCsrfToken', ''],
    ['signupToken', ''],
    ['challengeToken', ''],
    ['stepUpToken', ''],
    ['targetUserId', ''],
  ].map(([key, value]) => ({ key, value })),
  item: [
    {
      name: '0. Smoke (no codes needed)',
      description: 'Runs unattended: contract, CORS and ADR-004 guards. Use it in CI with the Postman CLI.',
      item: [
        req('OpenAPI document', 'GET', '/api/docs/openapi.json', { auth: false, base: '{{apiRoot}}', expect: { status: 200 } }),
        req('Health', 'GET', '/health', { auth: false, base: '{{apiRoot}}', expect: { status: 200 } }),
        req('Username availability', 'GET', '/auth/username-available?username=postman_smoke', { auth: false, expect: { status: 200 } }),
        req('Refresh without CSRF token (expect 403)', 'POST', '/auth/refresh', { auth: false, origin: 'web', expect: { status: 403, code: 'CSRF_TOKEN_INVALID' } }),
        req('Refresh from an unknown origin (expect 403)', 'POST', '/auth/refresh', {
          auth: false,
          headers: [{ key: 'Origin', value: 'https://evil.example' }],
          expect: { status: 403, code: 'CSRF_ORIGIN_REJECTED' },
        }),
        req('Admin login from the customer origin (expect 403)', 'POST', '/auth/admin/login', {
          auth: false,
          origin: 'web',
          body: { identifier: '{{masterPhone}}', password: 'wrong-password' },
          expect: { status: 403, code: 'CSRF_ORIGIN_REJECTED' },
        }),
        req('Admin API without a token (expect 401)', 'GET', '/admin/me', { auth: false, expect: { status: 401, code: 'AUTH_REQUIRED' } }),
        req('Send OTP is non-enumerating (202)', 'POST', '/auth/otp/send', { auth: false, body: { target: '01999999999', purpose: 'login' }, expect: { status: 202 } }),
      ],
    },
    {
      name: '1. Member signup (OTP) and gate',
      item: [
        req('Send OTP', 'POST', '/auth/otp/send', { auth: false, body: { target: '{{phone}}', purpose: 'signup' }, desc: 'Copy the 6-digit code from the API console into the `otp` variable.' }),
        req('Verify OTP (gives signupToken)', 'POST', '/auth/otp/verify', { auth: false, body: { target: '{{phone}}', purpose: 'signup', code: '{{otp}}' }, save: signedIn, cookies: csrfCookie }),
        req('Sign up with a ground_owner application', 'POST', '/auth/signup', {
          auth: false,
          body: { signupToken: '{{signupToken}}', displayName: 'Fahim Rahman', password: 'Turf-Booking-2026', role: 'ground_owner', roleMeta: { businessName: 'Mirpur Turf 10' } },
          save: { ...signedIn, targetUserId: 'user.id' },
          cookies: csrfCookie,
          expect: { status: 201 },
        }),
        req('Me', 'GET', '/me', { expect: { status: 200 } }),
        req('Gate: book a ground (expect KYC_REQUIRED)', 'GET', '/me/gate?action=book_ground', { expect: { status: 200 } }),
        req('Gate: list a ground (expect KYC_REQUIRED)', 'GET', '/me/gate?action=list_ground', { expect: { status: 200 } }),
        req('RBAC: member token on /admin (expect 401 TOKEN_AUDIENCE_INVALID)', 'GET', '/admin/users', { auth: 'user', expect: { status: 401, code: 'TOKEN_AUDIENCE_INVALID' } }),
      ],
    },
    {
      name: '1b. Email OTP, username, Google',
      item: [
        req('Send OTP by EMAIL', 'POST', '/auth/otp/send', { auth: false, body: { target: '{{email}}', purpose: 'signup' }, desc: 'Open Mailpit at http://localhost:8025 to read the code, then put it in the otp variable.' }),
        req('Verify email OTP (signupToken or signed in)', 'POST', '/auth/otp/verify', { auth: false, body: { target: '{{email}}', purpose: 'signup', code: '{{otp}}' }, save: signedIn, cookies: csrfCookie }),
        req('Sign up with email + username + password', 'POST', '/auth/signup', { auth: false, body: { signupToken: '{{signupToken}}', displayName: 'Fahim Rahman', username: '{{username}}', password: 'Turf-Booking-2026' }, save: signedIn, cookies: csrfCookie }),
        req('Is a username available?', 'GET', '/auth/username-available?username={{username}}', { auth: false }),
        req('Login with USERNAME + password', 'POST', '/auth/login', { auth: false, body: { identifier: '{{username}}', password: 'Turf-Booking-2026' }, save: signedIn, cookies: csrfCookie }),
        req('Login with EMAIL + password', 'POST', '/auth/login', { auth: false, body: { identifier: '{{email}}', password: 'Turf-Booking-2026' }, save: signedIn, cookies: csrfCookie }),
        req('Change my username', 'PUT', '/me/username', { body: { username: 'fahim.rahman' } }),
        req('Add/change email: send code', 'POST', '/me/email', { body: { email: 'fahim.new@example.com' } }),
        req('Add/change email: confirm code', 'POST', '/me/email/verify', { body: { email: 'fahim.new@example.com', code: '{{otp}}' } }),
        req('Sign in with Google', 'POST', '/auth/google', {
          auth: false,
          body: { idToken: '{{googleIdToken}}' },
          save: signedIn,
          cookies: csrfCookie,
          desc: 'Needs GOOGLE_CLIENT_IDS in .env and a real Google ID token (the "credential" from the Google button on the frontend). Returns signed_in, or status signup + signupToken; then call Sign up with that token.',
        }),
        req('Connect Google to my account', 'POST', '/me/identities/google', { body: { idToken: '{{googleIdToken}}' } }),
        req('Disconnect Google', 'DELETE', '/me/identities/google'),
      ],
    },
    {
      name: '2. Password, sessions, refresh',
      item: [
        req('Login with password', 'POST', '/auth/login', { auth: false, body: { identifier: '{{phone}}', password: 'Turf-Booking-2026' }, save: signedIn, cookies: csrfCookie }),
        req('Refresh (rotates the cookie)', 'POST', '/auth/refresh', {
          auth: false,
          origin: 'web',
          csrf: 'user',
          save: { accessToken: 'accessToken' },
          cookies: csrfCookie,
          expect: { status: 200 },
          desc: 'ADR-004: Origin must be an allowed app origin and X-CSRF-Token must equal the kg_csrf cookie.',
        }),
        req('List my sessions', 'GET', '/me/sessions'),
        req('Apply for the organiser role', 'POST', '/me/roles', {
          body: { role: 'organiser', meta: { organisation: 'Dhaka Corporate Sports Forum' } },
          desc: 'Afterwards the old access token returns AUTHZ_STALE. Run Refresh to get a new one.',
        }),
        req('Update profile', 'PATCH', '/me', { body: { displayName: 'Fahim R.', locale: 'bn' } }),
        req('Logout (this device)', 'POST', '/auth/logout', { expect: { status: 204 } }),
      ],
    },
    {
      name: '2b. Forgot password and the security alert',
      description: 'kriraghor.com /sign-in/reset. Send a reset code, set a new password (every session is signed out), sign in again, and see the PASSWORD_CHANGED alert (in-app, SMS and email). The alert arrives through the worker, so wait a few seconds before the last request.',
      item: [
        req('Send a reset code', 'POST', '/auth/otp/send', { auth: false, body: { target: '{{phone}}', purpose: 'reset' }, expect: { status: 202 }, desc: 'Always 202, so the reply never tells whether an account exists.' }),
        control(req('Reset the password', 'POST', '/auth/password/reset', { auth: false, body: { target: '{{phone}}', code: '{{otp}}', newPassword: 'Turf-Booking-2027' }, expect: { status: 200 } }), 'otp?phone={{phone}}', 'otp'),
        req('Login with the new password', 'POST', '/auth/login', { auth: false, body: { identifier: '{{phone}}', password: 'Turf-Booking-2027' }, save: signedIn, cookies: csrfCookie, expect: { status: 200 } }),
        check(control(req('My notifications show PASSWORD_CHANGED', 'GET', '/me/notifications', { expect: { status: 200 }, desc: 'The newest item has code PASSWORD_CHANGED and links to /account.' }), 'settle'), 'the newest notice is PASSWORD_CHANGED', "Boolean(j && j.items && j.items[0] && j.items[0].code === 'PASSWORD_CHANGED')"),
        req('Change it back (signed in, alerts again)', 'POST', '/me/password', { body: { currentPassword: 'Turf-Booking-2027', newPassword: 'Turf-Booking-2026' }, expect: { status: 204 } }),
      ],
    },
    {
      name: '3. Admin portal: master (TOTP, step-up, RBAC)',
      description: 'Staff sign in only here (ADR-004). Every admin auth request sends Origin = adminOrigin.',
      item: [
        req('Send OTP to master', 'POST', '/auth/otp/send', { auth: false, body: { target: '{{masterPhone}}', purpose: 'login' } }),
        req('Admin login with OTP (gives challengeToken)', 'POST', '/auth/admin/login', {
          auth: false,
          origin: 'admin',
          body: { target: '{{masterPhone}}', code: '{{otp}}' },
          save: adminSignedIn,
          desc: 'First time: status two_factor_setup_required. Later: two_factor_required. Staff with a password can send { identifier, password } instead.',
        }),
        req('TOTP setup (first time only)', 'POST', '/auth/2fa/totp/setup', {
          auth: false,
          origin: 'admin',
          body: { challengeToken: '{{challengeToken}}' },
          desc: 'Add the returned secret / otpauthUrl to Google Authenticator, Authy or Microsoft Authenticator.',
        }),
        req('TOTP activate (first time), signs in', 'POST', '/auth/2fa/totp/activate', { auth: false, origin: 'admin', body: { challengeToken: '{{challengeToken}}', code: '{{totp}}' }, save: adminSignedIn, cookies: adminCsrfCookie }),
        req('TOTP verify (later sign-ins), signs in', 'POST', '/auth/2fa/totp/verify', { auth: false, origin: 'admin', body: { challengeToken: '{{challengeToken}}', code: '{{totp}}' }, save: adminSignedIn, cookies: adminCsrfCookie }),
        req('Admin me (master holds every permission)', 'GET', '/admin/me', { auth: 'admin', expect: { status: 200 } }),
        req('Admin token on a customer endpoint (expect 401 TOKEN_AUDIENCE_INVALID)', 'GET', '/me', { auth: 'admin', expect: { status: 401, code: 'TOKEN_AUDIENCE_INVALID' } }),
        req('Admin refresh (admin cookie only)', 'POST', '/auth/admin/refresh', { auth: false, origin: 'admin', csrf: 'admin', save: { adminAccessToken: 'accessToken' }, cookies: adminCsrfCookie, expect: { status: 200 } }),
        req('Search users (masked phone)', 'GET', '/admin/users?q=Fahim', { auth: 'admin' }),
        req('Approve member role (NID verified)', 'POST', '/admin/users/{{targetUserId}}/roles/member/status', { auth: 'admin', body: { status: 'active' } }),
        req('Approve ground_owner role', 'POST', '/admin/users/{{targetUserId}}/roles/ground_owner/status', { auth: 'admin', body: { status: 'active' } }),
        req('Suspend user', 'POST', '/admin/users/{{targetUserId}}/suspend', { auth: 'admin', body: { reasonCode: 'abuse', note: 'Testing the suspension flow', until: '2026-12-31T00:00:00+06:00' } }),
        req('Restore user', 'POST', '/admin/users/{{targetUserId}}/restore', { auth: 'admin', body: { note: 'Test complete' } }),
        req('Ban WITHOUT step-up (expect 403 STEP_UP_REQUIRED)', 'POST', '/admin/users/{{targetUserId}}/ban', { auth: 'admin', body: { reasonCode: 'fraud', note: 'Testing step-up guard' }, expect: { status: 403, code: 'STEP_UP_REQUIRED' } }),
        req('Step-up for staff.write', 'POST', '/auth/step-up', {
          auth: 'admin',
          body: { scope: 'staff.write', code: '{{totp}}' },
          save: { stepUpToken: 'stepUpToken' },
          desc: 'Use a NEW authenticator code each time: a code cannot be used twice.',
        }),
        req('Make the user staff (approve_documents, manage_users)', 'POST', '/admin/staff', {
          auth: 'admin',
          stepUp: true,
          body: { userId: '{{targetUserId}}', employeeId: 'KG-0101', team: 'Verification', permissions: ['approve_documents', 'manage_users'] },
          desc: "This signs the user out everywhere: from now on they sign in at the admin portal only.",
        }),
        req('Staff list and permission matrix', 'GET', '/admin/staff', { auth: 'admin' }),
        req('Step-up for staff.write (again)', 'POST', '/auth/step-up', { auth: 'admin', body: { scope: 'staff.write', code: '{{totp}}' }, save: { stepUpToken: 'stepUpToken' } }),
        req('Save permission changes', 'PUT', '/admin/staff/permissions', {
          auth: 'admin',
          stepUp: true,
          body: { changes: [{ userId: '{{targetUserId}}', grant: ['resolve_reports'], revoke: ['approve_documents'] }], reason: 'Moves to the support rota' },
        }),
        req('Admin logout', 'POST', '/auth/admin/logout', { auth: 'admin', origin: 'admin', expect: { status: 204 } }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log('written', collection.item.reduce((n, f) => n + f.item.length, 0), 'requests');
