# M19 Dashboards and Analytics (step 1): Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: M19 Dashboards"** collection
(`postman/kriraghor-analytics.postman_collection.json`, rebuilt with `node postman/build-collection-m19.js`).

Step 1 is the shared engine (facts from events, day-grained views, the nightly reconcile), the ground owner's Overview and Analytics, the member's Overview, the platform overview for masters and `view_analytics` staff, "Needs your action" and CSV exports. The live activity feed, the fee simulator and the shop, pro, player and organiser dashboards come later.

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies two migrations:
  - `20261026000001-add-view-analytics-permission` (Q104);
  - `20261026000002-create-analytics`: the `kpi_fact_*` tables, `kpi_processed_events`, `kpi_drift`, and four materialised views (`kpi_mv_owner_day`, `kpi_mv_owner_occupancy_day`, `kpi_mv_owner_hour_day`, `kpi_mv_platform_day`).

  The seed adds settings v11 (181 settings: `analytics.week_start`, `mview_refresh_minutes`, `reconcile_days`, `drift_alert_pct`, `export_sync_max_rows`, `exports_per_hour`) and templates v8 (228 templates: `ANALYTICS_DRIFT`).
- [ ] `npm test`: everything green, including the coverage gates (100% on `analytics.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m19.js` → **0 failed** (24 requests, 50 assertions). The runner:
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
| 3.2 | **CSV of my bookings**, **Owner CSV as a member**, **Platform CSV** | UTF-8 with a BOM, taka with two decimals, +06:00 times, no names or phones; scoped like the screen; audited (`analytics.exported`); `analytics.exports_per_hour` per person (`429 EXPORT_LIMIT`) 🤖 |

## 4. Apps
- [ ] vendor.kriraghor.com: the home shows the owner's tiles, "Needs your action" and the period switch; `/vendor/analytics` shows the four charts and the CSV buttons.
- [ ] kriraghor.com `/me`: the member's tiles, where it went, and "Needs your action".
- [ ] admin.kriraghor.com home: the platform overview for masters and `view_analytics` staff; the staff screen offers the `view_analytics` permission.
