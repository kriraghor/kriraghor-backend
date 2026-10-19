'use strict';

/**
 * ADR-007 §3: module boundaries, as a ratchet. tests/unit/boundaries.baseline.json lists the
 * violations that existed when the rule arrived (20 Oct 2026); plan step 4 removes them. A NEW deep
 * import, cross-group model use or cross-group SQL fails here, and so does a baseline entry that has
 * been fixed but is still listed (run `node tests/unit/boundaries.scan.js --write` and commit).
 */
const { scan, readBaseline } = require('./boundaries.scan');
const { groupOf, ownerOf } = require('../../src/modules/ownership');
const models = require('../../src/models');

afterAll(() => models.sequelize.close());

describe('module boundaries (ADR-007)', () => {
  const now = scan();
  const baseline = new Set(readBaseline());

  it('adds no new violation', () => {
    expect(now.filter((v) => !baseline.has(v))).toEqual([]);
  });

  it('keeps the baseline current (fixed entries are removed)', () => {
    const current = new Set(now);
    expect([...baseline].filter((v) => !current.has(v))).toEqual([]);
  });

  it('gives every module a group and every model an owner', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'src', 'modules');
    const mods = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    expect(mods.filter((m) => !groupOf[m])).toEqual([]);
    const named = Object.entries(models).filter(([, m]) => m && typeof m.getTableName === 'function' && m.rawAttributes).map(([n]) => n);
    expect(named.filter((n) => !ownerOf[n])).toEqual([]);
  });
});
