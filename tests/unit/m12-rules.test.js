'use strict';

// M12 pure rules (100% branch gate): state machine (§8), review fields and the 20% reprice threshold
// (FR-02), spec and variant validation (FR-04, FR-05), stock movements and the §6.1 worked example
// (FR-10 to FR-15), the §6.3 variant status, supplement shelf life (v3), prices (FR-32) and slugs.
const r = require('../../src/modules/market/market.rules');

const sel = (key, values, extra = {}) => ({ key, kind: 'select', options: values.map((v) => ({ value: v, labelEn: `EN ${v}`, labelBn: `BN ${v}` })), sort: 1, ...extra });
const FIELDS = [
  sel('stud_type', ['fg', 'tf'], { required: true }),
  sel('eu_size', ['42', '43'], { isVariantAxis: true, required: true, sort: 2 }),
  sel('colour', ['black', 'white'], { isVariantAxis: true, sort: 1 }),
  { key: 'weight_g', kind: 'number', minValue: 900, maxValue: 1500, sort: 3 },
  { key: 'pieces', kind: 'number', minValue: null, maxValue: undefined, sort: 4 },
  { key: 'released', kind: 'date', sort: 5 },
  { key: 'material', kind: 'text', sort: 6 },
  { key: 'old', kind: 'text', isActive: false, required: true, sort: 7 },
];

describe('state machine (§8)', () => {
  it('follows the transitions and refuses the rest', () => {
    expect(r.next('submit', 'draft')).toBe('pending_review');
    expect(r.next('submit', 'live')).toBeNull();
    expect(r.next('approve', 'pending_review')).toBe('live');
    expect(r.next('remove', 'suspended')).toBe('removed');
    expect(r.next('restore', 'live')).toBeNull();
  });

  it('knows published and editable rows, and the edit sub-status after a review change', () => {
    expect(['live', 'paused', 'suspended'].map(r.isPublished)).toEqual([true, true, true]);
    expect(r.isPublished('draft')).toBe(false);
    expect(r.isEditable('live', null)).toBe(true);
    expect(r.isEditable('live', 'pending_review')).toBe(false);
    expect(r.isEditable('pending_review', null)).toBe(false);
    expect(r.editStatusAfterChange('live', null)).toBe('draft');
    expect(r.editStatusAfterChange('live', 'rejected')).toBe('draft');
    expect(r.editStatusAfterChange('live', 'changes_requested')).toBe('changes_requested');
    expect(r.editStatusAfterChange('draft', undefined)).toBeNull();
  });
});

describe('review fields and diffs (FR-02)', () => {
  it('compares values regardless of key order', () => {
    expect(r.same({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(true);
    expect(r.same(undefined, null)).toBe(true);
    expect(r.changedFields({ title: 'A', specs: { x: 1 } }, { title: 'A', specs: { x: 2 }, description: 'new' }, r.PRODUCT_REVIEW_FIELDS)).toEqual(['specs']);
  });

  it('a price move above the threshold needs review (20% vs 20.01%); a first price never does', () => {
    expect(r.repriceNeedsReview(100000, 120000, 20)).toBe(false);
    expect(r.repriceNeedsReview(100000, 120010, 20)).toBe(true);
    expect(r.repriceNeedsReview(100000, 79990, 20)).toBe(true);
    expect(r.repriceNeedsReview(null, 500000, 20)).toBe(false);
  });

  it('builds the product diff for the reviewer', () => {
    const snap = { title: 'Boots', brand: null, specs: { a: 1 }, variants: [{ id: 'v1', pricePoisha: 100 }, { id: 'v2', pricePoisha: 200 }], photos: [{ id: 'p1' }, { id: 'p2' }] };
    const working = { title: 'Turf boots', brand: null, specs: { a: 1 }, variants: [{ id: 'v1', pricePoisha: 150 }, { id: 'v2', pricePoisha: 200 }, { id: 'v3', pricePoisha: 300 }], photos: [{ id: 'p2' }, { id: 'p3' }] };
    const d = r.productDiff(snap, working);
    expect(d).toMatchObject({ first: false, fields: [{ field: 'title', from: 'Boots', to: 'Turf boots' }], prices: [{ variantId: 'v1', from: 100, to: 150 }], photos: { added: 1, removed: 1 } });
    expect(r.diffIsEmpty(d)).toBe(false);
    expect(r.productDiff(null, working)).toEqual({ first: true, fields: [], prices: [], photos: { added: 2, removed: 0 } });
    expect(r.diffIsEmpty(r.productDiff(snap, { ...snap }))).toBe(true);
    expect(r.productDiff({ ...snap, importer: 'Acme' }, { ...snap, brand: 'Nike' }).fields).toEqual([
      { field: 'brand', from: null, to: 'Nike' },
      { field: 'importer', from: 'Acme', to: null },
    ]);
    expect(r.diffIsEmpty({ first: true, fields: [] })).toBe(false);
  });

  it('builds the shop diff', () => {
    expect(r.shopDiff(null, {})).toEqual({ first: true, fields: [] });
    const d = r.shopDiff({ name: 'A', areaId: 'x', addressLine: 'Road 1' }, { name: 'A', areaId: 'y', addressLine: 'Road 1' });
    expect(d.fields).toEqual([{ field: 'areaId', from: 'x', to: 'y' }]);
    expect(r.diffIsEmpty(d)).toBe(false);
    expect(r.diffIsEmpty(r.shopDiff({ name: 'A' }, { name: 'A' }))).toBe(true);
    expect(r.shopDiff({ name: 'A', about: 'x' }, { name: 'A', areaId: 'y' }).fields).toEqual([{ field: 'areaId', from: null, to: 'y' }]);
    expect(r.shopDiff({ name: 'A', addressLine: 'Road 1' }, { name: 'A' }).fields).toEqual([{ field: 'addressLine', from: 'Road 1', to: null }]);
  });
});

describe('specs and variant attributes (FR-04, FR-05)', () => {
  it('accepts valid specs, ignoring inactive fields', () => {
    expect(r.specsBlock(FIELDS, { stud_type: 'tf', weight_g: 1200, pieces: 3, released: '2026-02-28', material: 'Synthetic' })).toBeNull();
    expect(r.specsBlock(FIELDS, { stud_type: 'fg', weight_g: '' })).toBeNull();
  });

  it('refuses unknown keys, axis keys, missing required fields and bad values', () => {
    const errs = r.specsBlock(FIELDS, { eu_size: '43', mystery: 1, weight_g: 800, released: '2026-02-30', material: '  ' });
    expect(errs.map((e) => `${e.field}:${e.message}`)).toEqual([
      'specs.eu_size:Set this on each variant',
      'specs.mystery:Not a field of this item type',
      'specs.stud_type:Required',
      'specs.weight_g:At least 900',
      'specs.released:A date as YYYY-MM-DD',
      'specs.material:Text up to 200 characters',
    ]);
    expect(r.specsBlock(FIELDS, { stud_type: 'sg', weight_g: 1600, pieces: 'x' }).map((e) => e.message)).toEqual(['One of fg, tf', 'At most 1500', 'A number']);
    expect(r.specsBlock(FIELDS)).toEqual([{ field: 'specs.stud_type', message: 'Required' }]);
  });

  it('checks dates strictly', () => {
    expect(r.validDate('2026-10-17')).toBe(true);
    expect(r.validDate('2026-13-01')).toBe(false);
    expect(r.validDate(20261017)).toBe(false);
  });

  it('checks variant attributes against the axis fields', () => {
    expect(r.attributesBlock(FIELDS, { eu_size: '43', colour: 'black' })).toBeNull();
    expect(r.attributesBlock(FIELDS, { eu_size: '44', stud_type: 'tf' }).map((e) => `${e.field}:${e.message}`)).toEqual(['attributes.eu_size:One of 42, 43', 'attributes.stud_type:Not a size or option of this item type']);
    expect(r.attributesBlock(FIELDS, {})).toEqual([{ field: 'attributes.eu_size', message: 'Required' }]);
    expect(r.attributesBlock(FIELDS)).toEqual([{ field: 'attributes.eu_size', message: 'Required' }]);
    expect(r.attributesBlock([], {})).toBeNull();
  });

  it('keeps every variant on the same axes and labels variants', () => {
    expect(r.sameAxes({ eu_size: '42', colour: 'white' }, { colour: 'black', eu_size: '43' })).toBe(true);
    expect(r.sameAxes({ eu_size: '42' }, {})).toBe(false);
    expect(r.sameAxes(undefined, null)).toBe(true);
    expect(r.variantLabel(FIELDS, { eu_size: '43', colour: 'black' })).toBe('EN black · EN 43');
    expect(r.variantLabel(FIELDS, { eu_size: '43' }, 'bn')).toBe('BN 43');
    expect(r.variantLabel(FIELDS, { eu_size: '99' })).toBe('99');
    expect(r.variantLabel(FIELDS, {})).toBe('Standard');
    expect(r.variantLabel(FIELDS, {}, 'bn')).toBe('স্ট্যান্ডার্ড');
  });
});

describe('prices (FR-03, FR-32)', () => {
  it('uses the override, else the base; ranges and the type band', () => {
    expect(r.variantPrice(500000, null)).toBe(500000);
    expect(r.variantPrice(500000, 450000)).toBe(450000);
    expect(r.priceRange([450000, 500000, 520000], 500000)).toEqual({ from: 450000, to: 520000 });
    expect(r.priceRange([], 500000)).toEqual({ from: 500000, to: 500000 });
    expect(r.priceInRange(80000, { floor: 80000, ceiling: 4000000 })).toBe(true);
    expect(r.priceInRange(79999, { floor: 80000, ceiling: 4000000 })).toBe(false);
    expect(r.priceInRange(4000001, { floor: 80000, ceiling: 4000000 })).toBe(false);
  });
});

describe('stock (FR-10 to FR-15)', () => {
  it('follows the §6.1 worked example: receive 5, hold 1, commit 1, return 1', () => {
    let s = { onHand: 0, held: 0 };
    const step = (type, qty) => {
      const n = r.applyMovement(s, type, qty);
      s = { onHand: n.onHand, held: n.held };
      return n;
    };
    expect(step('receive', 5)).toEqual({ onHand: 5, held: 0, deltaOnHand: 5, deltaHeld: 0 });
    expect(step('hold', 1)).toEqual({ onHand: 5, held: 1, deltaOnHand: 0, deltaHeld: 1 });
    expect(step('commit', 1)).toEqual({ onHand: 4, held: 0, deltaOnHand: -1, deltaHeld: -1 });
    expect(step('return_restock', 1)).toEqual({ onHand: 5, held: 0, deltaOnHand: 1, deltaHeld: 0 });
  });

  it('refuses overselling, over-release, adjustments below held and unknown types', () => {
    expect(r.applyMovement({ onHand: 2, held: 1 }, 'hold', 2)).toEqual({ error: 'INSUFFICIENT_STOCK' });
    expect(r.applyMovement({ onHand: 2, held: 1 }, 'hold', 1)).toMatchObject({ held: 2 });
    expect(r.applyMovement({ onHand: 2, held: 1 }, 'release', 2)).toEqual({ error: 'STOCK_STATE' });
    expect(r.applyMovement({ onHand: 2, held: 1 }, 'release', 1)).toMatchObject({ held: 0 });
    expect(r.applyMovement({ onHand: 2, held: 1 }, 'commit', 2)).toEqual({ error: 'STOCK_STATE' });
    expect(r.applyMovement({ onHand: 5, held: 3 }, 'adjust', -3)).toEqual({ error: 'BELOW_HELD' });
    expect(r.applyMovement({ onHand: 5, held: 0 }, 'adjust', -6)).toEqual({ error: 'BELOW_HELD' });
    expect(r.applyMovement({ onHand: 5, held: 3 }, 'adjust', -2)).toEqual({ onHand: 3, held: 3, deltaOnHand: -2, deltaHeld: 0 });
    expect(r.applyMovement({ onHand: 5, held: 0 }, 'teleport', 1)).toEqual({ error: 'STOCK_STATE' });
  });

  it('fires low stock once per crossing and re-arms above the threshold', () => {
    expect(r.lowStockStep({ available: 3, threshold: 3, alerted: false })).toBe('reached');
    expect(r.lowStockStep({ available: 2, threshold: 3, alerted: true })).toBeNull();
    expect(r.lowStockStep({ available: 0, threshold: 3, alerted: false })).toBeNull();
    expect(r.lowStockStep({ available: 4, threshold: 3, alerted: true })).toBe('rearmed');
    expect(r.lowStockStep({ available: 4, threshold: 3, alerted: false })).toBeNull();
  });

  it('notices out of stock and restock', () => {
    expect(r.stockStep(1, 0)).toBe('depleted');
    expect(r.stockStep(0, 2)).toBe('restocked');
    expect(r.stockStep(3, 2)).toBeNull();
    expect(r.stockStep(0, 0)).toBeNull();
  });

  it('hides a product only when no active variant can be sold (blocked counts as out)', () => {
    const v = (available, saleBlocked = false, status = 'active') => ({ available, saleBlocked, status });
    expect(r.shouldHide({ isMto: false, autoHide: true, variants: [v(0), v(0)] })).toBe(true);
    expect(r.shouldHide({ isMto: false, autoHide: true, variants: [v(0), v(2)] })).toBe(false);
    expect(r.shouldHide({ isMto: false, autoHide: true, variants: [v(5, true), v(0)] })).toBe(true);
    expect(r.shouldHide({ isMto: false, autoHide: true, variants: [v(5, false, 'retired')] })).toBe(true);
    expect(r.shouldHide({ isMto: false, autoHide: false, variants: [v(0)] })).toBe(false);
    expect(r.shouldHide({ isMto: true, autoHide: true, variants: [v(0)] })).toBe(false);
    expect(r.saleable(v(0), true)).toBe(true);
    expect(r.saleable(v(0, true), true)).toBe(false);
  });

  it('gives the §6.3 variant status', () => {
    const base = { isMto: false, mtoDays: null, lowThreshold: 3, autoHide: true, saleBlocked: false };
    expect(r.variantStatus({ ...base, saleBlocked: true, available: 9 })).toEqual({ code: 'blocked' });
    expect(r.variantStatus({ ...base, isMto: true, mtoDays: 5, available: 0 })).toEqual({ code: 'mto', days: 5 });
    expect(r.variantStatus({ ...base, available: 0 })).toEqual({ code: 'out_hidden' });
    expect(r.variantStatus({ ...base, autoHide: false, available: -1 })).toEqual({ code: 'out' });
    expect(r.variantStatus({ ...base, available: 3 })).toEqual({ code: 'low', available: 3 });
    expect(r.variantStatus({ ...base, available: 4 })).toEqual({ code: 'in_stock', available: 4 });
  });
});

describe('supplement shelf life (v3)', () => {
  it('blocks a variant with fewer than market.supplement_min_shelf_days left (29 / 30 / 31)', () => {
    const today = '2026-10-17';
    expect(r.daysUntil(today, '2026-11-16')).toBe(30);
    expect(r.shelfBlocked({ expiryDate: '2026-11-15', today, minShelfDays: 30 })).toBe(true);
    expect(r.shelfBlocked({ expiryDate: '2026-11-16', today, minShelfDays: 30 })).toBe(false);
    expect(r.shelfBlocked({ expiryDate: '2026-11-17', today, minShelfDays: 30 })).toBe(false);
    expect(r.shelfBlocked({ expiryDate: '2026-10-01', today, minShelfDays: 0 })).toBe(true);
    expect(r.shelfBlocked({ expiryDate: null, today, minShelfDays: 30 })).toBe(false);
  });

  it('dates are Asia/Dhaka calendar days', () => {
    expect(r.dhakaDate(new Date('2026-10-16T18:30:00Z'))).toBe('2026-10-17');
    expect(r.dhakaDate(new Date('2026-10-16T17:59:00Z'))).toBe('2026-10-16');
  });
});

describe('slugs', () => {
  it('makes URL slugs with a fallback', () => {
    expect(r.slugify('Adidas Predator — Turf Boots!', 'item')).toBe('adidas-predator-turf-boots');
    expect(r.slugify('প্রোটিন', 'item')).toBe('item');
  });
});
