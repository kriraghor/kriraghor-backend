# M24 §22 · The desk through a lost connection: Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: M24 · The desk through a lost connection"** collection (`postman/kriraghor-gym-offline.postman_collection.json`, rebuilt with `node postman/build-collection-m24-offline.js`). 🤖 marks cases only the jest suites cover (`tests/e2e/gym-desk-offline.test.js`, `tests/unit/gym-desk-rules.test.js`).

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies `20261128000001-gym-desk-offline` (`gym_desk_offline_items` with `chk_gym_desk_offline_items`, the unique client id per gym and the review index) and settings v43 (`gym_manage.desk_snapshot_refresh_minutes` 10, `desk_offline_max_hours` 24, `desk_offline_skew_seconds` 300).
- [ ] `node postman/run-m24-offline.js` → **0 failed** (23 requests, 39 assertions). The runner resets the test database and makes a Basic gym, a desk clerk, a door keeper, a coach, Rafiq (Monthly from today, ৳1,000 paid) and Tanvir (his month ended, the due overdue).

## 1. The desk copy (FR-144)
| # | Do | Expect |
|---|---|---|
| 1.1 | **The copy, with the open dues** | 200: stamp `v1.gso.…`, refresh 10 minutes; Rafiq `allow`, Tanvir `warn` (expired, unpaid); Rafiq's due owes ৳2,500; no full phone number |
| 1.2 | **Check-ins only** | `dues: null` |
| 1.3 | **No attendance.mark** | 403 |

## 2. Sending (FR-146 to FR-149)
| # | Do | Expect |
|---|---|---|
| 2.1 | **A check-in** | 201 applied, counted, at the copy's time plus the time on the device |
| 2.2 | **Sent again / from another sign-in** | the same item (201 replayed / 200); one attendance row |
| 2.3 | **Cash with a slip** | 201 applied; a receipt number now; `paid_on` the day taken; note `Offline slip T-…` |
| 2.4 | **Tanvir after the gym blocks** | 201 flagged `would_block`; recorded as a warning |
| 2.5 | **Cash for a due paid since** | 201 parked `due_paid`; no payment |
| 2.6 | **A stamp the server did not make / no slip / no permission** | 422 `GYM_OFFLINE_STAMP_INVALID` / 422 `VALIDATION_FAILED` / 403 |
| 2.7 | Time ahead of the server, late, drawer closed, the person not confirmed, a removed member, desk mode unlocks and a PIN checked on the device | flagged `time_adjusted`, `late`, `drawer_closed`, `unverified_taker`, `pin_on_device`; parked `member_removed` 🤖 |

## 3. The owner's list (FR-150)
| # | Do | Expect |
|---|---|---|
| 3.1 | **fees.collect alone** | 403 |
| 3.2 | **To check** | the flagged and the parked item, oldest first; `toCheck` 2 |
| 3.3 | **Wrong actions** | an applied item, parked cash "checked": 409 `GYM_OFFLINE_ITEM_STATE`; returned without a note: 422 |
| 3.4 | **Cash given back / checked** | resolved once; the list is empty; All keeps four |
| 3.5 | Parked cash on another due of the member | a receipt now, dated the day taken, received by the person recorded 🤖 |

## 4. Gym app
- [ ] The test guide's journeys X-14 to X-17 (`kriraghor-docs/testing/gym-test-guide.md`).
