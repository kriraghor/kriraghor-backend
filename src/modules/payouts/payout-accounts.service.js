'use strict';

/**
 * Payout accounts (M07 §4.1, FR-01, FR-02). Step 1 offers bKash and Nagad wallets only (bank and
 * BEFTN come with the bank channel). The number is encrypted at rest (common/crypto); responses carry
 * the last 4 digits only, and an HMAC flags one wallet on several users (edge case 8).
 *
 *   add (OTP to the registered phone) ─▶ pending_verification ─▶ active (staff verify) | rejected
 *   active ─▶ superseded (a newer account is verified) | disabled
 * Until M02 exists, finance staff verify that the account name matches the payee's NID legal name
 * (recorded in the spec's Differences table). Verifying a replacement account places an
 * account_change hold for risk.payout_change_hold_hours (FR-02).
 */
const { Op } = require('sequelize');
const { AppError, E } = require('../../common/errors');
const { encrypt, decrypt, hmac } = require('../../common/crypto');
const { sequelize, PayoutAccount } = require('../../models');
const audit = require('../audit/audit.service');
const events = require('../events/events.service');
const settings = require('../settings/settings.service');
const otp = require('../auth/otp.service');
const directory = require('../users/directory.service');
const holds = require('./holds.service');
const rules = require('./payouts.rules');

const OTP_PURPOSE = 'payout_account';
const walletHash = (number) => hmac(`payout_wallet:${number}`);

function serialize(a) {
  return {
    id: a.id,
    type: a.type,
    masked: rules.maskAccount(a.type, a.accountNoLast4),
    last4: a.accountNoLast4,
    accountName: a.accountName,
    status: a.status,
    reviewNote: a.status === 'rejected' ? a.reviewNote ?? null : null,
    activatedAt: a.activatedAt ?? null,
    holdUntil: a.holdUntil ?? null,
    createdAt: a.createdAt,
  };
}

function phoneOf(principal) {
  const { user } = principal;
  if (!user.phone || !user.phoneVerifiedAt) throw new AppError(409, 'PHONE_REQUIRED', 'Add and verify a phone number before adding a payout account');
  return user.phone;
}

/** GET /me/payout-accounts: the active account plus any pending or rejected one, newest first. */
async function listMine(userId) {
  const rows = await PayoutAccount.findAll({ where: { userId, status: { [Op.in]: ['active', 'pending_verification', 'rejected'] } }, order: [['createdAt', 'DESC']], limit: 10 });
  return { items: rows.map(serialize) };
}

/** POST /me/payout-accounts/otp: a code to the registered phone confirms the change (§4.1). */
async function sendCode(principal, req) {
  const phone = phoneOf(principal);
  const result = await otp.issue({ target: { type: 'phone', value: phone }, purpose: OTP_PURPOSE, ip: req.ip, locale: principal.user.locale });
  return { sent: true, ...result };
}

/** POST /me/payout-accounts: add or change the account; it waits for staff verification (FR-01). */
async function add(principal, { type, accountNo, accountName, code }, req) {
  const number = rules.normaliseWallet(accountNo);
  if (!number) throw new AppError(422, 'PAYOUT_ACCOUNT_INVALID', 'Enter a bKash or Nagad number like 01712345678');
  const phone = phoneOf(principal);
  await otp.consume({ target: { type: 'phone', value: phone }, purpose: OTP_PURPOSE, code });
  const userId = principal.user.id;
  const hash = walletHash(number);
  return sequelize.transaction(async (transaction) => {
    const mine = await PayoutAccount.findAll({ where: { userId, status: { [Op.in]: ['active', 'pending_verification'] } }, transaction, lock: transaction.LOCK.UPDATE });
    if (mine.some((a) => a.status === 'active' && a.accountNoHash === hash && a.type === type && a.accountName === accountName)) {
      throw E.conflict('PAYOUT_ACCOUNT_UNCHANGED', 'This is already your payout account');
    }
    // A newer submission replaces one still waiting for review.
    for (const pending of mine.filter((a) => a.status === 'pending_verification')) {
      await pending.update({ status: 'disabled', reviewNote: 'Replaced by a newer submission' }, { transaction });
    }
    const account = await PayoutAccount.create(
      { userId, type, accountNoEnc: encrypt(number), accountNoLast4: number.slice(-4), accountNoHash: hash, accountName, status: 'pending_verification' },
      { transaction }
    );
    await audit.record(
      { action: 'payout_account.added', actor: principal, entityType: 'payout_account', entityId: account.id, after: { type, last4: account.accountNoLast4, status: account.status }, req },
      { transaction }
    );
    await events.publish(transaction, { name: 'payout_account.added', aggregateType: 'payout_account', aggregateId: account.id, payload: { accountId: account.id, userId, type }, actor: principal, req });
    return serialize(account);
  });
}

/** Other users with the same wallet (pending or active): a fraud signal for the reviewer (edge case 8). */
async function sameWalletUsers(account, transaction) {
  const rows = await PayoutAccount.findAll({
    where: { accountNoHash: account.accountNoHash, userId: { [Op.ne]: account.userId }, status: { [Op.in]: ['pending_verification', 'active'] } },
    attributes: ['userId'],
    transaction,
  });
  return new Set(rows.map((r) => r.userId)).size;
}

/** GET /admin/payout-accounts?status: the review queue, with the payee's NID legal name next to the account name. */
async function adminList({ status = 'pending_verification', cursor, limit = 50 } = {}) {
  const where = { status, ...(cursor ? { id: { [Op.lt]: cursor } } : {}) };
  const rows = await PayoutAccount.findAll({ where, order: [['id', 'DESC']], limit: limit + 1 });
  const page = rows.slice(0, limit);
  const people = await directory.identities(page.map((a) => a.userId));
  const items = [];
  for (const a of page) {
    const who = people.get(a.userId) ?? {};
    items.push({
      ...serialize(a),
      reviewNote: a.reviewNote ?? null,
      userId: a.userId,
      user: { displayName: who.displayName ?? null, legalName: who.legalName ?? null, kycStatus: who.kycStatus ?? null },
      sameWalletUsers: await sameWalletUsers(a),
      reviewedBy: a.reviewedBy ?? null,
      reviewedAt: a.reviewedAt ?? null,
    });
  }
  return { items, nextCursor: rows.length > limit ? page[page.length - 1].id : null };
}

async function lockPending(id, actor, transaction) {
  const account = await PayoutAccount.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!account) throw E.notFound('Payout account');
  if (account.status !== 'pending_verification') throw E.conflict('PAYOUT_ACCOUNT_NOT_PENDING', 'This account is not waiting for review');
  if (account.userId === actor.id) throw E.forbidden('SELF_REVIEW_FORBIDDEN', 'You cannot review your own payout account');
  return account;
}

/** POST /admin/payout-accounts/:id/verify: the name matches the NID; the account becomes active (FR-01, FR-02). */
async function verify(actor, id, { note }, req) {
  return sequelize.transaction(async (transaction) => {
    const account = await lockPending(id, actor, transaction);
    const previous = await PayoutAccount.findOne({ where: { userId: account.userId, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    const now = new Date();
    const holdHours = settings.get('risk.payout_change_hold_hours');
    const holdUntil = previous && holdHours > 0 ? new Date(now.getTime() + holdHours * 3600 * 1000) : null;
    if (previous) await previous.update({ status: 'superseded', supersededBy: account.id }, { transaction });
    await account.update({ status: 'active', activatedAt: now, holdUntil, reviewedBy: actor.id, reviewedAt: now, reviewNote: note ?? null }, { transaction });
    if (holdUntil) {
      await holds.place(
        { payeeId: account.userId, scope: 'payee', type: 'account_change', refId: account.id, until: holdUntil, reason: `Payout account changed; payouts resume after ${holdHours} hours` },
        actor,
        { transaction }
      );
    }
    await audit.record(
      {
        action: 'payout_account.verified',
        actor,
        entityType: 'payout_account',
        entityId: account.id,
        before: { status: 'pending_verification' },
        after: { status: 'active', holdUntil },
        reason: note ?? null,
        meta: { replaced: previous?.id ?? null, holdHours: holdUntil ? holdHours : 0 },
        req,
      },
      { transaction }
    );
    await events.publish(transaction, {
      name: 'payout_account.verified',
      aggregateType: 'payout_account',
      aggregateId: account.id,
      payload: { accountId: account.id, userId: account.userId, type: account.type, holdUntil: holdUntil ? holdUntil.toISOString() : null },
      actor,
      req,
    });
    return serialize(account);
  });
}

/** POST /admin/payout-accounts/:id/reject: the name does not match (or the wallet looks shared). */
async function reject(actor, id, { note }, req) {
  return sequelize.transaction(async (transaction) => {
    const account = await lockPending(id, actor, transaction);
    await account.update({ status: 'rejected', reviewedBy: actor.id, reviewedAt: new Date(), reviewNote: note }, { transaction });
    await audit.record(
      { action: 'payout_account.rejected', actor, entityType: 'payout_account', entityId: account.id, before: { status: 'pending_verification' }, after: { status: 'rejected' }, reason: note, req },
      { transaction }
    );
    await events.publish(transaction, { name: 'payout_account.rejected', aggregateType: 'payout_account', aggregateId: account.id, payload: { accountId: account.id, userId: account.userId }, actor, req });
    return serialize(account);
  });
}

/** The payee's active account (or null), for release guards. */
const activeFor = (userId, { transaction } = {}) => PayoutAccount.findOne({ where: { userId, status: 'active' }, transaction });

/** §2.4 for M02's checklist: none | pending | verified | rejected. */
async function status(userId) {
  const latest = await PayoutAccount.findOne({ where: { userId, status: { [Op.in]: ['active', 'pending_verification', 'rejected'] } }, order: [['createdAt', 'DESC']] });
  if (await activeFor(userId)) return 'verified';
  if (!latest) return 'none';
  return latest.status === 'pending_verification' ? 'pending' : 'rejected';
}

/** The full number, for the audited reveal only (never logged, never serialised elsewhere). */
const fullNumber = (account) => decrypt(account.accountNoEnc);

/** Display facts for notifications (M08 reads them here). */
async function facts(id) {
  const a = await PayoutAccount.findByPk(id);
  if (!a) throw E.notFound('Payout account');
  return { masked: rules.maskAccount(a.type, a.accountNoLast4), reviewNote: a.reviewNote ?? null, holdUntil: a.holdUntil ?? null };
}

/** M18 shared_payout_account: other verified accounts using one of this user's wallets (ids never leave). */
async function sharedWith(userId) {
  const mine = await PayoutAccount.findAll({ where: { userId, status: { [Op.in]: ['pending_verification', 'active'] } }, attributes: ['accountNoHash'] });
  const hashes = [...new Set(mine.map((a) => a.accountNoHash))];
  if (!hashes.length) return 0;
  return PayoutAccount.count({ where: { accountNoHash: hashes, userId: { [Op.ne]: userId }, status: 'active' }, distinct: true, col: 'user_id' });
}

/** M18 payout_account_change: payout accounts added since `since` (FR-13). */
const addedSince = (userId, since) => PayoutAccount.count({ where: { userId, createdAt: { [Op.gte]: since } } });

module.exports = { sharedWith, addedSince, listMine, sendCode, add, adminList, verify, reject, activeFor, status, fullNumber, facts, serialize };
