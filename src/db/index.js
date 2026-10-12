'use strict';

const { Sequelize } = require('sequelize');
const dbConfig = require('../config/database');
const config = require('../config');

const c = dbConfig[config.env];

const sequelize = new Sequelize(c.database, c.username, c.password, {
  host: c.host,
  port: c.port,
  dialect: c.dialect,
  timezone: c.timezone,
  dialectOptions: c.dialectOptions,
  define: c.define,
  pool: c.pool,
  logging: c.logging,
});

module.exports = { sequelize, Sequelize };
