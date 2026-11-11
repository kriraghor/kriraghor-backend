'use strict';

// M24 §20 (product owner, 11 Nov 2026; M24-FR-128 to FR-133), end to end: a linked member records their
// measurements and reads the progress; a second entry for a date replaces the first; the newest weight moves
// the profile weight; the owner and the plan writers read and record, other staff do not; who may remove
// what; nothing is deleted; the audit trail carries no values; and the plan tier.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const gm = require('../fixtures/gym-manage');
const s = require('../../src/modules/gym-manage/gym-manage.schemas');

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
const me = (who, memberId) => {
  const base = `${P}/me/gym-memberships/${memberId}/body`;
  return {
    get: () => api().get(base).set(h.bearer(who)),
    add: (body, key = gm.key('bd')) => {
      const r = api().post(base).set(h.bearer(who));
      if (key) r.set('Idempotency-Key', key);
      return r.send(body);
    },
    remove: (entryId) => api().post(`${base}/${entryId}/void`).set(h.bearer(who)),
  };
};

/** A gym on `tier` with a member linked to an account (no package needed to record measurements). */
async function linked(tier) {
  const { owner, gym } = await gm.privateGym({ tier });
  const who = await h.signupUser({ name: 'Rafiq Hasan' });
  const added = await gm.addMember(owner, gym.id, { displayName: 'Rafiq Hasan', phone: who.phone });
  await gm.linkMember(owner, gym.id, added.member.id, who);
  return { owner, gym, who, member: added.member, g: gm.manage(owner, gym.id), m: me(who, added.member.id) };
}

describe('M24 body progress', () => {
  it('a member and the gym record measurements; the progress, the replacements and who may do what', async () => {
    const { owner, gym, who, member, g, m } = await linked('standard');
    const staffBody = `/members/${member.id}/body`;

    // Nothing yet, with the limits the form needs.
    const empty = (await m.get().expect(200)).body;
    conforms(s.BodyProgress, empty);
    expect(empty).toMatchObject({ memberId: member.id, on: true, entries: [], heightCm: null });
    expect((await m.get().expect(200)).headers['cache-control']).toContain('no-store');
    expect(empty.limits).toMatchObject({ backdateDays: 365, fields: { weightKg: { min: 10, max: 400 }, bodyFatPct: { min: 2, max: 70 } } });
    expect(Object.values(empty.change).every((x) => x === null)).toBe(true);

    // The checks (M24-FR-129).
    await m.add({ weightKg: 80 }, null).expect(400);
    expect((await m.add({}).expect(422)).body.code).toBe('GYM_BODY_EMPTY');
    expect((await m.add({ weightKg: 5 }).expect(422)).body.code).toBe('VALIDATION_FAILED');
    expect((await m.add({ weightKg: 80, measuredOn: gm.inDays(1) }).expect(422)).body.code).toBe('GYM_DATE_OUT_OF_RANGE');
    expect((await m.add({ weightKg: 80, measuredOn: gm.inDays(-366) }).expect(422)).body.code).toBe('GYM_DATE_OUT_OF_RANGE');
    expect(await models.GymBodyEntry.count()).toBe(0);

    // Two months of entries; the height gives each weight a BMI (M24-FR-130).
    await api().put(`${P}/me/gym-memberships/${member.id}/health`).set(h.bearer(who)).send({ heightCm: 175 }).expect(200);
    await m.add({ measuredOn: gm.inDays(-60), weightKg: 82, waistCm: 94.5 }).expect(201);
    const two = (await m.add({ weightKg: 78.4, waistCm: 90, bodyFatPct: 21.5 }).expect(201)).body;
    conforms(s.BodyProgress, two);
    expect(two.entries.map((e) => [e.measuredOn, e.weightKg, e.bmi, e.byRole])).toEqual([
      [gm.inDays(-60), 82, 26.8, 'member'],
      [gm.today(), 78.4, 25.6, 'member'],
    ]);
    expect(two.change.weightKg).toEqual({ from: 82, to: 78.4, delta: -3.6, fromOn: gm.inDays(-60), toOn: gm.today() });
    expect(two.change.waistCm).toMatchObject({ delta: -4.5 });
    expect(two.change.bodyFatPct).toBeNull();
    // The newest weight is the profile weight; an older entry added later does not move it back.
    expect(Number((await models.GymMember.findByPk(member.id)).weightKg)).toBe(78.4);
    await m.add({ measuredOn: gm.inDays(-30), weightKg: 80.2 }).expect(201);
    expect(Number((await models.GymMember.findByPk(member.id)).weightKg)).toBe(78.4);

    // A second entry for a date replaces the first, which is kept as void (M24-FR-128).
    const replaced = (await m.add({ weightKg: 78, waistCm: 89.5 }).expect(201)).body;
    expect(replaced.entries).toHaveLength(3);
    expect(replaced.entries[2]).toMatchObject({ measuredOn: gm.today(), weightKg: 78, waistCm: 89.5, bodyFatPct: null });
    expect(await models.GymBodyEntry.count()).toBe(4);
    expect(await models.GymBodyEntry.count({ where: { voidedAt: null } })).toBe(3);
    expect(Number((await models.GymMember.findByPk(member.id)).weightKg)).toBe(78);

    // The gym (M24-FR-131): the owner and plans.manage read and record; other staff do not.
    const coach = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Coach Tania' }), ['plans.manage', 'members.view']);
    const desk = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Desk Rumi' }), ['members.view', 'members.edit', 'fees.collect']);
    const seen = (await g.get(staffBody).expect(200)).body;
    conforms(s.BodyProgress, seen);
    expect(seen.entries).toHaveLength(3);
    expect((await gm.manage(desk, gym.id).get(staffBody).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    expect((await gm.manage(desk, gym.id).post(staffBody, { weightKg: 70 }, true).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    await gm.manage(coach, gym.id).post(staffBody, { weightKg: 77.5 }).expect(400); // no Idempotency-Key
    const byCoach = (await gm.manage(coach, gym.id).post(staffBody, { measuredOn: gm.inDays(-7), weightKg: 79, armCm: 34 }, true).expect(201)).body;
    const coachEntry = byCoach.entries.find((e) => e.measuredOn === gm.inDays(-7));
    expect(coachEntry).toMatchObject({ byRole: 'staff', armCm: 34 });
    expect((await m.get().expect(200)).body.entries).toHaveLength(4);
    // A trainer who only sees their own members does not see this one.
    const trainer = await gm.hire(owner, gym.id, await h.signupUser({ name: 'Trainer Babu' }), ['plans.manage', 'members.trainer']);
    await gm.manage(trainer, gym.id).get(staffBody).expect(404);
    // Another gym's member id is not found here.
    const elsewhere = await linked('standard');
    await g.get(`/members/${elsewhere.member.id}/body`).expect(404);
    await me(elsewhere.who, member.id).get().expect(404);
    await me(elsewhere.who, member.id).add({ weightKg: 60 }).expect(404);

    // Removing (kept as void): a member removes what they recorded; the gym removes any entry.
    const mine = byCoach.entries.find((e) => e.measuredOn === gm.inDays(-30));
    expect((await m.remove(coachEntry.id).expect(409)).body).toMatchObject({ code: 'GYM_BODY_ENTRY_STATE', reason: 'recorded_by_gym' });
    expect((await m.remove(mine.id).expect(200)).body.entries.map((e) => e.id)).not.toContain(mine.id);
    expect((await m.remove(mine.id).expect(409)).body).toMatchObject({ code: 'GYM_BODY_ENTRY_STATE', reason: 'removed' });
    expect((await gm.manage(desk, gym.id).post(`${staffBody}/${coachEntry.id}/void`).expect(403)).body.code).toBe('PERMISSION_REQUIRED');
    expect((await g.post(`${staffBody}/${coachEntry.id}/void`).expect(200)).body.entries).toHaveLength(2);
    await g.post(`${staffBody}/${h.models.GymBodyEntry.build().id}/void`).expect(404);
    expect(await models.GymBodyEntry.count()).toBe(5); // never deleted

    // The audit trail names the fields, never the values (M24-FR-132).
    const audit = await models.AuditLog.findAll({ where: { action: ['gym_body.entry_added', 'gym_body.entry_voided'] } });
    expect(audit.filter((a) => a.action === 'gym_body.entry_added')).toHaveLength(5);
    expect(audit.filter((a) => a.action === 'gym_body.entry_voided')).toHaveLength(2);
    const text = JSON.stringify(audit.map((a) => a.toJSON()));
    expect(text).toContain('weightKg');
    expect(text).not.toMatch(/78\.4|94\.5|21\.5|80\.2/);
  });

  it('is a Standard feature: on a Basic gym the member sees it switched off and nobody can record', async () => {
    const { member, g, m } = await linked('basic');
    const off = (await m.get().expect(200)).body;
    conforms(s.BodyProgress, off);
    expect(off).toMatchObject({ on: false, entries: [] });
    expect((await m.add({ weightKg: 80 }).expect(403)).body).toMatchObject({ code: 'GYM_TIER_REQUIRED', feature: 'progress', minTier: 'standard' });
    expect((await g.get(`/members/${member.id}/body`).expect(403)).body).toMatchObject({ code: 'GYM_TIER_REQUIRED', feature: 'progress' });
    expect((await g.post(`/members/${member.id}/body`, { weightKg: 80 }, true).expect(403)).body.code).toBe('GYM_TIER_REQUIRED');
    expect(await models.GymBodyEntry.count()).toBe(0);
  });
});
