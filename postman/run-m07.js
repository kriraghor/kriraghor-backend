'use strict';

/**
 * Unattended M07 acceptance run with the Postman CLI.
 *   node postman/run-m07.js
 *
 * Uses the kriraghor_test database (reset): migrates and seeds it, signs in masters A and B, a payer
 * and a payee; pays a ৳100 test charge and releases it from escrow to the payee (৳95 owed); lowers
 * the four-eyes threshold to ৳50 so the payout needs both masters; sends the payee's payout-account
 * code (read from the test SMS outbox); pre-mints step-up tokens; then starts the API and a worker
 * loop next to it. Never point this at a real database.
 */
require('../tests/env');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const collection = path.join(__dirname, 'kriraghor-payouts.postman_collection.json');

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
  const { api, P, models } = h;

  await h.resetDb();
  const a = await h.createSignedInMaster();
  const b = await h.createSecondMaster();
  const payer = await h.signupUser({ name: 'Fahim Rahman' });
  const payee = await h.signupUser({ name: 'Nusrat Jahan' });
  await models.User.update({ legalName: 'Nusrat Jahan' }, { where: { id: payee.user.id } });
  await h.setSettingForTest('payouts.min_amount_poisha', 1000);
  await h.setSettingForTest('payouts.four_eyes_threshold_poisha', 5000);

  // ৳100 paid by the payer, released to the payee: ৳95 in payable:user:{payee}.
  const tc = await api().post(`${P}/admin/payments/test-charges`).set(h.bearer(a)).set('Idempotency-Key', `pm-run-${Date.now()}`).send({ payerId: payer.user.id, payeeId: payee.user.id, amount: 10000 }).expect(201);
  await h.payWithSimulator(payer, tc.body.payment.id);
  const hold = await models.EscrowHold.findOne({ where: { paymentId: tc.body.payment.id } });
  await api().post(`${P}/admin/escrow/${hold.id}/release`).set(h.bearer(a)).set('X-Step-Up', await h.stepUp(a, 'escrow.manage')).send({ reason: 'Postman M07 setup' }).expect(200);
  await api().post(`${P}/me/payout-accounts/otp`).set(h.bearer(payee)).expect(202);

  const tokensA = [];
  for (let i = 0; i < 4; i += 1) tokensA.push(await h.stepUp(a, 'payout.approve'));
  const vars = {
    adminAccessToken: a.accessToken,
    adminAccessToken2: b.accessToken,
    accessToken: payee.accessToken,
    accountCode: h.lastCode(payee.phone),
    stepUpQueueA: tokensA.join(','),
    stepUpQueueB: await h.stepUp(b, 'payout.approve'),
  };

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
