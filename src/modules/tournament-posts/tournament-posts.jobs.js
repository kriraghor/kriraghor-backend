'use strict';

/** M26 tick (job tournament_posts.tick, hourly, queue tournament_posts): open posts past their last day expire. */
const posts = require('./posts.service');

async function tick(now = new Date()) {
  return posts.expireDue(now);
}

module.exports = { tick };
