# M06 Payments, ledger and escrow: Acceptance Checklist

Work through this list before starting M07. Tick each box when the result matches.
Request names refer to the **"Kriraghor API: M06 Payments, ledger and escrow"** collection
(`postman/kriraghor-payments.postman_collection.json`, rebuilt with `node postman/build-collection-m06.js`).
The gateway is the built-in SSLCommerz simulator (`PAYMENTS_SIMULATOR=true`, dev and tests only).

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies migrations `20261019000001` to `…04` and seeds the 7 `payments.*` / `refunds.retry_max` settings (151 in total) and 40 more EN/BN templates (88).
- [ ] `npm test`: everything green, including the coverage gate (100% on `common/money.js`, `ledger.rules.js`, `escrow.rules.js`, `refunds.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m06.js` → **0 failed**. It resets `kriraghor_test`, signs in a master, a payer and a payee, pre-mints the master's `escrow.manage` step-up token and runs a worker loop (events, notifications, payment jobs) next to the API.
- [ ] `node postman/run-m03.js`, `run-m04.js` and `run-m08.js` still pass.

## 1. Paying (M06-FR-01 to FR-06)
| # | Do | Expect |
|---|---|---|
| 1.1 | **Master creates a ৳100 test charge** | `201`, code `PAY-26-…`, status `initiated`, fee 5% snapshotted (`payments.test_charge_fee_pct`, version 1) |
| 1.2 | Same request with the same Idempotency-Key; then with a different amount | The same payment (`Idempotent-Replayed: true`); `422 IDEMPOTENCY_KEY_REUSED` 🤖 |
| 1.3 | **Payer starts paying with bKash** → **Gateway: the payer pays** → **Browser comes back** | `201` with the simulator page; `303` back to the API with `tran_id` and `val_id`; `303` to `kriraghor.com/pay/{id}/result` |
| 1.4 | **Payment succeeded (verified by the server)** | `succeeded`, `bKash ••• 4321`; the payer gets "৳100 paid for … Ref PAY-…" in-app and by SMS |
| 1.5 | Replay the IPN; send the IPN and the return together | `{ result: 'duplicate' }`; one capture posting, one hold 🤖 |
| 1.6 | An IPN with a changed amount | `401 WEBHOOK_SIGNATURE_INVALID`, stored with `signature_ok = false`, nothing changes 🤖 |
| 1.7 | Lose the IPN and the return | The 1/5/15-minute poll (or expiry, or reconciliation) captures it 🤖 |
| 1.8 | **Pay the wrong amount** (simulator button) | Never `succeeded`: captured money waits in `suspense` and is refunded in full 🤖 |
| 1.9 | Pay after the intent expired | Captured, then refunded automatically (`late_capture`); the payer hears about the refund, not "payment received" 🤖 |
| 1.10 | **Decline** or **Cancel** on the gateway, then pay again | `failed` (PAY_FAILED in-app), then `succeeded` on the new attempt 🤖 |

## 2. Escrow (FR-06, FR-07, FR-13, FR-14)
| # | Do | Expect |
|---|---|---|
| 2.1 | **Finance sees the hold and the capture posting** | Hold `holding` ৳100; ledger `payment.capture`: Dr `provider_clearing:sslcommerz` / Cr `escrow:test_charge` |
| 2.2 | **Release without step-up** | `403 STEP_UP_REQUIRED`; finance staff without master: `403 MASTER_REQUIRED` |
| 2.3 | **Master releases with step-up** (৳70 of ৳100) | `gross 7000, fee 350, net 6650`, hold `partially_released`; payee notified; audit `escrow.released_manually` (critical) |
| 2.4 | Freeze, try to release, unfreeze | `ESCROW_FROZEN` while frozen; the payee gets "Payment on hold" in-app and by SMS 🤖 |
| 2.5 | A `delay` release rule | `escrow.release-due` releases it when its time comes 🤖 |
| 2.6 | Esports pool (M21): 3 entries of ৳100, prizes ৳150 + ৳60 | One posting: payables ৳150 / ৳60, `fee_revenue:esports` ৳90; with prizes above the pool, the shortfall comes from `prize_subsidy_expense` 🤖 |
| 2.7 | Two masters release the same hold at once | One `200`, one `409`; one ledger posting 🤖 |

## 3. Refunds (FR-08, FR-09, FR-10)
| # | Do | Expect |
|---|---|---|
| 3.1 | **Refund ৳20 of what is still held** | `201 approved` from escrow; the job calls the gateway, polls, then `succeeded`; payer notified twice (started, done) |
| 3.2 | **Refund more than is left** | `422 REFUND_EXCEEDS_HELD` (or `REFUND_EXCEEDS_CAPTURED` above the capture) |
| 3.3 | Staff with `refund_small` above `refunds.staff_limit_poisha`, per refund or cumulatively | `202 pending_master`; masters get "Refund waiting for approval"; approve or reject needs step-up `refund.large` 🤖 |
| 3.4 | Master refund above the limit without step-up | `403 STEP_UP_REQUIRED` 🤖 |
| 3.5 | Refund after release | Staff: `REFUND_EXCEEDS_HELD`; master with **goodwill**: from `goodwill_expense` 🤖 |
| 3.6 | Gateway refuses three times | `failed`, retried at 1 min / 10 min, then `manual_required`; money stays in `refund_clearing`; payer and finance told 🤖 |
| 3.7 | Two refunds racing for the same money | One `201`, one `422` 🤖 |

## 4. Ledger and reconciliation (FR-11, FR-12, FR-18, FR-19)
| # | Do | Expect |
|---|---|---|
| 4.1 | **Payee balance and platform fee**, **Escrow still holds ৳10** | `payable:user:…` ৳66.50; `escrow:test_charge` ৳10 |
| 4.2 | **Trial balance is zero**, **Invariant checks pass** | `difference 0`; 6 checks OK (M07 adds `payout_clearing_matches`) |
| 4.3 | `UPDATE` / `DELETE` on `ledger_*`; an unbalanced transaction; an entry for a posted transaction | Refused by PostgreSQL ("append-only"; "unbalanced" and "already posted" at COMMIT, by the deferred constraint trigger) 🤖 |
| 4.4 | Edit an escrow hold's amount in PostgreSQL, run the checks | `escrow_matches_holds` and `holds_match_ledger` fail; finance gets "Ledger check failed" 🤖 |
| 4.5 | **Reconcile today**, then again | `completed`, capture and refund `matched`; `409 RECON_RUN_EXISTS` |
| 4.6 | A capture we missed; a wrong amount | `missing_internal` healed automatically; `amount_mismatch` stays open until resolved with a note; finance is told 🤖 |

## 5. Apps
| # | Do | Expect |
|---|---|---|
| 5.1 | kriraghor.localhost/pay/{id} as the payer | Amount, what it is for, bKash / Nagad / Card, time left; **Pay ৳100** opens the gateway |
| 5.2 | Back on /pay/{id}/result | "Payment confirmed" with reference and method (never from the URL; the page asks the API) |
| 5.3 | kriraghor.localhost/me/payments | Payments with refunds underneath |
| 5.4 | admin.kriraghor.localhost/admin/finance | Tabs Payments, Refunds, Escrow, Ledger, Reconciliation, Test charge; release, refund and approve ask for an authenticator code |
