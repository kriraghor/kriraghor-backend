# M27 round 1 · Front desk and money: Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: M27 round 1 · Front desk and money"** collection
(`postman/kriraghor-gym-ops.postman_collection.json`, rebuilt with `node postman/build-collection-m27.js`).

Round 1 gives a gym its own books at the counter: expenses by category, the day's cash drawer, a counter shop with stock and receipts, lockers, profit and loss, VAT on receipts (off by default), health fields with BMI, and dashboard extras. All of it is bookkeeping (like counter fees, M24-FR-34): no money moves and nothing touches the ledger. 🤖 marks cases only the jest suites cover (`tests/e2e/gym-ops.test.js`, `tests/unit/gym-ops-rules.test.js`).

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies `20261119000001-gym-ops-round1`: health columns on `gym_members` (blood group, height, weight, encrypted conditions), VAT on `gym_manage_settings` and `gym_fee_payments`, and the nine M27 tables (`gym_expense_categories`, `gym_expenses`, `gym_cash_sessions`, `gym_products`, `gym_stock_moves` append-only, `gym_sales`, `gym_sale_lines` append-only, `gym_lockers`, `gym_locker_rentals`). It merges `expenses`, `lockers` (basic) and `pos`, `pnl` (standard) into `gym_saas.feature_min_tiers` without overwriting owner changes, and relabels `gym_manage.remind_before_days` "No longer used".
- [ ] The seed adds settings v35 (372 settings: the `gym_ops.*` keys, `gym_manage.renewal_remind_days` [7, 3, 1], `gym_manage.expiring_list_days`, `gym_manage.vat_max_bps` four-eyes) and templates v27 (GYM_STOCK_LOW, GYM_PRODUCT_EXPIRING, GYM_CASH_DIFFERENCE, GYM_LOCKER_ENDING).
- [ ] `npm test`: everything green, including 100% branch coverage of `gym-ops.rules.js`, and the module boundaries (`gym-ops` sits in the gym group and calls gym-manage only through `gym-manage/index.js` → `ops`).
- [ ] `node postman/run-m27.js` → **0 failed** (48 requests, 75 assertions). The runner resets the test database, makes a Standard gym (short code IY) with a member who paid ৳1,000 cash and is linked, a cashier (members.view, cash.drawer, pos.sell), a store keeper (stock.manage) and a desk hand (members.view), and serves `{{controlUrl}}` (`/drain`, `/lockers`).

## 1. Plan and permissions (M27-FR-34)
| # | Do | Expect |
|---|---|---|
| 1.1 | **Staff without expenses.manage** | 403 `PERMISSION_REQUIRED` |
| 1.2 | **Staff without reports.view: no profit and loss** | 403 `PERMISSION_REQUIRED` |
| 1.3 | **A member is not staff** | 404 (no hint the gym exists) |
| 1.4 | A Free plan opens expenses | 403 `GYM_TIER_REQUIRED` `{feature: expenses, minTier: basic}`; the shop on Basic → `minTier: standard` 🤖 |

## 2. Expenses (M27-FR-01 to FR-05)
| # | Do | Expect |
|---|---|---|
| 2.1 | **The categories, made on first use** | nine: rent, electricity, salaries, equipment repair, internet, cleaning, marketing, stock purchases, other |
| 2.2 | **A date in the future** | 422 |
| 2.3 | **Rent ৳25,000 by bank** / **Internet ৳1,500 by bKash** | 201 `recorded`; not from the drawer |
| 2.4 | **The list and its total** | two rows, ৳26,500 |
| 2.5 | **Void the rent with a reason** / **again** | 200 `void` with the reason, still listed; then 409 `GYM_EXPENSE_STATE` |
| 2.6 | An amount over `gym_ops.expense_max_poisha`; from the drawer by bank | 422 `GYM_AMOUNT_OUT_OF_RANGE`; 422 🤖 |

## 3. The cash drawer (M27-FR-06 to FR-09)
| # | Do | Expect |
|---|---|---|
| 3.1 | **The cashier opens the day with ৳500** / **twice** | 201 `open`; 409 `GYM_DRAWER_OPEN` |
| 3.2 | **The drawer: float + cash fee + locker fee** | expected ৳1,800 (500 + 1,000 + 300; the cash sale was reversed) |
| 3.3 | **Close with ৳1,790 counted** | `closed`, difference −৳10; the owner gets GYM_CASH_DIFFERENCE |
| 3.4 | **A cash sale after closing** | 409 `GYM_DRAWER_CLOSED`; card and bKash still work |

## 4. The counter shop (M27-FR-10 to FR-21)
| # | Do | Expect |
|---|---|---|
| 4.1 | **A product: whey 1 kg, reorder at 2** / **the same barcode again** | 201; 409 `GYM_PRODUCT_BARCODE_TAKEN` |
| 4.2 | **Stock in: 4 with batch and expiry** | stock 4 |
| 4.3 | **The cashier finds it by barcode, without the cost** | no `costPoisha` for pos.sell |
| 4.4 | **Too many** | 409 `GYM_STOCK_SHORT` |
| 4.5 | **Sell 2 for cash, to the member** | ৳9,000; receipt `IY-R26-…` from the gym's one receipt series; no VAT; the member on it |
| 4.6 | **The receipt** | same number, the gym header, the lines |
| 4.7 | **A reversal without fees.adjust** / **the owner reverses it** | 403; 200 `reversed`, stock back to 4 |
| 4.8 | **Sell 3 by card** → **Low stock is flagged** | stock 1, `low`; one GYM_STOCK_LOW, not one per sale 🤖 |
| 4.9 | Stock past its date | 422 `GYM_PRODUCT_EXPIRED`; a write-off with a note takes it out 🤖 |

## 5. Lockers (M27-FR-22 to FR-26)
| # | Do | Expect |
|---|---|---|
| 5.1 | **Add lockers 1 to 3 at ৳300 a month** / **locker 2 again** | three free; 409 `GYM_LOCKER_NUMBER_TAKEN` |
| 5.2 | **Rent locker 1 to the member, fee taken in cash** / **again** | 201 paid, active, ৳300 (30 days); 409 `GYM_LOCKER_UNAVAILABLE` |
| 5.3 | **Locker 2 out of service** → **the grid** | 1 taken, 1 out of service, 1 free |
| 5.4 | **The daily lockers job** | runs (a reminder 3 days before the end, once; a rental past its end is ended 🤖) |
| 5.5 | **End the rental early** → **the member's rentals** | `ended`; listed |
| 5.6 | An unpaid rental: collect later / twice | a locker sale; 409 `GYM_LOCKER_FEE_PAID` 🤖 |

## 6. Profit and loss, VAT (M27-FR-27, FR-28)
| # | Do | Expect |
|---|---|---|
| 6.1 | **This month** | fees ৳1,000, sales ৳13,500, lockers ৳300, goods ৳9,900, expenses ৳1,500 → net ৳3,400; the previous month beside it (the whole calendar month before) |
| 6.2 | **VAT above the cap** / **VAT 15% on** | 422; on, 1,500 bps, cap 1,500 |
| 6.3 | **A card sale shows the VAT inside** | ৳4,500 incl. ৳586.96 VAT (58,696 poisha), net ৳3,913.04 |
| 6.4 | **VAT off again** | off; past receipts keep the rate they used 🤖 |

## 7. Health, dashboard, absent (M27-FR-29 to FR-33)
| # | Do | Expect |
|---|---|---|
| 7.1 | **The member sets height and weight** | BMI 22.9, healthy |
| 7.2 | **The owner sees the body fields** / **staff with members.view only** | blood group and BMI; none of them |
| 7.3 | Staff with members.edit change the weight / the blood group | 403 `PERMISSION_REQUIRED`; 200 🤖 |
| 7.4 | **The dashboard** | `expiring` (soonest first, at most 50) and `mix` by status |
| 7.5 | **Absent for 7 days** / **0 days** | 200; 422 |
| 7.6 | Renewal reminders | 7, 3 and 1 days before the end, each once (`d-N`) 🤖 |

## 8. Gym app (gym.kriraghor.com/manage/[gymId])
- [ ] The sidebar has **Counter** (Sell, Stock, Lockers) and, under **Money**, Cash drawer, Expenses and Profit and loss, each shown by permission; a page above the plan shows the upsell.
- [ ] **Sell:** a USB scanner (types the barcode, then Enter) adds the product; cash shows the change; the receipt prints on an 80 mm roll or A4; "Today's sales" lists the day; a reversal needs fees.adjust.
- [ ] **Stock:** add a product (supplement fields: batch, best before, importer or BSTI), stock in, correct or write off with a note; low and expiring are flagged; the margin shows for stock keepers and the owner.
- [ ] **Lockers:** add "1-40, A1-A10"; the grid colours (free, taken, unpaid, past end, out of service); rent to a member with the fee now or later; take the fee; end with a reason.
- [ ] **Cash drawer:** open with a float; the sheet adds cash fees, sales and locker fees and takes away cash paid out; close with the count and a note when it does not match; earlier days read-only; print.
- [ ] **Expenses:** month by month, by category; void with a reason; the owner renames, adds and retires categories.
- [ ] **Profit and loss:** this month and last month side by side, print on A4.
- [ ] **Dashboard:** "Ending soon" with Call and WhatsApp (members.edit; the number comes from the audited reveal), the membership mix.
- [ ] **Settings:** VAT on receipts (off by default; asks for the BIN); **Remove this gym** (M20-FR-15).
- [ ] **Member profile:** blood group (members.edit), height, weight, BMI and conditions (owner, plans.manage). **My membership:** "My body" with the BMI.
- [ ] **Reports:** the absent list for the gym's days, 7, 14, 30 or any number of days.
- [ ] **Business panel → Team:** for a gym, "Start from a role" presets (Receptionist, Cashier, Trainer, Manager, Accountant, Store keeper) tick the boxes; the boxes stay editable.
- [ ] Bangla, phone width, light and dark: no text left in English, no sideways scroll, readable contrast.
