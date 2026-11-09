'use strict';

/**
 * M24 member notices (§11.1, M24-FR-55 to FR-57): who receives a notice about a member, decided when
 * M08 routes it (through the gym-manage facade) and when the "sent once" log row is written.
 *  - Member notices need the owner's `reminders` feature (Basic and up) and a subscription that is not
 *    restricted (FR-08: reminders pause); a kind the owner switched off sends nothing (FR-55).
 *  - A linked member is reached by user id (in-app, push and the account's email); an unlinked member
 *    with an email in the gym's record by email only, through the M08 recipient adapter `gym_member`
 *    (no address in any event, FR-108).
 *  - SMS needs the paid add-on (prompt 3b, sms.service): when the add-on, the kind and the balance allow
 *    it, the units are held and the event carries sms.billingRef; a member with only a phone is then
 *    reachable too (the adapter resolves the phone in memory).
 *  - The adapter resolves { email, phone, locale } in memory; the locale is the gym owner's.
 */
const { GymMember, GymReminder } = require('../../models');
const directory = require('../users').directory;
const gymFacade = require('../gym').gyms;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');

const NONE = Object.freeze({ userIds: [], external: [], skip: null });

/**
 * Why a member notice of `kind` (null: a notice with no on/off switch) is not sent for this member, or
 * null: tier, restricted, off, no_contact (§7.2 gym_reminders.skip_reason).
 */
async function skipReason(member, kind, { transaction, sms = false } = {}) {
  const gym = await gymFacade.get(member.gymId, { transaction });
  if (!gym) return 'off';
  const sub = await c.subscriptionOf(gym.ownerId, { transaction });
  if (!rules.hasFeature(sub.chosenTier, 'reminders', c.tierCfg().featureMinTiers)) return 'tier';
  if (sub.status === 'restricted') return 'restricted';
  if (kind) {
    const s = await c.settingsOf(member.gymId, { transaction });
    if ((s?.remindersOff ?? []).includes(kind)) return 'off';
  }
  if (!member.userId && !member.emailEnc && !sms) return 'no_contact';
  return null;
}

/** The channels a reachable member gets (the log's `channels`): linked → in-app, push, email; unlinked → email. */
const channelsOf = (member) => (member.userId ? ['in_app', 'push', 'email'] : ['email']);

/** M08 targets of a member notice: { userIds, external: [{ type: 'gym_member', id }] }. */
async function memberTargets(payload, kind = null) {
  const memberId = payload?.memberId;
  const m = memberId ? await GymMember.findByPk(memberId) : null;
  if (!m || m.status === 'removed') return NONE;
  if (await skipReason(m, kind, { sms: Boolean(payload?.sms?.billingRef) })) return NONE;
  return m.userId ? { userIds: [m.userId], external: [], skip: null } : { userIds: [], external: [{ type: 'gym_member', id: m.id }], skip: null };
}

/** The channels a notice reaches a member by: the usual ones, plus sms when the units are held. */
const reachOf = (member, sms) => [...(member.userId || member.emailEnc ? channelsOf(member) : []), ...(sms ? ['sms'] : [])];

/**
 * Hold SMS units for a notice whose send-once row was just claimed (prompt 3b): the reservation points at
 * the row, which keeps the billingRef. → { billingRef } or null.
 */
async function holdSms(transaction, { plan, gym, reminderId }) {
  if (!plan?.ok || !reminderId) return null;
  const billingRef = await require('./sms.service').reserveIn(transaction, { ownerId: gym.ownerId, gymId: gym.id, reminderId, balance: plan.balance });
  await GymReminder.update({ smsBillingRef: billingRef }, { where: { id: reminderId }, transaction });
  return { billingRef };
}

/** Can this notice go by SMS (prompt 3b)? Only asked for the kinds that may: { ok, reason, balance }. */
const smsPlan = (transaction, { kind, gym, explicit = false }) => require('./sms.service').planIn(transaction, { ownerId: gym.ownerId, gymId: gym.id, kind, explicit });

/**
 * Log an immediate member notice (receipt, payment link) once, inside the caller's transaction:
 * published when it will go out, skipped with the reason otherwise (the reminders page, FR-61). With
 * `sms` (prompt 3b) the units are held when the add-on allows it; `explicit` when the staff chose SMS
 * for this one message (a payment link). → { notify, sms: { billingRef } | null }.
 */
async function logImmediate(transaction, { kind, member, gym, subjectType, subjectId, offsetKey = 'now', sms = false, explicit = false }) {
  const plan = sms ? await smsPlan(transaction, { kind, gym, explicit }) : null;
  const reason = await skipReason(member, kind, { transaction, sms: Boolean(plan?.ok) });
  const reminderId = await c.claimReminderId(transaction, {
    ownerId: gym.ownerId,
    gymId: gym.id,
    kind,
    subjectType,
    subjectId,
    offsetKey,
    memberId: member.id,
    channels: reason ? [] : reachOf(member, plan?.ok),
    status: reason ? 'skipped' : 'published',
    skipReason: reason,
  });
  return { notify: !reason, sms: reason ? null : await holdSms(transaction, { plan, gym, reminderId }) };
}

/**
 * The M08 recipient adapter `gym_member` (registered at boot): an unlinked, non-removed member's email
 * and phone from the gym's record, in the owner's language. A linked member is reached by user id instead.
 */
async function resolveMember(memberId) {
  const m = await GymMember.findByPk(memberId, { attributes: ['id', 'ownerId', 'status', 'userId', 'emailEnc', 'phoneEnc'] });
  if (!m || m.status === 'removed' || m.userId) return null;
  const owner = (await directory.contactFor([m.ownerId])).get(m.ownerId);
  // Prompt 3b: the phone too, for an SMS paid from the owner's units (M08 sends SMS only with a billingRef).
  return { email: m.emailEnc ? c.dec(m.emailEnc) : null, phone: m.phoneEnc ? c.dec(m.phoneEnc) : null, locale: owner?.locale ?? 'en' };
}

function registerRecipientAdapter() {
  require('../notifications').recipients.register('gym_member', { resolve: resolveMember });
}

module.exports = { skipReason, channelsOf, reachOf, holdSms, smsPlan, memberTargets, logImmediate, resolveMember, registerRecipientAdapter };
