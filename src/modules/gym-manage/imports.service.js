'use strict';

/**
 * M24 member list imports (§5.10): CSV (csv-parse) or Excel (exceljs) on the template, previewed,
 * applied, undone within the window, discarded; app invites only when the owner asks (FR-78, G10).
 *  - Upload (owner, or Kriraghor staff with manage_gyms while the owner's consent lasts, FR-79): at most
 *    gym_manage.import_max_bytes and gym_manage.import_max_rows. The raw file goes to the private bucket;
 *    the preview lists every row as ok or with its errors. Nothing else is saved (FR-75). The stored
 *    report keeps no phone (the last 4 digits only).
 *  - Apply (owner, Idempotency-Key, FR-76): re-reads the file and re-checks every row against today's
 *    members, then creates members (source import), memberships (the file's dates, status by today) and
 *    dues (amount due unpaid; the last payment as a row with method `opening`).
 *  - Undo (owner, within gym_manage.import_undo_hours, FR-77): refused when any imported member has a
 *    later payment, check-in, membership change or waiver; otherwise opening payments are reversed,
 *    dues void, memberships cancelled and members removed.
 *  - Housekeeping (job): raw files deleted after gym_manage.import_file_retention_days (FR-80);
 *    previews older than PREVIEW_DAYS discarded (§10).
 */
const crypto = require('crypto');
const { Op } = require('sequelize');
const { parse } = require('csv-parse/sync');
const ExcelJS = require('exceljs');
const { E } = require('../../common/errors');
const storage = require('../../common/storage');
const logger = require('../../common/logger');
const { uuid7 } = require('../../common/uuid7');
const { sequelize, GymImport, GymMember, GymMembership, GymFreeze, GymDue, GymFeePayment, GymAttendance } = require('../../models');
const packagesFacade = require('../gym').packages;
const gymFacade = require('../gym').gyms;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');
const memberships = require('./memberships.service');
const membersSvc = require('./members.service');
const dues = require('./dues.service');
const links = require('./links.service');

const { fail } = c;
/** §10: previews nobody applied are discarded after this many days (a spec constant of the job). */
const PREVIEW_DAYS = 7;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---------------------------------------------------------------- reading a file

const isZip = (buf) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

/** A spreadsheet cell as text or a Date (formulas give their result, links their text). */
function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v !== 'object') return v;
  if (v.result !== undefined) return cellValue(v.result);
  if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
  if (v.text !== undefined) return cellValue(v.text);
  return null;
}

/** Rows of cell values (header first) from CSV or XLSX; blank rows dropped. */
async function readRows(buf, contentType) {
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  let rows;
  if (isZip(buf)) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buf);
    } catch {
      throw fail('GYM_IMPORT_INVALID', { reason: 'unreadable' });
    }
    const ws = wb.worksheets[0];
    if (!ws) throw fail('GYM_IMPORT_INVALID', { reason: 'unreadable' });
    rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1).map(cellValue)));
  } else {
    if (declared === XLSX || buf.includes(0)) throw fail('GYM_IMPORT_INVALID', { reason: 'not_csv_or_xlsx' });
    try {
      rows = parse(buf.toString('utf8'), { bom: true, relax_column_count: true, skip_empty_lines: true, trim: true });
    } catch {
      throw fail('GYM_IMPORT_INVALID', { reason: 'unreadable' });
    }
  }
  return { kind: isZip(buf) ? 'xlsx' : 'csv', rows: rows.filter((r) => r.some((x) => x !== null && x !== undefined && String(x).trim() !== '')) };
}

/** The gym's current state the rows are checked against: desk packages, phones and codes in use. */
async function stateOf(gymId, { transaction } = {}) {
  const pkgs = await packagesFacade.forGym(gymId, { transaction });
  const existing = await GymMember.findAll({ where: { gymId }, attributes: ['phoneHash', 'memberCode', 'status'], transaction });
  return {
    packages: pkgs.filter((p) => p.channel !== 'online'),
    existingHashes: new Set(existing.filter((m) => m.status !== 'removed').map((m) => m.phoneHash)),
    existingCodes: new Set(existing.map((m) => m.memberCode)),
  };
}

/** Parse and check a file; throws GYM_IMPORT_INVALID for a bad file, returns per-row results. */
async function check(buf, contentType, gymId, { transaction } = {}) {
  const cfg = c.cfg();
  if (!buf.length) throw fail('GYM_IMPORT_INVALID', { reason: 'empty' });
  if (buf.length > cfg.importMaxBytes) throw fail('GYM_IMPORT_INVALID', { reason: 'too_large', max: cfg.importMaxBytes });
  const { kind, rows } = await readRows(buf, contentType);
  if (!rows.length) throw fail('GYM_IMPORT_INVALID', { reason: 'empty' });
  const hm = rules.headerMap(rows[0]);
  if (hm.missing) throw fail('GYM_IMPORT_INVALID', { reason: 'columns', missing: hm.missing });
  const data = rows.slice(1);
  if (data.length > cfg.importMaxRows) throw fail('GYM_IMPORT_INVALID', { reason: 'too_many_rows', max: cfg.importMaxRows });
  const state = await stateOf(gymId, { transaction });
  const results = rules.validateImportRows(data, { map: hm.map, ...state, hashPhone: c.phoneHash, today: c.today() });
  return { kind, results, packages: state.packages };
}

/** The stored report row: no phone beyond its last 4 digits. */
function reportRow(r, packages, memberId = null) {
  const v = r.value;
  return {
    n: r.n,
    status: r.status,
    errors: r.errors,
    displayName: v.name || null,
    phoneLast4: v.phone ? v.phone.slice(-4) : null,
    memberCode: v.memberCode,
    package: v.packageId ? packages.find((p) => p.id === v.packageId)?.title ?? null : null,
    startsOn: v.startsOn,
    endsOn: v.endsOn,
    lastPaidPoisha: v.lastPaid,
    lastPaidOn: v.lastPaidOn,
    amountDuePoisha: v.amountDue,
    memberId,
  };
}

function importView(imp, now = new Date()) {
  return {
    id: imp.id,
    gymId: imp.gymId,
    fileName: imp.fileName,
    fileBytes: imp.fileBytes,
    status: imp.status,
    uploadedAs: imp.uploadedAs,
    rowsTotal: imp.rowsTotal,
    rowsOk: imp.rowsOk,
    rowsFailed: imp.rowsFailed,
    createdAt: c.iso(imp.createdAt),
    appliedAt: c.iso(imp.appliedAt),
    undoUntil: c.iso(imp.undoUntil),
    undoneAt: c.iso(imp.undoneAt),
    invitesSentAt: c.iso(imp.invitesSentAt),
    filePurged: Boolean(imp.filePurgedAt),
    can: {
      apply: imp.status === 'previewed' && !imp.filePurgedAt && imp.rowsOk > 0,
      undo: imp.status === 'applied' && imp.undoUntil > now,
      discard: imp.status === 'previewed',
      sendInvites: imp.status === 'applied' && !imp.invitesSentAt,
    },
    report: imp.report,
  };
}

// ---------------------------------------------------------------- upload (owner or Kriraghor staff)

async function store(gym, { body, contentType, fileName }, { uploadedBy, uploadedAs, actor, req }) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const { kind, results, packages } = await check(buf, contentType, gym.id);
  const id = uuid7();
  const key = `gym-imports/${gym.id}/${id}.${kind}`;
  await storage.putPrivate(key, buf, kind === 'xlsx' ? XLSX : 'text/csv');
  const ok = results.filter((r) => r.status === 'ok').length;
  const imp = await sequelize.transaction(async (transaction) => {
    const row = await GymImport.create(
      {
        id,
        gymId: gym.id,
        ownerId: gym.ownerId,
        fileKey: key,
        fileName: String(fileName || `members.${kind}`).slice(0, 200),
        fileSha256: crypto.createHash('sha256').update(buf).digest('hex'),
        fileBytes: buf.length,
        rowsTotal: results.length,
        rowsOk: ok,
        rowsFailed: results.length - ok,
        report: results.map((r) => reportRow(r, packages)),
        status: 'previewed',
        uploadedBy,
        uploadedAs,
      },
      { transaction }
    );
    await c.publish(transaction, 'gym_import.previewed', 'gym_import', row.id, { importId: row.id, gymId: gym.id, rowsOk: ok, rowsFailed: results.length - ok, by: uploadedBy }, actor);
    await c.record({ action: 'gym_import.previewed', actor, entityType: 'gym_import', entityId: row.id, after: { rowsOk: ok, rowsFailed: results.length - ok, uploadedAs }, meta: { gymId: gym.id, fileBytes: buf.length }, req }, transaction);
    return row;
  });
  return importView(imp);
}

/** POST /manage/gyms/:gymId/imports (owner; raw CSV or XLSX; refused while restricted). */
async function upload(principal, gymId, file, req) {
  const a = await c.gymAccess(principal, gymId, 'owner.only', { restricted: true });
  await c.requireSetup(gymId);
  return store(a.gym, file, { uploadedBy: principal.id, uploadedAs: 'owner', actor: a.actor, req });
}

/** POST /admin/gym-manage/gyms/:gymId/imports (staff with manage_gyms, while the owner's consent lasts; preview only). */
async function adminUpload(staff, gymId, file, req) {
  const gym = await gymFacade.get(gymId);
  if (!gym) throw E.notFound('Gym');
  const s = await c.settingsOf(gymId);
  if (!s?.importConsentUntil || s.importConsentUntil <= new Date()) throw fail('GYM_IMPORT_CONSENT_REQUIRED');
  return store(gym, file, { uploadedBy: staff.id, uploadedAs: 'staff', actor: staff, req });
}

async function ownImport(gymId, importId, { transaction, lock = false } = {}) {
  const imp = await GymImport.findOne({ where: { id: importId, gymId }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!imp) throw E.notFound('Import');
  return imp;
}

/** GET /manage/gyms/:gymId/imports/:importId (owner). */
async function get(principal, gymId, importId) {
  await c.gymAccess(principal, gymId, 'owner.only');
  return importView(await ownImport(gymId, importId));
}

/** GET /manage/gyms/:gymId/imports (owner): the gym's imports, newest first (without row reports). */
async function list(principal, gymId) {
  await c.gymAccess(principal, gymId, 'owner.only');
  const rows = await GymImport.findAll({ where: { gymId }, order: [['createdAt', 'DESC']], limit: 50 });
  return { items: rows.map((r) => ({ ...importView(r), report: undefined })) };
}

// ---------------------------------------------------------------- apply (FR-76)

async function readStored(imp) {
  if (!imp.fileKey || imp.filePurgedAt) throw fail('GYM_IMPORT_STATE', { reason: 'file_purged' });
  const obj = await storage.getPrivate(imp.fileKey);
  if (Buffer.isBuffer(obj.body)) return obj.body;
  const chunks = [];
  for await (const ch of obj.body) chunks.push(ch);
  return Buffer.concat(chunks);
}

/** POST /manage/gyms/:gymId/imports/:importId/apply [Idempotency-Key] (owner; refused while restricted). */
async function apply(principal, gymId, importId, req) {
  const a = await c.gymAccess(principal, gymId, 'owner.only', { restricted: true });
  const now = new Date();
  const today = c.today(now);
  const cfg = c.cfg();
  await sequelize.transaction(async (transaction) => {
    const imp = await ownImport(gymId, importId, { transaction, lock: true });
    if (imp.status !== 'previewed') throw fail('GYM_IMPORT_STATE', { status: imp.status });
    const buf = await readStored(imp);
    const settings = await c.requireSetup(gymId, { transaction, lock: true });
    const { results, packages } = await check(buf, imp.fileKey.endsWith('.xlsx') ? XLSX : 'text/csv', gymId, { transaction });
    const report = [];
    let ok = 0;
    for (const r of results) {
      if (r.status !== 'ok') {
        report.push(reportRow(r, packages));
        continue;
      }
      const v = r.value;
      const member = await membersSvc.createIn(transaction, {
        gym: a.gym,
        settings,
        input: { displayName: v.name, phone: v.phone, gender: v.gender, birthDate: v.birthDate, joinedOn: v.startsOn ?? today },
        source: 'import',
        actor: a.actor,
        today,
        importId: imp.id,
        code: v.memberCode,
      });
      if (v.packageId) {
        const pkg = packages.find((p) => p.id === v.packageId);
        const status = rules.statusByDate({ startsOn: v.startsOn, endsOn: v.endsOn, today });
        const made = await memberships.createIn(transaction, { gym: a.gym, member, pkg, startsOn: v.startsOn, endsOn: v.endsOn, status, origin: 'import', amount: v.amountDue + v.lastPaid, actor: a.actor, today });
        if (status === 'expired') await member.update({ status: 'expired' }, { transaction });
        if (v.lastPaid > 0) {
          await dues.recordIn(transaction, { gym: a.gym, member, due: made.due, amount: v.lastPaid, method: 'opening', paidOn: v.lastPaidOn, receivedBy: principal.id, actor: a.actor, importId: imp.id, now, min: 1 });
        }
      }
      ok += 1;
      report.push(reportRow(r, packages, member.id));
    }
    await imp.update({ status: 'applied', appliedAt: now, appliedBy: principal.id, undoUntil: new Date(now.getTime() + cfg.importUndoHours * 3600000), rowsTotal: results.length, rowsOk: ok, rowsFailed: results.length - ok, report }, { transaction });
    await c.publish(transaction, 'gym_import.applied', 'gym_import', imp.id, { importId: imp.id, gymId, rowsOk: ok, rowsFailed: results.length - ok, by: principal.id }, a.actor);
    await c.record({ action: 'gym_import.applied', actor: a.actor, entityType: 'gym_import', entityId: imp.id, after: { rowsOk: ok, rowsFailed: results.length - ok }, meta: { gymId }, req }, transaction);
  });
  return importView(await GymImport.findByPk(importId));
}

// ---------------------------------------------------------------- undo (FR-77), discard, invites, consent

/** The imported members with activity after the import (codes), which block the undo. */
async function blockers(imp, members, transaction) {
  const ids = members.map((m) => m.id);
  if (!ids.length) return [];
  // One after another: inside a transaction the queries share one connection.
  const payments = await GymFeePayment.findAll({ where: { memberId: ids, [Op.or]: [{ importId: null }, { importId: { [Op.ne]: imp.id } }] }, attributes: ['memberId'], transaction });
  const visits = await GymAttendance.findAll({ where: { memberId: ids }, attributes: ['memberId'], transaction });
  const changed = await GymMembership.findAll({ where: { memberId: ids, [Op.or]: [{ origin: { [Op.ne]: 'import' } }, { status: ['changed', 'cancelled', 'frozen'] }] }, attributes: ['memberId'], transaction });
  const msIds = (await GymMembership.findAll({ where: { memberId: ids }, attributes: ['id'], transaction })).map((x) => x.id);
  const freezes = await GymFreeze.findAll({ where: { membershipId: msIds }, attributes: ['membershipId'], transaction });
  const waived = await GymDue.findAll({ where: { memberId: ids, waivedPoisha: { [Op.gt]: 0 } }, attributes: ['memberId'], transaction });
  const frozenMs = freezes.length ? await GymMembership.findAll({ where: { id: freezes.map((f) => f.membershipId) }, attributes: ['memberId'], transaction }) : [];
  const busy = new Set([...payments, ...visits, ...changed, ...frozenMs, ...waived].map((r) => r.memberId));
  for (const m of members) if (m.status === 'left') busy.add(m.id);
  return members.filter((m) => busy.has(m.id)).map((m) => m.memberCode);
}

/** POST /manage/gyms/:gymId/imports/:importId/undo (owner): within the window and with no later activity. */
async function undo(principal, gymId, importId, req) {
  const a = await c.gymAccess(principal, gymId, 'owner.only');
  const now = new Date();
  const today = c.today(now);
  await sequelize.transaction(async (transaction) => {
    const imp = await ownImport(gymId, importId, { transaction, lock: true });
    if (imp.status !== 'applied') throw fail('GYM_IMPORT_STATE', { status: imp.status });
    if (imp.undoUntil <= now) throw fail('GYM_IMPORT_STATE', { reason: 'undo_window_closed', undoUntil: c.iso(imp.undoUntil) });
    const members = await GymMember.findAll({ where: { importId: imp.id, status: { [Op.ne]: 'removed' } }, order: [['memberCode', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
    const blocked = await blockers(imp, members, transaction);
    if (blocked.length) throw fail('GYM_IMPORT_UNDO_BLOCKED', { members: blocked });
    for (const m of members) {
      const openings = await GymFeePayment.findAll({ where: { memberId: m.id, importId: imp.id, amountPoisha: { [Op.gt]: 0 } }, transaction });
      for (const p of openings) {
        const due = await dues.lockDue(gymId, p.dueId, transaction);
        await dues.reverseIn(transaction, { gym: a.gym, due, original: p, reason: 'import undone', by: principal.id, actor: a.actor, today, importId: imp.id });
      }
      await GymDue.update({ status: 'void', voidedAt: now, voidReason: 'import_undone' }, { where: { memberId: m.id, status: { [Op.ne]: 'void' } }, transaction });
      await membersSvc.removeIn(transaction, { m, reason: 'Import undone', actor: a.actor, by: principal.id, today });
    }
    await imp.update({ status: 'undone', undoneAt: now }, { transaction });
    await c.publish(transaction, 'gym_import.undone', 'gym_import', imp.id, { importId: imp.id, gymId, rowsOk: imp.rowsOk, rowsFailed: imp.rowsFailed, by: principal.id }, a.actor);
    await c.record({ action: 'gym_import.undone', actor: a.actor, entityType: 'gym_import', entityId: imp.id, after: { members: members.length }, meta: { gymId }, req }, transaction);
  });
  return importView(await GymImport.findByPk(importId));
}

async function purgeFile(imp, transaction, now = new Date()) {
  if (imp.fileKey) {
    try {
      await storage.deletePrivate(imp.fileKey);
    } catch (err) {
      // A missing object counts as deleted (§10).
      if (err?.name !== 'NoSuchKey') throw err;
    }
  }
  await imp.update({ fileKey: null, filePurgedAt: now }, { transaction });
}

/** POST /manage/gyms/:gymId/imports/:importId/discard (owner): a preview nobody wants; its file is deleted. */
async function discard(principal, gymId, importId, req) {
  const a = await c.gymAccess(principal, gymId, 'owner.only');
  await sequelize.transaction(async (transaction) => {
    const imp = await ownImport(gymId, importId, { transaction, lock: true });
    if (imp.status !== 'previewed') throw fail('GYM_IMPORT_STATE', { status: imp.status });
    await imp.update({ status: 'discarded' }, { transaction });
    await purgeFile(imp, transaction);
    await c.record({ action: 'gym_import.discarded', actor: a.actor, entityType: 'gym_import', entityId: imp.id, meta: { gymId }, req }, transaction);
  });
  return importView(await GymImport.findByPk(importId));
}

/** POST /manage/gyms/:gymId/imports/:importId/send-invites (owner): link requests for every imported member (FR-78). */
async function sendInvites(principal, gymId, importId, req) {
  const a = await c.gymAccess(principal, gymId, 'owner.only', { restricted: true });
  let sent = 0;
  await sequelize.transaction(async (transaction) => {
    const imp = await ownImport(gymId, importId, { transaction, lock: true });
    if (imp.status !== 'applied' || imp.invitesSentAt) throw fail('GYM_IMPORT_STATE', { status: imp.status, invitesSent: Boolean(imp.invitesSentAt) });
    const members = await GymMember.findAll({ where: { importId: imp.id, status: { [Op.ne]: 'removed' } }, transaction });
    sent = await links.inviteMany(transaction, { gym: a.gym, members, actor: a.actor, by: principal.id });
    await imp.update({ invitesSentAt: new Date() }, { transaction });
    await c.record({ action: 'gym_import.invites_sent', actor: a.actor, entityType: 'gym_import', entityId: imp.id, after: { sent }, meta: { gymId }, req }, transaction);
  });
  return { ...importView(await GymImport.findByPk(importId)), sent };
}

/** PUT /manage/gyms/:gymId/import-consent { grant } (owner): Kriraghor staff may upload for gym_manage.import_consent_days (FR-79). */
async function consent(principal, gymId, { grant }, req) {
  const a = await c.gymAccess(principal, gymId, 'owner.only');
  const until = grant ? new Date(Date.now() + c.cfg().importConsentDays * 86400000) : null;
  await sequelize.transaction(async (transaction) => {
    const s = await c.requireSetup(gymId, { transaction, lock: true });
    await s.update({ importConsentUntil: until, updatedBy: principal.id }, { transaction });
    await c.record({ action: 'gym_import.consent_changed', actor: a.actor, entityType: 'gym', entityId: gymId, after: { grant, until: c.iso(until) }, req }, transaction);
  });
  return { gymId, importConsentUntil: c.iso(until) };
}

// ---------------------------------------------------------------- housekeeping (job, FR-80)

/** Job gym-manage.import-housekeeping: purge raw files past retention; discard stale previews. Idempotent. */
async function housekeeping(now = new Date(), batch = 500) {
  const cfg = c.cfg();
  return sequelize.transaction(async (transaction) => {
    const stale = await GymImport.findAll({ where: { status: 'previewed', createdAt: { [Op.lt]: new Date(now.getTime() - PREVIEW_DAYS * 86400000) } }, limit: batch, transaction, lock: transaction.LOCK.UPDATE, skipLocked: true });
    for (const imp of stale) await imp.update({ status: 'discarded' }, { transaction });
    const old = await GymImport.findAll({ where: { filePurgedAt: null, createdAt: { [Op.lt]: new Date(now.getTime() - cfg.importRetentionDays * 86400000) } }, limit: batch, transaction, lock: transaction.LOCK.UPDATE, skipLocked: true });
    for (const imp of old) {
      try {
        await purgeFile(imp, transaction, now);
      } catch (err) {
        logger.warn({ importId: imp.id, err: err.message }, 'gym import file purge failed; retried next run');
      }
    }
    return { discarded: stale.length, purged: old.length };
  });
}

module.exports = { PREVIEW_DAYS, readRows, check, upload, adminUpload, get, list, apply, undo, discard, sendInvites, consent, housekeeping };
