'use strict';

/**
 * M24 gyms in the panel (§9.2): my gyms (owner) and workplaces (staff) with the tier, features and
 * restriction state; the dashboard tiles (FR-70: money only for the owner and reports.view); the gym's
 * settings (owner only; the short code is the first setup step and creates the settings row, FR-09).
 * gym-manage never writes M20 tables: the gyms come from the gym facade.
 */
const { Op, QueryTypes, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, GymManageSettings, GymMember } = require('../../models');
const settingsFacade = require('../settings').settings;
const gymFacade = require('../gym').gyms;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');

const { fail } = c;

/** The plan context of an owner: tier, features, restriction (for the upsell and restricted banner). */
async function planOf(ownerId) {
  const sub = await c.subscriptionOf(ownerId);
  return { tier: sub.chosenTier, features: rules.featuresOf(sub.chosenTier, c.tierCfg().featureMinTiers), restricted: sub.status === 'restricted', subscriptionStatus: sub.status };
}

async function todayCounts(gymIds, today) {
  if (!gymIds.length) return new Map();
  const rows = await sequelize.query(
    `SELECT g.id AS "gymId",
            (SELECT COUNT(*) FROM gym_attendance a WHERE a.gym_id = g.id AND a.local_date = :today AND a.counted)::int AS "checkIns",
            (SELECT COUNT(*) FROM gym_members m WHERE m.gym_id = g.id AND m.status IN ('active', 'frozen'))::int AS "activeMembers"
       FROM unnest(ARRAY[:ids]::uuid[]) AS g(id)`,
    { replacements: { ids: gymIds, today }, type: QueryTypes.SELECT }
  );
  return new Map(rows.map((r) => [r.gymId, { checkIns: r.checkIns, activeMembers: r.activeMembers }]));
}

/** GET /manage/gyms (gate work_gym): the gyms I own and the gyms I work at. */
async function listMine(principal) {
  const today = c.today();
  const owned = await gymFacade.ofOwner(principal.id);
  if (owned.length) await c.ensureSubscription(principal.id);
  const work = (principal.workplaces ?? []).filter((w) => w.businessType === 'gym');
  const staffGyms = [];
  for (const w of work) {
    const g = await gymFacade.get(w.businessId);
    if (g && g.ownerId === w.ownerId && !owned.some((o) => o.id === g.id)) staffGyms.push({ g, w });
  }
  const all = [...owned.map((g) => ({ g, w: null })), ...staffGyms];
  const ids = all.map((x) => x.g.id);
  const [settings, counts] = await Promise.all([GymManageSettings.findAll({ where: { gymId: ids } }), todayCounts(ids, today)]);
  const plans = new Map();
  for (const { g } of all) if (!plans.has(g.ownerId)) plans.set(g.ownerId, await planOf(g.ownerId));
  const items = all.map(({ g, w }) => {
    const s = settings.find((x) => x.gymId === g.id);
    return {
      id: g.id,
      name: g.name,
      slug: g.slug,
      listingStatus: g.status,
      role: w ? 'staff' : 'owner',
      permissions: w ? [...w.permissions].sort() : null,
      shortCode: s?.shortCode ?? null,
      setupDone: Boolean(s),
      today: counts.get(g.id) ?? { checkIns: 0, activeMembers: 0 },
      ...plans.get(g.ownerId),
    };
  });
  return { items, owner: owned.length ? await planOf(principal.id) : null };
}

/** GET /manage/gyms/:gymId/overview (any staff of the gym): the dashboard tiles (FR-70). */
async function overview(principal, gymId) {
  const a = await c.gymAccess(principal, gymId, null);
  const today = c.today();
  const s = await c.settingsOf(gymId);
  const absent = s?.absentAlertDays ?? c.cfg().absentAlertDays;
  const [row] = await sequelize.query(
    `SELECT
       (SELECT COUNT(*) FROM gym_attendance WHERE gym_id = :gymId AND local_date = :today AND counted)::int AS "checkInsToday",
       (SELECT COUNT(*) FROM gym_members WHERE gym_id = :gymId AND status IN ('active', 'frozen'))::int AS "activeMembers",
       (SELECT COUNT(*) FROM gym_members WHERE gym_id = :gymId AND status <> 'removed')::int AS "members",
       (SELECT COUNT(*) FROM gym_members WHERE gym_id = :gymId AND status <> 'removed' AND joined_on >= :monthStart)::int AS "newThisMonth",
       (SELECT COUNT(*) FROM gym_memberships ms WHERE ms.gym_id = :gymId AND ms.status IN ('active', 'frozen') AND ms.ends_on BETWEEN :today AND :weekEnd
           AND NOT EXISTS (SELECT 1 FROM gym_memberships up WHERE up.member_id = ms.member_id AND up.status = 'upcoming'))::int AS "expiringThisWeek",
       (SELECT COUNT(*) FROM gym_members m WHERE m.gym_id = :gymId AND m.status = 'active'
           AND EXISTS (SELECT 1 FROM gym_memberships cm WHERE cm.member_id = m.id AND cm.status = 'active' AND cm.starts_on <= :seenSince)
           AND NOT EXISTS (SELECT 1 FROM gym_attendance a WHERE a.member_id = m.id AND a.counted AND a.local_date > :seenSince))::int AS "notSeen",
       (SELECT COUNT(*) FROM gym_link_requests WHERE gym_id = :gymId AND status = 'pending')::int AS "requestsWaiting",
       (SELECT COUNT(*) FROM gym_dues WHERE gym_id = :gymId AND status IN ('unpaid', 'partial') AND due_on = :today)::int AS "dueTodayCount",
       (SELECT COALESCE(SUM(amount_poisha - paid_poisha - waived_poisha), 0) FROM gym_dues WHERE gym_id = :gymId AND status IN ('unpaid', 'partial') AND due_on = :today)::bigint AS "dueTodayPoisha",
       (SELECT COUNT(*) FROM gym_dues WHERE gym_id = :gymId AND status IN ('unpaid', 'partial') AND due_on < :today)::int AS "overdueCount",
       (SELECT COALESCE(SUM(amount_poisha), 0) FROM gym_fee_payments WHERE gym_id = :gymId AND paid_on = :today AND method NOT IN ('opening'))::bigint AS "collectedTodayPoisha"`,
    { replacements: { gymId, today, monthStart: rules.firstOfMonth(today), weekEnd: rules.addDays(today, rules.EXPIRING_DAYS), seenSince: rules.addDays(today, -absent) }, type: QueryTypes.SELECT }
  );
  const money = a.owner || a.can('reports.view');
  const tiles = {
    checkInsToday: row.checkInsToday,
    activeMembers: row.activeMembers,
    members: row.members,
    newThisMonth: row.newThisMonth,
    expiringThisWeek: row.expiringThisWeek,
    notSeen: row.notSeen,
    notSeenDays: absent,
    requestsWaiting: row.requestsWaiting,
    dueTodayCount: row.dueTodayCount,
    overdueCount: row.overdueCount,
    // FR-70: the money tiles only for the owner and reports.view.
    ...(money ? { collectedTodayPoisha: Number(row.collectedTodayPoisha), dueTodayPoisha: Number(row.dueTodayPoisha) } : {}),
  };
  return c.shown(a, { gymId, date: today, setupDone: Boolean(s), ...(await planOf(a.gym.ownerId)), tiles });
}

/** The settings as the owner sees them (defaults before the first setup step). */
function settingsView(gym, s) {
  return {
    gymId: gym.id,
    setupDone: Boolean(s),
    shortCode: s?.shortCode ?? null,
    tin: s?.tin ?? null,
    bin: s?.bin ?? null,
    receiptFooter: s?.receiptFooter ?? null,
    entryPolicy: s?.entryPolicy ?? c.cfg().entryPolicyDefault,
    absentAlertDays: s?.absentAlertDays ?? null,
    absentAlertDaysDefault: c.cfg().absentAlertDays,
    joinRequestsOpen: s?.joinRequestsOpen ?? true,
    remindersOff: s?.remindersOff ?? [],
    smsKinds: s?.smsKinds ?? [],
    importConsentUntil: c.iso(s?.importConsentUntil),
    nextMemberCode: s ? rules.memberCode(s.shortCode, s.memberSeq + 1) : null,
  };
}

/** GET /manage/gyms/:gymId/settings (owner). */
async function getSettings(principal, gymId) {
  const a = await c.gymAccess(principal, gymId, 'owner.only');
  return settingsView(a.gym, await c.settingsOf(gymId));
}

/**
 * PATCH /manage/gyms/:gymId/settings (owner; refused while restricted): the first call must carry the
 * short code (2–6 capital letters, unique among the owner's gyms) and creates the row (FR-09).
 */
async function patchSettings(principal, gymId, input, req) {
  const a = await c.gymAccess(principal, gymId, 'owner.only', { restricted: true });
  if (input.absentAlertDays !== undefined && input.absentAlertDays !== null) {
    // Within the bounds of gym_manage.absent_alert_days (each gym picks, §6.12).
    const { minValue: min, maxValue: max } = settingsFacade.definition('gym_manage.absent_alert_days');
    if (input.absentAlertDays < min || input.absentAlertDays > max) throw E.validation([{ field: 'absentAlertDays', message: `Between ${min} and ${max}` }]);
  }
  try {
    await sequelize.transaction(async (transaction) => {
      const s = await c.settingsOf(gymId, { transaction, lock: true });
      const fields = ['shortCode', 'tin', 'bin', 'receiptFooter', 'entryPolicy', 'absentAlertDays', 'joinRequestsOpen', 'remindersOff', 'smsKinds'].filter((k) => input[k] !== undefined);
      const changes = Object.fromEntries(fields.map((k) => [k, input[k]]));
      if (changes.shortCode) {
        const taken = await GymManageSettings.findOne({ where: { ownerId: a.gym.ownerId, shortCode: changes.shortCode, gymId: { [Op.ne]: gymId } }, attributes: ['gymId'], transaction });
        if (taken) throw fail('GYM_SHORT_CODE_TAKEN');
      }
      if (!s) {
        if (!changes.shortCode) throw fail('GYM_SETUP_REQUIRED', { step: 'short_code' });
        await GymManageSettings.create(
          { gymId, ownerId: a.gym.ownerId, receiptYear: rules.yearOf(c.today()), entryPolicy: c.cfg().entryPolicyDefault, ...changes, updatedBy: principal.id },
          { transaction }
        );
      } else if (fields.length) {
        await s.update({ ...changes, updatedBy: principal.id }, { transaction });
      }
      await c.record({ action: 'gym_manage.settings_changed', actor: a.actor, entityType: 'gym', entityId: gymId, after: { ...changes, ...(changes.tin ? { tin: 'set' } : {}) }, meta: { created: !s }, req }, transaction);
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw fail('GYM_SHORT_CODE_TAKEN');
    throw err;
  }
  return settingsView(a.gym, await c.settingsOf(gymId));
}

/** M08 facts: a member's code (never the name or phone). */
async function memberFacts(memberId) {
  const m = memberId ? await GymMember.findByPk(memberId, { attributes: ['memberCode', 'gymId'] }) : null;
  return m ? { memberCode: m.memberCode, gymId: m.gymId } : null;
}

module.exports = { planOf, listMine, overview, settingsView, getSettings, patchSettings, memberFacts };
