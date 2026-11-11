'use strict';

/**
 * M24 gyms in the panel (§9.2): my gyms (owner) and workplaces (staff) with the tier, features and
 * restriction state; the dashboard tiles (FR-70: money only for the owner and reports.view); the gym's
 * settings (owner only; the short code is the first setup step and creates the settings row, FR-09).
 * gym-manage never writes M20 tables: the gyms come from the gym facade.
 */
const { Op, QueryTypes, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, GymManageSettings, GymMember, GymMembership, GymPaymentLink, GymImport, GymFeePayment } = require('../../models');
const settingsFacade = require('../settings').settings;
const gymFacade = require('../gym').gyms;
const packagesFacade = require('../gym').packages;
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
/** Members whose running membership ends within gym_manage.expiring_list_days and who have not renewed (M27-FR-32). */
async function expiringSoon(gymId, today) {
  const rows = await sequelize.query(
    `SELECT m.id AS "memberId", m.member_code AS "memberCode", m.display_name AS "displayName", m.phone_last4 AS "phoneLast4", ms.ends_on AS "endsOn",
            (m.user_id IS NOT NULL) AS linked
       FROM gym_memberships ms JOIN gym_members m ON m.id = ms.member_id
      WHERE ms.gym_id = :gymId AND ms.status IN ('active', 'frozen') AND ms.ends_on BETWEEN :today AND :until AND m.status NOT IN ('left', 'removed')
        AND NOT EXISTS (SELECT 1 FROM gym_memberships up WHERE up.member_id = ms.member_id AND up.status = 'upcoming')
      ORDER BY ms.ends_on ASC, m.display_name ASC LIMIT 50`,
    { replacements: { gymId, today, until: rules.addDays(today, c.cfg().expiringListDays) }, type: QueryTypes.SELECT }
  );
  return rows.map((r) => ({ ...r, daysLeft: rules.daysBetween(today, r.endsOn) }));
}

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
       (SELECT COUNT(*) FROM gym_link_requests WHERE gym_id = :gymId AND status = 'pending' AND direction = 'join_request')::int AS "requestsWaiting",
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
    inGymNow: await require('./visits.service').inGymNow(gymId),
    notSeen: row.notSeen,
    notSeenDays: absent,
    requestsWaiting: row.requestsWaiting,
    dueTodayCount: row.dueTodayCount,
    overdueCount: row.overdueCount,
    // M24 trial visits: today's booked and attended guests, when the plan has visits.
    ...((await require('./ops.service').featureOn(gymId, 'visits')) ? { guestsToday: await require('./guests.service').todayCount(gymId) } : {}),
    // FR-70: the money tiles only for the owner and reports.view.
    ...(money ? { collectedTodayPoisha: Number(row.collectedTodayPoisha), dueTodayPoisha: Number(row.dueTodayPoisha) } : {}),
  };
  // M27-FR-32: who ends soon (for the call and WhatsApp buttons) and the membership mix.
  const expiring = a.can('members.view') ? await expiringSoon(gymId, today) : [];
  const [mix] = await sequelize.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active, COUNT(*) FILTER (WHERE status = 'frozen')::int AS frozen,
            COUNT(*) FILTER (WHERE status = 'expired')::int AS expired, COUNT(*) FILTER (WHERE status = 'new')::int AS "new",
            COUNT(*) FILTER (WHERE status = 'left')::int AS "left"
       FROM gym_members WHERE gym_id = :gymId AND status <> 'removed'`,
    { replacements: { gymId }, type: QueryTypes.SELECT }
  );
  return c.shown(a, { gymId, date: today, setupDone: Boolean(s), ...(await planOf(a.gym.ownerId)), tiles, expiring, mix });
}

/**
 * GET /manage/gyms/:gymId/packages (members.view): the active packages sold at the desk (channel desk or
 * both), so staff can add members and assign or change memberships without the owner's listing editor
 * (M24-FR-25). Prices are the gym's own, not a staff-hidden fee.
 */
async function packages(principal, gymId) {
  const a = await c.gymAccess(principal, gymId, 'members.view');
  const items = (await packagesFacade.forGym(gymId)).filter((p) => p.channel !== 'online');
  return c.shown(a, { items });
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
    vatEnabled: s?.vatEnabled ?? false,
    vatBps: s?.vatBps ?? null,
    vatMaxBps: c.cfg().vatMaxBps,
    // Trial visits (9 Nov 2026).
    visitsOpen: s?.visitsOpen ?? false,
    visitDailyCap: s?.visitDailyCap ?? null,
    visitDailyCapDefault: settingsFacade.get('gym_manage.visit_daily_cap_default'),
    visitDailyCapMax: settingsFacade.get('gym_manage.visit_daily_cap_max'),
    visitPerPerson: s?.visitPerPerson ?? 1,
    visitPerPersonMax: settingsFacade.get('gym_manage.visit_per_person_max'),
    visitNote: s?.visitNote ?? null,
    // M24-FR-121: members renew by themselves unless the gym switches it off.
    selfRenewOpen: s?.selfRenewOpen ?? true,
    selfRenewDaysBefore: c.cfg().selfRenewDaysBefore,
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
  // M27-FR-28: a VAT rate within gym_manage.vat_max_bps; VAT on needs a rate.
  if (input.vatBps !== undefined && input.vatBps !== null && input.vatBps > c.cfg().vatMaxBps) {
    throw E.validation([{ field: 'vatBps', message: `At most ${c.cfg().vatMaxBps}` }]);
  }
  // Prompt 3b (M24-FR-97): the kinds that go by SMS can be chosen only while the SMS add-on is active.
  if (input.smsKinds?.length && (await require('./sms.service').liveAddon(a.gym.ownerId))?.status !== 'active') throw c.fail('GYM_SMS_ADDON_OFF');
  // Trial visits: the cap and the per-person limit within the platform maximums.
  const capMax = settingsFacade.get('gym_manage.visit_daily_cap_max');
  if (input.visitDailyCap !== undefined && input.visitDailyCap !== null && input.visitDailyCap > capMax) throw E.validation([{ field: 'visitDailyCap', message: `At most ${capMax}` }]);
  const perMax = settingsFacade.get('gym_manage.visit_per_person_max');
  if (input.visitPerPerson !== undefined && input.visitPerPerson > perMax) throw E.validation([{ field: 'visitPerPerson', message: `At most ${perMax}` }]);
  try {
    await sequelize.transaction(async (transaction) => {
      const s = await c.settingsOf(gymId, { transaction, lock: true });
      const fields = ['shortCode', 'tin', 'bin', 'receiptFooter', 'entryPolicy', 'absentAlertDays', 'joinRequestsOpen', 'remindersOff', 'smsKinds', 'vatEnabled', 'vatBps', 'visitsOpen', 'visitDailyCap', 'visitPerPerson', 'visitNote', 'selfRenewOpen'].filter((k) => input[k] !== undefined);
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

/** M08 facts: a member's code and link state (never the name or phone). */
async function memberFacts(memberId) {
  const m = memberId ? await GymMember.findByPk(memberId, { attributes: ['memberCode', 'gymId', 'userId'] }) : null;
  return m ? { memberCode: m.memberCode, gymId: m.gymId, userId: m.userId ?? null } : null;
}

/** M08 facts: the public /p/ URL of a payment link (M24 §11.2 {{link}}), or null. */
async function payLinkUrl(linkId) {
  const l = linkId ? await GymPaymentLink.findByPk(linkId) : null;
  return l ? require('./links-pay.service').urlOf(l) : null;
}

/** M08 facts (prompt 3b): the short link of a payment link, for an SMS. */
async function payLinkShortUrl(linkId) {
  const l = linkId ? await GymPaymentLink.findByPk(linkId) : null;
  return l ? require('./links-pay.service').shortUrlOf(l) : null;
}

/** M08 facts: a membership's package title and kind. */
async function membershipFacts(membershipId) {
  const ms = membershipId ? await GymMembership.findByPk(membershipId, { attributes: ['title', 'packageKind'] }) : null;
  return ms ? { title: ms.title, packageKind: ms.packageKind } : null;
}

/** M08 facts: an import's owner and who uploaded it (GYM_IMPORT_READY goes to the owner for staff uploads). */
async function importFacts(importId) {
  const i = importId ? await GymImport.findByPk(importId, { attributes: ['ownerId', 'uploadedAs'] }) : null;
  return i ? { ownerId: i.ownerId, uploadedAs: i.uploadedAs } : null;
}

/** M08 facts: the receipt a reversal row corrected (its number and signed link). */
async function reversedReceipt(reversalId) {
  const r = reversalId ? await GymFeePayment.findByPk(reversalId, { attributes: ['reversesId'] }) : null;
  const o = r?.reversesId ? await GymFeePayment.findByPk(r.reversesId, { attributes: ['id', 'receiptNo'] }) : null;
  return o ? { receiptNo: o.receiptNo, url: c.receiptUrlOf(o.id) } : null;
}

module.exports = { planOf, listMine, overview, packages, settingsView, getSettings, patchSettings, memberFacts, membershipFacts, payLinkUrl, payLinkShortUrl, importFacts, reversedReceipt };
