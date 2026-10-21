# M17 Disputes, Reports and Reviews (step 1): Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: M17 Disputes, Reports and Reviews"** collection
(`postman/kriraghor-disputes.postman_collection.json`, rebuilt with `node postman/build-collection-m17.js`).

Step 1 covers disputes on bookings (no-show contested, a problem at the venue, money paid at the venue) and esports results, the staff desk with escalation to masters, reports with auto-hide, and ground reviews. Market, used-gear and hire sources plug in with M11 to M13.

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies `20261027000001-create-trust`:
  - `disputes`, `dispute_evidence`, `reports`, `reviews`, `review_aggregates`;
  - `bookings.settle_due_at`;
  - a copy of any open M21 result disputes as M17 cases.

  The seed adds settings v12 (197 settings: `disputes.*`, `reports.*`, `reviews.*`) and templates v9 (254 templates: `DISPUTE_*`, `REPORT_*`, `REVIEW_*`).
- [ ] `npm test`: everything green, including the coverage gates (100% on `trust.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m17.js` → **0 failed**. The runner:
  - resets `kriraghor_test` and signs in master A, an owner with a fixture ground (৳2,000/h flat, 25% advance), two members, three staff, three eligible reporters and a member to report;
  - prepares a no-show (b1, ৳500 retained) and two played bookings (b2, b3), and lowers `refunds.staff_limit_poisha` to ৳300;
  - serves `{{controlUrl}}`, a local test-only control: `/noshow`, `/tick` and `/dtick` (the minute ticks as if hours later), `/check` (ledger), `/settle`.
- [ ] `run-m02.js` to `run-m10.js`, `run-m19.js` and `run-m21.js` still pass. M10's no-show now waits for the dispute window: "Runner: the no-show dispute window closes" settles it.

## 1. A contested no-show (FR-01 to FR-13)
| # | Do | Expect |
|---|---|---|
| 1.1 | **What I can dispute** | `no_show_contest`, ৳500 held, closing 48 h after the no-show |
| 1.2 | **The owner cannot dispute**, **Open**, **Again** | 403 `NOT_YOUR_BOOKING` (only the payer, with a verified phone); 201 `awaiting_response` and the escrow hold is frozen; 409 `DISPUTE_ALREADY_OPEN` |
| 1.3 | **A photo**, **A GIF** | 201 (typed by its bytes, private bucket); 415 `FILE_TYPE` |
| 1.4 | **Runner: the window passes** | Nothing is settled: a frozen advance waits for the decision |
| 1.5 | **My cases as the respondent**, **Answer**, **Read the photo** | The owner sees the case, answers (→ `under_review`) and reads the photo (`no-store`; audited) |
| 1.6 | **Decide unclaimed**, **Claim**, **Another reviewer** | 403 `CLAIM_REQUIRED`; the claim shows what each outcome moves (all ৳500 back; half ৳250 back, owner ৳237.50, fee ৳12.50; none ৳475 / ৳25); 409 `CLAIMED_BY_OTHER` |
| 1.7 | **Staff note**, **The member never sees staff notes** | Notes stay on the desk |
| 1.8 | **A custom refund above what is held**, **Decide half** | 422 `REFUND_INVALID`; resolved: ৳250 refunded (kind `dispute`), ৳250 released with the fee on what the owner keeps; the hold is closed |
| 1.9 | **Runner: ledger** | Owner ৳1,037.50 (৳800 for two played bookings + ৳237.50); invariants hold |

## 2. Escalation to a master (§6.3)
| # | Do | Expect |
|---|---|---|
| 2.1 | **Runner: a second no-show**, **Open**, **Runner: the respondent window ends** | The owner never answers: `under_review` after `disputes.respondent_hours` (system note "no response") |
| 2.2 | **Full refund above the ৳300 limit**, **Escalate** | 403 `ESCALATION_REQUIRED`; `escalated` with the recommendation (all, ৳500), masters notified |
| 2.3 | **The master inbox**, **Master decide without step-up**, **Master decide all** | Listed; 403; resolved by a master (step-up `refund.large`), ৳500 refunded |
| 2.4 | Parties never decide; staff can decide "none" without `refund_small` 🤖 | `CONFLICT_OF_INTEREST`, `REFUND_PERMISSION_REQUIRED` |

## 3. Withdraw (FR-07)
| # | Do | Expect |
|---|---|---|
| 3.1 | **Runner: a third no-show**, **Open**, **Withdraw** | `withdrawn`; the hold is unfrozen |
| 3.2 | **Runner: the window closes**, **Runner: ledger** | The tick releases ৳475 / ৳25 as usual |

## 4. Reviews (FR-20 to FR-26, Q98)
| # | Do | Expect |
|---|---|---|
| 4.1 | **Waiting for a rating**, **Rate a no-show** | Played bookings only; 409 `NOT_PLAYED` |
| 4.2 | **Rate b2**, **Twice** | Published; 409 `REVIEW_EXISTS` |
| 4.3 | **Rate b3 with a link**, **Held reviews**, **Publish it** | Held (`content`) until staff publish it; a review of a booking with an open dispute is held too 🤖 |
| 4.4 | **Reviews of my grounds**, **Reply** | The owner replies once (and may edit it) |
| 4.5 | **Public reviews** | Two shown; the average stays hidden until `reviews.min_count_display` (3) reviews; then the ground card shows it (M09 consumer) 🤖 |

## 5. Reports (FR-15 to FR-19, Q99)
| # | Do | Expect |
|---|---|---|
| 5.1 | **Report my own review**, **Report 1 of 3**, **Again** | 422 `REPORT_SELF`; 201; 409 `REPORT_DUPLICATE` |
| 5.2 | **Report 2 of 3**, **Report 3 of 3**, **Hidden from the public** | Three NID-verified reporters (accounts 7+ days old) within 7 days hide the review at once; unverified or new accounts do not count 🤖 |
| 5.3 | **The reports queue**, **The subject**, **No violation** | Flagged first; three reports; resolved, the review is restored, reporters get the outcome |
| 5.4 | **Report a member**, **Suspend without manage_users**, **Suspend through M01**, **My reports** | 201; 403 `PERMISSION_REQUIRED`; the account is suspended (M01 `suspendInTx`, reason `reported`); both reports resolved |

## 6. Esports results (M21 bridge)
| # | Do | Expect |
|---|---|---|
| 6.1 | `run-m21.js`: a player disputes a result | The M21 response carries `caseCode`; the case is on `/admin/disputes` (no money; outcomes corrected or rejected) |
| 6.2 | The esports desk resolves it | The M17 case is resolved with the same outcome; the match finalises as before 🤖 |

## 7. Jobs, notifications and screens
| # | Check | Expect |
|---|---|---|
| 7.1 | `trust.tick` (every minute) | Respondent reminders 12 h before, timeouts, staff and master SLA breaches once per level, expired claims 🤖 |
| 7.2 | Notifications | `DISPUTE_OPENED` (owner, SMS), `DISPUTE_RECEIVED`, `DISPUTE_RESPONSE_DUE`, `DISPUTE_RESPONDED`, `DISPUTE_DECIDED` (both, SMS), `DISPUTE_ESCALATED`, `DISPUTE_SLA_BREACHED`, `REPORT_OUTCOME`, `REPORT_FLAGGED`, `REVIEW_NEW`, `REVIEW_HIDDEN`, in EN and BN |
| 7.3 | kriraghor.com | The booking page offers a dispute inside the window and "Rate this ground" after play; `/me/disputes` and the case page (statements, files, withdraw); reviews and "Report" on `/grounds/[slug]`; `/me/reports`, `/me/reviews` |
| 7.4 | admin.kriraghor.com | Disputes desk (queue, claim, outcome previews, decide, escalate, master decide with a code), Reports, Reviews; the esports desk links to the disputes desk |
| 7.5 | vendor.kriraghor.com | `/vendor/disputes` (give your side, add files) and `/vendor/reviews` (reply) |

## 8. Reviews of pros, shops and gyms (Round B1: FR-30 to FR-35, M11-FR-06, M20-FR-10)
| # | Do | Expect |
|---|---|---|
| 8.1 | **Waiting: the pro and the shop** | `/me/reviewable` lists played bookings, paid-out hire jobs, completed sub-orders and used gym passes (one per gym until it is reviewed), newest first |
| 8.2 | **Rate my own job**, **Rate the pro**, **Twice** | 403 `NOT_YOUR_JOB`; 201 about the `hire_profile`; 409 `REVIEW_EXISTS`. Before the money is released: 409 `JOB_NOT_RELEASED` 🤖 |
| 8.3 | **Rate the shop** | 201 about the `shop` (`rating` is another name for `stars`). Before the buyer receives it: 409 `ORDER_NOT_COMPLETED`; after `reviews.window_days`: 409 `REVIEW_WINDOW_CLOSED` 🤖 |
| 8.4 | **Rate the gym**, **The same pass again**, **Runner: a newer gym pass**, **A newer pass updates the one gym review** | 201; 409 `REVIEW_EXISTS`; 200 `updated: true`, the same review id with the new stars. Before the pass is used: 409 `PASS_NOT_REDEEMED`; a hidden gym review stays hidden: 409 `REVIEW_HIDDEN` 🤖 |
| 8.5 | **Reviews of my profile**, **Reply with a phone number**, **Reply to the pro review** (the seller), **Reply** ×3 | `GET /me/reviews?role=owner` lists reviews of what I own; 422 `REPLY_HAS_CONTACT`; 403 `NOT_OWNER`; 200, and the author gets `REVIEW_REPLIED` once (EN, BN) |
| 8.6 | **Public reviews of the pro / shop / gym**, **An unknown subject type** | `GET /reviews?subjectType&subjectId`: published only, with the reply, no source ids; the average from `reviews.min_count_display`; 422 |
| 8.7 | Ratings | `review.aggregate_updated` sets `hire_profiles`, `shops` and `gyms` `rating_avg` / `rating_count`; `/hire/profiles`, `/market/shops/{slug}` and `/gym/gyms/{slug}` show the average only from `reviews.min_count_display` reviews; a dispute on a booking, sub-order or hire job holds its review and the rating drops it until the dispute ends 🤖 |
