# M18 Risk and Trust (step 1): Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: M18 Risk and Trust"** collection
(`postman/kriraghor-risk.postman_collection.json`, rebuilt with `node postman/build-collection-m18.js`).

Step 1 covers risk flags from the rules that have data today, the risk desk (freeze payouts, ask for documents, clear, suspend, ban, and undo for each), reliability for ground owners and bookers, and the shared VelocityGuard. Shop, used-gear and hire rules come with M11–M13; device and IP signals later.

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies three migrations:
  - `20261028000001-create-document-requests` (M02 owns it);
  - `20261028000002-create-risk`: `risk_rules` (9 seeded rules), `risk_metrics`, `risk_flags`, `risk_actions` (append-only) and `trust_scores`;
  - `20261028000003-reports-subject-owner` (M17).

  The seed adds settings v13 (217 settings: `risk.*` and `trust.*`; the existing `risk.*` names are kept) and templates v10 (`RISK_FLAGGED`, `PAYOUTS_FROZEN`, `PAYOUTS_UNFROZEN`, `DOCUMENTS_REQUESTED`, `DOCUMENTS_OVERDUE`, `TRUST_LOW`).
- [ ] `npm test`: everything green, including the coverage gates (100% on `risk.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m18.js` → **0 failed**. The runner:
  - resets `kriraghor_test`, signs in master A and a `manage_users` staff member;
  - has two members submit the same NID;
  - mints the master's step-up tokens (risk.manage ×3, settings.write);
  - serves `{{controlUrl}}`, a local test-only control: `/settle` (events and risk jobs) and `/check`.
- [ ] `run-m02.js` to `run-m10.js`, `run-m17.js`, `run-m19.js` and `run-m21.js` still pass. M03 now counts 217 settings.

## 1. Flags (FR-01 to FR-05)
| # | Do | Expect |
|---|---|---|
| 1.1 | **Overview**, **Flags**, **The account** | One critical `accounts_per_nid` flag on the second holder (2 accounts > `risk.max_accounts_per_nid` 1), with its rule version and threshold. Nothing frozen (Q101). No NID number anywhere |
| 1.2 | Events debounce | Each event schedules `risk.evaluate-user` once per account (30 s); the evaluation re-reads the facts through the owning services 🤖 |
| 1.3 | Rules with data today | `shared_payout_account`, `esports_uid_banned` (critical); `refund_rate`, `dispute_loss_rate`, `reports_upheld`, `esports_disqualified` (high); `velocity_breaches` (medium); `payout_account_change` (info) 🤖 |
| 1.4 | Lapse | An open flag whose metric no longer breaches lapses after `risk.flag_lapse_days` 🤖 |

## 2. Actions and undo (FR-06 to FR-11, Q100, Q101)
| # | Do | Expect |
|---|---|---|
| 2.1 | **Staff freeze**, **Master freezes payouts**, **Again**, **Runner: frozen** | 403; 201, an M07 `risk_freeze` payee hold (step-up risk.manage); 409 `ALREADY_FROZEN`; one hold. The payee gets `PAYOUTS_FROZEN` with no rule detail |
| 2.2 | **Undo the freeze**, **Runner: unfrozen** | `unfreeze_payouts`; the hold is lifted; the flag returns to open when that was its only action |
| 2.3 | **Ask for a new NID upload**, **The member sees the request** | An M02 document request due in `risk.doc_request_days`; the member's next submission fulfils it, even after an approved NID; an overdue one raises the flag one level 🤖 |
| 2.4 | **Clear the flag**, **Undo the clear** | Cleared and snoozed for `risk.clear_snooze_days` (a re-breach inside the snooze reopens it only when clearly worse); undo reopens it |
| 2.5 | **Suspend 31 days**, **Suspend 7 days**, **Undo the suspension**, **Undo twice** | 422 `SUSPENSION_TOO_LONG` (`risk.staff_suspend_max_days`); suspended through M01 (`source: risk`); restored; 409 `ACTION_ALREADY_REVERSED` |
| 2.6 | Ban 🤖 | A master only, with step-up user.ban; lifting it is a master's too |
| 2.7 | **The timeline** | Seven append-only rows, each with its reason and actor; `risk_actions` refuses UPDATE and DELETE 🤖 |

## 3. Thresholds, velocity and reliability (FR-02, FR-03, FR-12, FR-14)
| # | Do | Expect |
|---|---|---|
| 3.1 | **Staff cannot change thresholds**, **Master proposes a threshold change** | 403; an M03 change request (`source: risk_desk`, step-up settings.write). When it applies, `setting.changed` re-evaluates every account with flags or metrics 🤖 |
| 3.2 | VelocityGuard 🤖 | Per-account limits (uploads, reports, esports room reads, ground photos) on a Redis sliding window: 429 with `retryAfter`, and each breach counts toward `velocity_breaches` |
| 3.3 | **My reliability**, **Public reliability** | Scores per kind; public only once shown (`trust.min_sample`). Owner: penalised cancels × `trust.w.owner_cancel` (weather exempt) + lost disputes × `trust.w.owner_dispute_lost`. Booker: no-shows not overturned × 1.0 + late cancels × 0.2. 25 bookings with one penalised cancel → 96% 🤖 |

## 4. Screens
| # | Check | Expect |
|---|---|---|
| 4.1 | admin.kriraghor.com `/admin/risk` | Counts by severity, flags critical first, rules with thresholds (masters change one with a code) |
| 4.2 | `/admin/risk/accounts/[userId]` | Flags, the actions timeline with Undo, reliability, holds, document requests and metrics; actions need a reason; freezes and bans ask for an authenticator code |
| 4.3 | vendor.kriraghor.com | The owner's reliability on the home page; a booker's reliability (when shown) in the booking panel |
| 4.4 | kriraghor.com | The owner's reliability on `/grounds/[slug]` once shown; "My reliability" on `/me`; document requests on `/account/verification` |
