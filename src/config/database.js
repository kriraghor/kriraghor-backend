'use strict';

// Used by sequelize-cli (migrations/seeders) and by the app's Sequelize instance.
const config = require('./index');

const base = {
  username: config.db.user,
  password: config.db.password,
  database: config.db.name,
  host: config.db.host,
  port: config.db.port,
  dialect: 'postgres',
  timezone: '+00:00', // store UTC; business logic converts to Asia/Dhaka
  // pg returns BIGINT and NUMERIC as strings; money getters (common/money) turn them into checked numbers.
  define: { underscored: true },
  migrationStorageTableName: 'sequelize_meta',
  seederStorage: 'sequelize',
  seederStorageTableName: 'sequelize_seeds',
  // eslint-disable-next-line no-console
  logging: config.db.logging ? console.log : false,
};

// Pool per process. With N pods x 3 processes, keep N x 3 x DB_POOL_MAX under Postgres max_connections (or put PgBouncer in front).
const pool = { max: config.db.poolMax, min: 0, idle: 10000, acquire: 30000 };

module.exports = {
  development: { ...base, pool },
  test: base,
  production: { ...base, pool },
};
