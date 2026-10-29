'use strict';

/**
 * M24 workout plans and diet charts (§5.8 FR-62 to FR-69, §6.10, §8.8; feature `plans`, Standard and up).
 *  - Writing (plans.manage): create, edit, retire, template flag. Content is checked by the zod schema
 *    (gym-manage.schemas PlanContent, hard ceilings) and here against the live settings
 *    (gym_manage.plan_max_items, diet_max_meals; refs unique) and the 64 KiB ceiling of §7.2. Every
 *    content edit is version n + 1 (gym_plan_versions is append-only); "update for the N members who
 *    have it" (default on) moves their active assignments to it and tells them once (GYM_PLAN_UPDATED).
 *  - Assigning (plans.manage) to members the caller can see (members.view or the owner: all;
 *    members.trainer: their assigned members), else 403 GYM_PLAN_ASSIGN_SCOPE. One active workout plan
 *    and one active diet chart per member (partial unique index): a new one replaces the old.
 *  - GET …/members/:memberId/plans: anyone who can see the member gets the titles; plans.manage and the
 *    owner also get the content, the ticks and notes, and the member's health note (M24-FR-66).
 *  - The member: today's workout by the §6.10 day mapping and today's meals, then the week; ticks and a
 *    note for today and up to gym_manage.plan_log_back_days back (422 GYM_PLAN_LOG_WINDOW), the latest
 *    tick per item and date wins. After leaving or unlinking, ended or replaced: read-only (FR-67).
 *  - Assignments end on their end date (gym-manage.daily), when staff end them, or when the member is
 *    removed; edits and new plans pause when the tier drops, members keep reading (§12.18).
 * Every change is audited; events carry ids only (gym_plan.assigned / .updated / .ended).
 */
const { Op, QueryTypes } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, GymMember, GymPlan, GymPlanVersion, GymPlanAssignment, GymPlanLog } = require('../../models');
const directory = require('../users').directory;
const gymFacade = require('../gym').gyms;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');
const view = require('./gym-manage.serializer');
const notices = require('./notices.service');
const members = require('./members.service');

const { fail } = c;
// §7.2 chk_gym_plan_versions: a storage ceiling of the table, not a business number.
const CONTENT_MAX_BYTES = 65536;
// The plan page's adherence column: items ticked done in the last 7 days.
const ADHERENCE_DAYS = 7;
const me = () => require('./me.service');

/** M24-FR-62: the live limits and the 64 KiB ceiling → 422 VALIDATION_FAILED with paths. Returns the size. */
function checkContent(content) {
  const cfg = c.cfg();
  const errors = rules.planContentErrors(content, { maxItems: cfg.planMaxItems, maxMeals: cfg.dietMaxMeals });
  const bytes = Buffer.byteLength(JSON.stringify(content));
  if (bytes > CONTENT_MAX_BYTES) errors.push({ field: 'content', message: 'The plan is too long' });
  if (errors.length) throw E.validation(errors);
  return bytes;
}

/** plans.manage at this gym (the owner always passes); writing needs the plans feature and no restriction. */
const planAccess = (principal, gymId, { write = false } = {}) => c.gymAccess(principal, gymId, 'plans.manage', write ? { feature: 'plans', restricted: true } : {});

/** May this caller see the member? The owner and members.view: all; a trainer-only caller: their assigned members (FR-64). */
const seesMember = (a, m) => a.owner || a.can('members.view') || (a.trainerScope != null && m.trainerBusinessMemberId === a.trainerScope);

async function planOf(gymId, planId, { transaction, lock = false } = {}) {
  const p = await GymPlan.findOne({ where: { id: planId, gymId, source: 'gym' }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!p) throw E.notFound('Plan');
  return p;
}

const planPayload = (asg, { version, member }) => ({ assignmentId: asg.id, planId: asg.planId, version, kind: asg.kind, memberId: asg.memberId, gymId: asg.gymId, userId: member?.userId ?? null });

/** Active assignments per plan. */
async function activeCounts(planIds) {
  if (!planIds.length) return new Map();
  const rows = await sequelize.query(`SELECT plan_id AS id, COUNT(*)::int AS n FROM gym_plan_assignments WHERE plan_id IN (:planIds) AND status = 'active' GROUP BY plan_id`, { replacements: { planIds }, type: QueryTypes.SELECT });
  return new Map(rows.map((r) => [r.id, r.n]));
}

/** The last tick date and the items ticked done in the last ADHERENCE_DAYS (latest tick per item and date). */
async function adherenceOf(assignmentIds, today) {
  if (!assignmentIds.length) return new Map();
  const rows = await sequelize.query(
    `SELECT x.assignment_id AS id, MAX(x.local_date) AS last, (COUNT(*) FILTER (WHERE x.done AND x.local_date > :since))::int AS done
       FROM (SELECT DISTINCT ON (assignment_id, local_date, item_ref) assignment_id, local_date, done
               FROM gym_plan_logs WHERE assignment_id IN (:ids)
              ORDER BY assignment_id, local_date, item_ref, created_at DESC, id DESC) x
      GROUP BY x.assignment_id`,
    { replacements: { ids: assignmentIds, since: rules.addDays(today, -ADHERENCE_DAYS) }, type: QueryTypes.SELECT }
  );
  return new Map(rows.map((r) => [r.id, { last: r.last, done: r.done }]));
}

/** The plan page: the plan, its current content, every version, and the active assignments the caller can see with adherence. */
async function detailOf(a, p, extra = {}) {
  const versions = await GymPlanVersion.findAll({ where: { planId: p.id }, order: [['version', 'DESC']] });
  const names = await directory.displayNames(versions.map((v) => v.createdBy));
  const active = await GymPlanAssignment.findAll({ where: { planId: p.id, status: 'active' }, order: [['createdAt', 'ASC']], limit: 500 });
  const ms = new Map((await GymMember.findAll({ where: { id: active.map((x) => x.memberId) } })).map((m) => [m.id, m]));
  const visible = active.filter((x) => ms.get(x.memberId) && seesMember(a, ms.get(x.memberId)));
  const adherence = await adherenceOf(visible.map((x) => x.id), c.today());
  const byId = new Map(versions.map((v) => [v.id, v]));
  return {
    ...view.planView(p, { activeAssignments: active.length }),
    content: versions.find((v) => v.version === p.currentVersion).content,
    versions: versions.map((v) => view.versionView(v, names)),
    assignments: visible.map((x) => ({
      ...view.assignmentView(x, { plan: p, version: byId.get(x.planVersionId) }),
      member: view.memberSummary(ms.get(x.memberId)),
      lastTickOn: adherence.get(x.id)?.last ?? null,
      doneLast7Days: adherence.get(x.id)?.done ?? 0,
    })),
    ...extra,
  };
}

// ---------------------------------------------------------------- writing (FR-62, FR-63, FR-68)

/** GET /manage/gyms/:gymId/plans?kind&status&template (plans.manage, feature plans). */
async function list(principal, gymId, { kind, status, template } = {}) {
  await c.gymAccess(principal, gymId, 'plans.manage', { feature: 'plans' });
  const rows = await GymPlan.findAll({
    where: { gymId, source: 'gym', status: status ?? 'active', ...(kind ? { kind } : {}), ...(template !== undefined ? { isTemplate: template } : {}) },
    order: [['updatedAt', 'DESC'], ['id', 'ASC']],
    limit: 500,
  });
  const n = await activeCounts(rows.map((p) => p.id));
  return { items: rows.map((p) => view.planView(p, { activeAssignments: n.get(p.id) ?? 0 })) };
}

/** POST /manage/gyms/:gymId/plans { kind, title, isTemplate, source, content } (plans.manage, feature plans, refused while restricted). */
async function create(principal, gymId, body, req) {
  const a = await planAccess(principal, gymId, { write: true });
  const bytes = checkContent(body.content);
  const p = await sequelize.transaction(async (transaction) => {
    const row = await GymPlan.create({ gymId, kind: body.kind, title: body.title, isTemplate: body.isTemplate, source: 'gym', currentVersion: 1, status: 'active', createdBy: principal.id, updatedBy: principal.id }, { transaction });
    await GymPlanVersion.create({ planId: row.id, version: 1, content: body.content, contentBytes: bytes, createdBy: principal.id }, { transaction });
    await c.record({ action: 'gym_plan.created', actor: a.actor, entityType: 'gym_plan', entityId: row.id, after: { kind: row.kind, title: row.title, isTemplate: row.isTemplate, version: 1 }, meta: { gymId }, req }, transaction);
    return row;
  });
  return detailOf(a, p);
}

/** GET /manage/gyms/:gymId/plans/:planId (plans.manage): the plan with its versions and adherence. */
async function get(principal, gymId, planId) {
  const a = await planAccess(principal, gymId);
  return detailOf(a, await planOf(gymId, planId));
}

/**
 * Move the plan's active assignments to a new version (inside the edit's transaction); each member is
 * told once per version (GYM_PLAN_UPDATED, the reminders rules of kind `plan`). Returns how many moved.
 */
async function moveAssignmentsIn(transaction, { a, plan, version, previous }) {
  const rows = await GymPlanAssignment.findAll({ where: { planId: plan.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
  for (const asg of rows) {
    await asg.update({ planVersionId: version.id }, { transaction });
    const m = await GymMember.findByPk(asg.memberId, { transaction });
    await c.publish(transaction, 'gym_plan.updated', 'gym_plan_assignment', asg.id, { ...planPayload(asg, { version: version.version, member: m }), previousVersion: previous }, a.actor);
    await notices.logImmediate(transaction, { kind: 'plan', member: m, gym: a.gym, subjectType: 'assignment', subjectId: asg.id, offsetKey: `v${version.version}` });
  }
  return rows.length;
}

/** PATCH /manage/gyms/:gymId/plans/:planId { title?, isTemplate?, content?, applyToAssigned } (plans.manage, feature plans, refused while restricted; FR-63). */
async function update(principal, gymId, planId, body, req) {
  const a = await planAccess(principal, gymId, { write: true });
  const bytes = body.content ? checkContent(body.content) : null;
  const moved = await sequelize.transaction(async (transaction) => {
    const p = await planOf(gymId, planId, { transaction, lock: true });
    if (p.status !== 'active') throw fail('GYM_PLAN_STATE', { status: p.status });
    if (body.content && body.content.kind !== p.kind) throw E.validation([{ field: 'content.kind', message: 'The content must be of the plan’s kind' }]);
    const before = { kind: p.kind, title: p.title, isTemplate: p.isTemplate, version: p.currentVersion };
    const changes = { updatedBy: principal.id, ...(body.title !== undefined ? { title: body.title } : {}), ...(body.isTemplate !== undefined ? { isTemplate: body.isTemplate } : {}) };
    let n = 0;
    if (body.content) {
      const v = await GymPlanVersion.create({ planId: p.id, version: p.currentVersion + 1, content: body.content, contentBytes: bytes, createdBy: principal.id }, { transaction });
      await p.update({ ...changes, currentVersion: v.version }, { transaction });
      if (body.applyToAssigned) n = await moveAssignmentsIn(transaction, { a, plan: p, version: v, previous: before.version });
    } else await p.update(changes, { transaction });
    await c.record(
      { action: 'gym_plan.updated', actor: a.actor, entityType: 'gym_plan', entityId: p.id, before, after: { kind: p.kind, title: p.title, isTemplate: p.isTemplate, version: p.currentVersion, movedAssignments: n }, meta: { gymId }, req },
      transaction
    );
    return n;
  });
  return detailOf(a, await planOf(gymId, planId), { movedAssignments: moved });
}

/** POST /manage/gyms/:gymId/plans/:planId/retire (plans.manage): no new assignments; running ones keep going. */
async function retire(principal, gymId, planId, req) {
  const a = await planAccess(principal, gymId);
  await sequelize.transaction(async (transaction) => {
    const p = await planOf(gymId, planId, { transaction, lock: true });
    if (p.status !== 'active') throw fail('GYM_PLAN_STATE', { status: p.status });
    await p.update({ status: 'retired', retiredAt: new Date(), updatedBy: principal.id }, { transaction });
    await c.record({ action: 'gym_plan.retired', actor: a.actor, entityType: 'gym_plan', entityId: p.id, before: { kind: p.kind, title: p.title, status: 'active' }, after: { status: 'retired' }, meta: { gymId }, req }, transaction);
  });
  return detailOf(a, await planOf(gymId, planId));
}

// ---------------------------------------------------------------- assigning (FR-64, §8.8)

/** End an active assignment inside the caller's transaction (replaced, ended by staff, the end date, the member removed). */
async function endIn(transaction, { asg, status = 'ended', reason, member, actor = null, now = new Date() }) {
  await asg.update({ status, endedAt: now }, { transaction });
  const version = await GymPlanVersion.findByPk(asg.planVersionId, { attributes: ['version'], transaction });
  await c.publish(transaction, 'gym_plan.ended', 'gym_plan_assignment', asg.id, { ...planPayload(asg, { version: version.version, member }), reason }, actor);
}

/** POST /manage/gyms/:gymId/plans/:planId/assign { memberIds[], startsOn, endsOn? } (plans.manage, feature plans, refused while restricted). */
async function assign(principal, gymId, planId, { memberIds, startsOn, endsOn = null }, req) {
  const a = await planAccess(principal, gymId, { write: true });
  const now = new Date();
  const today = c.today(now);
  const cfg = c.cfg();
  if (!rules.inWindow({ date: startsOn, today, back: cfg.backdateDays, ahead: rules.ASSIGN_AHEAD_DAYS })) {
    throw fail('GYM_DATE_OUT_OF_RANGE', { from: rules.addDays(today, -cfg.backdateDays), to: rules.addDays(today, rules.ASSIGN_AHEAD_DAYS) });
  }
  const found = new Map((await GymMember.findAll({ where: { id: memberIds, gymId } })).map((m) => [m.id, m]));
  const outside = memberIds.filter((id) => !found.get(id) || found.get(id).status === 'removed' || !seesMember(a, found.get(id)));
  if (outside.length) throw fail('GYM_PLAN_ASSIGN_SCOPE', { memberIds: outside });
  const left = memberIds.filter((id) => found.get(id).status === 'left');
  if (left.length) throw fail('GYM_MEMBER_STATE', { reason: 'left', memberIds: left });
  const made = await sequelize.transaction(async (transaction) => {
    const p = await planOf(gymId, planId, { transaction, lock: true });
    if (p.status !== 'active') throw fail('GYM_PLAN_STATE', { status: p.status });
    const version = await GymPlanVersion.findOne({ where: { planId: p.id, version: p.currentVersion }, transaction });
    const out = [];
    let replaced = 0;
    for (const id of memberIds) {
      const m = await GymMember.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (['left', 'removed'].includes(m.status)) throw fail('GYM_MEMBER_STATE', { reason: m.status, memberIds: [m.id] });
      const old = await GymPlanAssignment.findOne({ where: { memberId: m.id, kind: p.kind, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
      if (old) {
        await endIn(transaction, { asg: old, status: 'replaced', reason: 'replaced', member: m, actor: a.actor, now });
        replaced += 1;
      }
      const asg = await GymPlanAssignment.create({ planId: p.id, planVersionId: version.id, kind: p.kind, memberId: m.id, gymId, startsOn, endsOn, status: 'active', assignedBy: principal.id }, { transaction });
      await c.publish(transaction, 'gym_plan.assigned', 'gym_plan_assignment', asg.id, planPayload(asg, { version: version.version, member: m }), a.actor);
      await notices.logImmediate(transaction, { kind: 'plan', member: m, gym: a.gym, subjectType: 'assignment', subjectId: asg.id, offsetKey: 'assigned' });
      await c.record(
        { action: 'gym_plan.assigned', actor: a.actor, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, after: { planId: p.id, kind: p.kind, title: p.title, version: version.version, startsOn, endsOn, replaced: Boolean(old) }, meta: { gymId, assignmentId: asg.id }, req },
        transaction
      );
      out.push(asg);
    }
    return { p, version, out, replaced };
  });
  return { assignments: made.out.map((x) => view.assignmentView(x, { plan: made.p, version: made.version })), replaced: made.replaced };
}

/** POST /manage/gyms/:gymId/plan-assignments/:assignmentId/end (plans.manage; a member the caller can see). */
async function end(principal, gymId, assignmentId, req) {
  const a = await planAccess(principal, gymId);
  const asg = await sequelize.transaction(async (transaction) => {
    const plain = await GymPlanAssignment.findOne({ where: { id: assignmentId, gymId }, attributes: ['id', 'memberId'], transaction });
    if (!plain) throw E.notFound('Assignment');
    const m = await GymMember.findByPk(plain.memberId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!seesMember(a, m)) throw E.notFound('Assignment');
    const row = await GymPlanAssignment.findByPk(plain.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (row.status !== 'active') throw fail('GYM_PLAN_STATE', { status: row.status });
    await endIn(transaction, { asg: row, reason: 'ended', member: m, actor: a.actor });
    await c.record({ action: 'gym_plan.ended', actor: a.actor, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, after: { assignmentId: row.id, status: 'ended' }, meta: { gymId }, req }, transaction);
    return row;
  });
  const [plan, version] = await Promise.all([GymPlan.findByPk(asg.planId), GymPlanVersion.findByPk(asg.planVersionId)]);
  return { assignment: view.assignmentView(asg, { plan, version }) };
}

/** A removed member's active plans end (members.removeIn, inside its transaction; §8.8). */
async function endForMemberIn(transaction, { member, reason, actor = null }) {
  const rows = await GymPlanAssignment.findAll({ where: { memberId: member.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
  for (const asg of rows) await endIn(transaction, { asg, reason, member, actor });
  return rows.length;
}

/** Job step (gym-manage.daily): active assignments past their end date → ended (status guard; a second run changes nothing). */
async function endDue(now = new Date(), batch = 500) {
  const today = c.today(now);
  let ended = 0;
  for (;;) {
    const n = await sequelize.transaction(async (transaction) => {
      const rows = await GymPlanAssignment.findAll({ where: { status: 'active', endsOn: { [Op.lt]: today } }, limit: batch, transaction, lock: transaction.LOCK.UPDATE, skipLocked: true });
      for (const asg of rows) await endIn(transaction, { asg, reason: 'end_date', member: await GymMember.findByPk(asg.memberId, { transaction }), now });
      return rows.length;
    });
    ended += n;
    if (n < batch) break;
  }
  return ended;
}

/**
 * GET /manage/gyms/:gymId/members/:memberId/plans (whoever can see the member): every assignment with its
 * title; plans.manage and the owner also get the content, the ticks and notes and the health note (FR-66).
 */
async function memberPlans(principal, gymId, memberId) {
  const a = await c.gymAccess(principal, gymId, null, { anyOf: members.SEE });
  const m = await members.visibleMember(a, memberId);
  const full = a.owner || a.can('plans.manage');
  const rows = await GymPlanAssignment.findAll({ where: { memberId: m.id }, order: [['createdAt', 'DESC']], limit: 100 });
  const [plans, versions] = await Promise.all([
    GymPlan.findAll({ where: { id: [...new Set(rows.map((x) => x.planId))] } }),
    GymPlanVersion.findAll({ where: { id: [...new Set(rows.map((x) => x.planVersionId))] } }),
  ]);
  const planById = new Map(plans.map((p) => [p.id, p]));
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const logs = full && rows.length ? await GymPlanLog.findAll({ where: { assignmentId: rows.map((x) => x.id) }, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: 5000 }) : [];
  return {
    memberId: m.id,
    ...(full ? { healthNote: c.dec(m.healthNoteEnc) } : {}),
    items: rows.map((x) => {
      const base = view.assignmentView(x, { plan: planById.get(x.planId), version: versionById.get(x.planVersionId) });
      if (!full) return base;
      return { ...base, content: versionById.get(x.planVersionId).content, logs: [...rules.latestLogs(logs.filter((l) => l.assignmentId === x.id)).values()].map(view.logView) };
    }),
  };
}

// ---------------------------------------------------------------- the member (FR-65, FR-67, FR-69)

/** Today's plan titles per member row (GET /me/gym-memberships). */
async function todayTitles(memberIds) {
  const out = new Map();
  if (!memberIds.length) return out;
  const rows = await GymPlanAssignment.findAll({ where: { memberId: memberIds, status: 'active' }, order: [['kind', 'DESC']] });
  const plans = new Map((await GymPlan.findAll({ where: { id: [...new Set(rows.map((x) => x.planId))] }, attributes: ['id', 'title'] })).map((p) => [p.id, p]));
  for (const x of rows) out.set(x.memberId, [...(out.get(x.memberId) ?? []), { assignmentId: x.id, kind: x.kind, title: plans.get(x.planId)?.title ?? '' }]);
  return out;
}

/** My assignments (current and past member rows) with what each needs to render. */
async function mine(principal, where = {}) {
  const { current, past } = await me().myMembers(principal);
  const all = [...current, ...past];
  if (!all.length) return { rows: [], current: new Map(), byMember: new Map() };
  const rows = await GymPlanAssignment.findAll({ where: { memberId: all.map((m) => m.id), ...where }, order: [['createdAt', 'DESC']], limit: 200 });
  return { rows, current: new Map(current.map((m) => [m.id, m])), byMember: new Map(all.map((m) => [m.id, m])) };
}

/** One of my assignments as the member area shows it (ticks for the days I can still tick). */
function myItem(x, { plan, version, member, linked, gym, today, backDays, logs }) {
  const content = version.content;
  const workout = content.kind === 'workout';
  const days = workout ? content.days.length : 1;
  // A diet chart is the same every day: one "day", index 0 while it runs.
  const todayIndex = rules.dayIndexFor({ date: today, startsOn: x.startsOn, endsOn: x.endsOn, days });
  const since = rules.addDays(today, -backDays);
  return {
    assignmentId: x.id,
    memberId: x.memberId,
    gym: gym ? { id: gym.id, name: gym.name, slug: gym.slug } : null,
    kind: x.kind,
    title: plan?.title ?? '',
    version: version.version,
    startsOn: x.startsOn,
    endsOn: x.endsOn ?? null,
    status: x.status,
    readOnly: rules.planReadOnly({ assignmentStatus: x.status, linked, memberStatus: member.status }),
    content,
    todayIndex,
    week: rules.weekOf({ today, startsOn: x.startsOn, endsOn: x.endsOn, days }),
    ticks: [...rules.latestLogs(logs.filter((l) => l.localDate >= since)).values()].map(view.logView),
    safety: view.safetyLine(gym?.name ?? ''),
  };
}

async function context(rows) {
  const [plans, versions] = await Promise.all([
    GymPlan.findAll({ where: { id: [...new Set(rows.map((x) => x.planId))] } }),
    GymPlanVersion.findAll({ where: { id: [...new Set(rows.map((x) => x.planVersionId))] } }),
  ]);
  const gyms = new Map();
  for (const x of rows) if (!gyms.has(x.gymId)) gyms.set(x.gymId, await gymFacade.get(x.gymId));
  return { plans: new Map(plans.map((p) => [p.id, p])), versions: new Map(versions.map((v) => [v.id, v])), gyms };
}

/** GET /me/gym-plans: today's workout and meals first (active plans), then the rest, each with the week (§6.10). */
async function myPlans(principal) {
  const today = c.today();
  const backDays = c.cfg().planLogBackDays;
  const { rows, current, byMember } = await mine(principal);
  if (!rows.length) return { today, logBackDays: backDays, items: [] };
  const ctx = await context(rows);
  const logs = await GymPlanLog.findAll({ where: { assignmentId: rows.filter((x) => x.status === 'active').map((x) => x.id), localDate: { [Op.gte]: rules.addDays(today, -backDays) } }, order: [['createdAt', 'DESC'], ['id', 'DESC']] });
  const items = [];
  for (const x of rows) {
    items.push(
      myItem(x, { plan: ctx.plans.get(x.planId), version: ctx.versions.get(x.planVersionId), member: byMember.get(x.memberId), linked: current.has(x.memberId), gym: ctx.gyms.get(x.gymId), today, backDays, logs: logs.filter((l) => l.assignmentId === x.id) })
    );
  }
  items.sort((p, q) => Number(p.readOnly) - Number(q.readOnly));
  return { today, logBackDays: backDays, items };
}

/** GET /me/gym-plans/:assignmentId: one plan with the versions given to me and all my ticks (read-only once ended). */
async function myPlan(principal, assignmentId) {
  const today = c.today();
  const backDays = c.cfg().planLogBackDays;
  const { rows, current, byMember } = await mine(principal, { id: assignmentId });
  const x = rows[0];
  if (!x) throw E.notFound('Plan');
  const ctx = await context(rows);
  const version = ctx.versions.get(x.planVersionId);
  // The versions given to me: from the one current when the plan was assigned to the one I have now.
  const first = await GymPlanVersion.findOne({ where: { planId: x.planId, createdAt: { [Op.lte]: x.createdAt } }, order: [['version', 'DESC']], attributes: ['version'] });
  const given = await GymPlanVersion.findAll({ where: { planId: x.planId, version: { [Op.between]: [first?.version ?? version.version, version.version] } }, order: [['version', 'DESC']] });
  const logs = await GymPlanLog.findAll({ where: { assignmentId: x.id }, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit: 5000 });
  const item = myItem(x, { plan: ctx.plans.get(x.planId), version, member: byMember.get(x.memberId), linked: current.has(x.memberId), gym: ctx.gyms.get(x.gymId), today, backDays, logs });
  return { ...item, versions: given.map((v) => ({ version: v.version, createdAt: c.iso(v.createdAt), content: v.content })), logs: [...rules.latestLogs(logs).values()].map(view.logView) };
}

/** POST /me/gym-plans/:assignmentId/logs { localDate, itemRef, done, note? } (append-only; the latest tick per item and date wins). */
async function addLog(principal, assignmentId, { localDate, itemRef, done, note = null }, req) {
  const today = c.today();
  const backDays = c.cfg().planLogBackDays;
  const { rows, current, byMember } = await mine(principal, { id: assignmentId });
  const x = rows[0];
  if (!x) throw E.notFound('Plan');
  if (rules.planReadOnly({ assignmentStatus: x.status, linked: current.has(x.memberId), memberStatus: byMember.get(x.memberId).status })) throw fail('GYM_PLAN_STATE', { status: x.status, reason: 'read_only' });
  const block = rules.logWindowBlock({ localDate, today, backDays, startsOn: x.startsOn, endsOn: x.endsOn });
  if (block) throw fail(block, { backDays, startsOn: x.startsOn, endsOn: x.endsOn ?? null });
  const version = await GymPlanVersion.findByPk(x.planVersionId);
  if (!rules.itemRefsFor(version.content, { date: localDate, startsOn: x.startsOn, endsOn: x.endsOn }).has(itemRef)) throw E.validation([{ field: 'itemRef', message: 'Not an item of this plan on that day' }]);
  const row = await sequelize.transaction(async (transaction) => {
    const l = await GymPlanLog.create({ assignmentId: x.id, planVersionId: x.planVersionId, localDate, itemRef, done, note, byUser: principal.id }, { transaction });
    await c.record({ action: 'gym_plan.logged', actor: principal, entityType: 'gym_plan_assignment', entityId: x.id, after: { localDate, itemRef, done, note: note ? 'set' : null }, meta: { gymId: x.gymId }, req }, transaction);
    return l;
  });
  return { log: view.logView(row) };
}

/** M08 template facts for a plan notice: the title and kind (gym-manage facade facts.plan). */
async function planFacts(planId) {
  const p = planId ? await GymPlan.findByPk(planId, { attributes: ['id', 'title', 'kind'] }) : null;
  return p ? { title: p.title, kind: p.kind } : null;
}

module.exports = { checkContent, seesMember, list, create, get, update, retire, assign, end, endIn, endForMemberIn, endDue, memberPlans, todayTitles, myPlans, myPlan, addLog, planFacts };
