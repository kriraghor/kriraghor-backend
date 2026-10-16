# M09 Grounds (step 1): Acceptance Checklist

Work through this list before starting M10. Tick each box when the result matches.
Request names refer to the **"Kriraghor API: M09 Grounds"** collection
(`postman/kriraghor-grounds.postman_collection.json`, rebuilt with `node postman/build-collection-m09.js`).

Step 1 covers the supply side: who may list (business documents), the listing and its review, courts and hours, photos, versioned pricing, and the public pages. Closures, weekly series, moving bookings and the "most open hours" sort come with M10, because they write its booking slots.

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies four migrations:
  - `20261024000001-create-places-catalog`: sports, divisions, districts, areas, facilities, surfaces, and `pg_trgm`;
  - `20261024000002-business-documents`;
  - `20261024000003-moderation-ground-kind`;
  - `20261024000004-create-grounds`.

  The seed adds:
  - places v1: 124 rows (9 sports, 8 divisions, 64 districts, 21 areas, 15 facilities, 7 surfaces);
  - settings v9: 170 settings (`ground.min_photos`, `max_photos`, `photo_max_bytes`, `photo_uploads_per_hour`, `duplicate_radius_m`, `closure_max_days_ahead`);
  - templates v6: 196 templates;
  - three `ground_owner` document requirements;
  - the `ground` rubric and reasons.
- [ ] `npm test`: everything green, including the coverage gates (100% on `pricing.rules.js`, `grounds.rules.js` and `kyc.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m09.js` → **0 failed** (69 requests, 115 assertions). The runner:
  - resets `kriraghor_test` and signs in masters A and B (B reviews);
  - creates an owner who is an active member and has applied as a ground owner;
  - serves `{{controlUrl}}`, a local test-only control: `/refresh` hands back a fresh owner token after a role change, and `/settle` drains events.
- [ ] `run-m02.js` to `run-m08.js` and `run-m21.js` still pass.

## 1. Places catalogue (M03 §6.1, §6.3)
| # | Do | Expect |
|---|---|---|
| 1.1 | **Areas where grounds are listed** | 18 Dhaka metro areas (Q15). `?q=` matches English and Bangla names and aliases ("Mirpur 10" → Mirpur) 🤖 |
| 1.2 | **Divisions and districts** | 8 divisions and 64 districts with BBS codes |
| 1.3 | Staff edit places (portal, Places and sports) | Needs `manage_catalog` (esports staff get 403). Keys and the parent district never change. A zone is allowed only for Dhaka metro areas 🤖 |

## 2. Becoming a ground owner (M02 lite → M01)
| # | Do | Expect |
|---|---|---|
| 2.1 | **Applied but not active** | `403 ROLE_PENDING`. Before applying: `ROLE_REQUIRED`; before the NID: `KYC_REQUIRED` 🤖 |
| 2.2 | **The checklist** | Trade licence and deed or lease required, TIN optional, each with its fields and labels |
| 2.3 | **Expired licence** | `422 VALIDATION_FAILED` ("This date has passed"). Unknown fields are refused too 🤖 |
| 2.4 | **Send the trade licence** | `in_review`, number masked `•••• 9912`. The role moves to `in_review` and the owner is told |
| 2.5 | Reviewer panel (portal, Moderation desk → document) | Typed fields, the masked number and the file viewer; checks are the reused-file and still-valid checks; `REVEAL_NOT_AVAILABLE` for business documents 🤖 |
| 2.6 | **Trade licence / Lease: approve** | Once both required documents are approved, `verification.passed {ground_owner}` arrives and the role becomes active (only with an active member role). The owner gets "account approved" by SMS |
| 2.7 | Changes requested on one document | The role moves to `changes_requested`; the owner gets an SMS naming the document 🤖 |

## 3. Listing and review (FR-01 to FR-07)
| # | Do | Expect |
|---|---|---|
| 3.1 | **Create a draft ground** | `draft`, a slug, and a pricing draft (v1) from the base price and the design defaults. An area outside Dhaka gives `AREA_NOT_SERVED` 🤖 |
| 3.2 | **Send it incomplete** | `422 GROUND_INCOMPLETE` listing what is missing (photos, courts) |
| 3.3 | **Add a court** | `pending`, open 06:00–23:00 every day by default. A non-ground sport gives `CATALOG_ITEM_UNKNOWN`; a duplicate name gives `COURT_NAME_TAKEN` 🤖 |
| 3.4 | **Photo 1–3**; **A GIF is refused** | JPEG, PNG and WebP go to the public bucket with a year-long cache, under keys never reused. A GIF gives `415` |
| 3.5 | **Send for review**; **Not public while in review** | `pending_review`; the public page is 404; editing gives `GROUND_IN_REVIEW` |
| 3.6 | **Ground: claim** | Checks: owner documents (hard, locked), photos (hard), hours and rules (hard), price range (soft), similar name within 1 km (soft) |
| 3.7 | **Ground: approve** | `live`, version 1, courts active, first pricing published; the owner gets "approved and live" by SMS. A replayed approval changes nothing 🤖 |
| 3.8 | Changes requested, rejected, withdraw | `changes_requested` with the reason (SMS) → resubmit; `rejected` is final; a withdrawn ground can be sent again 🤖 |

## 4. Public pages and quote (FR-13, FR-25, FR-27, §6.1)
| # | Do | Expect |
|---|---|---|
| 4.1 | **Listed with facets** | Only `live` grounds. "From" is the lowest hourly rate this week (early bird: ৳1,920). Facet counts ignore their own filter; sorts are cheapest, nearest and newest; the cursor pages through 🤖 |
| 4.2 | **Detail** | The public version (snapshot) with photos, courts and hours, facilities, and the week's price table. v3 payment line: advance or full online; the advance is not refunded |
| 4.3 | **Quote: Monday 18:00, 120 min** | ৳6,000, advance ৳1,800, fee ৳300, full payment leaves the owner ৳5,700. Worked examples 2–4 and the ৳2,000 v3 example are in the unit tests 🤖 |
| 4.4 | **After closing** | `422 OUTSIDE_HOURS`. Wrong lengths give `LENGTH_INVALID`; other courts give `COURT_UNKNOWN`; courts that cannot combine give `NOT_COMBINABLE` 🤖 |

## 5. Pricing (FR-09 to FR-14)
| # | Do | Expect |
|---|---|---|
| 5.1 | **Pricing view** | Published v1, no draft, 0 upcoming bookings, the limits from settings, the v3 policy |
| 5.2 | **Advance above 50%** | `422`. The validation matrix (base ৳800–6,000, peak ≤ 60, weekend ≤ 50, early ≤ 50, half < full, advance ≥ the 5% fee) is in the unit tests 🤖 |
| 5.3 | **Save a ৳3,000 draft**; **Quote with an unsaved advance** | Draft v2; the calculator prices the unsaved change (৳7,500 with a ৳3,000 advance) |
| 5.4 | **Publish**; **History** | v2 published with the summary "Updated pricing: base ৳3,000/h"; v1 superseded with `effective_to`; the audit row has the before and after values |
| 5.5 | **The public quote follows** | ৳7,500 on rules v2 |
| 5.6 | Base price while in review; "apply to all my grounds" | `GROUND_IN_REVIEW`; each ground keeps its own base and court prices 🤖 |

## 6. Live edits, pause and staff (FR-03 to FR-05)
| # | Do | Expect |
|---|---|---|
| 6.1 | **Rename**; **The public keeps the approved name** | The edit waits for review (`editStatus draft`); the description (not a review field) is public at once |
| 6.2 | **Send the edit**; **Edit: approve** | The reviewer sees a diff (fields, courts added or changed, photos added or removed); the new name is public and the slug stays |
| 6.3 | **Pause**; **Show again** | Hidden, then back; bookings would stay (M10) |
| 6.4 | Hours; reordering photos; removing a photo; retiring a court | Hours and photo order apply at once; removing a photo is an edit; the last court of a live ground cannot retire (`LAST_COURT`); a court with upcoming bookings cannot either (`COURT_HAS_BOOKINGS`, through the M10 port) 🤖 |
| 6.5 | **Staff list**; **Staff view** | `approve_listings` or `manage_users` only |
| 6.6 | **Suspend**; **Restore**; **Audit log** | `manage_users` suspends; masters restore and remove (a status, never deleted). Critical audit. A suspended `ground_owner` role, or a suspended or banned account, pauses every live ground 🤖 |

## 7. Apps
- [ ] kriraghor.com:
  - `/account/business`: apply, send the documents, see their status, then a link to the business desk;
  - `/grounds`: filters in the URL, facets, cards, empty and error states;
  - `/grounds/[slug]`: gallery, facts, courts and hours, rules, the price table, and the "booking opens soon" aside;
  - the home page grounds section.
- [ ] vendor.kriraghor.com:
  - the home shows the owner's steps;
  - `/vendor/grounds`: status tabs and "Add a ground";
  - the ground editor: basics, photos with order and remove, courts with weekly hours, send for review, withdraw, pause and resume;
  - `/vendor/grounds/[id]/pricing`: rules, save, discard and publish, "apply to all", the quote calculator with both payment options, the heatmap and history.
- [ ] admin.kriraghor.com:
  - Moderation desk: the ground panel (diff, photos, courts and hours, price) and the business-document fields;
  - `/admin/grounds`: suspend, restore, remove;
  - `/admin/catalog/places`.
