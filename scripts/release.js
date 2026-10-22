'use strict';

/**
 * Release step (Helm pre-install/pre-upgrade Job, ADR-003): run migrations, then the M03
 * reference seed. Never runs on app boot. `--seed-only` skips migrations (tests, local resets).
 * Uses process.execPath, so it works on the distroless image (no shell, no npm).
 */
const path = require('path');
const { spawnSync } = require('child_process');

function migrate() {
  const cli = path.join(__dirname, '..', 'node_modules', 'sequelize-cli', 'lib', 'sequelize');
  const res = spawnSync(process.execPath, [cli, 'db:migrate'], { cwd: path.join(__dirname, '..'), stdio: 'inherit', env: process.env });
  if (res.status !== 0) throw new Error(`migrations failed (exit ${res.status})`);
}

async function main() {
  if (!process.argv.includes('--seed-only')) migrate();
  // Load models only after migrations, so the seed sees the final schema.
  // The release step always seeds (it is not on a host's start-up clock) and records the fingerprint,
  // so the API start that follows skips the seed.
  const { seedReferenceIfChanged } = require('../src/db/seed');
  const { sequelize } = require('../src/models');
  try {
    const { inserted } = await seedReferenceIfChanged({ force: true });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ msg: 'reference seed done', inserted }));
  } finally {
    await sequelize.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
