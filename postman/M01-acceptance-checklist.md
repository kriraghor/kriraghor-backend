# M01 Identity and Access: Acceptance Checklist (Postman)

Work through this list before starting the next module. Tick each box when the result matches.
Request names refer to the **"Kriraghor API: M01 Auth & RBAC"** Postman collection.

## 0. Setup
- [ ] `docker compose up -d`. PostgreSQL, Redis, Mailpit and SeaweedFS are healthy (`docker compose ps`).
- [ ] `npm run db:migrate`. This reports *no pending migrations* or applies `add-session-audience`.
- [ ] `npm run dev`. `GET http://localhost:4000/health` → `{"status":"ok","db":"up"}`.
- [ ] Re-import the latest collection file (58 requests). Rebuild it with `node postman/build-collection.js`.
- [ ] `postman collection run postman/kriraghor-auth.postman_collection.json -i "0. Smoke (no codes needed)"` → **8 assertions, 0 failed**.
- [ ] `node postman/run-m01.js` (forgot password and the PASSWORD_CHANGED alert, unattended on the test database) → **6 assertions, 0 failed**.
- [ ] Mailpit opens at http://localhost:8025.
- [ ] `npm test` → **110 passed**. This covers the cases that are awkward to test by hand (marked 🤖 below).

> **Codes:** SMS codes appear in the `npm run dev` terminal. Email codes appear in Mailpit. Paste each one into the collection variable `otp` and save.
> **Fresh data:** use a new `phone` / `email` / `username` value for each run, or reset the DB (`npx sequelize-cli db:migrate:undo:all && npm run db:migrate && npm run create:master -- --phone 01711000001 --name "Ayesha Siddiqua" --employee-id KG-0001`).

## 1. Sign-up and sign-in methods
| # | Do | Expect |
|---|---|---|
| 1.1 | **Send OTP** (phone) → **Verify OTP** → **Sign up** | `202` → `status: "signup"` → `201`, `status: "signed_in"`. Roles are `member: applied` and `ground_owner: applied` |
| 1.2 | **Me** | Your profile. **No** `passwordHash`, NID or token fields |
| 1.3 | Send and verify an OTP again for the **same phone** | `status: "signed_in"`, not signup. Same user `id` |
| 1.4 | **Send OTP by EMAIL** → read the code in Mailpit → verify → sign up with username and password | The email arrives (EN + BN template). Signup returns `emailVerified: true` and your `username` |
| 1.5 | **Login with USERNAME + password**, then **Login with EMAIL + password**, then log in with the phone and password | All three `200`, all for the same user |
| 1.6 | **Is a username available?** for a used name, then a new one | `available: false` / `true` |
| 1.7 | **Change my username** to a name that is already taken, then to `admin`, then to `9abc` | `409 USERNAME_TAKEN` / `422` / `422` |
| 1.8 | **Add/change email**: send code → confirm in Mailpit | `202` → `200 verified: true`. Afterwards an email OTP login signs in the same user |
| 1.9 | *(only with a Client ID set)* **Sign in with Google** using a real ID token from the frontend | New user → `signup` + `signupToken` → **Sign up** works. The second time it returns `signed_in` |
| 1.10 | Without `GOOGLE_CLIENT_IDS`: **Sign in with Google** | `400 GOOGLE_NOT_CONFIGURED` |

## 2. Security behaviour
| # | Do | Expect |
|---|---|---|
| 2.1 | Click **Send OTP** twice within 60 s | Second call: `429 OTP_RATE_LIMITED` with a `Retry-After` header |
| 2.2 | Send an OTP to `01212345678` | `422 VALIDATION_FAILED` (invalid BD number) |
| 2.3 | Verify with a wrong code 5 times, then with the right code | "N attempts left" each time; finally the right code is refused (`OTP_INVALID`) |
| 2.4 | Log in with a wrong password 5 times, then the right one | `401 INVALID_CREDENTIALS` ×5, then `429 AUTH_LOCKED`. OTP sign-in still works |
| 2.5 | Log in with an unknown number and any password | `401 INVALID_CREDENTIALS`, the same response as a wrong password (no account enumeration) |
| 2.6 | Sign up with password `password123` | `400 PASSWORD_WEAK` |
| 2.7 | Call **Me** with no `Authorization` header | `401 AUTH_REQUIRED`, content type `application/problem+json` |
| 2.8 | Call **Me** with a token that has one character changed | `401` |
| 2.9 | 🤖 Old refresh token replayed → whole session family revoked | Covered by `npm test` (Postman's cookie jar always sends the newest cookie) |
| 2.10 | 🤖 OTP code expiry (5 min) and staff idle timeout (30 min) | Covered by `npm test`. Optionally wait 5 min and verify a code → `OTP_EXPIRED` |

## 2b. Cross-subdomain auth (ADR-004)
| # | Do | Expect |
|---|---|---|
| 2b.1 | **Refresh** with the `Origin` header removed | `403 CSRF_ORIGIN_REJECTED` |
| 2b.2 | **Refresh** with `X-CSRF-Token` emptied | `403 CSRF_TOKEN_INVALID` |
| 2b.3 | **Refresh** with `Origin: http://esports.kriraghor.localhost` (another app on the same site) | `200`: one session works across apps |
| 2b.4 | Any customer sign-in response | Cookies `kg_rt` (HttpOnly, Lax, path `/api/v1/auth`), `kg_si=1` and `kg_csrf` (both readable) |
| 2b.5 | **Admin login** with `Origin: {{webOrigin}}` | `403 CSRF_ORIGIN_REJECTED` |
| 2b.6 | 🤖 CSRF token from another session, admin cookie on the customer refresh, mobile body refresh | Covered by `npm test` |

## 3. Sessions
| # | Do | Expect |
|---|---|---|
| 3.1 | **Refresh (rotates the cookie)** | `200` with a new `accessToken`. The `kg_rt` cookie value changes (Postman → Cookies) |
| 3.2 | Log in from two places (e.g. Postman plus a second request with the header `X-Client-Type: mobile`), then **List my sessions** | Two sessions, one marked `current: true` |
| 3.3 | `DELETE /me/sessions/{id}` for the other session, then use that session's token | `204`, then `401 SESSION_REVOKED` |
| 3.4 | **Logout (this device)**, then **Me** | `204`, then `401` |
| 3.5 | `POST /me/password` (current and new password), then use the *other* session's token | Other sessions return `401`; the current one still works |
| 3.6 | Password reset: **Send OTP** with purpose `reset`, then `POST /auth/password/reset` | `200 reset: true`. Every old token returns `401`; the new password works |
| 3.6b | After the reset, sign in with the new password and open **My notifications** (folder 2b) | A `PASSWORD_CHANGED` alert (in-app, plus SMS and email in the logs). Changing the password while signed in (`POST /me/password`) alerts again |

## 4. RBAC and the gate
| # | Do | Expect |
|---|---|---|
| 4.1 | As a member: **RBAC: member token on /admin** | `401 TOKEN_AUDIENCE_INVALID` (customer tokens never work on the admin API) |
| 4.2 | **Gate: book a ground** before verification | `allowed: false, code: "KYC_REQUIRED"` |
| 4.3 | **Apply for the organiser role**, then call **Me** with the same token | `201`, then `401 AUTHZ_STALE`. **Refresh**, and **Me** shows `organiser: applied` |
| 4.4 | Self-apply for `master_admin` (edit the body) | `422` (not a self-service role) |
| 4.5 | As master: **Approve ground_owner role** *before* approving member | `409 MEMBER_NOT_ACTIVE` |
| 4.6 | As master: **Approve member role**, then the member refreshes and runs **Gate: book a ground** | `allowed: true` |
| 4.7 | Member: **Gate: list a ground** while ground_owner is still `applied` | `ROLE_PENDING`. After master approval it returns `allowed: true` |

## 5. Master admin, step-up and staff
| # | Do | Expect |
|---|---|---|
| 5.1 | Master: **Send OTP to master** → **Admin login with OTP** (first time) | `status: "two_factor_setup_required"` and **no access token** |
| 5.1a | Master: send and verify an OTP on the **customer** endpoint (`/auth/otp/verify`) | `403 STAFF_USE_ADMIN_PORTAL` |
| 5.2 | **TOTP setup** → add the secret to Google Authenticator or Authy → **TOTP activate** with the app's code | `signed_in`. **Admin me** shows `isMaster: true` and every permission; cookies `kg_art` (Strict), `kg_asi`, `kg_acsrf` appear |
| 5.3 | **Admin logout**, sign in again | `204`; then `two_factor_required` → **TOTP verify** → `signed_in` |
| 5.3a | **Admin token on a customer endpoint** | `401 TOKEN_AUDIENCE_INVALID` |
| 5.3b | **Admin refresh (admin cookie only)** | `200` with a new access token |
| 5.4 | Use the same TOTP code twice within 30 s | Second use: `400 TOTP_REPLAYED` |
| 5.5 | **Search users** (`?q=Fahim`) | Phone and email masked (`+880171•••678`) |
| 5.6 | **Suspend user**, then the member calls **Me** and tries to log in | Member `401`, login `403 ACCOUNT_SUSPENDED` |
| 5.7 | **Restore user** | The member can sign in again |
| 5.8 | **Ban WITHOUT step-up** | `403 STEP_UP_REQUIRED, scope: "user.ban"` |
| 5.9 | **Step-up for staff.write** (new code) → **Make the user staff** | `200 stepUpToken` → `201` |
| 5.10 | Send **Make the user staff** again with the same step-up token | `403 STEP_UP_REQUIRED` (single-use) |
| 5.11 | Step up with scope `user.ban`, then use that token on **Make the user staff** | `403` (wrong scope) |
| 5.12 | Body `permissions: ["edit_fees"]` on **Make the user staff** | `422 PERMISSION_NOT_GRANTABLE` |
| 5.13 | The new staff member is signed out of the customer apps; they sign in at the admin portal (**Admin login** → TOTP setup → activate) and call `GET /admin/users` | Works only if they hold `manage_users`. `GET /admin/staff` → `403` (master only) |
| 5.14 | Master: **Save permission changes** (revoke `manage_users`), then the staff member uses their old token | Sessions revoked → `401`. After signing in again, `GET /admin/users` → `403` |
| 5.15 | A staff member with `manage_users` tries to suspend the master | `403 MASTER_REQUIRED` |

## 6. Data checks (PostgreSQL)
`docker exec -it kriraghor-postgres psql -U kriraghor -d kriraghor`
- [ ] `SELECT password_hash FROM users LIMIT 3;`: values start with `$argon2id$`, never plain text.
- [ ] `SELECT code_hash FROM otp_codes LIMIT 3;`: 64-character hashes, never the 6-digit code.
- [ ] `SELECT refresh_token_hash, revoke_cause FROM sessions;`: hashes only; causes such as `rotation`, `logout`, `sanction`.
- [ ] `SELECT totp_secret_enc FROM staff_members;`: encrypted values (`xxx.yyy.zzz`), not a base32 secret.
- [ ] `SELECT action, actor_id, created_at FROM audit_logs ORDER BY id DESC LIMIT 30;` includes `user.registered`, `auth.signed_in`, `user_role.applied`, `user.suspended`, `user.restored`, `staff.invited`, `staff.permission_granted`, `auth.step_up_granted` and `user.searched`.

## 7. Sign-off
- [ ] All boxes above are ticked, or each deviation is written down as a ticket.
- [ ] Decisions confirmed by the product owner: Q1 (multi-role), Q2 (pro covers official and trainer), and Q24+ items that affect M01. See `../kriraghor-docs/decisions/open-questions.md` (Q33 is answered by ADR-004: separate staff accounts).
- [ ] Before production: real SMS gateway and SMTP provider, Google Client ID, strong secrets in `.env`, `COOKIE_SECURE=true`.
