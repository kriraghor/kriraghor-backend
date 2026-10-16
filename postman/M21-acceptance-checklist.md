# M21 Esports (step 1): Acceptance Checklist

Work through this list before starting M09. Tick each box when the result matches.
Request names refer to the **"Kriraghor API: M21 Esports"** collection
(`postman/kriraghor-esports.postman_collection.json`, rebuilt with `node postman/build-collection-m21.js`).
Step 1 is the full player loop for one Kriraghor tournament: UID, registration, payment, check-in, room, results, dispute, prizes, rankings and withdrawal. Group stages, auto-finalise, cheating reports and the mobile app come in step 2.

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies four migrations:
  - `20261023000001-create-esports`: 24 tables;
  - `20261023000002-add-enter-results-permission`;
  - `20261023000003-moderation-esports-kinds`;
  - `20261023000004-payout-withdrawals`.

  It also seeds settings v8 (164 settings, including `esports.dispute_max_per_entry` and `esports.room_reads_per_minute`), templates v5 (172) and the rubrics and reasons for `game_profile` and `esports_tournament`.
- [ ] `npm test`: everything green, including the coverage gate (100% on `esports.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m21.js` → **0 failed** (60 requests, 91 assertions). The runner resets `kriraghor_test` and signs in masters A and B and two players. It verifies player B's UID, pre-mints `esports.money` step-up tokens, and serves `{{controlUrl}}`. That is a local, test-only clock: requests named **Runner clock** move the stored times and run one `esports.tick`.
- [ ] `run-m02.js` to `run-m08.js` still pass.

## 1. Game UIDs (FR-02 to FR-04, FR-32)
| # | Do | Expect |
|---|---|---|
| 1.1 | **Player A tries player B's UID** | `409 ESPORTS_UID_TAKEN` (one account per UID per game) |
| 1.2 | **Player A adds a Free Fire UID with a screenshot** | `201 pending`, UID masked `7123•••601`. The screenshot is uploaded raw, and its type is checked by its first bytes (`FILE_TYPE_MISMATCH` otherwise 🤖) |
| 1.3 | A second UID for the same game; another user's upload key | `409 ESPORTS_PROFILE_EXISTS`; `422 ESPORTS_UPLOAD_INVALID` 🤖 |
| 1.4 | **UID: claim** on the Moderation desk | Automatic checks pass: UID format, not banned, not taken. Reasons include `uid_mismatch` |
| 1.5 | **The reviewer sees the screenshot** | Image with `no-store`. Each view is audited (`esports_game_profile.screenshot_viewed`). The portal panel shows the UID and IGN next to it |
| 1.6 | **UID: approve** | Verified; the player gets "Game UID verified" |
| 1.7 | Ban a UID (portal, UID bans tab) | The linked profile is `banned`, active entries are forfeited, and the UID can't be added again 🤖 |

## 2. Authoring and review (FR-06, FR-07)
| # | Do | Expect |
|---|---|---|
| 2.1 | **Master A drafts the tournament** | `draft`, prize pool ৳70 (1st ৳50, 2nd ৳20) plus ৳5 per kill |
| 2.2 | Submit with more slots than the lobby holds | `422 SLOTS_ABOVE_LOBBY` 🤖 |
| 2.3 | **Master A submits it**; **Not public while in review** | `review`; the public page is `404` |
| 2.4 | **The author cannot review their own** | `403 SELF_REVIEW_FORBIDDEN` |
| 2.5 | **Master B: approve** | `scheduled`, settings snapshot taken. The desk shows a "subsidy at minimum" warning when prizes exceed the fees at the minimum fill |
| 2.6 | **Published: the prize table is public** | Entry ৳50, two places |
| 2.7 | **The prize table is locked** | `409 ESPORTS_PRIZE_TABLE_LOCKED`; a title change still works 🤖 |

## 3. Registration and payment (FR-08 to FR-12, §6.6)
| # | Do | Expect |
|---|---|---|
| 3.1 | **Too early** | `409 ESPORTS_REGISTRATION_CLOSED` |
| 3.2 | **Player A registers** | Slot 1 held for `esports.payment_hold_minutes` and `pending_payment`. The pay link opens kriraghor.com `/pay/…`, whose result page links back to esports |
| 3.3 | **The same key replays the same entry** | Same registration. A new key: `409 ESPORTS_ALREADY_REGISTERED` 🤖 |
| 3.4 | Pay (simulator) | `confirmed`. The hold is in the `esports_entry` pool (group = tournament, no payee); the player gets "Registration confirmed" |
| 3.5 | 200 people at once for 48 slots | Exactly 48 hold a slot; the rest are waitlisted 🤖 |
| 3.6 | A slot frees before close | The next on the waitlist gets an offer; an unanswered offer moves to the end of the queue (Q124) 🤖 |
| 3.7 | An unpaid hold expires; a payment captured after the slot is gone | The slot is freed; the late capture is refunded automatically (`reject`) 🤖 |
| 3.8 | Below `min_participants` at close | Cancelled, and every entry is refunded 100% 🤖 |
| 3.9 | No verified phone; someone else's UID | `403 PHONE_REQUIRED`; `403 ESPORTS_GAME_PROFILE_REQUIRED` 🤖 |
| 3.10 | A suspended or banned player | Withdrawn and refunded before close 🤖 |

## 4. Check-in and the room (FR-13 to FR-17)
| # | Do | Expect |
|---|---|---|
| 4.1 | **Player A / B checks in** | `200` inside the window. Not checked in at close: `no_show` 🤖 |
| 4.2 | **Master A sets the room** | The reply never shows the room ID or password; both are encrypted at rest |
| 4.3 | **Before the reveal** | `409 ESPORTS_ROOM_NOT_REVEALED`. A player who isn't checked in gets `403 ESPORTS_NOT_CHECKED_IN` 🤖 |
| 4.4 | **Player A reads the room** | Room ID and password, `no-store`, rate-limited by `esports.room_reads_per_minute` |
| 4.5 | Reveal time | Pushed by socket to `user:{id}` of checked-in players only. The push notification "Room ready" has no credentials |
| 4.6 | **Every view is logged**; **Audit log has the views** | Socket pushes and API reads in the view log, without the secret; `esports_room.viewed` in the audit log |
| 4.7 | Rotate (portal room panel) | Version 2 is pushed to checked-in players; version 1 is superseded 🤖 |
| 4.8 | Secrets anywhere else | None in the outbox, notifications, audit, SMS or logs 🤖 |

## 5. Results and disputes (FR-18 to FR-22)
| # | Do | Expect |
|---|---|---|
| 5.1 | Post before the match starts | `409 ESPORTS_TOO_EARLY` 🤖 |
| 5.2 | **Duplicate placements** | `422 ESPORTS_PLACEMENT_DUPLICATE`. The portal blocks it before sending |
| 5.3 | **Master A enters / posts the results** | Points = placement table + kills × kill points. An `enter_results` clerk can enter and post but not cancel or finalise 🤖 |
| 5.4 | **Public standings: A first** | Live over the `esports_tournament:{id}` socket room |
| 5.5 | **Player B disputes** | `201`, with optional evidence. More than `esports.dispute_max_per_entry`: `409 ESPORTS_DISPUTE_LIMIT` 🤖 |
| 5.6 | **Finalise while disputed** | `409 ESPORTS_NOT_FINALISABLE` |
| 5.7 | **Master A rejects the dispute** | The player gets "Dispute decided". Corrected results replace the posted ones 🤖 |
| 5.8 | Dispute window closes | Match `final` |
| 5.9 | Disqualify after credit (Q123) | The unwithdrawn prize goes back to revenue; nobody moves up; the UID ban is optional 🤖 |

## 6. Finalise and pay (FR-23 to FR-25, §6.5)
| # | Do | Expect |
|---|---|---|
| 6.1 | **Preview the settlement** | Collected ৳100, paid ৳90, revenue ৳10, subsidy ৳0 |
| 6.2 | **Finalise without step-up** | `403 STEP_UP_REQUIRED` |
| 6.3 | **Master A finalises with step-up** | `paid_out` with the settlement stored. One `escrow.settlePool` posting; escrow `esports_entry` = 0 |
| 6.4 | **Player A has ৳65**, **Player B has ৳25** | ৳50 + 3 × ৳5; ৳20 + 1 × ৳5. Credited to `payable:user` (not a wallet); "Prize credited" sent |
| 6.5 | **Trial balance**, **Invariant checks** | Zero; all ok |
| 6.6 | Worked example A (subsidised) and B (squad split, remainder to the captain) | Exact poisha; escrow zero 🤖 |
| 6.7 | Finalise again | No change (idempotent) 🤖 |

## 7. Rankings and withdrawal (FR-26 to FR-28)
| # | Do | Expect |
|---|---|---|
| 7.1 | **Free Fire leaderboard: A first** | Rebuilt on finalise and nightly at 03:00 Dhaka; tier weight and recency decay |
| 7.2 | **Player A's public page** | Games, IGN, ranks; the UID is masked |
| 7.3 | **Withdrawing needs NID KYC** | `403 KYC_REQUIRED`. Then `409 PAYOUT_ACCOUNT_REQUIRED`, `422 WITHDRAW_BELOW_MINIMUM` and `409 WITHDRAW_OPEN` 🤖 |
| 7.4 | A withdrawal | A single-line payout of kind `withdrawal` through the M07 release, send and paid flow. Scheduled runs never sweep winnings 🤖 |

## 8. Apps
- [ ] esports.kriraghor.com:
  - home (featured hero, open tournaments, top players);
  - `/tournaments` and `/t/[slug]` (prize table, schedule, slots bar, call to action by state);
  - register (solo or squad) → pay → `/me/matches`;
  - the room page shows a countdown, then the credentials with copy buttons;
  - result page (evidence, dispute), `/me/winnings`, `/leaderboards`, `/p/[handle]`;
  - EN and BN.
- [ ] Portal `/admin/esports`:
  - tournament list and create form; submit;
  - check-in board (staff check-in, DQ);
  - room panel (set, reveal now, rotate, view count);
  - results table; disputes; streams;
  - cancel and finalise with an authenticator code;
  - UID bans.

  The Moderation desk shows the UID screenshot panel and the tournament summary.
- [ ] kriraghor.com home has the esports strip (open tournaments and top players, linking to esports). The pay result page links back to esports for entry fees.
