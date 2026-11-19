# M20 Gym (step 1): Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: M20 Gym (step 1)"** collection
(`postman/kriraghor-gym.postman_collection.json`, rebuilt with `node postman/build-collection-m20.js`).

Step 1 covers:
- the `gym_owner` role with the ground owner's documents (M02, Q109);
- gyms reviewed on the Moderation desk (M05 kind `gym`) with photos, the week's hours (women-only windows) and subscription packages (no day pass since 2 Nov 2026);
- passes bought into escrow (M06 purpose `gym_package`) with a QR token and a 6-character backup code;
- the front desk: one admission a day, two scans at once admit once;
- cancel and expiry: an unused pass is paid to the gym minus the fee after its last day (Q110);
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
| 1.1 | **A member with a verified phone may open gyms** | 200, none yet (M24 gate `run_gym`; sending for review still needs `list_gym`) |
| 1.2 | **A draft in Banani** | Draft, with the limits: at least 3 photos |
| 1.3 | **Send it incomplete** | 422 `GYM_INCOMPLETE` listing photos, hours and packages |
| 1.4 | **Photo 1 to 3**, **A GIF is refused** | Three public photos; 415 for the GIF |
| 1.5 | **Hours that close before they open**, **The week** | 422; then 8 windows (Friday in two) |
| 1.6 | **A day pass is refused**, **Only at the desk** (saved, cannot be sent), **The design packages** | 422; 200 then 422 naming `packages`; then month ৳4,500, quarter ৳12,000 |
| 1.7 | **Send for review**, **Claim** | The five checks pass: owner KYC, photos, hours, packages, name unique in the area |
| 1.8 | **Tick the rubric**, **Approve** | The gym is live; `GYM_LIVE` to the owner 🤖 |
| 1.9 | **The public page**, **The gym list** | The prices, three photos, taking passes, open now |
| 1.10 | Edit a live gym 🤖 | `edit_status` draft; the public page keeps the live copy until the edit is approved |

## 2. A monthly package and the front desk (FR-03 to FR-05)
| # | Do | Expect |
|---|---|---|
| 2.1 | **Too far ahead** | 422 `DATE_OUT_OF_RANGE` (over `gym.pass_advance_days`) |
| 2.2 | **Buy a month from today** | Waiting for payment; no token or code yet |
| 2.3 | **pay**, **The pass with its QR token and code** | Active; `v1.` token and a 6-character Crockford code (holder only, `no-store`) |
| 2.4 | **A tampered token** | 422 `INVALID_PASS_TOKEN` |
| 2.5 | **Admit by token** | Admitted (Fahim Rahman), still active; ৳4,275 released to the owner |
| 2.6 | **A second scan today** | 409 `PASS_ALREADY_REDEEMED` |
| 2.7 | Two scans at once 🤖 | One 201, one 409; one `pass_redemptions` row |
| 2.8 | Wrong gym 🤖 | `PASS_WRONG_GYM` before anything else |
| 2.9 | A day pass sold before 2 Nov 2026 🤖 | Still admitted once, refunded before its date, paid to the gym when unused (`tests/e2e/gym.test.js`) |
| 2.10 | **Today's admissions**, **ledger** | One, by QR; the owner's payable ৳4,275, fee ৳225, balanced |
| 2.11 | **Still active for the rest of the month** | Active, first use recorded, the QR still shown |

## 3. Cancel and expiry (FR-06, FR-07, Q110)
| # | Do | Expect |
|---|---|---|
| 3.1 | **A month from tomorrow**, **pay**, **Cancel before its first use** | Refunded ৳4,500 in full |
| 3.2 | **Cancel after its first use** | 409 `PASS_NOT_REFUNDABLE` |
| 3.3 | **Another month, never used**, **gym.tick after the last day** | Both months expired; the unused one with reason `unused` |
| 3.4 | **ledger** | The gym kept it minus the fee: payable ৳8,550, fee ৳450 |
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
| 5.1 | **A pass for tomorrow**, **pay**, **Staff: the pass with its hold** | Held ৳4,500; no token or code |
| 5.2 | **A reviewer cannot cancel it**, **Master: platform cancel** | 403; then refunded in full (step-up `escrow.manage`) |
| 5.3 | **Staff: the gym working copy** | Live, with the owner and packages (the Moderation desk panel) |
| 5.4 | **Suspend the gym**, **Buying now**, **The public page** | Suspended; 409 `GYM_NOT_AVAILABLE`; 404 |
| 5.5 | **Master: restore**, **ledger still balanced** | Live again; invariants hold |
| 5.6 | Gates 🤖 | `buy_gym_pass` needs a verified phone; `list_gym` the `gym_owner` role |

# M20 · Holidays and special hours: Acceptance Checklist

Product owner, 11 Nov 2026; M20-FR-16 to FR-22 ([M20 §26](../../kriraghor-docs/modules/M20-gym.md)). Collection `kriraghor-gym-special-days.postman_collection.json` (it also holds the M27 conversion report, checklist in `M27-acceptance-checklist.md`).

## 0. Setup
- [ ] `npx jest --runInBand --coverage=false --runTestsByPath tests/unit/gym-special-days-rules.test.js tests/e2e/gym-special-days.test.js` passes.
- [ ] `node postman/run-m20-special-days.js` → **0 failed** (46 requests, 80 assertions). The runner resets the test database, publishes a Standard gym open 06:00 to 22:00 with trial visits on, a class tomorrow at 06:30 with one member booked, a guest's visit tomorrow at 18:00, desk staff, an accountant and another gym's owner. M03 counts 419 settings (seed v40).

## 1. The list, the checks and the preview (FR-16, FR-17)
| # | Do | Expect |
|---|---|---|
| 1.1 | **Nothing yet, with the limits** | No items; 60 days long, 365 days ahead, 30 active, 30 days on the public page |
| 1.2 | **A past day**, **Dates out of order**, **Longer than 60 days** | 422 `GYM_SPECIAL_DAY_DATES` with the reason |
| 1.3 | **Hours on a closed day**, **Changed hours without hours**, **A one-letter title** | 422 `GYM_SPECIAL_DAY_HOURS` twice, then `VALIDATION_FAILED` |
| 1.4 | **Staff cannot add one**, **Staff cannot list them**, **Another gym's owner** | 403 each (the last `NOT_OWNER`) |
| 1.5 | **The preview**, **The preview saved nothing** | One class session and one visit would be cancelled; the list is still empty |

## 2. A holiday closes the gym (FR-18, FR-19, FR-20, FR-22)
| # | Do | Expect |
|---|---|---|
| 2.1 | **Eid-ul-Fitr, tomorrow and the day after** | 201, active, upcoming, no hours |
| 2.2 | **An overlapping one** | 409 `GYM_SPECIAL_DAY_OVERLAP` |
| 2.3 | **The gym page lists it** | One special day with public fields only; today is an ordinary day |
| 2.4 | **Trial-visit slots skip both days**, **Booking a visit on the holiday** | 13 of 15 days; 422 `GYM_VISIT_HOURS` |
| 2.5 | Runner: deliver the events, **The guest's visit…**, **The class session…** | Both cancelled with "The gym is closed: Eid-ul-Fitr" |

## 3. Special hours (FR-18, FR-20)
| # | Do | Expect |
|---|---|---|
| 3.1 | **Ramadan hours in five days** | 201 with the window 10:00 to 14:00 |
| 3.2 | **That day's slots follow them**, **A visit at 18:00**, **A visit at 11:00** | One window; 422 `GYM_VISIT_HOURS`; 201 |
| 3.3 | **The gym page lists both** | Nearest first |

## 4. Removing a holiday (FR-21)
| # | Do | Expect |
|---|---|---|
| 4.1 | **Staff cannot remove it**, **The owner removes Eid-ul-Fitr**, **Removing it again** | 403; removed; 409 `GYM_SPECIAL_DAY_STATE` |
| 4.2 | Runner: deliver the events, **The class session is back, empty** | Scheduled, no reason, nobody booked |
| 4.3 | **The guest's visit stays cancelled**, **Tomorrow takes visits again** | Still cancelled; tomorrow is in the slots |
| 4.4 | **Coming**, **Past and removed** | Only the Ramadan hours; Eid-ul-Fitr kept as removed |

## 5. Gym app and phone app
- [ ] **Gym page editor** (owner): "Holidays and special hours" under the weekly hours. Add: name, first and last day, Closed or Special hours; **Check** shows what it would cancel, then **Save**. Remove asks first and says what comes back.
- [ ] **Public gym page and card**: "Closed today: {name}" on a holiday; the coming special days under the opening hours. The same in the phone app.
- [ ] A closed date is missing from **Book a free visit**; the class of that day shows as cancelled with the reason.
- [ ] Bangla, phone width, light and dark.

## 6. Removing a gym (tester feedback, 19 Nov 2026)
| # | Do | Expect |
|---|---|---|
| 6.1 | **Suspend it again**, **The owner cannot remove a suspended gym** | 409 `GYM_STATE`: a suspended gym is removed by Kriraghor only |
| 6.2 | **Staff who are not masters cannot**, **Master without step-up** | 403; 403 `STEP_UP_REQUIRED` |
| 6.3 | **Master: remove (step-up)**, **The public page is gone** | `removed` with the lists `refunded` and `paidToGym`; 404; the ledger balanced |
| 6.4 | Money 🤖 (`tests/e2e/gym-fixes-b1.test.js`) | An unused paid subscription is refunded in full; one already checked in (paid to the gym at first use) is listed for support, not refunded from Kriraghor's money; removing again 409 |
