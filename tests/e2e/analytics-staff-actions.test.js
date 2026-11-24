'use strict';

// M19-FR-29 (dashboards round 3, 25 Nov 2026): the admin home's "Needs your action". Every queue the
// admin desks work is counted by the module that owns it and shown only to staff whose permissions
// open that desk: disputes (by source), reports, payouts, esports results and reviews, four-eyes
// settings changes, next to the review queue and risk flags. Rows are placed directly: this checks
// the counting and who sees what, the queues' own flows have their own suites.
const { randomUUID } = require('node:crypto');
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const { tournamentBody } = require('../fixtures/esports');

const { api, P, models } = h;
const HOUR = 3600 * 1000;
const ago = (ms) => new Date(Date.now() - ms);
const soon = (ms) => new Date(Date.now() + ms);
let seq = 0;
const code = (p) => `${p}${Date.now() % 100000}${(seq += 1)}`;

let master;
beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

let emp = 0;
async function staffWith(permissions) {
  emp += 1;
  const s = await h.signupUser({ name: 'Desk' });
  await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'staff.write')).send({ userId: s.user.id, employeeId: `KG-Q-${emp}`, permissions }).expect(201);
  return h.signInStaff(s.phone, s.user.id);
}

const actionsOf = async (who) => (await api().get(`${P}/admin/analytics/actions`).set(h.bearer(who)).expect(200)).body;
const byKey = (body) => Object.fromEntries(body.items.map((i) => [i.key, i]));

// Cases between two members have a respondent (the table's check); esports result cases have none.
let respondentId;
const dispute = (claimantId, over) =>
  models.Dispute.create({ code: code('D'), sourceId: randomUUID(), sourceRef: 'T-1', claimantId, respondentId: over.sourceType === 'esports_result' ? null : respondentId, money: false, paidPoisha: 0, heldPoisha: 0, policyKey: 'test', policy: {}, ...over });
const report = (reporterId, over) => models.Report.create({ code: code('R'), subjectType: 'ground', subjectId: randomUUID(), reporterId, reasonCode: 'wrong_info', eligible: true, ...over });
const payout = (payeeId, status) => models.Payout.create({ code: code('P'), payeeId, amountPoisha: 6000000, grossPoisha: 6000000, status, rulesSnapshot: {} });

/** Every staff queue filled once: two of them past their time limits. */
async function fillQueues() {
  const m = await h.signupUser({ name: 'Member' });
  respondentId = (await h.signupUser({ name: 'Owner' })).user.id;
  await dispute(m.user.id, { sourceType: 'booking', category: 'venue_problem', status: 'under_review', slaDueAt: ago(HOUR) });
  await dispute(m.user.id, { sourceType: 'booking', category: 'venue_problem', status: 'under_review', slaDueAt: soon(5 * HOUR) });
  await dispute(m.user.id, { sourceType: 'esports_result', category: 'result_wrong', status: 'under_review', slaDueAt: soon(2 * HOUR) });
  await dispute(m.user.id, { sourceType: 'booking', category: 'venue_problem', status: 'escalated', masterDueAt: soon(HOUR) });
  await dispute(m.user.id, { sourceType: 'booking', category: 'venue_problem', status: 'awaiting_response' });
  // Two reports about one ground count once; an old one is past reports.sla_hours.
  const ground = randomUUID();
  await report(m.user.id, { subjectId: ground });
  await report((await h.signupUser()).user.id, { subjectId: ground });
  const old = await report(m.user.id, {});
  await models.sequelize.query('UPDATE reports SET created_at = :at WHERE id = :id', { replacements: { at: ago(1000 * HOUR), id: old.id } });
  await report(m.user.id, { status: 'escalated' });
  await payout(m.user.id, 'needs_approval');
  await payout(master.user.id, 'needs_approval'); // the master's own: never theirs to approve
  await payout(m.user.id, 'failed');
  await payout(m.user.id, 'paid');
  const t = await api().post(`${P}/admin/esports/tournaments`).set(h.bearer(master)).send(await tournamentBody()).expect(201);
  await models.EsportsMatch.update({ status: 'live', startsAt: ago(HOUR) }, { where: { tournamentId: t.body.id } });
  const t2 = await api().post(`${P}/admin/esports/tournaments`).set(h.bearer(master)).send(await tournamentBody({ startsInHours: 9 })).expect(201);
  await models.EsportsTournament.update({ status: 'review' }, { where: { id: t2.body.id } });
  const other = await h.createSecondMaster();
  await models.SettingsChangeRequest.create({ changes: [{ key: 'fees.hire_pct', value: 9 }], reason: 'test', effectiveAt: new Date(), needsFourEyes: true, proposedBy: other.user.id });
  await models.SettingsChangeRequest.create({ changes: [{ key: 'fees.gym_pct', value: 4 }], reason: 'mine', effectiveAt: new Date(), needsFourEyes: true, proposedBy: master.user.id });
  return { other };
}

describe('M19-FR-29 staff "Needs your action"', () => {
  it('a master sees every queue, counted once, with the overdue ones high and first', async () => {
    await fillQueues();
    const body = await actionsOf(master);
    const k = byKey(body);
    expect(k.disputes_to_review).toMatchObject({ count: 3, severity: 'high', href: '/admin/disputes' });
    expect(k.disputes_escalated).toMatchObject({ count: 1, severity: 'normal', href: '/admin/disputes?view=escalated' });
    expect(new Date(k.disputes_escalated.dueAt).getTime()).toBeGreaterThan(Date.now());
    expect(k.reports_open).toMatchObject({ count: 2, severity: 'high', href: '/admin/reports' });
    expect(k.reports_escalated).toMatchObject({ count: 1, severity: 'high', href: '/admin/reports?status=escalated' });
    expect(k.payouts_to_approve).toMatchObject({ count: 1, severity: 'normal', href: '/admin/finance?tab=payouts&status=needs_approval' });
    expect(k.payouts_failed).toMatchObject({ count: 1, severity: 'high', href: '/admin/finance?tab=payouts&status=failed' });
    expect(k.results_to_enter).toMatchObject({ count: 1, href: '/admin/esports' });
    expect(k.tournaments_to_review).toMatchObject({ count: 1, href: '/admin/esports' });
    expect(k.settings_to_approve).toMatchObject({ count: 1, href: '/admin/fees' });
    // Every queue is listed (no cap of 6 for staff), urgent ones first.
    expect(body.total).toBe(body.items.length);
    expect(body.items.length).toBeGreaterThan(6);
    const firstNormal = body.items.findIndex((i) => i.severity !== 'high');
    expect(body.items.slice(firstNormal).every((i) => i.severity !== 'high')).toBe(true);
  });

  it('the other master sees the change they proposed as not theirs to approve', async () => {
    const { other } = await fillQueues();
    const k = byKey(await actionsOf(other));
    expect(k.settings_to_approve).toMatchObject({ count: 1 }); // the first master's proposal
    expect(k.payouts_to_approve).toMatchObject({ count: 2 }); // neither payout is theirs
  });

  it('staff see only the queues their permissions open', async () => {
    await fillQueues();
    const reportsDesk = byKey(await actionsOf(await staffWith(['resolve_reports'])));
    expect(Object.keys(reportsDesk).sort()).toEqual(['disputes_to_review', 'reports_open']);
    expect(reportsDesk.disputes_to_review.count).toBe(2); // booking cases, not the esports one

    const esportsDesk = byKey(await actionsOf(await staffWith(['manage_esports'])));
    expect(Object.keys(esportsDesk).sort()).toEqual(['disputes_to_review', 'results_to_enter', 'tournaments_to_review']);
    expect(esportsDesk.disputes_to_review).toMatchObject({ count: 1, severity: 'normal' });

    const scorer = byKey(await actionsOf(await staffWith(['enter_results'])));
    expect(Object.keys(scorer)).toEqual(['results_to_enter']);

    const finance = byKey(await actionsOf(await staffWith(['view_payouts'])));
    expect(Object.keys(finance)).toEqual(['payouts_failed']);

    expect((await actionsOf(await staffWith(['manage_catalog']))).items).toEqual([]);
  });

  it('empty queues give no items, and members cannot ask', async () => {
    expect((await actionsOf(master)).items).toEqual([]);
    const m = await h.signupUser();
    expect([401, 403]).toContain((await api().get(`${P}/admin/analytics/actions`).set(h.bearer(m))).status);
  });
});
