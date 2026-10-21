'use strict';

/**
 * Round B2 fixtures (jest and the Postman runners): a live shop with turf boots and paid orders, a
 * live gym with passes sold and used at the front desk, and a sports organisation with an event and
 * registrations in every state the organiser dashboard counts.
 */
const h = require('../helpers');
const f = require('./market');
const g = require('./gym');
const tf = require('./tournaments');

const { api, P, models } = h;

/** A live shop with turf boots at `price` poisha a pair in sizes 40–45 (`stock` each). */
async function bootShop(docsReviewer, reviewer, { name = 'Elephant Road Sports', price = 260000, stock = 3 } = {}) {
  const owner = await f.shopOwner(docsReviewer, name);
  await f.liveShop(owner, reviewer, { name });
  const ready = await f.readyBoots(owner, { stock, over: { title: `${name} Turf Boots`, basePricePoisha: price } });
  const product = await f.liveProduct(owner, reviewer, ready);
  return { owner, product, variant: (size) => product.variants.find((v) => v.attributes.eu_size === size).id };
}

/** The buyer's shipping details (personal data that must never reach an analytics export). */
const SHIP = { name: 'Tanvir Hasan', phone: '01711000111', line: 'House 12, Road 5, Dhanmondi' };

/** One pair of each size from the shop, checked out and paid; returns the sub-order. */
async function paidOrder(buyer, shop, sizes) {
  for (const s of sizes) await api().put(`${P}/me/cart/items/${shop.variant(s)}`).set(h.bearer(buyer)).send({ qty: 1 }).expect(200);
  const areaId = await f.areaId('dhanmondi');
  const total = (await api().post(`${P}/checkout/quote`).set(h.bearer(buyer)).send({ areaId }).expect(200)).body.total;
  const r = await api()
    .post(`${P}/checkout`)
    .set(h.bearer(buyer))
    .set('Idempotency-Key', f.uniq('co'))
    .send({ ship: { ...SHIP, areaId }, expectedTotal: total })
    .expect(201);
  await h.payWithSimulator(buyer, r.body.payment.id);
  await h.drainEvents();
  return models.SubOrder.findOne({ where: { orderId: r.body.order.id } });
}

const shopPost = (who, id, action, body = {}) => api().post(`${P}/shop/sub-orders/${id}/${action}`).set(h.bearer(who)).send(body);

/** A live gym (the design's Iron Yard: day ৳400, month ৳4,500, quarter ৳12,000), open all day. */
async function liveGym(docsReviewer, reviewer, name = 'Iron Yard Fitness') {
  const owner = await g.gymOwner(docsReviewer, name);
  return { owner, gym: await g.liveGym(owner, reviewer) };
}

/** A paid pass of a kind; returns the holder's view (with the token for the front desk). */
async function paidPass(who, gym, kind, validFrom = g.today()) {
  const r = await api()
    .post(`${P}/gym/passes`)
    .set(h.bearer(who))
    .set('Idempotency-Key', f.uniq('gp'))
    .send({ packageId: gym.packages.find((p) => p.kind === kind).id, validFrom })
    .expect(201);
  await h.payWithSimulator(who, r.body.payment.id);
  await h.drainEvents();
  return (await api().get(`${P}/me/passes/${r.body.pass.code}`).set(h.bearer(who)).expect(200)).body.pass;
}

/** Admit a pass at the front desk (the owner scans the QR token). */
async function admit(owner, gym, pass) {
  await api().post(`${P}/me/gyms/${gym.id}/redemptions`).set(h.bearer(owner)).send({ token: pass.token }).expect(201);
  await h.drainEvents();
}

/**
 * A sports organisation with a paid event (4 places, ৳18,000 entry): three teams paid (two approved,
 * one waiting for approval) and a fourth registered but not paid yet. Captains have a verified NID.
 */
async function busyOrganiser(reviewer) {
  const { owner, org } = await tf.sportsOrg(reviewer);
  const t = await tf.approved(owner, org.id, reviewer);
  const caps = [];
  for (const name of ['Rafi Ahmed', 'Sakib Hasan', 'Nabil Khan']) {
    const c = await tf.captain(name);
    await tf.register(c, t.id);
    caps.push(c);
  }
  const waiting = (await api().get(`${P}/org/${org.id}/sports/tournaments/${t.id}/registrations?status=pending_approval`).set(h.bearer(owner)).expect(200)).body.items;
  for (const r of waiting.slice(0, 2)) await api().post(`${P}/org/${org.id}/sports/registrations/${r.id}/approve`).set(h.bearer(owner)).expect(200);
  const unpaid = await tf.captain('Tamim Iqbal');
  await tf.register(unpaid, t.id, { pay: false });
  await h.drainEvents();
  return { owner, org, t, caps: [...caps, unpaid] };
}

/** Add an existing member to the organisation as staff (or admin). */
async function addOrgMember(owner, orgId, role = 'staff', name = 'Mitu Akter') {
  const m = await h.signupUser({ name });
  await api().post(`${P}/org/${orgId}/members`).set(h.bearer(owner)).send({ phone: m.phone, role }).expect(201);
  return m;
}

module.exports = { SHIP, bootShop, paidOrder, shopPost, liveGym, paidPass, admit, busyOrganiser, addOrgMember };
