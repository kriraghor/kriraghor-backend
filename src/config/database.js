'use strict';

const config = require('./index');

// Check if DATABASE_URL is provided (ideal for production & cloud environments)
const useConnectionUri = process.env.DATABASE_URL;

const base = useConnectionUri
  ? {
      url: process.env.DATABASE_URL,
      dialect: 'postgres',
      dialectOptions: {
        ssl: {
          require: true,
          rejectUnauthorized: false, // Supabase SSL Connection
        },
      },
      define: { underscored: true },
      migrationStorageTableName: 'sequelize_meta',
      seederStorage: 'sequelize',
      seederStorageTableName: 'sequelize_seeds',
      logging: config.db.logging ? console.log : false,
    }
  : {
      username: config.db.user,
      password: config.db.password,
      database: config.db.name,
      host: config.db.host,
      port: config.db.port,
      dialect: 'postgres',
      dialectOptions: {
        ssl: {
          require: true,
          rejectUnauthorized: false,
        },
      },
      define: { underscored: true },
      migrationStorageTableName: 'sequelize_meta',
      seederStorage: 'sequelize',
      seederStorageTableName: 'sequelize_seeds',
      logging: config.db.logging ? console.log : false,
    };

// Pool per process.
const pool = { max: config.db.poolMax, min: 0, idle: 10000, acquire: 30000 };

module.exports = {
  development: useConnectionUri ? { url: process.env.DATABASE_URL, dialect: 'postgres', dialectOptions: base.dialectOptions, define: base.define, pool } : { ...base, pool },
  test: useConnectionUri ? { url: process.env.DATABASE_URL, dialect: 'postgres', dialectOptions: base.dialectOptions, define: base.define } : base,
  production: useConnectionUri ? { url: process.env.DATABASE_URL, dialect: 'postgres', dialectOptions: base.dialectOptions, define: base.define, pool } : { ...base, pool },
};