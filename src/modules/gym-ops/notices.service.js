'use strict';

/**
 * M27 round 2: notices to members (feature `notices`, Standard plan; FR-62 to FR-65).
 *  - The owner or staff with notices.send write a title and a message (gym_ops limits) for a segment: all
 *    active members, memberships ending in N days, expired in the last N days, not seen in N days, on a
 *    package, or booked on a class. The estimate shows how many can be reached and how (app, email, none).
 *  - Sending stores the notice (append-only) and publishes gym_notice.sent; M08 delivers it in-app and by
 *    push to linked members and by email to unlinked members with an email (recipient adapter gym_member).
 *    No SMS: promotional SMS needs a registered sender (M08 §1.3).
 *  - At most gym_ops.notice_daily_cap notices per gym per Dhaka day (429 GYM_NOTICE_CAP).
 */
const { sequelize, GymNotice } = require('../../models');
const directory = require('../users').directory;
const rules = require('./gym-ops.rules');
const c = require('./gym-ops.common');

const FEATURE = 'notices';

async function memberIdsOf(gymId, segment) {
  if (segment.kind === 'class') return c.ops.segmentMemberIds(gymId, { kind: 'members', memberIds: await require('./classes.service').memberIdsOfClass(gymId, segment.classId) });
  return c.ops.segmentMemberIds(gymId, segment);
}

function checkSegment(segment) {
  const block = rules.segmentBlock(segment, { daysMax: c.cfg().noticeDaysMax });
  if (block) throw c.fail(block);
}

/** POST …/notices/estimate { segment } (owner or notices.send): how many members, and how each can be reached. */
async function estimate(principal, gymId, { segment }) {
  await c.access(principal, gymId, 'notices.send', { feature: FEATURE });
  checkSegment(segment);
  const ids = await memberIdsOf(gymId, segment);
  const reach = await c.ops.reachOf(gymId, ids);
  return { members: ids.length, reach: reach.counts, sentToday: await sentToday(gymId), dailyCap: c.cfg().noticeDailyCap };
}

const sentToday = (gymId, transaction) => GymNotice.count({ where: { gymId, localDate: c.today() }, transaction });

/** POST …/notices { title, body, segment } (owner or notices.send): send now (FR-63). */
async function send(principal, gymId, { title, body, segment }, req) {
  const a = await c.access(principal, gymId, 'notices.send', { feature: FEATURE, restricted: true });
  checkSegment(segment);
  const ids = await memberIdsOf(gymId, segment);
  const reach = await c.ops.reachOf(gymId, ids);
  const reachable = reach.counts.app + reach.counts.email;
  if (!reachable) throw c.fail('GYM_NOTICE_NOBODY');
  const n = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `gym_notices:${gymId}` }, transaction });
    if ((await sentToday(gymId, transaction)) >= c.cfg().noticeDailyCap) throw c.fail('GYM_NOTICE_CAP', { cap: c.cfg().noticeDailyCap });
    const channels = [...(reach.counts.app ? ['in_app', 'push'] : []), ...(reach.counts.email ? ['email'] : [])];
    const row = await GymNotice.create({ gymId, title, body, segment, channels, targetCount: reachable, localDate: c.today(), sentBy: principal.id }, { transaction });
    await c.publish(transaction, 'gym_notice.sent', 'gym_notice', row.id, { noticeId: row.id, gymId, targetCount: reachable }, a.actor);
    await c.record({ action: 'gym_notice.sent', actor: a.actor, entityType: 'gym_notice', entityId: row.id, after: { segment: segment.kind, targetCount: reachable }, meta: { gymId }, req }, transaction);
    return row;
  });
  return view(n, await directory.displayNames([n.sentBy]));
}

const view = (n, names) => ({
  id: n.id,
  title: n.title,
  body: n.body,
  segment: n.segment,
  channels: n.channels,
  targetCount: n.targetCount,
  sentBy: { id: n.sentBy, displayName: names.get(n.sentBy) ?? null },
  sentAt: c.iso(n.createdAt),
});

/** GET …/notices (owner or notices.send): the gym's notices, newest first. */
async function list(principal, gymId) {
  await c.access(principal, gymId, 'notices.send', { feature: FEATURE });
  const rows = await GymNotice.findAll({ where: { gymId }, order: [['createdAt', 'DESC']], limit: 100 });
  const names = await directory.displayNames(rows.map((r) => r.sentBy));
  return { items: rows.map((r) => view(r, names)), sentToday: await sentToday(gymId), dailyCap: c.cfg().noticeDailyCap };
}

/** M08 targets of a notice (recipients, at delivery): { userIds, external } of its segment now. */
async function targets(noticeId) {
  const n = await GymNotice.findByPk(noticeId);
  if (!n) return { userIds: [], external: [] };
  const reach = await c.ops.reachOf(n.gymId, await memberIdsOf(n.gymId, n.segment));
  return { userIds: reach.userIds, external: reach.external };
}

/** Title and message for the M08 template values. */
async function facts(noticeId) {
  const n = await GymNotice.findByPk(noticeId);
  return n ? { title: n.title, body: n.body, gymId: n.gymId } : null;
}

module.exports = { estimate, send, list, targets, facts };
