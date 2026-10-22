'use strict';

/**
 * Round B3 demo business staff (data.js BUSINESS_STAFF): a front desk at Kamal Hossain's first venue,
 * a front desk at one of Nusrat Jahan's gyms and a packer at Mahbub Alam's shop.
 *
 * - Each is an ordinary member signed up with a demo phone (so the phone is verified; no NID, Q169),
 *   then added by the owner through the real POST /me/team with the business type's default
 *   permissions. Never Kriraghor staff (the route refuses staff accounts anyway).
 * - Runs in the listings profile after the venues, shops and gyms, and with --access-only (DEMO_SEED=access),
 *   so a database that already has the listings gets them too. Needs the owner and the listing: without
 *   them the row says "missing" and nothing is made.
 * - Idempotent: someone already on the team is left as is (ALREADY_MEMBER is accepted), and someone the
 *   owner removed is not added back. Their password comes from steps/access.js like every demo sign-in.
 * - demo:hide suspends them with the other demo accounts (they are demo users), and suspends their
 *   owners, whose staff lose access at once (business-members LIVE_OWNER).
 */
const rt = require('../runtime');
const people = require('./people');
const D = require('../data');
const rules = require('../../../src/modules/business-members/business-members.rules');

/** The demo_records entity and label of each business type's listing (steps/listings.js). */
const LISTING = { venue: 'ground', gym: 'gym', shop: 'shop' };

/** The expected permissions of each demo staff member: the business type's defaults (B3). */
const permissionsOf = (s) => rules.defaultsFor(s.businessType);

/** Adds each demo staff member to their business. Returns [{ phone, name, business, permissions, result }]. */
async function run() {
  const rows = [];
  for (const s of D.BUSINESS_STAFF) {
    const row = { phone: people.phoneOf(s.n), name: s.name, business: s.business, permissions: permissionsOf(s) };
    const ownerData = D.OWNERS.find((o) => o.n === s.owner);
    const ownerUser = await rt.models.User.findOne({ where: { phone: people.phoneOf(s.owner) } });
    const businessId = await rt.marked(LISTING[s.businessType], `${LISTING[s.businessType]}:${s.business}`);
    if (!ownerUser || !businessId) {
      rows.push({ ...row, result: 'missing (run the listings seed first)' });
      continue;
    }
    const owner = await people.member(s.owner, ownerData.name);
    const staff = await people.member(s.n, s.name);
    const q = new URLSearchParams({ businessType: s.businessType, businessId, status: 'all' });
    const team = await rt.get(owner, `/me/team?${q}`);
    const mine = team.items.filter((m) => m.member.id === staff.userId);
    if (mine.some((m) => m.status === 'active')) {
      rows.push({ ...row, result: 'already on the team' });
      continue;
    }
    if (mine.length) {
      rows.push({ ...row, result: 'removed by the owner (left as is)' });
      continue;
    }
    const res = await rt.post(owner, '/me/team', { businessType: s.businessType, businessId, phone: people.phoneOf(s.n) }, { ok: [409] });
    if (res?.code && res.code !== 'ALREADY_MEMBER') throw new rt.ApiError('POST', '/me/team', 409, res);
    rows.push({ ...row, result: res?.code === 'ALREADY_MEMBER' ? 'already on the team' : 'added' });
  }
  await rt.drain();
  return rows;
}

module.exports = { run, permissionsOf, LISTING };
