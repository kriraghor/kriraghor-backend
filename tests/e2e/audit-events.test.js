'use strict';

// M04 audit log and domain events: transactional writes, append-only tables, hash chain, outbox relay,
// inbox idempotency, dead letters, replay, M01 producers, audit API and exports.
const h = require('../helpers');
const { closeAllRedis } = require('../../src/common/redis');
const { processJob } = require('../../src/jobs/runtime');
const audit = require('../../src/modules/audit/audit.service');
const chain = require('../../src/modules/audit/audit.chain');
const events = require('../../src/modules/events/events.service');
const relay = require('../../src/modules/events/events.relay');
const consumers = require('../../src/modules/events/events.consumers');

const { api, P, models } = h;
const { sequelize } = models;

beforeEach(h.resetDb);
afterEach(() => consumers.useDispatcher(null));
afterAll(async () => {
  await closeAllRedis();
  await sequelize.close();
});

// Test consumers, registered once; each test sets what they do.
const calls = { restored: [], banned: 0 };
let restoredHandler = async () => {};
consumers.onEvent('user.restored', 'test.restored', async (event, ctx) => restoredHandler(event, ctx));
consumers.onEvent('user.banned', 'test.banned', async () => {
  calls.banned += 1;
});

const publishRestored = (userId) => sequelize.transaction((t) => events.publish(t, { name: 'user.restored', aggregateType: 'user', aggregateId: userId, payload: { userId } }));
const outboxNames = async () => (await models.OutboxEvent.findAll({ order: [['id', 'ASC']] })).map((r) => r.name);
const uid = () => require('crypto').randomUUID();

describe('transactional writes (M04-FR-01, FR-12)', () => {
  it('a rolled-back change leaves neither an audit row nor an outbox event', async () => {
    await expect(
      sequelize.transaction(async (transaction) => {
        await audit.record({ action: 'user.restored', entityType: 'user', entityId: 'x' }, { transaction });
        await events.publish(transaction, { name: 'user.restored', aggregateType: 'user', aggregateId: uid(), payload: { userId: uid() } });
        throw new Error('business rule failed');
      })
    ).rejects.toThrow('business rule failed');
    expect(await models.AuditLog.count()).toBe(0);
    expect(await models.OutboxEvent.count()).toBe(0);
  });

  it('a failed audit write fails the business change', async () => {
    const master = await h.createSignedInMaster();
    const target = await h.signupUser();
    const spy = jest.spyOn(models.AuditLog, 'create').mockRejectedValueOnce(new Error('disk full'));
    await api().post(`${P}/admin/users/${target.user.id}/suspend`).set(h.bearer(master)).send({ reasonCode: 'abuse', note: 'Abusive messages' }).expect(500);
    spy.mockRestore();
    expect((await models.User.findByPk(target.user.id)).status).toBe('active');
    expect(await models.OutboxEvent.count({ where: { name: 'user.suspended' } })).toBe(0);
  });

  it('rejects unknown events, invalid payloads and personal data before commit', async () => {
    const bad = [
      { name: 'user.vanished', payload: {} },
      { name: 'user.restored', payload: { userId: 'not-a-uuid' } },
      { name: 'user_role.applied', payload: { userId: uid(), role: 'player', phone: '0171' } },
    ];
    for (const e of bad) {
      await expect(sequelize.transaction((t) => events.publish(t, { ...e, aggregateType: 'user', aggregateId: 'x' }))).rejects.toMatchObject({ code: 'EVENT_INVALID' });
    }
    expect(await models.OutboxEvent.count()).toBe(0);
  });

  it('builds the envelope: version, aggregate, actor, correlation and DB time', async () => {
    const userId = uid();
    await sequelize.transaction((t) => events.publish(t, { name: 'user.restored', aggregateType: 'user', aggregateId: userId, payload: { userId }, actor: { id: userId }, correlationId: 'req-1' }));
    const row = await models.OutboxEvent.findOne();
    expect(row).toMatchObject({ name: 'user.restored', version: 1, aggregateType: 'user', aggregateId: userId, status: 'pending', attempts: 0, payload: { userId } });
    expect(row.metadata).toEqual({ actor: { type: 'user', id: userId }, correlationId: 'req-1', causationId: null });
    expect(row.occurredAt).toBeInstanceOf(Date);
    expect(row.id).toMatch(/^[0-9a-f-]{14}7/);
  });
});

describe('audit rows (M04-FR-02, FR-04, FR-11)', () => {
  it('records actor type, module, severity, step-up, session and redacted values', async () => {
    const master = await h.createSignedInMaster();
    const target = await h.signupUser();
    const token = await h.stepUp(master, 'user.ban');
    await api().post(`${P}/admin/users/${target.user.id}/ban`).set(h.bearer(master)).set('X-Step-Up', token).send({ reasonCode: 'fraud', note: 'Fake NID documents' }).expect(200);
    const row = await models.AuditLog.findOne({ where: { action: 'user.banned' } });
    expect(row).toMatchObject({ actorType: 'master', actorRole: 'master_admin', module: 'M01', severity: 'critical', stepUp: true, actorId: master.userId });
    expect(row.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // Critical → audit.critical_recorded in the same transaction (FR-11), plus the M01 event.
    expect(await outboxNames()).toEqual(expect.arrayContaining(['audit.critical_recorded', 'user.banned', 'session.revoked']));
    const critical = await models.OutboxEvent.findOne({ where: { name: 'audit.critical_recorded' } });
    expect(critical.payload).toMatchObject({ auditLogId: String(row.id), action: 'user.banned', actorId: master.userId, entityId: target.user.id });

    const email = await models.AuditLog.findOne({ where: { action: 'auth.signed_in', actorId: master.userId } });
    expect(email.actorType).toBe('user'); // { id } only: no principal yet at sign-in
  });

  it('audit_logs and audit_chain refuse UPDATE and DELETE (DB triggers and model hooks)', async () => {
    await audit.record({ action: 'user.restored', entityType: 'user', entityId: 'x' });
    await chain.seal();
    for (const sql of ["UPDATE audit_logs SET action = 'x'", 'DELETE FROM audit_logs', "UPDATE audit_chain SET row_hash = 'x'", 'DELETE FROM audit_chain']) {
      await expect(sequelize.query(sql)).rejects.toThrow(/append-only/);
    }
    const row = await models.AuditLog.findOne();
    await expect(row.update({ action: 'x' })).rejects.toThrow(/append-only/);
    await expect(models.AuditChain.destroy({ where: {} })).rejects.toThrow(/append-only/);
  });

  it('throws for an unregistered action in tests (FR-06)', async () => {
    await expect(audit.record({ action: 'thing.done' })).rejects.toThrow(/not in audit.actions.js/);
  });
});

describe('hash chain (M04-FR-05)', () => {
  it('seals committed rows in order, verifies, and detects an edited row', async () => {
    for (let i = 0; i < 5; i += 1) await audit.record({ action: 'user.restored', entityType: 'user', entityId: `u${i}`, meta: { i } });
    expect(await chain.seal({ batch: 3 })).toMatchObject({ sealed: 3, lastSeq: 3 });
    expect(await chain.seal({ batch: 3 })).toMatchObject({ sealed: 2, lastSeq: 5 });
    expect(await chain.seal()).toEqual({ sealed: 0 });
    expect(await chain.verify({ pageSize: 2 })).toEqual({ checked: 5, ok: true, unsealedOlderThanHour: 0 });
    expect(await chain.verify({ fromSeq: 3 })).toMatchObject({ checked: 3, ok: true });

    const third = await models.AuditChain.findByPk(3);
    // Simulate tampering by someone who can drop the trigger.
    await sequelize.query('DROP TRIGGER trg_audit_logs_no_update');
    try {
      await sequelize.query("UPDATE audit_logs SET entity_id = 'forged' WHERE id = ?", { replacements: [third.auditLogId] });
    } finally {
      await sequelize.query("CREATE TRIGGER trg_audit_logs_no_update BEFORE UPDATE ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only'");
    }
    expect(await chain.verify()).toEqual({ checked: 2, ok: false, firstBad: { seq: 3, auditLogId: String(third.auditLogId) } });
    const row = await models.AuditLog.findByPk(third.auditLogId);
    expect(await chain.statusOf(row)).toEqual({ sealed: true, seq: 3, intact: false });
  });

  it('a second sealer waits its turn instead of forking the chain', async () => {
    for (let i = 0; i < 4; i += 1) await audit.record({ action: 'user.restored', entityType: 'user', entityId: `u${i}` });
    const results = await Promise.all([chain.seal(), chain.seal()]);
    expect(results.map((r) => r.sealed).sort()).toEqual([0, 4]);
    expect(await chain.verify()).toMatchObject({ ok: true, checked: 4 });
  });

  it('the nightly job publishes audit.chain_mismatch_detected only on a mismatch', async () => {
    await audit.record({ action: 'user.restored', entityType: 'user', entityId: 'u' });
    await processJob({ name: 'audit.chain-seal', data: {} });
    expect(await processJob({ name: 'audit.chain-verify', data: {} })).toMatchObject({ ok: true, checked: 1 });
    expect(await models.OutboxEvent.count({ where: { name: 'audit.chain_mismatch_detected' } })).toBe(0);
  });
});

describe('relay and consumers (M04-FR-13, FR-14, FR-16, FR-17)', () => {
  it('parallel relays enqueue each (event, consumer) exactly once and mark events published', async () => {
    const userId = uid();
    for (let i = 0; i < 25; i += 1) await publishRestored(userId);
    const dispatched = [];
    consumers.useDispatcher(async (job) => {
      dispatched.push(job.jobId);
    });
    const results = await Promise.all([relay.relayOnce({ batch: 10 }), relay.relayOnce({ batch: 10 }), relay.relayOnce({ batch: 10 })]);
    await relay.relayOnce({ batch: 10 });
    expect(results.reduce((n, r) => n + r.published, 0)).toBeGreaterThan(0);
    // Every user.restored goes to the test consumer and to M08 (notify.ACCOUNT_RESTORED).
    const mine = dispatched.filter((id) => id.endsWith('__test.restored'));
    expect(mine).toHaveLength(25);
    expect(new Set(dispatched).size).toBe(dispatched.length);
    expect(dispatched).toHaveLength(50);
    expect(await models.OutboxEvent.count({ where: { status: 'published' } })).toBe(25);
    expect(await relay.health()).toEqual({ pending: 0, oldestPendingSeconds: null });
  });

  it('an event with no consumers is still marked published; enqueue failures back off', async () => {
    await sequelize.transaction((t) => events.publish(t, { name: 'user.email_changed', aggregateType: 'user', aggregateId: 'x', payload: { userId: uid() } }));
    await publishRestored(uid());
    consumers.useDispatcher(async () => {
      throw new Error('redis down');
    });
    expect(await relay.relayOnce()).toEqual({ published: 1, failed: 1 });
    const failed = await models.OutboxEvent.findOne({ where: { name: 'user.restored' } });
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, lastError: 'redis down' });
    expect(failed.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(await relay.relayOnce()).toEqual({ published: 0, failed: 0 }); // not due yet
    expect((await relay.health()).pending).toBe(1);
  });

  it('processes each delivery once, even when it is delivered twice', async () => {
    calls.restored = [];
    restoredHandler = async (event, { transaction }) => {
      calls.restored.push(event.payload.userId);
      await audit.record({ action: 'user.restored', entityType: 'user', entityId: event.payload.userId }, { transaction });
    };
    const userId = uid();
    await publishRestored(userId);
    await relay.relayOnce();
    const job = consumers.takeTestJobs().find((j) => j.data.consumer === 'test.restored');
    expect(job).toMatchObject({ data: { consumer: 'test.restored' } });
    expect(await consumers.processConsume(job.data)).toEqual({ status: 'processed' });
    expect(await consumers.processConsume(job.data)).toEqual({ status: 'skipped' });
    expect(await processJob({ name: 'events.consume', data: job.data, attemptsMade: 0 })).toEqual({ status: 'skipped' });
    expect(calls.restored).toEqual([userId]);
    expect(await models.ConsumedEvent.findOne({ where: { consumer: 'test.restored' } })).toMatchObject({ status: 'processed', attempts: 1, eventName: 'user.restored' });
    expect(await models.AuditLog.count({ where: { entityId: userId } })).toBe(1);
  });

  it('a failing handler rolls back its work, retries, then dead-letters without blocking others', async () => {
    await h.setSettingForTest('events.consumer_max_attempts', 3);
    restoredHandler = async (event, { transaction }) => {
      await audit.record({ action: 'user.restored', entityType: 'user', entityId: event.payload.userId }, { transaction });
      throw new Error('downstream unavailable');
    };
    const poison = uid();
    await publishRestored(poison);
    await relay.relayOnce();
    const job = consumers.takeTestJobs().find((j) => j.data.consumer === 'test.restored');
    for (let attemptsMade = 0; attemptsMade < 3; attemptsMade += 1) {
      await expect(consumers.processConsume(job.data, { attemptsMade })).rejects.toThrow('downstream unavailable');
    }
    expect(await models.AuditLog.count({ where: { entityId: poison } })).toBe(0);
    expect(await models.ConsumedEvent.findOne({ where: { eventId: job.data.eventId } })).toMatchObject({ status: 'dead', attempts: 3, lastError: 'downstream unavailable' });
    const alert = await models.OutboxEvent.findOne({ where: { name: 'outbox.event_dead_lettered' } });
    expect(alert.payload).toEqual({ eventId: job.data.eventId, eventType: 'user.restored', consumer: 'test.restored', attempts: 3 });

    // Another event for the same consumer still goes through.
    restoredHandler = async () => {};
    await publishRestored(uid());
    await relay.relayOnce();
    const next = consumers.takeTestJobs().find((j) => j.data.consumer === 'test.restored');
    expect(await consumers.processConsume(next.data)).toEqual({ status: 'processed' });
  });

  it('a master replays a dead delivery with step-up; it then processes once', async () => {
    await h.setSettingForTest('events.consumer_max_attempts', 1);
    restoredHandler = async () => {
      throw new Error('boom');
    };
    await publishRestored(uid());
    await relay.relayOnce();
    const job = consumers.takeTestJobs().find((j) => j.data.consumer === 'test.restored');
    await expect(consumers.processConsume(job.data)).rejects.toThrow('boom');

    const master = await h.createSignedInMaster();
    const dead = await api().get(`${P}/admin/events?status=dead`).set(h.bearer(master)).expect(200);
    expect(dead.body.items).toEqual([expect.objectContaining({ id: job.data.eventId, consumer: 'test.restored', status: 'dead', lastError: 'boom', consumers: expect.arrayContaining(['test.restored', 'notify.ACCOUNT_RESTORED']) })]);
    expect(dead.body.health).toEqual({ pending: 1, oldestPendingSeconds: expect.any(Number) }); // the dead-letter alert itself

    const noStepUp = await api().post(`${P}/admin/events/${job.data.eventId}/replay`).set(h.bearer(master)).send({ consumer: 'test.restored' }).expect(403);
    expect(noStepUp.body.code).toBe('STEP_UP_REQUIRED');
    const token = await h.stepUp(master, 'events.replay');
    const wrong = await api().post(`${P}/admin/events/${job.data.eventId}/replay`).set(h.bearer(master)).set('X-Step-Up', token).send({ consumer: 'nobody' }).expect(409);
    expect(wrong.body.code).toBe('EVENT_NOT_REPLAYABLE');
    const token2 = await h.stepUp(master, 'events.replay');
    await api().post(`${P}/admin/events/${job.data.eventId}/replay`).set(h.bearer(master)).set('X-Step-Up', token2).send({ consumer: 'test.restored' }).expect(202);
    expect(await models.AuditLog.findOne({ where: { action: 'outbox.event_replayed' } })).toMatchObject({ actorId: master.userId, stepUp: true, severity: 'notice' });

    restoredHandler = async () => {};
    const again = consumers.takeTestJobs().find((j) => j.data.consumer === 'test.restored');
    expect(again.jobId).toMatch(/__test\.restored__r\d+$/);
    expect(await consumers.processConsume(again.data)).toEqual({ status: 'processed' });
    expect(await models.ConsumedEvent.findOne({ where: { eventId: job.data.eventId } })).toMatchObject({ status: 'processed', attempts: 2 });
    const token3 = await h.stepUp(master, 'events.replay');
    const done = await api().post(`${P}/admin/events/${job.data.eventId}/replay`).set(h.bearer(master)).set('X-Step-Up', token3).send({ consumer: 'test.restored' }).expect(409);
    expect(done.body.code).toBe('EVENT_NOT_REPLAYABLE');
    const missing = await api().post(`${P}/admin/events/${uid()}/replay`).set(h.bearer(master)).set('X-Step-Up', await h.stepUp(master, 'events.replay')).send({ consumer: 'test.restored' }).expect(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });

  it('lists pending and failed events for ops; staff cannot', async () => {
    await publishRestored(uid());
    const master = await h.createSignedInMaster();
    const pending = await api().get(`${P}/admin/events?status=pending`).set(h.bearer(master)).expect(200);
    expect(pending.body.items.map((e) => e.name)).toContain('user.restored');
    const member = await h.signupUser();
    await api().get(`${P}/admin/events`).set(h.bearer(member)).expect(401);
  });
});

describe('M01 producers (M04 §6.3)', () => {
  it('signup, role decisions, suspension, restore and staff changes publish their events', async () => {
    const member = await h.signupUser({ role: 'ground_owner' });
    await h.verifyMember(member.user.id);
    const master = await h.createSignedInMaster();
    await api()
      .post(`${P}/admin/users/${member.user.id}/roles/ground_owner/status`)
      .set(h.bearer(master))
      .send({ status: 'in_review' })
      .expect(200);
    await api()
      .post(`${P}/admin/users/${member.user.id}/roles/ground_owner/status`)
      .set(h.bearer(master))
      .send({ status: 'active' })
      .expect(200);
    await api().post(`${P}/admin/users/${member.user.id}/suspend`).set(h.bearer(master)).send({ reasonCode: 'abuse', note: 'Abusive messages' }).expect(200);
    await api().post(`${P}/admin/users/${member.user.id}/restore`).set(h.bearer(master)).send({}).expect(200);
    const staffUser = await h.signupUser();
    const token = await h.stepUp(master, 'staff.write');
    await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', token).send({ userId: staffUser.user.id, employeeId: 'KG-EV-1', permissions: ['manage_users'] }).expect(201);

    const rows = await models.OutboxEvent.findAll({ order: [['id', 'ASC']] });
    const by = (name) => rows.filter((r) => r.name === name).map((r) => r.payload);
    expect(by('user.registered')).toEqual(expect.arrayContaining([{ userId: member.user.id, roles: ['member', 'ground_owner'] }]));
    expect(by('user_role.activated')).toEqual([{ userId: member.user.id, role: 'ground_owner' }]);
    expect(by('user.suspended')).toEqual([{ userId: member.user.id, sanctionId: expect.any(String), until: null }]);
    expect(by('user.restored')).toEqual([{ userId: member.user.id }]);
    expect(by('session.revoked')).toEqual(expect.arrayContaining([{ userId: member.user.id, cause: 'sanction', count: expect.any(Number) }]));
    expect(by('staff.invited')).toEqual([{ userId: staffUser.user.id }]);
    // No payload carries personal data (FR-18).
    for (const r of rows) expect([r.name, JSON.stringify(r.payload)]).not.toEqual([r.name, expect.stringMatching(/"(phone|email|displayName|name|nid|dob)"/)]);
  });
});

describe('audit API (M04 §9, FR-07, FR-08, FR-10)', () => {
  it('master search with filters, cursor and range cap; staff and customers cannot', async () => {
    const master = await h.createSignedInMaster();
    for (let i = 0; i < 3; i += 1) await audit.record({ action: 'user.restored', entityType: 'user', entityId: `u${i}`, actor: { id: master.userId, isMaster: true } });
    const page1 = await api().get(`${P}/admin/audit-logs?action=user.restored&limit=2`).set(h.bearer(master)).expect(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.items[0]).toMatchObject({ action: 'user.restored', module: 'M01', severity: 'notice', summary: { en: 'Restored the account', bn: 'অ্যাকাউন্ট পুনরুদ্ধার' }, actor: { type: 'master', name: 'Ayesha Siddiqua' }, entity: { type: 'user', id: 'u2' } });
    const page2 = await api().get(`${P}/admin/audit-logs?action=user.restored&limit=2&cursor=${page1.body.nextCursor}`).set(h.bearer(master)).expect(200);
    expect(page2.body.items.map((i) => i.entity.id)).toEqual(['u0']);
    expect(page2.body.nextCursor).toBeNull();

    const both = await api().get(`${P}/admin/audit-logs?action=user.restored,auth.signed_in&actorId=${master.userId}`).set(h.bearer(master)).expect(200);
    expect(new Set(both.body.items.map((i) => i.action))).toEqual(new Set(['user.restored', 'auth.signed_in']));
    const critical = await api().get(`${P}/admin/audit-logs?severity=critical&stepUp=true`).set(h.bearer(master)).expect(200);
    expect(critical.body.items).toEqual([]);

    const wide = await api().get(`${P}/admin/audit-logs?from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z`).set(h.bearer(master)).expect(422);
    expect(wide.body.code).toBe('RANGE_TOO_LARGE');
    await api().get(`${P}/admin/audit-logs?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z`).set(h.bearer(master)).expect(422);
    await api().get(`${P}/admin/audit-logs?cursor=abc`).set(h.bearer(master)).expect(422);

    const detail = await api().get(`${P}/admin/audit-logs/${page1.body.items[0].id}`).set(h.bearer(master)).expect(200);
    expect(detail.body.chain).toEqual({ sealed: false, seq: null, intact: null });
    await chain.seal();
    const sealed = await api().get(`${P}/admin/audit-logs/${page1.body.items[0].id}`).set(h.bearer(master)).expect(200);
    expect(sealed.body.chain).toMatchObject({ sealed: true, intact: true });
    await api().get(`${P}/admin/audit-logs/999999`).set(h.bearer(master)).expect(404);

    const member = await h.signupUser();
    await api().get(`${P}/admin/audit-logs`).set(h.bearer(member)).expect(401);
  });

  it('entity history: masters see every row, other staff only their own (FR-07)', async () => {
    const master = await h.createSignedInMaster();
    const member = await h.signupUser();
    const token = await h.stepUp(master, 'staff.write');
    await api().post(`${P}/admin/staff`).set(h.bearer(master)).set('X-Step-Up', token).send({ userId: member.user.id, employeeId: 'KG-H-1', permissions: ['manage_users'] }).expect(201);
    const staff = await h.signInStaff(member.phone, member.user.id);
    await audit.record({ action: 'user.restored', entityType: 'user', entityId: 'subject', actor: { id: master.userId, isMaster: true } });
    await audit.record({ action: 'user.restored', entityType: 'user', entityId: 'subject', actor: { id: staff.userId, isStaff: true } });

    const all = await api().get(`${P}/admin/entities/user/subject/history`).set(h.bearer(master)).expect(200);
    expect(all.body.items).toHaveLength(2);
    const own = await api().get(`${P}/admin/entities/user/subject/history`).set(h.bearer(staff)).expect(200);
    expect(own.body.items.map((i) => i.actor.id)).toEqual([staff.userId]);
    const denied = await api().get(`${P}/admin/audit-logs`).set(h.bearer(staff)).expect(403);
    expect(denied.body.code).toBe('MASTER_REQUIRED');
  });

  it('exports need step-up, build a CSV, audit themselves and expire', async () => {
    const master = await h.createSignedInMaster();
    await audit.record({ action: 'user.restored', entityType: 'user', entityId: '=cmd', actor: { id: master.userId, isMaster: true } });
    const noStepUp = await api().post(`${P}/admin/audit-logs/exports`).set(h.bearer(master)).send({ filters: {} }).expect(403);
    expect(noStepUp.body.code).toBe('STEP_UP_REQUIRED');
    const tooWide = await api()
      .post(`${P}/admin/audit-logs/exports`)
      .set(h.bearer(master))
      .set('X-Step-Up', await h.stepUp(master, 'audit.export'))
      .send({ filters: { from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' } })
      .expect(422);
    expect(tooWide.body.code).toBe('RANGE_TOO_LARGE');

    const token = await h.stepUp(master, 'audit.export');
    const created = await api().post(`${P}/admin/audit-logs/exports`).set(h.bearer(master)).set('X-Step-Up', token).send({ filters: { action: 'user.restored' } }).expect(202);
    expect(created.body).toMatchObject({ status: 'queued', downloadPath: null });
    const notReady = await api().get(`${P}/admin/audit-logs/exports/${created.body.id}/download`).set(h.bearer(master)).expect(409);
    expect(notReady.body.code).toBe('EXPORT_NOT_READY');

    expect(await processJob({ name: 'audit.export', data: { exportId: created.body.id } })).toEqual({ rows: 1 });
    expect(await processJob({ name: 'audit.export', data: { exportId: created.body.id } })).toEqual({ skipped: true });
    const ready = await api().get(`${P}/admin/audit-logs/exports/${created.body.id}`).set(h.bearer(master)).expect(200);
    expect(ready.body).toMatchObject({ status: 'ready', rowCount: 1, downloadPath: `/api/v1/admin/audit-logs/exports/${created.body.id}/download` });
    const csv = await api().get(`${P}/admin/audit-logs/exports/${created.body.id}/download`).set(h.bearer(master)).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = csv.text.trim().split('\r\n');
    expect(lines[0]).toBe('id,occurredAt,actorType,actorId,actorName,actorRole,action,summary,module,entityType,entityId,entityCode,severity,stepUp,reason,before,after,ip,requestId');
    expect(lines[1]).toContain(`"'=cmd"`);

    const exported = await models.AuditLog.findOne({ where: { action: 'audit_log.exported' } });
    expect(exported).toMatchObject({ actorId: master.userId, actorType: 'master', severity: 'critical', stepUp: true, after: { rowCount: 1, filters: { action: ['user.restored'] } } });
    expect(await outboxNames()).toEqual(expect.arrayContaining(['audit_log.exported', 'audit.critical_recorded']));

    const other = await h.createSecondMaster();
    await api().get(`${P}/admin/audit-logs/exports/${created.body.id}`).set(h.bearer(other)).expect(404);

    await sequelize.query('UPDATE audit_exports SET expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 MINUTE) WHERE id = ?', { replacements: [created.body.id] });
    const expired = await api().get(`${P}/admin/audit-logs/exports/${created.body.id}/download`).set(h.bearer(master)).expect(410);
    expect(expired.body.code).toBe('EXPORT_EXPIRED');
    expect((await api().get(`${P}/admin/audit-logs/exports/${created.body.id}`).set(h.bearer(master))).body.status).toBe('expired');
  });

  it('a failed export is marked failed', async () => {
    const master = await h.createSignedInMaster();
    const row = await models.AuditExport.create({ requestedBy: master.userId, filters: { from: 'not a date' } });
    await expect(processJob({ name: 'audit.export', data: { exportId: row.id } })).rejects.toThrow();
    expect((await row.reload()).status).toBe('failed');
  });
});
