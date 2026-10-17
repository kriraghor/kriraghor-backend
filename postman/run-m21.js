'use strict';

/**
 * Unattended M21 acceptance run with the Postman CLI.
 *   node postman/run-m21.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in masters A and B and two
 * members; uploads player A's screenshot and verifies player B's Free Fire UID (so A can try to take
 * it); pre-mints step-up tokens (esports.money); starts the API, a worker loop, and a local control
 * server for {{controlUrl}}. The control server is the test clock: the lifecycle job decides from
 * stored times, so each step moves them and runs one tick; /pay runs the payment simulator for a
 * player. It exists only inside this runner process. Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-esports.postman_collection.json');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('postman screenshot')]);

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function main() {
  const migrate = spawnSync(process.execPath, ['scripts/release.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' } });
  if (migrate.status !== 0) throw new Error('migrate + seed failed');
  const port = await freePort();
  process.env.API_PUBLIC_URL = `http://127.0.0.1:${port}`;

  const h = require('../tests/helpers');
  const { closeAllRedis } = require('../src/common/redis');
  const lifecycle = require('../src/modules/esports/esports.lifecycle');
  const { api, P, models } = h;

  await h.resetDb();
  await h.setSettingForTest('esports.ranking_min_tournaments', 1);
  const a = await h.createSignedInMaster();
  const b = await h.createSecondMaster();
  const playerA = await h.signupUser({ name: 'Rahim Uddin' });
  const playerB = await h.signupUser({ name: 'Karim Mia' });
  const game = await models.EsportsGame.findOne({ where: { key: 'free_fire' } });
  const mode = await models.EsportsMode.findOne({ where: { gameId: game.id, key: 'solo' } });
  const map = await models.EsportsMap.findOne({ where: { gameId: game.id }, order: [['sort', 'ASC']] });
  const preset = await models.EsportsPointsPreset.findOne({ where: { gameId: game.id } });
  const rubricKeys = async (kind) => JSON.stringify((await models.ReviewRubric.findOne({ where: { kind, isActive: true } })).items.map((i) => i.key));

  // Player B: a verified UID, approved by master A on the Moderation desk.
  const upload = async (who) => (await api().post(`${P}/me/esports/uploads`).set(h.bearer(who)).set('Content-Type', 'image/jpeg').send(Buffer.concat([JPEG, Buffer.from(who.user.id)])).expect(201)).body.key;
  const takenUid = '712345602';
  const pb = await api().post(`${P}/me/esports/profiles`).set(h.bearer(playerB)).send({ gameId: game.id, uid: takenUid, ign: 'Karim', screenshotKey: await upload(playerB) }).expect(201);
  const sub = await models.Submission.findOne({ where: { kind: 'game_profile', subjectId: pb.body.id, status: 'pending_review' } });
  await api().post(`${P}/admin/submissions/${sub.id}/claim`).set(h.bearer(a)).expect(200);
  await api().put(`${P}/admin/submissions/${sub.id}/ticks`).set(h.bearer(a)).send({ ticks: JSON.parse(await rubricKeys('game_profile')) }).expect(200);
  await api().post(`${P}/admin/submissions/${sub.id}/decide`).set(h.bearer(a)).set('Idempotency-Key', `pm-m21-b-${Date.now()}`).send({ decision: 'approve' }).expect(200);
  await h.drainEvents();

  const vars = {
    adminAccessToken: a.accessToken,
    adminAccessToken2: b.accessToken,
    playerA: playerA.accessToken,
    playerB: playerB.accessToken,
    userA: playerA.user.id,
    userB: playerB.user.id,
    profileB: pb.body.id,
    screenshotKeyA: await upload(playerA),
    takenUid,
    gameId: game.id,
    modeId: mode.id,
    mapId: map.id,
    presetId: preset.id,
    opensAt: new Date(Date.now() + 10 * 60000).toISOString(),
    startsAt: new Date(Date.now() + 6 * 3600000).toISOString(),
    profileTicks: await rubricKeys('game_profile'),
    tournamentTicks: await rubricKeys('esports_tournament'),
    stepUpQueueA: [await h.stepUp(a, 'esports.money'), await h.stepUp(a, 'esports.money')].join(','),
  };

  // ---- the test clock (one tournament in this database)
  const ago = (ms) => new Date(Date.now() - ms);
  const soon = (ms) => new Date(Date.now() + ms);
  const only = () => models.EsportsTournament.findOne({ order: [['createdAt', 'DESC']] });
  const tick = async () => {
    await lifecycle.tick();
    await h.drainEvents();
  };
  const steps = {
    settle: () => h.drainEvents(),
    'open-registration': async () => {
      await models.EsportsTournament.update({ registrationOpensAt: ago(2 * 3600000) }, { where: { id: (await only()).id } });
      await tick();
    },
    pay: async (q) => {
      await h.payWithSimulator(q.get('who') === 'A' ? playerA : playerB, q.get('payment'));
      await h.drainEvents();
    },
    'open-checkin': async () => {
      const t = await only();
      await models.EsportsTournament.update({ registrationClosesAt: ago(3600000) }, { where: { id: t.id } });
      await tick();
      await models.EsportsStage.update({ checkinOpensAt: ago(600000), checkinClosesAt: soon(600000) }, { where: { tournamentId: t.id } });
      await tick();
    },
    reveal: async () => {
      const t = await only();
      const ms = await models.EsportsMatch.findAll({ where: { tournamentId: t.id } });
      await models.EsportsRoomCredential.update({ revealAt: ago(1000) }, { where: { matchId: ms.map((m) => m.id), status: 'scheduled' } });
      await tick();
    },
    start: async () => {
      const t = await only();
      await models.EsportsStage.update({ checkinClosesAt: ago(2000) }, { where: { tournamentId: t.id } });
      await models.EsportsMatch.update({ startsAt: ago(60000) }, { where: { tournamentId: t.id } });
      await models.EsportsTournament.update({ startsAt: ago(60000) }, { where: { id: t.id } });
      await tick();
    },
    'close-window': async () => {
      await models.EsportsMatch.update({ disputeClosesAt: ago(1000) }, { where: { tournamentId: (await only()).id } });
      await tick();
    },
  };
  const control = http.createServer((rq, rs) => {
    const u = new URL(rq.url, 'http://127.0.0.1');
    const step = steps[u.pathname.slice(1)];
    const reply = (code, body) => rs.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (rq.method !== 'POST' || !step) return reply(404, { error: 'unknown step' });
    return Promise.resolve(step(u.searchParams)).then(
      () => reply(200, { ok: true }),
      (err) => reply(500, { error: err.message })
    );
  });
  const controlPort = await freePort();
  await new Promise((r) => control.listen(controlPort, '127.0.0.1', r));
  vars.controlUrl = `http://127.0.0.1:${controlPort}`;

  const server = require('../src/app').createApp().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  vars.baseUrl = `http://127.0.0.1:${port}/api/v1`;

  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        await h.drainEvents();
        await h.drainPaymentJobs();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('worker loop:', err.message);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();

  const args = ['collection', 'run', `"${collection}"`, ...Object.entries(vars).flatMap(([k, v]) => ['--env-var', `"${k}=${String(v).replace(/"/g, '\\"')}"`])];
  const status = await new Promise((resolve) => spawn('postman', args, { stdio: 'inherit', shell: true }).on('close', resolve));

  stop = true;
  await loop;
  await new Promise((r) => server.close(r));
  await new Promise((r) => control.close(r));
  await closeAllRedis();
  await h.models.sequelize.close();
  process.exit(status ?? 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
