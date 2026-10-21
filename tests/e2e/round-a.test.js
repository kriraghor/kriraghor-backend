'use strict';

// Round A (21 Oct 2026):
// - esports is organised by Kriraghor only: with esports.external_organisers_enabled off (the
//   default), nobody can create or submit an esports organisation, the organiser console, branding
//   and branded page do not exist, and staff cannot sign new esports contracts. Sports organisations
//   (M14) are unaffected, and turning the switch on brings M22 back.
// - venue owners search their own bookings at any venue and date (M10 owner desk).
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const f = require('../fixtures/market');
const o = require('../fixtures/organiser');
const t = require('../fixtures/tournaments');
const { owner, liveGround, HALF } = require('../fixtures/bookings');

const { api, P, models } = h;
const SWITCH = 'esports.external_organisers_enabled';

let master;
let reviewer;
let docsReviewer;

beforeEach(async () => {
  await h.resetDb();
  master = await h.createSignedInMaster();
  reviewer = await f.staffWith(master, ['approve_listings', 'approve_documents']);
  docsReviewer = reviewer;
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

describe('esports by Kriraghor only', () => {
  it('is off by default and the setting is public', async () => {
    expect(h.settings.get(SWITCH)).toBe(false);
    const pub = await api().get(`${P}/settings/public`).expect(200);
    expect(pub.body.esports.externalOrganisersEnabled).toBe(false);
  });

  it('a new organisation is a sports one; asking for esports is refused', async () => {
    const applicant = await o.organiserOwner(docsReviewer);
    const plain = await api().post(`${P}/me/organisations`).set(h.bearer(applicant)).send({ name: 'Mirpur Sports Club' }).expect(201);
    expect(plain.body.kind).toBe('sports');
    const esports = await api().post(`${P}/me/organisations`).set(h.bearer(applicant)).send({ name: 'Dhaka Clutch League', kind: 'esports' }).expect(403);
    expect(esports.body.code).toBe('ORG_KIND_CLOSED');
  });

  it('an esports draft made while it was on cannot be submitted once it is off, and the console is gone', async () => {
    const applicant = await o.organiserOwner(docsReviewer);
    await h.setSettingForTest(SWITCH, true);
    const org = await o.verifiedOrg(applicant, reviewer);
    await api().get(`${P}/org/${org.id}/esports/dashboard`).set(h.bearer(applicant)).expect(200);
    const draft = (await api().post(`${P}/me/organisations`).set(h.bearer(applicant)).send({ name: 'Dhaka Clutch League Two', kind: 'esports' }).expect(201)).body;

    await h.setSettingForTest(SWITCH, false);
    expect((await api().post(`${P}/me/organisations/${draft.id}/submit`).set(h.bearer(applicant)).expect(403)).body.code).toBe('ORG_KIND_CLOSED');
    await api().get(`${P}/org/${org.id}/esports/dashboard`).set(h.bearer(applicant)).expect(404);
    await api().get(`${P}/org/${org.id}/esports/tournaments`).set(h.bearer(applicant)).expect(404);
    await api().get(`${P}/org/${org.id}/branding`).set(h.bearer(applicant)).expect(404);
    await api().get(`${P}/esports/organisers/clutch`).expect(404);
  });

  it('staff cannot sign new esports contracts while it is off', async () => {
    const applicant = await o.organiserOwner(docsReviewer);
    await h.setSettingForTest(SWITCH, true);
    const org = await o.verifiedOrg(applicant, reviewer);
    await h.setSettingForTest(SWITCH, false);
    const today = new Date(Date.now() + 6 * 3600000).toISOString().slice(0, 10);
    const r = await api().post(`${P}/admin/organisers/${org.id}/contracts`).set(h.bearer(master)).send({ model: 'percentage', billingCycle: 'per_tournament', startsOn: today }).expect(409);
    expect(r.body.code).toBe('ESPORTS_ORGANISERS_CLOSED');
    // Reading organisations stays open (sports organisations are managed there too).
    await api().get(`${P}/admin/organisers/${org.id}`).set(h.bearer(master)).expect(200);
  });

  it('sports organisations and their members work as before', async () => {
    const { org, owner: orgOwner } = await t.sportsOrg(reviewer);
    expect(org.kind).toBe('sports');
    expect(org.status).toBe('verified');
    const members = await api().get(`${P}/org/${org.id}/members`).set(h.bearer(orgOwner)).expect(200);
    expect(members.body.items).toHaveLength(1);
    await api().get(`${P}/org/${org.id}/esports/dashboard`).set(h.bearer(orgOwner)).expect(404);
  });
});

describe('owner booking search (M10, Round A)', () => {
  const now = () => new Date(Math.floor(Date.now() / HALF) * HALF).toISOString();
  const walkIn = (who, g, court, name, phone) =>
    api()
      .post(`${P}/me/grounds/${g.id}/walk-ins`)
      .set(h.bearer(who))
      .set('Idempotency-Key', require('crypto').randomUUID())
      .send({ courtIds: [g.courts[court]], start: now(), minutes: 60, name, phone })
      .expect(201);

  it('finds my bookings by name, phone last digits and code, never another owner\'s; pages', async () => {
    const me = await owner();
    const g = await liveGround(me, { courts: 2 });
    const a = (await walkIn(me, g, 0, 'Shapla FC', '01711000099')).body.booking;
    await walkIn(me, g, 1, 'Padma FC', '01811000123');
    const other = await owner('Rezaul Karim');
    const og = await liveGround(other, { courts: 1 });
    await walkIn(other, og, 0, 'Shapla United', '01911000099');

    const search = (q, extra = '') => api().get(`${P}/me/ground-bookings/search?q=${encodeURIComponent(q)}${extra}`).set(h.bearer(me)).expect(200);
    expect((await search('shapla')).body.items.map((b) => b.teamName ?? b.contactName)).toEqual(['Shapla FC']);
    expect((await search('0099')).body.items.map((b) => b.id)).toEqual([a.id]);
    expect((await search(a.code.slice(-5))).body.items.map((b) => b.id)).toEqual([a.id]);
    expect(JSON.stringify((await search('0099')).body)).not.toContain('01711000099');

    const page1 = (await search('fc', '&limit=1')).body;
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = (await search('fc', `&limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`)).body;
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].id).not.toBe(page1.items[0].id);

    const foreign = await api().get(`${P}/me/ground-bookings/search?q=shapla&groundId=${og.id}`).set(h.bearer(me));
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe('NOT_OWNER');
    await api().get(`${P}/me/ground-bookings/search?q=x`).set(h.bearer(me)).expect(422);
  });
});
