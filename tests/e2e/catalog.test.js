'use strict';

// M03 §7.1 [v3] esports catalogue: public read, admin CRUD, immutable keys, preset versions.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');

const { api, P, models } = h;

beforeEach(h.resetDb);
afterAll(async () => {
  await closeAllRedis();
  await models.sequelize.close();
});

let empSeq = 0;
async function staffWith(master, permissions) {
  empSeq += 1;
  const member = await h.signupUser({ name: 'Tanvir Ahmed' });
  const token = await h.stepUp(master, 'staff.write');
  await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', token).send({ userId: member.user.id, employeeId: `KG-E-${empSeq}`, permissions }).expect(201);
  return h.signInStaff(member.phone, member.user.id);
}

const pubgId = async () => (await models.EsportsGame.findOne({ where: { key: 'pubg_mobile' } })).id;

describe('GET /catalog/esports/games (public, cached)', () => {
  it('lists the seeded games with modes, maps and current presets', async () => {
    const r = await api().get(`${P}/catalog/esports/games`).expect(200);
    expect(r.headers['cache-control']).toBe('public, max-age=300');
    expect(r.body.items.map((g) => g.key)).toEqual(['pubg_mobile', 'free_fire']);
    const [pubg, ff] = r.body.items;
    expect(pubg).toMatchObject({ nameEn: 'PUBG Mobile', nameBn: 'পাবজি মোবাইল', platform: 'mobile', uidRegex: '^[0-9]{5,12}$', ignMaxLen: 14 });
    expect(pubg.modes.find((m) => m.key === 'squad')).toMatchObject({ teamSize: 4, maxTeams: 25, maxPlayers: 100, maxSubs: 1 });
    expect(pubg.maps.map((m) => m.key)).toEqual(['erangel', 'miramar', 'sanhok', 'vikendi', 'livik']);
    expect(pubg.presets).toEqual([expect.objectContaining({ key: 'pubgm_squad_standard', version: 1, killPoints: 1, isLatest: true })]);
    expect(pubg.presets[0].placementPoints.slice(0, 8)).toEqual([15, 12, 10, 8, 6, 4, 2, 1]);
    expect(ff.modes.find((m) => m.key === 'squad')).toMatchObject({ teamSize: 4, maxTeams: 12, maxPlayers: 50 });
    expect(ff.presets.map((p) => p.key)).toEqual(['ff_br_standard', 'ff_cs_win']);
    expect(ff.maps.map((m) => m.key)).toEqual(['bermuda', 'purgatory', 'kalahari', 'alpine', 'nexterra']);
    await api().get(`${P}/catalog/esports/games`).set('If-None-Match', r.headers.etag).expect(304);
  });
});

describe('admin catalogue (manage_esports or manage_catalog)', () => {
  it('checks permissions', async () => {
    const master = await h.createSignedInMaster();
    await api().get(`${P}/admin/catalog/esports-games`).set(h.bearer(master)).expect(200);
    const esports = await staffWith(master, ['manage_esports']);
    await api().get(`${P}/admin/catalog/esports-modes`).set(h.bearer(esports)).expect(200);
    const catalog = await staffWith(master, ['manage_catalog']);
    await api().get(`${P}/admin/catalog/esports-maps`).set(h.bearer(catalog)).expect(200);
    const other = await staffWith(master, ['approve_documents']);
    const denied = await api().get(`${P}/admin/catalog/esports-maps`).set(h.bearer(other)).expect(403);
    expect(denied.body).toMatchObject({ code: 'PERMISSION_REQUIRED', anyOf: ['manage_esports', 'manage_catalog'] });
    await api().get(`${P}/admin/catalog/gym-packages`).set(h.bearer(master)).expect(422);
  });

  it('creates rows, rejects taken and changed keys, and enforces mode capacity', async () => {
    const master = await h.createSignedInMaster();
    const staff = await staffWith(master, ['manage_esports']);
    const gameId = await pubgId();

    const created = await api().post(`${P}/admin/catalog/esports-maps`).set(h.bearer(staff)).send({ gameId, key: 'karakin', nameEn: 'Karakin', nameBn: 'কারাকিন', sort: 6 }).expect(201);
    expect(created.body).toMatchObject({ key: 'karakin', gameId, isActive: true });
    expect(await models.AuditLog.findOne({ where: { action: 'catalog_item.created', entityId: created.body.id } })).toMatchObject({ actorId: staff.userId });
    expect(h.events.recorded().map((e) => e.name)).toContain('catalog_item.created');

    const taken = await api().post(`${P}/admin/catalog/esports-maps`).set(h.bearer(staff)).send({ gameId, key: 'karakin', nameEn: 'Again', nameBn: 'আবার' }).expect(409);
    expect(taken.body.code).toBe('CATALOG_KEY_TAKEN');

    const renamed = await api().patch(`${P}/admin/catalog/esports-maps/${created.body.id}`).set(h.bearer(staff)).send({ nameEn: 'Karakin (new)' }).expect(200);
    expect(renamed.body.nameEn).toBe('Karakin (new)');
    const immutable = await api().patch(`${P}/admin/catalog/esports-maps/${created.body.id}`).set(h.bearer(staff)).send({ key: 'karakin_2' }).expect(422);
    expect(immutable.body.code).toBe('CATALOG_KEY_IMMUTABLE');

    const tooMany = await api().post(`${P}/admin/catalog/esports-modes`).set(h.bearer(staff)).send({ gameId, key: 'payload', nameEn: 'Payload', nameBn: 'পেলোড', teamSize: 4, maxTeams: 30, maxPlayers: 100, maxSubs: 1 }).expect(422);
    expect(tooMany.body.errors[0]).toMatchObject({ field: 'maxPlayers' });
    const squad = await models.EsportsMode.findOne({ where: { gameId, key: 'squad' } });
    await api().patch(`${P}/admin/catalog/esports-modes/${squad.id}`).set(h.bearer(staff)).send({ maxTeams: 26 }).expect(422);
    await api().patch(`${P}/admin/catalog/esports-modes/${squad.id}`).set(h.bearer(staff)).send({ maxTeams: 20 }).expect(200);

    const badRegex = await api().post(`${P}/admin/catalog/esports-games`).set(h.bearer(staff)).send({ key: 'cod_mobile', nameEn: 'Call of Duty Mobile', nameBn: 'কল অফ ডিউটি মোবাইল', platform: 'mobile', uidLabelEn: 'UID', uidLabelBn: 'UID', uidRegex: '[0-9]+', ignMaxLen: 16 }).expect(422);
    expect(badRegex.body.errors[0].field).toBe('uidRegex');
    await api().post(`${P}/admin/catalog/esports-games`).set(h.bearer(staff)).send({ key: 'cod_mobile', nameEn: 'Call of Duty Mobile', nameBn: 'কল অফ ডিউটি মোবাইল', platform: 'mobile', uidLabelEn: 'UID', uidLabelBn: 'UID', uidRegex: '^[0-9]{6,20}$', ignMaxLen: 16 }).expect(201);
    const missingGame = await api().post(`${P}/admin/catalog/esports-maps`).set(h.bearer(staff)).send({ gameId: '00000000-0000-4000-8000-000000000000', key: 'nowhere', nameEn: 'Nowhere', nameBn: 'কোথাও না' }).expect(404);
    expect(missingGame.body.code).toBe('NOT_FOUND');
  });

  it('a preset edit creates a new version and keeps the old one', async () => {
    const master = await h.createSignedInMaster();
    const preset = await models.EsportsPointsPreset.findOne({ where: { key: 'ff_br_standard' } });
    const bad = await api().patch(`${P}/admin/catalog/esports-points-presets/${preset.id}`).set(h.bearer(master)).send({ placementPoints: [10, 12] }).expect(422);
    expect(bad.body.errors[0].field).toBe('placementPoints');

    const v2 = await api().patch(`${P}/admin/catalog/esports-points-presets/${preset.id}`).set(h.bearer(master)).send({ placementPoints: [12, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1, 0], killPoints: 2 }).expect(200);
    expect(v2.body).toMatchObject({ key: 'ff_br_standard', version: 2, killPoints: 2 });
    expect(v2.body.id).not.toBe(preset.id);
    await preset.reload();
    expect(preset).toMatchObject({ version: 1, killPoints: 1 });

    const list = await api().get(`${P}/admin/catalog/esports-points-presets?gameId=${preset.gameId}`).set(h.bearer(master)).expect(200);
    const versions = list.body.items.filter((p) => p.key === 'ff_br_standard').map((p) => [p.version, p.isLatest]);
    expect(versions).toEqual([[2, true], [1, false]]);
    const pub = await api().get(`${P}/catalog/esports/games`).expect(200);
    expect(pub.body.items[1].presets.find((p) => p.key === 'ff_br_standard')).toMatchObject({ version: 2, killPoints: 2 });
  });

  it('deactivate hides a row from the public list (never deleted); reactivate brings it back', async () => {
    const master = await h.createSignedInMaster();
    const tdm = await models.EsportsMode.findOne({ where: { key: 'tdm' } });
    const off = await api().post(`${P}/admin/catalog/esports-modes/${tdm.id}/deactivate`).set(h.bearer(master)).expect(200);
    expect(off.body.isActive).toBe(false);
    let pub = await api().get(`${P}/catalog/esports/games`).expect(200);
    expect(pub.body.items[0].modes.map((m) => m.key)).not.toContain('tdm');
    expect(await models.EsportsMode.count({ where: { key: 'tdm' } })).toBe(1);
    expect(h.events.recorded().map((e) => e.name)).toContain('catalog_item.deactivated');
    // Repeating is a no-op.
    await api().post(`${P}/admin/catalog/esports-modes/${tdm.id}/deactivate`).set(h.bearer(master)).expect(200);
    expect(await models.AuditLog.count({ where: { action: 'catalog_item.deactivated' } })).toBe(1);

    await api().post(`${P}/admin/catalog/esports-modes/${tdm.id}/reactivate`).set(h.bearer(master)).expect(200);
    pub = await api().get(`${P}/catalog/esports/games`).expect(200);
    expect(pub.body.items[0].modes.map((m) => m.key)).toContain('tdm');

    // Presets deactivate every version of the key.
    const preset = await models.EsportsPointsPreset.findOne({ where: { key: 'ff_cs_win' } });
    await api().patch(`${P}/admin/catalog/esports-points-presets/${preset.id}`).set(h.bearer(master)).send({ nameEn: 'Clash Squad (v2)' }).expect(200);
    await api().post(`${P}/admin/catalog/esports-points-presets/${preset.id}/deactivate`).set(h.bearer(master)).expect(200);
    expect(await models.EsportsPointsPreset.count({ where: { key: 'ff_cs_win', isActive: true } })).toBe(0);
    await api().post(`${P}/admin/catalog/esports-points-presets/00000000-0000-4000-8000-000000000000/deactivate`).set(h.bearer(master)).expect(404);
  });

  it('manage_esports can be granted (migration 20261016000003)', async () => {
    const master = await h.createSignedInMaster();
    const staff = await staffWith(master, ['manage_esports']);
    expect(await models.StaffPermission.count({ where: { userId: staff.userId, permission: 'manage_esports' } })).toBe(1);
  });
});
