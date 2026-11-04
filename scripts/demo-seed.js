#!/usr/bin/env node
'use strict';
/* eslint-disable no-console -- a command-line tool: its output is the report */

/**
 * Demo data for every public section (see scripts/demo/README.md).
 *
 *   node scripts/demo-seed.js --profile=listings [--confirm-live]   venues, shops, gyms, hire, events (no payments)
 *   node scripts/demo-seed.js --profile=full                         everything, payments through the simulator (never production)
 *   node scripts/demo-seed.js --access-only [--confirm-live]         the demo business staff (B3) and the demo sign-in accounts (needs DEMO_PASSWORD)
 *   node scripts/demo-seed.js --sports-only [--confirm-live]         only the sports events: closes the retired ones, adds the new ones (listings must exist)
 *
 * Every record is created through the real API and approved on the Moderation desk, and is listed in
 * demo_records so `npm run demo:hide` can hide it all later. Re-running skips what already exists.
 */
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const profile = args.profile ?? 'listings';
if (!['listings', 'full'].includes(profile)) {
  console.error('Use --profile=listings or --profile=full');
  process.exit(2);
}

const config = require('../src/config');

if (config.isProd && profile === 'full') {
  console.error('Refusing: --profile=full needs the payment simulator, which production never runs. Use --profile=listings.');
  process.exit(2);
}
if (config.isProd && !args['confirm-live']) {
  console.error('This is a production database. Re-run with --confirm-live to add the demo listings.');
  process.exit(2);
}
if (profile === 'full' && !config.payments.simulator) {
  console.error('--profile=full needs PAYMENTS_SIMULATOR=true (local only).');
  process.exit(2);
}

const rt = require('./demo/runtime');
const L = require('./demo/steps/listings');
const people = require('./demo/steps/people');
const access = require('./demo/steps/access');
const team = require('./demo/steps/team');

async function step(name, fn) {
  const t = Date.now();
  process.stdout.write(`• ${name} … `);
  const r = await fn();
  console.log(`done (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  return r;
}

/** The demo sign-in accounts (steps/access.js): printed without the password, which only the host knows. */
async function signIns(master) {
  const { skipped, rows } = await step('demo sign-in accounts', () => access.run({ master }));
  if (skipped) {
    console.log(`  ${skipped}`);
    return;
  }
  console.log('\nDemo sign-in (phone number + the DEMO_PASSWORD you set; staff then set up an authenticator):');
  for (const r of rows) console.log(`  ${r.phone.replace('+880', '0')}  ${r.name.padEnd(22)} ${r.kind.padEnd(35)} ${r.where}  [${r.result}]`);
}

/** Round B3 business staff (steps/team.js): added by their owners through POST /me/team. */
async function businessStaff() {
  const rows = await step('business staff (venue and gym front desks, shop packer)', () => team.run());
  for (const r of rows) console.log(`  ${r.phone.replace('+880', '0')}  ${r.name.padEnd(16)} ${r.business.padEnd(22)} ${r.permissions.join(', ')}  [${r.result}]`);
}

async function main() {
  const started = Date.now();
  const { runId } = await rt.boot({ profile });
  console.log(`Demo seed ${runId} (${profile}) into ${config.db?.name ?? process.env.DB_NAME ?? 'the database'}`);

  // Hidden demo data stays hidden: demo:hide suspended its accounts, and the seeder never re-opens them.
  const demoUsers = (await rt.models.DemoRecord.findAll({ where: { entity: 'user' }, attributes: ['entityId'] })).map((r) => r.entityId);
  const hidden = demoUsers.length ? await rt.models.User.count({ where: { id: demoUsers, status: 'suspended' } }) : 0;
  if (hidden) {
    console.log(`Demo data was hidden (${hidden} demo accounts suspended). Nothing to do; restore those accounts on the admin desk to show it again.`);
    return;
  }

  const { master, reviewer } = await step('staff (no sign-in possible)', () => people.staff());
  if (args['access-only']) {
    await businessStaff();
    await signIns(master);
    return;
  }
  if (args['sports-only']) {
    if (!(await rt.marked('organisation', 'sports-org'))) throw new Error('--sports-only needs the demo organisation: run --profile=listings first.');
    await step('sports events', () => L.sports(reviewer));
    await rt.drain();
    console.log(`Finished in ${((Date.now() - started) / 60000).toFixed(1)} min.`);
    return;
  }
  const owner = await step('owners: sign-up, NID and business documents', () => L.owners(reviewer));
  await step('venues', () => L.venues(owner, reviewer));
  await step('shops and products', () => L.shops(owner, reviewer));
  const gymRows = await step('gyms', () => L.gyms(owner, reviewer));
  await businessStaff();
  const pros = await step('hire profiles and trainers', () => L.pros(reviewer, gymRows));
  const calendars = await step('availability calendars (referee, trainer)', () => require('./demo/steps/availability').run(pros));
  console.log(`  ${calendars.join('; ')}`);
  await step('esports players and game IDs', () => L.players(reviewer));
  await step('esports events', () => L.esports(master, reviewer, { free: profile === 'listings' }));
  await step('showcase', () => L.showcase(master, reviewer));
  await step('sports events', () => L.sports(reviewer));
  await step('open esports registration (waits for the opening minute)', () => L.openRegistrations());

  if (profile === 'full') {
    const full = require('./demo/steps/full');
    await full.run({ master, reviewer, owner, step });
  }

  await signIns(master);
  await rt.drain();
  const counts = await rt.models.DemoRecord.findAll({ attributes: ['entity', [rt.models.sequelize.fn('COUNT', '*'), 'n']], group: ['entity'], raw: true });
  console.log(`\nDemo records: ${counts.map((c) => `${c.entity} ${c.n}`).join(', ')}`);
  console.log(`Finished in ${((Date.now() - started) / 60000).toFixed(1)} min.`);
}

main()
  .then(() => rt.shutdown())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`\nFailed: ${err.message}`);
    if (err.body) console.error(JSON.stringify(err.body, null, 2).slice(0, 2000));
    if (!err.body && err.stack) console.error(err.stack.split('\n').slice(1, 6).join('\n'));
    await rt.shutdown().catch(() => {});
    process.exit(1);
  });
