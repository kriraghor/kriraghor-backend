'use strict';

/**
 * Round B3 staff accounts for businesses (Q69, Q169, Q170; plan B3). The business-members module
 * (identity group, ADR-007) owns business_members.
 *
 *  - workplacesOf(userId): the principal's workplaces (M01 loadPrincipal), only active memberships
 *    whose owner is live right now (account active, NID member, owner role active): a suspended or
 *    banned owner's staff lose access on their next request.
 *  - the owner's team: list, add by verified phone, change permissions, remove. Every change bumps
 *    the staff member's authz_version (their access token goes stale and the client refreshes), is
 *    audited and publishes business_member.added / .permissions_changed / .removed.
 *  - staffRecipients(): who also hears about new bookings, orders and stock (M08), by permission.
 *  - pendingActions(): the staff to-do (M19 "Needs your action", role business_staff).
 * Staff need only a verified phone, not NID (Q169); the owner stays accountable for what they do.
 */
const { sequelize, BusinessMember } = require('../../models');
const { E } = require('../../common/errors');
const settings = require('../settings').settings;
const audit = require('../audit').audit;
const events = require('../events').events;
const authz = require('../auth').authz;
const directory = require('../users').directory;
const port = require('./businesses.port');
const rules = require('./business-members.rules');
const view = require('./business-members.serializer');

const { fail } = rules;
const ownerRoleCase = `CASE bm.business_type ${rules.TYPES.map((t) => `WHEN '${t}' THEN '${rules.OWNER_ROLE[t]}'`).join(' ')} END`;

/** The live-owner join shared by workplaces and recipients (identity group tables only). */
const LIVE_OWNER = `
  JOIN users o ON o.id = bm.owner_id AND o.status = 'active'
  JOIN user_roles om ON om.user_id = bm.owner_id AND om.role = 'member' AND om.status = 'active'
  JOIN user_roles orl ON orl.user_id = bm.owner_id AND orl.status = 'active' AND orl.role = ${ownerRoleCase}`;

/** M01 principal: [{ id, businessType, businessId, ownerId, permissions, since }] (B3 access). */
async function workplacesOf(userId, { transaction } = {}) {
  const rows = await sequelize.query(
    `SELECT bm.id, bm.business_type AS "businessType", bm.business_id AS "businessId", bm.owner_id AS "ownerId", bm.permissions, bm.created_at AS "since"
       FROM business_members bm ${LIVE_OWNER}
      WHERE bm.member_id = :userId AND bm.status = 'active'
      ORDER BY bm.created_at ASC`,
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT, transaction }
  );
  return rows.map((r) => ({ ...r, permissions: Array.isArray(r.permissions) ? r.permissions : [] }));
}

/**
 * M08: staff of a business who hold a permission (active membership, live owner, active account).
 * The owner is never in the list (they already get the owner's notice).
 */
async function staffRecipients(businessType, businessId, permission) {
  if (!businessId) return [];
  const rows = await sequelize.query(
    `SELECT DISTINCT bm.member_id AS "memberId"
       FROM business_members bm ${LIVE_OWNER}
       JOIN users m ON m.id = bm.member_id AND m.status = 'active'
      WHERE bm.business_type = :type AND bm.business_id = :businessId AND bm.status = 'active'
        AND bm.permissions @> jsonb_build_array(CAST(:permission AS text))`,
    { replacements: { type: businessType, businessId, permission }, type: sequelize.QueryTypes.SELECT }
  );
  return rows.map((r) => r.memberId);
}

// ---------------------------------------------------------------- the owner's team

/** The caller's own business (404 otherwise: never reveals someone else's); the owner role must be live to change the team. */
async function ownBusiness(principal, type, businessId, { live = true, transaction } = {}) {
  const b = await port.describe(type, businessId, { transaction });
  if (!b || b.ownerId !== principal.id) throw E.notFound('Business');
  if (live && !rules.ownerLive(principal, type)) {
    const suspended = principal.roles?.[rules.OWNER_ROLE[type]] === 'suspended';
    throw E.forbidden(suspended ? 'ROLE_SUSPENDED' : 'ROLE_REQUIRED', 'You cannot do this yet', undefined, { role: rules.OWNER_ROLE[type] });
  }
  return b;
}

async function rowsView(rows) {
  const contacts = await directory.contactFor(rows.map((r) => r.memberId));
  const businesses = new Map();
  for (const r of rows) {
    const k = `${r.businessType}:${r.businessId}`;
    if (!businesses.has(k)) businesses.set(k, await port.get(r.businessType).business(r.businessId));
  }
  return rows.map((r) => view.teamMemberView(r, { business: businesses.get(`${r.businessType}:${r.businessId}`), member: contacts.get(r.memberId) }));
}

/** GET /me/team?businessType&businessId&status: the owner's staff at every business (or one). */
async function listTeam(principal, { businessType, businessId, status = 'active' } = {}) {
  if (businessId && !businessType) throw E.validation([{ field: 'businessType', message: 'Name the business type with the business' }]);
  if (businessId) await ownBusiness(principal, businessType, businessId, { live: false });
  const where = { ownerId: principal.id, ...(businessType ? { businessType } : {}), ...(businessId ? { businessId } : {}), ...(status === 'all' ? {} : { status }) };
  const rows = await BusinessMember.findAll({ where, order: [['createdAt', 'ASC']] });
  const businesses = (await port.ownedBy(principal.id)).filter((b) => !businessType || b.businessType === businessType);
  return {
    items: await rowsView(rows),
    businesses: businesses.map((b) => ({ businessType: b.businessType, id: b.id, name: b.name ?? null, status: b.status ?? null })),
    permissionCatalogue: view.permissionCatalogue(),
    maxMembers: settings.get('business.team_max_members'),
  };
}

/** Serialise team changes per business (the cap and the one-active-row rule hold under concurrency). */
const lockBusiness = (type, businessId, transaction) =>
  sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `business_members:${type}:${businessId}` }, transaction });

const publish = (transaction, name, row, extra, actor) =>
  events.publish(transaction, {
    name,
    aggregateType: 'business_member',
    aggregateId: row.id,
    payload: { businessMemberId: row.id, businessType: row.businessType, businessId: row.businessId, ownerId: row.ownerId, memberId: row.memberId, ...extra },
    actor,
  });

function checkedPermissions(type, list) {
  const r = rules.normalizePermissions(type, list);
  if (r.error) throw fail('PERMISSIONS_INVALID', { unknown: r.unknown, missing: r.missing, allowed: rules.allowedFor(type) });
  return r.permissions;
}

/**
 * POST /me/team { businessType, businessId, phone, permissions? }: an existing Kriraghor account with
 * a verified phone joins one business (Q169: no NID needed). Refused: unknown numbers, the owner,
 * Kriraghor staff accounts (they never hold customer roles, M01), unverified phones, someone already
 * on the team, and a full team (business.team_max_members).
 */
async function add(principal, { businessType, businessId, phone, permissions }, req) {
  const business = await ownBusiness(principal, businessType, businessId);
  const granted = checkedPermissions(businessType, permissions ?? rules.defaultsFor(businessType));
  const memberId = await directory.activeByPhone(phone);
  if (!memberId) throw fail('MEMBER_NOT_FOUND');
  if (memberId === principal.id) throw fail('MEMBER_IS_OWNER');
  const account = (await directory.accounts([memberId])).get(memberId);
  if (account?.isStaff) throw fail('MEMBER_IS_STAFF');
  if (!(await directory.verifiedPhoneOf(memberId))) throw fail('PHONE_NOT_VERIFIED');
  const row = await sequelize.transaction(async (transaction) => {
    await lockBusiness(businessType, businessId, transaction);
    if (await BusinessMember.findOne({ where: { businessType, businessId, memberId, status: 'active' }, transaction })) throw fail('ALREADY_MEMBER');
    const activeCount = await BusinessMember.count({ where: { businessType, businessId, status: 'active' }, transaction });
    const max = settings.get('business.team_max_members');
    if (rules.teamFull({ activeCount, max })) throw fail('TEAM_FULL', { max });
    const m = await BusinessMember.create({ businessType, businessId, ownerId: business.ownerId, memberId, permissions: granted, status: 'active', addedBy: principal.id }, { transaction });
    await authz.bumpVersion(memberId, { transaction });
    await audit.record(
      { action: 'business_member.added', actor: principal, entityType: 'business_member', entityId: m.id, after: { businessType, businessId, memberId, permissions: granted }, meta: { businessType, businessId }, req },
      { transaction }
    );
    await publish(transaction, 'business_member.added', m, { permissions: granted }, principal);
    return m;
  });
  return { member: (await rowsView([row]))[0] };
}

async function ownRow(principal, id, transaction) {
  const row = await BusinessMember.findOne({ where: { id, ownerId: principal.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
  if (!row) throw E.notFound('Team member');
  return row;
}

/** PATCH /me/team/:id { permissions }: the owner changes what one staff member may do. */
async function updatePermissions(principal, id, { permissions }, req) {
  const result = await sequelize.transaction(async (transaction) => {
    const row = await ownRow(principal, id, transaction);
    await ownBusiness(principal, row.businessType, row.businessId, { transaction });
    const next = checkedPermissions(row.businessType, permissions);
    const diff = rules.diffPermissions(row.permissions, next);
    if (!diff.changed) return { row, unchanged: true };
    const before = [...row.permissions];
    await row.update({ permissions: next }, { transaction });
    await authz.bumpVersion(row.memberId, { transaction });
    await audit.record(
      { action: 'business_member.permissions_changed', actor: principal, entityType: 'business_member', entityId: row.id, before: { permissions: before }, after: { permissions: next }, meta: { businessType: row.businessType, businessId: row.businessId, memberId: row.memberId, added: diff.added, removed: diff.removed }, req },
      { transaction }
    );
    await publish(transaction, 'business_member.permissions_changed', row, { added: diff.added, removed: diff.removed }, principal);
    return { row, unchanged: false };
  });
  return { member: (await rowsView([result.row]))[0], ...(result.unchanged ? { unchanged: true } : {}) };
}

/**
 * POST /me/team/:id/remove: the staff member loses access at once (their next request no longer
 * finds the workplace; their token is stale). Allowed even while the owner's own role is suspended:
 * taking access away is always safe.
 */
async function remove(principal, id, req) {
  const row = await sequelize.transaction(async (transaction) => {
    const r = await ownRow(principal, id, transaction);
    await ownBusiness(principal, r.businessType, r.businessId, { live: false, transaction });
    await r.update({ status: 'removed', removedBy: principal.id, removedAt: new Date() }, { transaction });
    await authz.bumpVersion(r.memberId, { transaction });
    await audit.record(
      { action: 'business_member.removed', actor: principal, entityType: 'business_member', entityId: r.id, before: { status: 'active' }, after: { status: 'removed' }, meta: { businessType: r.businessType, businessId: r.businessId, memberId: r.memberId }, req },
      { transaction }
    );
    await publish(transaction, 'business_member.removed', r, {}, principal);
    return r;
  });
  return { member: (await rowsView([row]))[0] };
}

// ---------------------------------------------------------------- the staff member

/** GET /me/workplaces: where the caller works (live owners only), with names. */
async function workplaces(principal) {
  const list = principal.workplaces ?? [];
  const names = await directory.displayNames(list.map((w) => w.ownerId));
  const items = [];
  for (const w of list) {
    const business = await port.get(w.businessType).business(w.businessId);
    if (!business || business.status === 'removed') continue;
    items.push(view.workplaceView(w, { business, ownerName: names.get(w.ownerId) }));
  }
  return { items };
}

/** M19 "Needs your action" for staff: each workplace's to-do, by the staff member's permissions. */
async function pendingActions(principal, now = new Date()) {
  const items = [];
  for (const w of principal.workplaces ?? []) {
    for (const item of await port.staffActions(w.businessType, w.businessId, w.permissions, now)) items.push({ ...item, businessType: w.businessType, businessId: w.businessId });
  }
  return items;
}

/** Facts for M08 templates: the business's display name. */
async function businessName(businessType, businessId) {
  const b = await port.get(businessType).business(businessId);
  return b?.name ?? '';
}

/**
 * B3: the owner's account or role changed (suspended, banned, restored, role suspended or back):
 * every staff member's access token goes stale, so their panel reloads its workplaces.
 */
async function bumpStaffOf(ownerId, { transaction } = {}) {
  const rows = await BusinessMember.findAll({ where: { ownerId, status: 'active' }, attributes: ['memberId'], transaction });
  const ids = [...new Set(rows.map((r) => r.memberId))];
  for (const memberId of ids) await authz.bumpVersion(memberId, { transaction });
  return ids.length;
}

module.exports = { workplacesOf, staffRecipients, listTeam, add, updatePermissions, remove, workplaces, pendingActions, businessName, bumpStaffOf, ownBusiness };
