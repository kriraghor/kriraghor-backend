# M02 KYC lite (NID): Acceptance Checklist

Work through this list before starting M05 lite. Tick each box when the result matches.
Request names refer to the **"Kriraghor API: M02 KYC"** collection
(`postman/kriraghor-kyc.postman_collection.json`, rebuilt with `node postman/build-collection-m02.js`).
Lite scope: the member NID only (front, back, selfie, number, date of birth, legal name), uploaded through the API, reviewed on the KYC desk until M05 exists. No virus scan yet.

## 0. Setup
- [ ] `NID_HMAC_SECRET` is set (`.env`; k3d: `local/secrets.sh` adds it to an existing cluster).
- [ ] `npm run release`. This applies migration `20261021000001-create-kyc` and seeds the 2 member requirements, 2 new `kyc.*` settings (157 in total) and 8 more EN/BN templates (130).
- [ ] `npm test`: everything green, including the coverage gate (100% on `kyc.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m02.js` → **0 failed** (19 requests, 29 assertions). It resets `kriraghor_test`, signs in a master and a member, runs a worker loop, and uploads the files in `postman/fixtures`.
- [ ] `run-m03.js`, `run-m04.js`, `run-m06.js`, `run-m07.js` and `run-m08.js` still pass.

## 1. Member (FR-03 to FR-07, FR-11, FR-18)
| # | Do | Expect |
|---|---|---|
| 1.1 | **Gate: withdraw winnings before KYC** | `KYC_REQUIRED`, `next: /account/verification` |
| 1.2 | **Member checklist** | Phone done, NID missing, badge "Verification needed"; EN or BN labels (`?locale=bn`) |
| 1.3 | **Upload a GIF**, **Upload a PNG labelled JPEG** | `415 FILE_TYPE_NOT_ALLOWED`; `415 FILE_TYPE_MISMATCH`. The type comes from the first bytes |
| 1.4 | Empty file; larger than `kyc.max_file_bytes` (5 MB); too many uploads | `422 FILE_EMPTY`; `413 FILE_TOO_LARGE`; `429 UPLOAD_RATE_LIMITED` above `kyc.uploads_per_hour` 🤖 |
| 1.5 | **Upload the NID front / back / selfie** | `201` with a file id each; stored in the private bucket with its SHA-256 |
| 1.6 | **Submit with a wrong NID number** | `422 NID_FORMAT_INVALID` (10, 13 or 17 digits; 13-digit numbers become 17 with the birth year) |
| 1.7 | Under `kyc.min_age_years` (16, Dhaka calendar); future DOB; missing or another user's files; no consent; no verified phone | `UNDER_MIN_AGE`; `DOB_IN_FUTURE`; `FILES_INCOMPLETE`; `VALIDATION_FAILED`; `PHONE_REQUIRED` 🤖 |
| 1.8 | **Submit the NID** | `201 in_review`, `•••• 0123`; the fields are encrypted; the member role is `in_review`; the member gets "NID sent for review"; staff with `approve_documents` get "NID to review"; events carry ids only |
| 1.9 | Resubmit while in review | The open version becomes `withdrawn`; version 2 is `in_review` 🤖 |

## 2. KYC desk (FR-07, FR-09, FR-12, FR-13)
| # | Do | Expect |
|---|---|---|
| 2.1 | **Queue**, **Review panel** | Masked number, no failed checks; legal name and DOB on the panel; `view_payouts` alone gets `403` 🤖 |
| 2.2 | **View the front (audited)** | Inline JPEG, `no-store`, `nosniff`, sandboxed; one `document.file_viewed` audit row per view |
| 2.3 | **Reveal without a reason**, **Reveal the number with a reason** | `422`; then the full number for 60 s, critical audit `document.nid_revealed`; the number is in no other response, row or log |
| 2.4 | **Approve without the rubric**, **Approve with the full rubric** | `422 RUBRIC_INCOMPLETE`; `200 approved` |
| 2.5 | Ask for changes or reject without a reason | `422 REASON_REQUIRED`; with a reason the member is told why (SMS for changes) and can resubmit 🤖 |
| 2.6 | The same NID on a second account | `nid_unique` fails (blocking), `document.duplicate_nid_detected`; approve gives `409 CHECKS_FAILED`; reject with `duplicate_nid` 🤖 |
| 2.7 | The same image on two accounts | `file_reused` warning (does not block) 🤖 |

## 3. Verified (FR-10, M01-FR-14)
| # | Do | Expect |
|---|---|---|
| 3.1 | **Member role active, identity copied (M01)** | `kycStatus: verified`, member `active`, NID last 4 `0123`; legal name, DOB and NID hash copied from the approved NID; "Member account approved" by SMS |
| 3.2 | Gate and checklist after approval | `withdraw_winnings` allowed; badge "Fully verified"; resubmitting gives `409 DOC_ALREADY_APPROVED` 🤖 |

## 4. Retention (FR-17)
| # | Do | Expect |
|---|---|---|
| 4.1 | Daily `kyc.retention-purge` | Images of decided documents deleted after `kyc.raw_image_retention_days` (90); unused uploads after `kyc.orphan_upload_hours` (24); the hash, type and size stay; a deleted file gives `410 FILE_PURGED` 🤖 |

## 5. Apps
| # | Do | Expect |
|---|---|---|
| 5.1 | kriraghor.localhost/account/verification | Badge, checklist, the NID form with three file pickers and previews, consent; then "Documents in review" with the masked number |
| 5.2 | admin.kriraghor.localhost/admin/kyc | Queue by status with counts, the review panel, files opened on request, reveal with a reason, rubric and decision |
| 5.3 | kriraghor.localhost/me | "Verify your identity", or "Identity verified" once approved |
