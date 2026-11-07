'use strict';

/**
 * M27 jobs (BullMQ, src/jobs/definitions.js): round 1 gym-ops.daily (lockers, expiry alerts); round 2
 * gym-ops.classes-points-daily (sessions ahead, points expiry) and gym-ops.class-reminders; round 3 the
 * equipment service reminders (in gym-ops.daily) and gym-ops.staff-clockout.
 */
const lockers = require('./lockers.service');
const shop = require('./shop.service');

async function daily(now = new Date()) {
  const rentals = await lockers.daily(now);
  const expiring = await shop.expiryAlerts(now);
  const service = await require('./assets.service').serviceReminders();
  return { ...rentals, expiring, serviceReminders: service.sent };
}

async function classesAndPoints() {
  const sessions = await require('./classes.service').sessionsAhead();
  const points = await require('./points.service').expire();
  return { ...sessions, ...points };
}

const classReminders = (now = new Date()) => require('./classes.service').reminders(now);

const staffClockout = (now = new Date()) => require('./staff.service').autoClockOut(now);

module.exports = { daily, classesAndPoints, classReminders, staffClockout };
