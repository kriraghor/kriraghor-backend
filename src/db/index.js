'use strict';

const { Sequelize } = require('sequelize');
const dbConfig = require('../config/database');
const config = require('../config');

const c = dbConfig[config.env];

let sequelize;

if (c.url) {
  // If DATABASE_URL (Cloud/Render) is available hai then direct URL will be  pass
  sequelize = new Sequelize(c.url, {
    dialect: c.dialect,
    timezone: c.timezone,
    dialectOptions: c.dialectOptions,
    define: c.define,
    pool: c.pool,
    logging: c.logging,
  });
} else {
  // if local environment use : username, password, host
  sequelize = new Sequelize(c.database, c.username, c.password, {
    host: c.host,
    port: c.port,
    dialect: c.dialect,
    timezone: c.timezone,
    dialectOptions: c.dialectOptions,
    define: c.define,
    pool: c.pool,
    logging: c.logging,
  });
}

module.exports = { sequelize, Sequelize };