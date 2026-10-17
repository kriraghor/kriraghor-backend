# M13 Orders (step 1, shop orders): Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: M13 Orders (step 1, shop orders)"** collection
(`postman/kriraghor-orders.postman_collection.json`, rebuilt with `node postman/build-collection-m13.js`).

Step 1 covers shop orders end to end with online payment: the cart, a server-side quote, one payment split into one escrow hold per shop (M06), the shop's accept, reject, ship and delivered, the buyer's received and cancel, the deadlines, "not received" as an M17 dispute, the staff desk and M07's weekly shop payout. Returns, COD and used gear come in step 2.

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies three migrations:
  - `20261030000001-escrow-splits` (M06): `escrow_holds.split_ref` (one hold per split, UNIQUE (payment_id, split_ref); payments without splits keep one hold), `refunds.escrow_hold_id`;
  - `20261030000002-disputes-sub-orders` (M17): source type `sub_order`, category `not_received`, the shop as respondent;
  - `20261030000003-create-orders`: `carts`, `cart_items`, `orders` (phone and address encrypted), `sub_orders`, `order_items` (append-only).

  The seed adds settings v15 (233: `market.checkout_hold_minutes`, `market.cart_line_days`, `market.ship_overdue_buyer_cancel_hours`, `market.ship_overdue_auto_cancel_hours`, `market.shop_accept_reminder_hours`, `disputes.window_order_hours`) and templates v12 (`ORDER_*`, `SHOP_NEW_ORDER`, `SHOP_ORDER_REMINDER`, `SHOP_ORDER_CANCELLED`).
- [ ] `npm test`: everything green, including the coverage gates (100% on `orders.rules.js`, `ledger.rules.js`, `trust.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m13.js` → **0 failed**. The runner resets `kriraghor_test`, builds two live shops through the M12 fixtures (A: boots at ৳2,600 in EU 42 and 43; B: ৳1,200 in EU 42; 3 each), signs in master A, a buyer and a disputes desk member, mints one `escrow.manage` step-up and serves `{{controlUrl}}`: `/pay`, `/expire`, `/check`, `/settle`.
- [ ] `run-m02.js` to `run-m10.js`, `run-m12.js`, `run-m17.js`, `run-m18.js`, `run-m19.js` and `run-m21.js` still pass. M03 counts 233 settings; the M12 product page now says `checkoutOpen: true`.

## 1. The cart and the quote (FR-01 to FR-03)
| # | Do | Expect |
|---|---|---|
| 1.1 | **Not your own shop**, **More than the stock** | 422 `OWN_ITEM`; 409 `INSUFFICIENT_STOCK` |
| 1.2 | **Two of A**, **One of B** | Two shop groups, 3 items, ৳6,400, ready |
| 1.3 | **Quote outside Dhaka**, **Quote in Dhanmondi** | ৳150 per shop (৳6,700); ৳80 per shop: sub-orders ৳5,280 and ৳1,280, total ৳6,560, no price changes |
| 1.4 | Cart lines older than `market.cart_line_days` 🤖 | Drop out; adding the item again takes today's price |

## 2. Checkout and payment (FR-04 to FR-07)
| # | Do | Expect |
|---|---|---|
| 2.1 | **A stale total is refused** | 409 `PRICE_CHANGED` with the new quote; nothing held |
| 2.2 | **Place the order**, **Replay with the same key** | 201 with the pay link; codes `KG-26-…-A` and `-B`; the replay returns the same order |
| 2.3 | **Pending payment**, then **pay**, **Placed** | Phone masked to the last four; after paying, both sub-orders `placed` with accept deadlines; the cart is empty |
| 2.4 | The ledger 🤖 | One capture posting: Dr provider clearing ৳6,560, Cr escrow ৳5,280 and ৳1,280, one hold each (payee: the shop owner) |
| 2.5 | Two buyers, the last pair 🤖 | One checkout wins; the other gets 409 `INSUFFICIENT_STOCK` |
| 2.6 | Not paid in time; then the money arrives 🤖 | The tick cancels the order and frees the stock; the late capture is refunded hold by hold (`late_capture`); nobody is notified |

## 3. Fulfilment and completion (FR-08 to FR-14)
| # | Do | Expect |
|---|---|---|
| 3.1 | **To accept** | The area but no address (FR-10); commission ৳260, net ৳5,020 |
| 3.2 | **Another shop cannot accept it**, **The buyer is not a shop**, **Shipping before accepting** | 403 `NOT_YOUR_SHOP`; 403; 409 `ORDER_STATE` |
| 3.3 | **Accept** | The buyer's name, phone and address show |
| 3.4 | **A bad tracking number**, **Ship with Pathao**, **Mark delivered** | 422; shipped with the tracking number (stock committed); delivered with the auto-complete time |
| 3.5 | **Received** | Completed; A's hold is released: ৳5,020 to A's payable, ৳260 fee on the items only |
| 3.6 | **B rejects its sub-order** | Rejected; ৳1,280 refunded from B's own hold; B's stock released; the order is complete |
| 3.7 | **ledger**, **Settlement** | Invariants hold; A ৳5,020, B ৳0, fee ৳260; one completed sub-order |
| 3.8 | Auto-complete, accept reminder 🤖 | Delivered and not confirmed for `market.auto_complete_days`: completed by itself; one reminder `market.shop_accept_reminder_hours` before the accept deadline |
| 3.9 | M07 🤖 | The `shop_weekly` run pays A its ৳5,020 |

## 4. Not received (M17 category not_received)
| # | Do | Expect |
|---|---|---|
| 4.1 | **What the buyer can open** | `not_received` holding ৳2,680 |
| 4.2 | **Not received**, **Received is blocked** | A case awaiting the shop (`order.not_received`); the sub-order is `disputed`, its hold frozen; 409 `ORDER_STATE` |
| 4.3 | **The shop answers**, **The desk claims it** | Under review; previews: half refunds ৳1,340 with a ৳67 fee; "nothing back" charges the fee on the ৳2,600 items, never on delivery |
| 4.4 | **Decide half**, **ledger** | Resolved; ৳1,340 back, ৳1,340 released; A's payable ৳6,293; fee ৳327 |
| 4.5 | A withdrawn case 🤖 | The hold thaws and the sub-order is shipped again |

## 5. Staff, deadlines and cancellations
| # | Do | Expect |
|---|---|---|
| 5.1 | **Staff: find it by sub-order code**, **the order with its escrow hold** | Found; the hold holds ৳2,680; no phone or address |
| 5.2 | **A master cancels it for the platform** | Step-up `escrow.manage`; cancelled, ৳2,680 refunded, stock back |
| 5.3 | **the accept deadline passes**, **Expired and refunded** | The tick expires it; ৳2,680 refunded |
| 5.4 | **The buyer cancels before B accepts** | Cancelled, ৳1,280 refunded |
| 5.5 | Shipping late 🤖 | The buyer may cancel from ship-by + `market.ship_overdue_buyer_cancel_hours` (409 `CANCEL_NOT_YET` before); the tick cancels at ship-by + `market.ship_overdue_auto_cancel_hours` |
| 5.6 | **My orders**, **ledger still balanced** | Five orders; invariants hold |
