# M22 Esports organisers (step 1): Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: M22 Esports organisers (step 1)"** collection
(`postman/kriraghor-organisers.postman_collection.json`, rebuilt with `node postman/build-collection-m22.js`).

Step 1 covers:
- the `organiser` role with the organisation's registration document (M02 doc type `org_registration`);
- **M14 lite** organisations reviewed on the Moderation desk (M05 kind `organisation`), with owner, admin and staff members;
- contracts entered by Kriraghor staff: a percentage of entry fees (`fees.esports_saas_pct`, or a contract rate) or a flat fee per month, quarter or tournament, with a signed PDF and step-up `esports.money`;
- the organiser console at `vendor.kriraghor.com/vendor/esports`: tournaments on the M21 engine, scoped to the organisation (404 for anyone else);
- the prize fund paid before review (M06 purpose `esports_prize_fund`), the kill cap, organiser rooms and results (Q135), and a finalise confirmed by a code sent to the phone, which posts spec §6.2:
  - the entry fees go to the fee and the organiser's owner;
  - the prizes come from the fund;
  - there is never a subsidy;
- cancel returning the fund; flat invoices paid through M06 (`fee_invoice`); overdue past grace blocks submits (Q134);
- branding (colours with a WCAG AA check, logo, taglines), the subdomain page `{sub}.esports.kriraghor.com`, and the staff desk.

Q133 (the legal operator of organiser tournaments) and Q136 (VAT on Kriraghor's fee) stay open. `saas.vat_enabled` is off, and the first real organiser waits for the accountant.

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies three migrations:
  - `20261102000001-organiser-kinds`:
    - M05 kind `organisation`;
    - doc type `org_registration`;
    - OTP purpose `org_finalise`;
    - staff permission `manage_organisers`.
  - `20261102000002-create-organisations` (M14 lite): `organisations`, `organisation_members` (one active row per organisation and user; one owner).
  - `20261102000003-create-organiser-saas`:
    - `organiser_contracts` (one active per organisation);
    - `organiser_invoices` and `organiser_invoice_lines`;
    - `organiser_prize_funds`;
    - `organisation_branding` (subdomain unique);
    - on `esports_tournaments`: `saas_fee_model`, `saas_fee_bps`, `contract_id`, `max_paid_kills`, and the foreign key on `organisation_id`.

  The seed adds:
  - settings v18 (263 settings): `saas.invoice_due_days`, `saas.overdue_grace_days`, `saas.subdomain_reserved`, `saas.vat_enabled`, `saas.vat_pct`, `saas.contract_expiry_notice_days`;
  - templates v15 (`ORG_*`);
  - KYC requirements v5 (`organiser`);
  - the `organisation` rubric and reasons.
- [ ] `npm test`: everything green, including the coverage gates (100% on `saas.rules.js` and `ledger.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m22.js` → **0 failed**.
  - The runner resets `kriraghor_test`.
  - It signs in:
    - master A;
    - a documents reviewer, a listings reviewer and a `manage_organisers` staff member;
    - the organiser (role and registration approved);
    - a member without the role;
    - a player who joins the organisation's staff;
    - four players;
    - another verified organisation.
  - It serves `{{controlUrl}}`: `/settle`, `/body`, `/pay`, `/review`, `/open`, `/fill`, `/start`, `/close-disputes`, `/code`, `/check`.
- [ ] `run-m02.js` to `run-m13.js`, `run-m17.js` to `run-m21.js` still pass. M03 counts 263 settings.

## 1. The organisation and its review (M14 lite)
| # | Do | Expect |
|---|---|---|
| 1.1 | **Without the organiser role** | 403 `ORG_ROLE_REQUIRED` |
| 1.2 | **A draft** | Draft, role `owner`, slug `dhaka-clutch-league` |
| 1.3 | **A draft has no console** | 404 (the console needs a verified organisation) |
| 1.4 | **Send for review**, **Claim** | Three checks pass: owner documents approved, owner NID verified, name unique |
| 1.5 | **Tick the rubric**, **Approve**, **Verified** | Verified; the owner's `organiser` role is active; `ORG_VERIFIED` 🤖 |
| 1.6 | Changes requested 🤖 | `ORG_CHANGES_REQUESTED`; the owner edits and sends again |
| 1.7 | **Add a player to the staff by phone**, **Twice** | 201; then 409 `ORG_MEMBER_EXISTS` |
| 1.8 | **Staff see the console**, **Staff cannot see billing** | 200; 404 (admins only, and a 404 rather than a 403) |
| 1.9 | **A stranger** | 404 (FR-03) |

## 2. The contract (FR-01, FR-02)
| # | Do | Expect |
|---|---|---|
| 2.1 | **A flat fee under ৳1 a cycle is refused** | 422 `CONTRACT_FIELDS_INVALID` |
| 2.2 | **Percentage at the setting** | Draft |
| 2.3 | **Activate without the signed PDF** | 409 `CONTRACT_DOCUMENT_REQUIRED` (step-up `esports.money` passed) |
| 2.4 | **Attach the signed PDF**, **Activate** | Active; `ORG_CONTRACT_ACTIVE` to the owner and admins 🤖 |
| 2.5 | A second active contract 🤖 | 409 `CONTRACT_ACTIVE_EXISTS` |
| 2.6 | Expiry 🤖 | Notice `saas.contract_expiry_notice_days` before `ends_on` (`ORG_CONTRACT_ENDING`); the tick ends it after |
| 2.7 | **The contract in billing** | One, active |

## 3. A console tournament and its prize fund (FR-04 to FR-06)
| # | Do | Expect |
|---|---|---|
| 3.1 | **Per-kill rewards without a cap** | 422 `ESPORTS_KILL_CAP_REQUIRED` |
| 3.2 | **A draft with a cap of 5 kills** | Draft of this organisation, "by Dhaka Clutch League", `maxPaidKills` 5 |
| 3.3 | Submit without a contract 🤖 | 409 `ORG_CONTRACT_REQUIRED` |
| 3.4 | **Submit before funding** | 409 `PRIZE_FUND_REQUIRED` |
| 3.5 | **Fund the pool**, **pay**, **Funded** | ৳2,000 (places ৳1,500 + 5 × ৳100); funded; `ORG_FUND_RECEIVED` 🤖 |
| 3.6 | **Fund it again** | 409 `PRIZE_FUND_LOCKED` |
| 3.7 | A smaller pool after funding 🤖 | 409 `PRIZE_FUND_SHRINK`; a bigger one needs a top-up |
| 3.8 | **Submit**, **approve it on the desk** | Published with `saas_fee_model` percentage and `saas_fee_bps` 1000 snapshotted |

## 4. Branding and the organiser page (FR-11, FR-12)
| # | Do | Expect |
|---|---|---|
| 4.1 | **A primary colour too light for white text** | 422 `BRAND_PRIMARY_CONTRAST` |
| 4.2 | **Colours and a tagline** | Saved (lower-case hex) |
| 4.3 | **Staff cannot change branding** | 404 |
| 4.4 | **A reserved subdomain**, **Claim dhaka-clutch** | 422 `SUBDOMAIN_RESERVED`; then 200 |
| 4.5 | **Another organisation cannot take it** | 409 `SUBDOMAIN_TAKEN` |
| 4.6 | **The public organiser page**, **An unknown subdomain** | Name, colours and the published tournament; 404 |
| 4.7 | `dhaka-clutch.esports.kriraghor.localhost` (k3d) | The branded list; sign-in, the wallet and withdrawals stay Kriraghor's |

## 5. Rooms, results and the finalise (Q135, FR-07, FR-10)
| # | Do | Expect |
|---|---|---|
| 5.1 | **An organisation member cannot play** | 403 `ESPORTS_CONFLICT_OF_INTEREST` |
| 5.2 | **Staff set the room**, **Another organisation cannot** | 200 (audited); 404 |
| 5.3 | **Staff enter the results**, **Post them** | 6 kills; the dispute window starts |
| 5.4 | **Staff cannot finalise** | 404 (org admins only) |
| 5.5 | **Send the code to the phone**, **A wrong code is refused** | 200; 4xx |
| 5.6 | **Finalise** | Paid out: collected ৳1,600, prizes ৳1,999.98, fee ৳160, organiser ৳1,440, ৳0.02 back to the fund, subsidy 0 |
| 5.7 | **ledger** | P1 ৳1,000 + 3 × ৳83.33. The owner's payable is ৳1,440.02. The fee revenue is ৳160. Both escrows are at zero. Balanced |
| 5.8 | M07 🤖 | The owner's money goes on the `daily` payout run; the winners withdraw theirs (NID KYC) |
| 5.9 | A disqualification after finalise 🤖 | The prize goes back to the organisation's owner, not to Kriraghor revenue |

## 6. Cancel returns the fund (FR-10)
| # | Do | Expect |
|---|---|---|
| 6.1 | **Another draft**, **Fund it**, **pay** | ৳1,500 |
| 6.2 | **Another organisation cannot cancel it**, **Nor see it** | 404, 404 |
| 6.3 | **Cancel the funded draft**, **ledger** | The owner gets ৳1,500 back; the fund escrow is at zero; `ORG_FUND_RETURNED` 🤖 |
| 6.4 | Cancel after registration 🤖 | Entries are refunded 100% (M21) and the fund goes back to the owner |

## 7. A flat contract and its invoice (FR-08, FR-09)
| # | Do | Expect |
|---|---|---|
| 7.1 | **End the percentage contract** | Ended |
| 7.2 | **৳5,000 a month**, **Attach the signed PDF**, **Activate** | Active, with the first invoice |
| 7.3 | **The invoice** | `KG-INV-26-000001` style; ৳5,000; VAT 0 (`saas.vat_enabled` off); issued; `ORG_INVOICE_ISSUED` 🤖 |
| 7.4 | **Pay it**, **pay**, **Paid** | Paid; `ORG_INVOICE_PAID` 🤖 |
| 7.5 | **Staff: the invoice list**, **ledger** | One, paid; ৳5,000 more fee revenue; the invoice escrow is at zero |
| 7.6 | The monthly tick 🤖 | Nothing is issued twice for the same period |
| 7.7 | Overdue 🤖 | `ORG_INVOICE_OVERDUE` after `due_at`; submits blocked with 409 `INVOICE_OVERDUE` after `saas.overdue_grace_days` |
| 7.8 | Void 🤖 | Step-up `esports.money`; submits work again |

## 8. Staff (FR-13)
| # | Do | Expect |
|---|---|---|
| 8.1 | **The organisations**, **One organisation with its members** | Both organisations; verified, two members |
| 8.2 | **A draft before the suspension**, **Suspend** | Suspended (`manage_organisers`) |
| 8.3 | **Suspended: the console still opens**, **but nothing new can be sent** | 200; 409 `ORG_SUSPENDED` |
| 8.4 | **and the organiser page is gone** | 404 |
| 8.5 | **Restoring needs a master**, **Master: restore**, **The organiser page is back** | 403; 200; 200 |
| 8.6 | A suspended contract 🤖 | 409 `ORG_CONTRACT_SUSPENDED` on submit |
