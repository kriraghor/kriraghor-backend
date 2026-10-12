# Kriraghor API (backend)

Node.js · Express 5 · Sequelize 6 · MySQL 8 · Passport JWT

The specification for every module is in [`../docs/modules`](../docs/modules/README.md). Modules are built one at a time, in dependency order.

| Module | Status |
|---|---|
| **M01 Identity and Access**: authentication and authorisation | ✅ Implemented: [`src/modules/auth`](src/modules/auth), [`src/modules/users`](src/modules/users), [`src/modules/admin`](src/modules/admin) |
| M04 Audit log | Minimal append-only `audit_logs` table and service (enough for M01). Domain events and the outbox come later |
| Everything else | Not started |

## Quick start

```bash
cp .env.example .env              # then set real secrets (see the comments in the file)
docker compose up -d              # MySQL 8.4 on :3306 (also creates kriraghor_test)
npm install
npm run db:migrate
npm run create:master -- --phone 01XXXXXXXXX --name "Your Name" --employee-id KG-0001
npm run dev                       # http://localhost:4000/api/v1
```

In development:
- **SMS codes** are printed to the console (`SMS_DRIVER=console`).
- **Email codes** go to **Mailpit**: open http://localhost:8025 to read them. Mailpit is started by `docker compose up -d`.

### Enabling "Sign in with Google"
1. Open the Google Cloud Console and go to **APIs & Services → OAuth consent screen**. Configure it with the app name *Kriraghor* and the scopes *email*, *profile* and *openid*.
2. Go to **Credentials → Create credentials → OAuth client ID → Web application**.
   - Authorised JavaScript origins: `http://localhost:3000`, plus your production domain later.
   - Add separate Android and iOS client IDs when the mobile app arrives.
3. Put the client ID(s) in `.env`: `GOOGLE_CLIENT_IDS=1234-abc.apps.googleusercontent.com`. Separate several with commas.
4. On the frontend (Next.js), render the Google button with Google Identity Services and send its `credential` (the ID token) to `POST /api/v1/auth/google`.

```bash
npm test                          # unit + end-to-end tests (needs the MySQL container)
npm run lint
```

## How to check the backend yourself

### 1. Automated tests (fastest)
```bash
docker compose up -d
npm test
```
Expected result: `Tests: 64 passed, 64 total` (unit tests plus end-to-end tests against a real MySQL test database). The tests cover:
- OTP signup and sign-in
- Non-enumeration, cooldowns and code burning
- Password lockout and reset
- Refresh rotation and reuse detection
- Session revocation
- `AUTHZ_STALE`
- The gate
- TOTP enrolment
- Scoped single-use step-up
- Staff permission enforcement
- Masked search
- Suspend, ban and restore
- Automatic suspension expiry
- Role activation rules
- Protection of staff accounts
- Email OTP (Mailpit), username sign-up and login
- Google sign-in, linking and unlinking (Google verification is stubbed in tests)

### 2. Manual testing with Postman
1. `npm run dev`. The API runs at `http://localhost:4000/api/v1`, and `GET http://localhost:4000/health` should return `{"status":"ok","db":"up"}`.
2. In Postman: **Import →** [`postman/kriraghor-auth.postman_collection.json`](postman/kriraghor-auth.postman_collection.json).
3. Run the folders in order:
   - **1. Member signup**:
     - Send an OTP, copy the code from the **server console** into the `otp` collection variable, verify it, then sign up.
     - Check the gate (`KYC_REQUIRED`).
     - Try `/admin`; you should get **403** (RBAC).
   - **2. Password, sessions, refresh**: password login, refresh rotation, sessions, role application (then `AUTHZ_STALE` → refresh).
   - **3. Master admin**:
     - Sign in as the master created by `npm run create:master` (default `01711000001`).
     - Scan the TOTP secret into an authenticator app, putting each code into the `totp` variable.
     - Approve the member's roles, suspend and restore them, and confirm a ban without step-up is refused.
     - Step up, make the member staff, then edit the permission matrix.

Tokens are captured automatically. The refresh token is an httpOnly cookie that Postman stores for you.

### 3. Inspect the database
```bash
docker exec -it kriraghor-mysql mysql -ukriraghor -pkriraghor kriraghor
```
```sql
SELECT action, actor_id, entity_type, created_at FROM audit_logs ORDER BY id DESC LIMIT 20;
SELECT role, status FROM user_roles;
SELECT id, device_label, revoked_at, revoke_cause FROM sessions;
```

## Project layout

```
src/
├─ app.js                 Express app (security headers, CORS, JSON, Passport, routes, RFC 7807 errors)
├─ server.js              Boot, graceful shutdown, suspension-expiry scheduler
├─ config/                Env validation (zod) + sequelize-cli config
├─ db/migrations/         Schema (sequelize-cli)
├─ models/                Sequelize models + associations
├─ common/                errors, validation, identifiers (BD phone), crypto, enums, logger
├─ middlewares/           passport JWT strategy, auth guards, rate limits, errors
├─ providers/sms/         SMS facade (console / memory drivers; BD gateway driver goes here)
└─ modules/
   ├─ auth/               OTP, signup, password login and lockout, sessions and refresh rotation, TOTP 2FA, step-up, gate
   ├─ users/              /me: profile, gate preview, role applications, password, sessions
   ├─ admin/              /admin: user search, suspend, ban, restore, role decisions, staff and permission matrix
   └─ audit/              append-only audit writer
scripts/create-master.js  First master admin bootstrap (CLI only)
tests/                    Jest unit and Supertest e2e (real MySQL test database)
```

## Authentication model

| Concept | Implementation |
|---|---|
| Sign-in methods | **Phone OTP** (SMS), **email OTP** (emailed code), **password** with phone, email **or username**, and **Sign in with Google**. Proving possession by OTP signs in an existing account or starts signup, so no account enumeration is possible |
| Username | Optional and unique. 3–30 characters (letters, digits, `.` and `_`), starting with a letter, case-insensitive; reserved names are blocked. Works only with a password |
| Google | The frontend's Google button returns an ID token, and the API verifies it with `google-auth-library` (signature, issuer, expiry, audience = our client IDs). A known Google account signs in. A verified Google email matching an account whose email is **also verified** is linked automatically; anything else goes through signup. Staff still need TOTP |
| OTP | 6 digits, stored as an HMAC, 5-minute expiry, 5 attempts, 60 s resend cooldown, 3 sends per 10 min per target, per-IP cap |
| Passwords | Optional. Hashed with argon2id (64 MiB, t=3). Deny-list plus optional HIBP k-anonymity check. 5 failures lock password sign-in for 15 min (OTP still works) |
| Access token | 15 min HS256 JWT `{sub, sid, av}`, validated by **passport-jwt**. Roles and permissions are always re-read from the database. A changed `authz_version` returns `AUTHZ_STALE` |
| Refresh token | 30 days, opaque and stored hashed. Delivered in an httpOnly `SameSite=Strict` cookie, or in the body for `X-Client-Type: mobile`. **Rotated on every use**; reusing an old token revokes the whole token family |
| Staff and master | TOTP mandatory (enrolment on first sign-in), with replay protection. 30 min idle timeout and 12 h absolute session lifetime |
| Step-up | `POST /auth/step-up {scope, code}` returns a single-use, scope-bound token sent as the `X-Step-Up` header (fees, staff, bans, 2FA resets, …) |
| Authorisation | `requireRoles()`, `requirePermission()` (staff flags; masters hold all), `requireMaster`, `requireStepUp(scope)`, `requireGate(action)` |
| Audit | Every auth and admin mutation writes `audit_logs` inside the same transaction |

## API (M01)

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /auth/otp/send` | – | `{target, purpose: signup\|login\|reset}` → 202 |
| `POST /auth/otp/verify` | – | → `signed_in` / `signup` (+`signupToken`) / `two_factor_required` / `two_factor_setup_required` |
| `POST /auth/signup` | signup token | `{signupToken, displayName, password?, role?, roleMeta?, locale?}` |
| `POST /auth/login` | – | `{identifier, password}`. The identifier can be a phone, email or username |
| `POST /auth/google` | – | `{idToken}` → `signed_in` / `signup` (+`signupToken`, `suggested`) / `two_factor_required` |
| `GET /auth/username-available?username=` | – | `{available}` |
| `POST /auth/password/reset` | – | `{target, code, newPassword}` (signs out everywhere) |
| `POST /auth/2fa/totp/setup` · `/activate` · `/verify` | challenge token | Staff 2FA enrolment and sign-in |
| `POST /auth/step-up` | staff | `{scope, code}` → `{stepUpToken}` |
| `POST /auth/refresh` · `POST /auth/logout[?all=true]` | cookie / bearer | Rotation, sign-out |
| `GET /me` · `PATCH /me` | bearer | Profile, roles, permissions |
| `GET /me/gate?action=book_ground` | bearer | Gate preview (`KYC_REQUIRED`, `ROLE_PENDING`, …) |
| `POST /me/roles` · `POST /me/roles/:role/withdraw` | bearer | Role applications |
| `POST /me/password` | bearer | Set or change password (other sessions signed out) |
| `GET /me/sessions` · `DELETE /me/sessions/:id` | bearer | Device list and remote sign-out |
| `PUT /me/username` | bearer | Set or change the username |
| `POST /me/email` · `POST /me/email/verify` | bearer | Add or change the email with an emailed OTP |
| `POST /me/identities/google` · `DELETE /me/identities/google` | bearer | Connect or disconnect Google (you must keep at least one other sign-in method) |
| `GET /admin/users` · `GET /admin/users/:id` | `manage_users` | Masked search (audited), detail |
| `POST /admin/users/:id/suspend` · `/restore` · `/sign-out` | `manage_users` | Sanctions |
| `POST /admin/users/:id/ban` · `/unban` | master + step-up `user.ban` | |
| `POST /admin/users/:id/roles/:role/status` | `manage_users` | Manual role decisions (until M02 automates them) |
| `GET /admin/staff` | master | Staff list and permission matrix |
| `POST /admin/staff` · `PUT /admin/staff/permissions` · `/staff/:id/offboard` · `/promote-master` | master + step-up `staff.write` | |
| `POST /admin/staff/:id/reset-2fa` | master + step-up `twofa.reset` | |

Errors are `application/problem+json` with a stable `code`: `AUTH_REQUIRED`, `TOKEN_EXPIRED`, `AUTHZ_STALE`, `SESSION_REVOKED`, `OTP_INVALID`, `OTP_EXPIRED`, `OTP_RATE_LIMITED`, `AUTH_LOCKED`, `INVALID_CREDENTIALS`, `TWO_FACTOR_REQUIRED`, `TOTP_INVALID`, `TOTP_REPLAYED`, `STEP_UP_REQUIRED`, `PERMISSION_REQUIRED`, `PERMISSION_NOT_GRANTABLE`, `MASTER_REQUIRED`, `ROLE_REQUIRED`, `KYC_REQUIRED`, `KYC_PENDING`, `ACCOUNT_SUSPENDED`, `ACCOUNT_BANNED`, `VALIDATION_FAILED`, …

## Differences from the M01 spec in this first slice

| Spec | Now | Plan |
|---|---|---|
| WebAuthn security key for master step-up | TOTP-based step-up (same single-use, scoped token) | Add `@simplewebauthn/server` and make it mandatory for masters |
| Redis authz cache and BullMQ jobs | DB lookup per request; a `setInterval` lifts expired suspensions | Introduce Redis and BullMQ with M04/M08 |
| Phone or email change, account closure, email OTP delivery | Not yet | Next M01 iteration (email delivery needs M08) |
| Postgres partial unique index on `staff_permissions` | One row per (user, permission) with `revoked_at`; history lives in `audit_logs` | — (MySQL) |
