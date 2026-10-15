# Kriraghor API (backend)

Node.js · Express 5 · Sequelize 6 · MySQL 8 · Redis · BullMQ · Socket.IO · Passport JWT

The specification for every module is in [`../kriraghor-docs/modules`](../kriraghor-docs/modules/README.md). Modules are built one at a time, in dependency order.

| Module | Status |
|---|---|
| **M01 Identity and Access**: authentication and authorisation | ✅ Implemented: [`src/modules/auth`](src/modules/auth), [`src/modules/users`](src/modules/users), [`src/modules/admin`](src/modules/admin). Separate admin sessions per [ADR-004](../kriraghor-docs/decisions/ADR-004-cross-subdomain-auth.md) |
| **Platform (0B)**: Kubernetes readiness | ✅ Three entrypoints, Redis, BullMQ, Socket.IO, probes, metrics, OpenAPI, Docker image ([ADR-002](../kriraghor-docs/decisions/ADR-002-polyrepo-api-contracts.md), [ADR-003](../kriraghor-docs/decisions/ADR-003-kubernetes-deployment.md)) |
| **M03 Settings and esports catalogue** | ✅ Step 1: [`src/modules/settings`](src/modules/settings) (144 platform settings, history, four-eyes change requests, scheduled changes, SettingsService with Redis cache bust) and [`src/modules/catalog`](src/modules/catalog) (esports games, modes, maps, versioned points presets). Sports, locations, hire and item catalogues come with their modules |
| **M04 Audit log and events** | ✅ [`src/modules/audit`](src/modules/audit) (redacted, append-only audit log with a hash chain sealed after commit, action registry with EN/BN summaries, search, entity history, CSV export) and [`src/modules/events`](src/modules/events) (event registry, transactional outbox, relay, inbox, retries, dead letters, replay). M01 and M03 publish their events |
| **M08 Notifications core** | ✅ [`src/modules/notifications`](src/modules/notifications): catalogue router on M04 events, versioned EN/BN templates, preferences with mandatory categories, quiet hours, Redis SMS rate limits, dedupe, retries, in-app (bell, realtime), email and sandbox SMS, masked SMS log, OTP through M08. Push, broadcasts and the real SMS gateway come later (M21, Q59). **Phase 1 exit check passes** |
| Everything else | Not started |

## Quick start

```bash
cp .env.example .env              # then set real secrets (see the comments in the file)
docker compose up -d              # MySQL 8.4, Redis 7.4, Mailpit, SeaweedFS (S3); also creates kriraghor_test
npm install
npm run release                   # migrations, then the M03 reference seed (settings + esports catalogue)
npm run create:master -- --phone 01XXXXXXXXX --name "Your Name" --employee-id KG-0001
npm run dev                       # API       http://localhost:4000/api/v1  (docs: /api/docs)
npm run dev:realtime              # Socket.IO http://localhost:4001/socket.io
npm run dev:worker                # BullMQ jobs (suspension expiry, …)
```

In development:
- **SMS codes** are printed to the console (`SMS_DRIVER=console`).
- **Email codes** go to **Mailpit**: open http://localhost:8025 to read them.
- **API docs**: Swagger UI at http://localhost:4000/api/docs, the raw document at `/api/docs/openapi.json`.

### Processes (one image, three entrypoints)

| Process | Locally | In the image (container `args`) | Port | What it does |
|---|---|---|---|---|
| api | `npm run dev` | `src/server.js` (default) | `PORT` (4000) | REST `/api/v1`, OpenAPI |
| realtime | `npm run dev:realtime` | `src/realtime.js` | `REALTIME_PORT` (4001) | Socket.IO with the Redis adapter. Handshake `auth: { token, audience }`; joins `user:{id}`, staff also join `staff` |
| worker | `npm run dev:worker` | `src/worker.js` | – | BullMQ workers and job schedulers ([`src/jobs/definitions.js`](src/jobs/definitions.js)) |
| migrate | `npm run db:migrate` | `node_modules/sequelize-cli/lib/sequelize db:migrate` | – | Kubernetes pre-upgrade Job. Never runs on boot |

The image's entrypoint is Node itself (distroless), so Kubernetes passes only the script as `args`. For a one-off command inside a pod, call Node by its path: `kubectl exec deploy/backend-api -- /nodejs/bin/node scripts/create-master.js ...`.

Every process also serves `/health/live`, `/health/ready` (DB + Redis, 503 while draining) and `/metrics` (Prometheus) on `OPS_PORT` (9464). That port is never exposed through the ingress. On SIGTERM a process fails readiness, waits `SHUTDOWN_DRAIN_MS`, then closes its servers, queues, Redis and DB in order.

### Enabling "Sign in with Google"
1. Open the Google Cloud Console and go to **APIs & Services → OAuth consent screen**. Configure it with the app name *Kriraghor* and the scopes *email*, *profile* and *openid*.
2. Go to **Credentials → Create credentials → OAuth client ID → Web application**.
   - Authorised JavaScript origins: `http://localhost:3000`, `http://localhost:3001`, plus the production domains later.
   - Add separate Android and iOS client IDs when the mobile app arrives.
3. Put the client ID(s) in `.env`: `GOOGLE_CLIENT_IDS=1234-abc.apps.googleusercontent.com`. Separate several with commas.
4. On the frontend (Next.js), render the Google button with Google Identity Services and send its `credential` (the ID token) to `POST /api/v1/auth/google`.

```bash
npm test                          # unit + end-to-end tests (needs docker compose up -d)
npm run lint
npm run openapi                   # regenerate openapi.json after changing a route or schema
```

## How to check the backend yourself

### 1. Automated tests (fastest)
```bash
docker compose up -d
npm test
```
Expected result: every test green and the coverage gate (100% on the settings and catalogue validators, the audit redactor, the retry backoff and the event registry rules) (unit tests plus end-to-end tests against a real MySQL test database and Redis). The tests cover:
- OTP signup and sign-in; non-enumeration, cooldowns and code burning
- Password lockout and reset
- Refresh rotation and reuse detection; session revocation; `AUTHZ_STALE`
- The gate; TOTP enrolment; scoped single-use step-up (including `esports.money`)
- Staff permission enforcement; masked search; suspend, ban and restore; role activation rules
- Email OTP (Mailpit), username sign-up and login; Google sign-in, linking and unlinking (Google is stubbed)
- **ADR-004**: CORS allowlist (exact and one-label wildcards), cookie flags, CSRF origin and token checks (including a token from another session), SSO across two app origins, mobile refresh without cookies, separate admin sessions (`STAFF_USE_ADMIN_PORTAL`, `NOT_STAFF`, `TOKEN_AUDIENCE_INVALID`)
- **M03 settings**: every value type, range and cross-key rule; public vs admin views; step-up; single-approval apply; four-eyes (proposer cannot approve, DB check); reject, withdraw, supersede; scheduled apply and rejection when a rule now fails; `getAt` and snapshots; append-only history (DB triggers); cache bust across processes; boot check; seed idempotency; M01 reading its limits from settings
- **M03 esports catalogue**: public list with ETag, permissions (`manage_esports` or `manage_catalog`), immutable keys, mode capacity, UID patterns, preset versions, deactivate and reactivate
- **Platform**: the suspension-expiry job (idempotent), job scheduler registration, readiness and draining, shutdown order, metrics, the Socket.IO handshake (valid, missing, forged, expired, wrong audience, staff room), and the OpenAPI contract (served, committed file up to date, every route documented, real responses match the schemas)

### 2. Manual testing with Postman
1. `npm run dev`. The API runs at `http://localhost:4000/api/v1`, and `GET http://localhost:4000/health` should return `{"status":"ok","db":"up"}`.
2. In Postman: **Import →** [`postman/kriraghor-auth.postman_collection.json`](postman/kriraghor-auth.postman_collection.json). Rebuild it with `node postman/build-collection.js`.
3. Run the folders in order:
   - **0. Smoke**: needs no codes. With the Postman CLI: `postman collection run postman/kriraghor-auth.postman_collection.json -i "0. Smoke (no codes needed)"`.
   - **1. Member signup**:
     - Send an OTP, copy the code from the **server console** into the `otp` collection variable, verify it, then sign up.
     - Check the gate (`KYC_REQUIRED`).
     - Try `/admin` with the member token; you should get **401 `TOKEN_AUDIENCE_INVALID`**.
   - **2. Password, sessions, refresh**: password login, refresh rotation (the request sends `Origin` and `X-CSRF-Token`), sessions, role application (then `AUTHZ_STALE` → refresh).
   - **3. Admin portal**:
     - Staff sign in only through `POST /auth/admin/login` with `Origin: {{adminOrigin}}`. Use the master created by `npm run create:master` (default `01711000001`).
     - Scan the TOTP secret into an authenticator app, putting each code into the `totp` variable.
     - Approve the member's roles, suspend and restore them, and confirm a ban without step-up is refused.
     - Step up, make the member staff, then edit the permission matrix.

See [`postman/M01-acceptance-checklist.md`](postman/M01-acceptance-checklist.md) for the full sign-off list.

**M08 (notifications, the Phase 1 exit check)** runs unattended: `node postman/run-m08.js` (two masters with emails, a member and an in-process worker; 14 requests, 26 assertions). Checklist: [`postman/M08-acceptance-checklist.md`](postman/M08-acceptance-checklist.md).

**M04 (audit log and events)** runs unattended the same way: `node postman/run-m04.js` (it also runs a small in-process worker for the relay, consumers and exports). Checklist: [`postman/M04-acceptance-checklist.md`](postman/M04-acceptance-checklist.md).

**M03 (settings and esports catalogue)** runs unattended: `node postman/run-m03.js` resets the test database, signs in two masters, pre-mints step-up tokens and runs [`postman/kriraghor-settings.postman_collection.json`](postman/kriraghor-settings.postman_collection.json) with the Postman CLI (22 requests, 37 assertions). Checklist: [`postman/M03-acceptance-checklist.md`](postman/M03-acceptance-checklist.md).

### 3. Inspect the database
```bash
docker exec -it kriraghor-mysql mysql -ukriraghor -pkriraghor kriraghor
```
```sql
SELECT action, actor_id, entity_type, created_at FROM audit_logs ORDER BY id DESC LIMIT 20;
SELECT role, status FROM user_roles;
SELECT id, audience, device_label, revoked_at, revoke_cause FROM sessions;
```

## Running in Kubernetes

The image is built from the [`Dockerfile`](Dockerfile): production dependencies are installed on `node:24.16.0-bookworm-slim`, and the runtime is **distroless Node 24 (Debian 13)**, pinned by digest: no shell, no npm, no package manager. It runs as uid 1000 and needs no writable filesystem. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs lint, the tests against MySQL and Redis, the OpenAPI drift check, the image build and a Trivy scan that fails on fixable HIGH or CRITICAL findings.

```bash
docker build -t kriraghor-backend:dev .
```

Charts, values per environment and the local k3d cluster live in [`../kriraghor-infra`](../kriraghor-infra/README.md). In short:

| Setting | Local (docker compose) | k3d (`*.kriraghor.localhost`) | Production |
|---|---|---|---|
| `CORS_ORIGINS` | `http://localhost:3000,3001,3002` | `http://*.kriraghor.localhost` | `https://kriraghor.com,https://www.kriraghor.com,https://esports.kriraghor.com,https://vendor.kriraghor.com` |
| `ADMIN_ORIGINS` | `http://localhost:3002` | `http://admin.kriraghor.localhost` | `https://admin.kriraghor.com` |
| `COOKIE_HINT_DOMAIN` | empty | `.kriraghor.localhost` | `.kriraghor.com` (staging `.staging.kriraghor.com`) |
| `COOKIE_PREFIX` | `kg` | `kg` | `kg` (staging `kgstg`) |
| `COOKIE_SECURE` | `false` | `false` (plain HTTP) | `true` |
| `TRUST_PROXY` | `0` | `1` | `2` (Cloudflare + ingress-nginx) |
| Secrets | `.env` | Secret from `local/secrets.sh` | External Secrets |

## Project layout

```
src/
├─ app.js                 Express app (security headers, CORS allowlist, JSON, Passport, routes, OpenAPI, RFC 7807 errors)
├─ server.js              api entrypoint
├─ realtime.js            realtime entrypoint (Socket.IO + Redis adapter)
├─ worker.js              worker entrypoint (BullMQ)
├─ config/                Env validation (zod) + sequelize-cli config
├─ db/migrations/         Schema (sequelize-cli)
├─ models/                Sequelize models + associations
├─ common/                errors, validation, identifiers, crypto, enums, logger, origins, redis, lifecycle, ops-server, metrics
├─ jobs/                  queue registry, job catalogue, worker runtime
├─ realtime/              Socket.IO server and handshake
├─ openapi/               OpenAPI 3.1 registry: response components and every route
├─ middlewares/           passport JWT strategies (api, admin), auth guards, CSRF, rate limits (Redis), errors
├─ providers/             SMS, email and Google facades
└─ modules/
   ├─ auth/               OTP, signup, password login and lockout, admin login, sessions and refresh rotation, cookies, TOTP 2FA, step-up, gate
   ├─ users/              /me: profile, gate preview, role applications, password, sessions, sign-in methods
   ├─ admin/              /admin: me, user search, suspend, ban, restore, role decisions, staff and permission matrix
   ├─ settings/           M03 platform settings: SettingsService, validators, change requests (four-eyes), history
   ├─ catalog/            M03 esports catalogue: games, modes, maps, points presets
   ├─ events/             M04 event registry, outbox publish, relay, consumers/inbox, dead letters, replay, ops API
   ├─ audit/              M04 audit writer, action registry, redactor, hash chain, search, exports
   └─ notifications/      M08 catalogue, router, templates, prefs, delivery (in-app, email, SMS), bell API, delivery log
scripts/                  release.js (migrate + reference seed), create-master.js (first master, CLI only), openapi.js (writes openapi.json)
src/db/seed/              Reference seed (versioned JSON: settings, esports catalogue, message templates)
postman/                  collection builder, collection, guide and acceptance checklist
tests/                    Jest unit and Supertest e2e (real MySQL test database and Redis)
```

## Authentication model

| Concept | Implementation |
|---|---|
| Sign-in methods | **Phone OTP** (SMS), **email OTP** (emailed code), **password** with phone, email **or username**, and **Sign in with Google**. Proving possession by OTP signs in an existing account or starts signup, so no account enumeration is possible |
| Customer vs staff (ADR-004, Q33) | **Separate accounts and sessions.** Customer sign-in refuses staff (`STAFF_USE_ADMIN_PORTAL`). Staff sign in at `POST /auth/admin/login` (password or login OTP) from an admin origin, then TOTP. Admin tokens have `aud: "admin"`, customer tokens `aud: "api"`; the wrong one gets `TOKEN_AUDIENCE_INVALID`. Becoming staff signs the member out everywhere |
| Username | Optional and unique. 3–30 characters (letters, digits, `.` and `_`), starting with a letter, case-insensitive; reserved names are blocked. Works only with a password |
| Google | The frontend's Google button returns an ID token, and the API verifies it with `google-auth-library` (signature, issuer, expiry, audience = our client IDs). A known Google account signs in. A verified Google email matching an account whose email is **also verified** is linked automatically; anything else goes through signup |
| OTP | 6 digits, stored as an HMAC, 5-minute expiry, 5 attempts, 60 s resend cooldown, 3 sends per 10 min per target, per-IP cap |
| Passwords | Optional. Hashed with argon2id (64 MiB, t=3). Deny-list plus optional HIBP k-anonymity check. 5 failures lock password sign-in for 15 min (OTP still works) |
| Access token | 15 min HS256 JWT `{sub, sid, av, aud}`, validated by **passport-jwt** (two strategies). Roles and permissions are always re-read from the database. A changed `authz_version` returns `AUTHZ_STALE` |
| Refresh token | Opaque, stored hashed, **rotated on every use**; reusing an old token revokes the whole family. Customer: `kg_rt`, 30 days, httpOnly, `SameSite=Lax`. Admin: `kg_art`, 12 h, `SameSite=Strict`. Both host-only on the API host, path `/api/v1/auth`. Mobile (`X-Client-Type: mobile`) gets it in the body instead |
| Hint and CSRF cookies | `kg_si` / `kg_asi` (`"1"`, for Next.js routing only) and `kg_csrf` / `kg_acsrf` on `COOKIE_HINT_DOMAIN`. Refresh requires an allowed `Origin` and `X-CSRF-Token` equal to the CSRF cookie, whose HMAC binds it to the session family |
| Staff and master | TOTP mandatory (enrolment on first sign-in), with replay protection. 30 min idle timeout and 12 h absolute session lifetime |
| Step-up | `POST /auth/step-up {scope, code}` returns a single-use, scope-bound token sent as the `X-Step-Up` header (fees, staff, bans, 2FA resets, `esports.money`, …) |
| Authorisation | `requireRoles()`, `requirePermission()` (staff flags; masters hold all), `requireMaster`, `requireStepUp(scope)`, `requireGate(action)` |
| Rate limits | Redis store shared by every pod (`rate-limit-redis`); fails open to the DB-backed OTP and lockout limits if Redis is down |
| Audit | Every auth and admin mutation writes `audit_logs` inside the same transaction |

## API (M01)

The full contract, with request and response schemas and error codes per route, is [`openapi.json`](openapi.json) (Swagger UI at `/api/docs` outside production). Summary:

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /auth/otp/send` | – | `{target, purpose: signup\|login\|reset}` → 202 |
| `POST /auth/otp/verify` | – | → `signed_in` / `signup` (+`signupToken`) |
| `POST /auth/signup` | signup token | `{signupToken, displayName, password?, role?, roleMeta?, locale?}` |
| `POST /auth/login` | – | `{identifier, password}`. The identifier can be a phone, email or username |
| `POST /auth/google` | – | `{idToken}` → `signed_in` / `signup` (+`signupToken`, `suggested`) |
| `GET /auth/username-available?username=` | – | `{available}` |
| `POST /auth/password/reset` | – | `{target, code, newPassword}` (signs out everywhere) |
| `POST /auth/refresh` | cookie + `Origin` + `X-CSRF-Token` (or mobile body) | Rotation |
| `POST /auth/logout[?all=true]` | bearer | Sign-out |
| `POST /auth/admin/login` | admin origin | `{identifier, password}` or `{target, code}` → TOTP challenge |
| `POST /auth/2fa/totp/setup` · `/activate` · `/verify` | admin origin + challenge token | Staff 2FA enrolment and sign-in (admin session) |
| `POST /auth/admin/refresh` · `POST /auth/admin/logout` | admin origin + admin cookie / admin bearer | Admin rotation, sign-out |
| `POST /auth/step-up` | admin bearer | `{scope, code}` → `{stepUpToken}` |
| `GET /me` · `PATCH /me` | bearer | Profile, roles, permissions |
| `GET /me/gate?action=book_ground` | bearer | Gate preview (`KYC_REQUIRED`, `ROLE_PENDING`, …) |
| `POST /me/roles` · `POST /me/roles/:role/withdraw` | bearer | Role applications |
| `POST /me/password` | bearer | Set or change password (other sessions signed out) |
| `GET /me/sessions` · `DELETE /me/sessions/:id` | bearer | Device list and remote sign-out |
| `PUT /me/username` | bearer | Set or change the username |
| `POST /me/email` · `POST /me/email/verify` | bearer | Add or change the email with an emailed OTP |
| `POST /me/identities/google` · `DELETE /me/identities/google` | bearer | Connect or disconnect Google (you must keep at least one other sign-in method) |
| `GET /admin/me` | admin bearer | The signed-in staff member |
| `GET /admin/users` · `GET /admin/users/:id` | `manage_users` | Masked search (audited), detail |
| `POST /admin/users/:id/suspend` · `/restore` · `/sign-out` | `manage_users` | Sanctions |
| `POST /admin/users/:id/ban` · `/unban` | master + step-up `user.ban` | |
| `POST /admin/users/:id/roles/:role/status` | `manage_users` | Manual role decisions (until M02 automates them) |
| `GET /admin/staff` | master | Staff list and permission matrix |
| `POST /admin/staff` · `PUT /admin/staff/permissions` · `/staff/:id/offboard` · `/promote-master` | master + step-up `staff.write` | |
| `POST /admin/staff/:id/reset-2fa` | master + step-up `twofa.reset` | |

Errors are `application/problem+json` with a stable `code`: `AUTH_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_AUDIENCE_INVALID`, `AUTHZ_STALE`, `SESSION_REVOKED`, `CSRF_ORIGIN_REJECTED`, `CSRF_TOKEN_INVALID`, `STAFF_USE_ADMIN_PORTAL`, `NOT_STAFF`, `OTP_INVALID`, `OTP_EXPIRED`, `OTP_RATE_LIMITED`, `AUTH_LOCKED`, `INVALID_CREDENTIALS`, `TWO_FACTOR_REQUIRED`, `TOTP_INVALID`, `TOTP_REPLAYED`, `STEP_UP_REQUIRED`, `PERMISSION_REQUIRED`, `PERMISSION_NOT_GRANTABLE`, `MASTER_REQUIRED`, `ROLE_REQUIRED`, `KYC_REQUIRED`, `KYC_PENDING`, `ACCOUNT_SUSPENDED`, `ACCOUNT_BANNED`, `VALIDATION_FAILED`, …

## API (M03)

| Endpoint | Access | Notes |
|---|---|---|
| `GET /settings/public` | public | Public keys only, nested camelCase; money as `{ amount, currency }`; `Cache-Control: max-age=300` + ETag |
| `GET /catalog/esports/games` | public | Active games with modes, maps and the current preset versions; cached + ETag |
| `GET /admin/settings` · `/admin/settings/:key/history` · `/admin/settings/change-requests[/:id]` | master, or `manage_catalog` read-only | |
| `POST /admin/settings/change-requests` | master + step-up `settings.write` | Applies at once, schedules, or waits for a second master (four-eyes keys) |
| `POST /admin/settings/change-requests/:id/approve` · `/reject` · `/withdraw` | master + step-up `settings.write` | Approve and reject by another master; withdraw by the proposer |
| `GET/POST /admin/catalog/:table` · `PATCH /admin/catalog/:table/:id` · `POST …/:id/deactivate` · `/reactivate` | `manage_esports` or `manage_catalog` | Tables: esports-games, esports-modes, esports-maps, esports-points-presets |

New error codes: `SETTING_UNKNOWN`, `SETTING_TYPE_INVALID`, `SETTING_OUT_OF_RANGE`, `SETTING_CROSS_RULE`, `SETTING_UNCHANGED`, `EFFECTIVE_AT_PAST`, `FOUR_EYES_REQUIRED`, `NOT_PROPOSER`, `CHANGE_REQUEST_CLOSED`, `CATALOG_KEY_TAKEN`, `CATALOG_KEY_IMMUTABLE`.

Every process (api, realtime, worker) refuses to start until every seeded setting exists, so run `npm run release` (or the Helm migrate Job) first. Code reads values with `settings.get(key)`; store `settings.snapshot(keys)` with anything that charges a fee.

## API (M04)

| Endpoint | Access | Notes |
|---|---|---|
| `GET /admin/audit-logs` | master | Filters from, to, actorId, actorType, module, action (comma list), entityType, entityId, severity, stepUp; cursor paging; 1-year cap (`RANGE_TOO_LARGE`) |
| `GET /admin/audit-logs/:id` | master | Full IP, request and session, hash-chain status |
| `GET /admin/entities/:entityType/:entityId/history` | staff | Masters see every row, other staff only their own |
| `POST /admin/audit-logs/exports` · `GET …/exports/:id` · `GET …/exports/:id/download` | master + step-up `audit.export` | CSV built by the `audit.export` job into `S3_BUCKET_PRIVATE`, streamed back for 24 h (`EXPORT_NOT_READY`, `EXPORT_EXPIRED`) |
| `GET /admin/events?status=dead|failed|pending` | master | Outbox health and dead letters |
| `POST /admin/events/:id/replay` | master + step-up `events.replay` | `EVENT_NOT_REPLAYABLE` once processed |

**Writing code that changes state:** call `audit.record(entry, { transaction })` with a registered action ([`audit.actions.js`](src/modules/audit/audit.actions.js)) and `events.publish(transaction, event)` with a registered event ([`catalog.js`](src/modules/events/catalog.js)); payloads hold IDs, codes, amounts and statuses only. Consumers register in [`subscriptions.js`](src/modules/events/subscriptions.js) with `onEvent(name, consumer, handler)` and get `(event, { transaction })`; they run at least once, so keep them idempotent beyond the inbox.

## API (M08)

| Endpoint | Access | Notes |
|---|---|---|
| `GET /me/notifications?unread&category&cursor&limit` · `GET /me/notifications/unread-count` · `POST /me/notifications/read` | signed-in user | The list includes `unreadCount`; read takes `{ids}` or `{all: true, before}`. Realtime `notification.created` / `notification.read` to room `user:{id}` |
| `GET /admin/me/notifications…` (same three) | staff (admin token) | Kept apart from the customer audience (ADR-004) |
| `GET` / `PUT /me/notification-prefs` | signed-in user | Category × channel matrix with mandatory cells locked (`PREF_MANDATORY`), quiet hours |
| `GET /admin/notifications/deliveries?userId&phoneSuffix&code&status` | `manage_users` or master | Delivery log, recipients masked |

**Sending a notification:** add a code to [`notify.catalogue.js`](src/modules/notifications/notify.catalogue.js) (event, category, recipients, channels, variables) and active EN and BN templates to [`templates.v1.json`](src/db/seed/reference/templates.v1.json); the contract test fails until both exist and every SMS fits `notify.sms_max_segments`. Producers only publish their M04 event. OTPs use `notifications.sendOtp()` (priority route, code redacted in `sms_log`).

## Differences from the M01 spec

| Spec | Now | Plan |
|---|---|---|
| WebAuthn security key for master step-up | TOTP-based step-up (same single-use, scoped token) | Add `@simplewebauthn/server` and make it mandatory for masters |
| One sign-in flow for everyone, staff add TOTP | Separate admin sign-in, sessions, cookies and token audience (ADR-004); staff accounts can't use customer apps (Q33) | Done in 0B |
| Redis authz cache | DB lookup per request (Redis is now available) | Later; settings use a per-process cache with a Redis bust channel |
| OTP, lockout, session and staff limits as env vars | Platform settings (`auth.*`, `ratelimit.*`), changed on the Fees and rules screen with history (M03) | Done in M03 |
| `identity.sanction-expire` job | BullMQ job scheduler in the worker, every 60 s | Done in 0B |
| Phone change, account closure | Not yet | Next M01 iteration |
| Admin login with Google | Not offered; staff use password or OTP, then TOTP | Revisit with WebAuthn |
| Postgres partial unique index on `staff_permissions` | One row per (user, permission) with `revoked_at`; history lives in `audit_logs` | — (MySQL) |
