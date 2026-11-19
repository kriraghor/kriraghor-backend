# M11 Hire (step 1, the core hire loop): Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: M11 Hire (step 1)"** collection
(`postman/kriraghor-hire.postman_collection.json`, rebuilt with `node postman/build-collection-m11.js`).

Step 1 covers the core loop:
- the M03 hire taxonomy;
- a credential per hire role (M02);
- hire profiles reviewed on the Moderation desk (M05 kind `hire_profile`) with versioned rate cards;
- the directory and the server quote;
- requests with the five checks, accept, and one payment split into one escrow hold per job (M06);
- a message thread with contact masking until payment;
- match day (check in, start, mark complete), confirm or auto-release after `hire.auto_release_hours`;
- the cancellation tiers and the pro's withdrawal;
- a no-show as an M17 dispute.

Step 2 brings month and season contracts (Q71), conduct reports, the M10 official add-on (Q5), reliability penalties (Q72) and the availability grid.

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies three migrations:
  - `20261031000001-create-hire-taxonomy` (M03): `hire_categories` and `hire_roles` (units, formats, credential tiers, rate limits);
  - `20261031000002-hire-kinds`: M05 kind `hire_profile`; M17 source `hire_job` with categories `no_show` and `job_problem`; M02 document types `credential` and `police_clearance`;
  - `20261031000003-create-hire`: `hire_profiles`, `rate_cards`, `rate_card_items`, `hire_requests`, `jobs` (an exclusion constraint per pro over busy time plus `hire.travel_buffer_min`), `hire_messages` (append-only), `hire_shortlists`.

  The seed adds:
  - `hire.v1.json` (6 categories, 24 roles);
  - settings v16 (243 settings): `hire.payment_window_min`, `hire.cancel_free_hours`, `hire.cancel_high_hours`, `hire.cancel_fee_72h_pct`, `hire.cancel_fee_24h_pct`, `hire.no_show_after_min`, `hire.match_hours`, `hire.messages_per_hour`, `hire.shortlist_max`;
  - templates v13 (`HIRE_*`, `JOB_*`);
  - KYC requirements v3 (`player` and `pro`);
  - the `hire_profile` rubric.
- [ ] `npm test`: everything green, including the coverage gates (100% on `hire.rules.js`, `orders.rules.js`, `ledger.rules.js`, `trust.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m11.js` → **0 failed**.
  - The runner resets `kriraghor_test`.
  - It signs in master A, a documents reviewer, a listings reviewer, a disputes desk member, a pro applicant (Kamrul) and two managers.
  - It serves `{{controlUrl}}`: `/settle`, `/refresh`, `/pay`, `/move`, `/tick`, `/check`.
- [ ] `run-m02.js` to `run-m10.js`, `run-m12.js`, `run-m13.js`, `run-m17.js`, `run-m18.js`, `run-m19.js` and `run-m21.js` still pass. M03 counts 243 settings.

## 1. Taxonomy and the credential (M03, M02)
| # | Do | Expect |
|---|---|---|
| 1.1 | **The hire taxonomy** | 6 categories, 24 roles; cricket umpires are priced per format (T10, T20, OD, TAPE) |
| 1.2 | **A level the role does not have** | 422 |
| 1.3 | **Send the BCB Level 2 credential**, approve it on the desk, **refresh** | Kept under `hire:cricket_umpire`; the pro role turns active; the credential shows as approved |
| 1.4 | Police clearance for U16 work 🤖 | A profile with `worksWithU16` fails the check until `police_clearance` is approved and in date |

## 2. The profile and its review (FR-10 to FR-14)
| # | Do | Expect |
|---|---|---|
| 2.1 | **A semi-pro umpire profile in Dhanmondi** | Draft, with the rate limits for each unit and format |
| 2.2 | **Sending without rates**, **A rate under the limit** | 409 `RATE_CARD_REQUIRED`; 422 |
| 2.3 | **The design rate card**, **Send for review** | Version 1 with two items; `pending_review` |
| 2.4 | Approve on the listings desk, **The profile is live** | Live, version 1 published |
| 2.5 | **The directory lists it**, **The profile page** | One official from ৳2,500; the BCB Level 2 badge |
| 2.6 | **A quote: T20 night in Mirpur** | ৳4,500 = ৳3,500 + 20% night (৳700) + travel north (৳300); at under 48 h notice the short-notice 15% applies too 🤖 |
| 2.7 | Editing a live profile 🤖 | The live copy stays up; the new copy goes back to review |

## 3. Requests, accept and payment (FR-20 to FR-26)
| # | Do | Expect |
|---|---|---|
| 3.1 | **Manager 1: two T20 nights**, **Manager 2: the first night** | 201 each, quoted on the server; a second identical request from the same manager is 409 `DUPLICATE_REQUEST` 🤖 |
| 3.2 | **Requests to answer, with the checks** | Two, all five checks pass |
| 3.3 | **Accept manager 1** | `accepted_unpaid`; both jobs `reserved`; a payment with one split per job |
| 3.4 | **Manager 2 now clashes** | 422 `CHECKS_FAILED` on `free` (two concurrent accepts: one `SCHEDULE_CLASH` 🤖) |
| 3.5 | **A phone number before payment**, **A message**, **The pro sees it** | 422 `CONTACT_NOT_ALLOWED`; 201; one message, not masked away |
| 3.6 | **Unpaid: the payment link**, **pay**, **Confirmed; the phone shows** | No phone before paying; after paying `confirmed`, jobs `scheduled`, the other party's phone shows |
| 3.7 | Not paid by `pay_by`; not answered by `reply_by` 🤖 | The tick lapses or expires the request; jobs void; late money is refunded |

## 4. Match day and confirm (FR-30 to FR-34)
| # | Do | Expect |
|---|---|---|
| 4.1 | **Check in too early** | 409 `TOO_EARLY` (opens `hire.checkin_open_before_min` 60 before) |
| 4.2 | **Check in (late)** at 20 minutes before | Checked in, late (under `hire.late_before_start_min` 30) |
| 4.3 | **Start** at 10 minutes before, **Mark complete** | Live, then `completed_marked` with the auto-release time |
| 4.4 | **The manager confirms**, **ledger** | Released by the manager; the pro's payable ৳4,050, fee ৳450 |
| 4.5 | No action for `hire.auto_release_hours` 🤖 | Released by the tick unless a dispute is open |

## 5. Cancel, withdraw and a no-show (§6.6, FR-35, FR-51)
| # | Do | Expect |
|---|---|---|
| 5.1 | **Cancel preview** at 30 h, **Cancel**, **ledger** | Tier 24 to 72 h: fee 25% (৳1,125), ৳3,375 back; the pro gets ৳1,012.50 (payable ৳5,062.50). Over 72 h free, under 24 h 50% 🤖 |
| 5.2 | **Accept** manager 2, **pay**, **The pro withdraws** | Withdrawn; ৳4,500 back in full |
| 5.3 | **No-show: an M17 dispute** 61 minutes after the start | A case `hire.no_show` holding ৳4,500; the hold frozen |
| 5.4 | **The pro answers**, **The desk claims it**, **All back** | Resolved; ৳4,500 refunded |
| 5.5 | **Staff: the first request with its holds** | Two jobs with their escrow; no phone |
| 5.6 | Platform cancel 🤖 | Master only, step-up `escrow.manage`; the job is cancelled and refunded in full |
| 5.7 | **ledger still balanced** | Invariants hold; the pro's payable unchanged at ৳5,062.50 |

## 6. Round B1: insights, calendar and photo (FR-05, FR-14, FR-52, M19 §6.3, M01)
| # | Do | Expect |
|---|---|---|
| 6.1 | **Insights** (7 weeks, then by month) | Earned ৳5,062.50 this period (ledger, net of the 10% fee) in this week's bucket; 7 or 12 buckets; jobs done 1; acceptance in %; `period=month` 422 |
| 6.2 | **My profile: stats and completeness** | `stats.jobsDone` 1 (the stats consumer); completeness steps photo, headline, bio (60+ characters), rate card, credential, availability, payout account |
| 6.3 | **Block the evening of the day-8 match** | One block with its reason; audited `availability.updated`; not moderated |
| 6.4 | **The public strip** | Busy times only, no reasons and no job details |
| 6.5 | **A request over the block** | 409 `PRO_UNAVAILABLE` |
| 6.6 | Block a pending request's time, then accept 🤖 | The `available` check fails on `/pro/requests`; accept 422 `CHECKS_FAILED` (`available`) |
| 6.7 | Block over a booked job 🤖 | 409 `BLOCK_OVER_JOB` with the job codes |
| 6.8 | **Beyond the horizon** | 422 (`hire.availability_horizon_days` 60) |
| 6.9 | **My calendar**, **Clear the calendar** | The block in the range, weekly repeats expanded; then empty |
| 6.10 | **A profile photo (PNG)**, **A PDF is not a photo** | Me shows `avatarUrl` (public bucket); the PDF 415 `FILE_TYPE_NOT_ALLOWED`; over `users.avatar_max_bytes` 413 🤖 |
| 6.11 | **The directory card shows the photo**, **Remove the photo** | Card with `avatarUrl`, `availableToday`, jobs done and reply stats; removed → `avatarUrl` null |

## 7. Photo and intro video (M11-FR-16 to FR-18, tester feedback 19 Nov 2026)
| # | Do | Expect |
|---|---|---|
| 7.1 | Folder 2: **Sending without a photo**, **The profile photo**, **Send for review** | 409 `PHOTO_REQUIRED`; with the photo, `pending_review` |
| 7.2 | **A fb.watch link cannot be shown** | 422, `errors[0]` `field: introVideoUrl`, `code: facebook_video` |
| 7.3 | **A YouTube intro video**, **Not public before review** | `editStatus: draft`, `introVideo.playUrl` on youtube-nocookie; the public page has no video yet |
| 7.4 | **The photo was removed: sending the edit**, **The photo again**, **Send the edit for review** | 409 `PHOTO_REQUIRED`; then the edit is in review |
| 7.5 | **The edit on the desk**, **Reviewers see the photo and the link**, approve | The staff view has `owner.avatarUrl` and `introVideoUrl` |
| 7.6 | **The page plays the video**, **The card has the play badge** | `introVideo.provider: youtube`, `kind: iframe`; `hasIntroVideo: true` |
| 7.7 | Every kind of link 🤖 (`tests/unit/m11-intro-video.test.js`, 100% branches) | YouTube, Vimeo (with hash), Facebook (videos, reels, watch), Drive, OneDrive embed, Dropbox (raw=1), .mp4/.webm/.m4v, .m3u8; http, local hosts and long links refused |
| 7.8 | Switched off 🤖 (`tests/e2e/hire-media.test.js`) | `hire.intro_video_providers` without youtube: the page hides it and a save is refused with `provider_off`; an empty link removes it |

### By hand (kriraghor.com, gym.kriraghor.com, admin)
- [ ] **/pro/profiles/[id]**: "Your photo" at the top sets the account photo; Send for review is off with "Add your photo…" until there is one.
- [ ] **Intro video link**: paste each kind (YouTube, Vimeo, Facebook video, Drive, OneDrive embed, Dropbox .mp4, an .mp4 and an .m3u8); after Save, "How your video plays" plays it. A wrong link shows why under the field.
- [ ] **/hiring/[slug]**: nothing loads from the video's host until Play; YouTube plays without cookies; an .m3u8 plays in Chrome (hls.js) and Safari; "Open on …" opens the original.
- [ ] **Hire cards** and **gym.kriraghor.com/trainers**: the Video tag; a trainer without a photo shows initials.
- [ ] **Admin moderation panel**: the photo (or "No photo") and the video link with the reminder to watch it.
- [ ] Bangla, phone width, light and dark.
