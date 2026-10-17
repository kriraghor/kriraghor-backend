'use strict';

/**
 * M13 Orders and fulfilment, step 1 (shop orders, §7): carts, cart_items, orders, sub_orders,
 * order_items. Returns, COD and used-gear orders come in step 2.
 *
 *  - carts: one per member; cart_items keep the price seen when added (FR-03 price changes) and are
 *    removed by setting removed_at (one live line per variant: partial unique index).
 *  - orders: one checkout and one M06 payment (split into one escrow hold per sub-order). The phone
 *    and the address are encrypted (common/crypto); the shop sees them only after it accepts (FR-10).
 *  - sub_orders: one per shop, with its own status, deadlines and money: items + delivery = total;
 *    commission (snapshot of fees.shop_commission_pct at checkout, in bps) on the items only;
 *    net = total − commission. refunded + released never exceed the total.
 *  - order_items: the line snapshots (title, variant, SKU, photo, price) at checkout; append-only.
 */
const ORDER_STATUSES = ['pending_payment', 'placed', 'cancelled', 'completed'];
const SUB_STATUSES = ['pending_payment', 'placed', 'accepted', 'shipped', 'delivered', 'completed', 'rejected', 'expired', 'cancelled', 'disputed', 'refunded'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    const { DataTypes } = Sequelize;
    const now = { type: h.TS, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') };
    const at = { type: h.TS, allowNull: true };
    const uuid = { type: DataTypes.UUID, allowNull: false };
    const optUuid = { type: DataTypes.UUID, allowNull: true };
    const fk = (table) => ({ ...uuid, references: { model: table, key: 'id' }, onDelete: 'RESTRICT' });
    const poisha = { type: DataTypes.BIGINT, allowNull: false };
    const zero = { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 };
    const q = (sql) => queryInterface.sequelize.query(sql);

    await h.createTable(queryInterface, 'carts', {
      id: { ...uuid, primaryKey: true },
      user_id: fk('users'),
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('carts', ['user_id'], { unique: true, name: 'uq_carts_user' });

    await h.createTable(queryInterface, 'cart_items', {
      id: { ...uuid, primaryKey: true },
      cart_id: fk('carts'),
      variant_id: fk('product_variants'),
      qty: { type: DataTypes.SMALLINT, allowNull: false },
      added_price_poisha: poisha,
      added_at: now,
      removed_at: at,
      updated_at: now,
    });
    await q('CREATE UNIQUE INDEX uq_cart_items_live ON cart_items (cart_id, variant_id) WHERE removed_at IS NULL');
    await q('ALTER TABLE cart_items ADD CONSTRAINT chk_cart_items_qty CHECK (qty BETWEEN 1 AND 50 AND added_price_poisha >= 0)');

    await h.createTable(queryInterface, 'orders', {
      id: { ...uuid, primaryKey: true },
      code: { type: DataTypes.STRING(20), allowNull: false },
      buyer_id: fk('users'),
      ship_name: { type: DataTypes.STRING(80), allowNull: false },
      ship_phone_enc: { type: DataTypes.TEXT, allowNull: false },
      ship_phone_last4: { type: DataTypes.CHAR(4), allowNull: false },
      ship_area_id: fk('areas'),
      ship_address_enc: { type: DataTypes.TEXT, allowNull: false },
      ship_dhaka_metro: { type: DataTypes.BOOLEAN, allowNull: false },
      payment_method: { type: h.ENUM('online'), allowNull: false, defaultValue: 'online' },
      payment_id: { ...optUuid, references: { model: 'payments', key: 'id' }, onDelete: 'RESTRICT' },
      items_poisha: poisha,
      delivery_poisha: poisha,
      total_poisha: poisha,
      status: { type: h.ENUM(...ORDER_STATUSES), allowNull: false, defaultValue: 'pending_payment' },
      pay_by: at,
      placed_at: at,
      cancelled_at: at,
      completed_at: at,
      idempotency_key: { type: DataTypes.STRING(80), allowNull: false },
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('orders', ['code'], { unique: true, name: 'uq_orders_code' });
    await queryInterface.addIndex('orders', ['buyer_id', 'idempotency_key'], { unique: true, name: 'uq_orders_idempotency' });
    await queryInterface.addIndex('orders', ['buyer_id', 'created_at'], { name: 'ix_orders_buyer' });
    await queryInterface.addIndex('orders', ['payment_id'], { name: 'ix_orders_payment' });
    await q("CREATE INDEX ix_orders_pay_by ON orders (pay_by) WHERE status = 'pending_payment'");
    await q('ALTER TABLE orders ADD CONSTRAINT chk_orders_money CHECK (items_poisha > 0 AND delivery_poisha >= 0 AND total_poisha = items_poisha + delivery_poisha)');

    await h.createTable(queryInterface, 'sub_orders', {
      id: { ...uuid, primaryKey: true },
      code: { type: DataTypes.STRING(24), allowNull: false },
      order_id: fk('orders'),
      shop_id: fk('shops'),
      seller_id: fk('users'),
      buyer_id: fk('users'),
      status: { type: h.ENUM(...SUB_STATUSES), allowNull: false, defaultValue: 'pending_payment' },
      items_poisha: poisha,
      delivery_poisha: poisha,
      total_poisha: poisha,
      commission_bps: { type: DataTypes.INTEGER, allowNull: false },
      commission_poisha: poisha,
      net_poisha: poisha,
      refunded_poisha: zero,
      released_poisha: zero,
      placed_at: at,
      accept_by: at,
      accept_reminded_at: at,
      ship_by: at,
      buyer_cancel_from: at,
      auto_cancel_at: at,
      accepted_at: at,
      shipped_at: at,
      courier_name: { type: DataTypes.STRING(60), allowNull: true },
      tracking_no: { type: DataTypes.STRING(40), allowNull: true },
      delivered_at: at,
      delivered_proof_key: { type: DataTypes.STRING(255), allowNull: true },
      complete_by: at,
      completed_at: at,
      completed_by: { type: h.ENUM('buyer', 'auto', 'dispute'), allowNull: true },
      cancelled_at: at,
      cancelled_by: { type: h.ENUM('buyer', 'shop', 'system', 'staff'), allowNull: true },
      cancel_reason: { type: DataTypes.STRING(40), allowNull: true },
      cancel_note: { type: DataTypes.STRING(300), allowNull: true },
      dispute_id: optUuid,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.addIndex('sub_orders', ['code'], { unique: true, name: 'uq_sub_orders_code' });
    await queryInterface.addIndex('sub_orders', ['order_id'], { name: 'ix_sub_orders_order' });
    await queryInterface.addIndex('sub_orders', ['shop_id', 'status', 'created_at'], { name: 'ix_sub_orders_shop' });
    await queryInterface.addIndex('sub_orders', ['buyer_id', 'status'], { name: 'ix_sub_orders_buyer' });
    // The tick's queues: accept expiry, overdue shipping, auto-complete.
    await q("CREATE INDEX ix_sub_orders_accept_by ON sub_orders (accept_by) WHERE status = 'placed'");
    await q("CREATE INDEX ix_sub_orders_auto_cancel ON sub_orders (auto_cancel_at) WHERE status = 'accepted'");
    await q("CREATE INDEX ix_sub_orders_complete_by ON sub_orders (complete_by) WHERE status = 'delivered'");
    await q(
      'ALTER TABLE sub_orders ADD CONSTRAINT chk_sub_orders_money CHECK (items_poisha > 0 AND delivery_poisha >= 0 AND total_poisha = items_poisha + delivery_poisha ' +
        'AND commission_bps BETWEEN 0 AND 10000 AND commission_poisha BETWEEN 0 AND items_poisha AND net_poisha = total_poisha - commission_poisha ' +
        'AND refunded_poisha >= 0 AND released_poisha >= 0 AND refunded_poisha + released_poisha <= total_poisha)'
    );
    await q("ALTER TABLE sub_orders ADD CONSTRAINT chk_sub_orders_shipped CHECK (status NOT IN ('shipped', 'delivered') OR (shipped_at IS NOT NULL AND courier_name IS NOT NULL AND tracking_no IS NOT NULL))");
    await q("ALTER TABLE sub_orders ADD CONSTRAINT chk_sub_orders_completed CHECK (status <> 'completed' OR (completed_at IS NOT NULL AND completed_by IS NOT NULL))");

    await h.createTable(queryInterface, 'order_items', {
      id: { ...uuid, primaryKey: true },
      sub_order_id: fk('sub_orders'),
      variant_id: fk('product_variants'),
      product_id: fk('products'),
      title: { type: DataTypes.STRING(120), allowNull: false },
      variant_label_en: { type: DataTypes.STRING(120), allowNull: false },
      variant_label_bn: { type: DataTypes.STRING(120), allowNull: false },
      sku: { type: DataTypes.STRING(40), allowNull: true },
      photo_key: { type: DataTypes.STRING(255), allowNull: true },
      unit_price_poisha: poisha,
      qty: { type: DataTypes.SMALLINT, allowNull: false },
      line_total_poisha: poisha,
      is_mto: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      mto_days: { type: DataTypes.SMALLINT, allowNull: true },
      created_at: now,
    });
    await queryInterface.addIndex('order_items', ['sub_order_id'], { name: 'ix_order_items_sub_order' });
    await q('ALTER TABLE order_items ADD CONSTRAINT chk_order_items_money CHECK (qty BETWEEN 1 AND 50 AND unit_price_poisha > 0 AND line_total_poisha = unit_price_poisha * qty)');
    await h.appendOnly(queryInterface, 'order_items');
  },

  async down(queryInterface, Sequelize) {
    const h = require('../migration-helpers/pg-v1')(Sequelize);
    await h.dropAppendOnly(queryInterface, 'order_items');
    for (const t of ['order_items', 'sub_orders', 'orders', 'cart_items', 'carts']) await queryInterface.dropTable(t);
  },
};
