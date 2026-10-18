'use strict';

/**
 * M14 test fixtures (jest and the Postman runner): a verified sports organisation, an active payout
 * account for its owner, a tournament approved on the Moderation desk, and captains with an NID and a
 * team of a sport.
 */
const h = require('../helpers');
const f = require('./market');
const o = require('./organiser');

const { api, P, models } = h;
const DAY = 86400000;
const dhaka = (ms) => new Date(ms + 6 * 3600000).toISOString().slice(0, 10);

/** A verified organisation of kind `sports` owned by a new organiser. */
async function sportsOrg(reviewer, { name = 'Mirpur Sports Club', ownerName = 'Tanvir Hossain' } = {}) {
  const owner = await o.organiserOwner(reviewer, ownerName);
  const r = await api().post(`${P}/me/organisations`).set(h.bearer(owner)).send({ name, kind: 'sports', about: 'Weekend leagues in Mirpur.' }).expect(201);
  await api().post(`${P}/me/organisations/${r.body.id}/submit`).set(h.bearer(owner)).expect(200);
  await h.drainEvents();
  await f.review(reviewer, 'organisation', r.body.id);
  await models.PayoutAccount.create({ userId: owner.user.id, type: 'bkash', accountNoEnc: 'x', accountNoHash: f.uniq('acct').padEnd(64, '0').slice(0, 64), accountNoLast4: '5678', accountName: ownerName, status: 'active', activatedAt: new Date() });
  return { owner, org: (await api().get(`${P}/me/organisations/${r.body.id}`).set(h.bearer(owner)).expect(200)).body };
}

/** Dates that pass the checks: registration open now for a day, first match in four days. */
function dates(now = Date.now()) {
  return { registrationOpensAt: new Date(now - 60000).toISOString(), registrationClosesAt: new Date(now + DAY).toISOString(), startDate: dhaka(now + 4 * DAY), endDate: dhaka(now + 12 * DAY) };
}

/** A tournament draft (badminton singles by default: squads of one keep tests small). */
async function draft(owner, orgId, body = {}) {
  const area = await f.areaId();
  const r = await api()
    .post(`${P}/org/${orgId}/sports/tournaments`)
    .set(h.bearer(owner))
    .send({ sportKey: 'badminton', name: `Mirpur Open ${f.uniq('t')}`.slice(0, 60), format: 'league', minTeams: 4, maxTeams: 4, squadMin: 1, squadMax: 2, entryFeePoisha: 1800000, ...dates(), venues: [{ venueText: 'Mirpur Indoor Stadium', areaId: area, courts: ['Court 1', 'Court 2'] }], ...body });
  if (r.status !== 201) throw new Error(`draft: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** A draft submitted and approved on the Moderation desk: registration is open. */
async function approved(owner, orgId, reviewer, body = {}) {
  const t = await draft(owner, orgId, body);
  await api().post(`${P}/org/${orgId}/sports/tournaments/${t.id}/submit`).set(h.bearer(owner)).expect(200);
  await h.drainEvents();
  await f.review(reviewer, 'tournament', t.id);
  return (await api().get(`${P}/org/${orgId}/sports/tournaments/${t.id}`).set(h.bearer(owner)).expect(200)).body;
}

/** A captain with a verified NID and a team of the sport (plus extra members with an NID). */
async function captain(name, { sportKey = 'badminton', extra = 0, verify = true } = {}) {
  const c = await h.signupUser({ name });
  if (verify) {
    await h.verifyMember(c.user.id);
    await f.refresh(c);
  }
  const team = await api().post(`${P}/teams`).set(h.bearer(c)).send({ sportKey, name: `${name.split(' ')[0]} XI` }).expect(201);
  const members = [];
  for (let i = 0; i < extra; i += 1) {
    const m = await h.signupUser({ name: `${name.split(' ')[0]} Mate ${i + 1}` });
    if (verify) await h.verifyMember(m.user.id);
    const inv = await api().post(`${P}/teams/${team.body.id}/invites`).set(h.bearer(c)).send({ phone: m.phone }).expect(201);
    await h.drainEvents();
    await f.refresh(m);
    await api().post(`${P}/me/team-invites/${inv.body.invite.id}/accept`).set(h.bearer(m)).expect(200);
    members.push(m);
  }
  return { ...c, team: team.body, members };
}

/** Registers a captain's team (themselves on the squad unless given) and pays when there is a fee. */
async function register(c, tournamentId, { roster, pay = true } = {}) {
  const r = await api()
    .post(`${P}/tournaments/${tournamentId}/registrations`)
    .set(h.bearer(c))
    .set('Idempotency-Key', f.uniq('reg'))
    .send({ teamId: c.team.id, rosterUserIds: roster ?? [c.user.id], acceptRules: true });
  if (r.status !== 201) throw new Error(`register: ${r.status} ${JSON.stringify(r.body)}`);
  if (pay && r.body.payment) {
    await h.payWithSimulator(c, r.body.payment.id);
    await h.drainPaymentJobs();
    await h.drainEvents();
  }
  return (await api().get(`${P}/me/registrations`).set(h.bearer(c)).expect(200)).body.items.find((x) => x.id === r.body.id) ?? r.body;
}

/** The ledger balance of an account (credit − debit), e.g. payable:user:{id}. */
async function balance(code) {
  const [[row]] = await models.sequelize.query('SELECT COALESCE(SUM(e.credit_poisha - e.debit_poisha), 0) AS b FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = :code', { replacements: { code } });
  return Number(row.b);
}

module.exports = { DAY, dhaka, sportsOrg, dates, draft, approved, captain, register, balance };
