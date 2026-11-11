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

---

# M27 round 2 · Members and engagement: Acceptance Checklist

Request names refer to the **"Kriraghor API: M27 round 2 · Members and engagement"** collection
(`postman/kriraghor-gym-ops-r2.postman_collection.json`, rebuilt with `node postman/build-collection-m27-r2.js`).

Round 2 brings members back: check-out and the live count, classes with bookings and a waitlist, reward points, notices to a group of members (in-app, push and email; never SMS), enquiries from the gym page, and the exercise library. 🤖 marks cases only the jest suites cover (`tests/e2e/gym-ops-round2.test.js`, `tests/unit/gym-ops-rules.test.js`).

## 0. Setup
- [ ] `npm run release` applies `20261120000001-gym-ops-round2`: `gym_attendance_exits` (append-only, one per visit), `gym_classes`, `gym_class_schedules`, `gym_class_sessions` (one per slot and date), `gym_class_bookings` (one live booking per member and session), `gym_rewards`, `gym_point_entries` (append-only), `gym_member_referrals`, `gym_notices` (append-only), `gym_leads` (phone encrypted, last 4 and a hash kept) and the `exercises` catalogue. It merges `classes`, `points`, `notices` (standard) and `leads` (basic) into `gym_saas.feature_min_tiers`.
- [ ] The seed adds settings v36 (391 settings: `gym_manage.min_visit_minutes` 20, `gym_manage.visit_auto_close_hours` 4, the `gym_ops.class_*`, `points_*`, `notice_*`, `lead_*` keys), templates v28 (GYM_CLASS_CANCELLED, GYM_CLASS_REMINDER, GYM_CLASS_PROMOTED, GYM_NOTICE, GYM_LEAD_NEW) and the 64 library exercises in English and Bangla.
- [ ] Jobs: `gym-manage.visits-close` (every 30 min), `gym-ops.class-reminders` (every 15 min), `gym-ops.classes-points-daily` (03:20 Dhaka: sessions ahead, points expiry).
- [ ] `node postman/run-m27-r2.js` → **0 failed** (64 requests, 95 assertions). The runner resets the test database, publishes a Standard gym, links two members with a month each (Lima, Rafi), adds a member who has not paid (Friend Faruk), hires a trainer (classes.manage, members.view), a cashier (members.view, rewards.redeem) and a desk hand (attendance.mark, members.view), and serves `{{controlUrl}}` (`/drain`, `/visits-close`, `/soon`, `/reminders`).

## 1. Permissions
| # | Do | Expect |
|---|---|---|
| 1.1 | **Staff without notices.send** / **without leads.manage** | 403 `PERMISSION_REQUIRED` |
| 1.2 | **Only the owner keeps the rewards list** | 403 for staff |
| 1.3 | **A member is not staff** | 404 |
| 1.4 | Classes on a Basic plan | 403 `GYM_TIER_REQUIRED` `{feature: classes, minTier: standard}` 🤖 |

## 2. Check-out and the live count (M27-FR-40 to FR-45)
| # | Do | Expect |
|---|---|---|
| 2.1 | **The desk checks Lima in** / **One in the gym now** | 201; `inGymNow` 1 |
| 2.2 | **The desk checks Lima out** / **Out twice** | 200 `method: desk` with the visit length; then 409 `GYM_VISIT_CLOSED` |
| 2.3 | **Rafi scans in** / **A second scan at once** | 201; 200 repeat, not a check-out (under `gym_manage.min_visit_minutes`) |
| 2.4 | A second scan after the minimum visit | 200 `checkedOut: true` with the length 🤖 |
| 2.5 | A visit left open past `visit_auto_close_hours` | the job closes it `method: auto`, no length; a second run closes nothing 🤖 |
| 2.6 | Each check-in and check-out | `gym.desk_feed` over Socket.IO to the owner and staff with attendance.mark, nobody else 🤖 |

## 3. Classes (M27-FR-46 to FR-55)
| # | Do | Expect |
|---|---|---|
| 3.1 | **Morning HIIT** with a trainer from the staff; a trainer who is not staff | 201 with the slot; 422 `GYM_CLASS_TRAINER` 🤖 |
| 3.2 | **Sessions made ahead** | at least 3 weeks; 06:30 Dhaka is 00:30 UTC |
| 3.3 | **Lima books**, **twice**, **Rafi: full** | booked; 409 `GYM_CLASS_BOOKED`; waitlisted |
| 3.4 | Booking without a running membership; as someone else | 409 `GYM_MEMBERSHIP_NEEDED` 🤖; 404 |
| 3.5 | **Lima cancels** → **Rafi is promoted** | Rafi booked, `promoted: true`, told by GYM_CLASS_PROMOTED |
| 3.6 | **The trainer books Lima again** | waitlisted (the desk books for anyone until the start) |
| 3.7 | **The reminder job** twice | sent once only 🤖 (counts) |
| 3.8 | **Inside the cutoff a member cannot cancel** | 409 `GYM_CLASS_CANCEL_CLOSED` |
| 3.9 | After the start: the desk books; **the trainer marks who came** | 409 `GYM_CLASS_STARTED` 🤖; 200 `done`, Rafi `attended` |
| 3.10 | **The owner cancels a later session** | `cancelled`; everyone booked gets GYM_CLASS_CANCELLED with the reason |
| 3.11 | **The gym page timetable** | published gyms only; Yoga with 20 places; no member names |
| 3.12 | **Retire Morning HIIT** | no scheduled sessions left 🤖 |

## 4. Reward points (M27-FR-56 to FR-61)
| # | Do | Expect |
|---|---|---|
| 4.1 | **Lima has points for her check-in** | 10 (`gym_ops.points_per_checkin`); a 7-day streak adds 50 🤖 |
| 4.2 | **The rewards list** | two rewards (extra days, money off a due) |
| 4.3 | **The cashier redeems 3 extra days** / **again** | balance 0, the membership ends 3 days later; then 409 `GYM_POINTS_SHORT` |
| 4.4 | Money off with nothing owed | 409 `GYM_REWARD_NOTHING`; with a due, the due is waived by the amount 🤖 |
| 4.5 | **The owner adds 50 with a note** | 200; audited |
| 4.6 | **Lima brought a friend**, **a second referrer**, **the friend pays** | 200; 409 `GYM_REFERRAL_EXISTS`; Lima +200 after the payment |
| 4.7 | **Lima sees her points** / **not someone else's** | 250 and how to earn; 404 |
| 4.8 | Expiry after `points_expire_days` | first in, first out; points already spent do not expire twice 🤖 |

## 5. Notices (M27-FR-62 to FR-65)
| # | Do | Expect |
|---|---|---|
| 5.1 | **Who a notice to all active reaches** | by the app, by email, not reachable; cap 3 |
| 5.2 | **Expired 0 days ago** | 422 `GYM_NOTICE_SEGMENT` |
| 5.3 | **Send** | 201; in_app and push to linked members, email to others who have one; never SMS |
| 5.4 | **A fourth today** | 429 `GYM_NOTICE_CAP` |
| 5.5 | **Lima has the notice in the app** | GYM_NOTICE titled "Closed on Friday" |

## 6. Enquiries and the exercise library (M27-FR-66 to FR-71)
| # | Do | Expect |
|---|---|---|
| 6.1 | An enquiry to an unpublished gym | 404 🤖 |
| 6.2 | **A robot fills the hidden field** | 202, nothing stored |
| 6.3 | **Nadia asks** | 202; the phone stored encrypted; the owner and leads.manage staff are told (GYM_LEAD_NEW) |
| 6.4 | The same phone past `lead_per_phone_day` | 429 `RATE_LIMITED` 🤖 |
| 6.5 | **One new enquiry, the phone masked** / **Reveal the number** | last 4 only; the reveal is E.164, `no-store`, audited |
| 6.6 | **Contacted**, **joined without a member**, **joined as the friend**, **lost after joined** | 200; 422 `GYM_MEMBER_UNKNOWN`; 200; 409 `GYM_LEAD_STATE` |
| 6.7 | **The exercise library** | 64 exercises, English and Bangla names and steps |

## 7. Gym app
- [ ] The sidebar has **Engage** (Classes, Rewards, Notices, Enquiries), each shown by permission; a page above the plan shows the upsell.
- [ ] **Front desk:** "In the gym now" count, the live strip of check-ins and check-outs, **Check out** on each open visit, the out time and the visit length.
- [ ] **Entrance scan (member):** a second scan after the minimum visit says goodbye with the check-out time.
- [ ] **Classes:** add a class (trainer, places, length, room, weekly times); the week view by day; a session opens to book a member, cancel a booking, mark who came, cancel the session with a reason.
- [ ] **Rewards:** find a member, see points and history, redeem, adjust with a note, record who referred them; the owner edits the rewards list.
- [ ] **Notices:** pick a group, see the reach before sending, the daily cap, the sent list.
- [ ] **Enquiries:** new, contacted, joined, lost; Call and WhatsApp (the number from the audited reveal; prefilled message); mark joined with the member.
- [ ] **Plans:** "Pick from the exercise library" fills the name in both languages; the member sees "How to do it" with the steps.
- [ ] **Gym page:** the class timetable and the "Ask the gym" form; the thank-you after sending.
- [ ] **Me → Classes:** book, join the waitlist, cancel; **My membership:** my points and the rewards.
- [ ] Bangla, phone width, light and dark: no text left in English, no sideways scroll, readable contrast.

---

# M27 round 3a · Staff and equipment: Acceptance Checklist

Request names refer to the **"Kriraghor API: M27 round 3 · Staff and equipment"** collection
(`postman/kriraghor-gym-ops-r3.postman_collection.json`, rebuilt with `node postman/build-collection-m27-r3.js`).

Round 3a gives the gym its staff and machines: weekly shifts and clocking in by the entrance QR, the day's board and the month's hours, pay terms and the monthly payroll with payslips (Pro, the owner only), and the equipment register with service reminders. Payroll is the gym's own record: paid lines become salary expenses; Kriraghor never pays staff. 🤖 marks cases only the jest suites cover (`tests/e2e/gym-ops-round3.test.js`, `tests/unit/gym-ops-rules.test.js`).

## 0. Setup
- [ ] `npm run release` applies `20261121000001-gym-ops-round3`: `gym_staff_shifts`, `gym_staff_times` (append-only), `gym_staff_pay`, `gym_payroll_runs` (one live run per month), `gym_payroll_lines` (CHECK net = base + commissions + bonus − deduction), `gym_assets`, `gym_asset_logs` (append-only). It merges `staff_attendance`, `equipment` (standard) and `payroll` (pro) into `gym_saas.feature_min_tiers`.
- [ ] The seed adds settings v37 (400 settings: the `gym_ops.staff_*`, `shifts_per_staff_max`, `salary_max_poisha`, `commission_bps_max`, `payroll_adjust_max_poisha`, `assets_max`, `asset_*` keys) and templates v29 (GYM_ASSET_SERVICE_DUE, GYM_PAYSLIP_READY).
- [ ] New staff permissions: `clock.in` (on by default), `shifts.manage`, `assets.manage`. Every role preset in the business panel includes `clock.in`.
- [ ] Jobs: `gym-ops.staff-clockout` (hourly); the service reminders run in `gym-ops.daily`.
- [ ] `node postman/run-m27-r3.js` → **0 failed** (54 requests, 76 assertions). The runner resets the test database, makes a Pro gym, a member assigned to the trainer with a month's due, and four staff: Rumi (attendance.mark, members.view, clock.in), Tania (members.view, members.trainer, pos.sell, clock.in), a technician (assets.manage) and Other (members.view). It serves `{{controlUrl}}` (`/backdate`, `/clockout`, `/service`, `/drain`).

## 1. Shifts (M27-FR-72)
| # | Do | Expect |
|---|---|---|
| 1.1 | **An overnight shift** | 422 `GYM_SHIFT_TIMES` |
| 1.2 | **Rumi works 06:00 to 14:00 every day** / **Everyone's shifts** | seven shifts |
| 1.3 | **Staff without shifts.manage** | 403 `PERMISSION_REQUIRED` |

## 2. Clocking in and out (M27-FR-73 to FR-75)
| # | Do | Expect |
|---|---|---|
| 2.1 | **Rumi scans in** / **My clock** | in by the entrance QR; today's shift shown |
| 2.2 | **Rumi scans out** (after two hours) | out, 120 minutes |
| 2.3 | **The owner is not staff** / **Staff without clock.in** / **Not the entrance code** | 403 `GYM_NOT_STAFF`; 403 `PERMISSION_REQUIRED`; 422 `GYM_CLOCK_TOKEN_INVALID` |
| 2.4 | **The owner clocks Rumi in at the desk** / **again** | 201 at the desk; 409 `GYM_STAFF_ALREADY_IN` |
| 2.5 | **The board** | one in, 120 minutes worked today |
| 2.6 | **The auto-close job** after 15 hours, then **the month** | closed with method auto; still 120 minutes (auto time counts nothing) |
| 2.7 | Late and missed against the shifts | after the grace minutes = late; a past shift day with no clock-in = missed; today = neither 🤖 |
| 2.8 | Staff attendance on Basic | 403 `GYM_TIER_REQUIRED` `{feature: staff_attendance, minTier: standard}` 🤖 |

## 3. Pay terms (M27-FR-76)
| # | Do | Expect |
|---|---|---|
| 3.1 | **A commission above the cap** | 422 `GYM_COMMISSION_OUT_OF_RANGE` |
| 3.2 | **Tania: ৳15,000, 10% of her members' fees, 5% of her sales** / **Other: ৳10,000** | 200 |
| 3.3 | **Staff cannot see pay** | 403 |
| 3.4 | **Tania's member pays ৳2,000**, a product, **Tania sells one for ৳900** | the month's facts |

## 4. The month's payroll (M27-FR-77 to FR-81)
| # | Do | Expect |
|---|---|---|
| 4.1 | **A future month** / **Draft this month** / **the same month again** | 422 `GYM_PAYROLL_PERIOD`; a draft with two lines, Tania ৳15,245; 409 `GYM_PAYROLL_EXISTS` |
| 4.2 | **A deduction larger than the pay** / **Bonus ৳500, deduction ৳200** | 422 `GYM_PAYROLL_NEGATIVE`; net ৳15,545 |
| 4.3 | **Recalculate** | the bonus and deduction stay |
| 4.4 | **A draft payslip** (staff) / **Approve** / **Change after approval** | 404; approved; 409 `GYM_PAYROLL_STATE` |
| 4.5 | **Pay Tania by bank**, **again**, **Pay Other in cash** | paid ৳15,545; 409 `GYM_PAYROLL_LINE_STATE`; the month is paid |
| 4.6 | **Salaries are in the expenses** | two salary expenses, ৳25,545, in profit and loss |
| 4.7 | **Void a paid month** | 409 `GYM_PAYROLL_STATE`; a draft voids and the month can be drafted again 🤖 |
| 4.8 | **Tania's payslips** / **Her payslip** / **Not someone else's** | one, paid; with the note; 404 |
| 4.9 | Payroll on Standard; nobody with pay terms | 403 `GYM_TIER_REQUIRED` `{feature: payroll, minTier: pro}`; 422 `GYM_PAYROLL_EMPTY` 🤖 |

## 5. Equipment (M27-FR-82 to FR-86)
| # | Do | Expect |
|---|---|---|
| 5.1 | **Staff without assets.manage** | 403 |
| 5.2 | **A treadmill, serviced every 30 days, bought 29 days ago** | working, next service tomorrow |
| 5.3 | **The service reminder job** | once per due date to the owner and assets.manage staff (GYM_ASSET_SERVICE_DUE); a second run sends nothing 🤖 |
| 5.4 | **A service with its cost as a cash expense** | last service today, next in 30 days, the expense linked |
| 5.5 | **Out of order**, **The counts**, **Retire it**, **Log on a retired machine** | logged; 1 out of order; retired; 409 `GYM_ASSET_STATE` |
| 5.6 | **The history** | status, status, service |

## 6. Gym app
- [ ] The sidebar has **Team** (Staff attendance, Payroll for the owner, Equipment) by permission; staff with clock.in get **My work** under Today; a page above the plan shows the upsell.
- [ ] **Staff attendance:** Today (who is in, shifts, times, late; Clock in or out for shifts.manage), Shifts (edit a person's week), Month (hours, days, late, missed; month by month).
- [ ] **My work (staff):** Scan to clock in, then out; today's shifts and times; this month's hours; my payslips (print).
- [ ] **Payroll:** Pay terms (base, trainer %, sales %); Months: draft, edit bonus and deduction with a note, recalculate, approve, pay each line (method, from the drawer), void; payslip print on A4.
- [ ] **Equipment:** counts (working, needs service, out of order, service due); add or edit a machine; open it for its history; log a service, repair or note with a cost into the expenses; retire.
- [ ] **Business panel → Team:** the labels for clock.in, shifts.manage and assets.manage (and the round 2 permissions); presets include clocking in.
- [ ] Bangla, phone width, light and dark: no text left in English, no sideways scroll, readable contrast.

# M27 · The conversion report: Acceptance Checklist

Product owner, 11 Nov 2026; M27-FR-87 to FR-91 ([M27 §16](../../kriraghor-docs/modules/M27-gym-operations.md)). Folder 5 of `kriraghor-gym-special-days.postman_collection.json`.

## 0. Setup
- [ ] `npx jest --runInBand --coverage=false --runTestsByPath tests/unit/gym-special-days-rules.test.js tests/e2e/gym-conversion.test.js` passes.
- [ ] `node postman/run-m20-special-days.js` → **0 failed** (46 requests, 80 assertions).

## 1. Where members come from
| # | Do | Expect |
|---|---|---|
| 1.1 | **An enquiry from the gym page**, **A second enquiry**, Runner: date the visits today | 202 twice |
| 1.2 | **This month's report** | Two enquiries, both new; two visits (one cancelled, one to come); no join requests and no share for them; one new member added at the desk; no name or phone anywhere |
| 1.3 | **A month with nothing**, **A month ahead**, **A malformed month** | January 2020 all zero; this month; 422 |
| 1.4 | **Staff with reports.view read it**, **Desk staff do not** | 200; 403 `PERMISSION_REQUIRED` |
| 1.5 | **The CSV is the owner's**, **The owner's CSV** | 403; `conversion-YYYY-MM.csv` with Group, Stage, Count |
| 1.6 | Plan 🤖 | Below the reports feature: 403 `GYM_TIER_REQUIRED`; without enquiries or visits on the plan, that group is left out |

## 2. Gym app
- [ ] **Reports**: "Where members come from" with three bar lists and the share under each, the month's new members by source, **Download CSV** for the owner only. It follows the page's month.
- [ ] Bangla, phone width, light and dark.
