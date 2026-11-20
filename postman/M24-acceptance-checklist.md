# M24 prompt 1 · Desk MVP: Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: M24 prompt 1 · Desk"** collection
(`postman/kriraghor-gym-manage.postman_collection.json`, rebuilt with `node postman/build-collection-m24.js`).

Prompt 1 lets a pilot gym run a full day without a paper register: a phone sign-up opens a private gym, members are added or imported, staff with permissions check members in and record cash with receipts, memberships are renewed and frozen, and a member accepts an invite and sees their membership and receipts. All of it is counter money (bookkeeping only, no ledger). Online fees, reminders and invoices are prompt 2; plans, join requests, trainers and the entrance QR are prompt 3. 🤖 marks cases only the jest suites cover (`tests/e2e/gym-manage.test.js`, `tests/unit/gym-manage-rules.test.js`).

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies two migrations:
  - `20261113000001-m24-packages-and-permission`: M01 staff permission `manage_gyms`; M20 `gym_packages` kinds `half_year`, `year`, `custom` with `admission_fee_poisha`, `channel` (desk, online, both; existing packages `both`), `visit_limit`, `sort`, and `uq_gym_packages_kind` re-made to skip `custom`; `gym_passes` new kinds and `fee_override_id`.
  - `20261113000002-create-gym-manage`: the 11 prompt-1 tables of §7.2 (`gym_manage_settings`, `gym_members`, `gym_link_requests`, `gym_memberships`, `gym_freezes`, `gym_dues`, `gym_fee_payments`, `gym_attendance`, `gym_member_notes`, `gym_imports`, `gym_owner_subscriptions`) with named CHECKs, partial unique indexes and the append-only trigger on payments, attendance and notes.
- [ ] The seed adds settings v30 (331 settings: `gym.half_year_days`, `gym.year_days`, the `gym_manage.*` counter keys, the `gym_saas.*` tier keys in the new category `gym_saas`) and templates v23 (`GYM_LINK_INVITE` in-app and email, `GYM_LINK_ACCEPTED` in-app).
- [ ] `npm test`: everything green, including 100% coverage of `gym-manage.rules.js` and the module-boundary tests (`gym-manage` sits in the gym group and reads M20 only through `gym/index.js`).
- [ ] `node postman/run-m24.js` → **0 failed** (72 requests, 137 assertions). The runner resets the test database (set `DB_NAME` to keep it apart), signs in a gym owner with only a verified phone, the member who accepts the invite, the person who becomes front-desk staff and a Kriraghor staff member with `manage_gyms`, writes `m24-members.csv` into a temporary working directory and serves `{{controlUrl}}` (`/refresh`, `/drain`, `/daily`).

## 1. A private gym and its setup
| # | Do | Expect |
|---|---|---|
| 1.1 | **A private gym on a verified phone** | 201 `draft`; no NID, no documents (gate `run_gym`, M24-FR-01); the owner's `gym_owner_subscriptions` row (tier free) is created with the first gym (FR-81) |
| 1.2 | **Packages: month, quarter and a desk-only custom package** | 200; none needs to be sold online until the gym is listed (FR-24); admission fee, channel, visit limit and order kept |
| 1.3 | **Submitting for review still needs the gym_owner role** | 403 (`list_gym`, FR-02) |
| 1.4 | **The private gym is not in the directory** | empty list |
| 1.5 | **Adding a member before the short code** | 409 `GYM_SETUP_REQUIRED` |
| 1.6 | **The short code IY** | settings created; next member code `IY-0001`; a short code another of the owner's gyms uses → 409 `GYM_SHORT_CODE_TAKEN` 🤖 |
| 1.7 | **Public pricing / My plan / Choose Basic / My gyms** | four plans from settings; Free has no check-ins; Basic unlocks `attendance`; the month keeps the highest tier chosen (FR-82) |

## 2. Members
| # | Do | Expect |
|---|---|---|
| 2.1 | **Add a member with a membership and the first payment** | 201: `IY-0001`; due ৳3,000 (৳2,500 + ৳1,000 admission − ৳500 discount, FR-32); ৳1,000 paid; receipt `IY-R26-000001` with its `/r/` link; no ledger entry (FR-34) 🤖 |
| 2.2 | **The same request again** | the same 201 body, `Idempotent-Replayed: true` (FR-10) |
| 2.3 | **The same phone again** | 409 `GYM_MEMBER_PHONE_TAKEN` with `memberId` |
| 2.4 | 20 parallel adds 🤖 | continuous codes `IY-0001` … `IY-0020` (settings row lock) |
| 2.5 | **Search / profile / edit / stale version / reveal** | last 4 digits only in lists; `VERSION_CONFLICT` on a stale version; the reveal is `no-store`, audited (`gym_member.phone_revealed`) and limited per hour (429 `RATE_LIMITED` 🤖) |
| 2.6 | Leave, re-join, remove 🤖 | left keeps the open due; re-join keeps the code and charges the admission fee again; remove refused while a due holds payments (`GYM_MEMBER_STATE` `has_payments`) |

## 3. Dues, payments, receipts, renew and freeze
| # | Do | Expect |
|---|---|---|
| 3.1 | **More than is due / Pay the rest** | 422 `GYM_PAYMENT_EXCEEDS_DUE`; then `paid`, receipt 2 |
| 3.2 | **Reverse it / again** | a negative row, the due back to unpaid; again → 409 `GYM_PAYMENT_NOT_REVERSIBLE`; the original row never changes (append-only) 🤖 |
| 3.3 | **Waive ৳500** | outstanding ৳2,000 (FR-36) |
| 3.4 | **The receipt / the public link / a tampered link** | no TIN line without a TIN (G10); the same JSON behind the signed token, `noindex`; 404 for a forged signature |
| 3.5 | **Renew / freeze / overlapping freeze / unfreeze / cancel the renewal** | continuous upcoming renewal (FR-27); frozen with the end moved (FR-28); 409 for an overlap; the days come back on unfreeze; the cancelled renewal's due voids (FR-30) |
| 3.6 | Change package with credit 🤖 | the §6.1 example: credit round(paid × remaining ÷ total), the old membership `changed` |
| 3.7 | **Today's cash closing / the dashboard** | counter money by staff and method (FR-38); money tiles for the owner (FR-70); `trend` of 14 days ending today and `compare` (the same weekday last week), with money only for the owner and `reports.view` (FR-153, 20 Nov 2026) |
| 3.8 | Parallel payments on one due 🤖 | never over the due; receipt numbers continuous |

## 4. Staff at the desk
| # | Do | Expect |
|---|---|---|
| 4.1 | **Hire the front desk / fees.adjust without fees.collect** | 201; 422 `PERMISSIONS_INVALID` naming the missing permission (FR-04) |
| 4.2 | **Desk: members, search, check in, again** | no amounts; one counted check-in per Dhaka day, the repeat 200 with `firstCheckInToday` (FR-47, FR-48) |
| 4.3 | **Desk: a payment / the settings** | 403 `PERMISSION_REQUIRED` naming `fees.collect` / `owner.only` (FR-06) |
| 4.4 | Entry policy block 🤖 | staff 409 `GYM_ENTRY_BLOCKED` with the reasons; the owner overrides with a reason (audited `gym_attendance.override`) |
| 4.5 | Route matrix 🤖 | another gym's staff 404; removed staff 404; a suspended owner's staff 404 and the owner 403 `ROLE_SUSPENDED` (FR-03, FR-05) |

## 5. Account link and the member area
| # | Do | Expect |
|---|---|---|
| 5.1 | **Invite / a second invite** | pending (the account is known); 409 `GYM_LINK_REQUEST_PENDING`; `GYM_LINK_INVITE` in-app and email to the account |
| 5.2 | **Member: my requests / accept** | the gym, the member code and what the gym will see; accepted (gate `join_gym`); `GYM_LINK_ACCEPTED` to the owner |
| 5.3 | **Member: my gyms / the membership / receipts** | linked, monthly; receipts readable |
| 5.4 | **Member: my check-in QR / Desk: scan it / a forged QR** | `no-store` rotating token; the desk checks in by `member_qr`; 422 `GYM_CHECKIN_TOKEN_INVALID` (a token two windows old too 🤖) |
| 5.5 | **Member: unlink / under Past** | the gym's record stays; receipts stay readable (FR-18) |
| 5.6 | Invite to a phone with no account 🤖 | kept as a phone hash; attached and announced when that phone signs up |

## 6. Import a member list
| # | Do | Expect |
|---|---|---|
| 6.1 | **Upload the CSV** | preview: 3 ok, 1 `duplicate_phone_in_gym`; nothing saved; no phone in the report |
| 6.2 | **Apply / members now / undo / after the undo** | members (source import), memberships by today, dues and opening payments; no notification (FR-78); undo removes them (FR-77) |
| 6.3 | Undo after a check-in 🤖 | 409 `GYM_IMPORT_UNDO_BLOCKED` with the member codes |
| 6.4 | **Kriraghor staff without consent / with consent / discard** | 403 `GYM_IMPORT_CONSENT_REQUIRED`; preview uploaded as staff (FR-79); the discarded preview's file is deleted |
| 6.5 | XLSX, housekeeping 🤖 | the same template in Excel; raw files purged after `gym_manage.import_file_retention_days` (FR-80) |

## 7. Jobs
| # | Do | Expect |
|---|---|---|
| 7.1 | **Runner: run the daily jobs twice** | the second run of `gym-manage.daily` and `gym-manage.dues-overdue` changes nothing (FR-31, FR-39) |
| 7.2 | Freezes start and end, renewals start, expiry, requests expire 🤖 | each once, with its event |

---

# M24 prompt 2 · Money and billing: Acceptance Checklist

Request names refer to the **"Kriraghor API: M24 prompt 2 · Money and billing"** collection (`postman/kriraghor-gym-manage-money.postman_collection.json`, rebuilt with `node postman/build-collection-m24-money.js`). 🤖 marks cases only the jest suites cover (`tests/e2e/gym-manage-money.test.js`, `tests/unit/gym-manage-money-rules.test.js`).

Prompt 2 adds Kriraghor's first gym revenue and the money members ask for: online fee payments through M06 with no margin (the provider's charge passed through at cost), automatic reminders, reports, the owner's monthly invoice with dunning, referral fees and per-gym or per-owner fee overrides.

## P2.0 Setup
- [ ] `npm run release` applies three migrations:
  - `20261114000001-payout-items-provider-charge` (M07): `payout_items.provider_charge_poisha` (default 0).
  - `20261114000002-create-notification-external-deliveries` (M08): email to unlinked gym members through the recipient adapter `gym_member`; no address stored.
  - `20261114000003-gym-manage-money` (M24): `gym_payment_links`, `gym_reminders`, `gym_active_member_counts`, `gym_subscription_invoices`, `gym_subscription_invoice_lines` (append-only), `gym_referrals`, `gym_fee_overrides`, and the foreign key `gym_fee_payments.link_id`.
- [ ] Settings v31 (349 settings: `fees.gym_referral_poisha`, the online-fee, reminder and referral `gym_manage.*` keys, the invoice, founding partner and VAT `gym_saas.*` keys) and templates v24 (the §11.2 templates except the SMS add-on ones).
- [ ] `node postman/run-m24-money.js` → **0 failed**. The runner resets the test database (set `DB_NAME`), makes a gym owner with the `gym_owner` role and a Basic gym, the member Rafiq Hasan with a ৳3,500 due whose own account pays, staff with `members.view` and `fees.collect`, master A and Kriraghor staff with `manage_gyms`, and serves `{{controlUrl}}` (`/pay`, `/drain`, `/release`, `/refunds`, `/reminders`, `/payout`, `/cycle`, `/stepup`).

## P2.1 A payment link
| # | Do | Expect |
|---|---|---|
| P2.1.1 | **The billing page** | Basic; the fees that apply (referral ৳200 and pass commission 5%, both `setting`); no open invoices (FR-90) |
| P2.1.2 | **More than is due / a link for ৳1,500 / a second open link** | 422 `GYM_PAYMENT_EXCEEDS_DUE`; 201 `open` with the gym app `/p/` URL (also the QR payload); 409 `GYM_PAY_LINK_OPEN` naming the open link (FR-40) |
| P2.1.3 | Private owner (no documents) / Free plan 🤖 | 403 `GYM_ONLINE_FEES_UNAVAILABLE` `reason: role` / `tier` (FR-02) |
| P2.1.4 | **Staff list the links / the public page / signed in as the member / a tampered token** | the open link; first name and member code only, `noindex`, no phone; `viewer.canLink`; 404 |

## P2.2 Paying online, the hold and the release
| # | Do | Expect |
|---|---|---|
| P2.2.1 | **Pay and link my membership / Runner: pay by bKash** | `payUrl` and the return on `gym.kriraghor.com/pay/{id}` and `/pay/{id}/result` (FR-104); the member is linked (same phone, FR-41) |
| P2.2.2 | **The link page shows the receipt / pay again** | `paid` with the receipt number; 409 `GYM_DUE_STATE` |
| P2.2.3 | **Owner / staff / member views** | the owner sees `providerCharge` 200 bps = ৳30, net ৳1,470; staff never receive the key; the member sees `null` (FR-43) |
| P2.2.4 | **Runner: release after 73 hours** | escrow 0, the owner's payable ৳1,470, `provider_fee_expense` ৳30, `fee_revenue:gym_fee` 0; invariants pass (FR-44, FR-45) |
| P2.2.5 | **A refund after the release** | 409 `GYM_REFUND_WINDOW_CLOSED` |
| P2.2.6 | **Runner: the weekly payout / the payout line** | gross ৳1,500, fee 0, provider charge ৳30, net ৳1,470; the statement CSV has a "Provider charge" column (FR-46) |
| P2.2.7 | Cash recorded while the member is on the pay page 🤖 | the link is cancelled; the capture is refunded in full (late capture); the due keeps only the cash (FR-42) |
| P2.2.8 | Pass-through off 🤖 | the owner receives ৳1,500; Kriraghor bears the charge |

## P2.3 The member area and a refund from the hold
| # | Do | Expect |
|---|---|---|
| P2.3.1 | **My dues / pay it from the member area / Runner: pay by Nagad** | ৳2,000 outstanding, the gym takes fees online; a member-origin link for the outstanding (an open link is reused 🤖) |
| P2.3.2 | **Staff refund / owner refunds ৳500 / a second refund** | 403 `owner.only`; 201, the link remembers ৳500; 409 `GYM_PAYMENT_NOT_REVERSIBLE` (once per payment) |
| P2.3.3 | **Runner: settle the refund / the reversal row** | `refund.succeeded` writes −৳500 (method online); the due is partial again (FR-44) |

## P2.4 Reminders and reports
| # | Do | Expect |
|---|---|---|
| P2.4.1 | **The reminders page / staff** | offsets from settings (3 days before, overdue after 3), the log with the payment link and receipt notices, no phone; staff 403 (FR-59, FR-61) |
| P2.4.2 | **Runner: the reminder jobs twice** | the second runs send nothing (FR-56) |
| P2.4.3 | A fake-clock week 🤖 | renewal due, overdue and expired once each; "ends today" switched off sends nothing (FR-55); the unlinked member with an email gets one email (external delivery), the member nobody can reach is logged `no_contact` |
| P2.4.4 | Morning summary and monthly report 🤖 | once a day after `gym_manage.morning_summary_time` to the owner and `fees.collect` staff (FR-60); the month before on the 1st for Standard (FR-72) |
| P2.4.5 | **Reports on Basic / choose Standard / the month report** | 403 `GYM_TIER_REQUIRED` `reports` `standard`; online money shown apart (৳3,000), six months of history (FR-71); `previous` for the month before over the same days, `money.daily` adding up to the period's total, `attendance.byMethod` (FR-154, FR-155) |
| P2.4.6 | **Not seen / export the payments / staff export / all my gyms** | 200; CSV with a BOM and the provider charge column, audited `gym_manage.exported`; staff 403 `owner.only`; totals, no side-by-side on Standard (FR-73, FR-74) |

## P2.5 The owner invoice and dunning
| # | Do | Expect |
|---|---|---|
| P2.5.1 | **Runner: the invoice cycle / my invoices / the invoice** | one `GI-26-…` invoice in arrears; Standard was chosen this month, so the tier line is ৳1,500 (FR-82, FR-84) |
| P2.5.2 | **The billing page / pay / Runner: pay by card / paid / pay again** | the open invoice; the gym app pay page; `paid`; 409 `GYM_INVOICE_STATE` (FR-85) |
| P2.5.3 | The §6.6 November example 🤖 | Standard (peak 142 over Basic's 100) ৳1,500 − founding 25% ৳375 + 2 referrals ৳400 = **৳1,525** |
| P2.5.4 | Dunning 🤖 | reminders 3 days before and on the due date; overdue → `past_due`; restricted after `gym_saas.grace_days` (no new members; cash and check-ins still work); paying restores at once; the overdue and restricted notices go by SMS (`money`, G19) |
| P2.5.5 | Referrals 🤖 | a desk member matching a declined join request is `platform`; one referral on the first payment, never again; a reversal before invoicing voids it (FR-91, FR-92) |

## P2.6 The admin desk
| # | Do | Expect |
|---|---|---|
| P2.6.1 | **Owners / owner detail / invoices (manage_gyms)** | counts only, never member data; paid totals |
| P2.6.2 | **Founding partner by staff / by a master without step-up / with step-up** | 403 `MASTER_REQUIRED`; 403 `STEP_UP_REQUIRED`; founding partner no. 1 (FR-88); places full → 409 `GYM_FOUNDING_FULL` 🤖 |
| P2.6.3 | **Referral override ৳150 / a second one / a pass commission of 26%** | 201 `owner_override`; 409 `GYM_OVERRIDE_ACTIVE`; 422 `GYM_OVERRIDE_OUT_OF_BOUNDS` (FR-94) |
| P2.6.4 | **The owner sees the special rate / overrides / end it** | `owner_override` on the billing page (FR-90); listed; ended |
| P2.6.5 | A gym override of 3% on a pass purchase 🤖 | the pass snapshots `fee_bps` 300 and `fee_override_id` (FR-95); the job ends overrides at `valid_to` |
| P2.6.6 | **Voiding a paid invoice** | 409 `GYM_INVOICE_STATE`; an unpaid one is voided and its referrals return to pending 🤖 (FR-89) |

# M24 prompt 3 · Public and plans: Acceptance Checklist

Request names refer to the **"Kriraghor API: M24 prompt 3 · Public and plans"** collection (`postman/kriraghor-gym-manage-plans.postman_collection.json`, rebuilt with `node postman/build-collection-m24-plans.js`). 🤖 marks cases only the jest suites cover (`tests/e2e/gym-manage-plans.test.js`, `tests/unit/gym-manage-plans-rules.test.js`, `tests/unit/m20-rules.test.js`).

Prompt 3 opens the gym to members on the platform: join requests from a live gym's page (with the referral fee on the first payment), trainers assigned to members, workout plans and diet charts that members tick off, the entrance QR at the door, and a directory that sorts by distance.

## P3.0 Setup
- [ ] `npm run release` applies `20261115000001-gym-manage-plans` (M24): `gym_plans`, `gym_plan_versions` (append-only), `gym_plan_assignments` (one active workout plan and one diet chart per member), `gym_plan_logs` (append-only).
- [ ] Settings v32 (353 settings: `gym_manage.entrance_qr_seconds`, `plan_max_items`, `diet_max_meals`, `plan_log_back_days`) and templates v25 (`GYM_JOIN_REQUEST_NEW`, `GYM_JOIN_ACCEPTED`, `GYM_JOIN_DECLINED`, `GYM_PLAN_ASSIGNED`, `GYM_PLAN_UPDATED`).
- [ ] `node postman/run-m24-plans.js` → **0 failed** (68 requests, 110 assertions). The runner resets the test database (set `DB_NAME`), makes a gym owner with a live Standard gym at Gulshan's pin and a cheaper live gym at Uttara, the desk member Bashir, staff Coach Sabbir (`members.trainer`, `plans.manage`) and Cashier Mitu (`members.view`, `fees.collect`), three people who ask to join, and serves `{{controlUrl}}` (`/drain`, `/old-entrance-token`, `/daily`).

## P3.1 The directory and the landing page
| # | Do | Expect |
|---|---|---|
| P3.1.1 | **Nearest first / within 5 km / monthly at most ৳3,500** | every card has `distanceM`, nearest first (a gym without a pin uses its area's centre 🤖); the radius keeps the Banani gym; `priceMax` caps the monthly package (no position → `distanceM` null) |
| P3.1.2 | **Nearest without a position** | 422 `VALIDATION_FAILED` (also a radius without `lat`/`lng`, or `lat` without `lng` 🤖) |
| P3.1.3 | **The gym page / pricing** | `joinRequestsOpen` true (false once the owner switches joins off 🤖); 20 founding places, 2 free months, 25% for 12 months; 0 places hides the offer 🤖 |

## P3.2 Join requests
| # | Do | Expect |
|---|---|---|
| P3.2.1 | **Ask to join / asking again / the owner's own gym** | 201 pending with the package and note; 409 `GYM_LINK_REQUEST_PENDING`; 409 `GYM_JOIN_NOT_OPEN` `own_gym` (FR-16). A private, paused or switched-off gym → `not_live` / `closed` 🤖; an unverified phone → 403 `PHONE_REQUIRED` 🤖 |
| P3.2.2 | **My requests / accepting my own request as an invite** | listed with the invites (`direction`, `canCancel`); 404 (accept and decline answer gym invites only) |
| P3.2.3 | **The gym's requests / the dashboard** | the person's name and the last 4 digits of the phone, the package and the note, no full phone; `requestsWaiting` 1. The owner and `members.view` staff get `GYM_JOIN_REQUEST_NEW`; `members.edit` staff see the to-do `gym_requests_waiting` 🤖 |
| P3.2.4 | **A cashier answers / no Idempotency-Key / accept with the package and ৳2,000 / again** | 403 `members.edit`; 400; a new `platform` member linked to the person, the membership and the receipt; 409 `GYM_LINK_REQUEST_STATE` (FR-17). The referral fee (৳200) charges once on that payment and names the request 🤖 (FR-91); the person gets `GYM_JOIN_ACCEPTED` 🤖 |
| P3.2.5 | **My gyms** | linked; after an unlink the gym stays under Past 🤖 (FR-18); asking again links the existing record with the same phone (no new member, no second referral) 🤖 |
| P3.2.6 | **Decline / ask again and cancel / cancel again** | declined (`GYM_JOIN_DECLINED` to the person 🤖); cancelled; 409. The same phone added at the desk later is `platform` and pays a referral 🤖 (FR-92). Expired requests: the job expires them once 🤖 |

## P3.3 Trainers
| # | Do | Expect |
|---|---|---|
| P3.3.1 | **Who can be picked / a cashier / give Bashir the coach** | staff with `members.trainer` or `plans.manage`; 422 `GYM_TRAINER_INVALID`; the trainer on the profile (FR-21). Basic → 403 `GYM_TIER_REQUIRED` `trainers` 🤖 |
| P3.3.2 | **Members of the coach / the coach's own list** | the `trainerId` filter; a trainer-only caller sees their members only (FR-23) |
| P3.3.3 | Consumers 🤖 | removing one of the two permissions keeps the assignment; removing both, or removing the staff member, clears it (`gym_member.trainer_assigned` with the reason) |

## P3.4 Plans and diet charts
| # | Do | Expect |
|---|---|---|
| P3.4.1 | **Invalid content / write a workout plan / a diet chart / templates** | 422 with paths (`source` ai refused, a `javascript:` link refused, an empty name) (FR-62, FR-68); version 1; the template filter. Over `gym_manage.plan_max_items` → 422 🤖; Basic → 403 `plans` 🤖 |
| P3.4.2 | **The coach gives it to Ayesha / to Bashir / the owner to Ayesha / the diet chart** | 403 `GYM_PLAN_ASSIGN_SCOPE`; 201; 201 (FR-64); `GYM_PLAN_ASSIGNED` to the linked member 🤖 |
| P3.4.3 | **My plans** | today's workout day by §6.10 (10 days into a 2-day plan → day 0), the week, today's meals, "Given by {gym}, not medical advice" (FR-65, FR-69) |
| P3.4.4 | **Ticks: today, untick with a note, another day's item, 7 days back, 8 days back** | 201; 201 (the latest wins); 422 `itemRef`; 201; 422 `GYM_PLAN_LOG_WINDOW` (FR-65) |
| P3.4.5 | **Version 2 for the members who have it / my plan** | `movedAssignments` 2, the members are told once (`GYM_PLAN_UPDATED` 🤖); with the box off they keep theirs 🤖 (FR-63); my plan shows v2 and v1 and my ticks |
| P3.4.6 | **The owner / a cashier / a cashier lists plans** | content, ticks and the health note; titles only; 403 `plans.manage` (FR-66) |
| P3.4.7 | **The plan page / end Bashir's plan / retire / assign a retired chart / the daily job** | adherence (last tick, done in 7 days); ended; retired; 409 `GYM_PLAN_STATE`; nothing past its end date. A new workout plan replaces the old (read-only) 🤖; past `ends_on` the job ends it once 🤖; unlinking makes my plans read-only 🤖 (FR-67); removing a member ends their plans 🤖 |

## P3.5 The entrance QR
| # | Do | Expect |
|---|---|---|
| P3.5.1 | **The tablet's code / a cashier** | `v1.ge.…`, 30 seconds, `no-store`; 403 `attendance.mark` (FR-51). Free → 403 `GYM_TIER_REQUIRED` 🤖 |
| P3.5.2 | **Ayesha scans it / again** | 201 counted, method `entrance_qr`; 200 a repeat with the first time |
| P3.5.3 | **An old code / someone not linked / block for a member with no membership** | 422 `GYM_CHECKIN_TOKEN_INVALID`; 403 `GYM_NOT_A_MEMBER`; 409 `GYM_ENTRY_BLOCKED` with the gym's message and no override; `warn` lets them in with the reasons 🤖 |

## TV Trial visits (product owner, 9 Nov 2026; M24 §17)
Collection `kriraghor-gym-visits.postman_collection.json`, unattended `node postman/run-m24-visits.js`. A Basic gym published and open 06:00 to 22:00, a desk staff member with `attendance.mark`, guests Ana, Bo and Cy with a verified phone, and a Free-tier gym. 🤖 = covered by `tests/e2e/gym-visits.test.js` and `tests/unit/gym-visits-rules.test.js`.

| # | Do | Expect |
|---|---|---|
| TV.1 | **The gym page while off / Ana books** | `{open: false, days: []}`; 409 `GYM_VISITS_CLOSED` (FR-109) |
| TV.2 | **A cap of 51 / staff switch it on / the owner: on, 2 a day, 1 each, a note** | 422; 403; 200 with `visitDailyCapMax` 50 and `visitPerPersonMax` 3 (FR-109) |
| TV.3 | **The gym page** | open, the note, 15 days, tomorrow 06:00–22:00 with 2 places (FR-110) |
| TV.4 | **The owner / staff / 23:00 / 20 days ahead / yesterday / no Idempotency-Key** | 409 `GYM_VISIT_OWN_GYM` twice; 422 `GYM_VISIT_HOURS`; 422 `GYM_VISIT_DATE` twice; 400 (FR-111) |
| TV.5 | **Ana books tomorrow 18:00 / a second day / Bo / Cy** | 201 booked with a 6-character code and a `v1.gv.` QR; 409 `GYM_VISIT_LIMIT`; 201; 409 `GYM_VISIT_FULL` (FR-111). A member with a running membership → 409 `GYM_VISIT_MEMBER` 🤖; more than `gym_manage.visits_per_user_day` bookings in 24 hours → 429 🤖 |
| TV.6 | **My visits** | the code while booked; `no-store` (FR-112) |
| TV.7 | **Tomorrow's guests at the desk** | 2 booked, cap 2; the guest's name and last 4 digits; never the code (FR-113) |
| TV.8 | **Check in tomorrow's visit / (moved to today) find by code / by QR / the dashboard / check in / twice / my visit** | 409 `GYM_VISIT_NOT_TODAY`; the visit twice; `guestsToday` 1; attended; 409 `GYM_VISIT_STATE`; no code or QR any more (FR-114, FR-120). A forged QR finds nothing 🤖 |
| TV.9 | **The phone: desk / owner** | 403; the phone, `no-store`, one audit row 🤖 (FR-116) |
| TV.10 | **Make member: desk / owner / again / the member** | 403; 201; 409 `GYM_VISIT_STATE`; linked, source `desk`, so no referral fee (FR-117) |
| TV.11 | **Bo cancels / twice / Cy cancels Bo's / Cy books the freed place / the gym cancels Cy's with a reason / Cy's visits** | cancelled by the guest; 409; 404; 201; cancelled by the gym; the reason, no QR (FR-112, FR-115). Inside `gym_manage.visit_cancel_cutoff_minutes` → 409 `GYM_VISIT_CANCEL_CLOSED` 🤖 |
| TV.12 | **Notices** | the owner and desk staff: `GYM_VISIT_BOOKED` for each booking and `GYM_VISIT_CANCELLED_BY_GUEST`; Ana `GYM_VISIT_CONFIRMED`; Cy `GYM_VISIT_CANCELLED`; Bo none for his own cancel 🤖 (FR-118) |
| TV.13 | **The morning job at 08:30 / again** | the owner gets `GYM_GUESTS_TODAY`, Bo `GYM_VISIT_REMINDER`; nothing more the second time (FR-119). Before the morning time only no-shows 🤖; a visit whose time has passed gets no reminder 🤖; a no-show counts against the limit 🤖 |
| TV.14 | **A Free gym: on / its page / its list / booking there / an unknown gym** | 200; closed; 403 `GYM_TIER_REQUIRED` {visits, basic}; 409 `GYM_VISITS_CLOSED`; 404 (FR-120) |

## SA The SMS add-on (prompt 3b, M24-FR-96 to FR-100, §18)
Collection `kriraghor-gym-sms.postman_collection.json`, unattended `node postman/run-m24-sms.js` (memory SMS driver). A Basic gym whose owner can take fees online, a phone-only member and a second member each with a month's due, a Free gym, a master. The platform switch starts off (as in production until the gateway, G9); the runner turns it on with prices as a master would. 🤖 = covered by `tests/e2e/gym-sms.test.js`, `tests/unit/gym-sms-rules.test.js` and `tests/unit/settings-validate.test.js`.

| # | Do | Expect |
|---|---|---|
| SA.1 | **The billing page / switch on / choose SMS kinds, while off** | `smsAddon.available` false, balance 0; 409 `GYM_SMS_ADDON_UNAVAILABLE`; 409 `GYM_SMS_ADDON_OFF`. A counter payment sends no SMS at all (no `trans` SMS log row) 🤖 (FR-57) |
| SA.2 | **(switch on) a Free plan / the Basic owner / again** | 409; active with the month's allowance (10) once; still 10 (FR-96). The switch on needs a price, a bundle size and a bundle price; the hold at most `notify.sms_max_segments` 🤖 |
| SA.3 | **Receipts by SMS / the reminders page** | saved; `sms.active`, the balance, the kinds, five choosable (FR-97) |
| SA.4 | **A cash payment of a phone-only member / entries / deliver / entries** | 201; a hold of 2 (balance 8); M08 sends one SMS and settles; a settle (the taka sign makes it Unicode, 2 segments) (FR-99). A linked member gets it on the account's phone; a member who turned gym SMS off gets none and the hold comes back 🤖 |
| SA.5 | **A payment link by SMS / the member's SMS / the pay page by the code / a made-up code** | 201; `gym.kriraghor.com/p/<10 characters>`; 200 with the link; 404 |
| SA.6 | **Buy two bundles / 21 bundles / pay / billing / the invoice** | an `sms_bundle` invoice of ৳1,000 for 200 SMS; 422; the units arrive with the payment; paid with one bundle line (FR-98). Unpaid, it is never dunned and is voided after `gym_saas.sms_bundle_invoice_days` 🤖 |
| SA.7 | **The daily job / the allowance job on the 1st** | nothing stale; last month's allowance left expires and the new month is granted, once 🤖. A hold open for a day is settled as failed 🤖; three parallel holds never overdraw 🤖; low and empty notices once per crossing 🤖 (FR-100) |
| SA.8 | **Adjust: no step-up / below 0 / +25 / the admin desk** | 403; 409 `GYM_SMS_BALANCE_SHORT`; an `adjust` entry, audited `gym_sms.adjusted`; the owner shows the add-on and balance |
| SA.9 | **Switch off / choose kinds** | ended; 409 `GYM_SMS_ADDON_OFF`. The monthly invoice bills `sms_addon` for a month it was on 🤖 |

# M24 · A member renews by themselves, and body progress: Acceptance Checklist

Product owner, 11 Nov 2026; M24-FR-121 to FR-133 ([M24 §19 and §20](../../kriraghor-docs/modules/M24-gym-management.md)). Collection `kriraghor-gym-renewal.postman_collection.json`, unattended `node postman/run-m24-renewal.js`.

## 0. Setup
- [ ] `npx jest --runInBand --coverage=false --runTestsByPath tests/unit/gym-renewal-progress-rules.test.js tests/e2e/gym-renewal.test.js tests/e2e/gym-body.test.js` passes.
- [ ] `node postman/run-m24-renewal.js` → **0 failed** (52 requests, 87 assertions). The runner resets the test database and makes a Standard gym that takes fees online, two linked members (Rafi's Monthly ends in 9 days, Lima's started today), desk staff, a coach, a stranger and a Basic gym with a linked member. M03 counts 421 settings (seed v41); templates v32.

## 1. The read and renewing for the counter (FR-121 to FR-124, FR-126)
| # | Do | Expect |
|---|---|---|
| 1.1 | **Can I renew** | Yes; Monthly (current) and Quarterly, not the desk-only package; the dates continue from the old end; ৳2,500, no admission fee |
| 1.2 | **No Idempotency-Key**, **An unknown way to pay**, **The desk-only package**, **Someone else** | 400; 422; 422 `GYM_PACKAGE_UNAVAILABLE`; 404 |
| 1.3 | **Renew, pay at the counter** | 201: upcoming, made by the member, an unpaid due of ৳2,500, no payment |
| 1.4 | **The same key replays**, **A second renewal** | The same membership; 409 `GYM_RENEWAL_EXISTS` |
| 1.5 | Runner: deliver the events, **The owner is told**, **Staff who take fees are told** | `GYM_RENEWAL_BY_MEMBER` for both |
| 1.6 | **The desk sees who made it** | The membership carries `createdVia: member` |

## 2. Taking a renewal back (FR-125)
| # | Do | Expect |
|---|---|---|
| 2.1 | **The read shows the waiting renewal** | To pay ৳2,500, can be cancelled |
| 2.2 | **Someone else cannot cancel it**, **Cancel my renewal**, **Nothing left to cancel** | 404; renewable again; 409 `GYM_NOTHING_TO_RENEW` |
| 2.3 | **The cancelled renewal is kept, its fee void** | Cancelled and void, never deleted |

## 3. Renewing online (FR-123)
| # | Do | Expect |
|---|---|---|
| 3.1 | **Renew Quarterly, pay online** | 201 with the payment to open (৳6,500) |
| 3.2 | **Until it is paid the fee is with my dues** | Outstanding ৳6,500, payable online |
| 3.3 | Runner: pay it through the simulator, **Paid**, **Cancelling a paid renewal** | Nothing outstanding; 409 `GYM_MEMBERSHIP_STATE` (paid) |

## 4. Too early, and the gym's switch (FR-121, FR-122)
| # | Do | Expect |
|---|---|---|
| 4.1 | **Lima started today**, **Renewing now** | Too early, opens 14 days before the end; 409 `GYM_RENEW_TOO_EARLY` |
| 4.2 | **Settings**, **Staff cannot change the switch** | On by default, 14 days; 403 |
| 4.3 | **The owner switches member renewals off**, the read, **Renewing while off**, on again | `GYM_SELF_RENEW_OFF` in the read and 409 |

## 5. Body progress: the member (FR-128 to FR-130)
| # | Do | Expect |
|---|---|---|
| 5.1 | **Nothing yet, with the limits** | On, empty, the ranges, 365 days back, no-store |
| 5.2 | **No Idempotency-Key**, **An empty entry**, **A weight of 5 kg**, **Dated tomorrow**, **Dated 400 days back** | 400; 422 `GYM_BODY_EMPTY`; 422; 422 `GYM_DATE_OUT_OF_RANGE` twice |
| 5.3 | **Sixty days ago**, **Today** | Two entries oldest first; down 2.2 kg and 3.5 cm; no change yet for body fat |
| 5.4 | **Today again** | Still two entries: the day's first one is replaced |
| 5.5 | **The newest weight is on my health profile**, **Someone else reads nothing** | 61.5 kg; 404 |

## 6. Body progress: the gym, removing, and the plan (FR-131 to FR-133)
| # | Do | Expect |
|---|---|---|
| 6.1 | **The owner reads**, **Desk staff cannot** | 200; 403 `PERMISSION_REQUIRED` |
| 6.2 | **The coach records a measurement** | Recorded by the gym, replacing that day's entry |
| 6.3 | **The member cannot remove what the gym recorded**, **removes their own**, **again** | 409 (recorded by the gym); 200; 409 |
| 6.4 | **Desk staff cannot remove**, **The owner removes the coach's entry** | 403; none left (kept as void) |
| 6.5 | **On a Basic gym…**, **Recording there**, **The Basic owner** | Switched off for the member; 403 `GYM_TIER_REQUIRED` (progress, standard) twice |

## 7. Gym app and phone app
- [ ] **My membership** (member): the Renew card from 14 days before the end; the form with the package, dates and price, Pay online or Pay at the front desk; a waiting renewal with what is still to pay and Cancel renewal; "You can renew from …" when it is too early; a reminder link opens the form.
- [ ] **Body progress** (member): Add a measurement (English or Bangla digits), the change since the first entry, one measurement as a line (points by date), the entries with Remove on the member's own.
- [ ] **Member profile** (owner, plan writers): the same progress card with the gym's wording; "Renewed in the app" on the membership.
- [ ] **Settings** (owner): "Members can renew their package in the app".
- [ ] **Phone app**: the Renew card and the renew screen; the Body progress card and its screen with the chart.
- [ ] Bangla, phone width, light and dark.
