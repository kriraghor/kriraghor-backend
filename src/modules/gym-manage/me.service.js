'use strict';

/**
 * M24 the member area (/me, §4.1): my gyms (current and past), one membership with its dues, receipts
 * and freezes, the check-in calendar, my rotating check-in QR (linked only, no-store, FR-50), my health
 * note (encrypted, shown to the owner and plans.manage staff) and my receipts across gyms.
 * After an unlink the gym appears under "Past" with read-only receipts (FR-18): the accepted invite
 * keeps who accepted it, so past links are found without keeping the account on the member row.
 */
const { Op } = require('sequelize');
const { E } = require('../../common/errors');
const { sequelize, GymMember, GymMembership, GymFreeze, GymDue, GymFeePayment, GymLinkRequest } = require('../../models');
const gymFacade = require('../gym').gyms;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');
const view = require('./gym-manage.serializer');
const dues = require('./dues.service');
const members = require('./members.service');

/** My member rows: { current: [rows linked to me], past: [rows I linked once and unlinked] }. */
async function myMembers(principal) {
  const current = await GymMember.findAll({ where: { userId: principal.id, status: { [Op.ne]: 'removed' } }, order: [['createdAt', 'ASC']] });
  const accepted = await GymLinkRequest.findAll({ where: { userId: principal.id, status: 'accepted', direction: 'gym_invite' }, attributes: ['memberId'] });
  const pastIds = [...new Set(accepted.map((r) => r.memberId))].filter((id) => !current.some((m) => m.id === id));
  const past = pastIds.length ? await GymMember.findAll({ where: { id: pastIds, status: { [Op.ne]: 'removed' }, [Op.or]: [{ userId: null }, { userId: { [Op.ne]: principal.id } }] } }) : [];
  return { current, past };
}

async function mine(principal, memberId) {
  const { current, past } = await myMembers(principal);
  const m = [...current, ...past].find((x) => x.id === memberId);
  if (!m) throw E.notFound('Membership');
  return { m, linked: current.some((x) => x.id === memberId) };
}

const gymRef = (g) => (g ? { id: g.id, name: g.name, slug: g.slug } : null);

/** GET /me/gym-memberships: every gym I belong to (current and past), with the running membership and outstanding. */
async function list(principal) {
  const today = c.today();
  const { current, past } = await myMembers(principal);
  const all = [...current.map((m) => ({ m, linked: true })), ...past.map((m) => ({ m, linked: false }))];
  const items = [];
  for (const { m, linked } of all) {
    const [cur, open] = await Promise.all([GymMembership.findOne({ where: { memberId: m.id, status: ['active', 'frozen'] } }), GymDue.findAll({ where: { memberId: m.id, status: ['unpaid', 'partial'] } })]);
    items.push({
      memberId: m.id,
      gym: gymRef(await gymFacade.get(m.gymId)),
      memberCode: m.memberCode,
      status: m.status,
      linked,
      current: cur ? { title: cur.title, packageKind: cur.packageKind, startsOn: cur.startsOn, endsOn: cur.endsOn, daysLeft: rules.daysLeft({ startsOn: cur.startsOn, endsOn: cur.endsOn, today }), frozen: cur.status === 'frozen' } : null,
      outstandingPoisha: linked ? open.reduce((s, d) => s + rules.dueState({ amount: d.amountPoisha, paid: d.paidPoisha, waived: d.waivedPoisha }).outstanding, 0) : 0,
      onlineFees: false,
      plans: null,
    });
  }
  return { items };
}

/** GET /me/gym-memberships/:memberId: memberships with freezes, dues with payments, receipts (past: receipts only). */
async function detail(principal, memberId) {
  const today = c.today();
  const { m, linked } = await mine(principal, memberId);
  const [mss, dueRows, payments] = await Promise.all([
    linked ? GymMembership.findAll({ where: { memberId: m.id }, order: [['startsOn', 'DESC']] }) : [],
    linked ? GymDue.findAll({ where: { memberId: m.id }, order: [['dueOn', 'DESC']] }) : [],
    GymFeePayment.findAll({ where: { memberId: m.id }, order: [['createdAt', 'DESC']] }),
  ]);
  const freezes = mss.length ? await GymFreeze.findAll({ where: { membershipId: mss.map((x) => x.id) }, order: [['fromOn', 'ASC']] }) : [];
  const reversedOn = new Map(payments.filter((p) => p.reversesId).map((p) => [p.reversesId, p.paidOn]));
  return {
    member: { id: m.id, memberCode: m.memberCode, displayName: m.displayName, status: m.status, linked, joinedOn: m.joinedOn, gym: gymRef(await gymFacade.get(m.gymId)), ...(linked ? { healthNote: c.dec(m.healthNoteEnc), healthNoteAt: c.iso(m.healthNoteAt) } : {}) },
    memberships: mss.map((ms) => view.membershipView(ms, { today, freezes: freezes.filter((f) => f.membershipId === ms.id) })),
    dues: dueRows.map((d) => {
      const v = view.dueView(d, { today, payments: payments.filter((p) => p.dueId === d.id) });
      // The desk's internal note stays with the gym.
      return { ...v, payments: v.payments.map((x) => ({ ...x, note: null })) };
    }),
    receipts: payments.filter((p) => p.amountPoisha > 0).map((p) => receiptItem(p, reversedOn)),
  };
}

const receiptItem = (p, reversedOn, gym = undefined, memberCode = undefined) => ({
  id: p.id,
  receiptNo: p.receiptNo,
  amountPoisha: p.amountPoisha,
  method: p.method,
  paidOn: p.paidOn,
  url: c.receiptUrlOf(p.id),
  reversedOn: reversedOn.get(p.id) ?? null,
  ...(gym !== undefined ? { gym } : {}),
  ...(memberCode !== undefined ? { memberCode } : {}),
});

/** GET /me/gym-memberships/:memberId/attendance?month. */
async function attendance(principal, memberId, { month } = {}) {
  const { m, linked } = await mine(principal, memberId);
  if (!linked) throw E.notFound('Membership');
  return members.calendarOf(m.id, month ?? rules.monthOf(c.today()));
}

/** GET /me/gym-memberships/:memberId/checkin-token: the rotating member QR (linked only; FR-50). */
async function checkinToken(principal, memberId) {
  const { m, linked } = await mine(principal, memberId);
  if (!linked || m.status === 'left') throw c.fail('GYM_NOT_A_MEMBER');
  return { memberId: m.id, gymId: m.gymId, ...c.memberTokenOf(m.id) };
}

/** PUT /me/gym-memberships/:memberId/health-note { text } (linked; encrypted; empty clears it). */
async function setHealthNote(principal, memberId, { text }, req) {
  const { m, linked } = await mine(principal, memberId);
  if (!linked) throw E.notFound('Membership');
  const value = text?.trim() ? text.trim() : null;
  await sequelize.transaction(async (transaction) => {
    await m.update({ healthNoteEnc: c.enc(value), healthNoteBy: value ? 'member' : null, healthNoteAt: value ? new Date() : null }, { transaction });
    await c.record({ action: 'gym_member.health_note_set', actor: principal, entityType: 'gym_member', entityId: m.id, entityCode: m.memberCode, after: { healthNote: value ? 'changed' : 'cleared' }, meta: { gymId: m.gymId }, req }, transaction);
  });
  return { memberId: m.id, healthNote: value, healthNoteAt: value ? c.iso(new Date()) : null };
}

/** GET /me/gym-receipts: my receipts across gyms (current and past), newest first. */
async function receipts(principal) {
  const { current, past } = await myMembers(principal);
  const all = [...current, ...past];
  if (!all.length) return { items: [] };
  const rows = await GymFeePayment.findAll({ where: { memberId: all.map((m) => m.id) }, order: [['createdAt', 'DESC']], limit: 500 });
  const reversedOn = new Map(rows.filter((p) => p.reversesId).map((p) => [p.reversesId, p.paidOn]));
  const gyms = new Map();
  for (const m of all) if (!gyms.has(m.gymId)) gyms.set(m.gymId, gymRef(await gymFacade.get(m.gymId)));
  const byId = new Map(all.map((m) => [m.id, m]));
  return { items: rows.filter((p) => p.amountPoisha > 0).map((p) => receiptItem(p, reversedOn, gyms.get(p.gymId), byId.get(p.memberId).memberCode)) };
}

/** GET /me/gym-receipts/:feePaymentId: one of my receipts. */
async function receipt(principal, feePaymentId) {
  const { current, past } = await myMembers(principal);
  const ids = [...current, ...past].map((m) => m.id);
  const p = ids.length ? await GymFeePayment.findOne({ where: { id: feePaymentId, memberId: ids, amountPoisha: { [Op.gt]: 0 } } }) : null;
  if (!p) throw E.notFound('Receipt');
  return dues.receiptOf(p);
}

module.exports = { myMembers, list, detail, attendance, checkinToken, setHealthNote, receipts, receipt };
