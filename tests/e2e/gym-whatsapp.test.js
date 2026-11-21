'use strict';

// M24 §25 WhatsApp, step 1 (tester feedback item 5; M24-FR-157 to FR-160), end to end: the owner's number for
// every branch, a branch's own number that wins, the gym page button and switching it off; who may change
// them; a suspended gym; a member's WhatsApp number and consents from the desk and from the member, kept as
// append-only rows, with only the last 4 digits for staff and nothing of the number in the audit trail.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const gm = require('../fixtures/gym-manage');
const s = require('../../src/modules/gym-whatsapp/gym-whatsapp.schemas');

const { api, P, models } = h;
jest.setTimeout(300000);

beforeEach(async () => {
  await h.resetDb();
  await h.createSignedInMaster();
});
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

const conforms = (schema, body) => expect(schema.safeParse(body).error?.issues ?? []).toEqual([]);
const owner = (who) => ({
  get: () => api().get(`${P}/manage/whatsapp`).set(h.bearer(who)),
  setNumber: (number) => api().put(`${P}/manage/whatsapp/number`).set(h.bearer(who)).send({ number }),
});
const mine = (who, memberId) => ({
  get: () => api().get(`${P}/me/gym-whatsapp/${memberId}`).set(h.bearer(who)),
  put: (body) => api().put(`${P}/me/gym-whatsapp/${memberId}`).set(h.bearer(who)).send(body),
});

/** A published gym (status live with a snapshot), so its public page answers. */
async function publish(gymId, name) {
  await models.Gym.update({ status: 'live', liveVersion: 1, liveSnapshot: { name, addressLine: 'House 9, Road 11, Banani, Dhaka', photos: [], packages: [], hours: [] } }, { where: { id: gymId } });
  return (await models.Gym.findByPk(gymId)).slug;
}
const e164 = (local) => `+88${local}`;
const page = async (slug) => (await api().get(`${P}/gym/gyms/${slug}`).expect(200)).body.whatsapp;

describe('M24 §25 WhatsApp, step 1', () => {
  it('chat numbers: the owner’s for every branch, a branch’s own wins, the gym page button, who may change them', async () => {
    const one = await gm.privateGym({ tier: 'free' });
    const two = await gm.privateGym({ owner: one.owner, name: 'Iron Yard Gulshan', shortCode: 'IG' });
    const slugOne = await publish(one.gym.id, 'Iron Yard Banani');
    const slugTwo = await publish(two.gym.id, 'Iron Yard Gulshan');
    const o = owner(one.owner);

    // Nothing yet: no number, no button; the API is switched off on the platform.
    const empty = (await o.get().expect(200)).body;
    conforms(s.OwnerWhatsapp, empty);
    expect(empty).toMatchObject({ apiEnabled: false, number: null });
    expect(empty.gyms.map((g) => [g.name, g.source, g.shown])).toEqual([
      ['Iron Yard Banani', 'none', null],
      ['Iron Yard Gulshan', 'none', null],
    ]);
    expect(await page(slugOne)).toBeNull();

    // The owner's number, in any Bangladesh form, is used by every branch (M24-FR-157).
    expect((await o.setNumber('01212345678').expect(422)).body.errors[0].field).toBe('number');
    const set = (await o.setNumber('880 1712-345678').expect(200)).body;
    expect(set.number).toBe('+8801712345678');
    expect(set.gyms.every((g) => g.source === 'owner' && g.shown === '+8801712345678')).toBe(true);
    expect(await page(slugOne)).toBe('+8801712345678');
    expect(await page(slugTwo)).toBe('+8801712345678');

    // A branch's own number wins; switching its button off hides it from the page only (M24-FR-158).
    const g2 = gm.manage(one.owner, two.gym.id);
    const own = (await g2.patch('/whatsapp', { number: '01812345678' }).expect(200)).body;
    conforms(s.GymWhatsapp, own);
    expect(own).toMatchObject({ number: '+8801812345678', ownerNumber: '+8801712345678', source: 'own', shown: '+8801812345678', showOnPage: true });
    expect(await page(slugTwo)).toBe('+8801812345678');
    expect(await page(slugOne)).toBe('+8801712345678');
    expect((await g2.patch('/whatsapp', { showOnPage: false }).expect(200)).body.shown).toBeNull();
    expect(await page(slugTwo)).toBeNull();
    await g2.patch('/whatsapp', {}).expect(422);
    // Back to the owner's number.
    expect((await g2.patch('/whatsapp', { number: null, showOnPage: true }).expect(200)).body).toMatchObject({ number: null, source: 'owner', shown: '+8801712345678' });
    expect(await models.AuditLog.count({ where: { action: 'gym_whatsapp.gym_number_set' } })).toBe(3);
    expect(await models.AuditLog.count({ where: { action: 'gym_whatsapp.owner_number_set' } })).toBe(1);
    // Saving the same number again writes nothing.
    await o.setNumber('01712345678').expect(200);
    expect(await models.AuditLog.count({ where: { action: 'gym_whatsapp.owner_number_set' } })).toBe(1);

    // Staff may not change the numbers; another owner does not see these branches.
    const desk = await gm.hire(one.owner, one.gym.id, await h.signupUser({ name: 'Desk Rumi' }), ['members.view', 'members.edit']);
    expect((await gm.manage(desk, one.gym.id).patch('/whatsapp', { number: '01912345678' }).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    await gm.manage(desk, one.gym.id).get('/whatsapp').expect(403);
    const other = await gm.privateGym({ name: 'Other Gym', shortCode: 'OG' });
    await gm.manage(other.owner, one.gym.id).get('/whatsapp').expect(404);
    expect((await owner(other.owner).get().expect(200)).body.gyms.map((g) => g.name)).toEqual(['Other Gym']);

    // A suspended gym: the owner may look, never change (19 Nov 2026).
    await models.Gym.update({ status: 'suspended', suspendCause: 'staff', suspendedFrom: 'live' }, { where: { id: one.gym.id } });
    await gm.manage(one.owner, one.gym.id).get('/whatsapp').expect(200);
    expect((await gm.manage(one.owner, one.gym.id).patch('/whatsapp', { showOnPage: false }).expect(423)).body.code).toBe('GYM_SUSPENDED');
  });

  it('a member’s WhatsApp number and consents: from the desk, from the member, append-only, last 4 digits only', async () => {
    const { owner: o, gym } = await gm.privateGym({ tier: 'standard' });
    await publish(gym.id, 'Iron Yard Banani');
    const who = await h.signupUser({ name: 'Rafiq Hasan' });
    const added = await gm.addMember(o, gym.id, { displayName: 'Rafiq Hasan', phone: who.phone });
    const memberId = added.member.id;
    const phoneLast4 = who.phone.slice(-4);
    const path = `/members/${memberId}/whatsapp`;
    const g = gm.manage(o, gym.id);

    // Nothing agreed yet.
    const none = await g.get(path).expect(200);
    expect(none.headers['cache-control']).toContain('no-store');
    conforms(s.MemberConsent, none.body);
    expect(none.body).toMatchObject({ service: false, news: false, source: null, numberLast4: null, phoneLast4, currentVersion: 1 });

    // The desk records the member's answer: no number = their phone (M24-FR-159).
    const viewer = await gm.hire(o, gym.id, await h.signupUser({ name: 'Viewer Mitu' }), ['members.view']);
    expect((await gm.manage(viewer, gym.id).put(path, { service: true, news: false }).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    await gm.manage(viewer, gym.id).get(path).expect(200);
    const atDesk = (await g.put(path, { service: true, news: false }).expect(200)).body;
    expect(atDesk).toMatchObject({ service: true, news: false, source: 'desk', numberLast4: phoneLast4, consentVersion: 1 });
    expect(JSON.stringify(atDesk)).not.toContain(who.phone.slice(-8));
    // The same answer again writes nothing; a change is a new row (M24-FR-160).
    await g.put(path, { service: true, news: false }).expect(200);
    expect(await models.GymWhatsappConsent.count({ where: { memberId } })).toBe(1);
    expect((await g.put(path, { number: '01912345678', service: true, news: true }).expect(200)).body).toMatchObject({ news: true, numberLast4: '5678' });
    expect(await models.GymWhatsappConsent.count({ where: { memberId } })).toBe(2);
    expect((await g.put(path, { number: '123', service: true, news: true }).expect(422)).body.code).toBe('VALIDATION_FAILED');
    await g.put(path, { service: true }).expect(422);

    // The number is encrypted at rest; the audit trail holds no number.
    const row = await models.GymWhatsappConsent.findOne({ where: { memberId }, order: [['createdAt', 'DESC']] });
    expect(row.numberEnc).not.toContain('1912345678');
    const audits = await models.AuditLog.findAll({ where: { action: 'gym_whatsapp.consent_recorded' } });
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits.map((a) => a.toJSON()))).not.toMatch(/1912345678|\+880/);
    // Append-only: rows are never changed or removed.
    await expect(row.update({ news: false })).rejects.toThrow(/append-only/);

    // The member, once linked, sees their own number and answers for themselves.
    await gm.linkMember(o, gym.id, memberId, who);
    const m = mine(who, memberId);
    const read = (await m.get().expect(200)).body;
    conforms(s.MyConsent, read);
    expect(read).toMatchObject({ number: '+8801912345678', phone: e164(who.phone), service: true, news: true, source: 'desk', gymName: 'Iron Yard Banani' });
    const self = (await m.put({ number: null, service: false, news: false }).expect(200)).body;
    expect(self).toMatchObject({ number: e164(who.phone), service: false, news: false, source: 'member' });
    expect(await models.GymWhatsappConsent.count({ where: { memberId } })).toBe(3);
    // Somebody else's membership is not found.
    const stranger = await h.signupUser({ name: 'Stranger' });
    await mine(stranger, memberId).get().expect(404);
    await mine(stranger, memberId).put({ number: null, service: true, news: true }).expect(404);

    // A suspended gym: the member's answer is refused (19 Nov 2026), reading still works.
    await models.Gym.update({ status: 'suspended', suspendCause: 'staff', suspendedFrom: 'live' }, { where: { id: gym.id } });
    expect((await m.put({ number: null, service: true, news: false }).expect(423)).body.code).toBe('GYM_SUSPENDED');
    await m.get().expect(200);
  });
});
