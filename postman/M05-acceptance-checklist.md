# M05 Moderation lite: Acceptance Checklist

Work through this list before starting M21. Tick each box when the result matches.
Request names refer to the **"Kriraghor API: M05 Moderation"** collection
(`postman/kriraghor-moderation.postman_collection.json`, rebuilt with `node postman/build-collection-m05.js`).
Lite scope: one kind so far, `document` (M02 NID). M21 adds `game_profile` and `esports_tournament` through the same adapter. No websocket queue push (the desk polls every 30 s), no diff view, no recheck job, no daily summary.

## 0. Setup
- [ ] `npm run release`. This applies migration `20261022000001-create-moderation`, seeds the document rubric (4 items) and 10 rejection reasons, 5 new `moderation.*` settings (162 in total) and 10 more EN/BN templates (140).
- [ ] `npm test`: everything green, including the coverage gate (100% on `moderation.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m05.js` → **0 failed** (28 requests, 47 assertions). It resets `kriraghor_test`, signs in master A and reviewer B (`approve_documents` only), has two members submit their NID and runs a worker loop.
- [ ] `run-m02.js` (now decides through M05), `run-m03.js`, `run-m04.js`, `run-m06.js`, `run-m07.js` and `run-m08.js` still pass.

## 1. Submissions (FR-01 to FR-03, FR-14)
| # | Do | Expect |
|---|---|---|
| 1.1 | A member submits their NID (M02) | One `document` submission, version 1, `pending_review`, deadline `moderation.review_sla_hours` (24 h) later; the payload holds ids and the masked number only |
| 1.2 | The member resubmits while it waits | Version 2 links to version 1; version 1 becomes `superseded`; the reviewer holding it gets "Your review lock ended" (`MOD_CLAIM_LOST`) 🤖 |
| 1.3 | `GET /me/submissions` | The member's versions with status, reason and note 🤖 |
| 1.4 | `POST /me/submissions/:id/withdraw` on a document | `409 WITHDRAW_NOT_ALLOWED` (documents are replaced by resubmitting); someone else's id is `404` 🤖 |

## 2. Queue and claim (FR-07, FR-08, FR-17)
| # | Do | Expect |
|---|---|---|
| 2.1 | **Queue (oldest deadline first)**, **Desk KPIs** | Two documents, SLA `ok`, no lock; 2 in the queue |
| 2.2 | **Detail** | Masked payload, 6 checks, the 4-item rubric, reasons for documents only (no `price_wrong`) |
| 2.3 | **Claim**, **Master claims the same item** | Mine, 30 min lock with a 2 h hard cap; `409 ALREADY_CLAIMED` naming the holder |
| 2.4 | 20 claims at once from 4 reviewers | Exactly one wins; one active lock row 🤖 |
| 2.5 | **Heartbeat**; heartbeat near the hard cap; heartbeat by someone else | Extended; never past `hardExpiresAt`; `403 CLAIM_REQUIRED` 🤖 |
| 2.6 | Lock past its time (job `moderation.claim-expire`, every minute) | Released (`ttl`); deciding then gives `403 CLAIM_REQUIRED` 🤖 |
| 2.7 | Release mine; a master force-releases another reviewer's lock | `released: true`; `submission.released_forced` in the audit log 🤖 |
| 2.8 | Staff with `approve_listings` only; staff with neither permission | Empty queue, the document is `404`; `403 PERMISSION_REQUIRED` 🤖 |
| 2.9 | A staff member claims their own submission | `403 SELF_REVIEW_FORBIDDEN` 🤖 |

## 3. Rubric, reasons, decisions (FR-09 to FR-12)
| # | Do | Expect |
|---|---|---|
| 3.1 | **Tick two items** | Stored on the server; unknown keys dropped; two missing |
| 3.2 | **Approve with ticks missing**, **Tick the whole rubric**, **Approve** | `422 RUBRIC_INCOMPLETE`; then `200 approved`, lock released, rubric recorded |
| 3.3 | **Reject without a reason**, **with a listing reason**, **as "other" without text** | `422 REASON_REQUIRED`; `422 REASON_NOT_ALLOWED_FOR_KIND`; `422 REASON_REQUIRED` |
| 3.4 | **Reject** | `200 rejected` with the reason and note; the member sees them on `/account/verification` |
| 3.5 | Approve with a failing hard check (NID waiting on another account) | `422 CHECK_FAILED` with the failing keys 🤖 |
| 3.6 | A decide call without `Idempotency-Key` | `400 IDEMPOTENCY_KEY_REQUIRED` 🤖 |

## 4. Master override (Q46) and reopen (FR-21)
| # | Do | Expect |
|---|---|---|
| 4.1 | A reviewer sends an override reason | Without step-up `403 STEP_UP_REQUIRED`; with step-up `403 MASTER_REQUIRED` 🤖 |
| 4.2 | A master with step-up `moderation.override` and a reason | `200 approved`, `overridden: true`; critical audit `submission.check_overridden`; the check stays recorded as failed 🤖 |
| 4.3 | Override a check the adapter locks (`nid_unique`: the NID is verified on another account) | `422 CHECK_LOCKED`, even for a master (M01 keeps `nid_hash` unique) 🤖 |
| 4.4 | **Reviewer reopens**, **Reopen without step-up**, **Reopen with step-up** | `403 MASTER_REQUIRED`; `403 STEP_UP_REQUIRED`; `200 pending_review` with a new deadline, critical audit `submission.reopened` |
| 4.5 | Reopen something still open | `409 INVALID_STATE` 🤖 |

## 5. Applying, SLA, sanctions (FR-13, FR-18, edge case 6)
| # | Do | Expect |
|---|---|---|
| 5.1 | **Member 1 is active**, **Member 2 is active after the reopened approval** | M02 applied the decisions (`document.approved`, `verification.passed`), M01 activated the member role |
| 5.2 | **Applied (submission.applied)** | `appliedAt` set; one version |
| 5.3 | An approval nobody applies (job `moderation.apply-watchdog`) | Republished every `moderation.apply_timeout_minutes` (5) up to `moderation.apply_max_attempts` (5), then "Approval not applied" to masters (`MOD_APPLY_FAILED`); redeliveries apply once 🤖 |
| 5.4 | An item past its deadline (job `moderation.sla-breach`, hourly at :05 Dhaka) | One `submission.sla_breached`; "Review overdue" (`MOD_SLA_BREACH`) to reviewers of the kind and masters, not to others 🤖 |
| 5.5 | A member is suspended or banned | Their open submissions and the open document are withdrawn 🤖 |
| 5.6 | Outbox rows for `submission.*` | Ids, kinds and codes only: no NID, name or DOB 🤖 |

## 6. The Moderation desk (portal)
| # | Do | Expect |
|---|---|---|
| 6.1 | Open admin → **Moderation** (`/admin/kyc` redirects here with `?kind=document`) | KPIs, status tabs, kind / lock / overdue filters, search; the queue refreshes every 30 s |
| 6.2 | Pick an item, **Claim and review** | Checks, the document panel (legal name, DOB, masked number with reveal, files on request), rubric ticks saved as you tick, reasons in EN/BN |
| 6.3 | Leave the pane open | A heartbeat every 60 s keeps the lock; a lost lock shows "Your lock ended" |
| 6.4 | As a master on an item with a failing check | An override reason field; approving asks for the authenticator code |
| 6.5 | As a master on a decided item | **Reopen** asks for a reason and the authenticator code |
