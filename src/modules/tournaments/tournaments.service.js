'use strict';

/**
 * M14 tournaments, step 1: drafts and the wizard (§4.2), rules from the M03 schema (FR-08), venues,
 * submission to M05 kind `tournament` with the automatic checks (§6.1, FR-05/06), cancel (FR-25),
 * registration close and extend (FR-14), rules lock and unlock (FR-09), and the console, public and
 * staff views. Registrations, fixtures and money live in their own services.
 *
 *   draft ─submit─▶ pending_review ─approved─▶ registration_open ─close─▶ registration_closed
 *        ◀─changes─┘                 └rejected                    ◀─extend (once)─┘
 *   registration_closed ─first result─▶ live ─all matches done─▶ completed; cancel before completion
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const audit = require('../audit/audit.service');
const moderation = require('../moderation/moderation.service');
const settings = require('../settings/settings.service');
const fee = require('../payments/fee.service');
const sportRules = require('../catalog/sport-rules.service');
const ruleSchema = require('../catalog/sport-rules.rules');
const organisations = require('../organisations/organisations.service');
const { sequelize, Tournament, TournamentRules, TournamentVenue, Registration, Match, Stage } = require('../../models');
const rules = require('./tournaments.rules');
const F = require('./fixtures.rules');
const c = require('./tournaments.common');

const EDITABLE = ['draft', 'changes_requested'];
const RUNNING = ['registration_open', 'registration_closed', 'live'];
const COSMETIC = ['description', 'contactUserId', 'prizeText'];
const BASICS = ['name', 'description', 'format', 'category', 'minTeams', 'maxTeams', 'squadMin', 'squadMax', 'entryFeePoisha', 'prizePoolPoisha', 'prizeSplit', 'prizeText', 'eligibility', 'contactUserId', 'registrationOpensAt', 'registrationClosesAt', 'startDate', 'endDate'];

function slugify(name) {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'tournament';
}

async function uniqueSlug(name, transaction) {
  const base = slugify(name);
  let slug = base;
  for (let i = 2; await Tournament.findOne({ where: { slug }, attributes: ['id'], transaction }); i += 1) slug = `${base}-${i}`;
  return slug;
}

/** Default format settings for a sport and format (rally sports default to a knockout, §4.2). */
const defaultFormatConfig = (format) => ({
  groupCount: format === 'groups_knockout' ? 2 : undefined,
  qualifiersPerGroup: format === 'groups_knockout' ? 2 : undefined,
  bestExtra: 0,
  knockoutTopN: 0,
  thirdPlace: false,
  seeding: 'registration_order',
});

/** The tiebreakers to use: the organiser's order, limited to what the sport allows; points first. */
function tiebreakersFor(schema, wanted) {
  const allowed = schema.tiebreakers;
  const list = (wanted ?? schema.sport.defaultTiebreakers).filter((k) => allowed.includes(k));
  if (wanted && wanted.some((k) => !allowed.includes(k))) throw c.fail('TIEBREAKER_INVALID');
  const out = ['points', ...list.filter((k) => k !== 'points')];
  return out.includes('lots') ? out : [...out, 'lots'];
}

/** Validates rule values against the schema; returns {values, presetKey} or throws. */
function checkRules(schema, values, presetKey) {
  const r = ruleSchema.validate(schema, values ?? {}, presetKey);
  if (r.error) throw c.fail(r.error.code, { field: r.error.field });
  return r;
}

const summaries = (schema, values) => ({ summaryEn: ruleSchema.summary(schema, values, 'en'), summaryBn: ruleSchema.summary(schema, values, 'bn') });

/** Every problem a draft has before it can be submitted (also the M05 automatic checks). */
async function problemsOf(t, r, venues, { transaction } = {}) {
  const cfg = c.config();
  const schema = await sportRules.schemaFor(t.sportId, { version: r.schemaVersion, transaction });
  const rulesError = ruleSchema.validate(schema, r.values, null).error?.code ?? null;
  const formatError = F.formatBlock(t.format, { minTeams: t.minTeams, maxTeams: t.maxTeams, ...r.formatConfig }) ?? (t.maxTeams > cfg.maxTeams ? 'MAX_TEAMS_TOO_HIGH' : null);
  const squadError = rules.squadBlock({ squadMin: t.squadMin, squadMax: t.squadMax }, ruleSchema.playersOf(r.values));
  const datesError = rules.datesBlock(t, { closeDays: cfg.closeDays, minStartDays: cfg.minStartDays, today: c.today() });
  const prizeError = rules.prizeBlock(t);
  const org = await organisations.statusOf(t.organisationId, { transaction });
  const ownerId = await organisations.ownerOf(t.organisationId, { transaction });
  const payoutReady = t.entryFeePoisha === 0 || Boolean(await require('../payouts/payout-accounts.service').activeFor(ownerId));
  return {
    checks: rules.submissionChecks({ orgVerified: org === 'verified', payoutReady, feePoisha: t.entryFeePoisha, rulesError, datesError, formatError, squadError, prizeError, venues: venues.length, feeMax: cfg.feeMax }),
    errors: [rulesError, formatError, squadError, datesError, prizeError, t.entryFeePoisha > cfg.feeMax ? 'ENTRY_FEE_TOO_HIGH' : null].filter(Boolean),
  };
}

// ---------------------------------------------------------------- views

const venueView = (v) => ({ id: v.id, groundId: v.groundId, venueText: v.venueText, areaId: v.areaId, courts: v.courts, sort: v.sort });

async function counts(tournamentId, transaction) {
  const rows = await Registration.findAll({ where: { tournamentId }, attributes: ['status', [sequelize.fn('COUNT', sequelize.col('id')), 'n']], group: ['status'], raw: true, transaction });
  return Object.fromEntries(rows.map((x) => [x.status, Number(x.n)]));
}

/** The console view of a tournament (organisation members). */
async function consoleView(t, { transaction } = {}) {
  const [r, venues, n, matches] = await Promise.all([
    c.rulesOf(t.id, transaction),
    TournamentVenue.findAll({ where: { tournamentId: t.id, status: 'active' }, order: [['sort', 'ASC']], transaction }),
    counts(t.id, transaction),
    Match.count({ where: { tournamentId: t.id, status: { [Op.ne]: 'cancelled' } }, transaction }),
  ]);
  const schema = await sportRules.schemaFor(t.sportId, { version: r.schemaVersion, transaction });
  return {
    id: t.id,
    organisationId: t.organisationId,
    slug: t.slug,
    name: t.name,
    description: t.description,
    sport: { key: schema.sport.key, nameEn: schema.sport.nameEn, nameBn: schema.sport.nameBn, engine: schema.sport.engine },
    format: t.format,
    category: t.category,
    status: t.status,
    minTeams: t.minTeams,
    maxTeams: t.maxTeams,
    squadMin: t.squadMin,
    squadMax: t.squadMax,
    entryFeePoisha: t.entryFeePoisha,
    prizePoolPoisha: t.prizePoolPoisha,
    prizeSplit: t.prizeSplit,
    prizeText: t.prizeText,
    eligibility: t.eligibility,
    contactUserId: t.contactUserId,
    registrationOpensAt: t.registrationOpensAt?.toISOString() ?? null,
    registrationClosesAt: t.registrationClosesAt?.toISOString() ?? null,
    startDate: t.startDate,
    endDate: t.endDate,
    feeBps: t.feeBps,
    releasePct: t.releasePct,
    rulesLockedAt: t.rulesLockedAt?.toISOString() ?? null,
    rulesUnlockedUntil: t.rulesUnlockedUntil?.toISOString() ?? null,
    firstResultAt: t.firstResultAt?.toISOString() ?? null,
    reviewReason: t.reviewReason,
    cancelReason: t.cancelReason,
    version: t.version,
    rules: { schemaVersion: r.schemaVersion, presetKey: r.presetKey, values: r.values, formatConfig: r.formatConfig, tiebreakers: r.tiebreakers, summaryEn: r.summaryEn, summaryBn: r.summaryBn, allowedTiebreakers: schema.tiebreakers },
    venues: venues.map(venueView),
    registrations: n,
    matches,
    createdAt: t.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------- drafts (organisation staff)

async function writeVenues(t, list, { transaction, full }) {
  const current = await TournamentVenue.findAll({ where: { tournamentId: t.id, status: 'active' }, transaction });
  const keep = new Set(list.filter((v) => v.id).map((v) => v.id));
  for (const v of current) {
    if (keep.has(v.id)) continue;
    if (!full && (await Match.count({ where: { venueId: v.id, status: { [Op.ne]: 'cancelled' } }, transaction }))) throw c.fail('VENUE_IN_USE');
    await v.update({ status: 'removed' }, { transaction });
  }
  for (const [i, v] of list.entries()) {
    if (!v.groundId && !(v.venueText && v.areaId)) throw c.fail('VENUE_INVALID');
    const row = { groundId: v.groundId ?? null, venueText: v.venueText ?? null, areaId: v.areaId ?? null, courts: v.courts ?? [], sort: i };
    const existing = v.id && current.find((x) => x.id === v.id);
    if (existing) await existing.update(row, { transaction });
    else await TournamentVenue.create({ tournamentId: t.id, ...row }, { transaction });
  }
}

/** The organisation already runs a tournament of this name in that year (uq_tournaments_name_year). */
const nameTaken = (err) => {
  if (err instanceof UniqueConstraintError && /name_year/.test(err.parent?.constraint ?? err.original?.constraint ?? '')) throw c.fail('NAME_TAKEN');
  throw err;
};

/** POST /org/:orgId/sports/tournaments: a draft, rules from the sport's first preset. */
async function create(principal, org, body, req) {
  const schema = await sportRules.bySportKey(body.sportKey);
  if (!schema) throw c.fail('SPORT_NOT_SUPPORTED');
  const presetKey = body.presetKey ?? schema.presets[0]?.key ?? null;
  const ruled = checkRules(schema, body.rules, presetKey);
  const players = ruleSchema.playersOf(ruled.values);
  const id = await sequelize.transaction(async (transaction) => {
    const t = await Tournament.create(
      {
        organisationId: org.id,
        sportId: schema.sport.id,
        slug: await uniqueSlug(body.name, transaction),
        name: body.name,
        format: body.format,
        minTeams: body.minTeams ?? 4,
        maxTeams: body.maxTeams ?? 8,
        squadMin: body.squadMin ?? players,
        squadMax: body.squadMax ?? Math.min(30, players * 2 || 2),
        entryFeePoisha: body.entryFeePoisha ?? 0,
        ...Object.fromEntries(BASICS.filter((k) => !['name', 'format', 'minTeams', 'maxTeams', 'squadMin', 'squadMax', 'entryFeePoisha'].includes(k) && body[k] !== undefined).map((k) => [k, body[k]])),
        status: 'draft',
        createdBy: principal.id,
        updatedBy: principal.id,
      },
      { transaction }
    );
    await TournamentRules.create(
      { tournamentId: t.id, schemaVersion: schema.version, presetKey: ruled.presetKey, values: ruled.values, formatConfig: { ...defaultFormatConfig(t.format), ...(body.formatConfig ?? {}) }, tiebreakers: tiebreakersFor(schema, body.tiebreakers), ...summaries(schema, ruled.values) },
      { transaction }
    );
    if (body.venues) await writeVenues(t, body.venues, { transaction, full: true });
    await audit.record({ action: 'tournament.created', actor: principal, entityType: 'tournament', entityId: t.id, after: { name: t.name, format: t.format }, meta: { organisationId: org.id }, req }, { transaction });
    await c.publish(transaction, 'tournament.created', 'tournament', t.id, { tournamentId: t.id, organisationId: org.id });
    return t.id;
  }).catch(nameTaken);
  return detail(org, id);
}

/**
 * PATCH /org/:orgId/sports/tournaments/:id. A draft (or one sent back) changes freely; a running
 * tournament takes cosmetic edits only (description, contact, prize text, venues), since material
 * changes need a new review (FR-07, step 2). Rules change while unlocked (FR-09).
 */
async function update(principal, org, id, body, req) {
  await sequelize.transaction(async (transaction) => {
    const t = await c.ownTournament(org, id, { transaction, lock: true });
    if (body.version !== undefined && body.version !== t.version) throw c.fail('VERSION_CONFLICT');
    const r = await c.rulesOf(t.id, transaction);
    const editable = EDITABLE.includes(t.status);
    const unlocked = t.rulesUnlockedUntil && t.rulesUnlockedUntil > new Date();
    if (!editable && !RUNNING.includes(t.status)) throw c.fail('TOURNAMENT_STATE');
    const allowed = editable ? BASICS : COSMETIC;
    const material = BASICS.filter((k) => !COSMETIC.includes(k) && body[k] !== undefined);
    if (!editable && material.length) throw c.fail('TOURNAMENT_STATE', { fields: material });
    const before = t.toJSON();
    const patch = Object.fromEntries(allowed.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
    if (patch.name && patch.name !== t.name && t.status === 'draft') patch.slug = await uniqueSlug(patch.name, transaction);
    await t.update({ ...patch, version: t.version + 1, updatedBy: principal.id }, { transaction });

    const rulesChange = body.presetKey !== undefined || body.rules !== undefined || body.tiebreakers !== undefined || body.formatConfig !== undefined;
    if (rulesChange) {
      if (!editable && !unlocked) throw c.fail(t.rulesLockedAt ? 'RULES_LOCKED' : 'TOURNAMENT_STATE');
      if (!editable && body.formatConfig !== undefined) throw c.fail('TOURNAMENT_STATE', { fields: ['formatConfig'] });
      const schema = await sportRules.schemaFor(t.sportId, { version: r.schemaVersion, transaction });
      const preset = body.presetKey === undefined ? (r.presetKey === 'custom' ? null : r.presetKey) : body.presetKey;
      const values = body.rules ?? (body.presetKey !== undefined ? {} : r.values);
      const ruled = checkRules(schema, values, preset);
      const beforeRules = { values: r.values, tiebreakers: r.tiebreakers };
      await r.update(
        {
          presetKey: ruled.presetKey,
          values: ruled.values,
          formatConfig: body.formatConfig ? { ...r.formatConfig, ...body.formatConfig } : r.formatConfig,
          tiebreakers: body.tiebreakers ? tiebreakersFor(schema, body.tiebreakers) : r.tiebreakers,
          ...summaries(schema, ruled.values),
        },
        { transaction }
      );
      if (!editable) {
        await audit.record({ action: 'tournament.rules_changed', actor: principal, entityType: 'tournament_rules', entityId: t.id, before: beforeRules, after: { values: ruled.values, tiebreakers: r.tiebreakers }, req }, { transaction });
        await c.publish(transaction, 'tournament.rules_changed', 'tournament', t.id, { tournamentId: t.id });
        // Points or tiebreakers changed: every table is rebuilt (FR-09); placeholders already used by a
        // match with a result stay as they are.
        const scoring = require('../scoring/results.service');
        const stages = await Stage.findAll({ where: { tournamentId: t.id, status: { [Op.ne]: 'cancelled' }, kind: { [Op.ne]: 'knockout' } }, transaction });
        for (const st of stages) {
          const groups = st.kind === 'group' ? await require('../../models').Group.findAll({ where: { stageId: st.id }, transaction }) : [null];
          for (const g of groups) await scoring.rebuildInTx(t, st.id, g?.id ?? null, { transaction });
        }
      }
    }
    if (body.venues) await writeVenues(t, body.venues, { transaction, full: editable });
    await audit.record({ action: 'tournament.updated', actor: principal, entityType: 'tournament', entityId: t.id, before: Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]])), after: patch, req }, { transaction });
  }).catch(nameTaken);
  return detail(org, id);
}

/** POST …/submit (organisation admins): the checks, then M05 kind `tournament`. */
async function submit(principal, org, id, req) {
  await sequelize.transaction(async (transaction) => {
    const t = await c.ownTournament(org, id, { transaction, lock: true });
    if (!EDITABLE.includes(t.status)) throw c.fail('TOURNAMENT_STATE');
    const r = await c.rulesOf(t.id, transaction);
    const venues = await TournamentVenue.findAll({ where: { tournamentId: t.id, status: 'active' }, transaction });
    const { checks, errors } = await problemsOf(t, r, venues, { transaction });
    const hard = checks.filter((x) => x.severity === 'hard' && x.result === 'fail').map((x) => x.key);
    if (hard.length) throw c.fail('TOURNAMENT_INCOMPLETE', { checks: hard, errors });
    const sub = await moderation.submit(
      { kind: 'tournament', subjectId: t.id, payload: { tournamentId: t.id, organisationId: org.id, name: t.name, sportKey: (await sportRules.schemaFor(t.sportId, { transaction })).sport.key, fee: t.entryFeePoisha }, title: t.name, submittedBy: principal.id, isEdit: false },
      { transaction }
    );
    await t.update({ status: 'pending_review', currentSubmissionId: sub.id, reviewReason: null, updatedBy: principal.id }, { transaction });
    await audit.record({ action: 'tournament.submitted', actor: principal, entityType: 'tournament', entityId: t.id, meta: { submissionId: sub.id }, req }, { transaction });
    await c.publish(transaction, 'tournament.submitted', 'tournament', t.id, { tournamentId: t.id, organisationId: org.id });
  });
  return detail(org, id);
}

/** The M05 automatic checks of a tournament submission (§6.1). */
async function checksFor(tournamentId, { transaction } = {}) {
  const t = await Tournament.findByPk(tournamentId, { transaction });
  if (!t) return [];
  const r = await c.rulesOf(t.id, transaction);
  const venues = await TournamentVenue.findAll({ where: { tournamentId: t.id, status: 'active' }, transaction });
  return (await problemsOf(t, r, venues, { transaction })).checks;
}

const DECIDED = { changes_requested: 'tournament.changes_requested', rejected: 'tournament.rejected' };

/** M05 decisions (consumers in tournaments.moderation). Approval opens registration with snapshots. */
async function applyDecision(submissionId, status, { transaction }) {
  const sub = await moderation.getById(submissionId, { transaction });
  if (!sub) return null;
  const ack = () =>
    c.publish(transaction, 'submission.applied', 'submission', sub.id, { submissionId: sub.id, kind: sub.kind, subjectId: sub.subjectId, version: sub.version, submittedBy: sub.submittedBy });
  const t = await Tournament.findByPk(sub.payload.tournamentId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!t || t.currentSubmissionId !== sub.id || t.status !== 'pending_review') {
    if (status === 'approved') await ack();
    return null;
  }
  if (status === 'withdrawn') {
    await t.update({ status: 'draft', currentSubmissionId: null }, { transaction });
    return 'withdrawn';
  }
  if (status !== 'approved') {
    await t.update({ status, currentSubmissionId: null, reviewReason: { code: sub.reasonCode ?? null, text: sub.reasonText ?? null } }, { transaction });
    await audit.record({ action: DECIDED[status], actor: null, entityType: 'tournament', entityId: t.id, after: { status }, meta: { submissionId: sub.id, reasonCode: sub.reasonCode ?? null } }, { transaction });
    await c.publish(transaction, DECIDED[status], 'tournament', t.id, { tournamentId: t.id, organisationId: t.organisationId, reasonCode: sub.reasonCode ?? null });
    return status;
  }
  const snap = fee.snapshot('tournaments');
  await t.update({ status: 'registration_open', currentSubmissionId: null, reviewReason: null, approvedAt: new Date(), feeBps: snap.feeBps, releasePct: Math.round(settings.get('tournament.escrow_release_first_match_pct')) }, { transaction });
  await audit.record({ action: 'tournament.approved', actor: null, entityType: 'tournament', entityId: t.id, after: { status: t.status, feeBps: t.feeBps, releasePct: t.releasePct }, meta: { submissionId: sub.id } }, { transaction });
  await c.publish(transaction, 'tournament.approved', 'tournament', t.id, { tournamentId: t.id, organisationId: t.organisationId });
  await ack();
  return 'approved';
}

// ---------------------------------------------------------------- running a tournament

/** Closes registration (job at closes_at, or the organiser): unpaid and offered places lapse. */
async function closeInTx(t, { transaction, actor = null }) {
  if (!rules.can(rules.TOURNAMENT, t.status, 'registration_closed')) throw c.fail('TOURNAMENT_STATE');
  await require('./registrations.service').closeAllOpenInTx(t, { transaction });
  await t.update({ status: 'registration_closed', registrationClosesAt: t.registrationClosesAt && t.registrationClosesAt < new Date() ? t.registrationClosesAt : new Date() }, { transaction });
  const approved = await Registration.count({ where: { tournamentId: t.id, status: 'approved' }, transaction });
  await c.publish(transaction, 'tournament.registration_closed', 'tournament', t.id, { tournamentId: t.id, organisationId: t.organisationId, approved, belowMin: approved < t.minTeams }, actor);
}

async function closeRegistration(principal, org, id, req) {
  await sequelize.transaction(async (transaction) => {
    const t = await c.ownTournament(org, id, { transaction, lock: true });
    await closeInTx(t, { transaction, actor: principal });
    await audit.record({ action: 'tournament.registration_closed', actor: principal, entityType: 'tournament', entityId: t.id, req }, { transaction });
  });
  return detail(org, id);
}

/** POST …/registration/extend {closesAt}: once, before fixtures (FR-14). */
async function extendRegistration(principal, org, id, { closesAt }, req) {
  await sequelize.transaction(async (transaction) => {
    const t = await c.ownTournament(org, id, { transaction, lock: true });
    if (t.status !== 'registration_closed' || t.extended) throw c.fail('EXTEND_NOT_ALLOWED');
    if (await Match.count({ where: { tournamentId: t.id, status: { [Op.ne]: 'cancelled' } }, transaction })) throw c.fail('EXTEND_NOT_ALLOWED');
    const cfg = c.config();
    const block = rules.datesBlock({ ...t.toJSON(), registrationOpensAt: t.registrationOpensAt, registrationClosesAt: closesAt }, { closeDays: cfg.closeDays, minStartDays: 0, today: c.today() });
    if (block || new Date(closesAt) <= new Date()) throw c.fail(block ?? 'REGISTRATION_WINDOW_INVALID');
    await t.update({ status: 'registration_open', registrationClosesAt: closesAt, extended: true }, { transaction });
    await audit.record({ action: 'tournament.registration_extended', actor: principal, entityType: 'tournament', entityId: t.id, after: { closesAt }, req }, { transaction });
  });
  return detail(org, id);
}

/** POST …/rules/unlock {reason} (organisation admins): editable for rules_relock_hours (FR-09). */
async function unlockRules(principal, org, id, { reason }, req) {
  await sequelize.transaction(async (transaction) => {
    const t = await c.ownTournament(org, id, { transaction, lock: true });
    if (!t.rulesLockedAt || ['completed', 'cancelled'].includes(t.status)) throw c.fail('TOURNAMENT_STATE');
    const until = new Date(Date.now() + c.config().relockHours * 3600000);
    await t.update({ rulesUnlockedUntil: until }, { transaction });
    await audit.record({ action: 'tournament.rules_unlocked', actor: principal, entityType: 'tournament', entityId: t.id, after: { until: until.toISOString() }, meta: { reason }, req }, { transaction });
    await c.publish(transaction, 'tournament.rules_unlocked', 'tournament', t.id, { tournamentId: t.id, until: until.toISOString() }, principal);
  });
  return detail(org, id);
}

/** Locks the rules at the first result (and again after an unlock expires). */
async function lockRulesInTx(t, { transaction }) {
  if (t.rulesLockedAt && !t.rulesUnlockedUntil) return;
  await t.update({ rulesLockedAt: t.rulesLockedAt ?? new Date(), rulesUnlockedUntil: null }, { transaction });
  await c.publish(transaction, 'tournament.rules_relocked', 'tournament', t.id, { tournamentId: t.id });
}

/** Cancels with refunds (org owner, or a master): before the first result 100%, after it what is held. */
async function cancelInTx(t, { reason, actor, transaction }) {
  if (!rules.can(rules.TOURNAMENT, t.status, 'cancelled')) throw c.fail('TOURNAMENT_STATE');
  if (t.status === 'pending_review' && t.currentSubmissionId) await moderation.withdrawSubject('tournament', t.id, { transaction });
  await require('./registrations.service').cancelAllInTx(t, { transaction, actor });
  await Match.update({ status: 'cancelled', statusReason: 'tournament_cancelled' }, { where: { tournamentId: t.id, status: { [Op.in]: ['draft', 'scheduled', 'postponed', 'abandoned'] } }, transaction });
  await Stage.update({ status: 'cancelled' }, { where: { tournamentId: t.id, status: { [Op.ne]: 'cancelled' } }, transaction });
  await t.update({ status: 'cancelled', cancelledAt: new Date(), cancelledBy: actor?.id ?? null, cancelReason: reason, currentSubmissionId: null }, { transaction });
  await c.publish(transaction, 'tournament.cancelled', 'tournament', t.id, { tournamentId: t.id, organisationId: t.organisationId }, actor);
}

async function cancel(principal, org, id, { reason }, req) {
  await sequelize.transaction(async (transaction) => {
    const t = await c.ownTournament(org, id, { transaction, lock: true });
    if (org.role !== 'owner' && !['draft', 'changes_requested', 'pending_review', 'rejected'].includes(t.status)) throw E.forbidden('ORG_OWNER_ONLY', 'Only the organisation owner can cancel an event that teams have entered');
    await cancelInTx(t, { reason, actor: principal, transaction });
    await audit.record({ action: 'tournament.cancelled', actor: principal, entityType: 'tournament', entityId: t.id, meta: { reason }, req }, { transaction });
  });
  return detail(org, id);
}

async function adminCancel(principal, id, { reason }, req) {
  await sequelize.transaction(async (transaction) => {
    const t = await Tournament.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!t) throw E.notFound('Tournament');
    await cancelInTx(t, { reason, actor: principal, transaction });
    await audit.record({ action: 'tournament.cancelled', actor: principal, entityType: 'tournament', entityId: t.id, meta: { reason, staff: true }, req }, { transaction });
  });
  return adminGet(id);
}

// ---------------------------------------------------------------- reads

async function list(org, { status } = {}) {
  const rows = await Tournament.findAll({ where: { organisationId: org.id, ...(status ? { status } : {}) }, order: [['createdAt', 'DESC']], limit: 200 });
  return { items: await Promise.all(rows.map((t) => card(t))) };
}

async function detail(org, id) {
  const t = await c.ownTournament(org, id);
  return consoleView(t);
}

/** Overview KPIs and the setup checklist (§4.1), computed on the server. */
async function overview(org, id) {
  const t = await c.ownTournament(org, id);
  const regs = require('./registrations.service');
  const [n, matches, money, readiness] = await Promise.all([
    counts(t.id),
    Match.findAll({ where: { tournamentId: t.id, status: { [Op.ne]: 'cancelled' } }, attributes: ['status', 'scheduledStart', 'teamAId', 'teamBId', 'matchNo', 'published'] }),
    regs.moneyOf(t),
    regs.readinessSummary(t),
  ]);
  const done = matches.filter((m) => rules.TERMINAL_MATCH.includes(m.status)).length;
  const next = matches.filter((m) => !rules.TERMINAL_MATCH.includes(m.status) && m.scheduledStart).sort((a, b) => a.scheduledStart - b.scheduledStart)[0] ?? null;
  const unscheduled = matches.filter((m) => !m.scheduledStart).length;
  return {
    kpis: { approved: n.approved ?? 0, maxTeams: t.maxTeams, waiting: n.pending_approval ?? 0, reserve: n.reserve ?? 0, matches: matches.length, completed: done, nextMatchNo: next?.matchNo ?? null, nextAt: next?.scheduledStart?.toISOString() ?? null },
    money,
    checklist: [
      { key: 'rules', done: true },
      { key: 'approval', done: !['draft', 'pending_review', 'changes_requested', 'rejected'].includes(t.status) },
      { key: 'teams', done: (n.approved ?? 0) >= t.minTeams && !(n.pending_approval ?? 0) },
      { key: 'squads', done: readiness.notReady === 0 && (n.approved ?? 0) > 0 },
      { key: 'fixtures', done: matches.length > 0 },
      { key: 'scheduled', done: matches.length > 0 && unscheduled === 0 },
      { key: 'published', done: matches.length > 0 && matches.every((m) => m.published) },
      { key: 'payout_account', done: t.entryFeePoisha === 0 || Boolean(await require('../payouts/payout-accounts.service').activeFor(await organisations.ownerOf(t.organisationId))) },
    ],
  };
}

/** A list card (public and console). */
async function card(t) {
  const schema = await sportRules.schemaFor(t.sportId, {});
  const approved = await Registration.count({ where: { tournamentId: t.id, status: 'approved' } });
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    sport: { key: schema.sport.key, nameEn: schema.sport.nameEn, nameBn: schema.sport.nameBn },
    format: t.format,
    status: t.status,
    startDate: t.startDate,
    endDate: t.endDate,
    registrationClosesAt: t.registrationClosesAt?.toISOString() ?? null,
    entryFeePoisha: t.entryFeePoisha,
    prizePoolPoisha: t.prizePoolPoisha,
    approved,
    maxTeams: t.maxTeams,
    organisation: (await organisations.publicRefs([t.organisationId])).get(t.organisationId) ?? null,
  };
}

/** GET /tournaments?sport&status&q&cursor: public tournaments only (FR-23). */
async function publicList({ sport, status, q, limit = 24, offset = 0 } = {}) {
  const sportRow = sport ? await sportRules.bySportKey(sport) : null;
  const statuses = status === 'live' ? ['live'] : status === 'open' ? ['registration_open'] : status === 'completed' ? ['completed'] : ['registration_open', 'registration_closed', 'live', 'completed'];
  const where = { status: { [Op.in]: statuses }, ...(sportRow ? { sportId: sportRow.sport.id } : {}), ...(q ? { name: { [Op.iLike]: `%${q}%` } } : {}) };
  const rows = await Tournament.findAll({ where, order: [['startDate', status === 'completed' ? 'DESC' : 'ASC']], limit, offset });
  return { items: await Promise.all(rows.map((t) => card(t))) };
}

/** GET /tournaments/:slug: the hub (FR-23). Drafts and reviews are never public. */
async function publicDetail(slug) {
  const t = await Tournament.findOne({ where: { slug } });
  if (!t || !rules.PUBLIC.includes(t.status)) throw E.notFound('Tournament');
  const view = await consoleView(t);
  const fixtures = await require('./fixtures.service').publicFixtures(t);
  const teams = await require('./registrations.service').publicTeams(t);
  const standings = await require('../scoring/results.service').publicStandings(t);
  // The console-only fields never reach the public page.
  const PRIVATE = ['feeBps', 'releasePct', 'reviewReason', 'contactUserId', 'registrations', 'version', 'rulesUnlockedUntil'];
  const strip = Object.fromEntries(Object.entries(view).filter(([k]) => !PRIVATE.includes(k)));
  return {
    ...strip,
    organisation: (await organisations.publicRefs([t.organisationId])).get(t.organisationId) ?? null,
    window: rules.registrationWindow(t, new Date()),
    approved: view.registrations.approved ?? 0,
    fixtures,
    standings,
    teams,
  };
}

async function adminList({ status, q } = {}) {
  const rows = await Tournament.findAll({ where: { ...(status ? { status } : {}), ...(q ? { name: { [Op.iLike]: `%${q}%` } } : {}) }, order: [['updatedAt', 'DESC']], limit: 200 });
  return { items: await Promise.all(rows.map((t) => card(t))) };
}

async function adminGet(id) {
  const t = await Tournament.findByPk(id);
  if (!t) throw E.notFound('Tournament');
  const view = await consoleView(t);
  return { ...view, registrationList: await require('./registrations.service').staffList(t), money: await require('./registrations.service').moneyOf(t) };
}

// ---------------------------------------------------------------- the clock (tournaments.tick)

/** Registration closes at its time; unlocked rules lock again; idle tournaments complete. */
async function sweep(now = new Date()) {
  const due = await Tournament.findAll({ where: { status: 'registration_open', registrationClosesAt: { [Op.lte]: now } }, attributes: ['id'] });
  for (const { id } of due) {
    await sequelize.transaction(async (transaction) => {
      const t = await Tournament.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (t.status === 'registration_open' && t.registrationClosesAt <= now) await closeInTx(t, { transaction });
    });
  }
  const relock = await Tournament.findAll({ where: { rulesUnlockedUntil: { [Op.lte]: now } }, attributes: ['id'] });
  for (const { id } of relock) {
    await sequelize.transaction(async (transaction) => {
      const t = await Tournament.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (t.rulesUnlockedUntil && t.rulesUnlockedUntil <= now) await lockRulesInTx(t, { transaction });
    });
  }
}

module.exports = {
  slugify,
  tiebreakersFor,
  consoleView,
  create,
  update,
  submit,
  checksFor,
  applyDecision,
  closeInTx,
  closeRegistration,
  extendRegistration,
  unlockRules,
  lockRulesInTx,
  cancelInTx,
  cancel,
  adminCancel,
  list,
  detail,
  overview,
  card,
  publicList,
  publicDetail,
  adminList,
  adminGet,
  sweep,
};
