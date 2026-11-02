# Round B3 Staff accounts for businesses: Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: Business members (Round B3)"** collection
(`postman/kriraghor-business-members.postman_collection.json`, rebuilt with `node postman/build-collection-b3.js`).

Round B3 lets a venue, gym or shop owner add staff who work one business (Q170) with a verified phone, not NID (Q169); the owner stays accountable. Staff never see fees, net, released or retained amounts, settlement, analytics or payouts, and never full phone numbers, except shop staff with the shipping permission, who see the buyer's contact on an accepted order's page, every view audited (Q168). 🤖 marks cases only the jest suites cover (`tests/e2e/business-members.test.js`, `tests/unit/business-members-rules.test.js`).

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies `20261111000001-create-business-members`: the `business_members` table (business type and id, owner, member, `permissions` JSONB array, status active or removed with who added and removed them), one active row per business and member (`uq_business_members_active`), the member is never the owner (`ck_business_members_not_owner`).
- [ ] The seed adds settings v27 and v28 (303 settings: `business.team_max_members` = 10; `business.team_adds_per_hour` = 20 and `booking.checkin_due_soon_minutes` = 60 from the B3 review) and templates v22 (`TEAM_ADDED`, `TEAM_REMOVED` with SMS; `TEAM_BOOKING_NEW`, `TEAM_BOOKING_CANCELLED`, `TEAM_CHECKIN_SOON` in-app).
- [ ] `npm test`: everything green, including 100% coverage of `business-members.rules.js` and the module-boundary tests (the module sits in the identity group; venues, gyms and shops register a business adapter at boot).
- [ ] `node postman/run-b3.js` → **0 failed** (80 requests, 136 assertions). The runner resets the test database, makes a venue owner with a two-court ground, a second owner, a member, five people who become staff, one unverified phone, a live shop with two orders and a live gym with a monthly package, and serves `{{controlUrl}}` (`/refresh`, `/pay`, `/shift`, `/drain`, `/fill-team-adds`).

## 1. The owner's team
| # | Do | Expect |
|---|---|---|
| 1.1 | **My team (empty)** | `items: []`, the owner's businesses, the permission catalogue (venue cancel, move and reply to reviews optional and off), `maxMembers` 10 |
| 1.2 | **Unknown number / Myself / A Kriraghor staff account / A phone that is not verified** | 404 `MEMBER_NOT_FOUND`, 422 `MEMBER_IS_OWNER`, 422 `MEMBER_IS_STAFF`, 422 `PHONE_NOT_VERIFIED`; the refusals never echo the person's name, number or account id (Q180) |
| 1.3 | **A permission staff never get / Check-in without the bookings list** | 422 `PERMISSIONS_INVALID` naming the unknown key or the missing one it needs |
| 1.4 | **Another owner's venue** | 404 `NOT_FOUND` (never reveals the business) |
| 1.5 | **Add the counter staff by phone (defaults)** | 201: the six default venue permissions; only the last four digits of the phone; `business_member.added`, audit `business_member.added`, `TEAM_ADDED` (in-app and SMS) |
| 1.6 | **The same person again** | 409 `ALREADY_MEMBER` |
| 1.7 | Over the cap 🤖 | 409 `TEAM_FULL`; two adds racing for the last place: one wins (advisory lock) |
| 1.8 | **Where I work / Me** | The venue, its owner's name and the permissions; `workplaces` on `GET /me` |
| 1.9 | **Runner: use up all but one of owner 2's staff adds** → **The last add this hour** → **Over business.team_adds_per_hour** | 404 (a refusal still counts), then 429 `RATE_LIMITED` with `retryAfter` and nothing about the person; per owner (Redis sliding window, Q180): the shop and gym owners below still add staff |

## 2. The venue desk (route by route)
| # | Do | Expect |
|---|---|---|
| 2.1 | **Staff: the day at the venue** | 200 with `dueAtVenue`, without `fee`, `released`, `retained`, and without full phones; the owner's view still shows the fee |
| 2.2 | **No permission: the day** | 403 `PERMISSION_REQUIRED` naming `bookings.view` |
| 2.3 | **Another venue's staff: this booking** | 404 `NOT_FOUND` (the same answer as a missing id) |
| 2.4 | **Staff: check in** | 200, no `released` block; the money goes to the owner's payable (৳400 in the worked example) 🤖; audited with the staff member as actor (`actorRole` business_staff) and `meta.onBehalfOf` the owner 🤖 |
| 2.5 | **Staff: collect the balance** | 200; `balanceCollectedBy` is the staff member 🤖 |
| 2.6 | **Staff: cancel / move are optional and off** | 403 `PERMISSION_REQUIRED` (Q170) |
| 2.7 | **The owner turns move on** → **the old token is stale** → **Runner: refresh** → **move to court 2** | 200; 401 `AUTHZ_STALE`; the move succeeds within the same venue (staff never see or use the owner's other venues) |
| 2.8 | **Staff: a walk-in** / **another venue's staff: a walk-in here** | 201 with the phone's last four digits only / 404 |
| 2.9 | **Owner-only: pricing, the owner's dashboard** | 403 (pricing, listing, closures, series, analytics never for staff) |
| 2.10 | No-show, extend, move targets, search, reply to reviews 🤖 | Each route: owner unchanged, staff with the permission 200, without 403, another venue's staff 404, removed staff 403 |

## 3. The shop desk
| # | Do | Expect |
|---|---|---|
| 3.1 | **Add a packer (defaults)** | Orders (view, accept, ship, deliver) and stock (view, adjust); reject off |
| 3.2 | **Staff: orders to accept** | No commission, net or released; no buyer contact in lists |
| 3.3 | **Staff: accept** | 200 with `shipTo: null`, `contactHidden: true` |
| 3.4 | **Staff with shipping: the order page** → **The view is in the audit log** | The buyer's phone and address; one `sub_order.contact_viewed` audit row per view (Q168) |
| 3.5 | **Staff: reject is optional and off** | 403 `PERMISSION_REQUIRED` |
| 3.6 | **Staff: ship / received stock / the inventory** | 200; the inventory has no `stockValuePoisha` |
| 3.7 | **Owner-only: the settlement, products and prices** | 403 |
| 3.8 | Notifications 🤖 | Staff with `orders.view` get `SHOP_NEW_ORDER`, with `stock.view` the stock alerts; nobody but the owner gets `ORDER_COMPLETED` (money). Staff's `STOCK_LOW`, `STOCK_OUT` and `SUPPLEMENT_EXPIRING` links name the shop (`&shopId=`), so staff of several shops never hit `BUSINESS_REQUIRED`; the owner's links are unchanged |

## 4. The gym front desk
| # | Do | Expect |
|---|---|---|
| 4.1 | **Staff: admit a pass** | 201 without the amount released; the money goes to the owner 🤖 |
| 4.2 | **Staff: today's admissions** | 200 |
| 4.3 | **Staff: passes sold is optional and off** | 403; with `passes.view` the list has no money 🤖 |
| 4.4 | **Owner-only: the gym's hours** | 403 (listing, packages, hours never for staff) |

## 5. Access follows the owner; removal
| # | Do | Expect |
|---|---|---|
| 5.1 | **Suspend the venue owner's role** → **Staff of a suspended owner** | 403 at once, no workplaces (the principal drops workplaces of owners who are not live on every request) |
| 5.2 | **Reinstate** → **Runner: drain, refresh** → **Access is back** | 200; the consumer made staff tokens stale (`AUTHZ_STALE`) 🤖 |
| 5.3 | Owner account suspended, restored or banned 🤖 | The same: no access while not active |
| 5.4 | **Remove the counter staff / Remove again** | 200 `removed` / 404; `business_member.removed`, `TEAM_REMOVED` |
| 5.5 | **Removed staff: no access** | 403 |

## 6. Staff to-do 🤖
`GET /me/dashboard/actions?role=business_staff`: per workplace, by permission: check-ins due and balances at a venue; orders to accept or ship and stock at a shop. Counts only, never money. "Due" means starting within `booking.checkin_due_soon_minutes` (60), for the owner's to-do too. Staff whose phone is no longer verified (or whose account is not active) get an empty to-do, and venue staff with `reviews.reply` get 403 `PHONE_REQUIRED` on `GET /me/reviews?subjectType=ground&subjectId=`, the same rule as every desk.
