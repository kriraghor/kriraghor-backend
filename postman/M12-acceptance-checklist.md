# M12 Market Catalogue (step 1): Acceptance Checklist

Tick each box when the result matches. Request names refer to the **"Kriraghor API: M12 Market catalogue (step 1)"** collection
(`postman/kriraghor-market.postman_collection.json`, rebuilt with `node postman/build-collection-m12.js`).

Step 1 covers verified shops (sports gear, supplement houses, gym gear), products of the M03 item catalogue with variants and photos, the stock ledger and the `InventoryService` M13 will call, supplements blocked near expiry, browse, the product and shop pages and saved items. Used listings, offers and checkout come with M13.

## 0. Setup
- [ ] `docker compose up -d`, then `npm run release`. This applies four migrations:
  - `20261029000001-create-item-catalog` (M03): `item_categories`, `item_types`, `item_type_fields`;
  - `20261029000002-business-documents-per-role` (M02): business documents keyed by role, new type `bin`;
  - `20261029000003-market-kinds` (M05 kinds `shop` and `product`; M17 report subjects `shop` and `product`);
  - `20261029000004-create-market`: `shops`, `products`, `product_variants` (generated `available`), `product_photos`, `inventory_movements` (append-only), `saved_items`.

  The seed adds the item catalogue (`items.v1.json`: 6 categories, 12 item types, 33 fields), the shop owner document requirements, the shop and product rubrics and reasons, settings v14 (227) and templates v11 (`SHOP_*`, `PRODUCT_*`, `STOCK_LOW`, `STOCK_OUT`, `SUPPLEMENT_EXPIRING`, `SAVED_*`).
- [ ] `npm test`: everything green, including the coverage gates (100% on `market.rules.js`). 🤖 marks cases only the tests cover.
- [ ] `node postman/run-m12.js` → **0 failed**. The runner resets `kriraghor_test`, signs in masters A and B (B reviews), a shop owner (an active member who applied for shop_owner) and a buyer, and serves `{{controlUrl}}`: `/refresh` (a fresh owner token after the role change) and `/settle` (deliver events).
- [ ] `run-m02.js` to `run-m10.js`, `run-m17.js`, `run-m18.js`, `run-m19.js` and `run-m21.js` still pass. M03 now counts 227 settings.

## 1. Shop owner documents, per role (M02)
| # | Do | Expect |
|---|---|---|
| 1.1 | **The shop desk needs an active role**, **Shop owner checklist** | 403 before the role; the checklist lists the trade licence, the TIN and an optional BIN |
| 1.2 | **Send the trade licence**, **Send the TIN**, master B approves both | Both in review, then approved; the runner refresh shows `shop_owner` active |
| 1.3 | A member with both business roles 🤖 | A trade licence approved for ground_owner does not count for shop_owner; with two applied roles the request needs `role` (`ROLE_AMBIGUOUS`) |

## 2. The shop (FR-01, M05 kind shop)
| # | Do | Expect |
|---|---|---|
| 2.1 | **No shop yet**, **Open a sports gear shop**, **One shop per owner** | 404; a draft with the stock rules from settings (low 3, made-to-order 5 days); 409 `SHOP_EXISTS` |
| 2.2 | **Send the shop for review**, master B approves | Live, version 1; the owner gets `SHOP_LIVE` |
| 2.3 | Edits 🤖 | A new name or address is an edit for review (the public keeps the old one); the about text applies at once; the shop type is fixed once approved |
| 2.4 | Sanctions 🤖 | A suspended shop_owner role or account pauses the shop; its products leave Market |

## 3. A product with sizes (FR-02 to FR-05)
| # | Do | Expect |
|---|---|---|
| 3.1 | **The item catalogue** | Six categories; football boots have the EU size as a variant axis and a price range |
| 3.2 | **Specs must match**, **The price must fit** | 422 `SPECS_INVALID`; 422 `PRICE_OUT_OF_RANGE` |
| 3.3 | **Draft turf boots in EU 42, 43 and 44** | Three variants with their opening stock (a `receive` movement each) |
| 3.4 | **Send it without photos**, three photos, a GIF | 422 `PRODUCT_INCOMPLETE` (photos); three photos in the public bucket; 415 for the GIF |
| 3.5 | **Send it for review**, **Not on Market yet**, master B approves | In review and not listed; then live: **On Market** shows from ৳6,500 with prices that vary, the football facet counts 1, and **Search** finds it |
| 3.6 | Wrong shop type 🤖 | A sports gear shop cannot list protein powder (`CATEGORY_NOT_FOR_SHOP`) |

## 4. Stock, the product page and edits (FR-02, FR-10 to FR-15)
| # | Do | Expect |
|---|---|---|
| 4.1 | **Count EU 44 down to 0**, **A reason "other" needs text**, **Receive 10 of EU 43** | 0 available; 422; 15 on hand |
| 4.2 | **Product page** | EU 44 not purchasable, EU 42 low with 2 left, specs labelled ("Turf (TF)"), checkout says it opens with M13 |
| 4.3 | **Variant history**, **Inventory desk** | Movements newest first with their reasons; stock value 17 × ৳6,500, one out of stock, one low |
| 4.4 | **A 7.7% price cut**, **A further 33% cut**, **The public price stays** | Live at once; an edit for review with the public price kept at ৳6,000 |
| 4.5 | **Back to ৳6,000**, **Nothing to review** | 409 `NOTHING_TO_REVIEW` |
| 4.6 | InventoryService for M13 🤖 | Two holds on the last unit: one wins (`INSUFFICIENT_STOCK`); replays of hold, commit and restock change nothing; the product hides and shows again; `BELOW_HELD`; low stock fires once; made-to-order moves no stock; the reconcile job audits a tampered count as critical |
| 4.7 | Supplements 🤖 | A variant needs expiry and batch; with less than 30 days left it is blocked from sale (daily job) and the shop gets `SUPPLEMENT_EXPIRING`; the product needs the importer or a BSTI number |

## 5. Saved items and staff (FR-33, FR-34)
| # | Do | Expect |
|---|---|---|
| 5.1 | **My own item**, **Save the boots**, **My saved items** | 409 `OWN_ITEM`; saved; one item with its card |
| 5.2 | Price drop 🤖 | Savers who saved at a higher price get `SAVED_PRICE_DROP` (once per cooldown) and a "price dropped" badge |
| 5.3 | **Staff: shops**, **Staff: products**, **Suspend the product**, **The page is gone**, **Saved shows it unavailable**, **Restore it**, **Unsave** | Listed; suspended; 410 `PRODUCT_GONE`; "unavailable" badge; live again; unsaved (the row keeps `removed_at`) |
| 5.4 | Reports 🤖 | A report on a shop resolved as "content removed" suspends the shop; Market shows nothing from it |
