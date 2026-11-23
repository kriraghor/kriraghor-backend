'use strict';

/**
 * M24 the owner's subscription, invoices and dunning (§5.11, §6.6, §8.6, §8.7, §10).
 *  - gym-manage.active-count (00:45 Dhaka): yesterday's active members per owner (§6.6, FR-83) into
 *    gym_active_member_counts; gym_active_members.counted; the tier notice once a month at
 *    gym_saas.tier_notice_pct of the limit (GYM_TIER_LIMIT_NEAR).
 *  - gym-manage.invoice-cycle (the 1st, 02:00): the month before, in arrears (G21, FR-84): billed tier =
 *    max(highest tier chosen in the month, the tier that fits the month's peak) (FR-82, FR-87, G20),
 *    first-month proration, founding partner months, pending referrals, VAT when enabled; a total of 0
 *    issues nothing. Numbered GI-26-000123 (M06 code sequence); settings snapshotted. month_max_tier
 *    resets to the chosen tier.
 *  - gym-manage.invoice-dunning (10:00): reminders 3 days before and on the due date; issued → overdue
 *    after due_at (subscription past_due); restricted after gym_saas.grace_days more (FR-86, FR-08).
 *    Paying (or a master voiding) every overdue invoice restores active at once.
 *  - Paying (owner, Idempotency-Key, FR-85): M06 purpose gym_saas_invoice, collected to
 *    fee_revenue:gym_saas at capture. A capture of a paid or void invoice is refunded (late capture).
 *  - Prompt 3b: the SMS add-on line on the monthly invoice; bundle invoices (kind sms_bundle) are paid
 *    at once, add their units at capture and are never dunned (sms.service voids them unpaid).
 *  - Admin (/admin/gym-manage): owners, invoices, void (master, step-up escrow.manage; referrals back to
 *    pending, FR-89), founding partners (master, step-up settings.write; GYM_FOUNDING_FULL, FR-88).
 */
const { Op, QueryTypes, UniqueConstraintError } = require('sequelize');
const { E } = require('../../common/errors');
const { nextCode } = require('../../common/sequences');
const logger = require('../../common/logger');
const {
  sequelize,
  GymOwnerSubscription,
  GymSubscriptionInvoice,
  GymSubscriptionInvoiceLine,
  GymReferral,
  GymFeeOverride,
  GymImport,
  GymOwnerAddon,
} = require('../../models');
const payments = require('../payments');
const settings = require('../settings').settings;
const directory = require('../users').directory;
const gymFacade = require('../gym').gyms;
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');
const billing = require('./billing.service');
const fees = require('./fees.service');

const { fail } = c;
const PURPOSE = 'gym_saas_invoice';
const OPEN = ['issued', 'overdue'];
const SNAPSHOT_KEYS = [
  'gym_saas.tier_free_max_members',
  'gym_saas.tier_basic_max_members',
  'gym_saas.tier_standard_max_members',
  'gym_saas.tier_basic_price_poisha',
  'gym_saas.tier_standard_price_poisha',
  'gym_saas.tier_pro_price_poisha',
  'gym_saas.pro_min_gyms',
  'gym_saas.founding_free_months',
  'gym_saas.founding_discount_pct',
  'gym_saas.founding_discount_months',
  'gym_saas.vat_enabled',
  'gym_saas.vat_pct',
  'gym_saas.invoice_due_days',
  'gym_manage.active_window_days',
  'gym_saas.sms_addon_price_poisha',
];

// ---------------------------------------------------------------- views

/** Lines in the order the invoice reads (the plan, its adjustments, referrals, add-ons, VAT). */
const LINE_ORDER = ['tier', 'proration', 'founding_free', 'founding_discount', 'referral', 'sms_addon', 'sms_bundle', 'whatsapp_bundle', 'suspension_pause', 'adjustment', 'vat'];
const byLineOrder = (a, b) => LINE_ORDER.indexOf(a.kind) - LINE_ORDER.indexOf(b.kind) || b.amountPoisha - a.amountPoisha;
const lineView = (l) => ({ id: l.id, kind: l.kind, descriptionEn: l.descriptionEn, descriptionBn: l.descriptionBn, quantity: l.quantity, unitPoisha: l.unitPoisha, amountPoisha: l.amountPoisha });

function invoiceView(i, lines = null) {
  return {
    id: i.id,
    number: i.number,
    ownerId: i.ownerId,
    kind: i.kind,
    periodStart: i.periodStart ?? null,
    periodEnd: i.periodEnd ?? null,
    period: i.periodStart ? rules.monthOf(i.periodStart) : null,
    billedTier: i.billedTier ?? null,
    peakActive: i.peakActive ?? null,
    subtotalPoisha: i.subtotalPoisha,
    vatPoisha: i.vatPoisha,
    totalPoisha: i.totalPoisha,
    status: i.status,
    issuedAt: c.iso(i.issuedAt),
    dueAt: c.iso(i.dueAt),
    dueOn: rules.dhakaDate(new Date(new Date(i.dueAt).getTime() - 1)),
    paidAt: c.iso(i.paidAt),
    paymentId: i.paymentId ?? null,
    voidedAt: c.iso(i.voidedAt),
    voidReason: i.voidReason ?? null,
    ...(lines ? { lines: [...lines].sort(byLineOrder).map(lineView) } : {}),
  };
}

const invoicePayload = (i) => ({ invoiceId: i.id, number: i.number, ownerId: i.ownerId, total: i.totalPoisha, dueAt: c.iso(i.dueAt), period: i.periodStart ? rules.monthOf(i.periodStart) : null });

// ---------------------------------------------------------------- active members (FR-83)

/** gym-manage.active-count: yesterday's count per owner (upsert), and the tier notice once a month. */
async function activeCount(now = new Date()) {
  const day = rules.addDays(c.today(now), -1);
  const t = c.tierCfg();
  const subs = await GymOwnerSubscription.findAll({ where: { status: { [Op.ne]: 'closed' } } });
  let counted = 0;
  for (const sub of subs) {
    const n = await billing.activeCount(sub.ownerId, day);
    const limit = rules.tierLimit(sub.chosenTier, t);
    const near = limit !== null && limit > 0 && n.active * 100 >= limit * t.noticePct;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(
        `INSERT INTO gym_active_member_counts (owner_id, local_date, active_count, gyms_count, chosen_tier, frozen, created_at, updated_at)
         VALUES (:ownerId, :day, :active, :gyms, :tier, :frozen, NOW(), NOW())
         ON CONFLICT (owner_id, local_date) DO UPDATE SET active_count = EXCLUDED.active_count, gyms_count = EXCLUDED.gyms_count, chosen_tier = EXCLUDED.chosen_tier, frozen = EXCLUDED.frozen, updated_at = NOW()`,
        { replacements: { ownerId: sub.ownerId, day, active: n.active, gyms: n.gymsWithMembers, tier: sub.chosenTier, frozen: Boolean(n.frozen) }, type: QueryTypes.INSERT, transaction }
      );
      const notice = near ? await c.claimReminder(transaction, { ownerId: sub.ownerId, kind: 'tier_notice', subjectType: 'owner', subjectId: sub.ownerId, offsetKey: rules.monthOf(day), channels: ['in_app', 'email'] }) : false;
      await c.publish(transaction, 'gym_active_members.counted', 'gym_owner_subscription', sub.id, { ownerId: sub.ownerId, localDate: day, count: n.active, gymsCount: n.gymsWithMembers, tierLimit: limit, chosenTier: sub.chosenTier, notice });
    });
    counted += 1;
  }
  return { counted, day };
}

/**
 * The month's peak of active members (and of gyms with members) from the daily counts, live when none; and
 * the days every gym of the owner was suspended (M24-FR-172).
 */
async function peakOf(ownerId, { start, end }, transaction) {
  const [row] = await sequelize.query(
    'SELECT MAX(active_count)::int AS peak, MAX(gyms_count)::int AS gyms, COUNT(*)::int AS days, COUNT(*) FILTER (WHERE frozen)::int AS frozen FROM gym_active_member_counts WHERE owner_id = :ownerId AND local_date BETWEEN :start AND :end',
    { replacements: { ownerId, start, end }, type: QueryTypes.SELECT, transaction }
  );
  if (row.days > 0) return { peak: row.peak, gymsWithMembers: row.gyms, frozenDays: row.frozen };
  const live = await billing.activeCount(ownerId, end);
  return { peak: live.active, gymsWithMembers: live.gymsWithMembers, frozenDays: 0 };
}

// ---------------------------------------------------------------- the monthly cycle (FR-84)

/** Issue one owner's invoice for `period` inside the caller's transaction (idempotent per period: null when issued already or nothing is due). */
async function issueMonthlyIn(transaction, sub, period, now) {
  if (sub.startedOn > period.end) return null;
  const existing = await GymSubscriptionInvoice.findOne({ where: { subscriptionId: sub.id, periodStart: period.start, kind: 'monthly', status: { [Op.ne]: 'void' } }, transaction });
  if (existing) return null;
  const t = c.tierCfg();
  const s = c.saasCfg();
  const { peak, gymsWithMembers, frozenDays } = await peakOf(sub.ownerId, period, transaction);
  const fit = rules.ownerFitTier({ peak, gymsWithMembers, cfg: t });
  // The highest tier chosen during the period: month_max_tier while it is that month's; an older month means no change since.
  const monthMax = sub.monthOf === period.start ? sub.monthMaxTier : sub.monthOf < period.start ? sub.chosenTier : rules.higherTier(sub.chosenTier, sub.monthMaxTier);
  const tier = rules.billedTier({ monthMaxTier: monthMax, fit });
  if (tier !== 'free' && !sub.paidTierSince) await sub.update({ paidTierSince: period.start }, { transaction });
  const referrals = await GymReferral.findAll({ where: { ownerId: sub.ownerId, status: 'pending', createdAt: { [Op.lt]: rules.instantOf(rules.addDays(period.end, 1)) } }, transaction, lock: transaction.LOCK.UPDATE });
  // Prompt 3b (§6.6): the SMS add-on when it was active on any day of the month, at today's price.
  const addon = await GymOwnerAddon.findOne({
    where: { ownerId: sub.ownerId, addon: 'sms', startedAt: { [Op.lt]: rules.instantOf(rules.addDays(period.end, 1)) }, [Op.or]: [{ endedAt: null }, { endedAt: { [Op.gte]: rules.instantOf(period.start) } }] },
    attributes: ['id'],
    transaction,
  });
  const calc = rules.invoiceLines({
    periodStart: period.start,
    periodEnd: period.end,
    tier,
    prices: { basic: t.basicPrice, standard: t.standardPrice, pro: t.proPrice },
    startedOn: sub.startedOn,
    founding: { partner: sub.foundingPartner, paidTierSince: sub.paidTierSince, freeMonths: s.foundingFreeMonths, discountMonths: s.foundingDiscountMonths, discountPct: s.foundingDiscountPct },
    referrals: referrals.map((r) => ({ id: r.id, amount: r.amountPoisha })),
    smsAddon: addon ? { price: require('./sms.service').cfg().addonPrice } : null,
    vat: { enabled: s.vatEnabled, pct: s.vatPct },
    pausedDays: frozenDays,
  });
  if (calc.total <= 0) return null;
  const due = rules.invoiceDue({ issuedOn: c.today(now), dueDays: s.invoiceDueDays });
  const inv = await GymSubscriptionInvoice.create(
    {
      number: await nextCode('GI', transaction, now),
      ownerId: sub.ownerId,
      subscriptionId: sub.id,
      kind: 'monthly',
      periodStart: period.start,
      periodEnd: period.end,
      billedTier: tier,
      peakActive: peak,
      subtotalPoisha: calc.subtotal,
      vatPoisha: calc.vat,
      totalPoisha: calc.total,
      status: 'issued',
      issuedAt: now,
      dueAt: due.dueAt,
      settingsSnapshot: { ...settings.snapshot(SNAPSHOT_KEYS), fitTier: fit, monthMaxTier: monthMax, gymsWithMembers },
    },
    { transaction }
  );
  await GymSubscriptionInvoiceLine.bulkCreate(calc.lines.map((l) => ({ ...l, invoiceId: inv.id })), { transaction });
  if (referrals.length) await GymReferral.update({ status: 'invoiced', invoiceId: inv.id }, { where: { id: referrals.map((r) => r.id) }, transaction });
  await c.publish(transaction, 'gym_invoice.issued', 'gym_subscription_invoice', inv.id, invoicePayload(inv));
  return inv;
}

/** gym-manage.invoice-cycle: every subscription's invoice for the month before (the 1st, 02:00). */
async function cycle(now = new Date()) {
  const today = c.today(now);
  const period = rules.previousMonth(today);
  const subs = await GymOwnerSubscription.findAll({ where: { status: { [Op.ne]: 'closed' } }, attributes: ['id'] });
  const out = { issued: 0, nothing: 0, failed: 0, period: period.month };
  for (const { id } of subs) {
    try {
      const inv = await sequelize.transaction(async (transaction) => {
        const sub = await GymOwnerSubscription.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
        const made = await issueMonthlyIn(transaction, sub, period, now);
        // A new month starts from the chosen tier (§8.6).
        if (sub.monthOf < rules.firstOfMonth(today)) await sub.update({ monthOf: rules.firstOfMonth(today), monthMaxTier: sub.chosenTier }, { transaction });
        return made;
      });
      if (inv) out.issued += 1;
      else out.nothing += 1;
    } catch (err) {
      if (err instanceof UniqueConstraintError) continue;
      out.failed += 1;
      logger.error({ err: err.message, subscriptionId: id }, 'gym invoice cycle failed');
    }
  }
  return out;
}

// ---------------------------------------------------------------- dunning (FR-86)

/** The subscription follows its invoices (§8.6): past_due, restricted, or restored; events on each step. */
async function syncSubscriptionIn(transaction, sub, { now = new Date(), actor = null } = {}) {
  // Bundle invoices (prompt 3b) never make a subscription past due: unpaid, they are voided instead.
  const invoices = await GymSubscriptionInvoice.findAll({ where: { subscriptionId: sub.id, status: OPEN, kind: 'monthly' }, order: [['dueAt', 'ASC']], transaction });
  // M24-FR-173: while every gym of the owner is suspended, dunning never makes it worse.
  const next = rules.subscriptionStatus({ status: sub.status, invoices, now, graceDays: c.saasCfg().graceDays, frozen: await billing.frozenNow(sub.ownerId) });
  if (next === sub.status) return sub.status;
  const first = invoices.find((i) => i.status === 'overdue') ?? null;
  const payload = { subscriptionId: sub.id, ownerId: sub.ownerId, invoiceId: first?.id ?? null, number: first?.number ?? null };
  if (next === 'active') {
    await sub.update({ status: 'active', pastDueAt: null, restrictedAt: null }, { transaction });
    await c.publish(transaction, 'gym_subscription.restored', 'gym_owner_subscription', sub.id, payload, actor);
  } else if (next === 'past_due') {
    await sub.update({ status: 'past_due', pastDueAt: sub.pastDueAt ?? now, restrictedAt: null }, { transaction });
    if (sub.status !== 'restricted') await c.publish(transaction, 'gym_subscription.past_due_marked', 'gym_owner_subscription', sub.id, payload, actor);
  } else {
    await sub.update({ status: 'restricted', pastDueAt: sub.pastDueAt ?? now, restrictedAt: now }, { transaction });
    await c.publish(transaction, 'gym_subscription.restricted', 'gym_owner_subscription', sub.id, payload, actor);
  }
  return next;
}

/** gym-manage.invoice-dunning (10:00): reminders, overdue, past_due, restricted (status guards; once-keys). */
async function dunning(now = new Date()) {
  const today = c.today(now);
  const s = c.saasCfg();
  const out = { reminded: 0, overdue: 0, pastDue: 0, restricted: 0, restored: 0 };
  for (const { id } of await GymSubscriptionInvoice.findAll({ where: { status: 'issued', kind: 'monthly' }, attributes: ['id'] })) {
    await sequelize.transaction(async (transaction) => {
      const inv = await GymSubscriptionInvoice.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (inv.status !== 'issued') return;
      if (now.getTime() >= new Date(inv.dueAt).getTime()) {
        await inv.update({ status: 'overdue' }, { transaction });
        await c.publish(transaction, 'gym_invoice.overdue_marked', 'gym_subscription_invoice', inv.id, { ...invoicePayload(inv), restrictOn: rules.restrictOn({ dueAt: inv.dueAt, graceDays: s.graceDays }) });
        out.overdue += 1;
        return;
      }
      const key = rules.invoiceReminderKey({ dueAt: inv.dueAt, today });
      if (key && (await c.claimReminder(transaction, { ownerId: inv.ownerId, kind: 'invoice_due', subjectType: 'invoice', subjectId: inv.id, offsetKey: key, channels: ['in_app', 'email'] }))) {
        await c.publish(transaction, 'gym_invoice.reminded', 'gym_subscription_invoice', inv.id, { ...invoicePayload(inv), offsetKey: key });
        out.reminded += 1;
      }
    });
  }
  const subs = await GymOwnerSubscription.findAll({ where: { status: { [Op.in]: ['active', 'past_due', 'restricted'] } }, attributes: ['id'] });
  for (const { id } of subs) {
    await sequelize.transaction(async (transaction) => {
      const sub = await GymOwnerSubscription.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      const before = sub.status;
      const after = await syncSubscriptionIn(transaction, sub, { now });
      if (after === before) return;
      if (after === 'past_due') out.pastDue += 1;
      if (after === 'restricted') out.restricted += 1;
      if (after === 'active') out.restored += 1;
    });
  }
  return out;
}

// ---------------------------------------------------------------- owner (billing page, invoices, pay)

/** GET /manage/billing/invoices (owner of a gym): newest first. */
async function mine(principal) {
  const rows = await GymSubscriptionInvoice.findAll({ where: { ownerId: principal.id }, order: [['issuedAt', 'DESC']], limit: 120 });
  return { items: rows.map((r) => invoiceView(r)) };
}

/** GET /manage/billing/invoices/:invoiceId (owner): the invoice with its lines. */
async function mineOne(principal, invoiceId) {
  const inv = await GymSubscriptionInvoice.findOne({ where: { id: invoiceId, ownerId: principal.id } });
  if (!inv) throw E.notFound('Invoice');
  const lines = await GymSubscriptionInvoiceLine.findAll({ where: { invoiceId: inv.id }, order: [['createdAt', 'ASC'], ['id', 'ASC']] });
  return invoiceView(inv, lines);
}

/** POST /manage/billing/invoices/:invoiceId/pay [Idempotency-Key] (owner): an M06 payment → { invoice, payment: { id, payUrl } }. */
async function pay(principal, invoiceId, idempotencyKey) {
  return sequelize.transaction(async (transaction) => {
    const inv = await GymSubscriptionInvoice.findOne({ where: { id: invoiceId, ownerId: principal.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!inv) throw E.notFound('Invoice');
    if (!OPEN.includes(inv.status)) throw fail('GYM_INVOICE_STATE', { status: inv.status });
    const p = await payments.intents.createIntent(
      { purpose: PURPOSE, purposeId: inv.id, payerId: principal.id, amount: inv.totalPoisha, title: `Kriraghor gym plan ${inv.number}`, groupRef: inv.id, idempotencyKey: `gym_invoice:${inv.id}:${idempotencyKey}` },
      { transaction }
    );
    return { invoice: invoiceView(inv), payment: { id: p.id, payUrl: payments.intents.payUrl(p.id, PURPOSE) } };
  });
}

/** M06 hook: a captured invoice payment marks it paid, is collected to fee_revenue:gym_saas and restores the subscription. */
async function onCaptured({ payment, transaction }) {
  const inv = await GymSubscriptionInvoice.findByPk(payment.purposeId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!inv || !OPEN.includes(inv.status) || inv.totalPoisha !== payment.amountPoisha) return 'reject';
  const now = new Date();
  await inv.update({ status: 'paid', paidAt: now, paymentId: payment.id }, { transaction });
  const hold = await payments.escrow.lockHoldForPayment(payment.id, transaction);
  if (hold) await payments.escrow.collectToRevenueInTx(hold, { transaction });
  await c.publish(transaction, 'gym_invoice.paid', 'gym_subscription_invoice', inv.id, invoicePayload(inv));
  // Prompt 3b (M24-FR-98): a bundle's units arrive with the payment.
  if (inv.kind === 'sms_bundle') await require('./sms.service').onBundlePaid(transaction, inv);
  // M24 §25: WhatsApp units arrive with the payment.
  if (inv.kind === 'whatsapp_bundle') await require('./whatsapp-units.service').onBundlePaid(transaction, inv);
  const sub = await GymOwnerSubscription.findByPk(inv.subscriptionId, { transaction, lock: transaction.LOCK.UPDATE });
  await syncSubscriptionIn(transaction, sub, { now });
  return 'accept';
}
payments.purposes.register(PURPOSE, { onCaptured });

/** What the billing page adds in prompt 2 (FR-88, FR-90): peak, open invoices, founding status, fees that apply. */
async function billingExtras(ownerId, sub) {
  const today = c.today();
  const s = c.saasCfg();
  const [row] = await sequelize.query("SELECT MAX(active_count)::int AS peak FROM gym_active_member_counts WHERE owner_id = :ownerId AND local_date >= :start", {
    replacements: { ownerId, start: rules.firstOfMonth(today) },
    type: QueryTypes.SELECT,
  });
  const open = await GymSubscriptionInvoice.findAll({ where: { ownerId, status: OPEN }, order: [['dueAt', 'ASC']] });
  const overdue = open.find((i) => i.status === 'overdue');
  const window = rules.foundingWindow({ foundingPartner: sub.foundingPartner, paidTierSince: sub.paidTierSince, freeMonths: s.foundingFreeMonths, discountMonths: s.foundingDiscountMonths });
  const places = await GymOwnerSubscription.count({ where: { foundingPartner: true } });
  return {
    monthPeak: row.peak,
    openInvoices: open.map((i) => invoiceView(i)),
    restrictOn: overdue ? rules.restrictOn({ dueAt: overdue.dueAt, graceDays: s.graceDays }) : null,
    founding: { partner: sub.foundingPartner, no: sub.foundingNo ?? null, paidTierSince: sub.paidTierSince ?? null, ...window, discountPct: s.foundingDiscountPct, placesLeft: Math.max(0, s.foundingLimit - places) },
    fees: await fees.feesFor(ownerId),
  };
}

// ---------------------------------------------------------------- admin (/admin/gym-manage)

const subView = (s) => ({
  id: s.id,
  ownerId: s.ownerId,
  chosenTier: s.chosenTier,
  monthMaxTier: s.monthMaxTier,
  monthOf: s.monthOf,
  status: s.status,
  startedOn: s.startedOn,
  paidTierSince: s.paidTierSince ?? null,
  foundingPartner: s.foundingPartner,
  foundingNo: s.foundingNo ?? null,
  pastDueAt: c.iso(s.pastDueAt),
  restrictedAt: c.iso(s.restrictedAt),
});

/** GET /admin/gym-manage/owners?tier&status&founding (manage_gyms or view_payouts): counts only, never member data. */
async function owners({ tier, status, founding } = {}) {
  const subs = await GymOwnerSubscription.findAll({ where: { ...(tier ? { chosenTier: tier } : {}), ...(status ? { status } : {}), ...(founding !== undefined ? { foundingPartner: founding } : {}) }, order: [['createdAt', 'DESC']], limit: 500 });
  const ids = subs.map((s) => s.ownerId);
  const names = await directory.displayNames(ids);
  const latest = ids.length
    ? await sequelize.query('SELECT DISTINCT ON (owner_id) owner_id AS "ownerId", active_count AS active, local_date AS day FROM gym_active_member_counts WHERE owner_id IN (:ids) ORDER BY owner_id, local_date DESC', { replacements: { ids }, type: QueryTypes.SELECT })
    : [];
  const gymsCount = ids.length ? await sequelize.query("SELECT owner_id AS \"ownerId\", COUNT(*)::int AS n FROM gym_manage_settings WHERE owner_id IN (:ids) GROUP BY owner_id", { replacements: { ids }, type: QueryTypes.SELECT }) : [];
  const lastInv = ids.length ? await GymSubscriptionInvoice.findAll({ where: { ownerId: ids }, order: [['issuedAt', 'DESC']] }) : [];
  return {
    items: subs.map((s) => {
      const inv = lastInv.find((i) => i.ownerId === s.ownerId);
      const a = latest.find((x) => x.ownerId === s.ownerId);
      return {
        ownerId: s.ownerId,
        displayName: names.get(s.ownerId) ?? null,
        subscription: subView(s),
        gyms: gymsCount.find((g) => g.ownerId === s.ownerId)?.n ?? 0,
        activeMembers: a ? { count: a.active, on: a.day } : null,
        lastInvoice: inv ? { id: inv.id, number: inv.number, status: inv.status, totalPoisha: inv.totalPoisha, period: inv.periodStart ? rules.monthOf(inv.periodStart) : null } : null,
      };
    }),
  };
}

/** GET /admin/gym-manage/owners/:ownerId: subscription, gyms (counts), invoices, overrides, imports, fees. */
async function ownerDetail(ownerId) {
  const sub = await GymOwnerSubscription.findOne({ where: { ownerId } });
  if (!sub) throw E.notFound('Owner');
  const gyms = await gymFacade.ofOwner(ownerId);
  const today = c.today();
  const counts = gyms.length
    ? await sequelize.query(
        "SELECT gym_id AS \"gymId\", COUNT(*) FILTER (WHERE status <> 'removed')::int AS members, COUNT(*) FILTER (WHERE status IN ('active', 'frozen'))::int AS active FROM gym_members WHERE gym_id IN (:ids) GROUP BY gym_id",
        { replacements: { ids: gyms.map((g) => g.id) }, type: QueryTypes.SELECT }
      )
    : [];
  const [invoices, overrides, imports, live] = await Promise.all([
    GymSubscriptionInvoice.findAll({ where: { ownerId }, order: [['issuedAt', 'DESC']], limit: 60 }),
    GymFeeOverride.findAll({ where: { ownerId }, order: [['createdAt', 'DESC']] }),
    GymImport.findAll({ where: { ownerId }, order: [['createdAt', 'DESC']], limit: 50, attributes: ['id', 'gymId', 'status', 'rowsOk', 'rowsFailed', 'uploadedAs', 'createdAt', 'appliedAt', 'undoneAt'] }),
    billing.activeCount(ownerId, today),
  ]);
  return {
    owner: { id: ownerId, displayName: (await directory.displayNames([ownerId])).get(ownerId) ?? null, gymOwnerRole: await directory.roleStatus(ownerId, 'gym_owner') },
    subscription: subView(sub),
    activeMembers: { today: live.active, gymsWithMembers: live.gymsWithMembers, ...(await billingExtras(ownerId, sub)) },
    gyms: gyms.map((g) => ({ id: g.id, name: g.name, listingStatus: g.status, members: counts.find((x) => x.gymId === g.id)?.members ?? 0, activeMembers: counts.find((x) => x.gymId === g.id)?.active ?? 0 })),
    invoices: invoices.map((i) => invoiceView(i)),
    overrides: overrides.map(fees.overrideView),
    imports: imports.map((i) => ({ id: i.id, gymId: i.gymId, status: i.status, rowsOk: i.rowsOk, rowsFailed: i.rowsFailed, uploadedAs: i.uploadedAs, createdAt: c.iso(i.createdAt), appliedAt: c.iso(i.appliedAt), undoneAt: c.iso(i.undoneAt) })),
    smsAddon: await require('./sms.service').view(ownerId, sub),
  };
}

/** GET /admin/gym-manage/invoices?status&period&ownerId (manage_gyms or view_payouts): with totals. */
async function adminInvoices({ status, period, ownerId } = {}) {
  const rows = await GymSubscriptionInvoice.findAll({
    where: { ...(status ? { status } : {}), ...(ownerId ? { ownerId } : {}), ...(period ? { periodStart: `${period}-01` } : {}) },
    order: [['issuedAt', 'DESC']],
    limit: 500,
  });
  const names = await directory.displayNames([...new Set(rows.map((r) => r.ownerId))]);
  const totals = rows.reduce((acc, r) => ({ ...acc, [r.status]: { count: (acc[r.status]?.count ?? 0) + 1, totalPoisha: (acc[r.status]?.totalPoisha ?? 0) + r.totalPoisha } }), {});
  return { items: rows.map((r) => ({ ...invoiceView(r), ownerName: names.get(r.ownerId) ?? null })), totals };
}

/** POST /admin/gym-manage/invoices/:invoiceId/void { reason } (master, step-up escrow.manage, FR-89). */
async function voidInvoice(actor, invoiceId, { reason }, req) {
  const inv = await sequelize.transaction(async (transaction) => {
    const i = await GymSubscriptionInvoice.findByPk(invoiceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!i) throw E.notFound('Invoice');
    if (!OPEN.includes(i.status)) throw fail('GYM_INVOICE_STATE', { status: i.status });
    const now = new Date();
    await i.update({ status: 'void', voidedAt: now, voidedBy: actor.id, voidReason: reason }, { transaction });
    await GymReferral.update({ status: 'pending', invoiceId: null }, { where: { invoiceId: i.id, status: 'invoiced' }, transaction });
    await c.publish(transaction, 'gym_invoice.voided', 'gym_subscription_invoice', i.id, invoicePayload(i), actor);
    await c.record({ action: 'gym_invoice.voided', actor, entityType: 'gym_subscription_invoice', entityId: i.id, entityCode: i.number, before: { status: 'open' }, after: { status: 'void' }, reason, meta: { ownerId: i.ownerId, total: i.totalPoisha }, req }, transaction);
    const sub = await GymOwnerSubscription.findByPk(i.subscriptionId, { transaction, lock: transaction.LOCK.UPDATE });
    await syncSubscriptionIn(transaction, sub, { now, actor });
    return i;
  });
  return invoiceView(inv);
}

/** PUT /admin/gym-manage/owners/:ownerId/founding-partner { on, reason } (master, step-up settings.write, FR-88). */
async function setFounding(actor, ownerId, { on, reason }, req) {
  try {
    const sub = await sequelize.transaction(async (transaction) => {
      // One founding place at a time across all owners (the numbering and the limit).
      await sequelize.query("SELECT pg_advisory_xact_lock(hashtext('gym_founding_partner'))", { transaction });
      const s = await GymOwnerSubscription.findOne({ where: { ownerId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!s) throw E.notFound('Owner');
      if (s.foundingPartner === on) return s;
      if (on) {
        const taken = await GymOwnerSubscription.count({ where: { foundingPartner: true }, transaction });
        if (taken >= c.saasCfg().foundingLimit) throw fail('GYM_FOUNDING_FULL', { limit: c.saasCfg().foundingLimit });
        const [{ max }] = await sequelize.query('SELECT COALESCE(MAX(founding_no), 0)::int AS max FROM gym_owner_subscriptions', { type: QueryTypes.SELECT, transaction });
        await s.update({ foundingPartner: true, foundingNo: max + 1, foundingSetBy: actor.id, foundingSetAt: new Date() }, { transaction });
      } else {
        await s.update({ foundingPartner: false, foundingNo: null, foundingSetBy: actor.id, foundingSetAt: new Date() }, { transaction });
      }
      await c.record({ action: 'gym_subscription.founding_set', actor, entityType: 'gym_owner_subscription', entityId: s.id, before: { foundingPartner: !on }, after: { foundingPartner: on, foundingNo: s.foundingNo ?? null }, reason, meta: { ownerId }, req }, transaction);
      return s;
    });
    return subView(sub);
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw fail('GYM_FOUNDING_FULL');
    throw err;
  }
}

module.exports = { PURPOSE, invoiceView, lineView, invoicePayload, activeCount, peakOf, issueMonthlyIn, cycle, syncSubscriptionIn, dunning, mine, mineOne, pay, onCaptured, billingExtras, subView, owners, ownerDetail, adminInvoices, voidInvoice, setFounding };
