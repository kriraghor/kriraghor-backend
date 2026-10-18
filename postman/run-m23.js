'use strict';

/**
 * Unattended M23 acceptance run with the Postman CLI.
 *   node postman/run-m23.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in master A and a listings
 * reviewer, publishes five tournaments (two free solo qualifiers, one starting too late, an
 * invite-only final and an open final), and signs up seven players with verified Free Fire UIDs and a
 * fan. It serves {{controlUrl}}, a local test-only control: /settle drains events, /play fills, plays
 * and finalises a qualifier in a fixed order, /open and /close move the final's registration (close
 * also runs esports_events.tick), /start starts the final, /check reads the alerts.
 * Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-events.postman_collection.json');
const fixtures = path.join(__dirname, 'fixtures');

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
  const f = require('../tests/fixtures/market');
  const es = require('../tests/fixtures/esports');
  const { closeAllRedis } = require('../src/common/redis');
  const jobs = require('../src/modules/esports-events/events.jobs');
  const { api, P, models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const listings = await f.staffWith(a, ['approve_listings']);
  const tournament = async (opts) => {
    const t = (await api().post(`${P}/admin/esports/tournaments`).set(h.bearer(a)).send(await es.tournamentBody(opts)).expect(201)).body;
    await api().post(`${P}/admin/esports/tournaments/${t.id}/submit`).set(h.bearer(a)).expect(200);
    await h.drainEvents();
    await f.review(listings, 'esports_tournament', t.id);
    return t;
  };
  const t = {
    q1: await tournament({ fee: 0, maxSlots: 4, min: 2, prizes: [20000, 10000] }),
    q2: await tournament({ fee: 0, maxSlots: 4, min: 2, prizes: [20000, 10000] }),
    late: await tournament({ fee: 0, startsInHours: 9 }),
    fin: await tournament({ fee: 0, maxSlots: 5, min: 2, prizes: [100000, 50000], startsInHours: 10, entryPolicy: 'invite' }),
    open: await tournament({ fee: 0, startsInHours: 10 }),
  };
  const p = {};
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) p[n] = await es.player(listings, `Player ${n.toUpperCase()}`);
  const fanUser = await h.signupUser({ name: 'Fan One' });
  const order = { q1: ['a', 'b', 'c'], q2: ['d', 'e', 'f'] };

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  const steps = {
    settle: async () => {
      await h.drainEvents();
      return {};
    },
    play: async (q) => {
      const which = q.get('which');
      const people = order[which].map((k) => p[k]);
      const tour = t[which];
      await es.fill(tour.id, people);
      await es.startMatches(tour.id);
      const [m] = await es.matchesOf(tour.id);
      await api()
        .put(`${P}/admin/esports/matches/${m.id}/results`)
        .set(h.bearer(a))
        .send({ rows: people.map((x, i) => ({ registrationId: x.reg.id, placement: i + 1, kills: [] })) })
        .expect(200);
      await api().post(`${P}/admin/esports/matches/${m.id}/results/post`).set(h.bearer(a)).expect(200);
      await es.closeDisputes(tour.id);
      await api().post(`${P}/admin/esports/tournaments/${tour.id}/finalise`).set(h.bearer(a)).set('X-Step-Up', await h.stepUp(a, 'esports.money')).expect(200);
      await h.drainEvents();
      return { regs: Object.fromEntries(order[which].map((k) => [k, p[k].reg.id])) };
    },
    open: async (q) => {
      await es.openRegistration(t[q.get('which')].id);
      return {};
    },
    close: async (q) => {
      await es.closeRegistration(t[q.get('which')].id);
      const tick = await jobs.tick();
      await h.drainEvents();
      return { tick };
    },
    start: async (q) => {
      await es.openCheckin(t[q.get('which')].id);
      await es.startMatches(t[q.get('which')].id);
      return {};
    },
    check: async () => {
      await h.drainEvents();
      return {
        streamAlerts: await models.EsportsEventAlert.count({ where: { kind: 'stream_live' } }),
        fanStreamLive: await models.Notification.count({ where: { userId: fanUser.user.id, code: 'ESPORTS_EVENT_STREAM_LIVE' } }),
      };
    },
  };
  const control = http.createServer((rq, rs) => {
    const u = new URL(rq.url, 'http://127.0.0.1');
    const step = steps[u.pathname.slice(1)];
    const reply = (code, body) => rs.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (rq.method !== 'POST' || !step) return reply(404, { error: 'unknown step' });
    return serial(() => step(u.searchParams)).then(
      (body) => reply(200, { ok: true, ...body }),
      (err) => reply(500, { error: err.message })
    );
  });
  const controlPort = await freePort();
  await new Promise((r) => control.listen(controlPort, '127.0.0.1', r));

  const vars = {
    adminAccessToken: a.accessToken,
    q1Id: t.q1.id,
    q2Id: t.q2.id,
    lateId: t.late.id,
    finId: t.fin.id,
    openId: t.open.id,
    aToken: p.a.accessToken,
    aProfile: p.a.profileId,
    bToken: p.b.accessToken,
    bProfile: p.b.profileId,
    bUserId: p.b.user.id,
    cToken: p.c.accessToken,
    cProfile: p.c.profileId,
    gToken: p.g.accessToken,
    gProfile: p.g.profileId,
    gUserId: p.g.user.id,
    fanToken: fanUser.accessToken,
    eventStart: new Date(Date.now() - 3600000).toISOString(),
    eventEnd: new Date(Date.now() + 2 * 86400000).toISOString(),
    controlUrl: `http://127.0.0.1:${controlPort}`,
  };
  const server = require('../src/app').createApp().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  vars.baseUrl = `http://127.0.0.1:${port}/api/v1`;

  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        await serial(() => h.drainEvents());
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('worker loop:', err.message);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();

  const args = ['collection', 'run', `"${collection}"`, '--working-dir', `"${fixtures}"`, ...Object.entries(vars).flatMap(([k, v]) => ['--env-var', `"${k}=${v}"`])];
  const status = await new Promise((resolve) => spawn('postman', args, { stdio: 'inherit', shell: true }).on('close', resolve));

  stop = true;
  await loop;
  await new Promise((r) => server.close(r));
  await new Promise((r) => control.close(r));
  await closeAllRedis();
  await models.sequelize.close();
  process.exit(status ?? 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
