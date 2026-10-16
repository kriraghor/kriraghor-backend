'use strict';

const config = require('./index');

<<<<<<< HEAD
const base = {
  username: config.db.user,
  password: config.db.password,
  database: config.db.name,
  host: config.db.host,
  port: config.db.port,
  dialect: 'postgres',
  timezone: '+00:00',
  define: { underscored: true },
  migrationStorageTableName: 'sequelize_meta',
  seederStorage: 'sequelize',
  seederStorageTableName: 'sequelize_seeds',
  logging: config.db.logging ? console.log : false,
};
=======
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
>>>>>>> origin/feat/0b-platform

const pool = { max: config.db.poolMax, min: 0, idle: 10000, acquire: 30000 };

// Render ba onno kono Cloud Provider-er jonno (SSL soho)
const databaseUrlConfig = process.env.DATABASE_URL
  ? {
      use_env_variable: 'DATABASE_URL',
      url: process.env.DATABASE_URL,
      dialect: 'postgres',
      timezone: '+00:00',
      define: { underscored: true },
      migrationStorageTableName: 'sequelize_meta',
      seederStorage: 'sequelize',
      seederStorageTableName: 'sequelize_seeds',
      logging: config.db.logging ? console.log : false,
      pool,
      dialectOptions: {
        ssl: {
          require: true,
          rejectUnauthorized: false, // Cloud Postgres (Render) SSL connection handle kore
        },
      },
    }
  : null;

// Config Export: DATABASE_URL thakle automatic oita priority pabe
module.exports = {
<<<<<<< HEAD
  development: databaseUrlConfig || { ...base, pool },
  test: base,
  production: databaseUrlConfig || { ...base, pool },
=======
  development: useConnectionUri
    ? { url: process.env.DATABASE_URL, dialect: 'postgres', dialectOptions: base.dialectOptions, define: base.define, pool }
    : { ...base, pool },

  test: useConnectionUri
    ? { url: process.env.DATABASE_URL, dialect: 'postgres', dialectOptions: { ssl: false }, define: base.define }
    : { ...base, dialectOptions: { ssl: false } },

  production: useConnectionUri
    ? { url: process.env.DATABASE_URL, dialect: 'postgres', dialectOptions: base.dialectOptions, define: base.define, pool }
    : { ...base, pool },
>>>>>>> origin/feat/0b-platform
};