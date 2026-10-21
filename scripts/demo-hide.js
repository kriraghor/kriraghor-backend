#!/usr/bin/env node
'use strict';
/* eslint-disable no-console -- a command-line tool: its output is the report */

/**
 * Hide every demo record listed in demo_records (see scripts/demo/README.md). Nothing is deleted:
 *  - demo esports events that have not finished are cancelled (entries refunded by M21), the showcase is cancelled;
 *  - demo sports events are cancelled by their organiser;
 *  - demo accounts are suspended, which pauses their venues, gyms, shops and hire profiles and withdraws
 *    their esports entries (the existing user.suspended consumers);
 *  - the demo staff (the reviewer and the demo sign-in staff) are offboarded. The demo master keeps no way
 *    to sign in (no phone, email or password).
 *
 *   node scripts/demo-hide.js --dry-run        list what would change
 *   node scripts/demo-hide.js [--confirm-live]
 */
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const config = require('../src/config');

if (config.isProd && !args['confirm-live'] && !args['dry-run']) {
  console.error('This is a production database. Re-run with --confirm-live (or --dry-run first).');
  process.exit(2);
}

const rt = require('./demo/runtime');

const REASON = 'Demo data hidden';
const FINISHED = ['finalised', 'paid_out', 'cancelled'];

async function main() {
  await rt.boot({ profile: 'listings' });
  const { models } = rt;
  const rows = await models.DemoRecord.findAll();
  const of = (entity) => rows.filter((r) => r.entity === entity).map((r) => r.entityId);
  const dry = Boolean(args['dry-run']);
  const say = (msg) => console.log(`${dry ? '[dry run] ' : ''}${msg}`);

  const masterId = rows.find((r) => r.entity === 'staff' && r.label === 'master')?.entityId;
  if (!masterId) {
    console.log('No demo data found.');
    return;
  }
  const master = await rt.actor(await models.User.findByPk(masterId), { staff: true });

  // Esports events and the showcase.
  for (const id of of('esports_event')) {
    const e = await models.EsportsEvent.findByPk(id);
    if (e && e.status !== 'cancelled') {
      say(`cancel showcase "${e.titleEn}"`);
      if (!dry) await rt.post(master, `/admin/esports/events/${id}/cancel`, { reason: REASON });
    }
  }
  for (const id of of('esports_tournament')) {
    const t = await models.EsportsTournament.findByPk(id);
    if (t && !FINISHED.includes(t.status)) {
      say(`cancel esports event "${t.titleEn}" (${t.status})`);
      if (!dry) await rt.post(master, `/admin/esports/tournaments/${id}/cancel`, { reason: REASON }, { headers: { 'X-Step-Up': await rt.stepUp(master, 'esports.money') } });
    }
  }

  // Sports events, by their organiser while the account is still active.
  const orgId = of('organisation')[0];
  if (orgId) {
    const org = await models.Organisation.findByPk(orgId);
    const organiser = await rt.actor(await models.User.findByPk(org.ownerUserId));
    for (const id of of('sports_tournament')) {
      const t = await models.Tournament.findByPk(id);
      if (t && !['cancelled', 'completed'].includes(t.status)) {
        say(`cancel sports event "${t.name}" (${t.status})`);
        if (!dry) await rt.post(organiser, `/org/${orgId}/sports/tournaments/${id}/cancel`, { reason: REASON }, { ok: [409] });
      }
    }
  }
  await rt.drain();

  // Accounts: suspension pauses their listings through the existing consumers.
  let n = 0;
  for (const id of of('user')) {
    const u = await models.User.findByPk(id);
    if (u && u.status === 'active') {
      n += 1;
      if (!dry) await rt.post(master, `/admin/users/${id}/suspend`, { reasonCode: 'other', note: REASON }, { ok: [409] });
    }
  }
  say(`suspend ${n} demo accounts (their venues, gyms, shops and hire profiles pause)`);
  await rt.drain();

  // Every demo staff account but the master: the review desk and the demo sign-in staff (steps/access.js).
  for (const r of rows.filter((x) => x.entity === 'staff' && x.label !== 'master')) {
    const staff = await models.StaffMember.findOne({ where: { userId: r.entityId } });
    if (staff && staff.status !== 'offboarded') {
      say(`offboard the demo staff account ${r.label}`);
      if (!dry) await rt.post(master, `/admin/staff/${r.entityId}/offboard`, { note: REASON }, { headers: { 'X-Step-Up': await rt.stepUp(master, 'staff.write') }, ok: [404, 409, 422] });
    }
  }
  await rt.drain();
  console.log(dry ? 'Dry run: nothing changed.' : 'Demo data hidden.');
}

main()
  .then(() => rt.shutdown())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`Failed: ${err.message}`);
    await rt.shutdown().catch(() => {});
    process.exit(1);
  });
