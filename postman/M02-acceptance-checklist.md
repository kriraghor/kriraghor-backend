# M02 KYC lite (NID): Acceptance Checklist

Work through this list before starting M05 lite. Tick each box when the result matches.
Request names refer to the **"Kriraghor API: M02 KYC"** collection
(`postman/kriraghor-kyc.postman_collection.json`, rebuilt with `node postman/build-collection-m02.js`).
**25 Oct 2026 (product owner):** every NID and business document needs an explicit, versioned consent (M02-FR-05), and NID verification is for people aged 18 and over (`kyc.min_age_years` 18, bounds 18 to 21; migrations `20261112000001-kyc-consent` and `20261112000002-kyc-min-age-18`).
Lite scope: the member NID only (front, back, selfie, number, date of birth, legal name), uploaded through the API. Since M05 each version is a `document` submission: staff claim and decide it on the Moderation desk, which embeds this module's document panel (see the M05 checklist for the desk itself). No virus scan yet.

## 0. Setup
- [ ] `NID_HMAC_SECRET` is set (`.env`; k3d: `local/secrets.sh` adds it to an existing cluster).
- [ ] `npm run release`. This applies migration `20261021000001-create-kyc` and seeds the 2 member requirements, 2 new `kyc.*` settings (157 in total) and 8 more EN/BN templates (130).
- [ ] `npm test`: everything green, including the coverage gate (100% on `kyc.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m02.js` → **0 failed** (26 requests, 44 assertions). It resets `kriraghor_test`, signs in a master and a member, runs a worker loop, and uploads the files in `postman/fixtures`.
- [ ] `run-m03.js`, `run-m04.js`, `run-m06.js`, `run-m07.js` and `run-m08.js` still pass.

## 1. Member (FR-03 to FR-07, FR-11, FR-18)
| # | Do | Expect |
|---|---|---|
| 1.1 | **Gate: withdraw winnings before KYC** | `KYC_REQUIRED`, `next: /account/verification` |
| 1.2 | **Member checklist**, **Member checklist in Bangla** | Phone done, NID missing, badge "Verification needed"; EN or BN labels (`?locale=bn`). `consent: { version, draft: true, text }`: the NID text starting "I agree that Kriraghor uses these documents", with the retention days (90, `kyc.raw_image_retention_days`) and the minimum age (18) filled in, Bangla digits in Bangla; `minAgeYears: 18`. The collection keeps `consent.version` in `consentVersion`. With `?role=` the business text |
| 1.3 | **Upload a GIF**, **Upload a PNG labelled JPEG** | `415 FILE_TYPE_NOT_ALLOWED`; `415 FILE_TYPE_MISMATCH`. The type comes from the first bytes |
| 1.4 | Empty file; larger than `kyc.max_file_bytes` (5 MB); too many uploads | `422 FILE_EMPTY`; `413 FILE_TOO_LARGE`; `429 UPLOAD_RATE_LIMITED` above `kyc.uploads_per_hour` 🤖 |
| 1.5 | **Upload the NID front / back / selfie** | `201` with a file id each; stored in the private bucket with its SHA-256 |
| 1.6a | **Submit with the old consent: true**; no consent; `accepted` not true | `422 CONSENT_REQUIRED`, checked before anything else (also for business documents); nothing is stored and no upload is used |
| 1.6b | **Submit with an old consent version** | `422 CONSENT_VERSION_STALE` with `currentVersion` in the problem body |
| 1.6c | **Submit a date of birth one day short of 18** | `422 UNDER_MIN_AGE`, "NID verification is for people aged 18 and over", `minAge: 18` (Dhaka calendar: the 18th birthday is accepted 🤖) |
| 1.6 | **Submit with a wrong NID number** | `422 NID_FORMAT_INVALID` (10, 13 or 17 digits; 13-digit numbers become 17 with the birth year) |
| 1.7 | Under `kyc.min_age_years` (18, Dhaka calendar); future DOB; missing or another user's files; `consent: false`; no verified phone | `UNDER_MIN_AGE`; `DOB_IN_FUTURE`; `FILES_INCOMPLETE`; `CONSENT_REQUIRED`; `PHONE_REQUIRED` 🤖 |
| 1.8 | **Submit the NID** | `201 in_review`, `•••• 0123`; the fields are encrypted; `consent_version` and `consented_at` stored on the row, in the `document.submitted` audit row (`after.consentVersion`, `after.consentedAt`) and `consentVersion` in the event 🤖; the member role is `in_review`; the member gets "NID sent for review"; staff with `approve_documents` get "NID to review"; events carry ids only |
| 1.9 | Resubmit while in review | The open version becomes `withdrawn`; version 2 is `in_review` 🤖 |

## 2. Review on the Moderation desk (FR-07 to FR-09, FR-12, FR-13)
| # | Do | Expect |
|---|---|---|
| 2.1 | **Queue (documents)**, **Claim it** | One `document` waiting; claimed by me, no failing check, payload with the document id and the masked number; `view_payouts` alone gets `403` 🤖 |
| 2.2 | **Review panel** | Legal name, DOB, masked number, the three files; `consent: { version, at }` (`null` for documents sent before 25 Oct 2026 🤖) |
| 2.2a | **NID holders under the minimum age (audited)** | `GET /admin/kyc/under-min-age` (`approve_documents`, `no-store`): `minAgeYears 18`, none here. Lists current NID documents (approved, in review, changes requested) of people under 18 today with their age only (never the number or DOB), from `users.dob` or else the document; every view audited `kyc.under_min_age_listed` 🤖. `node scripts/kyc-under-min-age.js` prints only the count |
| 2.3 | **View the front (audited)** | Inline JPEG, `no-store`, `nosniff`, sandboxed; one `document.file_viewed` audit row per view |
| 2.4 | **Reveal without a reason**, **Reveal the number with a reason** | `422`; then the full number for 60 s, critical audit `document.nid_revealed`; the number is in no other response, row or log |
| 2.5 | **Approve without the rubric**, **Tick the rubric**, **Approve** | `422 RUBRIC_INCOMPLETE`; nothing missing; `200 approved`. M02 applies it and acknowledges with `submission.applied` |
| 2.6 | Ask for changes or reject without a reason; a reason of another kind | `422 REASON_REQUIRED`; `422 REASON_NOT_ALLOWED_FOR_KIND`; with `unreadable` the member is told why (SMS for changes) and can resubmit 🤖 |
| 2.7 | The same NID verified on a second account | `nid_unique` fails (blocking, cannot be overridden), `document.duplicate_nid_detected`; approve gives `422 CHECK_FAILED`; reject with `duplicate` 🤖 |
| 2.8 | The same NID only waiting on another account | `nid_pending_elsewhere` fails; a master may approve over it with step-up and a reason (M05 Q46) 🤖 |
| 2.9 | The same image on two accounts | `file_reused` warning (does not block) 🤖 |

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
| 5.1 | kriraghor.localhost/account/verification | Badge, checklist, the NID form with three file pickers and previews, the consent box (unticked; submit disabled until ticked; the API text) and an 18+ note; then "Documents in review" with the masked number |
| 5.2 | admin.kriraghor.localhost/admin/kyc | Redirects to the Moderation desk filtered to documents; the review pane embeds the document panel (files opened on request, reveal with a reason) |
| 5.3 | kriraghor.localhost/me | "Verify your identity", or "Identity verified" once approved |
