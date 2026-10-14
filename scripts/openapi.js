'use strict';

/**
 * Write openapi.json from the zod schemas (ADR-002).
 *   npm run openapi            write openapi.json
 *   npm run openapi -- --check exit 1 if the committed file is stale (CI)
 */
const fs = require('fs');
const path = require('path');
const { buildOpenApi } = require('../src/openapi');

const file = path.join(__dirname, '..', 'openapi.json');
const next = `${JSON.stringify(buildOpenApi(), null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current !== next) {
    // eslint-disable-next-line no-console
    console.error('openapi.json is stale. Run: npm run openapi');
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('openapi.json is up to date');
} else {
  fs.writeFileSync(file, next);
  // eslint-disable-next-line no-console
  console.log(`wrote ${path.relative(process.cwd(), file)} (${Object.keys(JSON.parse(next).paths).length} paths)`);
}
