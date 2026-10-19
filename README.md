# Kriraghor API (backend)

Node.js · Express 5 · Sequelize 6 · PostgreSQL 17 · Redis · BullMQ · Socket.IO · Passport JWT

The specification for every module is in [`../kriraghor-docs/modules`](../kriraghor-docs/modules/README.md). Modules are built one at a time, in dependency order.

| Module | Status |
|---|---|
| **M01 Identity and Access**: authentication and authorisation | ✅ Implemented: [`src/modules/auth`](src/modules/auth), [`src/modules/users`](src/modules/users), [`src/modules/admin`](src/modules/admin). Separate admin sessions per [ADR-004](../kriraghor-docs/decisions/ADR-004-cross-subdomain-auth.md) |
| **Platform (0B)**: Kubernetes readiness | ✅ Three entrypoints, Redis, BullMQ, Socket.IO, probes, metrics, OpenAPI, Docker image ([ADR-002](../kriraghor-docs/decisions/ADR-002-polyrepo-api-contracts.md), [ADR-003](../kriraghor-docs/decisions/ADR-003-kubernetes-deployment.md)) |
| **M03 Settings and esports catalogue** | ✅ Step 1: [`src/modules/settings`](src/modules/settings) (157 platform settings, history, four-eyes change requests, scheduled changes, SettingsService with Redis cache bust) and [`src/modules/catalog`](src/modules/catalog) (esports games, modes, maps, versioned points presets). Sports, locations, hire and item catalogues come with their modules |
| **M04 Audit log and events** | ✅ [`src/modules/audit`](src/modules/audit) (redacted, append-only audit log with a hash chain sealed after commit, action registry with EN/BN summaries, search, entity history, CSV export) and [`src/modules/events`](src/modules/events) (event registry, transactional outbox, relay, inbox, retries, dead letters, replay). M01 and M03 publish their events |
| **M08 Notifications core** | ✅ [`src/modules/notifications`](src/modules/notifications): catalogue router on M04 events, versioned EN/BN templates, preferences with mandatory categories, quiet hours, Redis SMS rate limits, dedupe, retries, in-app (bell, realtime), email and sandbox SMS, masked SMS log, OTP through M08. Push, broadcasts and the real SMS gateway come later (M21, Q59). **Phase 1 exit check passes** |
| **M06 Payments, ledger and escrow** | ✅ Step 1: [`src/modules/payments`](src/modules/payments): payment intents with Idempotency-Key, SSLCommerz adapter (and a built-in simulator for dev and tests), server-side verification, replay-safe IPN, append-only double-entry ledger with the balance enforced by a deferred constraint trigger, escrow holds (release, freeze, pool settlement for M21), refunds with the staff cap and master step-up, daily reconciliation, nightly invariants, finance desk API. bKash and Nagad direct, off-platform collections, COD, split shares and fee invoices come later |
| **M07 Payouts** | ✅ Step 1: [`src/modules/payouts`](src/modules/payouts): bKash and Nagad payout accounts (code to the registered phone, encrypted, masked, checked by finance against the NID name), payout runs from the ledger (daily, weekly ground and shop, idempotent, each payable entry once), fee-receivable netting and the minimum, holds (`PayoutHoldService` for M17 and M18), release with step-up and two-master approval above the threshold, manual sending with an audited 60-second number reveal, paid / failed / retry / cancel, refund payouts for M06 `manual_required`, payee summary and CSV statements. Disbursement APIs, bank and BEFTN, statements PDF and withdrawals (M21) come later |
| **M02 KYC (lite)** | ✅ [`src/modules/kyc`](src/modules/kyc): the member NID (front, back, selfie; number, DOB, legal name) uploaded through the API (type by magic bytes, size, SHA-256), encrypted fields, duplicate-NID and reused-image checks, the document panel API (`approve_documents`: audited file viewer, audited 60-second reveal), review through M05 (kind `document`), M01 consumers that move the member role and copy the verified identity, the `withdraw_winnings` gate, retention purge. Business-role documents and virus scanning come later |
| **M05 Moderation (lite)** | ✅ [`src/modules/moderation`](src/modules/moderation): `SubmissionService` (versions, supersede, checks, SLA), subject adapters by kind and permission, the claim lock (TTL, heartbeat, hard cap, force release), server-stored rubric ticks, decisions with reasons per kind, master override of a failing hard check and reopen (step-up `moderation.override`), `submission.applied` with the apply watchdog, SLA breach alerts, sanctions withdraw open submissions. First kind: `document` (M02). M21 adds `game_profile` and `esports_tournament`. Websocket queue push, diff view and the other kinds come later |
| **M21 Esports (step 1)** | ✅ [`src/modules/esports`](src/modules/esports): game UIDs (screenshot, M05 review, bans), squads, tournaments (`single_match`, `series`; M05 review, no self-approval, prize table locked), registration (row-locked slots, M06 `esports_entry` pool, waitlist offers, refunds, auto-cancel below the minimum), check-in, encrypted versioned room credentials revealed only to checked-in players (socket and API, every view audited), results with disputes (built in until M17), disqualification, finalise through `escrow.settlePool` with step-up `esports.money`, rankings, and M07 withdrawals. Jobs: `esports.tick` (every minute), `esports.rankings-recompute` (03:00 Dhaka). Group stages, auto-finalise and cheating reports are step 2 |
| **M09 Grounds (step 1)** | ✅ [`src/modules/grounds`](src/modules/grounds): listings with a live version beside edits (`live_snapshot`, review diff), courts and weekly hours, photos in the public bucket, versioned pricing rules (one draft, one published, history, "apply to all") with the pure shared calculator (`pricing.rules`, §6.1, both v3 payment options), quote and heatmap, the public `/grounds` (filters, facets, sorts) and detail, staff list, suspend, restore and remove, sanctions pause. With it: M03 places catalogue (sports, divisions, districts, areas, facilities, surfaces), M02 ground-owner documents lite, M01 business-role activation, M05 kind `ground`. The occupancy port waits for M10; closures and series come with it |
| **M10 Bookings (step 1)** | ✅ [`src/modules/bookings`](src/modules/bookings): the half-hour grid (Redis cache, live through `ground:{id}`), holds (gate `book_ground`: a verified phone) paying the advance or the full price into escrow (M06 purpose `ground_booking`), instant confirmation, late captures, member cancel with the refund preview, check-in releasing the money with the fee on the full value (`escrow.releaseInTx` `feeBase`), no-show, auto-complete after 24 h (Q68), extend, the venue balance, walk-ins and extensions owing the fee as a receivable (`fees.accrueReceivable`), owner and platform cancels, moves, the owner timeline, staff list and platform cancel. One occupancy table, `booking_slots`, with an exclusion constraint; M10 registers the M09 occupancy port. With it: M09 step 2 closures and weekly series, the "most open hours" sort. The pure `bookings.rules` (state machine, windows, v3 money plans) has a 100% gate |
| **M19 Dashboards (step 1)** | ✅ [`src/modules/analytics`](src/modules/analytics): read models only. Facts (`kpi_fact_booking`, court-day occupancy, payments, ledger fee lines, esports entries and tournaments) are written from the events by re-reading each record through its owner's service, guarded twice against replays; four day-grained materialised views refresh CONCURRENTLY (`asOf`); a nightly reconcile repairs drift and alerts masters. The ground owner's Overview and Analytics (revenue gross, occupancy, bookings, repeat teams, four charts), the member's Overview, the platform overview (GTV with venue money, fee revenue, take rate, esports; master or `view_analytics`), "Needs your action" and CSV exports. The pure `analytics.rules` (Dhaka periods, deltas, v3 earned, take rate) has a 100% gate |
| Everything else | Not started |

## Quick start

```bash
cp .env.example .env              # then set real secrets (see the comments in the file)
docker compose up -d              # PostgreSQL 17 (host port 55432), Redis 7.4, Mailpit, SeaweedFS (S3); also creates kriraghor_test
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

Every process also serves `/health/live`,  `/health/ready` (DB + Redis, 503 while draining) and `/metrics` (Prometheus) on `OPS_PORT` (9464). That port is never exposed through the ingress. On SIGTERM a process fails readiness, waits `SHUTDOWN_DRAIN_MS`, then closes its servers, queues, Redis and DB in order.

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
Expected result: every test green and the coverage gate (100% on the settings and catalogue validators, the audit redactor, the retry backoff and the event registry rules) (unit tests plus end-to-end tests against a real PostgreSQL test database and Redis). The tests cover:
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

**M06 (payments, ledger and escrow)** runs unattended: `node postman/run-m06.js` (master, payer and payee; the simulator plays the gateway; 23 requests, 41 assertions). Checklist: [`postman/M06-acceptance-checklist.md`](postman/M06-acceptance-checklist.md).

**M02 (KYC lite)** runs unattended: `node postman/run-m02.js` (a master and a member; uploads from `postman/fixtures`; reviewed through M05; 21 requests, 33 assertions). Checklist: [`postman/M02-acceptance-checklist.md`](postman/M02-acceptance-checklist.md).

**M05 (moderation lite)** runs unattended: `node postman/run-m05.js` (master A, reviewer B, two members with submitted NIDs; claim, rubric, reasons, reopen with step-up; 28 requests, 47 assertions). Checklist: [`postman/M05-acceptance-checklist.md`](postman/M05-acceptance-checklist.md).

**M07 (payouts, the Phase 2 exit check)** runs unattended: `node postman/run-m07.js` (two masters, a payer and a payee with a released ৳100 charge; account, run, four-eyes, reveal, paid; 21 requests, 38 assertions). Checklist: [`postman/M07-acceptance-checklist.md`](postman/M07-acceptance-checklist.md).

**M21 (esports step 1)** runs unattended: `node postman/run-m21.js` (masters A and B, two players; a local test clock moves the stored times between steps; UID review, authoring and review, paid registration, check-in, room reveal and audited views, results, a dispute, finalise with step-up, winnings, leaderboard, the KYC gate on withdrawal; 60 requests, 91 assertions). Checklist: [`postman/M21-acceptance-checklist.md`](postman/M21-acceptance-checklist.md).

**M19 (dashboards step 1)** runs unattended: `node postman/run-m19.js` (master A, an owner with a fixture ground, a member; a played booking and a member cancel feed the facts; the owner, member and platform dashboards, actions, CSV exports and the nightly reconcile; 24 requests, 50 assertions). Checklist: [`postman/M19-acceptance-checklist.md`](postman/M19-acceptance-checklist.md).

**M10 (bookings step 1)** runs unattended: `node postman/run-m10.js` (master A, two owners with a fixture ground at ৳2,000/h flat and a 25% advance, two members; holds, payment through the simulator, check-in, the venue balance, extend, member and owner cancels, no-show, auto-complete, walk-in, closures, series, staff and the ledger at the end; 50 requests, 94 assertions). Checklist: [`postman/M10-acceptance-checklist.md`](postman/M10-acceptance-checklist.md).

**M09 (grounds step 1)** runs unattended: `node postman/run-m09.js` (masters A and B, an owner who applied as a ground owner; business documents, the role, a ground with a court and three photos through review, public list, detail and quote, pricing draft and publish, a live edit with a diff, pause, staff suspend and restore; 69 requests, 115 assertions). Checklist: [`postman/M09-acceptance-checklist.md`](postman/M09-acceptance-checklist.md).

**M08 (notifications, the Phase 1 exit check)** runs unattended: `node postman/run-m08.js` (two masters with emails, a member and an in-process worker; 14 requests, 26 assertions). Checklist: [`postman/M08-acceptance-checklist.md`](postman/M08-acceptance-checklist.md).

**M04 (audit log and events)** runs unattended the same way: `node postman/run-m04.js` (it also runs a small in-process worker for the relay, consumers and exports). Checklist: [`postman/M04-acceptance-checklist.md`](postman/M04-acceptance-checklist.md).

**M03 (settings and esports catalogue)** runs unattended: `node postman/run-m03.js` resets the test database, signs in two masters, pre-mints step-up tokens and runs [`postman/kriraghor-settings.postman_collection.json`](postman/kriraghor-settings.postman_collection.json) with the Postman CLI (22 requests, 37 assertions). Checklist: [`postman/M03-acceptance-checklist.md`](postman/M03-acceptance-checklist.md).

### 3. Inspect the database
```bash
docker exec -it kriraghor-postgres psql -U kriraghor -d kriraghor
```
```sql
SELECT action, actor_id, entity_type, created_at FROM audit_logs ORDER BY id DESC LIMIT 20;
SELECT role, status FROM user_roles;
SELECT id, audience, device_label, revoked_at, revoke_cause FROM sessions;
\q
```

## Running in Kubernetes

The image is built from the [`Dockerfile`](Dockerfile): production dependencies are installed on `node:24.16.0-bookworm-slim`, and the runtime is **distroless Node 24 (Debian 13)**, pinned by digest: no shell, no npm, no package manager. It runs as uid 1000 and needs no writable filesystem. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs lint, the tests against PostgreSQL and Redis, the OpenAPI drift check, the image build and a Trivy scan that fails on fixable HIGH or CRITICAL findings.

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
├─ db/migrations/         Schema (sequelize-cli). Helpers in db/migration-helpers: pg-v1 is frozen, pg-v2 is the re-runnable (`ensure*`) set new migrations should use
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
   ├─ notifications/      M08 catalogue, router, templates, prefs, delivery (in-app, email, SMS), bell API, delivery log
   ├─ payments/           M06 intents, attempts, IPN, refunds, ledger (rules + service), escrow, reconciliation, invariants
   ├─ payouts/            M07 payout accounts, runs, holds, approvals, manual disbursement, refund payouts (rules + service)
   ├─ kyc/                M02 NID uploads, submissions, document panel, retention (rules + service), M05 adapter (kyc.moderation.js); M01 follows through users/kyc.consumers.js
   ├─ moderation/         M05 submissions, adapters, claims, rubric, decisions, override, reopen, jobs (rules + service)
   ├─ grounds/            M09 listings, courts, hours, photos, pricing (pricing.rules: the shared calculator), public read side, occupancy port, reads for M10, M05 adapter; closures and series (step 2)
   ├─ analytics/          M19 facts from events, materialised views, dashboards, actions, CSV exports (analytics.rules: periods and KPI formulas)
   ├─ bookings/           M10 availability, holds, my bookings, the owner's day, settlement through M06 (bookings.rules: state machine and v3 money), the occupancy implementation
   └─ esports/            M21 profiles, squads, tournaments, registrations, rooms, results, prizes, rankings, lifecycle tick, M05 adapters and M06 hook (rules + services)
src/providers/payments/   SSLCommerz adapter and the SSLCommerz-compatible simulator (dev and tests only)
scripts/                  release.js (migrate + reference seed), create-master.js (first master, CLI only), openapi.js (writes openapi.json)
src/db/seed/              Reference seed (versioned JSON: settings, esports catalogue, message templates)
postman/                  collection builder, collection, guide and acceptance checklist
tests/                    Jest unit and Supertest e2e (real PostgreSQL test database and Redis)
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

## API (M06)

| Endpoint | Access | Notes |
|---|---|---|
| `GET /payments/:id` · `POST /payments/:id/attempts` (Idempotency-Key) · `POST /payments/:id/verify` · `GET /me/payments` | payer | The pay page and the result page; success is decided by the server (validation API), never by the browser |
| `POST /webhooks/sslcommerz` · `GET`/`POST /payments/return/sslcommerz` | gateway | IPN stored once per event and re-validated; the return verifies, then 303s to `WEB_APP_URL/pay/:id/result` |
| `POST /admin/payments/test-charges` (Idempotency-Key) | master, `PAYMENTS_TEST_CHARGES` | Dev and staging only |
| `GET /admin/payments` · `/admin/payments/:id` · `/admin/payments/config` | `view_payouts` or master | Detail has attempts, refunds, the hold and ledger postings |
| `POST /admin/refunds` (Idempotency-Key) · `GET /admin/refunds` · `POST /admin/refunds/:id/approve` · `/reject` | `refund_small` (up to `refunds.staff_limit_poisha`) or master; decisions need step-up `refund.large` | `202 pending_master` when escalated |
| `GET /admin/ledger/accounts` · `/accounts/:id/entries` · `/transactions/:id` · `/trial-balance` · `/invariants` | `view_payouts` or master | Balances are computed from entries |
| `GET /admin/escrow` · `POST /admin/escrow/:id/release` · `/freeze` · `/unfreeze` | read: `view_payouts`; actions: master + step-up `escrow.manage` | |
| `GET /admin/reconciliation/runs` · `/runs/:id/items` · `POST /admin/reconciliation/runs` · `/items/:id/resolve` | read: `view_payouts`; run and resolve: master | One run per provider and Dhaka business day |

**Taking money in a module:** register the purpose in [`payments.purposes.js`](src/modules/payments/payments.purposes.js) (vertical, escrow account, pooled or not) and, if a late capture must be refused, `purposes.register(purpose, { onCaptured })`. Then call `payments.createIntent({ purpose, purposeId, payerId, amount, title, payeeId | groupRef, releaseRule, idempotencyKey })` at obligation time (the fee is snapshotted then), react to `payment.succeeded` / `payment.failed` / `payment.expired`, and use `escrow.releaseInTx`, `refunds.createInTx` or `escrow.settlePool`. Money only moves through `ledger.post` with a balanced, idempotent set of lines.

## Differences from the M06 spec

| Spec | Now | Why |
|---|---|---|
| `REVOKE UPDATE, DELETE` grants | A BEFORE UPDATE OR DELETE trigger (`kg_forbid_change()`) on all three ledger tables (plus the model guards); the balance check is the spec's deferred constraint trigger | Same pattern as `audit_logs`; grants need a separate migration user (Q140) |
| `payment_purpose` Postgres ENUM | VARCHAR validated by a code registry (`payments.purposes.js`) | New purposes need no migration |
| Pool settlement posts Dr subsidy / Cr escrow first, then pays out of escrow | One posting: Dr each hold + Dr `prize_subsidy_expense` / Cr payables + Cr `fee_revenue:esports` | Same effect on every account; escrow never goes negative either way |
| Refund statuses | Adds `rejected` (master rejects an escalation) and a `source` (escrow, goodwill, suspense); `kind` adds `amount_mismatch` and `goodwill` | Spec had no reject path or money source |
| Daily settlement-file reconciliation | Query-based (validation and refund status per attempt and refund of the day); settlement and MDR import later | SSLCommerz has no settlement API (open question) |
| bKash Tokenized, Nagad, saved wallets (FR-21) | Not yet; SSLCommerz covers bKash, Nagad and cards | Q9: aggregator first |
| Off-platform collections, COD, split shares, fee invoices (FR-15, FR-16, FR-17, FR-20) | Not yet | Built with M10 and M13, their producers |
| Manual ledger adjustments (four-eyes) | Reversals only | Later |

## API (M07)

| Endpoint | Access | Notes |
|---|---|---|
| `GET /me/payout-accounts` · `POST /me/payout-accounts/otp` · `POST /me/payout-accounts` | payee | bKash or Nagad; the code goes to the registered phone; numbers are only ever masked |
| `GET /me/payouts` · `/summary` · `/:id` · `/:id/statement.csv` | payee | The summary uses the same calculation as the run (FR-16) |
| `GET /admin/payouts` · `/:id` | `view_payouts` or `release_payouts` | Counts per status for the desk tabs |
| `POST /admin/payouts/:id/release` (Idempotency-Key) · `/retry` · `/reveal` | `release_payouts` + step-up `payout.approve` | Release up to `payouts.four_eyes_threshold_poisha`; the reveal is audited (critical), never replayed or logged |
| `POST /admin/payouts/:id/approve` (Idempotency-Key) | master + step-up `payout.approve` | Two different masters above the threshold; step 2 releases |
| `POST /admin/payouts/:id/mark-paid` (Idempotency-Key) · `/mark-failed` · `/cancel` · `/hold` · `/lift-hold` | `release_payouts` | Risk freezes are lifted on the Risk desk only |
| `GET /admin/payout-batches` · `POST /admin/payout-batches/run` | read: `view_payouts`; run: master | The hourly `payouts.schedule` job builds the due runs |
| `GET /admin/payout-accounts` · `POST /:id/verify` · `/reject` | read: `view_payouts`; decide: `release_payouts` | Account name next to the NID legal name; same-wallet warning |

**Paying a module's payees:** give the payment purpose a `payoutSchedule` in [`payments.purposes.js`](src/modules/payments/payments.purposes.js) (`daily`, `ground_weekly`, `shop_weekly`, or `withdraw` for money the payee withdraws). Released money then reaches the payee in the next run. Holds for disputes and risk go through `holds.service` (`place`, `release`).

## API (M02)

| Endpoint | Access | Notes |
|---|---|---|
| `GET /me/verification` | member | Checklist (phone, NID), badge, unlocks and limits; `?locale=bn` |
| `POST /me/documents/files?slot=front|back|selfie` | member | Raw body (JPEG, PNG or PDF), checked by its first bytes; rate-limited per account |
| `POST /me/documents` · `GET /me/documents/:id/files/:fileId` | member | Submit the NID (number, DOB, legal name, three file ids, consent); view your own upload |
| `GET /admin/kyc/documents/:id` · `/:id/files/:fileId` | `approve_documents` | The document panel on the Moderation desk; every file view audited |
| `POST /admin/kyc/documents/:id/reveal-nid` | `approve_documents` | Reveal with a reason (critical audit, 60 s). Decisions are M05's (`/admin/submissions`) |

**Who reads the result:** M01 moves the member role from the M02 events; other modules call `kyc.getVerifiedIdentity(userId)` or use the gate (`requireGate('withdraw_winnings')`). `NID_HMAC_SECRET` keys the NID hash: never rotate it without re-hashing.

## API (M05)

| Endpoint | Access | Notes |
|---|---|---|
| `GET /me/submissions` · `POST /me/submissions/:id/withdraw` | signed in | My submissions with reasons; withdraw where the kind allows it |
| `GET /admin/submissions` · `/stats` · `/:id` | `approve_documents` or `approve_listings` (per kind; masters all) | Queue (oldest deadline first; `status`, `kind`, `claimed`, `overdue`, `q`), KPIs, detail; a kind you may not review is `404` |
| `POST /admin/submissions/:id/claim` · `/heartbeat` · `/release` · `PUT /:id/ticks` | same | The lock (`ALREADY_CLAIMED` names the holder), keep it, release it (`force` for masters), rubric ticks |
| `POST /admin/submissions/:id/decide` | same, `Idempotency-Key` | approve / request_changes / reject; `override` (master, step-up `moderation.override`) approves over a failing hard check |
| `POST /admin/submissions/:id/reopen` | master, step-up `moderation.override` | A decided submission back to the queue (critical audit) |

**Adding a kind:** widen the `submissions.kind` CHECK in a migration, seed its rubric and reasons in `moderation.v1.json`, register an adapter (`moderation.adapters.register({ kind, permission, checks, ownerWithdraw, lockedChecks })`), call `moderation.submit` from your module, and apply decisions in consumers of `submission.approved` / `.changes_requested` / `.rejected`, acknowledging with `submission.applied` (see `kyc/kyc.moderation.js`).

## API (M19)

| Endpoint | Access | Notes |
|---|---|---|
| `GET /me/dashboard?role=member|ground_owner&period=7w|qtr|yr` | signed in; the owner view needs an active `ground_owner` role (`ROLE_REQUIRED`) | Tiles (value, delta, sparkline), charts, `asOf`, definitions |
| `GET /me/dashboard/actions?role=` · `GET /admin/analytics/actions` | signed in · staff | "Needs your action" from the owning modules |
| `GET /me/dashboard/export?dataset=owner_bookings|owner_revenue|member_payments` | as the screen | CSV, audited, `analytics.exports_per_hour` |
| `GET /admin/analytics/overview?period=` · `/admin/analytics/export?dataset=platform_daily` | master or `view_analytics` | Platform overview and its CSV |
| `GET /kpis/:key/definition?locale=` | public | What a tile counts |

## API (M10)

| Endpoint | Access | Notes |
|---|---|---|
| `GET /grounds/:id/availability?date=` | public (signed in: "yours") | Half-hour cells per court with the hourly rate; 7-day window |
| `POST /bookings/holds` (Idempotency-Key) · `/bookings/:id/pay` · `/bookings/:id/release` | gate `book_ground` (a verified phone) | `payment: advance\|full` (v3); 10-minute hold; `409 SLOT_UNAVAILABLE` from the exclusion constraint |
| `GET /me/bookings` · `/me/bookings/:id` · `POST /cancel-preview` · `/cancel` | the member | Cancel before the start with `expectedRefund` (`REFUND_CHANGED`); the advance is retained, above it refunded (Q120) |
| `GET /me/ground-bookings?groundId=&date=` · `/:id` · `POST /:id/check-in` · `/no-show` · `/extend` · `/collect-balance` · `/cancel` · `GET /:id/move-targets` · `POST /:id/move` | gate `list_ground`, own grounds (`NOT_OWNER`) | Check-in releases the online money minus the fee on the full price; no-show after the grace; extensions owe the fee at the venue |
| `POST /me/grounds/:id/walk-ins` (Idempotency-Key) | same | Paid at the counter; the fee is a receivable |
| `POST /me/grounds/:id/closures/preview` · `/closures` · `GET /closures` · `POST /me/closures/:id/reopen` · `/end-now` | same (M09 step 2) | `409 CLOSURE_CLASHES` with the list; up to 90 days ahead |
| `POST /me/grounds/:id/series/preview` · `/series` · `GET /series` · `GET /me/series/:id` · `POST /weeks/:week/skip` · `/restore` · `/end` | same (M09 step 2) | Weekly bookings paid at the venue; `SERIES_CLASHES` unless `skipClashingWeeks` |
| `GET /admin/bookings` · `/admin/bookings/:id` · `POST /admin/bookings/:id/cancel` | `manage_users` or `view_payouts`; cancel: master + step-up `escrow.manage` | The detail carries the ledger trail |

## API (M09)

| Endpoint | Access | Notes |
|---|---|---|
| `GET /catalog/sports` · `/locations` · `/areas?districtId=&service=grounds&q=` · `/facilities` · `/surfaces` | public | M03 places catalogue (cacheable, ETag) |
| `GET /grounds` · `/grounds/:slug` · `POST /grounds/:id/quote` | public | Live grounds only (the public version): filters, facets, sorts; detail with courts, hours, price table and the v3 payment line; the quote shows both payment options |
| `GET|POST /me/grounds` · `GET|PATCH /me/grounds/:id` · `/submit` · `/withdraw` · `/pause` · `/resume` | gate `list_ground` (active `ground_owner`), own grounds (`NOT_OWNER`) | Draft, review (M05 kind `ground`), live edits beside the public version |
| `POST /me/grounds/:id/courts` · `PATCH /me/courts/:id` · `/retire` · `PUT /me/courts/:id/hours` | same | Courts `pending` until approved; hours on the half-hour grid; retire through the occupancy port |
| `POST /me/grounds/:id/photos` (raw) · `PUT /photos/order` · `POST /photos/:photoId/remove` | same | JPEG, PNG or WebP by first bytes, to the public bucket |
| `/me/grounds/:id/pricing` (GET) · `/draft` (PUT) · `/draft/discard` · `/publish` · `/history` · `/heatmap` · `/quote` | same | One draft and one published version; base locked in review; "apply to all"; history with summaries |
| `GET /admin/grounds` · `/admin/grounds/:id` | `approve_listings` or `manage_users` | The list and the working copy with the public version and rules |
| `POST /admin/grounds/:id/suspend` · `/restore` · `/remove` | `manage_users` (suspend), master (restore, remove) | With a reason; critical audit |
| `GET /me/verification?role=ground_owner` · `POST /me/documents` (`trade_license`, `deed_or_lease`, `tin`) | signed in, active member, role applied | M02 business documents lite; approval of the required ones activates `ground_owner` |

## API (M21)

| Endpoint | Access | Notes |
|---|---|---|
| `GET /esports/games` · `/tournaments` · `/tournaments/:slugOrId` · `/:id/standings` · `/matches/:id` | public | Catalogue, published tournaments (filters, cursor), detail with the prize table and schedule, standings, posted results |
| `GET /esports/leaderboards` · `/top-players` · `/players/:handle` | public | Rolling or season rankings (the formula is in the response), the home strip, a player page (UIDs masked) |
| `POST /esports/tournaments/:id/registrations` | gate `join_esports`, `Idempotency-Key` | Solo (`players`) or squad (`squadId`, `players`, `substitutes`); returns the M06 pay link, or `waitlisted` |
| `POST /me/esports/uploads` · `GET|POST /me/esports/profiles` · `/profiles/:id/unlink` | signed in | Raw JPEG or PNG screenshot (first bytes checked), then a UID for review |
| `/me/esports/squads` (create, join by code, invite, leave, captain, remove) · `/squad-invites/:id/accept|decline` | signed in | One active squad per game; size = team size + `max_subs` |
| `GET /me/esports/registrations` · `POST /registrations/:id/accept-offer|withdraw|check-in` · `PUT /prize-split` | the entry's players | Offers, withdraw (refund before close), check-in in the window, the captain's split |
| `GET /me/esports/matches/:id/room` | checked-in players | `no-store`, rate-limited, audited; `409 ESPORTS_ROOM_NOT_REVEALED` before `reveal_at` |
| `POST /me/esports/matches/:id/evidence|disputes` · `GET /me/esports/winnings` | the match's players | Evidence and disputes in the window; prizes and the withdrawable balance |
| `GET|POST /me/withdrawals` · `/available` | gate `withdraw_winnings` (NID KYC) for POST, `Idempotency-Key` | An M07 payout of kind `withdrawal` (minimum, daily limit, one open) |
| `/admin/esports/tournaments` (list, create, get, PATCH, `submit`, `streams`, `checkins`, `finalise-preview`) | `manage_esports` (list and matches also `enter_results`) | Drafts go to M05 (`esports_tournament`); the prize table locks on approval |
| `POST /admin/esports/tournaments/:id/cancel` · `/finalise` | `manage_esports`, step-up `esports.money` | Cancel with 100% refunds; finalise through `escrow.settlePool` (idempotent) |
| `/admin/esports/matches/:id` · `/room` (GET, PUT, `rotate`, `reveal-now`, `view`, `views`) · `/cancel` | `manage_esports` | Credentials are never returned except through `view` (no-store, logged and audited like a player read) |
| `PUT /admin/esports/matches/:id/results` · `POST /results/post` | `manage_esports` or `enter_results` | Draft rows, then post (opens the dispute window) |
| `GET /admin/esports/disputes` · `POST /disputes/:id/resolve` · `POST /registrations/:id/check-in|disqualify` · `/uid-bans` · `/profiles/:id/screenshot` | `manage_esports` (screenshot also `approve_listings`) | Reject or correct; staff check-in; DQ (prize forfeit or reversal); bans; the audited screenshot |

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
| Partial unique index on `staff_permissions` | One row per (user, permission) with `revoked_at`; history lives in `audit_logs` | Simpler grants and revokes; could become a partial index later |
