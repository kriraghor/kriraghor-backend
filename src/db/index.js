'use strict';

const { Sequelize } = require('sequelize');
const config = require('../config');

let sequelize;

if (process.env.DATABASE_URL) {
  // Directly use the connection URI for Supabase / Cloud environments
  sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false, // Supabase SSL support
      },
    },
    define: { underscored: true },
    logging: config.db.logging ? (msg) => { /* use custom logger or no-op */ void msg; } : false,
    pool: { max: config.db.poolMax, min: 0, idle: 10000, acquire: 30000 },
  });
} else {
  // Fallback to individual config fields for local development
  sequelize = new Sequelize(
    config.db.name,
    config.db.user,
    config.db.password,
    {
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
      logging: config.db.logging ? (msg) => { /* use custom logger or no-op */ void msg; } : false,
      pool: { max: config.db.poolMax, min: 0, idle: 10000, acquire: 30000 },
    }
  );
}

module.exports = { sequelize };