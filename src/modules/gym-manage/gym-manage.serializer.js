'use strict';

/**
 * M24 views, per audience (M24-FR-15, FR-106): a gym sees only what it typed and, for a linked member,
 * the link. Phones show their last 4 digits; full numbers only through the audited reveal. Money keys
 * appear only for callers who may collect fees (owner, fees.collect); the member sees their own.
 * Photos are private: `photoPath` is an API path under /api/v1 to fetch with the bearer token.
 */
const rules = require('./gym-manage.rules');
const c = require('./gym-manage.common');

const photoPath = (m) => (m.photoKey ? `/manage/gyms/${m.gymId}/members/${m.id}/photo` : null);

/** A member as lists and cards show them (no phone beyond the last 4 digits, no contact data). */
const memberSummary = (m) => ({
  id: m.id,
  memberCode: m.memberCode,
  displayName: m.displayName,
  phoneLast4: m.phoneLast4,
  gender: m.gender ?? null,
  status: m.status,
  source: m.source,
  linked: Boolean(m.userId),
  joinedOn: m.joinedOn,
  photoPath: photoPath(m),
});

const freezeView = (f) => ({ id: f.id, fromOn: f.fromOn, toOn: f.toOn, endedEarlyOn: f.endedEarlyOn ?? null, reason: f.reason, status: f.status });

/** A membership with its package snapshot and dates. */
function membershipView(ms, { today, freezes = [], dueId = null } = {}) {
  return {
    id: ms.id,
    memberId: ms.memberId,
    packageId: ms.packageId,
    packageKind: ms.packageKind,
    title: ms.title,
    days: ms.days,
    pricePoisha: ms.pricePoisha,
    admissionFeePoisha: ms.admissionFeePoisha,
    discountPoisha: ms.discountPoisha,
    discountReason: ms.discountReason ?? null,
    visitLimit: ms.visitLimit ?? null,
    origin: ms.origin,
    previousId: ms.previousId ?? null,
    startsOn: ms.startsOn,
    endsOn: ms.endsOn,
    frozenDays: ms.frozenDays,
    freezesCount: ms.freezesCount,
    status: ms.status,
    daysLeft: ['active', 'frozen', 'upcoming'].includes(ms.status) ? rules.daysLeft({ startsOn: ms.startsOn, endsOn: ms.endsOn, today }) : 0,
    cancelledAt: c.iso(ms.cancelledAt),
    cancelReason: ms.cancelReason ?? null,
    dueId,
    freezes: freezes.map(freezeView),
  };
}

/** One fee payment (or reversal); the receipt link only on positive rows. */
function paymentView(p, { names = new Map(), reversedBy = null } = {}) {
  return {
    id: p.id,
    dueId: p.dueId,
    memberId: p.memberId,
    amountPoisha: p.amountPoisha,
    method: p.method,
    paidOn: p.paidOn,
    receiptNo: p.receiptNo ?? null,
    receiptUrl: p.amountPoisha > 0 ? c.receiptUrlOf(p.id) : null,
    reversesId: p.reversesId ?? null,
    reversedById: reversedBy,
    reason: p.reason ?? null,
    note: p.note ?? null,
    receivedBy: p.receivedBy ? { id: p.receivedBy, displayName: names.get(p.receivedBy) ?? null } : null,
    // Online payments (M24-FR-42, FR-43): the M06 payment and link, and the provider charge passed through
    // at cost; `providerCharge` is a staff-hidden key (the owner only; never the member).
    paymentId: p.paymentId ?? null,
    linkId: p.linkId ?? null,
    providerCharge: p.method === 'online' && p.amountPoisha > 0 ? { bps: p.providerChargeBps ?? 0, poisha: p.providerChargePoisha ?? 0, netPoisha: p.amountPoisha - (p.providerChargePoisha ?? 0) } : null,
    createdAt: c.iso(p.createdAt),
  };
}

/**
 * A due. `money: false` (members.view without fees.collect) keeps the status and dates only (§3.3:
 * "the desk card shows the member's status and outstanding flag, not amounts").
 */
function dueView(d, { today, payments = [], names = new Map(), money = true } = {}) {
  const state = rules.dueState({ amount: d.amountPoisha, paid: d.paidPoisha, waived: d.waivedPoisha, voided: d.status === 'void' });
  const base = { id: d.id, membershipId: d.membershipId, memberId: d.memberId, dueOn: d.dueOn, status: d.status, overdue: rules.isOverdue({ status: d.status, dueOn: d.dueOn, today }) };
  if (!money) return base;
  const reversed = new Map(payments.filter((p) => p.reversesId).map((p) => [p.reversesId, p.id]));
  return {
    ...base,
    amountPoisha: d.amountPoisha,
    paidPoisha: d.paidPoisha,
    waivedPoisha: d.waivedPoisha,
    outstandingPoisha: state.outstanding,
    waiveReason: d.waiveReason ?? null,
    voidedAt: c.iso(d.voidedAt),
    voidReason: d.voidReason ?? null,
    payments: payments.map((p) => paymentView(p, { names, reversedBy: reversed.get(p.id) ?? null })),
  };
}

const noteView = (n, names = new Map()) => ({ id: n.id, body: n.body, by: { id: n.byUser, displayName: names.get(n.byUser) ?? null }, createdAt: c.iso(n.createdAt) });

/**
 * A link request as the gym sees it. An invitee's account is never named; a join request shows who asks
 * (their display name, account photo and the last 4 digits of their phone: they agreed the gym sees
 * their name and phone, M24-FR-16), the package asked for and their note.
 */
const requestView = (r, { member = null, requester = null, pkg = null } = {}) => ({
  id: r.id,
  direction: r.direction,
  status: r.status,
  memberId: r.memberId ?? null,
  member: member ? { id: member.id, memberCode: member.memberCode, displayName: member.displayName, phoneLast4: member.phoneLast4 } : null,
  accountKnown: Boolean(r.userId),
  requester: r.direction === 'join_request' ? { displayName: requester?.displayName ?? null, avatarUrl: requester?.avatarUrl ?? null, phoneLast4: requester?.phoneLast4 ?? null } : null,
  package: r.direction === 'join_request' && pkg ? { id: pkg.id, title: pkg.title, kind: pkg.kind, pricePoisha: pkg.pricePoisha } : null,
  note: r.direction === 'join_request' ? (r.note ?? null) : null,
  expiresAt: c.iso(r.expiresAt),
  decidedAt: c.iso(r.decidedAt),
  createdAt: c.iso(r.createdAt),
});

/**
 * The receipt (M24-FR-37): the gym's name and address, TIN or BIN only when entered, member name and
 * code, package and period, amount, method, number, received by, outstanding after, and the reversal
 * date once reversed. The same JSON for staff, the member and the public token page.
 */
function receiptView({ payment, gym, settings, member, membership, receivedByName, outstandingAfter, reversal }) {
  return {
    id: payment.id,
    receiptNo: payment.receiptNo,
    url: c.receiptUrlOf(payment.id),
    gym: { id: gym.id, name: gym.name, addressLine: gym.addressLine ?? null, tin: settings?.tin || null, bin: settings?.bin || null, footer: settings?.receiptFooter || null },
    member: { memberCode: member.memberCode, displayName: member.displayName },
    membership: membership ? { title: membership.title, packageKind: membership.packageKind, startsOn: membership.startsOn, endsOn: membership.endsOn } : null,
    amountPoisha: payment.amountPoisha,
    // M27-FR-28: the VAT inside the amount, at the rate it was recorded at.
    vat: payment.vatBps ? { bps: payment.vatBps, ...rules.vatPart(payment.amountPoisha, payment.vatBps) } : null,
    method: payment.method,
    paidOn: payment.paidOn,
    receivedBy: receivedByName ?? null,
    outstandingAfterPoisha: outstandingAfter,
    issuedAt: c.iso(payment.createdAt),
    reversed: reversal ? { on: reversal.paidOn, at: c.iso(reversal.createdAt) } : null,
  };
}

// ---------------------------------------------------------------- prompt 3: plans and diet charts

/** "Given by {gym}, not medical advice" on every plan view (M24-FR-69). */
const safetyLine = (gymName) => ({ en: `Given by ${gymName}, not medical advice`, bn: `${gymName} দিয়েছে, এটি চিকিৎসা পরামর্শ নয়` });

const planView = (p, { activeAssignments = 0 } = {}) => ({
  id: p.id,
  gymId: p.gymId,
  kind: p.kind,
  title: p.title,
  isTemplate: p.isTemplate,
  source: p.source,
  currentVersion: p.currentVersion,
  status: p.status,
  retiredAt: c.iso(p.retiredAt),
  activeAssignments,
  createdAt: c.iso(p.createdAt),
  updatedAt: c.iso(p.updatedAt),
});

const versionView = (v, names = new Map()) => ({ id: v.id, version: v.version, content: v.content, createdAt: c.iso(v.createdAt), createdBy: { id: v.createdBy, displayName: names.get(v.createdBy) ?? null } });

/** An assignment with its plan's title and the version it shows. */
const assignmentView = (a, { plan, version }) => ({
  id: a.id,
  planId: a.planId,
  kind: a.kind,
  title: plan?.title ?? '',
  version: version?.version ?? 1,
  memberId: a.memberId,
  startsOn: a.startsOn,
  endsOn: a.endsOn ?? null,
  status: a.status,
  endedAt: c.iso(a.endedAt),
  createdAt: c.iso(a.createdAt),
});

const logView = (l) => ({ id: l.id, assignmentId: l.assignmentId, localDate: l.localDate, itemRef: l.itemRef, done: l.done, note: l.note ?? null, createdAt: c.iso(l.createdAt) });

module.exports = { photoPath, memberSummary, freezeView, membershipView, paymentView, dueView, noteView, requestView, receiptView, safetyLine, planView, versionView, assignmentView, logView };
