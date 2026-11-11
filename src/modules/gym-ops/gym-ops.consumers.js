'use strict';

/**
 * M27 round 2 consumers (registered once per process by registry.registerAll), each in the inbox transaction:
 *  - gym_attendance.recorded (M24, a counted check-in): check-in points and the streak bonus (FR-55, FR-56);
 *  - gym_fee.recorded (M24): a referred member's first fee rewards whoever referred them (FR-57).
 */
const { onEvent } = require('../events').consumers;

function registerGymOpsConsumers() {
  // M20-FR-20, FR-21: a holiday or special hours cancels the class sessions it leaves shut; removing it brings them back empty.
  onEvent('gym_special_day.created', 'gym-ops.special-day-classes', (e, { transaction }) => require('./classes.service').onSpecialDay(e.payload, { transaction }));
  onEvent('gym_special_day.removed', 'gym-ops.special-day-classes-back', (e, { transaction }) => require('./classes.service').onSpecialDayRemoved(e.payload, { transaction }));
  onEvent('gym_attendance.recorded', 'gym-ops.points-checkin', (e, { transaction }) => require('./points.service').onCheckIn(e.payload, { transaction }));
  onEvent('gym_fee.recorded', 'gym-ops.points-referral', (e, { transaction }) => require('./points.service').onFee(e.payload, { transaction }));
}

module.exports = { registerGymOpsConsumers };
