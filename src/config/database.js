'use strict';

const config = require('./index');

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
  development: databaseUrlConfig || { ...base, pool },
  test: base,
  production: databaseUrlConfig || { ...base, pool },
};