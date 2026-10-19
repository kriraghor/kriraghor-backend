'use strict';

/**
 * M18 job entry points (§10): one account (rules, then reliability), everyone with flags or metrics
 * (after a threshold change), and the nightly run (M02 overdue document requests, then every active
 * account re-evaluated, which also lapses quiet flags). Each step re-reads its facts, so a repeat or a
 * retry is harmless. Failures of one account are logged and the run goes on.
 */
const logger = require('../../common/logger');
const settings = require('../settings').settings;
const flags = require('./flags.service');
const trust = require('./trust.service');

const DAY = 24 * 3600 * 1000;

async function evaluate(userId, now = new Date()) {
  const result = await flags.evaluateUser(userId, now);
  const scores = await trust.recompute(userId, now);
  return { ...result, scores };
}

async function each(ids, now) {
  let done = 0;
  for (const id of ids) {
    try {
      await evaluate(id, now);
      done += 1;
    } catch (err) {
      logger.error({ err: err.message, userId: id }, 'risk evaluation failed');
    }
  }
  return done;
}

async function everyone(now = new Date()) {
  const ids = await flags.activeUserIds({ since: new Date(now.getTime() - settings.get('risk.window_days') * DAY) });
  return { evaluated: await each(ids, now) };
}

async function nightly(now = new Date()) {
  const overdue = await require('../kyc').requests.markOverdue(now);
  const { evaluated } = await everyone(now);
  return { overdue, evaluated };
}

module.exports = { evaluate, everyone, nightly };
