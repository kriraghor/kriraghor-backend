'use strict';

/**
 * M14 lite (built early for M22, 18 Oct 2026): esports organisations and their members.
 *
 *   draft ─submit─▶ pending_review (M05 kind organisation) ─approved─▶ verified
 *                                         └─changes / rejected─▶ changes_requested | rejected
 *   verified ─staff─▶ suspended ─master─▶ verified
 *
 * The owner applies on kriraghor.com: the organiser role (NID, then the org_registration document,
 * approved on the documents desk), then this organisation. Members are owner, admin or staff; every
 * organiser request is scoped by membership (membership() and the requireOrgRole guard), and a
 * mismatch is a 404 so tenants cannot probe each other's ids (M22-FR-03). Never deleted.
 */
const { Op } = require('sequelize');
const { E, AppError } = require('../../common/errors');
const { sequelize, Organisation, OrganisationMember } = require('../../models');
const { Area } = require('../catalog').reference;
const users = require('../users').directory;
const audit = require('../audit').audit;
const events = require('../events').events;
const moderation = require('../moderation').moderation;
const directory = require('../users').directory;
const { normalizePhone } = require('../../common/identifiers');

const ERRORS = {
  ORG_ROLE_REQUIRED: [403, 'Apply for the organiser role first (your NID and the organisation\'s registration)'],
  ORG_STATE: [409, 'The organisation cannot do that in its current state'],
  ORG_IN_REVIEW: [409, 'Staff are reviewing this organisation. Wait for the decision'],
  ORG_NAME_TAKEN: [409, 'Another organisation already uses this name'],
  ORG_MEMBER_UNKNOWN: [404, 'No Kriraghor member has this phone number'],
  ORG_MEMBER_EXISTS: [409, 'This person is already a member'],
  ORG_OWNER_FIXED: [409, 'The owner stays the owner'],
  AREA_UNKNOWN: [422, 'Choose an area from the list'],
};
const fail = (code, meta) => new AppError(ERRORS[code][0], code, ERRORS[code][1], meta ? { meta } : undefined);
const publish = (transaction, name, o, extra = {}, actor = null) =>
  events.publish(transaction, { name, aggregateType: 'organisation', aggregateId: o.id, payload: { organisationId: o.id, ownerId: o.ownerUserId ?? o.ownerId, ...extra }, actor });

const FIELDS = ['name', 'areaId', 'about', 'contactEmail'];
const EDITABLE = ['draft', 'changes_requested', 'rejected'];
const ADMIN_ROLES = ['owner', 'admin'];

function slugify(text) {
  const base = String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'org';
}

function view(o, { role = null } = {}) {
  return {
    id: o.id,
    slug: o.slug,
    kind: o.kind,
    name: o.name,
    areaId: o.areaId ?? null,
    about: o.about ?? null,
    contactEmail: o.contactEmail ?? null,
    status: o.status,
    ownerId: o.ownerUserId,
    reviewReason: o.reviewReasonCode ? { code: o.reviewReasonCode, text: o.reviewReasonText ?? null } : null,
    verifiedAt: o.verifiedAt ?? null,
    role,
    createdAt: o.createdAt,
  };
}

// ---------------------------------------------------------------- membership (M22-FR-03)

/** The caller's active membership of an organisation, or null. */
async function membership(userId, organisationId, { transaction } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(organisationId))) return null;
  const m = await OrganisationMember.findOne({ where: { organisationId, userId, status: 'active' }, transaction });
  if (!m) return null;
  const o = await Organisation.findByPk(organisationId, { transaction });
  return o ? { org: o, role: m.role, isAdmin: ADMIN_ROLES.includes(m.role) } : null;
}

/** Is any of these users an active member of the organisation (registration conflict of interest)? */
async function isMember(userIds, organisationId) {
  return (await OrganisationMember.count({ where: { organisationId, userId: [...new Set(userIds)], status: 'active' } })) > 0;
}

/** The organisation's owner (the payee of its money, M22 decision 18 Oct 2026). */
async function ownerOf(organisationId, { transaction } = {}) {
  const o = await Organisation.findByPk(organisationId, { attributes: ['ownerUserId'], transaction });
  return o?.ownerUserId ?? null;
}

/** The organisation's status (M22 refuses new submits unless it is verified, e.g. while suspended). */
async function statusOf(organisationId, { transaction } = {}) {
  const o = await Organisation.findByPk(organisationId, { attributes: ['status'], transaction });
  return o?.status ?? null;
}

/** Active admins and the owner, for notifications. */
async function adminIds(organisationId, { transaction } = {}) {
  const rows = await OrganisationMember.findAll({ where: { organisationId, status: 'active', role: ADMIN_ROLES }, attributes: ['userId'], transaction });
  return rows.map((r) => r.userId);
}

/** Names of organisations, for cards and the esports app (only verified ones are public). */
async function publicRefs(ids, { transaction } = {}) {
  if (!ids.length) return new Map();
  const rows = await Organisation.findAll({ where: { id: [...new Set(ids)] }, attributes: ['id', 'slug', 'name', 'status'], transaction });
  return new Map(rows.map((o) => [o.id, { id: o.id, slug: o.slug, name: o.name }]));
}

// ---------------------------------------------------------------- the applicant

async function checkFields(body, transaction) {
  if (body.areaId && !(await Area.findByPk(body.areaId, { attributes: ['id'], transaction }))) throw fail('AREA_UNKNOWN');
}

/** POST /me/organisations: a draft owned by the caller (who has applied for the organiser role). */
async function create(principal, body, req) {
  if (!principal.roles.organiser) throw fail('ORG_ROLE_REQUIRED');
  return sequelize.transaction(async (transaction) => {
    await checkFields(body, transaction);
    const base = slugify(body.name);
    let slug = base;
    for (let i = 2; await Organisation.findOne({ where: { slug }, attributes: ['id'], transaction }); i += 1) slug = `${base}-${i}`;
    const o = await Organisation.create(
      { ownerUserId: principal.id, slug, kind: body.kind ?? 'esports', ...Object.fromEntries(FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]])), status: 'draft', createdBy: principal.id, updatedBy: principal.id },
      { transaction }
    );
    await OrganisationMember.create({ organisationId: o.id, userId: principal.id, role: 'owner', addedBy: principal.id }, { transaction });
    await audit.record({ action: 'organisation.created', actor: principal, entityType: 'organisation', entityId: o.id, after: { name: o.name }, req }, { transaction });
    return view(o, { role: 'owner' });
  });
}

/** GET /me/organisations: organisations I belong to, with my role. */
async function listMine(principal) {
  const ms = await OrganisationMember.findAll({ where: { userId: principal.id, status: 'active' }, order: [['createdAt', 'ASC']] });
  const orgs = new Map((await Organisation.findAll({ where: { id: ms.map((m) => m.organisationId) } })).map((o) => [o.id, o]));
  return { items: ms.filter((m) => orgs.has(m.organisationId)).map((m) => view(orgs.get(m.organisationId), { role: m.role })) };
}

async function ownedForWrite(principal, id, transaction) {
  const m = await membership(principal.id, id, { transaction });
  if (!m || m.role !== 'owner') throw E.notFound('Organisation');
  return Organisation.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
}

/** GET /me/organisations/:id (members). */
async function getMine(principal, id) {
  const m = await membership(principal.id, id);
  if (!m) throw E.notFound('Organisation');
  return view(m.org, { role: m.role });
}

/** PATCH /me/organisations/:id (owner): while not verified; a verified organisation's name is fixed. */
async function update(principal, id, body, req) {
  return sequelize.transaction(async (transaction) => {
    const o = await ownedForWrite(principal, id, transaction);
    if (o.status === 'pending_review') throw fail('ORG_IN_REVIEW');
    const patch = Object.fromEntries(FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
    if (!EDITABLE.includes(o.status) && (patch.name !== undefined || patch.areaId !== undefined)) throw fail('ORG_STATE');
    await checkFields(patch, transaction);
    await o.update({ ...patch, updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'organisation.updated', actor: principal, entityType: 'organisation', entityId: o.id, after: patch, req }, { transaction });
    return view(o, { role: 'owner' });
  });
}

/** M05 checks: the owner's organiser role (documents approved; locked), the NID, a unique name. */
async function checksFor(organisationId, { transaction } = {}) {
  const o = await Organisation.findByPk(organisationId, { transaction });
  if (!o) return [];
  const statuses = { organiser: await users.roleStatus(o.ownerUserId, 'organiser', { transaction }), member: await users.roleStatus(o.ownerUserId, 'member', { transaction }) };
  const role = (r) => statuses[r] ?? null;
  const [similar] = await sequelize.query("SELECT COUNT(*)::int AS n FROM organisations WHERE id <> :id AND status IN ('verified', 'pending_review', 'suspended') AND similarity(lower(name), lower(:name)) > 0.8", {
    replacements: { id: o.id, name: o.name },
    transaction,
  });
  return [
    { key: 'owner_documents_approved', severity: 'hard', result: role('organiser') === 'active' ? 'pass' : 'fail', detail: role('organiser') === 'active' ? null : `Organiser role: ${role('organiser') ?? 'not applied'}` },
    { key: 'owner_nid_verified', severity: 'hard', result: role('member') === 'active' ? 'pass' : 'fail', detail: null },
    { key: 'name_unique', severity: 'soft', result: similar[0].n ? 'warn' : 'pass', detail: similar[0].n ? 'A similar name is already used' : null },
  ];
}

/** POST /me/organisations/:id/submit (owner): to the Moderation desk. */
async function submit(principal, id, req) {
  return sequelize.transaction(async (transaction) => {
    const o = await ownedForWrite(principal, id, transaction);
    if (!EDITABLE.includes(o.status)) throw fail(o.status === 'pending_review' ? 'ORG_IN_REVIEW' : 'ORG_STATE');
    if (!principal.roles.organiser) throw fail('ORG_ROLE_REQUIRED');
    const sub = await moderation.submit(
      { kind: 'organisation', subjectId: o.id, payload: { organisationId: o.id, name: o.name, ownerId: o.ownerUserId }, title: o.name, submittedBy: principal.id, isEdit: false },
      { transaction }
    );
    await o.update({ status: 'pending_review', currentSubmissionId: sub.id, reviewReasonCode: null, reviewReasonText: null, statusChangedAt: new Date(), updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'organisation.submitted', actor: principal, entityType: 'organisation', entityId: o.id, meta: { submissionId: sub.id }, req }, { transaction });
    await publish(transaction, 'organisation.submitted', o, {}, principal);
    return view(o, { role: 'owner' });
  });
}

const DECIDED = { changes_requested: 'organisation.changes_requested', rejected: 'organisation.rejected' };

/** Apply an M05 decision (consumer in organisations.moderation). */
async function applyDecision(submissionId, status, { transaction }) {
  const sub = await moderation.getById(submissionId, { transaction });
  if (!sub) return null;
  const ack = () =>
    events.publish(transaction, { name: 'submission.applied', aggregateType: 'submission', aggregateId: sub.id, payload: { submissionId: sub.id, kind: sub.kind, subjectId: sub.subjectId, version: sub.version, submittedBy: sub.submittedBy } });
  const o = await Organisation.findByPk(sub.payload.organisationId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!o || o.currentSubmissionId !== sub.id) {
    if (status === 'approved') await ack();
    return null;
  }
  const now = new Date();
  if (status === 'withdrawn') {
    await o.update({ status: 'draft', currentSubmissionId: null, statusChangedAt: now }, { transaction });
    return 'withdrawn';
  }
  if (status !== 'approved') {
    await o.update({ status, currentSubmissionId: null, reviewReasonCode: sub.reasonCode ?? null, reviewReasonText: sub.reasonText ?? null, statusChangedAt: now }, { transaction });
    await audit.record({ action: DECIDED[status], actor: null, entityType: 'organisation', entityId: o.id, after: { status, reasonCode: sub.reasonCode ?? null }, meta: { submissionId: sub.id } }, { transaction });
    await publish(transaction, DECIDED[status], o, { reasonCode: sub.reasonCode ?? null });
    return status;
  }
  await o.update({ status: 'verified', verifiedAt: now, statusChangedAt: now, currentSubmissionId: null, reviewReasonCode: null, reviewReasonText: null }, { transaction });
  await audit.record({ action: 'organisation.verified', actor: null, entityType: 'organisation', entityId: o.id, after: { status: 'verified' }, meta: { submissionId: sub.id, decidedBy: sub.decidedBy } }, { transaction });
  await publish(transaction, 'organisation.verified', o);
  await ack();
  return 'approved';
}

// ---------------------------------------------------------------- members (org admins)

async function members(organisationId) {
  const rows = await OrganisationMember.findAll({ where: { organisationId, status: 'active' }, order: [['createdAt', 'ASC']] });
  const names = await directory.publicNames(rows.map((r) => r.userId));
  return { items: rows.map((r) => ({ id: r.id, userId: r.userId, name: names.get(r.userId)?.displayName ?? null, role: r.role, addedAt: r.createdAt })) };
}

/** POST /org/:orgId/members { phone, role } (owner or admin): an existing member account joins. */
async function addMember(principal, org, { phone, role }, req) {
  return sequelize.transaction(async (transaction) => {
    const normal = normalizePhone(phone);
    const userId = normal ? await users.activeByPhone(normal, { transaction }) : null;
    if (!userId) throw fail('ORG_MEMBER_UNKNOWN');
    const user = { id: userId };
    if (await OrganisationMember.findOne({ where: { organisationId: org.id, userId: user.id, status: 'active' }, transaction })) throw fail('ORG_MEMBER_EXISTS');
    const m = await OrganisationMember.create({ organisationId: org.id, userId: user.id, role, addedBy: principal.id }, { transaction });
    await audit.record({ action: 'organisation.member_added', actor: principal, entityType: 'organisation', entityId: org.id, after: { userId: user.id, role }, req }, { transaction });
    await publish(transaction, 'organisation.member_added', org, { userId: user.id, role }, principal);
    return { id: m.id, userId: user.id, role };
  });
}

/** POST /org/:orgId/members/:memberId/remove (owner or admin): the owner cannot be removed. */
async function removeMember(principal, org, memberId, req) {
  return sequelize.transaction(async (transaction) => {
    const m = await OrganisationMember.findOne({ where: { id: memberId, organisationId: org.id, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!m) throw E.notFound('Member');
    if (m.role === 'owner') throw fail('ORG_OWNER_FIXED');
    await m.update({ status: 'removed', removedBy: principal.id, removedAt: new Date() }, { transaction });
    await audit.record({ action: 'organisation.member_removed', actor: principal, entityType: 'organisation', entityId: org.id, after: { userId: m.userId }, req }, { transaction });
    return { id: m.id, status: 'removed' };
  });
}

// ---------------------------------------------------------------- staff

async function staffList({ status, kind, q, limit = 100 } = {}) {
  const where = { ...(status ? { status } : { status: { [Op.ne]: 'draft' } }), ...(kind ? { kind } : {}), ...(q ? { name: { [Op.iLike]: `%${q}%` } } : {}) };
  const rows = await Organisation.findAll({ where, order: [['updatedAt', 'DESC']], limit });
  return { items: rows.map((o) => view(o)) };
}

async function staffGet(id) {
  const o = await Organisation.findByPk(id);
  if (!o) throw E.notFound('Organisation');
  return { ...view(o), members: (await members(o.id)).items };
}

/** Staff: suspend (manage_organisers) or restore (masters), with a reason. */
async function staffAction(actor, id, action, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const o = await Organisation.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!o) throw E.notFound('Organisation');
    const to = action === 'suspend' ? (o.status === 'verified' ? 'suspended' : null) : o.status === 'suspended' ? 'verified' : null;
    if (!to) throw fail('ORG_STATE');
    await o.update({ status: to, statusChangedAt: new Date() }, { transaction });
    await audit.record({ action: `organisation.${action === 'suspend' ? 'suspended' : 'restored'}`, actor, entityType: 'organisation', entityId: o.id, after: { status: to }, reason, req }, { transaction });
    await publish(transaction, action === 'suspend' ? 'organisation.suspended' : 'organisation.restored', o, { reason }, actor);
    return view(o);
  });
}

module.exports = {
  ERRORS,
  fail,
  view,
  membership,
  isMember,
  ownerOf,
  statusOf,
  adminIds,
  publicRefs,
  create,
  listMine,
  getMine,
  update,
  checksFor,
  submit,
  applyDecision,
  members,
  addMember,
  removeMember,
  staffList,
  staffGet,
  staffAction,
};
