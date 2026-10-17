'use strict';

/**
 * Builds postman/kriraghor-market.postman_collection.json (M12 Market catalogue step 1, with the M02
 * shop-owner documents and the M03 item catalogue it needs). node postman/build-collection-m12.js
 *
 * Variables: adminAccessToken / adminAccessToken2 (masters A and B; B reviews), accessToken (the shop
 * owner: an active member who applied for shop_owner), memberToken (a buyer), controlUrl (the runner:
 * /refresh hands back a fresh owner token after the role changes, /settle drains events).
 * Unattended: `node postman/run-m12.js` (kriraghor_test database; fixtures in postman/fixtures).
 */
const fs = require('fs');
const path = require('path');
const { req } = require('./lib');

const out = path.join(__dirname, 'kriraghor-market.postman_collection.json');

const as = (token) => (name, method, p, opts = {}) => {
  const r = req(name, method, p, { ...opts, as: false });
  r.request.header.push({ key: 'Authorization', value: `Bearer {{${token}}}` });
  return r;
};
const owner = as('accessToken');
const member = as('memberToken');
const upload = (name, p, file, mime, opts) => {
  const r = owner(name, 'POST', p, opts);
  r.request.header.push({ key: 'Content-Type', value: mime });
  r.request.body = { mode: 'file', file: { src: file } };
  return r;
};
const idem = (item) => {
  item.request.header.push({ key: 'Idempotency-Key', value: 'pm-{{$guid}}' });
  return item;
};
const control = (name, step, opts = {}) => {
  const r = req(`Runner: ${name}`, 'POST', '/x', { as: false, expect: { status: 200 }, ...opts });
  r.request.url = { raw: `{{controlUrl}}/${step}`, host: ['{{controlUrl}}'], path: [step] };
  return r;
};
const setVar = (name, expr) => [`saves ${name}`, `(pm.collectionVariables.set('${name}', ${expr}), true)`];
const decide = (label, idVar, ticks, decision = 'approve') => [
  req(`${label}: claim`, 'POST', `/admin/submissions/{{${idVar}}}/claim`, { as: 'B', expect: { status: 200 }, checks: [['no failing check', "j.checks.every((c) => c.result !== 'fail')"]] }),
  req(`${label}: tick the rubric`, 'PUT', `/admin/submissions/{{${idVar}}}/ticks`, { as: 'B', body: { ticks }, expect: { status: 200 } }),
  idem(req(`${label}: ${decision}`, 'POST', `/admin/submissions/{{${idVar}}}/decide`, { as: 'B', body: { decision }, expect: { status: 200 } })),
];
const DOC_RUBRIC = ['name_matches', 'readable', 'not_edited', 'face_matches'];
const SHOP_RUBRIC = ['name_ok', 'type_ok', 'address_ok', 'about_ok'];
const PRODUCT_RUBRIC = ['photos_real', 'type_ok', 'price_ok', 'text_ok', 'supplement_ok'];

const collection = {
  info: {
    name: 'Kriraghor API: M12 Market catalogue (step 1)',
    description: [
      'A member who applied as a shop owner sends a trade licence and a TIN (M02 documents, kept per role); master B approves both and shop_owner becomes active. The owner opens a sports gear shop in Dhanmondi, which master B approves (M05 kind shop).',
      'The owner drafts Adidas turf boots of the M03 item type football_boots in three EU sizes with opening stock (specs checked against the item fields), adds three photos and sends it for review; master B approves (kind product). It shows on /market/items, and its page shows a sold-out size as not purchasable.',
      'A 7.7% price cut goes live at once; a further 33% cut waits for review while the public price stays. Stock moves with reasons on an append-only ledger; the inventory desk shows the KPIs. A buyer saves the boots; the owner cannot save their own. Staff list, suspend (410 on the page) and restore.',
      'Requests named "Runner" go to the local test runner (refresh the owner token, deliver events).',
      'Unattended: `node postman/run-m12.js` (kriraghor_test database).',
      'Rebuild this file with: node postman/build-collection-m12.js',
    ].join('\n\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: ['baseUrl', 'controlUrl', 'adminAccessToken', 'adminAccessToken2', 'accessToken', 'memberToken', 'areaId', 'fileId', 'tlSubmissionId', 'tinSubmissionId', 'shopId', 'shopSubmissionId', 'bootsTypeId', 'productId', 'slug', 'productSubmissionId', 'v42', 'v43', 'v44'].map((key) => ({ key, value: key === 'baseUrl' ? 'http://localhost:4000/api/v1' : '' })),
  item: [
    {
      name: '1. Shop owner documents, per role (M02)',
      item: [
        req('Dhanmondi (catalogue)', 'GET', '/catalog/areas?q=dhanmondi', { as: false, expect: { status: 200 }, save: { areaId: 'items.0.id' } }),
        owner('The shop desk needs an active role (expect 403)', 'GET', '/shop/profile', { expect: { status: 403 } }),
        owner('Shop owner checklist: trade licence, TIN, BIN (optional)', 'GET', '/me/verification?role=shop_owner', {
          expect: { status: 200 },
          checks: [['three items', "j.items.map((i) => i.key).join(',') === 'trade_license,tin,bin'"], ['BIN optional', "j.items.find((i) => i.key === 'bin').required === 'optional'"]],
        }),
        upload('Upload the trade licence (PDF)', '/me/documents/files?slot=document&docType=trade_license', 'nid-selfie.pdf', 'application/pdf', { expect: { status: 201 }, save: { fileId: 'fileId' } }),
        owner('Send the trade licence (the role is the only one applied)', 'POST', '/me/documents', {
          body: { docType: 'trade_license', fields: { number: 'TRAD/DNCC/771234', holderName: 'Nayeem Sports', expiresOn: '2029-06-30' }, files: { document: '{{fileId}}' }, consent: true },
          expect: { status: 201 },
          checks: [['in review', "j.status === 'in_review' && j.numberMasked.endsWith('1234')"]],
        }),
        upload('Upload the TIN certificate (PNG)', '/me/documents/files?slot=document&docType=tin', 'nid-back.png', 'image/png', { expect: { status: 201 }, save: { fileId: 'fileId' } }),
        owner('Send the TIN', 'POST', '/me/documents', { body: { docType: 'tin', fields: { number: '123456789012' }, files: { document: '{{fileId}}' }, consent: true }, expect: { status: 201 } }),
        req('Both are on the Moderation desk', 'GET', '/admin/submissions?status=pending_review&kind=document', {
          as: 'B',
          expect: { status: 200 },
          checks: [['two documents', 'j.items.length === 2'], setVar('tlSubmissionId', "j.items.find((s) => s.title.startsWith('Trade licence')).id"), setVar('tinSubmissionId', "j.items.find((s) => s.title.startsWith('TIN')).id")],
        }),
        ...decide('Trade licence', 'tlSubmissionId', DOC_RUBRIC),
        ...decide('TIN', 'tinSubmissionId', DOC_RUBRIC),
        control('drain events and refresh the owner token', 'refresh', { checks: [['fresh owner token', "(pm.environment.set('accessToken', j.accessToken), typeof j.accessToken === 'string')"]] }),
        owner('The shop_owner role is active', 'GET', '/me/verification?role=shop_owner', { expect: { status: 200 }, checks: [['active', "j.roleStatus === 'active'"]] }),
      ],
    },
    {
      name: '2. The shop and its review (FR-01)',
      item: [
        owner('No shop yet (expect 404)', 'GET', '/shop/profile', { expect: { status: 404 } }),
        owner('Open a sports gear shop', 'POST', '/shop/profile', {
          body: { shopType: 'sports_gear', name: 'Postman Sports House', areaId: '{{areaId}}', addressLine: '12 Elephant Road, Dhaka', about: 'Boots, balls and rackets' },
          expect: { status: 201 },
          save: { shopId: 'id' },
          checks: [['draft with stock rules', "j.status === 'draft' && j.stockRules.lowStockThreshold === 3 && j.stockRules.mtoDaysDefault === 5"]],
        }),
        owner('One shop per owner (expect 409)', 'POST', '/shop/profile', { body: { shopType: 'gym_gear', name: 'Second Shop', areaId: '{{areaId}}', addressLine: '1 Road, Dhaka' }, expect: { status: 409, code: 'SHOP_EXISTS' } }),
        owner('Send the shop for review', 'POST', '/shop/profile/submit', { expect: { status: 200 }, checks: [['pending review', "j.status === 'pending_review'"]] }),
        req('The shop on the desk', 'GET', '/admin/submissions?status=pending_review&kind=shop', { as: 'B', expect: { status: 200 }, checks: [setVar('shopSubmissionId', 'j.items[0].id')] }),
        ...decide('Shop', 'shopSubmissionId', SHOP_RUBRIC),
        control('deliver the decision', 'settle'),
        owner('The shop is live', 'GET', '/shop/profile', { expect: { status: 200 }, checks: [['live v1', "j.status === 'live' && j.liveVersion === 1"]] }),
      ],
    },
    {
      name: '3. A product with sizes and its review (FR-02 to FR-05)',
      item: [
        req('The item catalogue (M03)', 'GET', '/market/categories', {
          as: false,
          expect: { status: 200 },
          checks: [
            ['six categories', 'j.items.length === 6'],
            setVar('bootsTypeId', "j.items.find((c) => c.key === 'football').types.find((t) => t.key === 'football_boots').id"),
            ['EU size is a variant axis', "j.items.find((c) => c.key === 'football').types.find((t) => t.key === 'football_boots').fields.find((f) => f.key === 'eu_size').isVariantAxis === true"],
          ],
        }),
        owner('Specs must match the item type (expect 422)', 'POST', '/shop/products', {
          body: { itemTypeId: '{{bootsTypeId}}', title: 'Bad boots', specs: { stud_type: 'spikes' }, basePricePoisha: 650000 },
          expect: { status: 422, code: 'SPECS_INVALID' },
        }),
        owner('The price must fit the item type (expect 422)', 'POST', '/shop/products', {
          body: { itemTypeId: '{{bootsTypeId}}', title: 'Cheap boots', specs: { stud_type: 'tf' }, basePricePoisha: 5000 },
          expect: { status: 422, code: 'PRICE_OUT_OF_RANGE' },
        }),
        owner('Draft turf boots in EU 42, 43 and 44', 'POST', '/shop/products', {
          body: {
            itemTypeId: '{{bootsTypeId}}',
            title: 'Adidas Predator Turf Boots',
            brand: 'Adidas',
            description: 'Turf studs, synthetic upper.',
            specs: { stud_type: 'tf' },
            basePricePoisha: 650000,
            variants: [
              { attributes: { eu_size: '42' }, sku: 'PRED-TF-42', openingStock: 2 },
              { attributes: { eu_size: '43' }, sku: 'PRED-TF-43', openingStock: 5 },
              { attributes: { eu_size: '44' }, sku: 'PRED-TF-44', priceOverridePoisha: 680000, openingStock: 1 },
            ],
          },
          expect: { status: 201 },
          save: { productId: 'id', slug: 'slug' },
          checks: [
            ['three variants with stock', "j.variants.length === 3 && j.variants.map((v) => v.onHand).join(',') === '2,5,1'"],
            setVar('v42', "j.variants.find((v) => v.attributes.eu_size === '42').id"),
            setVar('v43', "j.variants.find((v) => v.attributes.eu_size === '43').id"),
            setVar('v44', "j.variants.find((v) => v.attributes.eu_size === '44').id"),
          ],
        }),
        owner('Send it without photos (expect 422)', 'POST', '/shop/products/{{productId}}/submit', { expect: { status: 422, code: 'PRODUCT_INCOMPLETE' }, checks: [['photos missing', "j.errors.some((e) => e.field === 'photos')"]] }),
        upload('Photo 1 (JPEG)', '/shop/products/{{productId}}/photos', 'nid-front.jpg', 'image/jpeg', { expect: { status: 201 }, checks: [['public URL', "j.url.includes('/market/products/') && j.url.endsWith('.jpg')"]] }),
        upload('Photo 2 (PNG)', '/shop/products/{{productId}}/photos', 'nid-back.png', 'image/png', { expect: { status: 201 } }),
        upload('Photo 3 (WebP)', '/shop/products/{{productId}}/photos', 'ground.webp', 'image/webp', { expect: { status: 201 } }),
        upload('A GIF is refused (expect 415)', '/shop/products/{{productId}}/photos', 'not-allowed.gif', 'image/gif', { expect: { status: 415, code: 'FILE_TYPE_NOT_ALLOWED' } }),
        owner('Send it for review', 'POST', '/shop/products/{{productId}}/submit', { expect: { status: 200 }, checks: [['pending review', "j.status === 'pending_review'"]] }),
        req('Not on Market yet', 'GET', '/market/items', { as: false, expect: { status: 200 }, checks: [['nothing', 'j.total === 0']] }),
        req('The product on the desk', 'GET', '/admin/submissions?status=pending_review&kind=product', { as: 'B', expect: { status: 200 }, checks: [setVar('productSubmissionId', 'j.items[0].id')] }),
        ...decide('Product', 'productSubmissionId', PRODUCT_RUBRIC),
        control('deliver the decision', 'settle'),
        req('On Market: from ৳6,500, prices vary', 'GET', '/market/items?category=football', {
          as: false,
          expect: { status: 200 },
          checks: [['one card', "j.total === 1 && j.items[0].priceFromPoisha === 650000 && j.items[0].priceToPoisha === 680000 && j.items[0].pricesVary === true"], ['football facet', "j.facets.categories.some((c) => c.key === 'football' && c.count === 1)"]],
        }),
        req('Search finds it', 'GET', '/market/items?q=predator', { as: false, expect: { status: 200 }, checks: [['found', 'j.total === 1']] }),
      ],
    },
    {
      name: '4. Stock, the product page and edits (FR-02, FR-10 to FR-15)',
      item: [
        owner('Count EU 44 down to 0 (count correction)', 'POST', '/shop/variants/{{v44}}/adjust', { body: { setTo: 0, reasonCode: 'count_correction' }, expect: { status: 200 }, checks: [['empty', 'j.onHand === 0 && j.available === 0']] }),
        owner('A reason "other" needs text (expect 422)', 'POST', '/shop/variants/{{v43}}/adjust', { body: { delta: -1, reasonCode: 'other' }, expect: { status: 422 } }),
        owner('Receive 10 of EU 43', 'POST', '/shop/variants/{{v43}}/adjust', { body: { delta: 10, reasonCode: 'received' }, expect: { status: 200 }, checks: [['15 on hand', 'j.onHand === 15 && j.available === 15']] }),
        req('Product page: EU 44 sold out, EU 42 low', 'GET', '/market/products/{{slug}}', {
          as: false,
          expect: { status: 200 },
          checks: [
            ['EU 44 not purchasable', "j.variants.find((v) => v.attributes.eu_size === '44').purchasable === false"],
            ['EU 42 low with 2 left', "(() => { const v = j.variants.find((x) => x.attributes.eu_size === '42'); return v.stock.code === 'low' && v.stock.available === 2; })()"],
            ['specs labelled', "j.specs.some((s) => s.key === 'stud_type' && s.valueEn === 'Turf (TF)')"],
            ['checkout open (M13)', 'j.checkoutOpen === true'],
          ],
        }),
        owner('Variant history of EU 43', 'GET', '/shop/variants/{{v43}}/movements', { expect: { status: 200 }, checks: [['receive and opening', "j.items.map((m) => m.reasonCode).join(',') === 'received,opening'"]] }),
        owner('Inventory desk', 'GET', '/shop/inventory', {
          expect: { status: 200 },
          checks: [['stock value at selling price', 'j.kpis.stockValuePoisha === 17 * 650000'], ['one out of stock', 'j.kpis.outOfStock === 1'], ['one low', 'j.kpis.runningLow === 1']],
        }),
        owner('A 7.7% price cut goes live at once', 'PATCH', '/shop/products/{{productId}}', { body: { basePricePoisha: 600000 }, expect: { status: 200 }, checks: [['no review', "j.editStatus === null && j.publicPricePoisha === 600000"]] }),
        owner('A further 33% cut waits for review', 'PATCH', '/shop/products/{{productId}}', { body: { basePricePoisha: 400000 }, expect: { status: 200 }, checks: [['edit draft, public price kept', "j.editStatus === 'draft' && j.publicPricePoisha === 600000"]] }),
        req('The public price stays ৳6,000', 'GET', '/market/products/{{slug}}', { as: false, expect: { status: 200 }, checks: [['600000', 'j.priceFromPoisha === 600000']] }),
        owner('Back to ৳6,000 (no edit left to review)', 'PATCH', '/shop/products/{{productId}}', { body: { basePricePoisha: 600000 }, expect: { status: 200 } }),
        owner('Nothing to review (expect 409)', 'POST', '/shop/products/{{productId}}/submit', { expect: { status: 409, code: 'NOTHING_TO_REVIEW' } }),
      ],
    },
    {
      name: '5. Saved items and staff (FR-33, FR-34)',
      item: [
        owner('My own item (expect 409)', 'PUT', '/me/saved/product/{{productId}}', { expect: { status: 409, code: 'OWN_ITEM' } }),
        member('Save the boots', 'PUT', '/me/saved/product/{{productId}}', { expect: { status: 200 }, checks: [['saved', 'j.saved === true']] }),
        member('My saved items', 'GET', '/me/saved', { expect: { status: 200 }, checks: [['one, with the card', "j.items.length === 1 && j.items[0].item.title === 'Adidas Predator Turf Boots' && j.items[0].badges.length === 0"]] }),
        req('Staff: shops', 'GET', '/admin/market/shops?q=postman', { expect: { status: 200 }, checks: [['the shop', "j.items[0].name === 'Postman Sports House'"]] }),
        req('Staff: products of the shop', 'GET', '/admin/market/products?shopId={{shopId}}', { expect: { status: 200 }, checks: [['one', 'j.items.length === 1']] }),
        req('Suspend the product', 'POST', '/admin/market/products/{{productId}}/suspend', { body: { reason: 'Checking the photos are genuine' }, expect: { status: 200 }, checks: [['suspended', "j.status === 'suspended'"]] }),
        req('The page is gone (expect 410)', 'GET', '/market/products/{{slug}}', { as: false, expect: { status: 410, code: 'PRODUCT_GONE' } }),
        member('Saved shows it unavailable', 'GET', '/me/saved', { expect: { status: 200 }, checks: [['unavailable badge', "j.items[0].badges.includes('unavailable')"]] }),
        req('Restore it (master)', 'POST', '/admin/market/products/{{productId}}/restore', { body: { reason: 'Photos are genuine' }, expect: { status: 200 }, checks: [['live', "j.status === 'live'"]] }),
        member('Unsave', 'DELETE', '/me/saved/product/{{productId}}', { expect: { status: 200 }, checks: [['removed', 'j.removed === true']] }),
      ],
    },
  ],
};

fs.writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${path.relative(process.cwd(), out)}`);
