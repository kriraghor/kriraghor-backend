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
| 1.2 | **Packages: month, quarter and a desk-only custom package** | 200; no day pass needed (FR-24); admission fee, channel, visit limit and order kept |
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
| 3.7 | **Today's cash closing / the dashboard** | counter money by staff and method (FR-38); money tiles for the owner (FR-70) |
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
