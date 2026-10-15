# M07 Payouts (step 1): Acceptance Checklist

Work through this list before starting M02 lite. Tick each box when the result matches.
Request names refer to the **"Kriraghor API: M07 Payouts"** collection
(`postman/kriraghor-payouts.postman_collection.json`, rebuilt with `node postman/build-collection-m07.js`).
Step 1 pays out by hand: finance reveals the wallet number, sends the money in the bKash or Nagad merchant app, then records the reference.

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies migration `20261020000001-create-payouts` and seeds the 4 new `payouts.*` settings (155 in total) and 34 more EN/BN templates (122).
- [ ] `npm test`: everything green, including the coverage gate (100% on `payouts.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m07.js` → **0 failed**. It resets `kriraghor_test`, signs in masters A and B, a payer and a payee, releases a ৳100 test charge to the payee (৳95 owed), lowers the four-eyes threshold to ৳50, sends the payee's account code and pre-mints step-up tokens.
- [ ] `node postman/run-m06.js` (now 6 invariant checks), `run-m03.js`, `run-m04.js` and `run-m08.js` still pass.

## 1. Payout accounts (FR-01, FR-02, §4.1)
| # | Do | Expect |
|---|---|---|
| 1.1 | **Add an account with a wrong number** | `422 PAYOUT_ACCOUNT_INVALID` |
| 1.2 | **Payee adds a bKash account (code from the SMS)** | `201`, `bKash ••• 5678`, `pending_verification`; the number is in no response, log or audit row; the payee gets "New payout account added" by SMS and email at once (urgent, even in quiet hours) |
| 1.3 | **Finance sees it next to the NID name** | The queue shows the account name, the NID legal name, "names match" and "also on N other users" when the wallet is shared 🤖 |
| 1.4 | **Finance verifies it** | `active`; a first account has no change hold; `view_payouts` alone cannot verify 🤖 |
| 1.5 | Replace a verified account | The old one is `superseded`; payouts pause for `risk.payout_change_hold_hours` (48 h, an `account_change` hold) 🤖 |
| 1.6 | Reject with a note | The payee sees the note; the account cannot be decided twice (`PAYOUT_ACCOUNT_NOT_PENDING`) 🤖 |

## 2. Payout runs (FR-03 to FR-05)
| # | Do | Expect |
|---|---|---|
| 2.1 | **Master runs the daily payouts** | One payout `PO-26-…` of ৳95: gross ৳100, fee ৳5 from the release posting (never recalculated) |
| 2.2 | The same window again; a new window | No new payout: each ledger entry is used once; a payee with an open payout gets nothing new 🤖 |
| 2.3 | Two runs at once | One payout (unique open payout per payee) 🤖 |
| 2.4 | Less than `payouts.min_amount_poisha` (৳100) owed | No payout; it waits for the next run 🤖 |
| 2.5 | Hourly job at 10:00 Dhaka (`payouts.run_hour`) | Daily, plus ground and shop runs on their weekday; 09:59 builds nothing 🤖 |
| 2.6 | Fees owed (fee receivable) | Netted first: ৳95 − ৳20 owed = ৳75 paid 🤖 |
| 2.7 | Esports prizes | Never swept (withdraw only, with M21) 🤖 |

## 3. Release and four-eyes (FR-07, §3)
| # | Do | Expect |
|---|---|---|
| 3.1 | **It needs two approvals** | Above `payouts.four_eyes_threshold_poisha`: `needs_approval`; masters get "Payout needs two approvals" |
| 3.2 | **A single release is refused** | `409 INVALID_STATE` (staff with `release_payouts` release only up to the threshold, with step-up) |
| 3.3 | **Master A approves**, **Master A again** | Step 1 of 2; then `409 SAME_APPROVER` |
| 3.4 | **Master B approves (2 of 2)** | `processing`; ledger Dr `payable:user` / Cr `payout_clearing` ৳95 |
| 3.5 | The master who placed or lifted the latest manual hold | `409 HOLD_ACTOR_CANNOT_APPROVE` 🤖 |
| 3.6 | Release without step-up; with `view_payouts` only | `403 STEP_UP_REQUIRED`; `403 PERMISSION_REQUIRED` 🤖 |

## 4. Send by hand (FR-08, FR-10)
| # | Do | Expect |
|---|---|---|
| 4.1 | **Reveal without step-up**, then **Finance reveals the number** | `403 STEP_UP_REQUIRED`; then the full number for 60 s, `Cache-Control: no-store`; only while `processing` |
| 4.2 | **The reveal is in the payout detail, the number is not**, **Audit log has the critical reveal** | `reveals: 1`; `payout.account_revealed` is critical with step-up; the number is not stored, logged or replayed |
| 4.3 | **Finance marks it paid with the bKash reference** | `paid`; Dr `payout_clearing` / Cr `platform_bank`; the payee gets "৳95 paid to bKash ••• 5678. Ref BKX9TR2Q1" in-app and by SMS |
| 4.4 | Mark failed (`invalid_wallet`) | The release is reversed (money back in the payable); the payee is told; retry needs a new account (`PAYOUT_ACCOUNT_UPDATE_REQUIRED`), then waits for its change hold (`PAYOUT_ON_HOLD`) 🤖 |
| 4.5 | Cancel | Lines return to the next run; a refund payout cannot be cancelled 🤖 |

## 5. Holds (FR-06, FR-13, FR-14)
| # | Do | Expect |
|---|---|---|
| 5.1 | Manual hold, lift | `on_hold`, then back to `scheduled` / `needs_approval`; the payee is told 🤖 |
| 5.2 | Risk freeze (M18 calls PayoutHoldService) | Cannot be lifted here: `409 RISK_HOLD_MANAGED_IN_RISK`; placing it twice is harmless 🤖 |
| 5.3 | Dispute on one source (M17) | Only that source's lines wait 🤖 |
| 5.4 | Account suspended, restored | Payouts held, then released 🤖 |

## 6. Refund payouts (FR-15, M06 manual_required)
| # | Do | Expect |
|---|---|---|
| 6.1 | The gateway refuses a refund three times | A refund payout to the payer (never netted), waiting for their verified account 🤖 |
| 6.2 | Release and mark paid | Dr `refund_clearing` / Cr `payout_clearing`, then the bank; the M06 refund becomes `succeeded` 🤖 |

## 7. Payee and ledger
| # | Do | Expect |
|---|---|---|
| 7.1 | **Payee sees the payout paid**, **Payee summary** | Paid ৳95 this month; the projection uses the same calculation as the run (FR-16) |
| 7.2 | **Payout clearing is empty**, **Trial balance is zero**, **Invariant checks pass** | `payout_clearing` 0; difference 0; 6 checks OK including `payout_clearing_matches` |
| 7.3 | kriraghor.localhost/me/payout-account and /me/payouts | Masked account, hold banner, payouts with lines and a CSV statement (EN/BN) |
| 7.4 | admin.kriraghor.localhost/admin/finance?tab=payouts | Status tabs with counts, the drawer, the 60-second reveal panel, runs and account review |
