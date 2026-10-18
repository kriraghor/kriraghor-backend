'use strict';

// M14 lite and M22 Esports organiser SaaS step 1 end to end: the organiser role and an organisation
// reviewed on the Moderation desk; a contract (M22-FR-01, FR-02); console tournaments with the prize
// fund gate (FR-04, FR-05), the fee snapshot (FR-06), rooms and results by the organiser (Q135), a
// finalise confirmed by a phone code with the §6.2 postings and the kill cap (FR-07, FR-10); cancel
// returning the fund; flat invoices, payment and the overdue block (FR-08, FR-09); branding and the
// subdomain (FR-11, FR-12); tenant isolation (FR-03) and the conflict of interest.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const f = require('../fixtures/market');
const es = require('../fixtures/esports');
const o = require('../fixtures/organiser');
const ledger = require('../../src/modules/payments/ledger.service');
const invariants = require('../../src/modules/payments/invariants.service');
const saasJobs = require('../../src/modules/organiser-saas/saas.jobs');

const { api, P, models } = h;

let master;
let reviewer;
let docsReviewer;

beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  reviewer = await f.staffWith(master, ['approve_listings']);
  docsReviewer = await f.staffWith(master, ['approve_documents']);
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const consoleUrl = (org, p) => `${P}/org/${org.id}${p}`;
const balance = (code) => ledger.balance(code);
const codesOf = async (userId) => (await models.Notification.findAll({ where: { userId } })).map((n) => n.code);

/** An organisation with an active contract, its owner, and a draft through the console. */
async function organiser(terms = {}, name = 'Dhaka Clutch League') {
  const owner = await o.organiserOwner(docsReviewer, `Owner of ${name}`.slice(0, 40));
  const org = await o.verifiedOrg(owner, reviewer, name);
  const contract = await o.activeContract(master, org.id, terms);
  return { owner, org, contract };
}

async function fundAndPay(owner, org, tournamentId) {
  const dep = await api().post(consoleUrl(org, `/esports/tournaments/${tournamentId}/prize-fund`)).set(h.bearer(owner)).set('Idempotency-Key', f.uniq('fund')).expect(201);
  await h.payWithSimulator(owner, dep.body.payment.id);
  await h.drainEvents();
  return dep.body;
}

describe('M14 lite organisations', () => {
  it('the organiser role and documents, review, verified; members; tenants cannot see each other', async () => {
    const plain = await h.signupUser({ name: 'Nadia Islam' });
    expect((await api().post(`${P}/me/organisations`).set(h.bearer(plain)).send({ name: 'No Role Esports' }).expect(403)).body.code).toBe('ORG_ROLE_REQUIRED');
    const owner = await o.organiserOwner(docsReviewer);
    const draft = (await api().post(`${P}/me/organisations`).set(h.bearer(owner)).send({ name: 'Dhaka Clutch League' }).expect(201)).body;
    expect(draft).toMatchObject({ status: 'draft', role: 'owner', slug: 'dhaka-clutch-league' });
    // The console needs a verified organisation: a draft is a 404 there.
    await api().get(consoleUrl(draft, '/esports/dashboard')).set(h.bearer(owner)).expect(404);
    await api().post(`${P}/me/organisations/${draft.id}/submit`).set(h.bearer(owner)).expect(200);
    await h.drainEvents();
    const sub = await models.Submission.findOne({ where: { kind: 'organisation', subjectId: draft.id } });
    const claimed = await api().post(`${P}/admin/submissions/${sub.id}/claim`).set(h.bearer(reviewer)).expect(200);
    expect(claimed.body.checks.map((c) => [c.key, c.result]).sort()).toEqual([
      ['name_unique', 'pass'],
      ['owner_documents_approved', 'pass'],
      ['owner_nid_verified', 'pass'],
    ]);
    const rubric = await models.ReviewRubric.findByPk(sub.rubricId);
    await api().put(`${P}/admin/submissions/${sub.id}/ticks`).set(h.bearer(reviewer)).send({ ticks: rubric.items.map((i) => i.key) }).expect(200);
    await api().post(`${P}/admin/submissions/${sub.id}/decide`).set(h.bearer(reviewer)).set('Idempotency-Key', f.uniq('dec')).send({ decision: 'approve' }).expect(200);
    await h.drainEvents();
    expect((await api().get(`${P}/me/organisations/${draft.id}`).set(h.bearer(owner)).expect(200)).body.status).toBe('verified');
    expect(await codesOf(owner.user.id)).toContain('ORG_VERIFIED');

    // A staff member added by phone sees the console but cannot do admin things (404, not 403).
    const helper = await h.signupUser({ name: 'Sakib Hasan' });
    await api().post(consoleUrl(draft, '/members')).set(h.bearer(owner)).send({ phone: helper.phone, role: 'staff' }).expect(201);
    expect((await api().post(consoleUrl(draft, '/members')).set(h.bearer(owner)).send({ phone: helper.phone, role: 'staff' }).expect(409)).body.code).toBe('ORG_MEMBER_EXISTS');
    await api().get(consoleUrl(draft, '/esports/dashboard')).set(h.bearer(helper)).expect(200);
    await api().get(consoleUrl(draft, '/billing/invoices')).set(h.bearer(helper)).expect(404);
    expect((await api().get(consoleUrl(draft, '/members')).set(h.bearer(helper)).expect(200)).body.items.map((m) => m.role).sort()).toEqual(['owner', 'staff']);
    // Another organisation's admin, and a stranger: 404 everywhere (FR-03).
    await api().get(consoleUrl(draft, '/esports/dashboard')).set(h.bearer(plain)).expect(404);
    await api().get(`${P}/org/not-a-uuid/esports/dashboard`).set(h.bearer(owner)).expect(404);
    // Staff: suspend (manage_organisers) and restore (masters).
    const mgr = await f.staffWith(master, ['manage_organisers']);
    await api().post(`${P}/admin/organisers/${draft.id}/suspend`).set(h.bearer(mgr)).send({ reason: 'Fake prize screenshots' }).expect(200);
    await api().post(`${P}/admin/organisers/${draft.id}/restore`).set(h.bearer(mgr)).send({ reason: 'Checked' }).expect(403);
    await api().post(`${P}/admin/organisers/${draft.id}/restore`).set(h.bearer(master)).send({ reason: 'Checked with the club' }).expect(200);
    expect((await api().get(`${P}/admin/organisers/${draft.id}`).set(h.bearer(mgr)).expect(200)).body).toMatchObject({ status: 'verified', members: expect.any(Array) });
  });
});

describe('M22 contracts and the console tournament', () => {
  it('contract rules; fund before submit; the fee snapshotted; organiser rooms, results and a phone-confirmed finalise settle §6.2 with the kill cap', async () => {
    const owner = await o.organiserOwner(docsReviewer);
    const org = await o.verifiedOrg(owner, reviewer);
    // Contract: a document is needed, then one active contract per organisation.
    const k = await api().post(`${P}/admin/organisers/${org.id}/contracts`).set(h.bearer(master)).send({ model: 'flat', billingCycle: 'per_tournament', startsOn: '2026-10-01', flatFee: 1000 }).expect(422);
    expect(k.body.code).toBe('CONTRACT_FIELDS_INVALID');
    const draftK = (await api().post(`${P}/admin/organisers/${org.id}/contracts`).set(h.bearer(master)).send({ model: 'percentage', billingCycle: 'per_tournament', startsOn: '2026-10-01' }).expect(201)).body;
    expect((await api().post(`${P}/admin/organisers/contracts/${draftK.id}/activate`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'esports.money')).expect(409)).body.code).toBe('CONTRACT_DOCUMENT_REQUIRED');
    // Without an active contract, the console cannot submit.
    const body = await es.tournamentBody({ fee: 40000, prizes: [100000, 50000], killReward: 10000 });
    expect((await api().post(consoleUrl(org, '/esports/tournaments')).set(h.bearer(owner)).send(body).expect(422)).body.code).toBe('ESPORTS_KILL_CAP_REQUIRED');
    const t = (await api().post(consoleUrl(org, '/esports/tournaments')).set(h.bearer(owner)).send({ ...body, maxPaidKills: 5 }).expect(201)).body;
    expect(t).toMatchObject({ status: 'draft', organisationId: org.id, organiser: { name: 'Dhaka Clutch League' }, maxPaidKills: 5 });
    expect((await api().post(consoleUrl(org, `/esports/tournaments/${t.id}/submit`)).set(h.bearer(owner)).expect(409)).body.code).toBe('ORG_CONTRACT_REQUIRED');
    await o.activeContract(master, org.id);
    // FR-05: the pool (places ৳1,500 + 5 kills × ৳100 = ৳2,000) is funded first.
    expect((await api().post(consoleUrl(org, `/esports/tournaments/${t.id}/submit`)).set(h.bearer(owner)).expect(409)).body.code).toBe('PRIZE_FUND_REQUIRED');
    const dep = await fundAndPay(owner, org, t.id);
    expect(dep.payment.amount).toBe(200000);
    const d = (await api().get(consoleUrl(org, `/esports/tournaments/${t.id}`)).set(h.bearer(owner)).expect(200)).body;
    expect(d.fund).toMatchObject({ required: 200000, deposited: 200000, status: 'funded', block: null });
    expect(await codesOf(owner.user.id)).toContain('ORG_FUND_RECEIVED');
    await api().post(consoleUrl(org, `/esports/tournaments/${t.id}/submit`)).set(h.bearer(owner)).expect(200);
    await h.drainEvents();
    // The review desk sees the organiser and the cap; prizes over the minimum fill are not a subsidy here.
    const sub = await models.Submission.findOne({ where: { kind: 'esports_tournament', subjectId: t.id } });
    expect(sub.payload).toMatchObject({ organisationId: org.id, organiserName: 'Dhaka Clutch League', maxPaidKills: 5 });
    const checks = await require('../../src/modules/esports/tournaments.service').checksFor(t.id, {});
    expect(checks.find((c) => c.key === 'subsidy_at_minimum')).toMatchObject({ result: 'pass', detail: null });
    await f.review(reviewer, 'esports_tournament', t.id);
    const published = await models.EsportsTournament.findByPk(t.id);
    expect(published).toMatchObject({ status: 'scheduled', saasFeeModel: 'percentage', saasFeeBps: 1000 });
    // Branding and the public organiser page (FR-11, FR-12).
    expect((await api().put(consoleUrl(org, '/branding')).set(h.bearer(owner)).send({ primaryHex: '#c8f53c', accentHex: '#f2a33a' }).expect(422)).body.code).toBe('BRAND_PRIMARY_CONTRAST');
    await api().put(consoleUrl(org, '/branding')).set(h.bearer(owner)).send({ primaryHex: '#0B7A4B', accentHex: '#f2a33a', taglineEn: 'Weekly scrims' }).expect(200);
    expect((await api().put(consoleUrl(org, '/branding/subdomain')).set(h.bearer(owner)).send({ subdomain: 'admin' }).expect(422)).body.code).toBe('SUBDOMAIN_RESERVED');
    await api().put(consoleUrl(org, '/branding/subdomain')).set(h.bearer(owner)).send({ subdomain: 'dhaka-clutch' }).expect(200);
    const page = await api().get(`${P}/esports/organisers/dhaka-clutch`).expect(200);
    expect(page.body.organiser).toMatchObject({ name: 'Dhaka Clutch League', primaryHex: '#0b7a4b', subdomain: 'dhaka-clutch' });
    expect(page.body.tournaments.map((x) => x.id)).toEqual([t.id]);

    // Players; an organisation member cannot play in its tournament.
    const people = [];
    for (const n of ['Player One', 'Player Two', 'Player Three', 'Player Four']) people.push(await es.player(reviewer, n));
    const insider = await es.player(reviewer, 'Insider Ifty');
    await api().post(consoleUrl(org, '/members')).set(h.bearer(owner)).send({ phone: insider.phone, role: 'staff' }).expect(201);
    await es.openRegistration(t.id);
    const conflict = await api().post(`${P}/esports/tournaments/${t.id}/registrations`).set(h.bearer(insider)).set('Idempotency-Key', f.uniq('reg')).send({ players: [insider.profileId] });
    expect([conflict.status, conflict.body.code]).toEqual([403, 'ESPORTS_CONFLICT_OF_INTEREST']);
    await es.fill(t.id, people);
    // The organiser's staff run the room and the results (Q135).
    const [m] = await es.matchesOf(t.id);
    await api().put(consoleUrl(org, `/esports/matches/${m.id}/room`)).set(h.bearer(insider)).send({ roomId: '55556666', password: 'clutch' }).expect(200);
    await es.startMatches(t.id);
    const row = (p, placement, kills) => ({ registrationId: p.reg.id, placement, kills: kills ? [{ userId: p.user.id, kills }] : [] });
    const [p1, p2, p3, p4] = people;
    await api().put(consoleUrl(org, `/esports/matches/${m.id}/results`)).set(h.bearer(insider)).send({ rows: [row(p1, 1, 3), row(p2, 2, 2), row(p3, 3, 1), row(p4, 4, 0)] }).expect(200);
    await api().post(consoleUrl(org, `/esports/matches/${m.id}/results/post`)).set(h.bearer(insider)).expect(200);
    await es.closeDisputes(t.id);
    // Finalise: org admins only, confirmed with a code to the phone.
    await api().post(consoleUrl(org, `/esports/tournaments/${t.id}/finalise/code`)).set(h.bearer(insider)).expect(404);
    await api().post(consoleUrl(org, `/esports/tournaments/${t.id}/finalise/code`)).set(h.bearer(owner)).expect(200);
    expect((await api().post(consoleUrl(org, `/esports/tournaments/${t.id}/finalise`)).set(h.bearer(owner)).send({ code: '000000' })).status).toBeGreaterThanOrEqual(400);
    const fin = await api().post(consoleUrl(org, `/esports/tournaments/${t.id}/finalise`)).set(h.bearer(owner)).send({ code: h.lastCode(owner.phone) }).expect(200);
    // 6 kills over a cap of 5: each kill pays ⌊৳100 × 5 / 6⌋ = ৳83.33. Places ৳1,000 and ৳500.
    expect(fin.body).toMatchObject({ status: 'paid_out', settlement: { collected: 160000, paid: 199998, fee: 16000, net: 144000, fundReturn: 2, subsidy: 0 } });
    expect(await balance(`payable:user:${p1.user.id}`)).toBe(100000 + 3 * 8333);
    expect(await balance(`payable:user:${p2.user.id}`)).toBe(50000 + 2 * 8333);
    expect(await balance(`payable:user:${p3.user.id}`)).toBe(8333);
    expect(await balance(`payable:user:${p4.user.id}`)).toBe(0);
    expect(await balance(`payable:user:${owner.user.id}`)).toBe(144002);
    expect(await balance('fee_revenue:esports_saas')).toBe(16000);
    expect(await balance('escrow:esports_entry')).toBe(0);
    expect(await balance('escrow:esports_prize_fund')).toBe(0);
    expect(await balance('prize_subsidy_expense')).toBe(0);
    expect((await invariants.check({ publish: false })).ok).toBe(true);
    // M07: the organiser's money goes out on the daily run; the winners withdraw theirs.
    const ownerEntries = await ledger.payableEntries({ upTo: new Date(), payeeIds: [owner.user.id] });
    expect(ownerEntries.map((e) => e.purpose)).toEqual(['esports_prize_fund']);
    const winnerEntries = await ledger.payableEntries({ upTo: new Date(), payeeIds: [p1.user.id] });
    expect(winnerEntries.map((e) => e.purpose)).toEqual(['esports_entry']);
    expect(await models.OrganiserPrizeFund.findOne({ where: { tournamentId: t.id } })).toMatchObject({ status: 'consumed', paidPoisha: 199998, returnedPoisha: 2 });
    // Disqualified after credit (FR-10, Q123): the prize goes back to the organisation's owner, not to Kriraghor.
    await api().post(`${P}/admin/esports/registrations/${p2.reg.id}/disqualify`).set(h.bearer(master)).send({ reasonCode: 'cheating', note: 'Emulator in a mobile lobby', userId: p2.user.id }).expect(200);
    expect(await balance(`payable:user:${p2.user.id}`)).toBe(0);
    expect(await balance(`payable:user:${owner.user.id}`)).toBe(144002 + 50000 + 2 * 8333);
    expect(await balance('fee_revenue:esports_saas')).toBe(16000);
    expect(await balance('fee_revenue:esports')).toBe(0);
    expect((await invariants.check({ publish: false })).ok).toBe(true);
  });

  it('too few players: the tournament cancels itself, entries are refunded and the fund goes back (FR-10)', async () => {
    const { owner, org } = await organiser();
    const t = (await api().post(consoleUrl(org, '/esports/tournaments')).set(h.bearer(owner)).send(await es.tournamentBody({ fee: 40000, min: 2, prizes: [100000, 50000] })).expect(201)).body;
    await fundAndPay(owner, org, t.id);
    await api().post(consoleUrl(org, `/esports/tournaments/${t.id}/submit`)).set(h.bearer(owner)).expect(200);
    await h.drainEvents();
    await f.review(reviewer, 'esports_tournament', t.id);
    // An org admin cannot cancel a published tournament (staff do, through M21).
    expect((await api().post(consoleUrl(org, `/esports/tournaments/${t.id}/cancel`)).set(h.bearer(owner)).send({ reason: 'Changed our minds' })).status).toBe(409);
    const lone = await es.player(reviewer, 'Lone Player');
    await es.openRegistration(t.id);
    await es.enterPaid(lone, t.id);
    await h.drainEvents();
    expect(await balance('escrow:esports_entry')).toBe(40000);
    await es.closeRegistration(t.id);
    await h.drainPaymentJobs();
    await h.drainEvents();
    expect((await models.EsportsTournament.findByPk(t.id)).status).toBe('cancelled');
    expect(await balance('escrow:esports_entry')).toBe(0);
    expect(await balance('escrow:esports_prize_fund')).toBe(0);
    expect(await balance(`payable:user:${owner.user.id}`)).toBe(150000);
    expect(await balance('fee_revenue:esports_saas')).toBe(0);
    expect(await models.OrganiserPrizeFund.findOne({ where: { tournamentId: t.id } })).toMatchObject({ status: 'returned', returnedPoisha: 150000 });
    expect((await invariants.check({ publish: false })).ok).toBe(true);
  });

  it('the fund follows the draft; cancelling a funded draft returns it; tenants and org staff are kept out', async () => {
    const { owner, org } = await organiser();
    const other = await organiser({}, 'Chittagong Gamers');
    const t = (await api().post(consoleUrl(org, '/esports/tournaments')).set(h.bearer(owner)).send(await es.tournamentBody({ prizes: [100000, 50000] })).expect(201)).body;
    await fundAndPay(owner, org, t.id);
    expect((await api().post(consoleUrl(org, `/esports/tournaments/${t.id}/prize-fund`)).set(h.bearer(owner)).set('Idempotency-Key', f.uniq('fund')).expect(409)).body.code).toBe('PRIZE_FUND_LOCKED');
    // A smaller pool than deposited is refused; a bigger one needs a top-up.
    expect((await api().patch(consoleUrl(org, `/esports/tournaments/${t.id}`)).set(h.bearer(owner)).send(await es.tournamentBody({ prizes: [100000] })).expect(409)).body.code).toBe('PRIZE_FUND_SHRINK');
    await api().patch(consoleUrl(org, `/esports/tournaments/${t.id}`)).set(h.bearer(owner)).send(await es.tournamentBody({ prizes: [100000, 50000, 25000] })).expect(200);
    expect((await api().post(consoleUrl(org, `/esports/tournaments/${t.id}/submit`)).set(h.bearer(owner)).expect(409)).body.code).toBe('PRIZE_FUND_REQUIRED');
    // Tenant isolation: the other organisation sees nothing of this one (FR-03).
    await api().get(consoleUrl(other.org, `/esports/tournaments/${t.id}`)).set(h.bearer(other.owner)).expect(404);
    await api().get(consoleUrl(org, `/esports/tournaments/${t.id}`)).set(h.bearer(other.owner)).expect(404);
    await api().post(consoleUrl(org, `/esports/tournaments/${t.id}/cancel`)).set(h.bearer(other.owner)).send({ reason: 'Not mine at all' }).expect(404);
    const [m] = await es.matchesOf(t.id);
    await api().put(consoleUrl(other.org, `/esports/matches/${m.id}/room`)).set(h.bearer(other.owner)).send({ roomId: '11112222', password: 'pw' }).expect(404);
    // Cancelling the funded draft returns the whole fund to the owner's balance.
    await api().post(consoleUrl(org, `/esports/tournaments/${t.id}/cancel`)).set(h.bearer(owner)).send({ reason: 'Venue internet is down' }).expect(200);
    await h.drainEvents();
    expect(await balance(`payable:user:${owner.user.id}`)).toBe(150000);
    expect(await balance('escrow:esports_prize_fund')).toBe(0);
    expect(await models.OrganiserPrizeFund.findOne({ where: { tournamentId: t.id } })).toMatchObject({ status: 'returned', returnedPoisha: 150000 });
    expect(await codesOf(owner.user.id)).toContain('ORG_FUND_RETURNED');
    // A suspended contract stops new submits.
    const k = await models.OrganiserContract.findOne({ where: { organisationId: other.org.id, status: 'active' } });
    await api().post(`${P}/admin/organisers/contracts/${k.id}/suspend`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'esports.money')).send({ reason: 'Breach of fair play' }).expect(200);
    const t2 = (await api().post(consoleUrl(other.org, '/esports/tournaments')).set(h.bearer(other.owner)).send(await es.tournamentBody()).expect(201)).body;
    expect((await api().post(consoleUrl(other.org, `/esports/tournaments/${t2.id}/submit`)).set(h.bearer(other.owner)).expect(409)).body.code).toBe('ORG_CONTRACT_SUSPENDED');
    // A suspended organisation keeps its console but cannot send anything new (FR-13).
    await api().post(`${P}/admin/organisers/${other.org.id}/suspend`).set(h.bearer(master)).send({ reason: 'Fake prize screenshots' }).expect(200);
    await api().get(consoleUrl(other.org, '/esports/dashboard')).set(h.bearer(other.owner)).expect(200);
    expect((await api().post(consoleUrl(other.org, `/esports/tournaments/${t2.id}/submit`)).set(h.bearer(other.owner)).expect(409)).body.code).toBe('ORG_SUSPENDED');
  });
});

describe('M22 flat contracts and invoices', () => {
  it('a flat contract is invoiced at activation; paying collects it; overdue past grace blocks submits; voids need step-up', async () => {
    const { owner, org } = await organiser({ model: 'flat', flatFee: 500000, billingCycle: 'monthly' });
    const list = (await api().get(consoleUrl(org, '/billing/invoices')).set(h.bearer(owner)).expect(200)).body.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ number: expect.stringMatching(/^KG-INV-\d{2}-\d{6}$/), subtotal: 500000, vat: 0, total: 500000, status: 'issued' });
    expect(await codesOf(owner.user.id)).toContain('ORG_INVOICE_ISSUED');
    // The tick does not issue the same month twice.
    expect((await saasJobs.tick()).issued).toBe(0);
    const pay = await api().post(consoleUrl(org, `/billing/invoices/${list[0].id}/pay`)).set(h.bearer(owner)).set('Idempotency-Key', f.uniq('inv')).expect(201);
    await h.payWithSimulator(owner, pay.body.payment.id);
    await h.drainEvents();
    expect((await api().get(consoleUrl(org, '/billing/invoices')).set(h.bearer(owner)).expect(200)).body.items[0].status).toBe('paid');
    expect(await balance('fee_revenue:esports_saas')).toBe(500000);
    expect(await balance('escrow:fee_invoice')).toBe(0);

    // A second organisation does not pay: overdue, then blocked after the grace days (FR-09, Q134).
    const late = await organiser({ model: 'flat', flatFee: 300000, billingCycle: 'quarterly' }, 'Sylhet Snipers');
    const inv = await models.OrganiserInvoice.findOne({ where: { organisationId: late.org.id } });
    await inv.update({ dueAt: new Date(Date.now() - 3 * 86400000) });
    expect((await saasJobs.tick()).overdue).toBe(1);
    await h.drainEvents();
    expect(await codesOf(late.owner.user.id)).toContain('ORG_INVOICE_OVERDUE');
    const t = (await api().post(consoleUrl(late.org, '/esports/tournaments')).set(h.bearer(late.owner)).send(await es.tournamentBody()).expect(201)).body;
    await fundAndPay(late.owner, late.org, t.id);
    await inv.update({ dueAt: new Date(Date.now() - 15 * 86400000) });
    expect((await api().post(consoleUrl(late.org, `/esports/tournaments/${t.id}/submit`)).set(h.bearer(late.owner)).expect(409)).body.code).toBe('INVOICE_OVERDUE');
    // Staff void it (step-up); submits work again.
    await api().post(`${P}/admin/organisers/invoices/${inv.id}/void`).set(h.bearer(master)).send({ reason: 'Waived for the first season' }).expect(403);
    await api().post(`${P}/admin/organisers/invoices/${inv.id}/void`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'esports.money')).send({ reason: 'Waived for the first season' }).expect(200);
    await api().post(consoleUrl(late.org, `/esports/tournaments/${t.id}/submit`)).set(h.bearer(late.owner)).expect(200);
    // Another active contract for the same organisation is refused.
    const second = (await api().post(`${P}/admin/organisers/${org.id}/contracts`).set(h.bearer(master)).send({ model: 'percentage', billingCycle: 'per_tournament', startsOn: '2026-10-01' }).expect(201)).body;
    await api().post(`${P}/admin/organisers/contracts/${second.id}/document`).set(h.bearer(master)).set('Content-Type', 'application/pdf').send(o.PDF).expect(200);
    expect((await api().post(`${P}/admin/organisers/contracts/${second.id}/activate`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'esports.money')).expect(409)).body.code).toBe('CONTRACT_ACTIVE_EXISTS');
    expect((await invariants.check({ publish: false })).ok).toBe(true);
  });

  it('the tick reminds before ends_on, then ends the contract and submits stop (FR-01)', async () => {
    const { owner, org, contract } = await organiser();
    await models.OrganiserContract.update({ endsOn: '2026-10-31' }, { where: { id: contract.id } });
    const day = (d) => new Date(`${d}T06:00:00Z`);
    expect(await saasJobs.tick(day('2026-10-10'))).toMatchObject({ expiryNotices: 0, contractsEnded: 0 });
    expect(await saasJobs.tick(day('2026-10-18'))).toMatchObject({ expiryNotices: 1, contractsEnded: 0 });
    expect((await saasJobs.tick(day('2026-10-19'))).expiryNotices).toBe(0);
    await h.drainEvents();
    expect(await codesOf(owner.user.id)).toContain('ORG_CONTRACT_ENDING');
    expect((await saasJobs.tick(day('2026-11-01'))).contractsEnded).toBe(1);
    expect((await models.OrganiserContract.findByPk(contract.id)).status).toBe('ended');
    const t = (await api().post(consoleUrl(org, '/esports/tournaments')).set(h.bearer(owner)).send(await es.tournamentBody()).expect(201)).body;
    expect((await api().post(consoleUrl(org, `/esports/tournaments/${t.id}/submit`)).set(h.bearer(owner)).expect(409)).body.code).toBe('ORG_CONTRACT_REQUIRED');
  });
});
