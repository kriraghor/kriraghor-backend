'use strict';

/**
 * M24 prompt 3b, the SMS add-on (M24-FR-96 to FR-100, §6.7). Built against the test SMS driver and kept
 * off by gym_saas.sms_addon_enabled until the SMS gateway is signed (G9).
 *  - Units: 1 unit = 1 SMS segment as the gateway counts it. gym_sms_entries is append-only and the
 *    balance is Σ units per owner. Every write to it holds the owner's gym_owner_subscriptions row lock,
 *    so parallel holds never overdraw.
 *  - Switching on (owner, paid plan, FR-96) grants the month's allowance (gym_saas.sms_addon_included,
 *    expiring at the month end); the 1st expires what is left and grants the new month (job). The monthly
 *    invoice bills the add-on when it was active on any day of the month.
 *  - Bundles (FR-98): a one-line invoice paid at once (M06 purpose gym_saas_invoice); the units arrive at
 *    capture, valid gym_saas.sms_bundle_valid_days; an unpaid bundle invoice is voided after
 *    gym_saas.sms_bundle_invoice_days and never chases the owner (no dunning).
 *  - Holds (FR-99): before a member notice is published with SMS, gym_saas.sms_reserve_units are held
 *    (`reserve`) and the event carries sms.billingRef; M08 sends and publishes notification.sms_settled,
 *    and `settle` gives back what was not used. A hold left open for a day is settled as failed (job).
 *  - Low and empty (FR-100): GYM_SMS_BALANCE_LOW and GYM_SMS_DEPLETED once per crossing.
 */
const crypto = require('node:crypto');
const { Op, QueryTypes } = require('sequelize');
const { E } = require('../../common/errors');
const { nextCode } = require('../../common/sequences');
const { sequelize, GymOwnerSubscription, GymOwnerAddon, GymSmsEntry, GymSubscriptionInvoice, GymSubscriptionInvoiceLine } = require('../../models');
const settings = require('../settings').settings;
const payments = require('../payments');
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');

const { fail } = c;

const cfg = () => ({
  enabled: settings.get('gym_saas.sms_addon_enabled'),
  addonPrice: settings.get('gym_saas.sms_addon_price_poisha'),
  included: settings.get('gym_saas.sms_addon_included'),
  bundleSize: settings.get('gym_saas.sms_bundle_size'),
  bundlePrice: settings.get('gym_saas.sms_bundle_price_poisha'),
  bundleValidDays: settings.get('gym_saas.sms_bundle_valid_days'),
  bundleInvoiceDays: settings.get('gym_saas.sms_bundle_invoice_days'),
  reserve: settings.get('gym_saas.sms_reserve_units'),
  low: settings.get('gym_saas.sms_low_balance'),
});
const SNAPSHOT_KEYS = ['gym_saas.sms_bundle_size', 'gym_saas.sms_bundle_price_poisha', 'gym_saas.sms_bundle_valid_days', 'gym_saas.vat_enabled', 'gym_saas.vat_pct'];

/** A deterministic reference (UUID form, from SHA-1 like v5) so a job run twice writes nothing new. */
function refOf(...parts) {
  const h = crypto.createHash('sha1').update(`kriraghor-gym-sms:${parts.join(':')}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

// ---------------------------------------------------------------- reads

async function balanceOf(ownerId, { transaction } = {}) {
  const [row] = await sequelize.query('SELECT COALESCE(SUM(units), 0)::int AS balance FROM gym_sms_entries WHERE owner_id = :ownerId', { replacements: { ownerId }, type: QueryTypes.SELECT, transaction });
  return row.balance;
}

const liveAddon = (ownerId, { transaction, lock = false } = {}) =>
  GymOwnerAddon.findOne({ where: { ownerId, addon: 'sms', status: ['active', 'paused'] }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });

const lockSubscription = (ownerId, transaction) => GymOwnerSubscription.findOne({ where: { ownerId }, transaction, lock: transaction.LOCK.UPDATE });

/** Units used in a month (holds less what came back), for the allowance spent first. */
async function usedIn(ownerId, { start, end }, transaction) {
  const [row] = await sequelize.query(
    "SELECT COALESCE(-SUM(units), 0)::int AS used FROM gym_sms_entries WHERE owner_id = :ownerId AND kind IN ('reserve', 'settle') AND created_at >= :from AND created_at < :to",
    { replacements: { ownerId, from: rules.instantOf(start), to: rules.instantOf(rules.addDays(end, 1)) }, type: QueryTypes.SELECT, transaction }
  );
  return row.used;
}

/** The month's allowance left: granted that month less what was used, never more than the balance. */
async function allowanceLeft(ownerId, period, transaction) {
  const grant = await GymSmsEntry.findOne({ where: { ownerId, kind: 'grant', billingRef: refOf(ownerId, period.month, 'grant') }, transaction });
  if (!grant) return 0;
  return rules.smsAllowanceLeft({ granted: grant.units, used: await usedIn(ownerId, period, transaction) });
}

/** The billing page's SMS card (and the admin owner detail): what the owner can do and has. */
async function view(ownerId, sub = null) {
  const s = cfg();
  const tier = sub?.chosenTier ?? (await GymOwnerSubscription.findOne({ where: { ownerId } }))?.chosenTier ?? 'free';
  const addon = await liveAddon(ownerId);
  const period = rules.previousMonth(rules.addMonths(rules.firstOfMonth(c.today()), 1));
  const bundles = await GymSmsEntry.findAll({ where: { ownerId, kind: 'purchase', expiresOn: { [Op.gte]: c.today() } }, order: [['expiresOn', 'ASC']] });
  return {
    available: Boolean(s.enabled) && tier !== 'free',
    enabled: Boolean(s.enabled),
    status: addon?.status ?? null,
    startedAt: c.iso(addon?.startedAt),
    balance: await balanceOf(ownerId),
    allowanceLeft: addon ? await allowanceLeft(ownerId, period, null) : 0,
    pricePoisha: s.addonPrice,
    included: s.included,
    bundle: { size: s.bundleSize, pricePoisha: s.bundlePrice, validDays: s.bundleValidDays },
    reserveUnits: s.reserve,
    lowBalance: s.low,
    bundles: bundles.map((b) => ({ units: b.units, expiresOn: b.expiresOn })),
  };
}

/** GET /manage/billing/sms-entries (owner): the latest entries, newest first. */
async function entries(principal, { limit = 50 } = {}) {
  const rows = await GymSmsEntry.findAll({ where: { ownerId: principal.id }, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit });
  return { balance: await balanceOf(principal.id), items: rows.map(entryView) };
}
const entryView = (e) => ({ id: e.id, kind: e.kind, units: e.units, expiresOn: e.expiresOn ?? null, gymId: e.gymId ?? null, invoiceId: e.invoiceId ?? null, note: e.kind === 'adjust' ? e.note ?? null : null, createdAt: c.iso(e.createdAt) });

// ---------------------------------------------------------------- writes (all under the subscription lock)

async function write(transaction, entry) {
  return GymSmsEntry.create(entry, { transaction });
}

/**
 * After a debit: the crossing it made (FR-100), as an event the owner hears once per crossing. Returns
 * the balance after.
 */
async function afterDebit(transaction, { ownerId, before }) {
  const s = cfg();
  const after = await balanceOf(ownerId, { transaction });
  const crossing = rules.smsCrossing({ before, after, low: s.low, reserve: s.reserve });
  if (crossing === 'depleted') await c.publish(transaction, 'gym_sms.depleted', 'gym_owner', ownerId, { ownerId, balance: after });
  if (crossing === 'low') await c.publish(transaction, 'gym_sms.low_reached', 'gym_owner', ownerId, { ownerId, balance: after });
  return after;
}

/** The month's allowance (idempotent per owner and month). */
async function grantIn(transaction, { ownerId, period, by = null }) {
  const units = cfg().included;
  if (units <= 0) return 0;
  const billingRef = refOf(ownerId, period.month, 'grant');
  if (await GymSmsEntry.findOne({ where: { billingRef, kind: 'grant' }, transaction, attributes: ['id'] })) return 0;
  await write(transaction, { ownerId, kind: 'grant', units, expiresOn: period.end, billingRef, createdBy: by });
  return units;
}

/** PUT /manage/billing/sms-addon { enabled } (owner, paid plan, FR-96). */
async function setAddon(principal, { enabled }, req) {
  await sequelize.transaction(async (transaction) => {
    const sub = await lockSubscription(principal.id, transaction);
    if (!sub) throw E.notFound('Subscription');
    const addon = await liveAddon(principal.id, { transaction, lock: true });
    const now = new Date();
    if (!enabled) {
      if (!addon) return;
      await addon.update({ status: 'ended', endedAt: now }, { transaction });
      await c.record({ action: 'gym_sms_addon.ended', actor: principal, entityType: 'gym_owner_addon', entityId: addon.id, before: { status: addon.status }, after: { status: 'ended' }, req }, transaction);
      return;
    }
    const s = cfg();
    if (!s.enabled || sub.chosenTier === 'free' || sub.status === 'closed') throw fail('GYM_SMS_ADDON_UNAVAILABLE', { tier: sub.chosenTier, enabled: Boolean(s.enabled) });
    if (addon?.status === 'active') return;
    const row = addon
      ? await addon.update({ status: 'active', pausedAt: null }, { transaction })
      : await GymOwnerAddon.create({ subscriptionId: sub.id, ownerId: principal.id, addon: 'sms', status: 'active', pricePoisha: s.addonPrice, startedAt: now }, { transaction });
    const today = c.today(now);
    const granted = await grantIn(transaction, { ownerId: principal.id, period: { month: rules.monthOf(today), end: rules.lastOfMonth(today) }, by: principal.id });
    await c.record({ action: 'gym_sms_addon.started', actor: principal, entityType: 'gym_owner_addon', entityId: row.id, after: { status: 'active', pricePoisha: row.pricePoisha, granted }, req }, transaction);
  });
  return view(principal.id);
}

/**
 * POST /manage/billing/sms-bundles { bundles } [Idempotency-Key] (owner, add-on active, FR-98): a bundle
 * invoice paid at once → { invoice, payment: { id, payUrl } }. The units arrive when M06 captures it.
 */
async function buyBundles(principal, { bundles }, idempotencyKey) {
  return sequelize.transaction(async (transaction) => {
    const sub = await lockSubscription(principal.id, transaction);
    if (!sub) throw E.notFound('Subscription');
    const s = cfg();
    if (!s.enabled || sub.chosenTier === 'free' || s.bundleSize <= 0 || s.bundlePrice <= 0) throw fail('GYM_SMS_ADDON_UNAVAILABLE', { tier: sub.chosenTier, enabled: Boolean(s.enabled) });
    const addon = await liveAddon(principal.id, { transaction });
    if (addon?.status !== 'active') throw fail('GYM_SMS_ADDON_OFF');
    const saas = c.saasCfg();
    const calc = rules.bundleInvoiceLines({ bundles, size: s.bundleSize, price: s.bundlePrice, vat: { enabled: saas.vatEnabled, pct: saas.vatPct } });
    const now = new Date();
    const inv = await GymSubscriptionInvoice.create(
      {
        number: await nextCode('GI', transaction, now),
        ownerId: principal.id,
        subscriptionId: sub.id,
        kind: 'sms_bundle',
        subtotalPoisha: calc.subtotal,
        vatPoisha: calc.vat,
        totalPoisha: calc.total,
        status: 'issued',
        issuedAt: now,
        dueAt: new Date(now.getTime() + s.bundleInvoiceDays * 86400000),
        settingsSnapshot: { ...settings.snapshot(SNAPSHOT_KEYS), bundles, units: calc.units },
      },
      { transaction }
    );
    await GymSubscriptionInvoiceLine.bulkCreate(calc.lines.map((l) => ({ ...l, invoiceId: inv.id })), { transaction });
    const invoices = require('./invoices.service');
    const p = await payments.intents.createIntent(
      { purpose: invoices.PURPOSE, purposeId: inv.id, payerId: principal.id, amount: inv.totalPoisha, title: `Kriraghor SMS bundle ${inv.number}`, groupRef: inv.id, idempotencyKey: `gym_sms_bundle:${inv.id}:${idempotencyKey}` },
      { transaction }
    );
    return { invoice: invoices.invoiceView(inv), units: calc.units, payment: { id: p.id, payUrl: payments.intents.payUrl(p.id, invoices.PURPOSE) } };
  });
}

/** Inside the M06 capture of a bundle invoice (invoices.onCaptured): the units, valid for the bundle days. */
async function onBundlePaid(transaction, inv) {
  await lockSubscription(inv.ownerId, transaction);
  const snap = inv.settingsSnapshot ?? {};
  const billingRef = refOf(inv.id, 'purchase');
  if (await GymSmsEntry.findOne({ where: { billingRef, kind: 'purchase' }, transaction, attributes: ['id'] })) return;
  const units = Number(snap.units) || 0;
  if (units <= 0) return;
  const days = Number(snap['gym_saas.sms_bundle_valid_days']?.value) || cfg().bundleValidDays;
  await write(transaction, { ownerId: inv.ownerId, kind: 'purchase', units, expiresOn: rules.addDays(c.today(), days), billingRef, invoiceId: inv.id });
  await c.publish(transaction, 'gym_sms.purchased', 'gym_owner', inv.ownerId, { ownerId: inv.ownerId, invoiceId: inv.id, units });
}

/**
 * Before a member notice: can it go by SMS? Locks the owner's subscription row (held until the caller's
 * transaction ends) and answers { ok, reason, balance } without writing (§6.7).
 */
async function planIn(transaction, { ownerId, gymId, kind, explicit = false }) {
  const s = cfg();
  // Switched off on the platform (until the gateway, G9): no lock, nothing read.
  if (!s.enabled) return { ok: false, reason: 'off' };
  const sub = await lockSubscription(ownerId, transaction);
  const addon = await liveAddon(ownerId, { transaction });
  const gymSettings = await c.settingsOf(gymId, { transaction });
  const balance = addon ? await balanceOf(ownerId, { transaction }) : 0;
  const reason = rules.smsBlock({ enabled: s.enabled, tier: sub?.chosenTier ?? 'free', addonStatus: sub?.status === 'restricted' ? 'paused' : addon?.status, kind, kinds: gymSettings?.smsKinds ?? [], explicit, balance, reserve: s.reserve });
  return { ok: !reason, reason, balance };
}

/** Hold the units for one message (after planIn said ok, in the same transaction) → the billingRef. */
async function reserveIn(transaction, { ownerId, gymId, reminderId = null, balance }) {
  const units = cfg().reserve;
  const billingRef = crypto.randomUUID();
  await write(transaction, { ownerId, kind: 'reserve', units: -units, billingRef, gymId, reminderId });
  await afterDebit(transaction, { ownerId, before: balance });
  return billingRef;
}

/**
 * Consumer of notification.sms_settled (M08): give back what the message did not use. Once per hold
 * (uq billing_ref, kind); an unknown or settled ref does nothing.
 */
async function settle({ billingRef, segments = 0, status }, { transaction }) {
  const hold = await GymSmsEntry.findOne({ where: { billingRef, kind: 'reserve' }, transaction });
  if (!hold) return null;
  await lockSubscription(hold.ownerId, transaction);
  if (await GymSmsEntry.findOne({ where: { billingRef, kind: 'settle' }, transaction, attributes: ['id'] })) return null;
  const before = await balanceOf(hold.ownerId, { transaction });
  const units = rules.smsSettleUnits({ reserve: -hold.units, segments, sent: status === 'sent', balanceAfterReserve: before });
  await write(transaction, { ownerId: hold.ownerId, kind: 'settle', units, billingRef, gymId: hold.gymId, reminderId: hold.reminderId, note: status });
  if (units < 0) await afterDebit(transaction, { ownerId: hold.ownerId, before });
  return units;
}

/** POST /admin/gym-manage/owners/:ownerId/sms-adjust { units, note } (master, step-up): never below 0. */
async function adjust(actor, ownerId, { units, note }, req) {
  return sequelize.transaction(async (transaction) => {
    const sub = await lockSubscription(ownerId, transaction);
    if (!sub) throw E.notFound('Owner');
    const before = await balanceOf(ownerId, { transaction });
    if (before + units < 0) throw fail('GYM_SMS_BALANCE_SHORT', { balance: before });
    const row = await write(transaction, { ownerId, kind: 'adjust', units, note, createdBy: actor.id });
    if (units < 0) await afterDebit(transaction, { ownerId, before });
    await c.record({ action: 'gym_sms.adjusted', actor, entityType: 'gym_sms_entry', entityId: row.id, before: { balance: before }, after: { balance: before + units }, reason: note, meta: { ownerId, units }, req }, transaction);
    return { balance: before + units, entry: entryView(row) };
  });
}

// ---------------------------------------------------------------- jobs

/** gym-manage.sms-allowance (the 1st, 00:10): last month's allowance left expires; this month's is granted. */
async function allowance(now = new Date()) {
  const today = c.today(now);
  const last = rules.previousMonth(today);
  const out = { expired: 0, granted: 0 };
  const owners = await GymOwnerAddon.findAll({ where: { addon: 'sms', status: ['active', 'paused'] }, attributes: ['ownerId', 'status'] });
  // Owners whose add-on ended still lose last month's allowance.
  const ended = await GymSmsEntry.findAll({ where: { kind: 'grant', billingRef: { [Op.ne]: null }, expiresOn: last.end }, attributes: ['ownerId'] });
  const ids = [...new Set([...owners.map((o) => o.ownerId), ...ended.map((e) => e.ownerId)])];
  for (const ownerId of ids) {
    await sequelize.transaction(async (transaction) => {
      await lockSubscription(ownerId, transaction);
      const ref = refOf(ownerId, last.month, 'expire');
      if (!(await GymSmsEntry.findOne({ where: { billingRef: ref, kind: 'expire' }, transaction, attributes: ['id'] }))) {
        const left = Math.min(await allowanceLeft(ownerId, last, transaction), await balanceOf(ownerId, { transaction }));
        if (left > 0) {
          await write(transaction, { ownerId, kind: 'expire', units: -left, billingRef: ref, note: `allowance ${last.month}` });
          out.expired += left;
        }
      }
      const live = owners.find((o) => o.ownerId === ownerId && o.status === 'active');
      if (live) out.granted += await grantIn(transaction, { ownerId, period: { month: rules.monthOf(today), end: rules.lastOfMonth(today) } });
    });
  }
  return out;
}

/**
 * gym-manage.sms-daily (00:20): bundles past their date expire (what is left of them, §6.7); holds open
 * for a day are settled as failed; unpaid bundle invoices past their days are voided (never dunned).
 */
async function daily(now = new Date()) {
  const today = c.today(now);
  const out = { bundlesExpired: 0, holdsClosed: 0, invoicesVoided: 0 };
  const due = await GymSmsEntry.findAll({ where: { kind: 'purchase', expiresOn: { [Op.lt]: today } }, order: [['expiresOn', 'ASC'], ['createdAt', 'ASC']] });
  for (const b of due) {
    await sequelize.transaction(async (transaction) => {
      await lockSubscription(b.ownerId, transaction);
      const ref = refOf(b.id, 'expire');
      if (await GymSmsEntry.findOne({ where: { billingRef: ref, kind: 'expire' }, transaction, attributes: ['id'] })) return;
      const balance = await balanceOf(b.ownerId, { transaction });
      const month = rules.previousMonth(rules.addMonths(rules.firstOfMonth(today), 1));
      const pool = balance - (await allowanceLeft(b.ownerId, month, transaction));
      const [{ newer }] = await sequelize.query(
        "SELECT COALESCE(SUM(units), 0)::int AS newer FROM gym_sms_entries WHERE owner_id = :ownerId AND kind = 'purchase' AND expires_on >= :today AND id <> :id",
        { replacements: { ownerId: b.ownerId, today, id: b.id }, type: QueryTypes.SELECT, transaction }
      );
      const left = rules.smsBundleLeft({ units: b.units, pool, newer });
      // Nothing left of it: no entry (the check forbids 0 units).
      if (left > 0) {
        await write(transaction, { ownerId: b.ownerId, kind: 'expire', units: -left, billingRef: ref, invoiceId: b.invoiceId, note: 'bundle' });
        out.bundlesExpired += left;
      }
    });
  }
  const stale = await sequelize.query(
    "SELECT r.billing_ref AS ref FROM gym_sms_entries r WHERE r.kind = 'reserve' AND r.created_at < :before AND NOT EXISTS (SELECT 1 FROM gym_sms_entries s WHERE s.billing_ref = r.billing_ref AND s.kind = 'settle') LIMIT 500",
    { replacements: { before: new Date(now.getTime() - 86400000) }, type: QueryTypes.SELECT }
  );
  for (const { ref } of stale) {
    const r = await sequelize.transaction((transaction) => settle({ billingRef: ref, status: 'failed' }, { transaction }));
    if (r !== null) out.holdsClosed += 1;
  }
  const unpaid = await GymSubscriptionInvoice.findAll({ where: { kind: 'sms_bundle', status: 'issued', dueAt: { [Op.lte]: now } }, attributes: ['id'] });
  for (const { id } of unpaid) {
    await sequelize.transaction(async (transaction) => {
      const inv = await GymSubscriptionInvoice.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (inv.status !== 'issued') return;
      await inv.update({ status: 'void', voidedAt: now, voidReason: 'Not paid in time' }, { transaction });
      await c.publish(transaction, 'gym_invoice.voided', 'gym_subscription_invoice', inv.id, require('./invoices.service').invoicePayload(inv));
      out.invoicesVoided += 1;
    });
  }
  return out;
}

/** Invariant (§7.2): no owner's SMS balance is below 0. */
async function negativeBalances() {
  return sequelize.query('SELECT owner_id AS "ownerId" FROM gym_sms_entries GROUP BY owner_id HAVING SUM(units) < 0 LIMIT 20', { type: QueryTypes.SELECT });
}

module.exports = { cfg, refOf, balanceOf, liveAddon, view, entries, setAddon, buyBundles, onBundlePaid, planIn, reserveIn, settle, adjust, allowance, daily, negativeBalances };
