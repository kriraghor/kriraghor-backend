'use strict';

/**
 * M24 consumers of prompt 1 (§2.3), registered once per process (registry.registerAll). Each runs in
 * the inbox transaction, so a duplicate delivery is skipped and every handler is idempotent anyway:
 *  - gym_pass.redeemed (M20): a linked member admitted on a pass gets a `pass` check-in (M24-FR-52);
 *  - user.phone_verified and user.registered (M01): gym invites waiting for that phone attach to the
 *    account and are announced (M24-FR-14).
 */
const { onEvent } = require('../events').consumers;

function registerGymManageConsumers() {
  onEvent('gym_pass.redeemed', 'gym-manage.pass-checkin', (e, { transaction }) => require('./checkins.service').onPassRedeemed(e.payload, { transaction }));
  onEvent('user.phone_verified', 'gym-manage.attach-invites', (e, { transaction }) => require('./links.service').attachOnPhoneVerified(e.payload.userId, { transaction }));
  onEvent('user.registered', 'gym-manage.attach-invites-on-signup', (e, { transaction }) => require('./links.service').attachOnPhoneVerified(e.payload.userId, { transaction }));
}

module.exports = { registerGymManageConsumers };
