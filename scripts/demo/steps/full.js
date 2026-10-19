'use strict';

/**
 * The full local profile (never production): paid entries and bookings through the payment
 * simulator, finished esports events with results and prizes, so standings, leaderboards, top
 * players, winnings, bookings, orders, passes, hire jobs and reviews all have data.
 *
 * Past activity is made the way the tests make it: things are created in the near future, played
 * through, then their stored times are moved back. Only time columns of demo rows are touched.
 */
const rt = require('../runtime');
const people = require('./people');
const L = require('./listings');
const D = require('../data');

const { models } = rt;
const day = 86400000;
const ago = (ms) => new Date(Date.now() - ms);
const soon = (ms) => new Date(Date.now() + ms);

// ---------------------------------------------------------------- payments

/** Pay as the payer through the in-process SSLCommerz simulator (what payWithSimulator does in tests). */
async function pay(a, paymentId, method = 'bkash') {
  const simulator = require('../../../src/providers/payments/sslcommerz.simulator');
  const attempt = await rt.post(a, `/payments/${paymentId}/attempts`, { method }, { idem: true });
  await simulator.pay(attempt.redirectUrl.split('/').pop(), 'success');
  await rt.drain();
}

// ---------------------------------------------------------------- finished esports events

const lifecycle = () => require('../../../src/modules/esports/esports.lifecycle');

async function playThrough(master, reviewer, f, roster, index) {
  const label = `finished:${f.titleEn}`;
  const e = { key: label, game: f.game, mode: 'solo', titleEn: f.titleEn, titleBn: f.titleBn, tier: f.tier, fee: 5000, slots: 48, min: 8, prizes: f.tier === 'weekly' ? [600000, 300000, 150000] : [300000, 150000, 80000], killReward: 2000, startsInDays: 1, opensInMin: 1 };
  const id = await L.esportsTournament(master, reviewer, e, { free: false });
  let t = await models.EsportsTournament.findByPk(id);
  if (['finalised', 'paid_out'].includes(t.status)) return id;

  // Registration: open it, every player enters and pays, then close it.
  if (t.status === 'scheduled') {
    await models.EsportsTournament.update({ registrationOpensAt: ago(2 * 3600000) }, { where: { id } });
    await lifecycle().tick();
  }
  const regs = new Map();
  for (const p of roster) {
    let reg = await models.EsportsRegistration.findOne({ where: { tournamentId: id, registrantUserId: p.userId } });
    if (!reg) {
      const r = await rt.post(p, `/esports/tournaments/${id}/registrations`, { players: [p.profileId] }, { idem: true });
      if (r.payment) await pay(p, r.payment.id);
      reg = await models.EsportsRegistration.findByPk(r.registration.id);
    }
    regs.set(p.userId, reg.id);
  }
  t = await t.reload();
  if (['registration_open', 'scheduled'].includes(t.status)) {
    await models.EsportsTournament.update({ registrationClosesAt: ago(3600000) }, { where: { id } });
    await lifecycle().tick();
    await rt.drain();
  }
  // Check-in, then the match starts.
  await models.EsportsStage.update({ checkinOpensAt: ago(600000), checkinClosesAt: soon(600000) }, { where: { tournamentId: id } });
  await lifecycle().tick();
  for (const p of roster) await rt.post(p, `/me/esports/registrations/${regs.get(p.userId)}/check-in`, undefined, { ok: [409] });
  const matches = await models.EsportsMatch.findAll({ where: { tournamentId: id }, order: [['seq', 'ASC']] });
  for (const [i, m] of matches.entries()) await m.update({ startsAt: ago(60000 * (matches.length - i)) });
  await models.EsportsTournament.update({ startsAt: ago(60000 * matches.length) }, { where: { id } });
  await lifecycle().tick();

  // Results: a different finishing order each time, with kills; posted, then the dispute window closes.
  const order = roster.map((p, i) => ({ p, score: (i * 7 + index * 5) % roster.length }));
  order.sort((x, y) => x.score - y.score);
  for (const m of matches) {
    const rows = order.map(({ p }, place) => ({ registrationId: regs.get(p.userId), placement: place + 1, kills: [{ userId: p.userId, kills: Math.max(0, 9 - place - ((index + place) % 3)) }] }));
    await rt.put(master, `/admin/esports/matches/${m.id}/results`, { rows });
    await rt.post(master, `/admin/esports/matches/${m.id}/results/post`);
  }
  await models.EsportsMatch.update({ disputeClosesAt: ago(1000) }, { where: { tournamentId: id } });
  await lifecycle().tick();
  await rt.drain();
  await rt.post(master, `/admin/esports/tournaments/${id}/finalise`, undefined, { headers: { 'X-Step-Up': await rt.stepUp(master, 'esports.money') } });
  await rt.drain();
  return id;
}

/** Move a finished event `daysAgo` days back (its schedule, matches and finalisation). */
async function backdate(id, daysAgo) {
  const t = await models.EsportsTournament.findByPk(id);
  const shift = daysAgo * day;
  const back = (d) => (d ? new Date(new Date(d).getTime() - shift) : d);
  if (t.finalisedAt && Date.now() - new Date(t.finalisedAt).getTime() > shift / 2) return; // already moved
  await t.update({ registrationOpensAt: back(t.registrationOpensAt), registrationClosesAt: back(t.registrationClosesAt), startsAt: back(t.startsAt), finalisedAt: back(t.finalisedAt), paidOutAt: back(t.paidOutAt) });
  for (const m of await models.EsportsMatch.findAll({ where: { tournamentId: id } })) await m.update({ startsAt: back(m.startsAt), disputeClosesAt: back(m.disputeClosesAt) });
  for (const s of await models.EsportsStage.findAll({ where: { tournamentId: id } })) await s.update({ checkinOpensAt: back(s.checkinOpensAt), checkinClosesAt: back(s.checkinClosesAt) });
}

async function finishedEsports(master, reviewer, players) {
  const done = [];
  for (const [i, f] of D.FINISHED.entries()) {
    const roster = players.filter((p) => p.game === f.game);
    const id = await playThrough(master, reviewer, f, roster, i);
    done.push({ id, f });
  }
  for (const { id, f } of done) await backdate(id, f.daysAgo);
  const rankings = require('../../../src/modules/esports/rankings.service');
  for (const key of ['free_fire', 'pubg_mobile']) await rankings.recompute((await L.byKey('EsportsGame', key)).id);
  return done.length;
}

// ---------------------------------------------------------------- bookings and reviews (M10, M17)

const HALF = 30 * 60000;
/** HH:00 Dhaka (UTC+6) `days` days from today. */
function dhakaAt(days, hour) {
  const d = new Date(Date.now() + days * day + 6 * 3600000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour - 6, 0));
}
/** Move a booking and its active slots to start at `start` (as tests/fixtures/bookings.js moveTo). */
async function moveBooking(b, start) {
  const s = new Date(Math.floor(new Date(start).getTime() / HALF) * HALF);
  const e = new Date(s.getTime() + (new Date(b.endAt) - new Date(b.startAt)));
  await models.sequelize.query('UPDATE bookings SET start_at = :s, end_at = :e WHERE id = :id', { replacements: { s, e, id: b.id } });
  await models.sequelize.query("UPDATE booking_slots SET period = tstzrange(:s, :e, '[)') WHERE booking_id = :id AND status = 'active'", { replacements: { s, e, id: b.id } });
  return b.reload();
}

/** Hold and pay a booking (advance or full) tomorrow at `hour` Dhaka on the venue's first court. */
async function book(a, ground, { daysAhead = 1, hour, minutes = 60, payment = 'advance', court = 0 }) {
  const courts = await models.Court.findAll({ where: { groundId: ground.id }, order: [['sort', 'ASC']] });
  const r = await rt.post(a, '/bookings/holds', { groundId: ground.id, courtIds: [courts[court % courts.length].id], start: dhakaAt(daysAhead, hour).toISOString(), minutes, payment }, { idem: `demo-book-${a.userId.slice(0, 8)}-${ground.id.slice(0, 8)}-${daysAhead}-${hour}` });
  if (r.payment) await pay(a, r.payment.id);
  return models.Booking.findByPk(r.booking.id);
}

const REVIEWS = [
  [5, 'Great turf and the lights are bright even late at night. Staff were friendly.'],
  [4, 'Good surface and easy to book. Parking was a bit tight on a Friday.'],
  [5, 'Clean changing room and the court was ready on time. Will book again.'],
  [4, 'Nice place, fair price for peak hours.'],
  [5, 'Best court in the area. Smooth check-in with the QR code.'],
];

/** Three past, checked-in and reviewed bookings per venue (ratings show from three reviews), from different players. */
async function pastBookings(players, owners, venues) {
  let k = 0;
  for (const [v, ground] of venues.entries()) {
    const owner = owners[ground.owner];
    for (let j = 0; j < 3; j += 1) {
      const booker = players[(v * 3 + j) % players.length];
      if (await models.Booking.findOne({ where: { bookerUserId: booker.userId, groundId: ground.id } })) continue;
      const hour = ground.hours?.[0]?.openTime === '07:00' ? 9 + j * 2 : 8 + j * 2;
      let b = await book(booker, ground, { daysAhead: 1, hour, payment: j === 2 ? 'full' : 'advance' });
      b = await moveBooking(b, new Date(Date.now() - 10 * 60000)); // playing now: the owner checks them in
      await rt.post(owner, `/me/ground-bookings/${b.id}/check-in`);
      await moveBooking(b, dhakaAt(-(3 + v + j * 4), hour)); // then it becomes a past game
      const [stars, text] = REVIEWS[(k += 1) % REVIEWS.length];
      await rt.post(booker, '/reviews', { bookingId: b.id, stars, text }, { ok: [409, 422] });
    }
  }
  await require('../../../src/modules/bookings/bookings.service').tick();
  await rt.drain();
}

// ---------------------------------------------------------------- orders (M13)

const variantOf = async (shopName, title, attr) => {
  const shop = await models.Shop.findOne({ where: { name: shopName } });
  const product = await models.Product.findOne({ where: { shopId: shop.id, title } });
  const variants = await models.ProductVariant.findAll({ where: { productId: product.id } });
  return (attr ? variants.find((v) => Object.values(v.attributes ?? {}).includes(attr)) : null) ?? variants[0];
};

/** A paid order; `stage` takes each shop's part to accepted, shipped, delivered or received. */
async function order(buyer, lines, owners, stage, tag) {
  if (await models.Order.findOne({ where: { buyerId: buyer.userId } })) return;
  for (const [shop, title, attr, qty] of lines) await rt.put(buyer, `/me/cart/items/${(await variantOf(shop, title, attr)).id}`, { qty });
  const area = await L.byKey('Area', 'dhanmondi');
  const ship = { name: buyer.name, phone: `0${people.phoneOf(buyer.n).slice(4)}`, areaId: area.id, line: 'House 12, Road 5, Dhanmondi' };
  const quote = await rt.post(buyer, '/checkout/quote', { areaId: area.id });
  const placed = await rt.post(buyer, '/checkout', { ship, expectedTotal: quote.total }, { idem: `demo-order-${tag}` });
  await pay(buyer, placed.payment.id);
  const subs = await models.SubOrder.findAll({ where: { orderId: placed.order.id }, order: [['code', 'ASC']] });
  for (const s of subs) {
    const shop = await models.Shop.findByPk(s.shopId);
    const o = Object.values(owners).find((a) => a.userId === shop.ownerId);
    if (stage === 'paid') continue;
    await rt.post(o, `/shop/sub-orders/${s.id}/accept`, {});
    if (stage === 'accepted') continue;
    await rt.post(o, `/shop/sub-orders/${s.id}/ship`, { courierName: 'Pathao', trackingNo: `PTH-${s.code.replace(/[^A-Za-z0-9]/g, '').slice(-8)}` });
    if (stage === 'shipped') continue;
    await rt.post(o, `/shop/sub-orders/${s.id}/delivered`, {});
    if (stage === 'delivered') continue;
    await rt.post(buyer, `/me/sub-orders/${s.id}/received`, {});
  }
  await rt.drain();
}

// ---------------------------------------------------------------- the demo member and more activity

const paymentIdOf = (r) => r?.payment?.id ?? r?.paymentId ?? r?.pass?.paymentId ?? r?.subscription?.paymentId ?? r?.request?.paymentId ?? null;
const todayDhaka = () => new Date(Date.now() + 6 * 3600000).toISOString().slice(0, 10);

async function memberActivity(reviewer, owners, players, venues, pros) {
  const m = await people.member(D.MEMBER.n, D.MEMBER.name, { username: D.MEMBER.username });
  await people.verifyNid(m, reviewer);

  // An upcoming venue booking (advance paid online).
  const rooftop = venues.find((v) => v.name === 'Dhanmondi Rooftop Turf');
  if (!(await models.Booking.findOne({ where: { bookerUserId: m.userId } }))) await book(m, rooftop, { daysAhead: 2, hour: 19, payment: 'advance' });

  // Orders: the member's two-shop order received; other buyers' orders at each stage for the shop desks.
  await order(m, [['Elephant Road Sports Corner', 'Turf Pro TF Football Boots', '42', 1], ['Muscle Fuel BD', 'Gold Whey Protein, 5 lb', 'chocolate', 1]], owners, 'received', 'member');
  await order(players[0], [['Mirpur Cricket Bazar', 'English Willow Bat, Grade 2', 'sh', 1]], owners, 'shipped', 'p0');
  await order(players[1], [['Iron Supply Tejgaon', 'Rubber Hex Dumbbells (Pair)', '10', 1]], owners, 'accepted', 'p1');
  await order(players[2], [['Elephant Road Sports Corner', 'Club Jersey, Red and Black Stripes', 'M', 2]], owners, 'paid', 'p2');

  // A monthly gym pass and a trainer subscription.
  if (!(await models.GymPass.findOne({ where: { holderId: m.userId } }))) {
    const gym = await models.Gym.findOne({ where: { name: 'Iron Yard Banani' } });
    const pkg = await models.GymPackage.findOne({ where: { gymId: gym.id, kind: 'month' } });
    const r = await rt.post(m, '/gym/passes', { packageId: pkg.id, validFrom: todayDhaka() }, { idem: 'demo-pass-member' });
    if (paymentIdOf(r)) await pay(m, paymentIdOf(r));
  }
  const sabbir = pros.find((p) => p.trainer && p.name === 'Sabbir Hossain');
  const plan = await models.TrainerPlan.findOne({ where: { profileId: sabbir.profileId } });
  if (plan && !(await models.TrainerSubscription.findOne({ where: { memberId: m.userId } }))) {
    const r = await rt.post(m, '/gym/subscriptions', { planId: plan.id, startDate: todayDhaka() }, { idem: 'demo-sub-member', ok: [409, 422] });
    if (paymentIdOf(r)) await pay(m, paymentIdOf(r));
  }

  // A hire job: the member books the umpire for a T20 in four days; accepted and paid.
  const umpire = pros.find((p) => p.roleKey === 'cricket_umpire');
  if (!(await models.HireRequest.findOne({ where: { profileId: umpire.profileId } }))) {
    const at = dhakaAt(4, 19);
    at.setUTCMinutes(30);
    const r = await rt.post(m, '/hire/requests', { profileId: umpire.profileId, unit: 'match', engagements: [{ start: at.toISOString(), format: 'T20', venueText: 'Pallabi Cricket Ground', venueAreaId: (await L.byKey('Area', 'pallabi')).id }], note: 'Corporate league match, white ball' }, { idem: 'demo-hire-member' });
    await rt.post(umpire.actor, `/pro/requests/${r.request.id}/accept`, {});
    const req = await models.HireRequest.findByPk(r.request.id);
    if (req.paymentId) await pay(m, req.paymentId);
  }
  await rt.drain();
  return m;
}

/** Players enter the open daily events, so the cards show slots taken. */
async function openEntries(players) {
  for (const key of ['ff-daily', 'pm-daily']) {
    const id = await rt.marked('esports_tournament', `esports:${key}`);
    const t = id && (await models.EsportsTournament.findByPk(id));
    if (!t || t.status !== 'registration_open') continue;
    const game = await models.EsportsGame.findByPk(t.gameId);
    for (const p of players.filter((x) => x.game === game.key).slice(0, 8)) {
      if (await models.EsportsRegistration.findOne({ where: { tournamentId: id, registrantUserId: p.userId } })) continue;
      const r = await rt.post(p, `/esports/tournaments/${id}/registrations`, { players: [p.profileId] }, { idem: `demo-open-${key}-${p.n}` });
      if (r.payment) await pay(p, r.payment.id);
    }
  }
}

/** Four NID-verified captains enter their badminton teams in the Gulshan Badminton Open (free entry). */
async function sportsEntries(reviewer, players) {
  const id = await rt.marked('sports_tournament', 'sports:badminton-open');
  if (!id) return;
  for (const p of players.slice(12, 16)) {
    await people.verifyNid(p, reviewer);
    let team = await models.Team.findOne({ where: { createdBy: p.userId } });
    if (!team) {
      const t = await rt.post(p, '/teams', { sportKey: 'badminton', name: `${p.name.split(' ')[0]} Smashers` });
      team = await models.Team.findByPk(t.id);
      await rt.mark('team', team.id, `team:${p.n}`);
    }
    if (!(await models.Registration.findOne({ where: { tournamentId: id, teamId: team.id } }))) {
      await rt.post(p, `/tournaments/${id}/registrations`, { teamId: team.id, rosterUserIds: [p.userId], acceptRules: true }, { idem: `demo-sports-${p.n}` });
    }
  }
  await rt.drain();
  // The organiser approves the entries.
  const organiser = await people.member(11, D.OWNERS.find((x) => x.n === 11).name);
  const orgId = await rt.marked('organisation', 'sports-org');
  for (const r of await models.Registration.findAll({ where: { tournamentId: id, status: 'pending_approval' } })) {
    await rt.post(organiser, `/org/${orgId}/sports/registrations/${r.id}/approve`, {});
  }
  await rt.drain();
}

async function run({ master, reviewer, owner, step }) {
  const players = await step('players (again, for their sessions)', () => L.players(reviewer));
  await step('finished esports events: entries, results, prizes, rankings', () => finishedEsports(master, reviewer, players));
  const venues = await step('venues (again, for their ids)', () => L.venues(owner, reviewer));
  await step('past bookings, check-ins and reviews', () => pastBookings(players, owner, venues));
  const gymRows = await step('gyms (again, for their ids)', () => L.gyms(owner, reviewer));
  const pros = await step('hire profiles (again, for their ids)', () => L.pros(reviewer, gymRows));
  await step('demo member: booking, orders, gym pass, trainer plan, hire job', () => memberActivity(reviewer, owner, players, venues, pros));
  await step('entries in the open esports events', () => openEntries(players));
  await step('teams entered in the badminton open', () => sportsEntries(reviewer, players));
}

module.exports = { run, pay, backdate };
