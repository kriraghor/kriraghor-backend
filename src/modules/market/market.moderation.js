'use strict';

/**
 * M12 on M05 (FR-02, FR-03) and the events it reacts to (§2):
 *  - adapters: kinds `shop` and `product` for staff with approve_listings (masters see all); the
 *    owner's documents are a locked check (no override);
 *  - consumers: M05 decisions on shop and product submissions; an owner whose shop_owner role is
 *    suspended or withdrawn, or whose account is suspended or banned, has the live shop paused (its
 *    products leave Market with it); saved-item alerts on restock and price drops (FR-33).
 * Registered once per process (subscriptions.registerAll).
 */
const adapters = require('../moderation/moderation.adapters');
const { onEvent } = require('../events/events.consumers');

adapters.register({
  kind: 'shop',
  permission: 'approve_listings',
  ownerWithdraw: false,
  lockedChecks: ['owner_kyc_approved'],
  checks: (submission, { transaction }) => require('./shops.service').checksFor(submission.payload.shopId, { transaction }),
});

adapters.register({
  kind: 'product',
  permission: 'approve_listings',
  ownerWithdraw: false,
  lockedChecks: ['owner_kyc_approved', 'shop_live'],
  checks: (submission, { transaction }) => require('./products.service').checksFor(submission.payload.productId, { transaction }),
});

const APPLY = { 'submission.approved': 'approved', 'submission.changes_requested': 'changes_requested', 'submission.rejected': 'rejected', 'submission.withdrawn': 'withdrawn' };
const SERVICE = { shop: () => require('./shops.service'), product: () => require('./products.service') };

function registerMarketConsumers() {
  for (const [name, status] of Object.entries(APPLY)) {
    onEvent(name, `market.apply-${status}`, (e, { transaction }) => {
      const svc = SERVICE[e.payload.kind];
      if (!svc || (status === 'withdrawn' && e.payload.superseded)) return null;
      return svc().applyDecision(e.payload.submissionId, status, { transaction });
    });
  }
  for (const name of ['user_role.suspended', 'user_role.withdrawn']) {
    onEvent(name, `market.owner-${name.split('.')[1]}`, (e, { transaction }) =>
      e.payload.role === 'shop_owner' ? require('./shops.service').pauseAllOf(e.payload.userId, 'owner_role', { transaction }) : null
    );
  }
  for (const name of ['user.suspended', 'user.banned']) {
    onEvent(name, `market.sanction-${name.split('.')[1]}`, (e, { transaction }) => require('./shops.service').pauseAllOf(e.payload.userId, 'owner_sanction', { transaction }));
  }
  onEvent('variant.restocked', 'market.saved-restocked', (e, { transaction }) => require('./saved.service').alertSavers(e.payload.productId, 'back_in_stock', { transaction }));
  onEvent('product.price_lowered', 'market.saved-price', (e, { transaction }) => require('./saved.service').alertSavers(e.payload.productId, 'price_dropped', { transaction }));
}

module.exports = { registerMarketConsumers };
