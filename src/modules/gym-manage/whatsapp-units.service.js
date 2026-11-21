'use strict';

/**
 * M24 §25 the owner's WhatsApp units (M24-FR-166, FR-167; product owner, 21 Nov 2026: Kriraghor pays Meta and
 * resells units, like the SMS bundles). The same shape as the SMS add-on (sms.service), without a monthly fee:
 *  - Units: gym_whatsapp_entries is append-only and the balance is Σ units per owner. Every write holds the
 *    owner's gym_owner_subscriptions row lock, so parallel holds never overdraw.
 *  - Switching WhatsApp on (owner, a plan with the whatsapp feature, gym_whatsapp.api_enabled) grants the
 *    month's allowance (gym_whatsapp.included, expiring at the month end); the 1st expires what is left and
 *    grants the new month (job).
 *  - Bundles: a one-line invoice paid at once (M06 purpose gym_saas_invoice, kind whatsapp_bundle); the units
 *    arrive at capture, valid gym_whatsapp.bundle_valid_days; unpaid ones are voided after
 *    gym_whatsapp.bundle_invoice_days (never dunned).
 *  - Holds: a message holds gym_whatsapp.units_utility or units_marketing when queued (reserve); Meta charges on
 *    delivery, so a delivered message settles 0 and a failed or undelivered one gives the hold back.
 *  - Low and empty: gym_whatsapp.low_reached and gym_whatsapp.depleted once per crossing.
 * Called by gym-whatsapp through the facade (whatsappUnits); billing routes call it directly.
 */
const crypto = require('node:crypto');
const { Op, QueryTypes } = require('sequelize');
const { E } = require('../../common/errors');
const { nextCode } = require('../../common/sequences');
const { sequelize, GymOwnerSubscription, GymOwnerAddon, GymWhatsappEntry, GymSubscriptionInvoice, GymSubscriptionInvoiceLine } = require('../../models');
const settings = require('../settings').settings;
const payments = require('../payments');
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');

const { fail } = c;

const cfg = () => ({
  enabled: Boolean(settings.get('gym_whatsapp.api_enabled')),
  included: settings.get('gym_whatsapp.included'),
  bundleSize: settings.get('gym_whatsapp.bundle_size'),
  bundlePrice: settings.get('gym_whatsapp.bundle_price_poisha'),
  bundleValidDays: settings.get('gym_whatsapp.bundle_valid_days'),
  bundleInvoiceDays: settings.get('gym_whatsapp.bundle_invoice_days'),
  unitsUtility: settings.get('gym_whatsapp.units_utility'),
  unitsMarketing: settings.get('gym_whatsapp.units_marketing'),
  low: settings.get('gym_whatsapp.low_balance'),
});
const SNAPSHOT_KEYS = ['gym_whatsapp.bundle_size', 'gym_whatsapp.bundle_price_poisha', 'gym_whatsapp.bundle_valid_days', 'gym_saas.vat_enabled', 'gym_saas.vat_pct'];

/** A deterministic reference (UUID form) so a job run twice writes nothing new. */
function refOf(...parts) {
  const h = crypto.createHash('sha1').update(`kriraghor-gym-whatsapp:${parts.join(':')}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** The units one message of a category holds. */
const unitsFor = (category) => (category === 'marketing' ? cfg().unitsMarketing : cfg().unitsUtility);

async function balanceOf(ownerId, { transaction } = {}) {
  const [row] = await sequelize.query('SELECT COALESCE(SUM(units), 0)::int AS balance FROM gym_whatsapp_entries WHERE owner_id = :ownerId', { replacements: { ownerId }, type: QueryTypes.SELECT, transaction });
  return row.balance;
}

const liveAddon = (ownerId, { transaction, lock = false } = {}) =>
  GymOwnerAddon.findOne({ where: { ownerId, addon: 'whatsapp', status: ['active', 'paused'] }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
const lockSubscription = (ownerId, transaction) => GymOwnerSubscription.findOne({ where: { ownerId }, transaction, lock: transaction.LOCK.UPDATE });
const featureOk = (tier) => rules.hasFeature(tier, 'whatsapp', c.tierCfg().featureMinTiers);

async function usedIn(ownerId, { start, end }, transaction) {
  const [row] = await sequelize.query(
    "SELECT COALESCE(-SUM(units), 0)::int AS used FROM gym_whatsapp_entries WHERE owner_id = :ownerId AND kind IN ('reserve', 'settle') AND created_at >= :from AND created_at < :to",
    { replacements: { ownerId, from: rules.instantOf(start), to: rules.instantOf(rules.addDays(end, 1)) }, type: QueryTypes.SELECT, transaction }
  );
  return row.used;
}

async function allowanceLeft(ownerId, period, transaction) {
  const grant = await GymWhatsappEntry.findOne({ where: { ownerId, kind: 'grant', billingRef: refOf(ownerId, period.month, 'grant') }, transaction });
  if (!grant) return 0;
  return rules.smsAllowanceLeft({ granted: grant.units, used: await usedIn(ownerId, period, transaction) });
}

/** The billing page's WhatsApp card and gym-whatsapp's status: what the owner can do and has. */
async function view(ownerId) {
  const s = cfg();
  const sub = await c.subscriptionOf(ownerId);
  const addon = await liveAddon(ownerId);
  const bundles = await GymWhatsappEntry.findAll({ where: { ownerId, kind: 'purchase', expiresOn: { [Op.gte]: c.today() } }, order: [['expiresOn', 'ASC']] });
  return {
    available: s.enabled && featureOk(sub.chosenTier),
    enabled: s.enabled,
    status: addon?.status ?? null,
    balance: await balanceOf(ownerId),
    included: s.included,
    bundle: { size: s.bundleSize, pricePoisha: s.bundlePrice, validDays: s.bundleValidDays },
    units: { utility: s.unitsUtility, marketing: s.unitsMarketing },
    lowBalance: s.low,
    bundles: bundles.map((b) => ({ units: b.units, expiresOn: b.expiresOn })),
  };
}

const entryView = (e) => ({ id: e.id, kind: e.kind, units: e.units, expiresOn: e.expiresOn ?? null, gymId: e.gymId ?? null, invoiceId: e.invoiceId ?? null, createdAt: c.iso(e.createdAt) });

/** GET /manage/billing/whatsapp-entries (owner): the latest entries, newest first. */
async function entries(principal, { limit = 50 } = {}) {
  const rows = await GymWhatsappEntry.findAll({ where: { ownerId: principal.id }, order: [['createdAt', 'DESC'], ['id', 'DESC']], limit });
  return { balance: await balanceOf(principal.id), items: rows.map(entryView) };
}

const write = (transaction, entry) => GymWhatsappEntry.create(entry, { transaction });

/** After a debit: the crossing it made, as an event the owner hears once per crossing. */
async function afterDebit(transaction, { ownerId, before }) {
  const s = cfg();
  const after = await balanceOf(ownerId, { transaction });
  const crossing = rules.smsCrossing({ before, after, low: s.low, reserve: Math.max(1, s.unitsUtility) });
  if (crossing === 'depleted') await c.publish(transaction, 'gym_whatsapp.depleted', 'gym_owner', ownerId, { ownerId, balance: after });
  if (crossing === 'low') await c.publish(transaction, 'gym_whatsapp.low_reached', 'gym_owner', ownerId, { ownerId, balance: after });
  return after;
}

async function grantIn(transaction, { ownerId, period, by = null }) {
  const units = cfg().included;
  if (units <= 0) return 0;
  const billingRef = refOf(ownerId, period.month, 'grant');
  if (await GymWhatsappEntry.findOne({ where: { billingRef, kind: 'grant' }, transaction, attributes: ['id'] })) return 0;
  await write(transaction, { ownerId, kind: 'grant', units, expiresOn: period.end, billingRef, createdBy: by });
  return units;
}

/** PUT /manage/billing/whatsapp-addon { enabled } (owner; a plan with the whatsapp feature; the platform on). */
async function setAddon(principal, { enabled }, req) {
  await sequelize.transaction(async (transaction) => {
    const sub = await lockSubscription(principal.id, transaction);
    if (!sub) throw E.notFound('Subscription');
    const addon = await liveAddon(principal.id, { transaction, lock: true });
    const now = new Date();
    if (!enabled) {
      if (!addon) return;
      await addon.update({ status: 'ended', endedAt: now }, { transaction });
      await c.record({ action: 'gym_whatsapp_addon.ended', actor: principal, entityType: 'gym_owner_addon', entityId: addon.id, before: { status: addon.status }, after: { status: 'ended' }, req }, transaction);
      return;
    }
    const s = cfg();
    if (!s.enabled || !featureOk(sub.chosenTier) || sub.status === 'closed') throw fail('GYM_WHATSAPP_UNAVAILABLE', { tier: sub.chosenTier, enabled: s.enabled });
    if (addon?.status === 'active') return;
    const row = addon
      ? await addon.update({ status: 'active', pausedAt: null }, { transaction })
      : await GymOwnerAddon.create({ subscriptionId: sub.id, ownerId: principal.id, addon: 'whatsapp', status: 'active', pricePoisha: 0, startedAt: now }, { transaction });
    const today = c.today(now);
    const granted = await grantIn(transaction, { ownerId: principal.id, period: { month: rules.monthOf(today), end: rules.lastOfMonth(today) }, by: principal.id });
    await c.record({ action: 'gym_whatsapp_addon.started', actor: principal, entityType: 'gym_owner_addon', entityId: row.id, after: { status: 'active', granted }, req }, transaction);
  });
  return view(principal.id);
}

/** POST /manage/billing/whatsapp-bundles { bundles } [Idempotency-Key] (owner, WhatsApp on): a bundle invoice paid at once. */
async function buyBundles(principal, { bundles }, idempotencyKey) {
  return sequelize.transaction(async (transaction) => {
    const sub = await lockSubscription(principal.id, transaction);
    if (!sub) throw E.notFound('Subscription');
    const s = cfg();
    if (!s.enabled || !featureOk(sub.chosenTier) || s.bundleSize <= 0 || s.bundlePrice <= 0) throw fail('GYM_WHATSAPP_UNAVAILABLE', { tier: sub.chosenTier, enabled: s.enabled });
    const addon = await liveAddon(principal.id, { transaction });
    if (addon?.status !== 'active') throw fail('GYM_WHATSAPP_OFF');
    const saas = c.saasCfg();
    const calc = rules.whatsappBundleLines({ bundles, size: s.bundleSize, price: s.bundlePrice, vat: { enabled: saas.vatEnabled, pct: saas.vatPct } });
    const now = new Date();
    const inv = await GymSubscriptionInvoice.create(
      {
        number: await nextCode('GI', transaction, now),
        ownerId: principal.id,
        subscriptionId: sub.id,
        kind: 'whatsapp_bundle',
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
      { purpose: invoices.PURPOSE, purposeId: inv.id, payerId: principal.id, amount: inv.totalPoisha, title: `Kriraghor WhatsApp bundle ${inv.number}`, groupRef: inv.id, idempotencyKey: `gym_whatsapp_bundle:${inv.id}:${idempotencyKey}` },
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
  if (await GymWhatsappEntry.findOne({ where: { billingRef, kind: 'purchase' }, transaction, attributes: ['id'] })) return;
  const units = Number(snap.units) || 0;
  if (units <= 0) return;
  const days = Number(snap['gym_whatsapp.bundle_valid_days']?.value) || cfg().bundleValidDays;
  await write(transaction, { ownerId: inv.ownerId, kind: 'purchase', units, expiresOn: rules.addDays(c.today(), days), billingRef, invoiceId: inv.id });
}

/**
 * Before a message: can it hold `units`? Locks the owner's subscription row (held until the caller's
 * transaction ends) → { ok, reason, balance } without writing.
 */
async function planIn(transaction, { ownerId, units }) {
  const s = cfg();
  if (!s.enabled) return { ok: false, reason: 'off', balance: 0 };
  const sub = await lockSubscription(ownerId, transaction);
  const addon = await liveAddon(ownerId, { transaction });
  const balance = addon ? await balanceOf(ownerId, { transaction }) : 0;
  const reason = rules.whatsappBlock({ enabled: s.enabled, featureOk: featureOk(sub?.chosenTier ?? 'free'), restricted: sub?.status === 'restricted', addonStatus: addon?.status, balance, units });
  return { ok: !reason, reason, balance };
}

/** Hold the units of one message (after planIn said ok, in the same transaction), under `billingRef`. */
async function reserveIn(transaction, { ownerId, gymId, units, balance, billingRef }) {
  await write(transaction, { ownerId, kind: 'reserve', units: -units, billingRef, gymId });
  return afterDebit(transaction, { ownerId, before: balance });
}

/**
 * Close a hold once: delivered → 0 (Meta charged it); anything else → the hold back. An unknown or closed
 * ref does nothing → the units given back, or null.
 */
async function settleIn(transaction, { billingRef, delivered, note = null }) {
  const hold = await GymWhatsappEntry.findOne({ where: { billingRef, kind: 'reserve' }, transaction });
  if (!hold) return null;
  await lockSubscription(hold.ownerId, transaction);
  if (await GymWhatsappEntry.findOne({ where: { billingRef, kind: 'settle' }, transaction, attributes: ['id'] })) return null;
  const units = delivered ? 0 : -hold.units;
  await write(transaction, { ownerId: hold.ownerId, kind: 'settle', units, billingRef, gymId: hold.gymId, note: note ?? (delivered ? 'delivered' : 'returned') });
  return units;
}

/** gym-manage.whatsapp-allowance (the 1st): last month's allowance left expires; this month's is granted. */
async function allowance(now = new Date()) {
  const today = c.today(now);
  const last = rules.previousMonth(today);
  const out = { expired: 0, granted: 0 };
  const owners = await GymOwnerAddon.findAll({ where: { addon: 'whatsapp', status: ['active', 'paused'] }, attributes: ['ownerId', 'status'] });
  const ended = await GymWhatsappEntry.findAll({ where: { kind: 'grant', billingRef: { [Op.ne]: null }, expiresOn: last.end }, attributes: ['ownerId'] });
  const ids = [...new Set([...owners.map((o) => o.ownerId), ...ended.map((e) => e.ownerId)])];
  for (const ownerId of ids) {
    await sequelize.transaction(async (transaction) => {
      await lockSubscription(ownerId, transaction);
      const ref = refOf(ownerId, last.month, 'expire');
      if (!(await GymWhatsappEntry.findOne({ where: { billingRef: ref, kind: 'expire' }, transaction, attributes: ['id'] }))) {
        const left = Math.min(await allowanceLeft(ownerId, last, transaction), await balanceOf(ownerId, { transaction }));
        if (left > 0) {
          await write(transaction, { ownerId, kind: 'expire', units: -left, billingRef: ref, note: `allowance ${last.month}` });
          out.expired += left;
        }
      }
      if (owners.find((o) => o.ownerId === ownerId && o.status === 'active')) out.granted += await grantIn(transaction, { ownerId, period: { month: rules.monthOf(today), end: rules.lastOfMonth(today) } });
    });
  }
  return out;
}

/** gym-manage.whatsapp-daily: bundles past their date expire (what is left of them); unpaid bundle invoices are voided. */
async function daily(now = new Date()) {
  const today = c.today(now);
  const out = { bundlesExpired: 0, invoicesVoided: 0 };
  const due = await GymWhatsappEntry.findAll({ where: { kind: 'purchase', expiresOn: { [Op.lt]: today } }, order: [['expiresOn', 'ASC'], ['createdAt', 'ASC']] });
  for (const b of due) {
    await sequelize.transaction(async (transaction) => {
      await lockSubscription(b.ownerId, transaction);
      const ref = refOf(b.id, 'expire');
      if (await GymWhatsappEntry.findOne({ where: { billingRef: ref, kind: 'expire' }, transaction, attributes: ['id'] })) return;
      const balance = await balanceOf(b.ownerId, { transaction });
      const month = rules.previousMonth(rules.addMonths(rules.firstOfMonth(today), 1));
      const pool = balance - (await allowanceLeft(b.ownerId, month, transaction));
      const [{ newer }] = await sequelize.query(
        "SELECT COALESCE(SUM(units), 0)::int AS newer FROM gym_whatsapp_entries WHERE owner_id = :ownerId AND kind = 'purchase' AND expires_on >= :today AND id <> :id",
        { replacements: { ownerId: b.ownerId, today, id: b.id }, type: QueryTypes.SELECT, transaction }
      );
      const left = rules.smsBundleLeft({ units: b.units, pool, newer });
      if (left > 0) {
        await write(transaction, { ownerId: b.ownerId, kind: 'expire', units: -left, billingRef: ref, invoiceId: b.invoiceId, note: 'bundle' });
        out.bundlesExpired += left;
      }
    });
  }
  const unpaid = await GymSubscriptionInvoice.findAll({ where: { kind: 'whatsapp_bundle', status: 'issued', dueAt: { [Op.lte]: now } }, attributes: ['id'] });
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

/** Invariant: no owner's WhatsApp balance is below 0. */
async function negativeBalances() {
  return sequelize.query('SELECT owner_id AS "ownerId" FROM gym_whatsapp_entries GROUP BY owner_id HAVING SUM(units) < 0 LIMIT 20', { type: QueryTypes.SELECT });
}

module.exports = { cfg, refOf, unitsFor, balanceOf, view, entries, setAddon, buyBundles, onBundlePaid, planIn, reserveIn, settleIn, allowance, daily, negativeBalances };
