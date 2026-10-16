'use strict';

/**
 * Unattended M05 acceptance run with the Postman CLI.
 *   node postman/run-m05.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in master A and reviewer B
 * (staff with approve_documents only), has two members submit their NID with the files in
 * postman/fixtures, mints one moderation.override step-up for A, starts the API on a free port and a
 * worker loop next to it (M02 applies the decisions, M01 activates the members), then runs the
 * collection. Never point this at a real database.
 */
require('../tests/env');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-moderation.postman_collection.json');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));

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
  const { api, P } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const staffUser = await h.signupUser({ name: 'Rumana Akter' });
  await api().post(`${P}/admin/staff`).set(h.bearer(a)).set('X-Step-Up', await h.stepUp(a, 'staff.write')).send({ userId: staffUser.user.id, employeeId: 'KG-PM-1', permissions: ['approve_documents'] }).expect(201);
  const b = await h.signInStaff(staffUser.phone, staffUser.user.id);

  // Two members submit their NID (different numbers; the same fixture images, salted per member).
  const members = [];
  for (const [name, number] of [['Nusrat Jahan', '1990 1234 5678 9012 3'], ['Fahim Rahman', '1234567890']]) {
    const m = await h.signupUser({ name });
    const files = {};
    for (const [slot, file, mime] of [['front', 'nid-front.jpg', 'image/jpeg'], ['back', 'nid-back.png', 'image/png'], ['selfie', 'nid-selfie.pdf', 'application/pdf']]) {
      const r = await api().post(`${P}/me/documents/files?slot=${slot}`).set(h.bearer(m)).set('Content-Type', mime).send(Buffer.concat([fixture(file), Buffer.from(m.user.id)])).expect(201);
      files[slot] = r.body.fileId;
    }
    await api().post(`${P}/me/documents`).set(h.bearer(m)).send({ docType: 'nid', fields: { legalName: name, number, dob: '1990-05-14' }, files, consent: true }).expect(201);
    members.push(m);
  }

  const vars = {
    adminAccessToken: a.accessToken,
    adminAccessToken2: b.accessToken,
    stepUpQueueA: await h.stepUp(a, 'moderation.override'),
    member1Id: members[0].user.id,
    member2Id: members[1].user.id,
  };

  const server = require('../src/app').createApp().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  vars.baseUrl = `http://127.0.0.1:${port}/api/v1`;

  let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        await h.drainEvents();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('worker loop:', err.message);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();

  const args = ['collection', 'run', `"${collection}"`, ...Object.entries(vars).flatMap(([k, v]) => ['--env-var', `"${k}=${v}"`])];
  const status = await new Promise((resolve) => spawn('postman', args, { stdio: 'inherit', shell: true }).on('close', resolve));

  stop = true;
  await loop;
  await new Promise((r) => server.close(r));
  await closeAllRedis();
  await h.models.sequelize.close();
  process.exit(status ?? 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
