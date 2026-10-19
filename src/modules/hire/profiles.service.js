'use strict';

/**
 * M11 hire profiles and rate cards (FR-10 to FR-14), on kriraghor.com/pro.
 *  - One profile per (user, hire role). The role's category says which platform role works in it
 *    (player for category 01, pro for the rest); the member must have applied for that role and have
 *    an active member (NID) role.
 *  - Create and edit a working copy; submit sends it to the Moderation desk (M05 kind hire_profile)
 *    with the automatic checks; the public sees live_snapshot, and an edit of a live profile runs
 *    beside it (edit_status) like an M09 ground. The first approval also activates the player or pro
 *    role (M01 reacts to hire_profile.published).
 *  - Rate cards are not moderated but are checked against the role's limits on save (FR-14) and
 *    versioned: a save is a new version; requests keep the version they were quoted on.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, HireProfile, RateCard, RateCardItem, Area } = require('../../models');
const audit = require('../audit').audit;
const events = require('../events').events;
const moderation = require('../moderation').moderation;
const authz = require('../auth').authz;
const directory = require('../users').directory;
const kyc = require('../kyc').kyc;
const taxonomy = require('../catalog').hireReads;
const { slugify } = require('../../common/identifiers');
const rules = require('./hire.rules');
const c = require('./hire.common');

const { fail } = c;
const PUBLISHED = ['live', 'paused', 'suspended'];
const isPublished = (s) => PUBLISHED.includes(s);
const inReview = (p) => p.status === 'pending_review' || p.editStatus === 'pending_review';
const ROLE_OPEN = ['applied', 'documents_pending', 'in_review', 'active'];
const FIELDS = ['headline', 'specialisation', 'sportKeys', 'experienceLevel', 'years', 'baseAreaId', 'bio', 'worksWithU16'];

/** The public version of a profile (live_snapshot), built at approval. */
const snapshotOf = (p, version) => ({
  version,
  headline: p.headline,
  specialisation: p.specialisation ?? null,
  sportKeys: p.sportKeys,
  experienceLevel: p.experienceLevel,
  years: p.years,
  baseAreaId: p.baseAreaId,
  bio: p.bio ?? null,
  worksWithU16: p.worksWithU16,
});
const diffOf = (live, next) => Object.fromEntries(Object.entries(next).filter(([k, v]) => k !== 'version' && JSON.stringify(live?.[k] ?? null) !== JSON.stringify(v ?? null)).map(([k, v]) => [k, { from: live?.[k] ?? null, to: v }]));

const publish = (transaction, name, p, extra = {}) => events.publish(transaction, { name, aggregateType: 'hire_profile', aggregateId: p.id, payload: { profileId: p.id, userId: p.userId, roleId: p.roleId, ...extra } });

// ---------------------------------------------------------------- rate cards

async function currentCard(profileId, { transaction } = {}) {
  return RateCard.findOne({ where: { profileId }, order: [['version', 'DESC']], include: [{ model: RateCardItem, as: 'items' }], transaction });
}

const cardView = (card) =>
  card
    ? {
        version: card.version,
        nightPct: card.nightPct,
        shortNoticePct: card.shortNoticePct,
        shortNoticeHours: card.shortNoticeHours,
        travel: { north: card.travelNorthPoisha, south: card.travelSouthPoisha, outside: card.travelOutsidePoisha },
        maxJobsPerDay: card.maxJobsPerDay,
        items: (card.items ?? []).map((i) => ({ unit: i.unit, format: i.format ?? null, rate: i.ratePoisha })),
      }
    : null;

/** The rate card in the shape the quote rules read. */
const cardForQuote = (card) => ({
  items: card.items.map((i) => ({ unit: i.unit, format: i.format ?? null, rate: i.ratePoisha })),
  card: { nightPct: card.nightPct, shortNoticePct: card.shortNoticePct, shortNoticeHours: card.shortNoticeHours, travel: { north: card.travelNorthPoisha, south: card.travelSouthPoisha, outside: card.travelOutsidePoisha } },
});

/** The rate limits of a role for each unit and format (Q74). */
function limitsFor(role) {
  const cfg = c.config();
  return (unit, format) => rules.rateLimits({ baseHourly: role.baseHourlyPoisha, unit, format, matchHours: cfg.matchHours, unitMultipliers: cfg.unitMultipliers, experienceMultipliers: cfg.experienceMultipliers, band: cfg.rateBand });
}

function cardErrors(role, body) {
  const cfg = c.config();
  return rules.rateCardErrors({
    role,
    items: body.items,
    card: { nightPct: body.nightPct, shortNoticePct: body.shortNoticePct, maxJobsPerDay: body.maxJobsPerDay },
    limitsFor: limitsFor(role),
    maxJobsCap: cfg.maxJobsCap,
    nightPctMax: cfg.nightPctMax,
    shortPctMax: cfg.shortPctMax,
  });
}

// ---------------------------------------------------------------- owner

async function own(principal, id, { transaction, lock = false } = {}) {
  const p = lock ? await c.lockProfile(id, transaction) : await HireProfile.findByPk(id, { transaction });
  if (!p || p.status === 'removed') throw E.notFound('Profile');
  if (p.userId !== principal.id) throw fail('NOT_YOUR_PROFILE');
  return p;
}

async function ownerView(p) {
  const [role, card] = await Promise.all([taxonomy.role(p.roleId), currentCard(p.id)]);
  return {
    id: p.id,
    slug: p.slug,
    status: p.status,
    editStatus: p.editStatus ?? null,
    liveVersion: p.liveVersion,
    role: role ? { key: role.key, nameEn: role.nameEn, nameBn: role.nameBn, categoryKey: role.categoryKey, allowedUnits: role.allowedUnits, formatPriced: role.formatPriced, formats: role.formats, requiresCredential: role.requiresCredential, policeCheckForU16: role.policeCheckForU16, credentialTiers: role.credentialTiers } : null,
    ...Object.fromEntries(FIELDS.map((k) => [k, p[k] ?? null])),
    live: p.liveSnapshot ?? null,
    reviewReason: p.reviewReasonCode ? { code: p.reviewReasonCode, text: p.reviewReasonText ?? null } : null,
    rateCard: cardView(card),
    limits: role ? Object.fromEntries(role.allowedUnits.flatMap((u) => (u === 'match' && role.formatPriced ? role.formats.map((f) => [`match:${f}`, limitsFor(role)(u, f)]) : [[`${u}:`, limitsFor(role)(u, null)]]))) : {},
  };
}

/** GET /pro/profiles: my hire profiles. */
async function listMine(principal) {
  const rows = await HireProfile.findAll({ where: { userId: principal.id, status: { [Op.ne]: 'removed' } }, order: [['createdAt', 'ASC']] });
  return { items: await Promise.all(rows.map(ownerView)) };
}

async function getMine(principal, id) {
  return ownerView(await own(principal, id));
}

async function activeArea(areaId, transaction) {
  const a = await Area.findByPk(areaId, { transaction });
  if (!a || a.isActive === false) throw fail('AREA_UNKNOWN');
  return a;
}

/** POST /pro/profiles: a draft for one hire role. */
async function create(principal, body, req) {
  const role = await taxonomy.role(body.roleKey);
  if (!role) throw E.validation([{ field: 'roleKey', message: 'Choose a hire role' }]);
  const status = principal.roles?.[role.forRole];
  if (!ROLE_OPEN.includes(status)) throw fail('ROLE_REQUIRED', { role: role.forRole });
  if (principal.roles?.member !== 'active') throw fail('MEMBER_NOT_ACTIVE');
  return sequelize.transaction(async (transaction) => {
    if (await HireProfile.findOne({ where: { userId: principal.id, roleId: role.id, status: { [Op.ne]: 'removed' } }, transaction })) throw fail('PROFILE_EXISTS');
    await activeArea(body.baseAreaId, transaction);
    const name = (await directory.contactFor([principal.id], { transaction })).get(principal.id)?.displayName ?? 'pro';
    const base = slugify(`${name} ${role.key.replace(/_/g, ' ')}`, 'pro');
    let slug = base;
    for (let i = 2; await HireProfile.findOne({ where: { slug }, attributes: ['id'], transaction }); i += 1) slug = `${base}-${i}`;
    const p = await HireProfile.create(
      { userId: principal.id, roleId: role.id, slug, ...Object.fromEntries(FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]])), status: 'draft', createdBy: principal.id },
      { transaction }
    );
    await audit.record({ action: 'hire_profile.created', actor: principal, entityType: 'hire_profile', entityId: p.id, after: { role: role.key, status: p.status }, req }, { transaction });
    return p;
  }).then(ownerView);
}

/** PATCH /pro/profiles/:id: edit the working copy (an edit of a live profile waits for review). */
async function update(principal, id, patch, req) {
  return sequelize
    .transaction(async (transaction) => {
      const p = await own(principal, id, { transaction, lock: true });
      if (inReview(p)) throw fail('PROFILE_IN_REVIEW');
      if (['rejected', 'suspended', 'removed'].includes(p.status)) throw fail('PROFILE_STATE');
      if (patch.baseAreaId) await activeArea(patch.baseAreaId, transaction);
      const changes = Object.fromEntries(FIELDS.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]]));
      await p.update({ ...changes, ...(isPublished(p.status) ? { editStatus: 'draft' } : {}), updatedBy: principal.id }, { transaction });
      await audit.record({ action: 'hire_profile.updated', actor: principal, entityType: 'hire_profile', entityId: p.id, after: { fields: Object.keys(changes) }, req }, { transaction });
      return p;
    })
    .then(ownerView);
}

/** PUT /pro/profiles/:id/rate-card: a new rate card version (validated against the role's limits). */
async function saveRateCard(principal, id, body, req) {
  return sequelize
    .transaction(async (transaction) => {
      const p = await own(principal, id, { transaction, lock: true });
      const role = await taxonomy.role(p.roleId, { transaction });
      const errors = cardErrors(role, body);
      if (errors.length) throw E.validation(errors);
      const last = await RateCard.max('version', { where: { profileId: p.id }, transaction });
      const card = await RateCard.create(
        {
          profileId: p.id,
          version: (last ?? 0) + 1,
          nightPct: body.nightPct,
          shortNoticePct: body.shortNoticePct,
          shortNoticeHours: body.shortNoticeHours ?? c.config().shortNoticeHoursDefault,
          travelNorthPoisha: body.travel.north,
          travelSouthPoisha: body.travel.south,
          travelOutsidePoisha: body.travel.outside,
          maxJobsPerDay: body.maxJobsPerDay,
          createdBy: principal.id,
        },
        { transaction }
      );
      await RateCardItem.bulkCreate(body.items.map((i) => ({ rateCardId: card.id, unit: i.unit, format: i.format ?? null, ratePoisha: i.rate })), { transaction });
      await p.update({ normalisedHourlyPoisha: rules.normalisedHourly(body.items, c.config().unitMultipliers.match) }, { transaction });
      await audit.record({ action: 'rate_card.saved', actor: principal, entityType: 'hire_profile', entityId: p.id, after: { version: card.version, items: body.items.length }, req }, { transaction });
      return p;
    })
    .then(ownerView);
}

/** POST /pro/profiles/:id/submit: send the profile (or its edit) to the Moderation desk. */
async function submit(principal, id, req) {
  return sequelize
    .transaction(async (transaction) => {
      const p = await own(principal, id, { transaction, lock: true });
      const published = isPublished(p.status);
      if (inReview(p)) throw fail('PROFILE_IN_REVIEW');
      if (!(await currentCard(p.id, { transaction }))) throw fail('RATE_CARD_REQUIRED');
      let diff;
      if (published) {
        if (!['draft', 'changes_requested', 'rejected'].includes(p.editStatus)) throw fail('NOTHING_TO_REVIEW');
        diff = diffOf(p.liveSnapshot, snapshotOf(p, null));
        if (!Object.keys(diff).length) throw fail('NOTHING_TO_REVIEW');
      } else {
        if (!['draft', 'changes_requested', 'withdrawn'].includes(p.status)) throw fail('PROFILE_STATE');
        diff = diffOf(null, snapshotOf(p, null));
      }
      const role = await taxonomy.role(p.roleId, { transaction });
      const version = p.liveVersion + 1;
      const sub = await moderation.submit(
        { kind: 'hire_profile', subjectId: p.id, payload: { profileId: p.id, version, isEdit: published, diff, roleKey: role.key }, title: `${role.nameEn}: ${p.headline} · v${version}${published ? ' (edit)' : ''}`, submittedBy: principal.id, isEdit: published },
        { transaction }
      );
      await p.update({ ...(published ? { editStatus: 'pending_review' } : { status: 'pending_review', statusChangedAt: new Date() }), currentSubmissionId: sub.id, reviewReasonCode: null, reviewReasonText: null, updatedBy: principal.id }, { transaction });
      await audit.record({ action: 'hire_profile.submitted', actor: principal, entityType: 'hire_profile', entityId: p.id, meta: { submissionId: sub.id, version, isEdit: published }, req }, { transaction });
      await publish(transaction, 'hire_profile.submitted', p, { version, isEdit: published });
      return p;
    })
    .then(ownerView);
}

/** POST /pro/profiles/:id/pause | /resume: stop or start taking requests (a live profile). */
async function setPaused(principal, id, paused, req) {
  return sequelize
    .transaction(async (transaction) => {
      const p = await own(principal, id, { transaction, lock: true });
      if (p.status !== (paused ? 'live' : 'paused')) throw fail('PROFILE_STATE');
      await p.update({ status: paused ? 'paused' : 'live', statusChangedAt: new Date() }, { transaction });
      await audit.record({ action: paused ? 'hire_profile.paused' : 'hire_profile.resumed', actor: principal, entityType: 'hire_profile', entityId: p.id, req }, { transaction });
      await publish(transaction, paused ? 'hire_profile.paused' : 'hire_profile.resumed', p);
      return p;
    })
    .then(ownerView);
}

// ---------------------------------------------------------------- M05 (adapter in hire.moderation)

const DECIDED_EVENT = { changes_requested: 'hire_profile.changes_requested', rejected: 'hire_profile.rejected' };

async function applyDecision(submissionId, status, { transaction }) {
  const sub = await moderation.getById(submissionId, { transaction });
  if (!sub) return null;
  const ack = () =>
    events.publish(transaction, { name: 'submission.applied', aggregateType: 'submission', aggregateId: sub.id, payload: { submissionId: sub.id, kind: sub.kind, subjectId: sub.subjectId, version: sub.version, submittedBy: sub.submittedBy } });
  const p = await c.lockProfile(sub.payload.profileId, transaction);
  if (!p || p.currentSubmissionId !== sub.id) {
    if (status === 'approved') await ack();
    return null;
  }
  const isEdit = Boolean(sub.payload.isEdit);
  const now = new Date();
  if (status === 'withdrawn') {
    await p.update({ ...(isEdit ? { editStatus: 'draft' } : { status: 'withdrawn', statusChangedAt: now }), currentSubmissionId: null }, { transaction });
    return 'withdrawn';
  }
  if (status !== 'approved') {
    await p.update({ ...(isEdit ? { editStatus: status } : { status, statusChangedAt: now }), currentSubmissionId: null, reviewReasonCode: sub.reasonCode ?? null, reviewReasonText: sub.reasonText ?? null }, { transaction });
    await audit.record({ action: DECIDED_EVENT[status], actor: null, entityType: 'hire_profile', entityId: p.id, after: { status: p.status, editStatus: p.editStatus ?? null, reasonCode: sub.reasonCode ?? null }, meta: { submissionId: sub.id } }, { transaction });
    await publish(transaction, DECIDED_EVENT[status], p, { isEdit, reasonCode: sub.reasonCode ?? null });
    return status;
  }
  const first = !isPublished(p.status);
  const version = p.liveVersion + 1;
  const snap = snapshotOf(p, version);
  await p.update(
    {
      status: first ? 'live' : p.status,
      editStatus: null,
      liveVersion: version,
      liveSnapshot: snap,
      publicHeadline: snap.headline,
      publicExperienceLevel: snap.experienceLevel,
      publicAreaId: snap.baseAreaId,
      currentSubmissionId: null,
      reviewReasonCode: null,
      reviewReasonText: null,
      ...(first ? { firstLiveAt: now, statusChangedAt: now } : {}),
    },
    { transaction }
  );
  const role = await taxonomy.role(p.roleId, { transaction });
  await audit.record({ action: 'hire_profile.published', actor: null, entityType: 'hire_profile', entityId: p.id, after: { status: p.status, version }, meta: { submissionId: sub.id, first } }, { transaction });
  await publish(transaction, 'hire_profile.published', p, { version, first, platformRole: role.forRole });
  await ack();
  return 'approved';
}

/** The M05 automatic checks of a profile submission (§5.2 FR-12). */
async function checksFor(profileId, { transaction }) {
  const p = await HireProfile.findByPk(profileId, { transaction });
  if (!p) return [];
  const ok = (key, pass, severity, detail = null) => ({ key, severity, result: pass ? 'pass' : 'fail', detail: pass ? null : detail });
  const [owner, role, card] = await Promise.all([authz.loadPrincipal(p.userId), taxonomy.role(p.roleId, { transaction }), currentCard(p.id, { transaction })]);
  const credential = role.requiresCredential ? await kyc.credentialFor(p.userId, role.key, { transaction }) : null;
  const police = p.worksWithU16 && role.policeCheckForU16 ? await kyc.policeClearedUntil(p.userId, { transaction }) : null;
  const errors = card ? cardErrors(role, { ...cardView(card), items: cardView(card).items }) : [{ field: 'rateCard' }];
  return [
    ok('nid_verified', owner?.roles?.member === 'active', 'hard', 'The NID is not approved'),
    ok('credential_covers', !role.requiresCredential || Boolean(credential && rules.levelRank(credential.level) >= rules.levelRank(p.experienceLevel)), 'hard', 'No approved credential at this experience level'),
    ok('rates_in_limits', errors.length === 0, 'hard', 'Rates are outside the role limits'),
    ok('police_clearance', !(p.worksWithU16 && role.policeCheckForU16) || Boolean(police), 'hard', 'Under-16 work needs an approved police clearance'),
    ok('no_contact_details', !rules.hasContact(`${p.headline} ${p.bio ?? ''}`), 'soft', 'The headline or bio has contact details'),
  ];
}

/** user_role.suspended / .withdrawn (player, pro), user.suspended / .banned: pause the live profiles. */
async function pauseAllOf(userId, { transaction }) {
  const live = await HireProfile.findAll({ where: { userId, status: 'live' }, transaction, lock: transaction.LOCK.UPDATE });
  for (const p of live) {
    await p.update({ status: 'paused', statusChangedAt: new Date() }, { transaction });
    await publish(transaction, 'hire_profile.paused', p, { reason: 'sanction' });
  }
  return live.length;
}

/** Staff: suspend (manage_users) or restore (masters) a profile, with a reason. */
async function staffAction(actor, id, action, { reason }, req) {
  return sequelize.transaction(async (transaction) => {
    const p = await c.lockProfile(id, transaction);
    if (!p) throw E.notFound('Profile');
    const to = action === 'suspend' ? (['live', 'paused'].includes(p.status) ? 'suspended' : null) : p.status === 'suspended' ? 'live' : null;
    if (!to) throw fail('PROFILE_STATE');
    await p.update({ status: to, statusChangedAt: new Date() }, { transaction });
    await audit.record({ action: `hire_profile.${action === 'suspend' ? 'suspended' : 'restored'}`, actor, entityType: 'hire_profile', entityId: p.id, after: { status: to }, reason, req }, { transaction });
    await publish(transaction, action === 'suspend' ? 'hire_profile.suspended' : 'hire_profile.restored', p, { reason });
    return { id: p.id, status: p.status };
  });
}

/** A profile as staff see it: the working copy, the owner's public name, the credential and the base area. */
async function staffView(p, names) {
  const [view, role] = await Promise.all([ownerView(p), taxonomy.role(p.roleId)]);
  const credential = role && role.credentialTiers.length ? await kyc.credentialFor(p.userId, role.key) : null;
  const area = p.baseAreaId ? await Area.findByPk(p.baseAreaId, { attributes: ['id', 'nameEn', 'nameBn'] }) : null;
  return {
    ...view,
    owner: { id: p.userId, displayName: names.get(p.userId)?.displayName ?? null },
    credential: credential ? { level: credential.level, issuer: credential.issuer ?? null, expiresOn: credential.expiresOn ?? null } : null,
    baseArea: area ? { id: area.id, nameEn: area.nameEn, nameBn: area.nameBn } : null,
    updatedAt: c.iso(p.updatedAt),
  };
}

/** GET /admin/hire/profiles?status&q: profiles other than drafts, newest change first. */
async function staffList({ status, q, limit = 50 } = {}) {
  const rows = await HireProfile.findAll({ where: { ...(status ? { status } : { status: { [Op.ne]: 'draft' } }), ...(q ? { headline: { [Op.iLike]: `%${q}%` } } : {}) }, order: [['updatedAt', 'DESC']], limit });
  const names = await directory.publicNames(rows.map((p) => p.userId));
  return { items: await Promise.all(rows.map((p) => staffView(p, names))) };
}

/** GET /admin/hire/profiles/:id. */
async function staffGet(id) {
  const p = await HireProfile.findByPk(id);
  if (!p || p.status === 'removed') throw E.notFound('Profile');
  return staffView(p, await directory.publicNames([p.userId]));
}

/** Display facts for notifications (M08). */
async function facts(profileId) {
  const p = await HireProfile.findByPk(profileId, { attributes: ['id', 'slug', 'headline', 'roleId', 'reviewReasonCode'] });
  if (!p) throw E.notFound('Profile');
  const role = await taxonomy.role(p.roleId);
  return { headline: p.headline, slug: p.slug, roleEn: role?.nameEn ?? '', roleBn: role?.nameBn ?? '', reasonCode: p.reviewReasonCode ?? null };
}

/** M16: a member's live hire profiles (slug and specialisation), for links from their player page. */
async function liveFor(userId) {
  const rows = await HireProfile.findAll({ where: { userId, status: 'live' }, attributes: ['slug', 'specialisation'], order: [['createdAt', 'ASC']] });
  return rows.map((r) => ({ slug: r.slug, specialisation: r.specialisation ?? null }));
}

module.exports = { liveFor, listMine, getMine, create, update, saveRateCard, submit, setPaused, applyDecision, checksFor, pauseAllOf, staffAction, staffList, staffGet, facts, currentCard, cardView, cardForQuote, snapshotOf };
