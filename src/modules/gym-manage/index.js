'use strict';

/**
 * The gym-manage module's public interface (ADR-007 §3, M24 §7.4): other modules use only this file;
 * everything else in gym-manage is internal (tests/unit/boundaries.test.js). Functions delegate lazily,
 * so requiring the index never changes load order and cannot create a require cycle at load time.
 *
 *   owners     M20 creates the owner's subscription row with their first gym (M24-FR-09, FR-81)
 *   facts      M08 template facts (a member's code and link state, receipt and pay links; never a name or phone)
 *   notices    M08: who receives a member notice (the owner's plan, the kind switched on, linked or by email)
 *   fees       M20 pass purchase: fees.gym_pct as it applies to a gym, overrides included (M24-FR-95)
 *   reads      M19 the gym owner's to-dos; M20's business adapter: a gym's staff to-dos
 *   joins      M20's gym page: whether the gym takes join requests (prompt 3)
 *   consumers  registered by registry.registerAll
 *   ops        M27 gym-ops: access to one gym, today's date, receipt numbers and VAT, a member, the money
 *              collected for profit and loss (round 1); notice segments and reach, reward writes
 *              (extend, waive), member by account, check-in dates (round 2)
 */
const lazy = (file, names, values = []) => {
  const out = Object.fromEntries(names.map((n) => [n, (...args) => require(file)[n](...args)]));
  for (const v of values) Object.defineProperty(out, v, { enumerable: true, get: () => require(file)[v] });
  return Object.freeze(out);
};

module.exports = {
  owners: lazy('./gym-manage.common', ['ensureSubscription']),
  facts: Object.freeze({
    member: (...args) => require('./gyms.service').memberFacts(...args),
    membership: (...args) => require('./gyms.service').membershipFacts(...args),
    receiptUrl: (...args) => require('./gym-manage.common').receiptUrlOf(...args),
    payLinkUrl: (...args) => require('./gyms.service').payLinkUrl(...args),
    importUpload: (...args) => require('./gyms.service').importFacts(...args),
    reversedReceipt: (...args) => require('./gyms.service').reversedReceipt(...args),
    plan: (...args) => require('./plans.service').planFacts(...args),
  }),
  notices: lazy('./notices.service', ['memberTargets']),
  fees: lazy('./fees.service', ['passFee']),
  reads: lazy('./reads.service', ['pendingActions', 'staffActions']),
  joins: lazy('./joins.service', ['openFor']),
  consumers: lazy('./gym-manage.consumers', ['registerGymManageConsumers']),
  ops: Object.freeze({
    access: (...args) => require('./gym-manage.common').gymAccess(...args),
    needs: (...args) => require('./gym-manage.common').needs(...args),
    shown: (...args) => require('./gym-manage.common').shown(...args),
    today: (...args) => require('./gym-manage.common').today(...args),
    nextReceiptNo: (...args) => require('./gym-manage.common').nextReceiptNo(...args),
    vatBpsOf: (...args) => require('./gym-manage.common').vatBpsOf(...args),
    gymSettings: (...args) => require('./gym-manage.common').settingsOf(...args),
    member: (...args) => require('./ops.service').member(...args),
    collected: (...args) => require('./ops.service').collected(...args),
    cashCollected: (...args) => require('./ops.service').cashCollected(...args),
    // round 2
    featureOn: (...args) => require('./ops.service').featureOn(...args),
    extendIn: (...args) => require('./ops.service').extendIn(...args),
    waiveIn: (...args) => require('./ops.service').waiveIn(...args),
    segmentMemberIds: (...args) => require('./ops.service').segmentMemberIds(...args),
    reachOf: (...args) => require('./ops.service').reachOf(...args),
    memberOfUser: (...args) => require('./ops.service').memberOfUser(...args),
    hasRunningMembership: (...args) => require('./ops.service').hasRunningMembership(...args),
    checkInDates: (...args) => require('./ops.service').checkInDates(...args),
    // round 3
    parseEntranceToken: (...args) => require('./gym-manage.common').parseEntranceToken(...args),
    feesByTrainer: (...args) => require('./ops.service').feesByTrainer(...args),
  }),
};
