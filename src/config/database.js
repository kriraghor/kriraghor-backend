'use strict';

const config = require('./index');

const useConnectionUri = process.env.DATABASE_URL;
const isTestEnv = process.env.NODE_ENV === 'test';

const sslConfig = isTestEnv
  ? false
  : {
      require: true,
      rejectUnauthorized: false, // Supabase SSL Connection for Prod/Dev
    };

const base = useConnectionUri
  ? {
      url: process.env.DATABASE_URL,
      dialect: 'postgres',
      dialectOptions: {
        ssl: sslConfig,
      },
      define: { underscored: true },
      migrationStorageTableName: 'sequelize_meta',
      seederStorage: 'sequelize',
      seederStorageTableName: 'sequelize_seeds',
      logging: config.db.logging ? (msg) => { void msg; } : false,
    }
  : {
      username: config.db.user,
      password: config.db.password,
      database: config.db.name,
      host: config.db.host,
      port: config.db.port,
      dialect: 'postgres',
      dialectOptions: {
        ssl: sslConfig,
      },
      define: { underscored: true },
      migrationStorageTableName: 'sequelize_meta',
      seederStorage: 'sequelize',
      seederStorageTableName: 'sequelize_seeds',
      logging: config.db.logging ? (msg) => { void msg; } : false,
    };

const pool = { max: config.db.poolMax, min: 0, idle: 10000, acquire: 30000 };

module.exports = {
  development: useConnectionUri
    ? { url: process.env.DATABASE_URL, dialect: 'postgres', dialectOptions: base.dialectOptions, define: base.define, pool }
    : { ...base, pool },

  test: useConnectionUri
    ? { url: process.env.DATABASE_URL, dialect: 'postgres', dialectOptions: { ssl: false }, define: base.define }
    : { ...base, dialectOptions: { ssl: false } },

  production: useConnectionUri
    ? { url: process.env.DATABASE_URL, dialect: 'postgres', dialectOptions: base.dialectOptions, define: base.define, pool }
    : { ...base, pool },
};