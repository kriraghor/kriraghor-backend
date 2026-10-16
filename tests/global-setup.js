'use strict';

const { execSync } = require('child_process');
const path = require('path');

/**
 * Create the test schema from migrations and seed reference data once per run (requires PostgreSQL
 * from docker-compose). The test database is disposable: the schema is dropped and recreated rather
 * than undoing every migration, because rows left by an earlier run (for example a staff permission
 * granted under a newer CHECK list) can rightly stop an older migration's down step.
 */
module.exports = async () => {
  require('./env');
  const { sequelize } = require('../src/db');
  await sequelize.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await sequelize.close();
  const cli = path.join(__dirname, '..', 'node_modules', '.bin', 'sequelize-cli');
  const opts = { cwd: path.join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' }, shell: true };
  execSync(`"${cli}" db:migrate`, opts);
  execSync(`node scripts/release.js --seed-only`, opts);
};
