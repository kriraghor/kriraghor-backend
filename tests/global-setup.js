'use strict';

const { execSync } = require('child_process');
const path = require('path');

/** Create the test schema from migrations once per run (requires MySQL from docker-compose). */
module.exports = async () => {
  require('./env');
  const cli = path.join(__dirname, '..', 'node_modules', '.bin', 'sequelize-cli');
  const opts = { cwd: path.join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' }, shell: true };
  execSync(`"${cli}" db:migrate:undo:all`, opts);
  execSync(`"${cli}" db:migrate`, opts);
};
