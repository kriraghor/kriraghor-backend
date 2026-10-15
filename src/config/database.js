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
  define: { underscored: true },
  migrationStorageTableName: 'sequelize_meta',
  seederStorage: 'sequelize',
  seederStorageTableName: 'sequelize_seeds',
  logging: config.db.logging ? console.log : false,
};

const pool = { max: config.db.poolMax, min: 0, idle: 10000, acquire: 30000 };

// Render & Cloud PostgreSQL requires SSL & URL parsing
const productionConfig = process.env.DATABASE_URL
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
          rejectUnauthorized: false, // Render Postgres connection requires SSL
        },
      },
    }
  : { ...base, pool };

module.exports = {
  development: { ...base, pool },
  test: base,
  production: productionConfig,
};