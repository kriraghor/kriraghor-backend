'use strict';

/**
 * M16 consumers: M01 events. A banned account leaves its teams (captaincy passes on); a phone verified
 * at sign-up, added later or first proven at OTP sign-in picks up the invites waiting for it.
 */
const { onEvent } = require('../events/events.consumers');

function registerTeamsConsumers() {
  onEvent('user.banned', 'teams.ban-leaves-teams', (e, { transaction }) => require('./teams.service').onUserBanned(e.payload.userId, { transaction }));
  onEvent('user.registered', 'teams.link-invites-on-signup', (e, { transaction }) => require('./invites.service').onPhoneVerified(e.payload.userId, { transaction }));
  onEvent('user.phone_verified', 'teams.link-invites-on-phone', (e, { transaction }) => require('./invites.service').onPhoneVerified(e.payload.userId, { transaction }));
}

module.exports = { registerTeamsConsumers };
