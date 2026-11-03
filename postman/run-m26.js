'use strict';

/**
 * Unattended M26 acceptance run with the Postman CLI.
 *   node postman/run-m26.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in an author, a player, a
 * stranger, a member whose phone isn't verified, and two staff (approve_listings and resolve_reports),
 * and serves {{controlUrl}}, a local test-only control (never part of the API):
 *   POST /drain            deliver the events
 *   POST /expire?postId=   this post's dates pass, then tournament_posts.tick runs
 * Never point this at a real database.
 */
require('../tests/env');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-tournament-feed.postman_collection.json');

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
  const mf = require('../tests/fixtures/market');
  const rules = require('../src/modules/tournament-posts/tournament-posts.rules');
  const jobs = require('../src/modules/tournament-posts/tournament-posts.jobs');
  const { closeAllRedis } = require('../src/common/redis');
  const { models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const staff = await mf.staffWith(a, ['approve_listings']);
  const desk = await mf.staffWith(a, ['resolve_reports']);
  const author = await h.signupUser({ name: 'Rafi Karim' });
  const player = await h.signupUser({ name: 'Nadia Rahman' });
  const stranger = await h.signupUser({ name: 'Tanvir Ahmed' });
  const noPhone = await h.signupUser({ name: 'No Phone' });
  await models.User.update({ phoneVerifiedAt: null }, { where: { id: noPhone.user.id } });
  const area = await models.Area.findOne();
  const sport = await models.Sport.findOne({ where: { isActive: true } });
  const today = rules.dhakaDate(new Date());

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => null);
    return next;
  };
  const steps = {
    drain: async () => {
      await h.drainEvents({ rounds: 10 });
      return {};
    },
    expire: async (q) => {
      await models.TournamentPost.update({ startDate: rules.addDays(today, -30), endDate: rules.addDays(today, -20), registrationDeadline: rules.addDays(today, -31) }, { where: { id: q.get('postId') } });
      return jobs.tick();
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
    controlUrl: `http://127.0.0.1:${controlPort}`,
    authorToken: author.accessToken,
    playerToken: player.accessToken,
    strangerToken: stranger.accessToken,
    noPhoneToken: noPhone.accessToken,
    staffToken: staff.accessToken,
    deskToken: desk.accessToken,
    sportKey: sport.key,
    districtId: area.districtId,
    areaId: area.id,
    in20: rules.addDays(today, 20),
    in22: rules.addDays(today, 22),
    in10: rules.addDays(today, 10),
    past: rules.addDays(today, -1),
  };
  const server = require('../src/app').createApp().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  vars.baseUrl = `http://127.0.0.1:${port}/api/v1`;

  const args = ['collection', 'run', `"${collection}"`, ...Object.entries(vars).flatMap(([k, v]) => ['--env-var', `"${k}=${v}"`])];
  const status = await new Promise((resolve) => spawn('postman', args, { stdio: 'inherit', shell: true }).on('close', resolve));

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
