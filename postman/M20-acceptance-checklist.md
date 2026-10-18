# M20 Gym (step 1): Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: M20 Gym (step 1)"** collection
(`postman/kriraghor-gym.postman_collection.json`, rebuilt with `node postman/build-collection-m20.js`).

Step 1 covers:
- the `gym_owner` role with the ground owner's documents (M02, Q109);
- gyms reviewed on the Moderation desk (M05 kind `gym`) with photos, the week's hours (women-only windows) and day, month and quarter packages;
- passes bought into escrow (M06 purpose `gym_package`) with a QR token and a 6-character backup code;
- the front desk: one admission a day, two scans at once admit once;
- cancel and expiry: an unused day pass is paid to the gym minus the fee (Q110);
- fitness trainers' monthly plans and subscriptions (M06 purpose `trainer_subscription`): renewal, grace, the 3-day cancel window, release at the month end, an M17 case;
- the staff desk.

Step 2 brings front-desk staff accounts, gym reviews (M17) and closures with automatic refunds.

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies two migrations:
  - `20261101000001-gym-kinds`: M05 kind `gym`; M17 source `trainer_subscription` with category `service_problem` (and `disputes.source_type` widened to VARCHAR(24)); the payments purposes;
  - `20261101000002-create-gym`: `gyms`, `gym_hours`, `gym_photos`, `gym_packages`, `gym_passes`, `pass_redemptions` (append-only, UNIQUE (pass, day)), `trainer_plans`, `trainer_subscriptions`, `trainer_subscription_periods`.

  The seed adds:
  - settings v17 (257 settings): `gym.day_pass_min_poisha`, `gym.day_pass_max_poisha`, `gym.pass_advance_days`, `gym.month_days`, `gym.quarter_days`, `gym.min_photos`, `gym.max_photos`, `gym.subscription_*`, `gym.trainer_plan_*`, `disputes.window_trainer_hours`;
  - templates v14 (`GYM_*`, `TRAINER_SUB_*`, `TRAINER_NEW_SUBSCRIBER`);
  - KYC requirements v4 (`gym_owner`);
  - the `gym` rubric and reasons; five gym facilities.
- [ ] `npm test`: everything green, including the coverage gates (100% on `gym.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m20.js` → **0 failed**.
  - The runner resets `kriraghor_test`.
  - It signs in master A, a documents reviewer, a listings reviewer, a `manage_users` moderator, an approved gym owner, a live fitness trainer (Sabbir) and a member (Fahim).
  - It serves `{{controlUrl}}`: `/settle`, `/pay`, `/tick`, `/check`.
- [ ] `run-m02.js` to `run-m13.js`, `run-m17.js`, `run-m18.js`, `run-m19.js` and `run-m21.js` still pass. M03 counts 257 settings.

## 1. A gym and its review (FR-01, FR-02)
| # | Do | Expect |
|---|---|---|
| 1.1 | **A member cannot list a gym** | 403 (gate `list_gym` needs an active `gym_owner`) |
| 1.2 | **A draft in Banani** | Draft, with the limits: day pass ৳100 to ৳3,000, at least 3 photos |
| 1.3 | **Send it incomplete** | 422 `GYM_INCOMPLETE` listing photos, hours and packages |
| 1.4 | **Photo 1 to 3**, **A GIF is refused** | Three public photos; 415 for the GIF |
| 1.5 | **Hours that close before they open**, **The week** | 422; then 8 windows (Friday in two) |
| 1.6 | **A day pass under the limit**, **The design packages** | 422; then day ৳400, month ৳4,500, quarter ৳12,000 |
| 1.7 | **Send for review**, **Claim** | The five checks pass: owner KYC, photos, hours, packages, name unique in the area |
| 1.8 | **Tick the rubric**, **Approve** | The gym is live; `GYM_LIVE` to the owner 🤖 |
| 1.9 | **The public page**, **The gym list** | The prices, three photos, taking passes, open now |
| 1.10 | Edit a live gym 🤖 | `edit_status` draft; the public page keeps the live copy until the edit is approved |

## 2. A day pass and the front desk (FR-03 to FR-05)
| # | Do | Expect |
|---|---|---|
| 2.1 | **Too far ahead** | 422 `DATE_OUT_OF_RANGE` (over `gym.pass_advance_days`) |
| 2.2 | **Buy today's day pass** | Waiting for payment; no token or code yet |
| 2.3 | **pay**, **The pass with its QR token and code** | Active; `v1.` token and a 6-character Crockford code (holder only, `no-store`) |
| 2.4 | **A tampered token** | 422 `INVALID_PASS_TOKEN` |
| 2.5 | **Admit by token** | Admitted (Fahim Rahman); ৳380 released to the owner |
| 2.6 | **A second scan** | 409 `PASS_ALREADY_REDEEMED` |
| 2.7 | Two scans at once 🤖 | One 201, one 409; one `pass_redemptions` row |
| 2.8 | Wrong gym 🤖 | `PASS_WRONG_GYM` before anything else |
| 2.9 | A month pass 🤖 | Once a day; ৳4,275 released at the first admission; no cancel after first use |
| 2.10 | **Today's admissions**, **ledger** | One, by QR; the owner's payable ৳380, fee ৳20, balanced |
| 2.11 | **The used pass hides its secrets** | Redeemed; token and code null |
| 2.12 | Daily capacity 🤖 | The next day pass for a full date: 409 `PASS_CAPACITY_FULL` |

## 3. Cancel and expiry (FR-06, FR-07, Q110)
| # | Do | Expect |
|---|---|---|
| 3.1 | **A day pass for tomorrow**, **pay**, **Cancel before the day** | Refunded ৳400 in full |
| 3.2 | **Another pass for today**, **Cancel on the day** | 409 `PASS_NOT_REFUNDABLE` |
| 3.3 | **gym.tick after the gym closes today** | One expired, reason `unused` |
| 3.4 | **ledger** | The gym kept it minus the fee: payable ৳760, fee ৳40 |
| 3.5 | Unpaid passes 🤖 | Void after the payment window |

## 4. A trainer's monthly plan (v3)
| # | Do | Expect |
|---|---|---|
| 4.1 | **A price under the limit**, **Strength 12** | 422; then a ৳6,000 plan, 12 sessions, online |
| 4.2 | **The trainers tab**, **The plans with the start window** | From ৳6,000, one plan; start up to 14 days ahead, 3-day cancel |
| 4.3 | **Subscribe from today**, **pay** | Active, month 1 paid; a cancel now refunds |
| 4.4 | **The trainer sees the subscriber** | One, as the trainer |
| 4.5 | **Cancel in the first 3 days** | Cancelled, not renewed; the month refunded in full |
| 4.6 | Renewal 🤖 | Opens 5 days before the end; paid in grace (3 days) the next month starts at the old end; not paid → lapsed |
| 4.7 | Release 🤖 | Month 1 released a day after its end: ৳5,700 to the trainer |
| 4.8 | A problem 🤖 | An M17 case (`gym.service_problem`); the hold frozen; the release waits; half refunded on the decision |

## 5. Staff (FR-10)
| # | Do | Expect |
|---|---|---|
| 5.1 | **A pass for tomorrow**, **pay**, **Staff: the pass with its hold** | Held ৳400; no token or code |
| 5.2 | **A reviewer cannot cancel it**, **Master: platform cancel** | 403; then refunded in full (step-up `escrow.manage`) |
| 5.3 | **Staff: the gym working copy** | Live, with the owner and packages (the Moderation desk panel) |
| 5.4 | **Suspend the gym**, **Buying now**, **The public page** | Suspended; 409 `GYM_NOT_AVAILABLE`; 404 |
| 5.5 | **Master: restore**, **ledger still balanced** | Live again; invariants hold |
| 5.6 | Gates 🤖 | `buy_gym_pass` needs a verified phone; `list_gym` the `gym_owner` role |
