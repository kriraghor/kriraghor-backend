'use strict';

// Kubernetes readiness: worker jobs, probes, the realtime handshake and the OpenAPI contract.
const fs = require('fs');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { io: connect } = require('socket.io-client');
const h = require('../helpers');
const config = require('../../src/config');
const lifecycle = require('../../src/common/lifecycle');
const { createOpsApp } = require('../../src/common/ops-server');
const { closeAllRedis, pingRedis } = require('../../src/common/redis');
const { getQueue, closeQueues, QUEUES } = require('../../src/jobs/queues');
const { processJob, registerSchedules } = require('../../src/jobs/runtime');
const { createRealtimeServer } = require('../../src/realtime/server');
const { buildOpenApi } = require('../../src/openapi');
const C = require('../../src/openapi/components');

const { api, P, models } = h;

beforeEach(h.resetDb);
afterAll(async () => {
  await closeQueues();
  await closeAllRedis();
  await models.sequelize.close();
});

describe('worker jobs', () => {
  it('lifts expired suspensions through the identity.sanction-expire job (idempotent)', async () => {
    const member = await h.signupUser();
    await models.User.update({ status: 'suspended' }, { where: { id: member.user.id } });
    await models.UserSanction.create({ userId: member.user.id, kind: 'suspension', reasonCode: 'abuse', note: 'test', endsAt: new Date(Date.now() - 1000) });

    expect(await processJob({ name: 'identity.sanction-expire', data: {} })).toEqual({ lifted: 1 });
    expect(await processJob({ name: 'identity.sanction-expire', data: {} })).toEqual({ lifted: 0 });
    expect((await models.User.findByPk(member.user.id)).status).toBe('active');
  });

  it('rejects unknown jobs', async () => {
    await expect(processJob({ name: 'nope' })).rejects.toThrow(/No processor/);
  });

  it('registers job schedulers in Redis, once however many pods call it', async () => {
    await registerSchedules();
    await registerSchedules();
    const schedulers = await getQueue(QUEUES.IDENTITY).getJobSchedulers();
    const ours = schedulers.filter((s) => s.key === 'identity.sanction-expire' || s.id === 'identity.sanction-expire');
    expect(ours).toHaveLength(1);
    expect(Number(ours[0].every)).toBe(60000);
  });
});

describe('probes', () => {
  afterEach(() => lifecycle._reset());

  it('is live always, and ready only when dependencies are up and not draining', async () => {
    const ops = createOpsApp({ checks: { db: async () => true, redis: () => pingRedis() } });
    await request(ops).get('/health/live').expect(200);
    await request(ops).get('/health/ready').expect(503); // not marked ready yet

    lifecycle.setReady(true);
    const ready = await request(ops).get('/health/ready').expect(200);
    expect(ready.body).toMatchObject({ status: 'ready', db: 'up', redis: 'up', draining: false });

    await lifecycle.shutdown('SIGTERM', { exit: false });
    const draining = await request(ops).get('/health/ready').expect(503);
    expect(draining.body).toMatchObject({ status: 'not_ready', draining: true });
    await request(ops).get('/health/live').expect(200);
  });

  it('is not ready when a dependency is down', async () => {
    lifecycle.setReady(true);
    const ops = createOpsApp({ checks: { db: async () => { throw new Error('down'); } } });
    const r = await request(ops).get('/health/ready').expect(503);
    expect(r.body.db).toBe('down');
  });

  it('serves Prometheus metrics', async () => {
    const r = await request(createOpsApp()).get('/metrics').expect(200);
    expect(r.text).toMatch(/http_request_duration_seconds/);
  });

  it('runs shutdown closers in reverse order, once', async () => {
    const order = [];
    lifecycle.onShutdown('first', async () => order.push('first'));
    lifecycle.onShutdown('second', async () => order.push('second'));
    await Promise.all([lifecycle.shutdown('SIGTERM', { exit: false }), lifecycle.shutdown('SIGTERM', { exit: false })]);
    expect(order).toEqual(['second', 'first']);
  });
});

describe('realtime handshake', () => {
  let server;
  let url;
  const sockets = [];

  beforeAll(async () => {
    server = http.createServer();
    createRealtimeServer(server);
    await new Promise((resolve) => server.listen(0, resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => sockets.splice(0).forEach((s) => s.close()));
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  function open(auth) {
    const socket = connect(url, { transports: ['websocket'], auth, reconnection: false, forceNew: true });
    sockets.push(socket);
    return new Promise((resolve) => {
      socket.on('ready', (info) => resolve({ ok: true, info }));
      socket.on('connect_error', (err) => resolve({ ok: false, code: err.data?.code ?? err.message }));
    });
  }

  it('joins the user room with a valid customer token', async () => {
    const s = await h.signupUser();
    const r = await open({ token: s.accessToken });
    expect(r).toEqual({ ok: true, info: { userId: s.user.id, rooms: [`user:${s.user.id}`] } });
  });

  it('rejects missing, forged and expired tokens', async () => {
    expect(await open({})).toEqual({ ok: false, code: 'AUTH_REQUIRED' });
    expect(await open({ token: 'not-a-jwt' })).toEqual({ ok: false, code: 'AUTH_REQUIRED' });
    const s = await h.signupUser();
    const { sid, av } = jwt.decode(s.accessToken);
    const expired = jwt.sign({ sid, av, typ: 'access' }, config.auth.accessSecret, {
      subject: s.user.id, issuer: config.auth.issuer, audience: 'api', expiresIn: -10, algorithm: 'HS256',
    });
    expect(await open({ token: expired })).toEqual({ ok: false, code: 'TOKEN_EXPIRED' });
  });

  it('checks the audience: customer tokens cannot join as admin', async () => {
    const s = await h.signupUser();
    expect(await open({ token: s.accessToken, audience: 'admin' })).toEqual({ ok: false, code: 'TOKEN_AUDIENCE_INVALID' });
  });

  it('puts admin sockets in the staff room', async () => {
    const master = await h.createSignedInMaster();
    const r = await open({ token: master.accessToken, audience: 'admin' });
    expect(r.ok).toBe(true);
    expect(r.info.rooms).toEqual(expect.arrayContaining([`user:${master.userId}`, 'staff']));
  });
});

describe('OpenAPI contract (ADR-002)', () => {
  it('is served and matches the committed openapi.json', async () => {
    const r = await api().get('/api/docs/openapi.json').expect(200);
    expect(r.body.openapi).toBe('3.1.0');
    const committed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'openapi.json'), 'utf8'));
    expect(buildOpenApi()).toEqual(committed); // run `npm run openapi` after changing a schema
  });

  it('documents every Express route', () => {
    const doc = buildOpenApi();
    const mounts = [
      ['/auth', require('../../src/modules/auth/auth.routes')],
      ['/me', require('../../src/modules/users/users.routes')],
      ['/admin', require('../../src/modules/admin/admin.routes')],
      ...(() => {
        const pr = require('../../src/modules/payments/payments.routes');
        return [
          ['/payments', pr.payerRouter],
          ['/me/payments', pr.meRouter],
          ['/webhooks', pr.webhookRouter],
          ['/admin/payments', pr.adminPayments],
          ['/admin/refunds', pr.adminRefunds],
          ['/admin/ledger', pr.adminLedger],
          ['/admin/escrow', pr.adminEscrow],
          ['/admin/reconciliation', pr.adminRecon],
        ];
      })(),
      ...(() => {
        const po = require('../../src/modules/payouts/payouts.routes');
        return [
          ['/me/payout-accounts', po.meAccounts],
          ['/me/payouts', po.mePayouts],
          ['/admin/payouts', po.adminPayouts],
          ['/admin/payout-batches', po.adminBatches],
          ['/admin/payout-accounts', po.adminAccounts],
        ];
      })(),
    ];
    const missing = [];
    for (const [prefix, router] of mounts) {
      for (const layer of router.stack.filter((l) => l.route)) {
        const p = `${prefix}${layer.route.path === '/' ? '' : layer.route.path}`.replace(/:(\w+)/g, '{$1}');
        for (const method of Object.keys(layer.route.methods)) {
          if (!doc.paths[p]?.[method]) missing.push(`${method.toUpperCase()} ${p}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('describes real responses', async () => {
    const s = await h.signupUser();
    const me = await api().get(`${P}/me`).set(h.bearer(s)).expect(200);
    expect(C.Me.safeParse(me.body).error).toBeUndefined();
    const master = await h.createSignedInMaster();
    const adminMe = await api().get(`${P}/admin/me`).set(h.bearer(master)).expect(200);
    expect(C.Me.safeParse(adminMe.body).error).toBeUndefined();
    const staff = await api().get(`${P}/admin/staff`).set(h.bearer(master)).expect(200);
    expect(C.StaffList.safeParse(staff.body).error).toBeUndefined();
    const sessions = await api().get(`${P}/me/sessions`).set(h.bearer(s)).expect(200);
    expect(C.SessionItem.array().safeParse(sessions.body.data).error).toBeUndefined();
  });
});
