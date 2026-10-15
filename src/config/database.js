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
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false, // Supabase SSL Connection এর জন্য
    },
  },
  define: { underscored: true },
  migrationStorageTableName: 'sequelize_meta',
  seederStorage: 'sequelize',
  seederStorageTableName: 'sequelize_seeds',
  // eslint-disable-next-line no-console
  logging: config.db.logging ? console.log : false,
};

// Pool per process.
const pool = { max: config.db.poolMax, min: 0, idle: 10000, acquire: 30000 };

module.exports = {
  development: { ...base, pool },
  test: base,
  production: { ...base, pool },
};