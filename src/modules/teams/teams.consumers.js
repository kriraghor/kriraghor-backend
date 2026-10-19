'use strict';

/**
 * M16 consumers:
 *  - M01 events: a banned account leaves its teams (captaincy passes on); a phone verified at sign-up,
 *    added later or first proven at OTP sign-in picks up the invites waiting for it;
 *  - eligibility (M16-FR-08, with M14): a changed identity (gender, DOB) or member role (NID review)
 *    re-checks the player's squads in running tournaments; a member who leaves a team leaves its
 *    squads that have not frozen yet.
 */
const { onEvent } = require('../events').consumers;

const recheck = (userId, transaction) => require('./rosters.service').reevaluate(userId, { transaction, tournamentsOf: require('../tournaments').registrations.tournamentsOf });

function registerTeamsConsumers() {
  onEvent('user.banned', 'teams.ban-leaves-teams', (e, { transaction }) => require('./teams.service').onUserBanned(e.payload.userId, { transaction }));
  onEvent('user.registered', 'teams.link-invites-on-signup', (e, { transaction }) => require('./invites.service').onPhoneVerified(e.payload.userId, { transaction }));
  onEvent('user.phone_verified', 'teams.link-invites-on-phone', (e, { transaction }) => require('./invites.service').onPhoneVerified(e.payload.userId, { transaction }));
  onEvent('user.identity_changed', 'teams.recheck-identity', (e, { transaction }) => recheck(e.payload.userId, transaction));
  for (const name of ['user_role.activated', 'user_role.reinstated', 'user_role.suspended', 'user_role.withdrawn']) {
    onEvent(name, `teams.recheck-${name.split('.')[1]}`, (e, { transaction }) => (e.payload.role === 'member' ? recheck(e.payload.userId, transaction) : null));
  }
  onEvent('team_member.removed', 'teams.leave-squads', (e, { transaction }) => require('./rosters.service').onMemberLeft(e.payload.teamId, e.payload.userId, { transaction }));
}

module.exports = { registerTeamsConsumers };
