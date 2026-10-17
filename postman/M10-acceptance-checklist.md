# M10 Bookings (step 1): Acceptance Checklist

Work through this list before starting M19. Tick each box when the result matches.
Request names refer to the **"Kriraghor API: M10 Bookings"** collection
(`postman/kriraghor-bookings.postman_collection.json`, rebuilt with `node postman/build-collection-m10.js`).

Step 1 is the booking loop and the owner desk on the v3 money rules, plus M09's closures, weekly series and moves. Split shares, open games, the reliability score, tournament and hire reservations and the in-app balance come later.

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies two migrations:
  - `20261025000001-create-closures-series` (M09 step 2);
  - `20261025000002-create-bookings`: `bookings`, `booking_slots` (`btree_gist`, the exclusion constraint), `check_ins`.

  The seed adds settings v10 (175 settings: `booking.hold_attempts_per_10min`, `walkin_auto_checkin_min`, `availability_cache_seconds`, `balance_unrecorded_days`, `start_reminder_hours`) and templates v7 (224 templates: the `BOOKING_*` codes).
- [ ] `npm test`: everything green, including the coverage gates (100% on `bookings.rules.js`, `grounds.rules.js`, `pricing.rules.js`, `escrow.rules.js`, `ledger.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m10.js` → **0 failed** (50 requests, 94 assertions). The runner:
  - resets `kriraghor_test`, signs in master A, two owners and two members;
  - builds owner A's live two-court ground at ৳2,000/h flat with a 25% advance (a fixture; the M09 run covers the real listing flow);
  - serves `{{controlUrl}}`, a local test-only control: `/pay` pays through the simulator, `/shift` moves a booking in time, `/tick` runs the minute job, `/check` reads the ledger.
- [ ] `run-m02.js` to `run-m09.js` and `run-m21.js` still pass.

## 1. Availability, hold and pay (FR-01 to FR-06)
| # | Do | Expect |
|---|---|---|
| 1.1 | **Availability tomorrow** | Two courts of half-hour cells (open, booked, yours, closed, past) with the hourly rate; lengths 60/90/120/180 |
| 1.2 | **Own ground** | `422 OWN_GROUND`. Off-grid start `NOT_HALF_HOUR`, past the 7-day window `OUT_OF_RANGE`, 30 minutes `LENGTH_INVALID`, a third hold `HOLD_LIMIT`, the sixth attempt in 10 minutes `HOLD_RATE_LIMITED` 🤖 |
| 1.3 | **Hold the advance** | `pending_payment`; price ৳2,000, advance ৳500, fee ৳100; a payment link for ৳500. `book_ground` needs only a verified phone |
| 1.4 | **Same court and time** | `409 SLOT_UNAVAILABLE` (the exclusion constraint). A touching slot is fine. 20 parallel holds on one slot give exactly one 🤖 |
| 1.5 | **Runner: pay**, **Confirmed at once** | `confirmed` (Q66); SMS to the member, in-app to the owner. A capture after the hold lapsed takes the slot again, or is refunded in full if it was taken 🤖 |
| 1.6 | **Cancel preview** | Refund ৳0, ৳500 kept (v3: the advance is not refunded) |

## 2. Check-in releases the money (FR-13, v3)
| # | Do | Expect |
|---|---|---|
| 2.1 | **Check-in tomorrow** | `409 NOT_CHECKIN_WINDOW` (start − 30 min until the end) |
| 2.2 | **Check in** | `checked_in`; ৳500 released: owner ৳400, Kriraghor ৳100 (fee on the full value); ৳1,500 due at the venue. Paid in full: owner ৳1,900 🤖 |
| 2.3 | **Venue balance** | The full amount only (`BALANCE_MISMATCH`), once (`NO_BALANCE_DUE`) |
| 2.4 | **Extend 30 min** | ৳1,000 more at the venue; ৳50 fee owed (`fee_receivable`, netted at the next payout). The next half-hour must be free (`NEXT_SLOT_TAKEN`) 🤖 |

## 3. Cancels and no-show (FR-10 to FR-19, Q120, Q68)
| # | Do | Expect |
|---|---|---|
| 3.1 | **Cancel** (paid in full) | ৳1,500 back, ৳500 kept (owner ৳475, Kriraghor ৳25); a stale `expectedRefund` gives `409 REFUND_CHANGED`; no cancel after the start (`ALREADY_STARTED`) |
| 3.2 | **Owner cancel for the weather** | 100% back; not penalised (Q22). A suspended or removed ground cancels its bookings for the platform with 100% back 🤖 |
| 3.3 | **Mark no-show** | Only after the grace (`NOT_LATE_YET`) and before auto-complete; ৳475 / ৳25; the rest of the court is freed from the next half-hour |
| 3.4 | **Auto-completed** | Never checked in: completed 24 h after the end with the full release (৳400 / ৳100) |

## 4. Walk-in, closures, moves, series
| # | Do | Expect |
|---|---|---|
| 4.1 | **Walk-in** | Paid in full at the counter; ৳100 fee owed; checked in at once when it starts within 15 minutes; the phone is encrypted, only the last four digits are shown |
| 4.2 | **Close over a booking** | `409 CLOSURE_CLASHES` with the list; nothing written. A free period closes every court; holds there get `SLOT_UNAVAILABLE`; **Reopen** frees it. End now shortens an in-progress closure 🤖 |
| 4.3 | Moves | To a free active court of the owner's live grounds that shares a sport; same price; a new ground lets the member cancel free 🤖 |
| 4.4 | **Series** | ৳1,800 a session (10% off); four venue-paid bookings; clashing weeks need `skipClashingWeeks`; skip, restore (`SLOT_UNAVAILABLE` if taken) and end (future confirmed weeks cancelled, no penalty) |
| 4.5 | Hours and retiring courts | `HOURS_CONFLICT` and `COURT_HAS_BOOKINGS` now see real bookings (the M09 port) 🤖 |
| 4.6 | **Another owner** | `403 NOT_OWNER` |

## 5. Staff and the ledger
| # | Do | Expect |
|---|---|---|
| 5.1 | **Staff list**, **Staff view** | `manage_users` or `view_payouts`; the ledger trail shows `escrow.release_booking` and `fee.receivable`. Masters cancel for the platform with step-up `escrow.manage` 🤖 |
| 5.2 | **Runner: ledger balances** | Owner ৳1,750 (400 + 475 + 475 + 400); fee revenue ৳400 (৳250 from online money, ৳150 owed at the venue); fees owed ৳150; every invariant holds |

## 6. Apps
- [ ] kriraghor.com:
  - `/grounds/[slug]`: the booking widget (7-day strip, court and length, the live half-hour grid, both payment options, "Hold and pay" → `/pay`);
  - the pay result links back to the booking;
  - `/me/bookings` (upcoming and past) and `/me/bookings/[id]` (paid online, due at the venue, cancel with the refund preview);
  - `/grounds` sorts by "most open hours today" and shows the free hours on each card.
- [ ] vendor.kriraghor.com:
  - `/vendor/bookings`: the day timeline per ground, the booking panel (check in, extend, no-show, record the balance, cancel with a reason, move), walk-ins;
  - `/vendor/grounds/[id]/schedule`: closures with the clash list, reopen and end now; weekly series with the week check, skip and end.
- [ ] admin.kriraghor.com: `/admin/bookings` (list, detail with the ledger trail, platform cancel with an authenticator code).
