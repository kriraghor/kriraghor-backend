'use strict';

/**
 * M24 consumers (§2.3), registered once per process (registry.registerAll). Each runs in the inbox
 * transaction, so a duplicate delivery is skipped and every handler is idempotent anyway:
 *  - gym_pass.redeemed (M20): a linked member admitted on a pass gets a `pass` check-in (M24-FR-52);
 *  - user.phone_verified and user.registered (M01): gym invites waiting for that phone attach to the
 *    account and are announced (M24-FR-14);
 *  - refund.succeeded (M06, prompt 2): the reversal row of a refunded online fee (M24-FR-44);
 *  - business_member.removed and business_member.permissions_changed (M01, prompt 3): a removed trainer,
 *    or one left with neither members.trainer nor plans.manage, is taken off their members (M24-FR-21);
 *  - notification.sms_settled (M08, prompt 3b): the SMS hold is settled (§6.7).
 * Prompt 2 also loads the M06 purpose hooks (gym_membership_fee, gym_saas_invoice), registers the M08
 * recipient adapter `gym_member` (email to unlinked members, §11.1) and the M24 ledger-side invariants.
 */
const { onEvent } = require('../events').consumers;

function registerGymManageConsumers() {
  // M20-FR-20: a holiday or special hours cancels the booked trial visits it leaves without an open hour.
  onEvent('gym.suspended', 'gym-manage.suspended-visits', (e, { transaction }) => require('./guests.service').onGymSuspended(e.payload, { transaction }));
  onEvent('gym_special_day.created', 'gym-manage.special-day-visits', (e, { transaction }) => require('./guests.service').onSpecialDay(e.payload, { transaction }));
  onEvent('gym_pass.redeemed', 'gym-manage.pass-checkin', (e, { transaction }) => require('./checkins.service').onPassRedeemed(e.payload, { transaction }));
  onEvent('user.phone_verified', 'gym-manage.attach-invites', (e, { transaction }) => require('./links.service').attachOnPhoneVerified(e.payload.userId, { transaction }));
  onEvent('user.registered', 'gym-manage.attach-invites-on-signup', (e, { transaction }) => require('./links.service').attachOnPhoneVerified(e.payload.userId, { transaction }));
  onEvent('refund.succeeded', 'gym-manage.fee-refund-reversal', (e, { transaction }) => require('./links-pay.service').onRefundSucceeded(e.payload, { transaction }));
  onEvent('business_member.removed', 'gym-manage.trainer-removed', (e, { transaction }) => require('./trainers.service').onStaffRemoved(e.payload, { transaction }));
  onEvent('business_member.permissions_changed', 'gym-manage.trainer-permissions', (e, { transaction }) => require('./trainers.service').onPermissionsChanged(e.payload, { transaction }));
  // Prompt 3b: M08 reports a billed SMS; the hold is settled (§6.7).
  onEvent('notification.sms_settled', 'gym-manage.sms-settle', (e, { transaction }) => require('./sms.service').settle(e.payload, { transaction }));
  // M06 purpose hooks load with their services.
  require('./links-pay.service');
  require('./invoices.service');
  require('./notices.service').registerRecipientAdapter();
  require('./invariants').registerInvariants();
}

module.exports = { registerGymManageConsumers };
