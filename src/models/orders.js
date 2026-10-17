'use strict';

/**
 * M13 Orders models, step 1 (migration 20261030000003-create-orders): carts, cart_items, orders,
 * sub_orders, order_items. index.js re-exports them.
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../db');
const { uuid7 } = require('../common/uuid7');
const { toPoisha } = require('../common/money');

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: () => uuid7() };
const req = (type) => ({ type, allowNull: false });
const poisha = (field, dflt) => ({
  type: DataTypes.BIGINT,
  allowNull: false,
  ...(dflt === undefined ? {} : { defaultValue: dflt }),
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? null : toPoisha(v);
  },
});

class Cart extends Model {}
Cart.init({ id, userId: req(DataTypes.UUID) }, { sequelize, modelName: 'Cart', tableName: 'carts' });

class CartItem extends Model {}
CartItem.init(
  {
    id,
    cartId: req(DataTypes.UUID),
    variantId: req(DataTypes.UUID),
    qty: req(DataTypes.SMALLINT),
    addedPricePoisha: poisha('addedPricePoisha'),
    addedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    removedAt: DataTypes.DATE(3),
  },
  { sequelize, modelName: 'CartItem', tableName: 'cart_items', createdAt: false }
);

class Order extends Model {}
Order.init(
  {
    id,
    code: req(DataTypes.STRING(20)),
    buyerId: req(DataTypes.UUID),
    shipName: req(DataTypes.STRING(80)),
    shipPhoneEnc: req(DataTypes.TEXT),
    shipPhoneLast4: req(DataTypes.CHAR(4)),
    shipAreaId: req(DataTypes.UUID),
    shipAddressEnc: req(DataTypes.TEXT),
    shipDhakaMetro: req(DataTypes.BOOLEAN),
    paymentMethod: { type: DataTypes.ENUM('online'), allowNull: false, defaultValue: 'online' },
    paymentId: DataTypes.UUID,
    itemsPoisha: poisha('itemsPoisha'),
    deliveryPoisha: poisha('deliveryPoisha'),
    totalPoisha: poisha('totalPoisha'),
    status: { type: DataTypes.ENUM('pending_payment', 'placed', 'cancelled', 'completed'), allowNull: false, defaultValue: 'pending_payment' },
    payBy: DataTypes.DATE(3),
    placedAt: DataTypes.DATE(3),
    cancelledAt: DataTypes.DATE(3),
    completedAt: DataTypes.DATE(3),
    idempotencyKey: req(DataTypes.STRING(80)),
  },
  { sequelize, modelName: 'Order', tableName: 'orders' }
);

class SubOrder extends Model {}
SubOrder.init(
  {
    id,
    code: req(DataTypes.STRING(24)),
    orderId: req(DataTypes.UUID),
    shopId: req(DataTypes.UUID),
    sellerId: req(DataTypes.UUID),
    buyerId: req(DataTypes.UUID),
    status: {
      type: DataTypes.ENUM('pending_payment', 'placed', 'accepted', 'shipped', 'delivered', 'completed', 'rejected', 'expired', 'cancelled', 'disputed', 'refunded'),
      allowNull: false,
      defaultValue: 'pending_payment',
    },
    itemsPoisha: poisha('itemsPoisha'),
    deliveryPoisha: poisha('deliveryPoisha'),
    totalPoisha: poisha('totalPoisha'),
    commissionBps: req(DataTypes.INTEGER),
    commissionPoisha: poisha('commissionPoisha'),
    netPoisha: poisha('netPoisha'),
    refundedPoisha: poisha('refundedPoisha', 0),
    releasedPoisha: poisha('releasedPoisha', 0),
    placedAt: DataTypes.DATE(3),
    acceptBy: DataTypes.DATE(3),
    acceptRemindedAt: DataTypes.DATE(3),
    shipBy: DataTypes.DATE(3),
    buyerCancelFrom: DataTypes.DATE(3),
    autoCancelAt: DataTypes.DATE(3),
    acceptedAt: DataTypes.DATE(3),
    shippedAt: DataTypes.DATE(3),
    courierName: DataTypes.STRING(60),
    trackingNo: DataTypes.STRING(40),
    deliveredAt: DataTypes.DATE(3),
    deliveredProofKey: DataTypes.STRING(255),
    completeBy: DataTypes.DATE(3),
    completedAt: DataTypes.DATE(3),
    completedBy: DataTypes.ENUM('buyer', 'auto', 'dispute'),
    cancelledAt: DataTypes.DATE(3),
    cancelledBy: DataTypes.ENUM('buyer', 'shop', 'system', 'staff'),
    cancelReason: DataTypes.STRING(40),
    cancelNote: DataTypes.STRING(300),
    disputeId: DataTypes.UUID,
  },
  { sequelize, modelName: 'SubOrder', tableName: 'sub_orders' }
);

class OrderItem extends Model {}
OrderItem.init(
  {
    id,
    subOrderId: req(DataTypes.UUID),
    variantId: req(DataTypes.UUID),
    productId: req(DataTypes.UUID),
    title: req(DataTypes.STRING(120)),
    variantLabelEn: req(DataTypes.STRING(120)),
    variantLabelBn: req(DataTypes.STRING(120)),
    sku: DataTypes.STRING(40),
    photoKey: DataTypes.STRING(255),
    unitPricePoisha: poisha('unitPricePoisha'),
    qty: req(DataTypes.SMALLINT),
    lineTotalPoisha: poisha('lineTotalPoisha'),
    isMto: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    mtoDays: DataTypes.SMALLINT,
  },
  { sequelize, modelName: 'OrderItem', tableName: 'order_items', updatedAt: false }
);

Cart.hasMany(CartItem, { as: 'items', foreignKey: 'cartId' });
Order.hasMany(SubOrder, { as: 'subOrders', foreignKey: 'orderId' });
SubOrder.belongsTo(Order, { as: 'order', foreignKey: 'orderId' });
SubOrder.hasMany(OrderItem, { as: 'items', foreignKey: 'subOrderId' });

module.exports = { Cart, CartItem, Order, SubOrder, OrderItem };
