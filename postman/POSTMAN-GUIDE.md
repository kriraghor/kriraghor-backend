# Postman Guide: Testing the Kriraghor Backend (M01 Auth and RBAC)

A complete walkthrough. You don't need any earlier Postman experience.

---

## Part A: Start the backend (do this every time)

Open a terminal (PowerShell or VS Code terminal) and run:

```bash
cd E:\kriraghor\kriraghor-backend
docker compose up -d
npm run db:migrate
npm run dev
```

- **Keep this terminal open.** The server is running in it, and the **SMS codes are printed here**.
- When you see `Kriraghor API listening on :4000/api/v1`, it's ready.
- Check it in a browser: http://localhost:4000/health shows `{"status":"ok","db":"up"}`.
- **Email codes** go to Mailpit, a local test inbox: http://localhost:8025.

> If Docker says it cannot connect, open the **Docker Desktop** app first and wait until it shows *Engine running*.

---

## Part B: Import the collection (once)

1. Open Postman.
2. **Delete any old copies** of "Kriraghor API: M01 Auth & RBAC" in the left sidebar under **Collections**: right-click → **Delete**.
3. Click **Import**. It's the icon next to the **+** at the top of the left sidebar. You can also use **Ctrl + O**, or **File → Import**.
4. Drag in this file, or click *files* and choose it:
   `E:\kriraghor\kriraghor-backend\postman\kriraghor-auth.postman_collection.json`
5. If Postman asks to "connect a local project / folder", choose **Skip / Cancel**. Only import the file.
6. You now see the collection with these folders:
   - `0. Smoke (no codes needed)`: run it first; every request has a pass/fail test
   - `1. Member signup (OTP) and gate`
   - `1b. Email OTP, username, Google`
   - `2. Password, sessions, refresh`
   - `3. Admin portal: master (TOTP, step-up, RBAC)`

---

## Part C: Learn 4 small things first

### C1. Collection variables (the most important thing)
The requests use placeholders like `{{phone}}`, `{{otp}}` and `{{accessToken}}`. Their values live in the collection's **Variables** tab.

1. Click the **collection name** in the sidebar ("Kriraghor API: M01 Auth & RBAC").
2. Open the **Variables** tab.
3. Type in the **Value** column. If you see both *Initial value* and *Current value*, edit **Current value**.
4. Press **Ctrl + S** to save. **If you don't save, the requests still use the old value.**

| Variable | You set it? | Meaning |
|---|---|---|
| `baseUrl` | No (already `http://localhost:4000/api/v1`) | Server address |
| `phone` | **Yes**: a new number for each new test user, e.g. `01812345601` | Member's phone |
| `email` | **Yes**: e.g. `mahmudur346@gmail.com` | Member's email (the code goes to Mailpit, not real Gmail) |
| `username` | **Yes**: e.g. `mahmudur_r` | Member's username |
| `masterPhone` | No (`01711000001`) | The master admin created by `npm run create:master` |
| `otp` | **Yes**: paste each new SMS or email code | 6-digit login code |
| `totp` | **Yes**: paste the code from your authenticator app | Staff and master 2FA code |
| `accessToken`, `signupToken`, `challengeToken`, `stepUpToken`, `targetUserId` | **No**: filled automatically | Saved from responses |

Tip: hover the mouse over a `{{variable}}` in a request to see its current value.

### C2. Sending a request
Click a request in the sidebar, then click the blue **Send** button. The response appears in the lower half:
- the **status** (e.g. `200 OK`, `201 Created`, `403 Forbidden`)
- the **Body** (JSON)

### C3. Don't change the URL or Params
Requests are ready to use. **Do not add query params** such as `?email=...`. All inputs go through the variables or the **Body** tab.

### C4. Where the codes come from
- **SMS code**: in the `npm run dev` terminal, look for:
  ```
  [sms:console] to=+8801812345601
  Your Kriraghor code is 482913. It expires in 5 minutes...
  ```
- **Email code**: open http://localhost:8025, click the newest email ("Your Kriraghor code"), and read the big number.
- A code works **once**, expires after **5 minutes**, and you can request a new one only after **60 seconds**.

---

## Part D: Test 1, sign up a member with a phone number
Folder: **1. Member signup (OTP) and gate**

| Step | What to do | You should see |
|---|---|---|
| 1 | Variables: set `phone` to a new number, e.g. `01812345601` → **Ctrl + S** | |
| 2 | **Send OTP** → Send | `202 Accepted`, `"sent": true` |
| 3 | Copy the code from the terminal → put it in variable `otp` → **Ctrl + S** | |
| 4 | **Verify OTP (gives signupToken)** → Send | `200`, `"status": "signup"`, a long `signupToken` |
| 5 | **Sign up with a ground_owner application** → Send | `201`, `"status": "signed_in"`, `accessToken`; roles `ground_owner: applied` and `member: applied` |
| 6 | **Me** → Send | `200`, your profile |
| 7 | **Gate: book a ground** → Send | `"allowed": false, "code": "KYC_REQUIRED"`: the NID isn't verified yet (correct) |
| 8 | **RBAC: member token on /admin** → Send | `401`, `"code": "TOKEN_AUDIENCE_INVALID"`: customer tokens never work on the admin API (correct) |

If step 4 shows `"status": "signed_in"` instead, this phone already has an account and you were simply logged in. Use a new `phone` value to test sign-up again.

---

## Part E: Test 2, email OTP, username and password
Folder: **1b. Email OTP, username, Google**

| Step | What to do | You should see |
|---|---|---|
| 1 | Variables: set `email` (e.g. `mahmudur346@gmail.com`) and `username` (e.g. `mahmudur_r`) → **Ctrl + S** | |
| 2 | **Send OTP by EMAIL** → Send | `202` |
| 3 | Open http://localhost:8025, copy the code into `otp` → **Ctrl + S** | |
| 4 | **Verify email OTP** → Send | `"status": "signup"` + `signupToken` |
| 5 | **Sign up with email + username + password** → Send | `201`, `"emailVerified": true`, your `username` |
| 6 | **Is a username available?** → Send | `"available": false` (because you just took it) |
| 7 | **Login with USERNAME + password** → Send | `200`, `"status": "signed_in"` |
| 8 | **Login with EMAIL + password** → Send | `200`, the same user `id` |
| 9 | **Change my username** → Send | `200`, `"username": "fahim.rahman"` |
| 10 | **Add/change email: send code** → Send, put the Mailpit code in `otp` → **Ctrl + S** → **Add/change email: confirm code** | `202`, then `200 "verified": true` |
| 11 | **Sign in with Google** | `400 GOOGLE_NOT_CONFIGURED` until a Google Client ID is set up (expected for now) |

The password used by the collection is `Turf-Booking-2026`.

---

## Part F: Test 3, sessions and refresh
Folder: **2. Password, sessions, refresh**. Run it after Part D, with the same `phone`. Run these one after another.

| Step | Request | You should see |
|---|---|---|
| 1 | **Login with password** | `200`, `"status": "signed_in"`. The Part D signup already set the password `Turf-Booking-2026` |
| 2 | **Refresh (rotates the cookie)** | `200`, a new `accessToken`. Click **Cookies** (under Send) → `localhost` → `kg_rt` changes each time. The request sends `Origin` and `X-CSRF-Token` for you (ADR-004); without them you get `403` |
| 3 | **List my sessions** | A list with one session marked `"current": true` |
| 4 | **Apply for the organiser role** | `201` |
| 5 | **Update profile** | `401 AUTHZ_STALE`: your role changed, so the old token is stale (correct). Run **Refresh**, then **Update profile** again → `200` |
| 6 | **Logout (this device)** | `204` |
| 7 | **Me** (folder 1) | `401`: you're logged out (correct) |

---

## Part G: Test 4, master admin (2FA, approvals, staff)
Folder: **3. Admin portal: master (TOTP, step-up, RBAC)**

### G1. Install an authenticator app (once)
On your phone, install **Google Authenticator** (or Microsoft Authenticator or Authy).

### G2. First master sign-in and 2FA setup
| Step | Request | What to do / see |
|---|---|---|
| 1 | **Send OTP to master** | `202`. Copy the code for `+8801711000001` from the terminal into `otp` → **Ctrl + S** |
| 2 | **Admin login with OTP (gives challengeToken)** | `"status": "two_factor_setup_required"` (first time). There's no access token yet: 2FA is required. Staff can only sign in here; the customer **Verify OTP** answers `403 STAFF_USE_ADMIN_PORTAL` |
| 3 | **TOTP setup (first time only)** | The response has a `"secret"` like `JBSWY3DPEHPK3PXP` |
| 4 | In the app: **+** → **Enter a setup key** → Account name: `Kriraghor`, Key: the secret, Type: **Time based** → Add | The app shows a 6-digit code that changes every 30 s |
| 5 | Put the current app code in `totp` → **Ctrl + S** → **TOTP activate (first time), signs in** | `200`, `"status": "signed_in"` |
| 6 | **Admin me (master holds every permission)** | `"isMaster": true` and the full permissions list. The token is saved as `adminAccessToken`, separate from the member's `accessToken` |

Next time the master signs in: **Send OTP to master** → **Admin login with OTP** (now `"two_factor_required"`) → put the app code in `totp` → **TOTP verify (later sign-ins)**.

### G3. Admin actions (the member from Part D is the target)
`targetUserId` was saved automatically when you signed up the member. Run these in order:

| Step | Request | You should see |
|---|---|---|
| 1 | **Search users (masked phone)** | The user list; the phone looks like `+880181•••601` |
| 2 | **Approve ground_owner role** (before member) | `409 MEMBER_NOT_ACTIVE`: the NID must be approved first (correct) |
| 3 | **Approve member role (NID verified)** | `200 "status": "active"` |
| 4 | **Approve ground_owner role** | `200 "status": "active"` |
| 5 | **Suspend user** | `200 "status": "suspended"` |
| 6 | **Restore user** | `200 "status": "active"` |
| 7 | **Ban WITHOUT step-up** | `403 STEP_UP_REQUIRED`: dangerous actions need fresh 2FA (correct) |
| 8 | Put a **new** app code in `totp` → **Ctrl + S** → **Step-up for staff.write** | `200`, a `stepUpToken` (saved automatically) |
| 9 | **Make the user staff (approve_documents, manage_users)** | `201` |
| 10 | **Make the user staff** again (same step-up) | `403 STEP_UP_REQUIRED`: a step-up works only once (correct) |
| 11 | **Staff list and permission matrix** | Two staff; the master has every permission |
| 12 | New app code in `totp` → **Ctrl + S** → **Step-up for staff.write (again)** → **Save permission changes** | `200`, `"applied": 2` |

**Important about TOTP codes:** each code can be used **only once**. Before every step-up, wait for the app to show a **new** code and put that one in `totp`. Reusing a code returns `TOTP_REPLAYED`.

---

## Part H: When something goes wrong

| You see | Meaning | Fix |
|---|---|---|
| `422 VALIDATION_FAILED`, field `signupToken` "Too small" | `signupToken` is empty | Run **Verify OTP** first and check it returned `"status": "signup"`. Use only one copy of the collection |
| `400 OTP_INVALID` | Wrong or old code, or the `otp` variable wasn't saved | Copy the newest code, then **Ctrl + S** |
| `400 OTP_EXPIRED` | More than 5 minutes passed | **Send OTP** again |
| `429 OTP_RATE_LIMITED` | Asked for a new code within 60 s | Wait one minute |
| `429 AUTH_LOCKED` | 5 wrong passwords | Wait 15 min, or sign in with an OTP |
| `401 AUTH_REQUIRED` | No or empty `accessToken` | Sign in (Verify OTP, Sign up or Login) |
| `401 TOKEN_EXPIRED` | The access token is older than 15 min | Run **Refresh** |
| `401 AUTHZ_STALE` | Your roles or permissions changed | Run **Refresh** |
| `401 SESSION_REVOKED` | You logged out, were suspended, or changed password | Sign in again |
| `400 TOTP_INVALID` / `TOTP_REPLAYED` | Wrong or reused authenticator code | Wait for a new code in the app |
| `ECONNREFUSED` / "Could not send request" | The server isn't running | Start `npm run dev` (Part A) |
| "Fix test script error" at the bottom | You have the old collection | Delete it and import the latest file |

## Part I: Look inside the database (optional)

```bash
docker exec -it kriraghor-postgres psql -U kriraghor -d kriraghor
```

```sql
SELECT id, phone, email, username, status, kyc_status FROM users;
SELECT user_id, role, status FROM user_roles;
SELECT action, created_at FROM audit_logs ORDER BY id DESC LIMIT 20;
\q
```

Next: work through `M01-acceptance-checklist.md` in this folder to sign off the module.
