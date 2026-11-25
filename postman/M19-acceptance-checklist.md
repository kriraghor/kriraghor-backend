# M19 Dashboards and Analytics (step 1): Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: M19 Dashboards"** collection
(`postman/kriraghor-analytics.postman_collection.json`, rebuilt with `node postman/build-collection-m19.js`).

Step 1 is the shared engine (facts from events, day-grained views, the nightly reconcile), the ground owner's Overview and Analytics, the member's Overview, the platform overview for masters and `view_analytics` staff, "Needs your action" and CSV exports. Round B2 adds the shop owner's, gym owner's and sports organiser's dashboards, their exports and the organiser's to-do list (sections 4 to 6). The live activity feed, the fee simulator and the player dashboard come later (the pro's numbers are M11's `/pro/insights`).

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies two migrations:
  - `20261026000001-add-view-analytics-permission` (Q104);
  - `20261026000002-create-analytics`: the `kpi_fact_*` tables, `kpi_processed_events`, `kpi_drift`, and four materialised views (`kpi_mv_owner_day`, `kpi_mv_owner_occupancy_day`, `kpi_mv_owner_hour_day`, `kpi_mv_platform_day`).

  The seed adds settings v11 (181 settings: `analytics.week_start`, `mview_refresh_minutes`, `reconcile_days`, `drift_alert_pct`, `export_sync_max_rows`, `exports_per_hour`) and templates v8 (228 templates: `ANALYTICS_DRIFT`).
- [ ] `npm test`: everything green, including the coverage gates (100% on `analytics.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m19.js` → **0 failed** (46 requests, 117 assertions with Round B2). The runner:
  - resets `kriraghor_test`, signs in master A, an owner with a fixture ground (৳2,000/h flat, 25% advance) and a member;
  - serves `{{controlUrl}}`, a local test-only control: `/pay`, `/shift`, `/settle` (drain events and refresh the views), `/forget` (delete one fact), `/reconcile`.
- [ ] `run-m02.js` to `run-m10.js` and `run-m21.js` still pass.

## 1. Facts and views (FR-08 to FR-10)
| # | Do | Expect |
|---|---|---|
| 1.1 | **Hold … / Check in / Cancel it**, then **Runner: settle** | Every `booking.*`, `payment.succeeded`, `refund.succeeded`, `ledger.transaction_posted`, closure, series and esports event refreshes its fact by re-reading the record through the owning service; the four views refresh |
| 1.2 | Replays | A replayed event changes nothing (`kpi_processed_events` and the M04 inbox); an older version of a booking never overwrites a newer one 🤖 |
| 1.3 | **Runner: forget one fact**, **nightly reconcile**, **The dashboard is whole again** | The reconcile re-reads the last 35 days, repairs the fact and logs it in `kpi_drift`; above `analytics.drift_alert_pct` of a vertical's daily GMV, masters get `ANALYTICS_DRIFT` |

## 2. Dashboards (FR-01 to FR-07, §6)
| # | Do | Expect |
|---|---|---|
| 2.1 | **Owner overview** | Revenue gross of the fee (Q105): a played ৳2,000 booking earns ৳2,000; a member cancel earns the kept ৳500. Bookings count confirmed, played and no-show ("1 app, 0 walk-in, 0 regular"); occupancy = booked ÷ open half-hours; repeat teams over 90 days. Every tile has a delta (same elapsed part of the previous bucket) and a sparkline |
| 2.2 | Charts | Bookings by day and revenue by ground add up to their tiles (FR-06); weekly revenue with last year; busiest hours |
| 2.3 | **A quarter and a year** / **Wrong period** | 13 weeks or 12 months on the Dhaka calendar, weeks from Monday (Q107); a bad period is `422` |
| 2.4 | **Member asks for the owner view** | `403 ROLE_REQUIRED` (the role is checked on the server) |
| 2.5 | **Member overview** | Spent online minus refunds (৳1,000), bookings, upcoming, where it went by vertical |
| 2.6 | **Platform overview** | GTV = online + venue money recorded by owners (Q106), with online shown; fee revenue from the ledger (৳125); take rate 12.5%; bookings; esports entries and prizes paid; verified members and businesses; the review queue. Staff need `view_analytics` (Q104) 🤖 |
| 2.7 | **What take rate means** | Plain-words definitions in EN and BN |

## 3. Actions and exports
| # | Do | Expect |
|---|---|---|
| 3.1 | **Needs your action** | Owner: check-ins due within the hour, balances unrecorded or due, grounds with changes requested, drafts. Member: holds to pay, NID to verify. Staff: the review queue. Each provider has 800 ms; a slow one is skipped 🤖 |
| 3.1a | **Runner: fill three staff queues**, **Needs your action (staff, FR-29)** | The master gets one item per queue: `payouts_failed` (1, high, `/admin/finance?tab=payouts&status=failed`), `reports_open` (1, `/admin/reports`) and `settings_to_approve` (1, the other master's change, `/admin/fees`); every queue is listed (`total` = the items). Who sees which queue is covered by `tests/e2e/analytics-staff-actions.test.js` 🤖 |
| 3.2 | **CSV of my bookings**, **Owner CSV as a member**, **Platform CSV** | UTF-8 with a BOM, taka with two decimals, +06:00 times, no names or phones; scoped like the screen; audited (`analytics.exported`); `analytics.exports_per_hour` per person (`429 EXPORT_LIMIT`) 🤖 |

## Round B2: numbers and reports for businesses (§6.3)
Setup: `npm run release` also applies `20261110000001-create-business-kpis` (only `kpi_*`: `kpi_fact_sub_order`, `kpi_fact_order_line`, `kpi_fact_gym_pass`, `kpi_fact_gym_admission`; views `kpi_mv_shop_day`, `kpi_mv_shop_category_day`, `kpi_mv_gym_day`, `kpi_mv_gym_hour_day`). No new settings. The first nightly reconcile after it backfills every existing sub-order and pass once. The runner's **Runner: a shop, a gym and a sports organisation** step makes the businesses after the booking checks (so the platform numbers above stay those of the bookings); its `/forget-sub-order` and `/backfill` steps exercise the repair and the backfill.

### 4. Shops (§6.3 "Shop")
| # | Do | Expect |
|---|---|---|
| 4.1 | **Runner: settle the businesses** | `sub_order.*` events refresh the sub-order and its lines (re-read through M13 `orders.reads`); the eight views refresh |
| 4.2 | **Shop dashboard** | Sales = the items of the counted orders, gross of the 5% commission and without delivery (the rejected order is out), note "4 items"; Orders 3; Average order = Sales ÷ Orders; Repeat buyers 0.5 (one of two buyers ordered twice in 90 days). Orders by day and sales by category add up to their tiles (FR-06); weekly sales with last year; best sellers (4 pairs, 30 days). Conversion and the shopper funnel are listed in `comingLater` (no product-view counts yet) |
| 4.3 | **A member asks for the shop view** | `403 ROLE_REQUIRED` |
| 4.4 | **Shop orders CSV**, **Sales by product CSV**, **Shop CSV as a member** | Codes, times (+06:00), statuses (the rejected order is listed), items, taka; sales by product with the category. **No buyer name, phone, address or id.** A member gets `403` |
| 4.5 | **Runner: forget a sub-order fact**, **nightly reconcile**, **The shop dashboard is whole again** | The reconcile re-reads sub-orders changed in the last `analytics.reconcile_days` through M13, repairs the fact and logs it in `kpi_drift` (dataset `sub_order`) |
| 4.6 | **Runner: backfill from empty facts** | With the facts and the marker gone (as on the day of the migration) the reconcile re-reads every sub-order (4) and pass (3) once, without logging drift; the next run does not backfill again 🤖 |

### 5. Gyms (Round B2)
| # | Do | Expect |
|---|---|---|
| 5.1 | **Gym dashboard** | `gym_pass.*` events refresh the pass and its admissions (M20 `gym.reads`). Pass sales ৳400 + ৳4,500 + ৳400 (gross of the fee); passes sold 3 (2 day, 1 month); admissions 2; admissions by day and busiest hours (Dhaka) add up; sales by package adds up to pass sales. Unused share = passes whose last day was in the period and that were never admitted 🤖 |
| 5.2 | **A member asks for the gym view**, **A shop dataset as a gym owner** | `403 ROLE_REQUIRED` |
| 5.3 | **Gym passes CSV**, **Admissions CSV** | Pass codes, kinds, packages, validity, status, price, fee, refunds, admissions; admissions with their time, pass code and method. **No holder name, phone or id** |

### 6. Sports organisers (§6.3 "Organiser", M14 §4.1)
| # | Do | Expect |
|---|---|---|
| 6.1 | **Organiser dashboard** | Through M14's facade (no fact table): teams 2 approved of 4 places (+1 waiting, 1 unpaid, 0 reserve) in running events; entry fees ৳54,000 collected this week from the M06 escrow holds, note held ৳54,000, released 0; matches played 0 of 0; registrations over time (4 registered, 2 approved this week); fees by event |
| 6.2 | **Organisation staff see it too**, **Not a member**, **No organisation chosen** | Staff of the organisation: `200`; anyone else: `404` (M22-FR-03); no `orgId`: `422` |
| 6.3 | **Needs your action (organiser admin / staff)** | Admins: `registrations_waiting` (1) and `registrations_unpaid` (1), linking to `/vendor/tournaments/{orgId}`; staff: the unpaid holds only |
| 6.4 | Exports everywhere 🤖 | Every Round B2 export (and M14's registrations CSV) is capped by `analytics.export_sync_max_rows` (`422 EXPORT_TOO_LARGE`), counted against `analytics.exports_per_hour` (`429 EXPORT_LIMIT`) and audited |

## 7. Apps
- [ ] vendor.kriraghor.com: the home shows the owner's tiles, "Needs your action" and the period switch; `/vendor/analytics` shows the four charts and the CSV buttons.
- [ ] kriraghor.com `/me`: the member's tiles, where it went, and "Needs your action".
- [ ] admin.kriraghor.com home (round 3, FR-30): the platform tiles with the period in the URL for masters and `view_analytics` staff, then one card per staff queue (urgent first, "Urgent" in words), then the charts with Table views and the day table CSV; staff without analytics see their queues and desks only; the staff screen offers the `view_analytics` permission.
