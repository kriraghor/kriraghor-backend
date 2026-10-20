'use strict';

/**
 * ADR-007: every call through a module's public index must name something that index exposes, and
 * every name an index exposes must exist in the file it delegates to. The index's facades are lazy
 * (they require their file on first call), so a missing name would only fail at run time, in
 * whichever request first takes that path. This scan finds both kinds of gap statically.
 *
 * Callers are recognised in the two forms the code uses:
 *   const x = require('../mod').facade;          x.name(…)
 *   const x = () => require('../mod').facade;    x().name(…)
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');
const MODULES = path.join(SRC, 'modules');

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}

/** Each module index's facades: { mod: { facade: Set(names) } }, from the real objects. */
function exposed() {
  const out = {};
  for (const mod of fs.readdirSync(MODULES)) {
    const index = path.join(MODULES, mod, 'index.js');
    if (!fs.existsSync(index)) continue;
    const api = require(index);
    out[mod] = Object.fromEntries(Object.entries(api).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => [k, new Set(Object.keys(v))]));
  }
  return out;
}

/** Calls to names an index does not expose. */
function missingCalls(api = exposed()) {
  const found = [];
  for (const file of files(SRC)) {
    // Comments mention module paths too ("events.service → models"): drop block and line comments.
    const text = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\s\/\/ .*$/gm, '');
    const rel = path.relative(SRC, file).replace(/\\/g, '/');
    const bind = /const\s+(\w+)\s*=\s*(\(\)\s*=>\s*)?require\('(?:\.\.\/)+(?:modules\/)?([\w-]+)'\)\.(\w+)\s*;/g;
    for (const m of text.matchAll(bind)) {
      const [, name, lazyFn, mod, facade] = m;
      if (!api[mod]?.[facade]) continue; // not a facade object (a constant, or not an index)
      // A call or a property read, not text inside a string or path ('payments.unknown_grace_minutes').
      const use = new RegExp(`(?<![\\w'"\`./-])${name}${lazyFn ? '\\(\\)' : ''}\\.(\\w+)(?![\\w'"\`.-])`, 'g');
      for (const u of text.matchAll(use)) {
        if (!api[mod][facade].has(u[1])) found.push(`${rel}: ${mod}.${facade}.${u[1]}`);
      }
    }
    // const { a, b: c } = require('../mod').facade;
    for (const m of text.matchAll(/const\s*\{([^}]+)\}\s*=\s*require\('(?:\.\.\/)+(?:modules\/)?([\w-]+)'\)\.(\w+)\s*;/g)) {
      const [, list, mod, facade] = m;
      if (!api[mod]?.[facade]) continue;
      for (const part of list.split(',')) {
        const key = part.split(':')[0].trim();
        if (key && !api[mod][facade].has(key)) found.push(`${rel}: ${mod}.${facade}.${key}`);
      }
    }
    // require('../mod').facade.name(…)
    for (const m of text.matchAll(/require\('(?:\.\.\/)+(?:modules\/)?([\w-]+)'\)\.(\w+)\.(\w+)/g)) {
      const [, mod, facade, key] = m;
      if (api[mod]?.[facade] && !api[mod][facade].has(key)) found.push(`${rel}: ${mod}.${facade}.${key}`);
    }
  }
  return [...new Set(found)].sort();
}

/** Names an index exposes that its target file does not export (each facade delegates to one file). */
function deadNames() {
  const found = [];
  for (const mod of fs.readdirSync(MODULES)) {
    const index = path.join(MODULES, mod, 'index.js');
    if (!fs.existsSync(index)) continue;
    const text = fs.readFileSync(index, 'utf8');
    for (const m of text.matchAll(/(\w+):\s*lazy\('(\.\/[\w.-]+)',\s*\[([^\]]*)\]/g)) {
      const [, facade, file, list] = m;
      const target = require(path.join(MODULES, mod, file));
      for (const n of list.match(/'(\w+)'/g)?.map((q) => q.slice(1, -1)) ?? []) {
        if (typeof target[n] !== 'function') found.push(`${mod}.${facade}.${n} (${file})`);
      }
    }
  }
  return found.sort();
}

module.exports = { missingCalls, deadNames };

if (require.main === module) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ missingCalls: missingCalls(), deadNames: deadNames() }, null, 2));
  process.exit(0);
}
