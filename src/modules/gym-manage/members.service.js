'use strict';

/**
 * M24 members (§5.2, §8.1): add (optionally with a membership and the first payment), list and search,
 * the profile, edit, the audited phone reveal, leave, re-join, remove, notes, the check-in calendar and
 * the member's photo.
 *  - Phone, email, emergency contact and health note are encrypted; the phone also keeps its keyed hash
 *    (matching, uniqueness among non-removed members) and its last 4 digits (display) (FR-11, FR-12).
 *  - Member codes {SHORT}-0001 come from the settings row under its lock: continuous, no gaps (FR-10).
 *  - Removed members leave every list and count except the owner's `status=removed` filter (FR-20).
 */
const crypto = require('crypto');
const { Op, QueryTypes, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { normalizePhone } = require('../../common/identifiers');
const storage = require('../../common/storage');
const velocity = require('../../common/velocity');
const { sniffMime, fileBlock, PHOTO_TYPES } = require('../../common/filetype');
const { uuid7 } = require('../../common/uuid7');
const { sequelize, GymMember, GymMembership, GymFreeze, GymDue, GymFeePayment, GymMemberNote, GymAttendance, GymLinkRequest } = require('../../models');
const directory = require('../users').directory;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');
const view = require('./gym-manage.serializer');
const memberships = require('./memberships.service');
const fees = require('./fees.service');

const { fail } = c;
const SEE = ['members.view', 'members.trainer'];

/** The member a caller may see: members.view sees all; a trainer-only caller only their assigned members (FR-23). */
async function visibleMember(a, memberId, { transaction } = {}) {
  const m = await GymMember.findOne({ where: { id: memberId, gymId: a.gym.id }, transaction });
  if (!m || (m.status === 'removed' && !a.owner)) throw E.notFound('Member');
  if (a.trainerScope !== undefined && m.trainerBusinessMemberId !== a.trainerScope) throw E.notFound('Member');
  return m;
}

/** A Bangladeshi mobile, normalised to +8801… (422 otherwise). */
function phoneOf(input, field = 'phone') {
  const p = normalizePhone(String(input ?? ''));
  if (!p) throw E.validation([{ field, message: 'Enter a Bangladesh mobile number' }]);
  return p;
}

async function phoneTaken(gymId, hash, { exceptId = null, transaction } = {}) {
  const other = await GymMember.findOne({ where: { gymId, phoneHash: hash, status: ['new', 'active', 'frozen', 'expired', 'left'] }, attributes: ['id'], transaction });
  return other && other.id !== exceptId ? other : null;
}

/**
 * Create a member inside a transaction that holds the settings row lock (member codes). Used by the
 * desk add, the import and an accepted join request (source platform, already linked to the requester:
 * `userId`, M24-FR-17). Publishes gym_member.added.
 */
async function createIn(transaction, { gym, settings, input, source, actor, today, importId = null, code = null, userId = null }) {
  const phone = phoneOf(input.phone);
  const hash = c.phoneHash(phone);
  const taken = await phoneTaken(gym.id, hash, { transaction });
  if (taken) throw fail('GYM_MEMBER_PHONE_TAKEN', { memberId: taken.id });
  const memberCode = code ?? (await c.nextMemberCode(settings, transaction));
  let m;
  try {
    m = await sequelize.transaction({ transaction }, (t) =>
      GymMember.create(
        {
          gymId: gym.id,
          ownerId: gym.ownerId,
          memberCode,
          displayName: input.displayName.trim(),
          phoneEnc: c.enc(phone),
          phoneHash: hash,
          phoneLast4: phone.slice(-4),
          emailEnc: c.enc(input.email),
          gender: input.gender ?? null,
          birthDate: input.birthDate ?? null,
          emergencyContactEnc: input.emergencyContact ? c.enc(JSON.stringify(input.emergencyContact)) : null,
          source,
          status: 'new',
          userId,
          linkedAt: userId ? new Date() : null,
          joinedOn: input.joinedOn ?? today,
          importId,
          createdBy: actor?.id ?? null,
          updatedBy: actor?.id ?? null,
        },
        { transaction: t }
      )
    );
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const again = await phoneTaken(gym.id, hash, { transaction });
      if (again) throw fail('GYM_MEMBER_PHONE_TAKEN', { memberId: again.id });
    }
    throw err;
  }
  if (input.notes) await GymMemberNote.create({ memberId: m.id, gymId: gym.id, body: input.notes, byUser: actor.id }, { transaction });
  await c.publish(transaction, 'gym_member.added', 'gym_member', m.id, { memberId: m.id, gymId: gym.id, ownerId: gym.ownerId, source, linked: Boolean(userId), by: actor?.id ?? null }, actor);
  return m;
}

/** POST /manage/gyms/:gymId/members [Idempotency-Key] (members.edit; refused while restricted; FR-10). */
async function add(principal, gymId, input, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit', { restricted: true });
  if (input.payment && !input.membership) throw E.validation([{ field: 'payment', message: 'A first payment needs a membership' }]);
  if (input.payment) c.needs(a, 'fees.collect');
  const now = new Date();
  const today = c.today(now);
  const made = await sequelize.transaction(async (transaction) => {
    const settings = await c.requireSetup(gymId, { transaction, lock: true });
    // M24-FR-92: the same person as a recent declined, expired or cancelled join request is a referral.
    const source = (await fees.matchesJoinRequest({ gymId, phoneHash: c.phoneHash(phoneOf(input.phone)), now, transaction })) ? 'platform' : 'desk';
    const member = await createIn(transaction, { gym: a.gym, settings, input, source, actor: a.actor, today });
    await c.record({ action: 'gym_member.added', actor: a.actor, entityType: 'gym_member', entityId: member.id, entityCode: member.memberCode, after: { displayName: member.displayName, phone: 'set', source }, meta: { gymId }, req }, transaction);
    const out = { member };
    if (input.membership) Object.assign(out, await memberships.assignIn(transaction, a, member, { ...input.membership, payment: input.payment }, { now }));
    return out;
  });
  const member = await GymMember.findByPk(made.member.id);
  return c.shown(a, {
    member: view.memberSummary(member),
    membership: made.membership ? view.membershipView(made.membership, { today, dueId: made.due.id }) : null,
    due: made.due ? await memberships.dueFor(a, await GymDue.findByPk(made.due.id), today) : null,
    payment: made.payment ? { id: made.payment.id, receiptNo: made.payment.receiptNo, amountPoisha: made.payment.amountPoisha, receiptUrl: c.receiptUrlOf(made.payment.id) } : null,
  });
}

// ---------------------------------------------------------------- list and search (FR-23)

const LIST_SQL = `
  WITH x AS (
    SELECT m.*, cur.id AS cur_id, cur.title AS cur_title, cur.package_id AS cur_package_id, cur.package_kind AS cur_kind,
           cur.starts_on AS cur_starts_on, cur.ends_on AS cur_ends_on, cur.status AS cur_status, cur.visit_limit AS cur_visit_limit,
           COALESCE(d.outstanding, 0)::bigint AS outstanding, COALESCE(d.overdue, false) AS overdue, la.last_date
      FROM gym_members m
      LEFT JOIN LATERAL (SELECT ms.* FROM gym_memberships ms WHERE ms.member_id = m.id AND ms.status IN ('active', 'frozen') LIMIT 1) cur ON true
      LEFT JOIN LATERAL (SELECT SUM(GREATEST(gd.amount_poisha - gd.paid_poisha - gd.waived_poisha, 0)) AS outstanding, BOOL_OR(gd.due_on < :today) AS overdue
                           FROM gym_dues gd WHERE gd.member_id = m.id AND gd.status IN ('unpaid', 'partial')) d ON true
      LEFT JOIN LATERAL (SELECT MAX(ga.local_date) AS last_date FROM gym_attendance ga WHERE ga.member_id = m.id AND ga.counted) la ON true
     WHERE m.gym_id = :gymId)
  SELECT * FROM x WHERE %WHERE% ORDER BY display_name ASC, id ASC LIMIT :limit`;

/** One list row (amounts only for callers who may collect fees). */
function listItem(r, { today, money, trainers }) {
  const member = {
    id: r.id,
    gymId: r.gym_id,
    memberCode: r.member_code,
    displayName: r.display_name,
    phoneLast4: r.phone_last4,
    gender: r.gender,
    status: r.status,
    source: r.source,
    userId: r.user_id,
    joinedOn: r.joined_on,
    photoKey: r.photo_key,
  };
  return {
    ...view.memberSummary(member),
    current: r.cur_id
      ? { membershipId: r.cur_id, title: r.cur_title, packageId: r.cur_package_id, packageKind: r.cur_kind, startsOn: r.cur_starts_on, endsOn: r.cur_ends_on, status: r.cur_status, daysLeft: rules.daysLeft({ startsOn: r.cur_starts_on, endsOn: r.cur_ends_on, today }) }
      : null,
    flags: { due: Number(r.outstanding) > 0, overdue: Boolean(r.overdue) },
    lastCheckInOn: r.last_date ?? null,
    trainer: trainerRef(r.trainer_business_member_id, trainers),
    ...(money ? { outstandingPoisha: Number(r.outstanding) } : {}),
  };
}

/** The assigned trainer as lists and profiles show it (a stale id, e.g. staff removed, still shows without a name). */
const trainerRef = (businessMemberId, trainers) => (businessMemberId ? { businessMemberId, displayName: trainers.get(businessMemberId) ?? null } : null);
const trainerNames = async (gymId) => new Map((await c.trainersOf(gymId)).map((x) => [x.businessMemberId, x.displayName]));

/** GET /manage/gyms/:gymId/members?status&due&overdue&expiring&frozen&notSeen&packageId&linked&trainerId&q&cursor&limit. */
async function list(principal, gymId, query = {}) {
  const a = await c.gymAccess(principal, gymId, null, { anyOf: SEE });
  const today = c.today();
  const { status, due, overdue, expiring, frozen, notSeen, packageId, linked, trainerId, q, cursor, limit = 25 } = query;
  const where = [];
  const rep = { gymId, today, limit: limit + 1 };
  if (status === 'removed' && !a.owner) c.needs(a, 'owner.only');
  if (status) {
    where.push('status = :status');
    rep.status = status;
  } else where.push("status <> 'removed'");
  if (a.trainerScope !== undefined) {
    where.push('trainer_business_member_id = :trainer');
    rep.trainer = a.trainerScope;
  }
  if (due) where.push('outstanding > 0');
  if (overdue) where.push('overdue');
  if (expiring) {
    where.push('cur_ends_on BETWEEN :today AND :soon');
    rep.soon = rules.addDays(today, rules.EXPIRING_DAYS);
  }
  if (frozen) where.push("cur_status = 'frozen'");
  if (notSeen) {
    // FR-53: a running membership older than the window and no counted check-in inside it.
    where.push("cur_id IS NOT NULL AND cur_starts_on <= :seenSince AND (last_date IS NULL OR last_date <= :seenSince)");
    rep.seenSince = rules.addDays(today, -notSeen);
  }
  if (packageId) {
    where.push('cur_package_id = :packageId');
    rep.packageId = packageId;
  }
  if (linked !== undefined) where.push(linked ? 'user_id IS NOT NULL' : 'user_id IS NULL');
  if (trainerId) {
    // M24-FR-23: the trainer filter (a trainer-only caller is already scoped to themselves).
    where.push('trainer_business_member_id = :trainerId');
    rep.trainerId = trainerId;
  }
  if (q) {
    const phone = normalizePhone(q);
    rep.q = q;
    rep.qLike = `%${q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
    rep.code = q.trim().toUpperCase();
    rep.hash = phone ? c.phoneHash(phone) : '-';
    where.push('(member_code = :code OR phone_hash = :hash OR display_name ILIKE :qLike OR display_name % :q)');
  }
  const after = c.parseCursor(cursor);
  if (after) {
    where.push('(display_name, id) > (:afterName, :afterId)');
    rep.afterName = after[0];
    rep.afterId = after[1];
  }
  const rows = await sequelize.query(LIST_SQL.replace('%WHERE%', where.join(' AND ')), { replacements: rep, type: QueryTypes.SELECT });
  const page = rows.slice(0, limit);
  const money = a.can('fees.collect');
  const trainers = page.some((r) => r.trainer_business_member_id) ? await trainerNames(gymId) : new Map();
  return c.shown(a, { items: page.map((r) => listItem(r, { today, money, trainers })), nextCursor: rows.length > limit ? c.cursorOf([page.at(-1).display_name, page.at(-1).id]) : null });
}

// ---------------------------------------------------------------- profile

/** The profile (FR-15, FR-106): what the gym typed, the link state, memberships, dues (amounts with fees.collect). */
async function profile(a, m, today) {
  const [mss, dueRows, payments, pending, notesCount] = await Promise.all([
    GymMembership.findAll({ where: { memberId: m.id }, order: [['startsOn', 'DESC'], ['createdAt', 'DESC']] }),
    GymDue.findAll({ where: { memberId: m.id }, order: [['dueOn', 'DESC']] }),
    GymFeePayment.findAll({ where: { memberId: m.id }, order: [['createdAt', 'ASC']] }),
    GymLinkRequest.findOne({ where: { memberId: m.id, status: 'pending', direction: 'gym_invite' } }),
    GymMemberNote.count({ where: { memberId: m.id } }),
  ]);
  const freezes = await GymFreeze.findAll({ where: { membershipId: mss.map((x) => x.id) }, order: [['fromOn', 'ASC']] });
  const names = await directory.displayNames(payments.map((p) => p.receivedBy).filter(Boolean));
  const money = a.can('fees.collect');
  const edit = a.can('members.edit');
  const dueByMs = new Map(dueRows.map((d) => [d.membershipId, d.id]));
  return {
    member: {
      ...view.memberSummary(m),
      birthDate: m.birthDate ?? null,
      // §7.3: email and emergency contact for the owner and members.edit; the health note for the owner (and plans.manage, prompt 3).
      ...(edit ? { email: c.dec(m.emailEnc), emergencyContact: c.decJson(m.emergencyContactEnc) } : {}),
      ...(a.owner || a.can('plans.manage') ? { healthNote: c.dec(m.healthNoteEnc), healthNoteBy: m.healthNoteBy ?? null } : {}),
      leftOn: m.leftOn ?? null,
      leftReason: m.leftReason ?? null,
      removedAt: c.iso(m.removedAt),
      removedReason: m.removedReason ?? null,
      importId: m.importId ?? null,
      version: m.version,
      createdAt: c.iso(m.createdAt),
      notesCount,
      trainer: trainerRef(m.trainerBusinessMemberId, m.trainerBusinessMemberId ? await trainerNames(m.gymId) : new Map()),
    },
    link: { linked: Boolean(m.userId), linkedAt: c.iso(m.linkedAt), unlinkedAt: c.iso(m.unlinkedAt), pendingInvite: pending ? { id: pending.id, expiresAt: c.iso(pending.expiresAt), accountKnown: Boolean(pending.userId) } : null },
    memberships: mss.map((ms) => view.membershipView(ms, { today, freezes: freezes.filter((f) => f.membershipId === ms.id), dueId: dueByMs.get(ms.id) ?? null })),
    dues: dueRows.map((d) => view.dueView(d, { today, payments: payments.filter((p) => p.dueId === d.id), names, money })),
    can: { edit, collect: money, adjust: a.can('fees.adjust'), revealPhone: edit, remove: a.owner, assignTrainer: edit, plans: a.can('plans.manage') },
  };
}

/** GET /manage/gyms/:gymId/members/:memberId (members.view or the assigned trainer). */
async function get(principal, gymId, memberId) {
  const a = await c.gymAccess(principal, gymId, null, { anyOf: SEE });
  const m = await visibleMember(a, memberId);
  return c.shown(a, await profile(a, m, c.today()));
}

/** PATCH /manage/gyms/:gymId/members/:memberId { version, … } (members.edit; FR-13). Encrypted fields audit as "changed". */
async function update(principal, gymId, memberId, input, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit', { restricted: true });
  await sequelize.transaction(async (transaction) => {
    const m = await memberships.lockedMember(gymId, memberId, transaction);
    if (m.status === 'removed') throw fail('GYM_MEMBER_STATE', { reason: 'removed' });
    if (m.version !== input.version) throw fail('VERSION_CONFLICT', { version: m.version });
    const changes = {};
    const before = {};
    const after = {};
    for (const k of ['displayName', 'gender', 'birthDate']) {
      if (input[k] !== undefined && input[k] !== m[k]) {
        before[k] = m[k] ?? null;
        after[k] = input[k];
        changes[k] = input[k];
      }
    }
    if (input.phone !== undefined) {
      const phone = phoneOf(input.phone);
      const hash = c.phoneHash(phone);
      if (hash !== m.phoneHash) {
        const taken = await phoneTaken(gymId, hash, { exceptId: m.id, transaction });
        if (taken) throw fail('GYM_MEMBER_PHONE_TAKEN', { memberId: taken.id });
        Object.assign(changes, { phoneEnc: c.enc(phone), phoneHash: hash, phoneLast4: phone.slice(-4) });
        before.phone = 'changed';
        after.phone = 'changed';
      }
    }
    if (input.email !== undefined) {
      changes.emailEnc = c.enc(input.email);
      after.email = 'changed';
    }
    if (input.emergencyContact !== undefined) {
      changes.emergencyContactEnc = input.emergencyContact ? c.enc(JSON.stringify(input.emergencyContact)) : null;
      after.emergencyContact = 'changed';
    }
    if (!Object.keys(changes).length) return;
    await m.update({ ...changes, version: m.version + 1, updatedBy: principal.id }, { transaction });
    await c.record({ action: 'gym_member.updated', actor: a.actor, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, before, after, meta: { gymId }, req }, transaction);
  });
  return get(principal, gymId, memberId);
}

/** POST …/members/:memberId/reveal-phone (members.edit): the full number, no-store, audited, rate-limited per staff member (FR-12). */
async function revealPhone(principal, gymId, memberId, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit');
  const m = await visibleMember(a, memberId);
  const hit = await velocity.hit({ name: 'gym_phone_reveal', scope: principal.id, limit: c.cfg().phoneRevealsPerHour, windowMs: 3600000 });
  if (!hit.allowed) throw E.tooMany('RATE_LIMITED', 'Too many requests', 'Slow down and try again shortly.', { retryAfter: hit.retryAfter });
  await c.record({ action: 'gym_member.phone_revealed', actor: a.actor, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, meta: { gymId }, req });
  return { memberId: m.id, phone: c.dec(m.phoneEnc) };
}

// ---------------------------------------------------------------- leave, re-join, remove (FR-19, FR-20)

/** POST …/members/:memberId/leave { reason, leftOn, note? }: running and upcoming memberships end; unpaid dues stay. */
async function leave(principal, gymId, memberId, { reason, leftOn, note }, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit', { restricted: true });
  const today = c.today();
  const day = leftOn ?? today;
  if (!rules.inWindow({ date: day, today, back: c.cfg().backdateDays })) throw fail('GYM_DATE_OUT_OF_RANGE', { from: rules.addDays(today, -c.cfg().backdateDays), to: today });
  await sequelize.transaction(async (transaction) => {
    const m = await memberships.lockedMember(gymId, memberId, transaction);
    if (['left', 'removed'].includes(m.status)) throw fail('GYM_MEMBER_STATE', { reason: m.status });
    const open = await GymMembership.findAll({ where: { memberId: m.id, status: memberships.OPEN }, transaction, lock: transaction.LOCK.UPDATE });
    for (const ms of open) await memberships.cancelIn(transaction, { ms, member: m, reason: 'member_left', today, actor: a.actor, endOn: day, by: principal.id });
    await m.reload({ transaction });
    await m.update({ status: 'left', leftOn: day, leftReason: reason, version: m.version + 1, updatedBy: principal.id }, { transaction });
    if (note) await GymMemberNote.create({ memberId: m.id, gymId, body: note, byUser: principal.id }, { transaction });
    await c.publish(transaction, 'gym_member.left', 'gym_member', m.id, { memberId: m.id, gymId, ownerId: a.gym.ownerId, by: principal.id, reason }, a.actor);
    await c.record({ action: 'gym_member.left', actor: a.actor, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, after: { leftOn: day, leftReason: reason }, meta: { gymId }, req }, transaction);
  });
  return get(principal, gymId, memberId);
}

/** POST …/members/:memberId/rejoin: back to `new`, keeping the member code; a new membership makes them active. */
async function rejoin(principal, gymId, memberId, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit', { restricted: true });
  await sequelize.transaction(async (transaction) => {
    const m = await memberships.lockedMember(gymId, memberId, transaction);
    if (m.status !== 'left') throw fail('GYM_MEMBER_STATE', { reason: m.status });
    await m.update({ status: 'new', leftOn: null, leftReason: null, version: m.version + 1, updatedBy: principal.id }, { transaction });
    await c.publish(transaction, 'gym_member.rejoined', 'gym_member', m.id, { memberId: m.id, gymId, ownerId: a.gym.ownerId, by: principal.id }, a.actor);
    await c.record({ action: 'gym_member.rejoined', actor: a.actor, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, after: { status: 'new' }, meta: { gymId }, req }, transaction);
  });
  return get(principal, gymId, memberId);
}

/**
 * Remove inside a transaction on a locked member (owner route, import undo): unpaid dues void, open
 * memberships and pending invites cancelled. Refused while a due holds payments (reverse them first).
 */
async function removeIn(transaction, { m, reason, actor, by, today }) {
  if (m.status === 'removed') throw fail('GYM_MEMBER_STATE', { reason: 'removed' });
  const paid = await GymDue.count({ where: { memberId: m.id, paidPoisha: { [Op.gt]: 0 } }, transaction });
  if (paid) throw fail('GYM_MEMBER_STATE', { reason: 'has_payments' });
  const open = await GymMembership.findAll({ where: { memberId: m.id, status: memberships.OPEN }, transaction, lock: transaction.LOCK.UPDATE });
  for (const ms of open) await memberships.cancelIn(transaction, { ms, member: m, reason: 'member_removed', today, actor, by });
  const openDues = await GymDue.findAll({ where: { memberId: m.id, status: ['unpaid', 'partial'] }, attributes: ['id'], transaction });
  await GymDue.update({ status: 'void', voidedAt: new Date(), voidReason: 'member_removed' }, { where: { memberId: m.id, status: ['unpaid', 'partial'] }, transaction });
  for (const d of openDues) await require('./dues.service').cancelLinksIn(transaction, { dueId: d.id });
  await GymLinkRequest.update({ status: 'cancelled', decidedAt: new Date(), decidedBy: by }, { where: { memberId: m.id, status: 'pending' }, transaction });
  // §8.8: a removed member's plans end (the logs stay with the gym).
  await require('./plans.service').endForMemberIn(transaction, { member: m, reason: 'member_removed', actor });
  await m.reload({ transaction });
  await m.update({ status: 'removed', removedAt: new Date(), removedReason: reason, leftOn: null, leftReason: null, version: m.version + 1, updatedBy: by }, { transaction });
  await c.publish(transaction, 'gym_member.removed', 'gym_member', m.id, { memberId: m.id, gymId: m.gymId, ownerId: m.ownerId, by }, actor);
}

/** POST …/members/:memberId/remove { reason } (owner only; FR-20). */
async function remove(principal, gymId, memberId, { reason }, req) {
  const a = await c.gymAccess(principal, gymId, 'owner.only', { restricted: true });
  const today = c.today();
  await sequelize.transaction(async (transaction) => {
    const m = await memberships.lockedMember(gymId, memberId, transaction);
    await removeIn(transaction, { m, reason, actor: a.actor, by: principal.id, today });
    await c.record({ action: 'gym_member.removed', actor: a.actor, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, after: { status: 'removed' }, reason, meta: { gymId }, req }, transaction);
  });
  return get(principal, gymId, memberId);
}

// ---------------------------------------------------------------- notes (FR-22) and the calendar

/** GET …/members/:memberId/notes (whoever can see the member; never shown to the member). */
async function notes(principal, gymId, memberId) {
  const a = await c.gymAccess(principal, gymId, null, { anyOf: SEE });
  const m = await visibleMember(a, memberId);
  const rows = await GymMemberNote.findAll({ where: { memberId: m.id }, order: [['createdAt', 'DESC']], limit: 200 });
  const names = await directory.displayNames(rows.map((r) => r.byUser));
  return { items: rows.map((r) => view.noteView(r, names)) };
}

/** POST …/members/:memberId/notes { body }: append-only. */
async function addNote(principal, gymId, memberId, { body }, req) {
  const a = await c.gymAccess(principal, gymId, null, { anyOf: SEE });
  const m = await visibleMember(a, memberId);
  const row = await sequelize.transaction(async (transaction) => {
    const n = await GymMemberNote.create({ memberId: m.id, gymId, body, byUser: principal.id }, { transaction });
    await c.record({ action: 'gym_member.note_added', actor: a.actor, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, meta: { gymId, noteId: n.id }, req }, transaction);
    return n;
  });
  const names = await directory.displayNames([principal.id]);
  return view.noteView(row, names);
}

/** The counted check-ins of a member in a month (YYYY-MM, default this Dhaka month). */
async function calendarOf(memberId, month) {
  const first = `${month}-01`;
  const next = `${rules.addDays(first, 31).slice(0, 7)}-01`;
  const rows = await GymAttendance.findAll({ where: { memberId, counted: true, localDate: { [Op.gte]: first, [Op.lt]: next } }, order: [['localDate', 'ASC']] });
  return { month, count: rows.length, days: rows.map((r) => ({ date: r.localDate, at: c.iso(r.checkedInAt), method: r.method })) };
}

/** GET …/members/:memberId/attendance?month (whoever can see the member). */
async function attendance(principal, gymId, memberId, { month } = {}) {
  const a = await c.gymAccess(principal, gymId, null, { anyOf: SEE });
  const m = await visibleMember(a, memberId);
  return calendarOf(m.id, month ?? rules.monthOf(c.today()));
}

// ---------------------------------------------------------------- photo (private bucket)

/** PUT …/members/:memberId/photo (raw JPEG, PNG or WebP; members.edit). */
async function setPhoto(principal, gymId, memberId, { contentType, body }, req) {
  const a = await c.gymAccess(principal, gymId, 'members.edit', { restricted: true });
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const block = fileBlock({ declared, sniffed: sniffMime(buf), size: buf.length, max: c.cfg().photoMaxBytes });
  if (block) throw fail(block);
  const m = await visibleMember(a, memberId);
  if (m.status === 'removed') throw fail('GYM_MEMBER_STATE', { reason: 'removed' });
  const key = `gym-members/${gymId}/${m.id}/${uuid7()}.${PHOTO_TYPES[declared]}`;
  await storage.putPrivate(key, buf, declared);
  await sequelize.transaction(async (transaction) => {
    await m.update({ photoKey: key, version: m.version + 1, updatedBy: principal.id }, { transaction });
    await c.record({ action: 'gym_member.photo_set', actor: a.actor, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, meta: { gymId, sizeBytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') }, req }, transaction);
  });
  return { photoPath: view.photoPath(m) };
}

/** GET …/members/:memberId/photo: the stored photo, streamed (never cached). */
async function getPhoto(principal, gymId, memberId) {
  const a = await c.gymAccess(principal, gymId, null, { anyOf: SEE });
  const m = await visibleMember(a, memberId);
  if (!m.photoKey) throw E.notFound('Photo');
  const obj = await storage.getPrivate(m.photoKey);
  return { body: obj.body, mime: obj.contentType ?? 'image/jpeg' };
}

module.exports = { SEE, visibleMember, phoneOf, phoneTaken, createIn, add, list, profile, get, update, revealPhone, leave, rejoin, removeIn, remove, notes, addNote, calendarOf, attendance, setPhoto, getPhoto };
