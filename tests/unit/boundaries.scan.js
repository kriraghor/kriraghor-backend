'use strict';
/* eslint-disable no-console -- a command-line report when run directly */

/**
 * Module boundary scanner (ADR-007 §3). Lists every place a module reaches into another:
 *  - deep:  require('../<other module>/<file>') instead of the module's public index;
 *  - model: a Sequelize model owned by another module group, used directly;
 *  - sql:   raw SQL naming a table owned by another module group.
 * Imports from the same group are allowed for models and SQL, but not deep imports across modules.
 *
 *   node tests/unit/boundaries.scan.js           print the current violations
 *   node tests/unit/boundaries.scan.js --write   rewrite the baseline (it may only shrink: review the diff)
 */
const fs = require('fs');
const path = require('path');
const { groupOf, ownerOf } = require('../../src/modules/ownership');

const MOD = path.join(__dirname, '..', '..', 'src', 'modules');
const BASELINE = path.join(__dirname, 'boundaries.baseline.json');

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return p.endsWith('.js') ? [p] : [];
  });
}

/** Table name → owning module, from the models themselves (tableName is the source of truth). */
function tableOwners() {
  const models = require('../../src/models');
  const out = {};
  for (const [name, m] of Object.entries(models)) {
    if (m && typeof m.getTableName === 'function' && m.rawAttributes && ownerOf[name]) out[m.getTableName()] = ownerOf[name];
  }
  return out;
}

function scan() {
  const modules = fs.readdirSync(MOD, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const tables = tableOwners();
  const found = new Set();
  for (const f of modules.flatMap((m) => files(path.join(MOD, m)))) {
    const rel = path.relative(MOD, f).split(path.sep).join('/');
    const mod = rel.split('/')[0];
    const src = fs.readFileSync(f, 'utf8');

    for (const x of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!x[1].startsWith('.')) continue;
      const target = path.relative(MOD, path.resolve(path.dirname(f), x[1])).split(path.sep);
      if (target[0] === '..' || !modules.includes(target[0]) || target[0] === mod) continue;
      if (target.length > 1) found.add(`deep ${rel} -> ${target.join('/')}`);
    }

    const used = new Set();
    for (const x of src.matchAll(/\{([^}]+)\}\s*=\s*require\(\s*['"][./]+models['"]\s*\)/g)) {
      for (const n of x[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean)) used.add(n);
    }
    for (const x of src.matchAll(/\bmodels\.([A-Z]\w+)/g)) used.add(x[1]);
    for (const n of used) {
      const owner = ownerOf[n];
      if (owner && groupOf[owner] !== groupOf[mod]) found.add(`model ${rel} -> ${n} (${owner})`);
    }

    for (const x of src.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+"?([a-z_]+)"?/g)) {
      const owner = tables[x[1]];
      if (owner && groupOf[owner] !== groupOf[mod]) found.add(`sql ${rel} -> ${x[1]} (${owner})`);
    }
  }
  return [...found].sort();
}

const readBaseline = () => (fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : []);

module.exports = { scan, readBaseline, BASELINE };

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const now = scan();
  if (process.argv.includes('--write')) {
    fs.writeFileSync(BASELINE, `${JSON.stringify(now, null, 1)}\n`);
    console.log(`baseline: ${now.length} violations`);
  } else {
    for (const v of now) console.log(v);
    console.log(`${now.length} violations`);
  }
  process.exit(0);
}
