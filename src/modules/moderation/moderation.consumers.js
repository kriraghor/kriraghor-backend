'use strict';

/**
 * M05 consumers: the subject module's acknowledgement (FR-13) and account sanctions (edge case 6).
 */
const { onEvent } = require('../events/events.consumers');
const moderation = require('./moderation.service');

function registerModerationConsumers() {
  onEvent('submission.applied', 'moderation.mark-applied', (e, { transaction }) => moderation.markApplied(e.payload.submissionId, { transaction }));
  onEvent('user.suspended', 'moderation.withdraw-suspended', (e, { transaction }) => moderation.withdrawAllOf(e.payload.userId, { transaction }));
  onEvent('user.banned', 'moderation.withdraw-banned', (e, { transaction }) => moderation.withdrawAllOf(e.payload.userId, { transaction }));
}

module.exports = { registerModerationConsumers };
