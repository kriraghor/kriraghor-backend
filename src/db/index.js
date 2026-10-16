'use strict';

const { Sequelize } = require('sequelize');
const config = require('../config');

let sequelize;

if (process.env.DATABASE_URL) {
  // Cloud Postgres / Supabase / Render connection
  sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: {
      ssl: config.isProd || process.env.DB_SSL === 'true'
        ? { require: true, rejectUnauthorized: false }
        : false,
    },
    define: { underscored: true },
    logging: config.db.logging ? console.log : false,
    pool: { max: config.db.poolMax, min: 0, idle: 10000, acquire: 30000 },
  });
} else {
  // Local environment setup
  sequelize = new Sequelize(
    config.db.name,
    config.db.user,
    config.db.password,
    {
      host: config.db.host,
      port: config.db.port,
      dialect: 'postgres',
      dialectOptions: {
        ssl: config.isProd || process.env.DB_SSL === 'true'
          ? { require: true, rejectUnauthorized: false }
          : false,
      },
      define: { underscored: true },
      logging: config.db.logging ? console.log : false,
      pool: { max: config.db.poolMax, min: 0, idle: 10000, acquire: 30000 },
    }
  );
}

module.exports = { sequelize, Sequelize };