'use strict';

/**
 * M24 member notices (§11.1, M24-FR-55 to FR-57): who receives a notice about a member, decided when
 * M08 routes it (through the gym-manage facade) and when the "sent once" log row is written.
 *  - Member notices need the owner's `reminders` feature (Basic and up) and a subscription that is not
 *    restricted (FR-08: reminders pause); a kind the owner switched off sends nothing (FR-55).
 *  - A linked member is reached by user id (in-app, push and the account's email); an unlinked member
 *    with an email in the gym's record by email only, through the M08 recipient adapter `gym_member`
 *    (no address in any event, FR-108). SMS needs the paid add-on (prompt 3b): never sent here.
 *  - The adapter resolves { email, locale } in memory; the locale is the gym owner's.
 */
const { GymMember } = require('../../models');
const directory = require('../users').directory;
const gymFacade = require('../gym').gyms;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');

const NONE = Object.freeze({ userIds: [], external: [], skip: null });

/**
 * Why a member notice of `kind` (null: a notice with no on/off switch) is not sent for this member, or
 * null: tier, restricted, off, no_contact (§7.2 gym_reminders.skip_reason).
 */
async function skipReason(member, kind, { transaction } = {}) {
  const gym = await gymFacade.get(member.gymId, { transaction });
  if (!gym) return 'off';
  const sub = await c.subscriptionOf(gym.ownerId, { transaction });
  if (!rules.hasFeature(sub.chosenTier, 'reminders', c.tierCfg().featureMinTiers)) return 'tier';
  if (sub.status === 'restricted') return 'restricted';
  if (kind) {
    const s = await c.settingsOf(member.gymId, { transaction });
    if ((s?.remindersOff ?? []).includes(kind)) return 'off';
  }
  if (!member.userId && !member.emailEnc) return 'no_contact';
  return null;
}

/** The channels a reachable member gets (the log's `channels`): linked → in-app, push, email; unlinked → email. */
const channelsOf = (member) => (member.userId ? ['in_app', 'push', 'email'] : ['email']);

/** M08 targets of a member notice: { userIds, external: [{ type: 'gym_member', id }] }. */
async function memberTargets({ memberId }, kind = null) {
  const m = memberId ? await GymMember.findByPk(memberId) : null;
  if (!m || m.status === 'removed') return NONE;
  if (await skipReason(m, kind)) return NONE;
  return m.userId ? { userIds: [m.userId], external: [], skip: null } : { userIds: [], external: [{ type: 'gym_member', id: m.id }], skip: null };
}

/**
 * Log an immediate member notice (receipt, payment link) once, inside the caller's transaction:
 * published when it will go out, skipped with the reason otherwise (the reminders page, FR-61).
 */
async function logImmediate(transaction, { kind, member, gym, subjectType, subjectId, offsetKey = 'now' }) {
  const reason = await skipReason(member, kind, { transaction });
  await c.claimReminder(transaction, {
    ownerId: gym.ownerId,
    gymId: gym.id,
    kind,
    subjectType,
    subjectId,
    offsetKey,
    memberId: member.id,
    channels: reason ? [] : channelsOf(member),
    status: reason ? 'skipped' : 'published',
    skipReason: reason,
  });
  return !reason;
}

/**
 * The M08 recipient adapter `gym_member` (registered at boot): an unlinked, non-removed member's email
 * from the gym's record, in the owner's language. A linked member is reached by user id instead.
 */
async function resolveMember(memberId) {
  const m = await GymMember.findByPk(memberId, { attributes: ['id', 'ownerId', 'status', 'userId', 'emailEnc'] });
  if (!m || m.status === 'removed' || m.userId || !m.emailEnc) return null;
  const owner = (await directory.contactFor([m.ownerId])).get(m.ownerId);
  return { email: c.dec(m.emailEnc), locale: owner?.locale ?? 'en' };
}

function registerRecipientAdapter() {
  require('../notifications').recipients.register('gym_member', { resolve: resolveMember });
}

module.exports = { skipReason, channelsOf, memberTargets, logImmediate, resolveMember, registerRecipientAdapter };
