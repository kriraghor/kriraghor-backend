# M08 Notifications core: Acceptance Checklist (Phase 1 exit check)

Work through this list before starting Phase 2. Tick each box when the result matches.
Request names refer to the **"Kriraghor API: M08 Notifications (Phase 1 exit check)"** collection
(`postman/kriraghor-notifications.postman_collection.json`, rebuilt with `node postman/build-collection-m08.js`).

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies migration `20261018000001`, seeds the 7 `notify.*` settings and the 48 EN/BN Phase 1 templates (insert-if-missing).
- [ ] `npm test`: everything green, including the coverage gate (100% on `notify.rules.js`: SMS encoding, quiet hours, prefs ∩ mandatory, renderer, dedupe). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m08.js` → **0 failed**. It resets `kriraghor_test`, signs in two masters with verified emails and a member, pre-mints step-up tokens and runs a worker loop (relay, consumers, deliveries) next to the API.
- [ ] `node postman/run-m03.js` and `node postman/run-m04.js` still pass.

## 1. Phase 1 exit check (M08-FR-01, FR-02, FR-04, FR-06)
| # | Do | Expect |
|---|---|---|
| 1.1 | **A proposes shop commission 5 → 6%** (step-up) | `201`, status `proposed` |
| 1.2 | **B's bell asks for approval** | One unread `SETTING_CHANGE_PROPOSED`, title "Approval needed"; an email to B |
| 1.3 | **B approves** (step-up) | `applied`; audit row `setting.changed`, critical, step-up |
| 1.4 | **A's bell has the critical alert** | `AUDIT_CRITICAL` naming `fees.shop_commission_pct`; an email to A |
| 1.5 | **B is not alerted about B's own change** | No `AUDIT_CRITICAL` for the actor |
| 1.6 | **Emails went out** | Two `email` deliveries with status `sent` |
| 1.7 | Deliver the same event twice | One notification (M04 inbox + `dedupe_key` UNIQUE) 🤖 |

## 2. Bell and centre (FR-03, FR-04)
| # | Do | Expect |
|---|---|---|
| 2.1 | **Unread count**, then **Mark all read** | `1`, then `0`; a realtime `notification.read` with the count 🤖 |
| 2.2 | Portal header bell (admin.kriraghor.localhost) | Badge updates without a reload when another master proposes a change; 99+ cap |
| 2.3 | Web / esports **Account → Notifications** | Centre with All / Unread, cursor paging, mark read on open |

## 3. Preferences (FR-05, FR-07)
| # | Do | Expect |
|---|---|---|
| 3.1 | **Turn off a mandatory cell** | `422 PREF_MANDATORY` |
| 3.2 | **Read preferences** | Category × channel matrix; security SMS `locked` |
| 3.3 | **Turn off moderation SMS and quiet hours** | Saved; a later `ROLE_REJECTED` goes in-app only, SMS `suppressed` 🤖 |
| 3.4 | Ban a user who has turned SMS off for security | `ACCOUNT_SUSPENDED` still goes by SMS (mandatory) 🤖 |

## 4. Delivery rules (FR-08 to FR-15)
| # | Do | Expect |
|---|---|---|
| 4.1 | A non-urgent SMS at 22:00–08:00 Dhaka | `deferred` until 08:00; released by `notify.release-deferred` 🤖 |
| 4.2 | More than `notify.sms_per_user_per_hour` SMS | Extra ones `rate_limited`, in-app still delivered 🤖 |
| 4.3 | A provider that keeps failing | Retries at 30 s, 2 min, 10 min, then `failed` 🤖 |
| 4.4 | A code without an active template | Fails closed: no blank message sent, error logged 🤖 |
| 4.5 | Sign in with a phone OTP | `sms_log` row with route `otp`, masked phone `+8801•••••NNNN`, body with the code redacted |
| 4.6 | **Delivery log** (`manage_users`) | Masked recipients only; filter by user, code, status, phone suffix |

## 5. Push to the mobile app (M08 push channel)
🤖 = covered by `tests/e2e/push.test.js`; the requests are in folder **4. Push (the mobile app)**.

| # | Do | Expect |
|---|---|---|
| 5.1 | **Register a token that is not an Expo token** | `422 VALIDATION_FAILED` |
| 5.2 | **Register this phone**, then **again** | `201`, then `200` with the same id; only `tokenTail` comes back, never the token |
| 5.3 | **List phones**, **Remove this phone**, list again | One phone, `204`, none; the row is kept with `revoke_reason = removed` |
| 5.4 | **Push is offered in preferences** | A `push` cell in every category, never locked |
| 5.5 | A member with a phone gets any in-app notification | A push with the same title and text in their language, and only `notificationId`, `code`, `link` in `data` 🤖 |
| 5.6 | Turn push off for a category; sign out on the phone | No push row for that category; nothing to a signed-out phone 🤖 |
| 5.7 | A non-urgent push at 22:00–08:00 Dhaka; `PASSWORD_CHANGED` at the same time | The first is `deferred`; the second goes at once with `priority: high` 🤖 |
| 5.8 | The app is uninstalled (Expo answers `DeviceNotRegistered`, at send or in the receipt) | The phone is revoked; the delivery `suppressed` (`no_device`) or the receipt `error` 🤖 |
| 5.9 | `notify.push-receipts` after `notify.push_receipt_delay_minutes` | Accepted pushes become `delivered`; receipts never answered expire after `notify.push_receipt_expire_hours` 🤖 |
| 5.10 | On a real phone (development build, `PUSH_DRIVER=expo`) | `ESPORTS_ROOM_READY` arrives at high priority; tapping it opens the room screen; the text has no room ID or password |
